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
		
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Performing local chat transfer...",
			cancellable: false
		}, async (progress) => {
			progress.report({ message: "Building export object..." });
			let exp = await transferMod.buildExportObject(sourceWsUri, glUri);
			let sourceIds = (exp.allComposers || []).map(c => c.composerId).filter(Boolean);
			
			output.appendLine(`\n=== ${mode.toUpperCase()} MODE DIAGNOSTICS ===`);
			output.appendLine(`[${mode}] Found ${exp.allComposers.length} composers to transfer`);
			output.appendLine(`[${mode}] Composers with data: ${Object.keys(exp.composers || {}).length}`);
			output.appendLine(`[${mode}] Composers with bubbles: ${Object.keys(exp.bubbles || {}).length}`);
			
			// Show detailed debug info
			if (exp.debugInfo) {
				output.appendLine(`\n--- Debug Information ---`);
				output.appendLine(`Total composer IDs in workspace: ${exp.debugInfo.totalComposers}`);
				output.appendLine(`ComposerData keys found in global DB: ${exp.debugInfo.composerDataKeysFound}`);
				output.appendLine(`Bubble keys found in global DB: ${exp.debugInfo.bubbleKeysFound}`);
				
				if (exp.debugInfo.composerIds.length > 0) {
					output.appendLine(`Sample composer IDs from workspace: ${exp.debugInfo.composerIds.slice(0, 3).join(', ')}`);
				}
				
				if (exp.debugInfo.sampleComposerDataKeys.length > 0) {
					output.appendLine(`Sample composerData keys from global DB: ${exp.debugInfo.sampleComposerDataKeys.slice(0, 3).join(', ')}`);
				} else {
					output.appendLine(`⚠ WARNING: No composerData keys found in global DB!`);
				}
				
				if (exp.debugInfo.sampleBubbleKeys.length > 0) {
					output.appendLine(`Sample bubble keys from global DB: ${exp.debugInfo.sampleBubbleKeys.slice(0, 3).join(', ')}`);
				}
				
				if (exp.debugInfo.missingComposerData.length > 0) {
					output.appendLine(`\n⚠ Composers missing data: ${exp.debugInfo.missingComposerData.length}/${exp.debugInfo.totalComposers}`);
					output.appendLine(`Missing IDs: ${exp.debugInfo.missingComposerData.slice(0, 3).join(', ')}${exp.debugInfo.missingComposerData.length > 3 ? '...' : ''}`);
				}
			}
			output.appendLine(`---\n`);
			
			// Warn if no data found
			if (exp.allComposers.length > 0 && Object.keys(exp.composers || {}).length === 0) {
				const warning = `⚠ WARNING: Found ${exp.allComposers.length} composer(s) in workspace but no data in global storage. The composers might be empty or the wrong global DB was selected.`;
				output.appendLine(warning);
				vscode.window.showWarningMessage(warning);
			}
			
			if (mode === 'copy') {
				progress.report({ message: "Cloning for copy..." });
				const { cloned } = transferMod.cloneExportObjectForCopy(exp);
				exp = cloned;
				output.appendLine(`[copy] Cloned ${exp.allComposers.length} composers with new IDs`);
			}
			
			progress.report({ message: "Importing into target..." });
			const result = await transferMod.importFromObject(exp, targetWsUri, glUri);
			const inserted = result.inserted;
			
			if (mode === 'cut') {
				progress.report({ message: "Removing from source..." });
				await transferMod.removeComposersFromWorkspace(sourceWsUri, sourceIds);
			}

			output.appendLine(`Local Import done. KV inserted: ${inserted}`);
			output.appendLine(`=== END DIAGNOSTICS ===\n`);
			output.show(true);
		});


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

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Exporting chats...",
			cancellable: false
		}, async (progress) => {
			progress.report({ message: "Reading workspace database..." });
			const wsDb = await dbMod.openSqlite(wsUri.fsPath);
			const composerData = await dbMod.readItemTableComposer(wsDb);
			if (!composerData || !Array.isArray(composerData.allComposers)) {
				vscode.window.showWarningMessage('No composer.composerData found in the selected workspace DB.');
				wsDb.close();
				return;
			}
			let allComposers = composerData.allComposers;
			wsDb.close(); // Close early

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

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Importing chats...",
			cancellable: false
		}, async (progress) => {
			progress.report({ message: "Importing from object..." });
			const result = await transferMod.importFromObject(obj, wsUri, glUri);
			const { inserted, verification } = result;

			// Verification info is already included in the result, no need to reopen DB
			if (!output) output = vscode.window.createOutputChannel('Cursor Chat Transfer');
			output.appendLine(`Import verification: ${verification.totalComposers} total composers listed in workspace DB.`);
			output.appendLine(`Import verification: attempted KV insertions ${inserted}.`);
			output.show(true);

			const msg = `Import complete. Workspace composers now ${verification.totalComposers}. KV inserted ${inserted}. Reload Cursor to see changes.`;
			const choice = await vscode.window.showInformationMessage(msg, 'Reload Window');
			if (choice === 'Reload Window') {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});

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


