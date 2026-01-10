'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
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

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Exporting chats...",
			cancellable: false
		}, async (progress) => {
			progress.report({ message: "Reading workspace database..." });
			const wsDb = await dbMod.openSqliteReadOnly(wsUri.fsPath);
			const composerData = await dbMod.readItemTableComposer(wsDb);
			if (!composerData || !Array.isArray(composerData.allComposers)) {
				vscode.window.showWarningMessage('No composer.composerData found in the selected workspace DB.');
				wsDb.closeReadOnly();
				return;
			}
			let allComposers = composerData.allComposers;
			wsDb.closeReadOnly(); // Close early

			// Optional selection step
			const selectionMode = await vscode.window.showQuickPick(
				[
					{ label: 'Export all chats', value: 'all' },
					{ label: 'Select chats…', value: 'select' }
				],
				{ title: 'Choose chats to export' }
			);
			if (!selectionMode) { return; }
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
				if (!picked) { return; }
				allComposers = picked.map(p => p.composer);
			}

			const selectedIds = allComposers.map(c => c.composerId).filter(Boolean);
			
			progress.report({ message: "Building export object..." });
			const { allComposers: finalComposers, composers, bubbles } = await transferMod.buildExportObject(wsUri, glUri, selectedIds);

			const exportObj = { allComposers: finalComposers, composers, bubbles };
			
			progress.report({ message: "Saving to file..." });
			const saveUri = await vscode.window.showSaveDialog({
				title: 'Save exported Cursor chats',
				filters: { 'Cursor Chat Export': ['cursor-chat.json'] },
				saveLabel: 'Save Export',
				defaultUri: vscode.Uri.file(path.join(os.homedir(), 'cursor-chat-export.cursor-chat.json'))
			});
			if (!saveUri) return;
			fs.writeFileSync(saveUri.fsPath, JSON.stringify(exportObj, null, 2), 'utf8');
			vscode.window.showInformationMessage('Cursor chats exported successfully.');
		});

	} catch (err) {
		console.error(err);
		
		// Provide helpful error message for large files
		let errorMessage = `Export failed: ${err.message || String(err)}`;
		if (err.message && err.message.includes('greater than')) {
			errorMessage = 'Export failed: Your global database is too large (>1.5GB). ' +
				'This extension uses in-memory SQLite which has size limitations. ' +
				'Try clearing old chat history in Cursor to reduce the database size.';
		}
		
		vscode.window.showErrorMessage(errorMessage);
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

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Importing chats...",
			cancellable: false
		}, async (progress) => {
			progress.report({ message: "Cloning chats with new IDs..." });
			
			// Clone the imported data with new IDs to avoid conflicts
			const { cloned } = transferMod.cloneExportObjectForCopy(obj);
			
			if (!output) output = vscode.window.createOutputChannel('Cursor Chat Transfer');
			output.appendLine(`\n${'='.repeat(50)}`);
			output.appendLine(`Import from file started at ${new Date().toISOString()}`);
			output.appendLine(`${'='.repeat(50)}`);
			output.appendLine(`Cloned ${cloned.allComposers.length} composers with new IDs`);
			
			progress.report({ message: "Creating backups and importing..." });
			const result = await transferMod.importFromObject(cloned, wsUri, glUri);
			const { inserted, verification } = result;

			// Verification info is already included in the result, no need to reopen DB
			output.appendLine(`Import verification: ${verification.totalComposers} total composers listed in workspace DB.`);
			output.appendLine(`Import verification: KV entries inserted: ${inserted}.`);
			output.appendLine(`${'='.repeat(50)}\n`);
			output.show(true);

			const msg = `Import complete. ${cloned.allComposers.length} chats imported. Reload Cursor to see changes.`;
			vscode.window.showInformationMessage(msg);
		});

	} catch (err) {
		console.error(err);
		
		let errorMessage = `Import failed: ${err.message || String(err)}`;
		
		vscode.window.showErrorMessage(errorMessage);
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
		vscode.commands.registerCommand('cursorChatTransfer.import', doImport)
	);
}

function deactivate() {}

module.exports = {
	activate,
	deactivate
};
