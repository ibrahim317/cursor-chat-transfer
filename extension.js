'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('@vscode/sqlite3').verbose();
// Modularized helpers
const pathsMod = require('./lib/paths');
const dbMod = require('./lib/db');
const transferMod = require('./lib/transfer');
let output;

/**
 * Utility: find default Cursor user data dir by platform.
 * Linux: ~/.config/Cursor
 * macOS: ~/Library/Application Support/Cursor
 * Windows: %APPDATA%/Cursor
 */
function getDefaultCursorUserDir() {
	const platform = process.platform;
	if (platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor');
	}
	if (platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, 'Cursor');
	}
	// linux
	return path.join(os.homedir(), '.config', 'Cursor');
}

function toUriIfExists(filePath) {
	try {
		if (filePath && fs.existsSync(filePath)) {
			return vscode.Uri.file(filePath);
		}
	} catch {
		// ignore
	}
	return undefined;
}


function openSqlite(dbPath) {
	return new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE);
}

function run(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (err) {
			if (err) return reject(err);
			resolve(this);
		});
	});
}

function exec(db, sql) {
	return new Promise((resolve, reject) => {
		db.exec(sql, (err) => err ? reject(err) : resolve());
	});
}

function readItemTableComposer(db) {
	return new Promise((resolve, reject) => {
		db.get("SELECT value FROM ItemTable WHERE key = ?", ['composer.composerData'], (err, row) => {
			if (err) return reject(err);
			if (!row || row.value == null) return resolve(null);
			try {
				const text = typeof row.value === 'string' ? row.value : row.value.toString();
				const json = JSON.parse(text);
				resolve(json);
			} catch (e) {
				reject(e);
			}
		});
	});
}

function writeItemTableComposer(db, json) {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(json);
		db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", ['composer.composerData', payload], (err) => {
			if (err) return reject(err);
			resolve();
		});
	});
}

function readCursorDiskKV(db, key) {
	return new Promise((resolve, reject) => {
		db.get("SELECT value FROM cursorDiskKV WHERE key = ?", [key], (err, row) => {
			if (err) return reject(err);
			if (!row) return resolve(null);
			const val = typeof row.value === 'string' ? row.value : row.value?.toString();
			resolve(val);
		});
	});
}

function hasCursorDiskKV(db, key) {
	return new Promise((resolve, reject) => {
		db.get("SELECT 1 AS ok FROM cursorDiskKV WHERE key = ? LIMIT 1", [key], (err, row) => {
			if (err) return reject(err);
			resolve(!!row);
		});
	});
}

function insertCursorDiskKV(db, key, value) {
	return new Promise((resolve, reject) => {
		db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [key, value], (err) => {
			if (err) return reject(err);
			resolve();
		});
	});
}


/**
 * Local Import: choose source workspace and target workspace, copy chats locally.
 */
async function doLocalImport() {
	try {
		// Mode selection: Copy (default), Cut, Ref
		const modePick = await vscode.window.showQuickPick(
			[
				{ label: 'Copy (duplicate chats)', value: 'copy', picked: true },
				{ label: 'Cut (move chats)', value: 'cut' },
				{ label: 'Ref (link to existing)', value: 'ref' }
			],
			{ title: 'Local Import Mode' }
		);
		const mode = (modePick && modePick.value) || 'copy';

		const sourceWsUri = await pathsMod.quickPickWorkspaceDbOrBrowse();
		if (!sourceWsUri) return;
		// Target = current workspace if resolvable, else ask
		let targetWsUri = pathsMod.getCurrentWorkspaceStateDbUri();
		if (!targetWsUri) {
			targetWsUri = await pathsMod.quickPickWorkspaceDbOrBrowse();
			if (!targetWsUri) return;
		}
		const glUri = await pathsMod.quickPickGlobalDbOrBrowse(pathsMod.getDefaultCursorUserDir);
		if (!glUri) return;

		if (!output) output = vscode.window.createOutputChannel('Cursor Chat Transfer');
		output.appendLine(`Local Import source: ${sourceWsUri.fsPath}`);
		output.appendLine(`Local Import target: ${targetWsUri.fsPath}`);
		output.appendLine(`Local Import global: ${glUri.fsPath}`);

		let exp = await transferMod.buildExportObject(sourceWsUri, glUri);
		let sourceIds = (exp.allComposers || []).map(c => c.composerId).filter(Boolean);
		if (mode === 'copy') {
			const { cloned } = transferMod.cloneExportObjectForCopy(exp);
			exp = cloned;
		}
		const inserted = await transferMod.importFromObject(exp, targetWsUri, glUri);
		if (mode === 'cut') {
			await transferMod.removeComposersFromWorkspace(sourceWsUri, sourceIds);
		}

		output.appendLine(`Local Import done. KV inserted: ${inserted}`);
		output.show(true);
		const choice = await vscode.window.showInformationMessage('Local import complete. Reload Window to reflect changes?', 'Reload Window');
		if (choice === 'Reload Window') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (err) {
		console.error(err);
		vscode.window.showErrorMessage(`Local import failed: ${err.message || String(err)}`);
	}
}

/**
 * Export command:
 * - user picks workspace state.vscdb and global state.vscdb
 * - read composer.composerData -> collect allComposers and ids
 * - for each id, read cursorDiskKV value: composerData:<id>
 * - save JSON file with structure:
 *   { allComposers: [...], composers: { [id]: "<json string as stored>" } }
 */
async function doExport() {
	try {
		const wsUri = await pathsMod.quickPickWorkspaceDbOrBrowse();
		if (!wsUri) return;
		const glUri = await pathsMod.quickPickGlobalDbOrBrowse(pathsMod.getDefaultCursorUserDir);
		if (!glUri) return;

		const wsDb = dbMod.openSqlite(wsUri.fsPath);
		const composerData = await dbMod.readItemTableComposer(wsDb);
		if (!composerData || !Array.isArray(composerData.allComposers)) {
			vscode.window.showWarningMessage('No composer.composerData found in the selected workspace DB.');
			wsDb.close();
			return;
		}
		let allComposers = composerData.allComposers;

		// Optional selection step
		const selectionMode = await vscode.window.showQuickPick(
			[
				{ label: 'Export all chats', value: 'all' },
				{ label: 'Select chats…', value: 'select' }
			],
			{ title: 'Choose chats to export' }
		);
		if (!selectionMode) { wsDb.close(); return; }
		if (selectionMode.value === 'select') {
			const items = allComposers.map(c => {
				const label = c.name || c.composerId || 'Untitled';
				const description = c.subtitle || '';
				const detail = c.unifiedMode ? `Mode: ${c.unifiedMode} • Updated: ${c.lastUpdatedAt || ''}` : '';
				return { label, description, detail, picked: true, composer: c };
			});
			const picked = await vscode.window.showQuickPick(items, {
				canPickMany: true,
				title: 'Select chats to export'
			});
			if (!picked) { wsDb.close(); return; }
			allComposers = picked.map(p => p.composer);
		}

		const selectedIds = allComposers.map(c => c.composerId).filter(Boolean);
		wsDb.close();
		// Build export with transfer module (includes bubbles)
		const { allComposers: finalComposers, composers, bubbles } = await transferMod.buildExportObject(wsUri, glUri, selectedIds);

		const exportObj = { allComposers: finalComposers, composers, bubbles };
		const saveUri = await vscode.window.showSaveDialog({
			title: 'Save exported Cursor chats',
			filters: { 'Cursor Chat Export': ['cursor-chat.json'] },
			saveLabel: 'Save Export',
			defaultUri: vscode.Uri.file(path.join(os.homedir(), 'cursor-chat-export.cursor-chat.json'))
		});
		if (!saveUri) return;
		fs.writeFileSync(saveUri.fsPath, JSON.stringify(exportObj, null, 2), 'utf8');
		vscode.window.showInformationMessage('Cursor chats exported successfully.');
	} catch (err) {
		console.error(err);
		vscode.window.showErrorMessage(`Export failed: ${err.message || String(err)}`);
	}
}

/**
 * Import command:
 * - user picks export file
 * - user picks target workspace state.vscdb and global state.vscdb
 * - read existing composer.composerData, merge allComposers (by composerId), write back
 * - for each composer value, insert into cursorDiskKV if missing (skip if exists)
 */
async function doImport() {
	try {
		const exported = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: 'Select exported Cursor chats (.cursor-chat.json)',
			openLabel: 'Select Export',
			filters: { 'Cursor Chat Export': ['cursor-chat.json'], 'JSON': ['json'] }
		});
		if (!exported || !exported[0]) return;
		const text = fs.readFileSync(exported[0].fsPath, 'utf8');
		const obj = JSON.parse(text);
		if (!obj || !Array.isArray(obj.allComposers) || typeof obj.composers !== 'object') {
			vscode.window.showErrorMessage('Invalid export file format.');
			return;
		}

		const wsUri = await pathsMod.quickPickWorkspaceDbOrBrowse();
		if (!wsUri) return;
		const glUri = await pathsMod.quickPickGlobalDbOrBrowse(pathsMod.getDefaultCursorUserDir);
		if (!glUri) return;

		// Perform import via transfer module
		const inserted = await transferMod.importFromObject(obj, wsUri, glUri);

		// Verify write landed
		const wsDb = dbMod.openSqlite(wsUri.fsPath);
		const verify = (await dbMod.readItemTableComposer(wsDb)) || {};
		wsDb.close();
		const verifyList = Array.isArray(verify.allComposers) ? verify.allComposers : [];
		const verifyIds = new Set(verifyList.map(c => c.composerId).filter(Boolean));
		if (!output) output = vscode.window.createOutputChannel('Cursor Chat Transfer');
		output.appendLine(`Import verification: ${verifyIds.size} total composers listed in workspace DB.`);
		output.appendLine(`Import verification: attempted KV insertions ${inserted}.`);
		output.show(true);

		const msg = `Import complete. Workspace composers now ${verifyIds.size}. KV inserted ${inserted}. Reload Cursor to see changes.`;
		const choice = await vscode.window.showInformationMessage(msg, 'Reload Window');
		if (choice === 'Reload Window') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (err) {
		console.error(err);
		vscode.window.showErrorMessage(`Import failed: ${err.message || String(err)}`);
	}
}

class ChatTransferTreeItem extends vscode.TreeItem {
	constructor(label, description, command, contextValue, iconId) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.command = command;
		this.contextValue = contextValue;
		this.iconPath = new vscode.ThemeIcon(iconId);
		this.tooltip = description;
	}
}

class ChatTransferProvider {
	getTreeItem(element) {
		return element;
	}

	getChildren() {
		return [
			new ChatTransferTreeItem(
				'Export Chats',
				'Export chats to a file',
				{ command: 'cursorChatTransfer.export', title: 'Export Chats' },
				'export',
				'export'
			),
			new ChatTransferTreeItem(
				'Import Chats',
				'Import chats from a file',
				{ command: 'cursorChatTransfer.import', title: 'Import Chats' },
				'import',
				'cloud-download'
			),
			new ChatTransferTreeItem(
				'Local Import (Move Chats)',
				'Copy or move chats between workspaces',
				{ command: 'cursorChatTransfer.localImport', title: 'Local Import' },
				'localImport',
				'arrow-both'
			)
		];
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	output = vscode.window.createOutputChannel('Cursor Chat Transfer');
	const provider = new ChatTransferProvider();
	vscode.window.registerTreeDataProvider('cursorChatTransfer.view', provider);
	context.subscriptions.push(
		vscode.commands.registerCommand('cursorChatTransfer.export', doExport),
		vscode.commands.registerCommand('cursorChatTransfer.import', doImport),
		vscode.commands.registerCommand('cursorChatTransfer.localImport', doLocalImport)
	);
}

function deactivate() {}

module.exports = {
	activate,
	deactivate
};


