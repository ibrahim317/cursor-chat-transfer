'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');

function getDefaultCursorUserDir() {
	const platform = process.platform;
	if (platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor');
	}
	if (platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, 'Cursor');
	}
	return path.join(os.homedir(), '.config', 'Cursor');
}

function toUriIfExists(filePath) {
	try {
		if (filePath && fs.existsSync(filePath)) {
			return vscode.Uri.file(filePath);
		}
	} catch {}
	return undefined;
}

function resolveWorkspaceStorageDir() {
	const envPath = process.env.WORKSPACE_PATH;
	if (envPath && envPath.trim() !== '') {
		const expanded = envPath.startsWith('~') ? path.join(os.homedir(), envPath.slice(1)) : envPath;
		if (fs.existsSync(expanded)) return expanded;
	}
	const remoteLinux = path.join(os.homedir(), '.cursor-server', 'data', 'User', 'workspaceStorage');
	if (fs.existsSync(remoteLinux)) return remoteLinux;
	const isWSL = !!process.env.WSL_DISTRO_NAME || (process.platform === 'linux' && fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'));
	if (isWSL) {
		const winUser = process.env.WINDOWS_USER || process.env.USER || process.env.USERNAME;
		if (winUser) {
			const wslPath = path.join('/mnt', 'c', 'Users', winUser, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage');
			if (fs.existsSync(wslPath)) return wslPath;
		}
		try {
			const usersDir = '/mnt/c/Users';
			if (fs.existsSync(usersDir)) {
				const names = fs.readdirSync(usersDir);
				for (const name of names) {
					const p = path.join(usersDir, name, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage');
					if (fs.existsSync(p)) return p;
				}
			}
		} catch {}
	}
	const base = getDefaultCursorUserDir();
	return path.join(base, 'User', 'workspaceStorage');
}

function listWorkspaceStateDbs(max = 20) {
	const root = resolveWorkspaceStorageDir();
	const results = [];
	try {
		const entries = fs.readdirSync(root, { withFileTypes: true });
		for (const ent of entries) {
			if (!ent.isDirectory()) continue;
			const candidate = path.join(root, ent.name, 'state.vscdb');
			if (!fs.existsSync(candidate)) continue;
			const stat = fs.statSync(candidate);
			results.push({ path: candidate, mtime: stat.mtimeMs || 0, hash: ent.name });
		}
	} catch {}
	results.sort((a, b) => b.mtime - a.mtime);
	return results.slice(0, max);
}

function tryGetWorkspaceName(hash) {
	try {
		const root = resolveWorkspaceStorageDir();
		const wsJson = path.join(root, hash, 'workspace.json');
		if (!fs.existsSync(wsJson)) return undefined;
		const text = fs.readFileSync(wsJson, 'utf8');
		const obj = JSON.parse(text);
		const folder = obj && obj.folder;
		if (typeof folder !== 'string') return undefined;
		let p = folder;
		if (p.startsWith('file://')) {
			try {
				const url = new URL(p);
				p = url.pathname;
			} catch {}
		}
		const base = path.basename(p);
		return base || undefined;
	} catch {
		return undefined;
	}
}

function tryGetWorkspaceFolderPath(hash) {
	try {
		const root = resolveWorkspaceStorageDir();
		const wsJson = path.join(root, hash, 'workspace.json');
		if (!fs.existsSync(wsJson)) return undefined;
		const text = fs.readFileSync(wsJson, 'utf8');
		const obj = JSON.parse(text);
		const folder = obj && obj.folder;
		if (typeof folder !== 'string') return undefined;
		let p = folder;
		if (p.startsWith('file://')) {
			try {
				const url = new URL(p);
				p = url.pathname;
			} catch {}
		}
		return p || undefined;
	} catch {
		return undefined;
	}
}

function getCurrentWorkspaceName() {
	try {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) return undefined;
		const p = folders[0].uri.fsPath;
		return path.basename(p);
	} catch {
		return undefined;
	}
}

function getCurrentWorkspaceStateDbUri() {
	try {
		const name = getCurrentWorkspaceName();
		if (!name) return undefined;
		const list = listWorkspaceStateDbs(50);
		for (const c of list) {
			const n = tryGetWorkspaceName(c.hash);
			if (n && n === name) {
				return vscode.Uri.file(c.path);
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function pickWorkspaceStateDb() {
	const defaultDir = resolveWorkspaceStorageDir();
	const uri = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		title: 'Select workspace state.vscdb (Cursor/User/workspaceStorage/<hash>/state.vscdb)',
		openLabel: 'Select state.vscdb',
		defaultUri: fs.existsSync(defaultDir) ? vscode.Uri.file(defaultDir) : undefined,
		filters: { 'SQLite DB': ['vscdb'] }
	});
	return uri && uri[0];
}

async function quickPickWorkspaceDbOrBrowse() {
	const candidates = listWorkspaceStateDbs(20);
	if (candidates.length === 0) {
		return pickWorkspaceStateDb();
	}
	const items = candidates.map(c => {
		const name = tryGetWorkspaceName(c.hash) || c.hash;
		const folderPath = tryGetWorkspaceFolderPath(c.hash);
		const label = name;
		const description = folderPath || c.hash;
		const detail = new Date(c.mtime).toLocaleString();
		return { label, description, detail, path: c.path };
	});
	items.push({ label: 'Browse…', description: 'Pick a workspace state.vscdb manually', browse: true });
	const pick = await vscode.window.showQuickPick(items, {
		title: 'Select workspace storage (most recent first)',
		placeHolder: 'Choose the workspace to export/import into'
	});
	if (!pick) return undefined;
	if (pick.browse) {
		return pickWorkspaceStateDb();
	}
	return vscode.Uri.file(pick.path);
}

async function pickGlobalStateDb(getDefaultCursorUserDir) {
	const defaultDir = path.join(getDefaultCursorUserDir(), 'User', 'globalStorage');
	const uri = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		title: 'Select globalStorage state.vscdb (Cursor/User/globalStorage/state.vscdb)',
		openLabel: 'Select state.vscdb',
		defaultUri: fs.existsSync(defaultDir) ? vscode.Uri.file(defaultDir) : undefined,
		filters: { 'SQLite DB': ['vscdb'] }
	});
	return uri && uri[0];
}

function quickPickGlobalDbOrBrowse(getDefaultCursorUserDir) {
	const uri = toUriIfExists(path.join(getDefaultCursorUserDir(), 'User', 'globalStorage', 'state.vscdb'));
	if (uri) return Promise.resolve(uri);
	return pickGlobalStateDb(getDefaultCursorUserDir);
}

module.exports = {
	getDefaultCursorUserDir,
	resolveWorkspaceStorageDir,
	listWorkspaceStateDbs,
	tryGetWorkspaceName,
	tryGetWorkspaceFolderPath,
	getCurrentWorkspaceName,
	getCurrentWorkspaceStateDbUri,
	quickPickWorkspaceDbOrBrowse,
	quickPickGlobalDbOrBrowse,
	toUriIfExists,
	pickWorkspaceStateDb,
	pickGlobalStateDb
};


