'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

function formatBytes(bytes) {
	const units = ['B', 'KB', 'MB', 'GB'];
	let i = 0;
	let size = bytes;
	while (size >= 1024 && i < units.length - 1) {
		size /= 1024;
		i++;
	}
	return `${size.toFixed(2)} ${units[i]}`;
}

/**
 * Escape a JS string for use as a SQLite single-quoted literal
 */
function sqlEscapeLiteral(value) {
	return String(value).replace(/'/g, "''");
}

function hexToUtf8(hex) {
	const clean = (hex || '').trim();
	if (!clean) return null;
	try {
		return Buffer.from(clean, 'hex').toString('utf8');
	} catch {
		return null;
	}
}

/**
 * Find sqlite3 CLI path
 */
function findSqlite3() {
	const isWindows = process.platform === 'win32';
	
	// Define paths based on platform
	const paths = isWindows ? [
		// Common Windows installation paths
		'C:\\sqlite3\\sqlite3.exe',
		'C:\\sqlite\\sqlite3.exe',
		'C:\\Program Files\\sqlite3\\sqlite3.exe',
		'C:\\Program Files\\sqlite\\sqlite3.exe',
		'C:\\Program Files (x86)\\sqlite3\\sqlite3.exe',
		'C:\\Program Files (x86)\\sqlite\\sqlite3.exe',
		// User-specific paths
		process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\sqlite3\\sqlite3.exe` : null,
		process.env.APPDATA ? `${process.env.APPDATA}\\sqlite3\\sqlite3.exe` : null,
		process.env.USERPROFILE ? `${process.env.USERPROFILE}\\sqlite3\\sqlite3.exe` : null,
		// Chocolatey installation path
		'C:\\ProgramData\\chocolatey\\bin\\sqlite3.exe',
		// Scoop installation path
		process.env.USERPROFILE ? `${process.env.USERPROFILE}\\scoop\\apps\\sqlite\\current\\sqlite3.exe` : null,
	].filter(Boolean) : [
		// Unix/macOS paths
		'/usr/bin/sqlite3',
		'/usr/local/bin/sqlite3',
		'/bin/sqlite3',
		'/opt/homebrew/bin/sqlite3',
		process.env.HOME ? `${process.env.HOME}/.android_sdk/platform-tools/sqlite3` : null,
	].filter(Boolean);
	
	for (const p of paths) {
		if (fs.existsSync(p)) {
			return p;
		}
	}
	
	// Try to find sqlite3 using system command
	try {
		if (isWindows) {
			// Use 'where' command on Windows
			const result = execSync('where sqlite3', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
			// 'where' can return multiple lines, take the first one
			const firstResult = result.split(/\r?\n/)[0];
			if (firstResult && fs.existsSync(firstResult)) {
				return firstResult;
			}
		} else {
			// Use 'which' command on Unix/macOS
			const result = execSync('which sqlite3', { encoding: 'utf8' }).trim();
			if (result && fs.existsSync(result)) {
				return result;
			}
		}
	} catch (e) {
		// Command failed, continue to next check
	}
	
	// On Windows, also try to find sqlite3.exe directly (might be in PATH without extension)
	if (isWindows) {
		try {
			const result = execSync('where sqlite3.exe', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
			const firstResult = result.split(/\r?\n/)[0];
			if (firstResult && fs.existsSync(firstResult)) {
				return firstResult;
			}
		} catch (e) {
			// Ignore
		}
	}
	
	return null;
}

/**
 * Execute SQL using sqlite3 CLI (handles WAL mode properly)
 */
function execSqlite3(dbPath, sql) {
	const sqlite3Path = findSqlite3();
	if (!sqlite3Path) {
		throw new Error('sqlite3 CLI not found. Please install sqlite3.');
	}
	
	try {
		// Use -cmd to set busy timeout for concurrent access
		return execFileSync(sqlite3Path, ['-cmd', '.timeout 5000', dbPath], {
			input: sql,
			encoding: 'utf8',
			maxBuffer: 50 * 1024 * 1024 // 50MB buffer
		});
	} catch (err) {
		console.error('[sqlite3] Error executing SQL:', err.message);
		throw err;
	}
}

function execSqlite3ListHex(dbPath, sql) {
	// Use a robust encoding strategy:
	// - query returns HEX(...) so output has only [0-9A-F]
	// - .mode list + a separator makes multi-column parsing safe
	const SEP = '\t';
	const input = [
		'.timeout 5000',
		'.mode list',
		`.separator "${SEP}"`,
		sql
	].join('\n') + '\n';
	return execSqlite3(dbPath, input);
}

function querySingleHexValue(dbPath, sql) {
	const out = execSqlite3ListHex(dbPath, sql).trim();
	if (!out) return null;
	// If sqlite3 outputs multiple lines, take the first non-empty one
	const firstLine = out.split(/\r?\n/).map(l => l.trim()).find(Boolean);
	if (!firstLine) return null;
	return hexToUtf8(firstLine);
}

function queryHexRows(dbPath, sql, colCount) {
	const out = execSqlite3ListHex(dbPath, sql);
	if (!out) return [];
	const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	if (lines.length === 0) return [];
	return lines.map(line => {
		const cols = line.split('\t');
		// Pad/truncate to expected cols
		while (cols.length < colCount) cols.push('');
		if (cols.length > colCount) cols.length = colCount;
		return cols.map(hexToUtf8);
	});
}

/**
 * Insert or ignore key-value pairs using sqlite3 CLI
 */
function insertKVWithCLI(dbPath, keyValuePairs) {
	if (!keyValuePairs || keyValuePairs.length === 0) return 0;
	
	const sqlite3Path = findSqlite3();
	if (!sqlite3Path) {
		throw new Error('sqlite3 CLI not found. Please install sqlite3.');
	}
	
	// Build SQL statements
	let sql = 'BEGIN TRANSACTION;\n';
	for (const { key, value } of keyValuePairs) {
		// Escape single quotes in key and value
		const escapedKey = sqlEscapeLiteral(key);
		const escapedValue = sqlEscapeLiteral(value);
		sql += `INSERT OR IGNORE INTO cursorDiskKV (key, value) VALUES ('${escapedKey}', '${escapedValue}');\n`;
	}
	sql += 'COMMIT;\n';
	
	try {
		execFileSync(sqlite3Path, ['-cmd', '.timeout 5000', dbPath], {
			input: sql,
			encoding: 'utf8',
			maxBuffer: 50 * 1024 * 1024
		});
		return keyValuePairs.length;
	} catch (err) {
		console.error('[sqlite3] Error inserting KV pairs:', err.message);
		throw err;
	}
}

/**
 * Update ItemTable using sqlite3 CLI
 */
function updateItemTableWithCLI(dbPath, key, value) {
	const sqlite3Path = findSqlite3();
	if (!sqlite3Path) {
		throw new Error('sqlite3 CLI not found. Please install sqlite3.');
	}
	
	const escapedKey = sqlEscapeLiteral(key);
	const escapedValue = sqlEscapeLiteral(value);
	const sql = `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${escapedKey}', '${escapedValue}');`;
	
	try {
		execFileSync(sqlite3Path, ['-cmd', '.timeout 5000', dbPath], {
			input: sql,
			encoding: 'utf8'
		});
	} catch (err) {
		console.error('[sqlite3] Error updating ItemTable:', err.message);
		throw err;
	}
}

/**
 * Read ItemTable value using sqlite3 CLI (properly handles WAL)
 */
function readItemTableWithCLI(dbPath, key) {
	const sqlite3Path = findSqlite3();
	if (!sqlite3Path) {
		return null;
	}
	
	try {
		// Use hex(value) to safely transport large JSON/text (no newline/pipe issues)
		const escapedKey = sqlEscapeLiteral(key);
		const sql = `SELECT hex(value) FROM ItemTable WHERE key = '${escapedKey}';`;
		return querySingleHexValue(dbPath, sql);
	} catch (err) {
		console.error('[sqlite3] Error reading ItemTable:', err.message);
		return null;
	}
}

/**
 * Create a backup of the database before modifying it
 */
function createBackup(dbPath) {
	const backupDir = path.dirname(dbPath);
	const baseName = path.basename(dbPath, '.vscdb');
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupPath = path.join(backupDir, `${baseName}.backup-${timestamp}.vscdb`);
	
	// Use sqlite3 CLI to create a proper backup (handles WAL)
	const sqlite3Path = findSqlite3();
	if (sqlite3Path) {
		try {
			execSync(`"${sqlite3Path}" "${dbPath}" ".backup '${backupPath}'"`, { encoding: 'utf8' });
			return backupPath;
		} catch (e) {
			console.warn('[db] sqlite3 backup failed, falling back to file copy:', e.message);
		}
	}
	
	// Fallback: Copy main database file
	fs.copyFileSync(dbPath, backupPath);
	
	// Also backup WAL and SHM files if they exist
	const walPath = dbPath + '-wal';
	const shmPath = dbPath + '-shm';
	
	if (fs.existsSync(walPath)) {
		fs.copyFileSync(walPath, backupPath + '-wal');
	}
	if (fs.existsSync(shmPath)) {
		fs.copyFileSync(shmPath, backupPath + '-shm');
	}
	
	return backupPath;
}

/**
 * Restore database from backup
 */
function restoreFromBackup(backupPath, targetPath) {
	if (!fs.existsSync(backupPath)) {
		throw new Error(`Backup file not found: ${backupPath}`);
	}
	
	fs.copyFileSync(backupPath, targetPath);
	
	// Also restore WAL and SHM files if they exist
	const walBackup = backupPath + '-wal';
	const shmBackup = backupPath + '-shm';
	
	if (fs.existsSync(walBackup)) {
		fs.copyFileSync(walBackup, targetPath + '-wal');
	}
	if (fs.existsSync(shmBackup)) {
		fs.copyFileSync(shmBackup, targetPath + '-shm');
	}
}

/**
 * Remove backup files after successful operation
 */
function removeBackup(backupPath) {
	try {
		if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
		if (fs.existsSync(backupPath + '-wal')) fs.unlinkSync(backupPath + '-wal');
		if (fs.existsSync(backupPath + '-shm')) fs.unlinkSync(backupPath + '-shm');
	} catch (err) {
		console.warn('Could not remove backup files:', err.message);
	}
}

/**
 * Check database integrity using sqlite3 CLI
 */
async function checkIntegrity(dbPath) {
	const sqlite3Path = findSqlite3();
	if (!sqlite3Path) {
		return true; // Can't check, assume OK
	}
	
	try {
		const result = execFileSync(sqlite3Path, [dbPath, 'PRAGMA integrity_check;'], {
			encoding: 'utf8'
		});
		return result.trim() === 'ok';
	} catch (err) {
		console.error('Integrity check failed:', err);
		return false;
	}
}

/**
 * Open SQLite database wrapper for read operations.
 * All DB interactions (read/write) use the sqlite3 CLI.
 */
async function openSqliteReadOnly(dbPath) {
	const sqlite3Path = findSqlite3();
	if (!sqlite3Path) {
		throw new Error('sqlite3 CLI not found. Please install sqlite3.');
	}
	if (!dbPath || !fs.existsSync(dbPath)) {
		throw new Error(`Database file not found: ${dbPath}`);
	}

	return {
		path: dbPath,
		readOnly: true,
		
		closeReadOnly() {
			// no-op (sqlite3 CLI runs per query)
		}
	};
}

function readItemTableComposer(dbWrapper) {
	try {
		const sql = "SELECT hex(value) FROM ItemTable WHERE key = 'composer.composerData';";
		const text = querySingleHexValue(dbWrapper.path, sql);
		if (!text) return Promise.resolve(null);
		return Promise.resolve(JSON.parse(text));
	} catch (err) {
		return Promise.reject(err);
	}
}

function readCursorDiskKV(dbWrapper, key) {
	try {
		const escapedKey = sqlEscapeLiteral(key);
		const sql = `SELECT hex(value) FROM cursorDiskKV WHERE key = '${escapedKey}';`;
		const val = querySingleHexValue(dbWrapper.path, sql);
		return Promise.resolve(val);
	} catch (err) {
		return Promise.reject(err);
	}
}

/**
 * Read all bubbles for a composerId.
 * Returns array of { key, value, bubbleId } where key format is bubbleId:<composerId>:<bubbleId>
 */
function readBubblesForComposer(dbWrapper, composerId) {
	try {
		const prefix = `bubbleId:${composerId}:`;
		const escapedPrefix = sqlEscapeLiteral(prefix);
		const sql = `SELECT hex(key), hex(value) FROM cursorDiskKV WHERE key LIKE '${escapedPrefix}%';`;
		const rows = queryHexRows(dbWrapper.path, sql, 2);
		const bubbles = [];
		for (const [k, v] of rows) {
			if (!k) continue;
			// Extract bubbleId from key: bubbleId:<composerId>:<bubbleId>
			const parts = k.split(':');
			if (parts.length >= 3 && parts[0] === 'bubbleId') {
				const bubbleId = parts.slice(2).join(':'); // bubbleId itself could contain colons
				bubbles.push({ key: k, value: v || '', bubbleId });
			}
		}
		return Promise.resolve(bubbles);
	} catch (err) {
		return Promise.reject(err);
	}
}

/**
 * List all keys in cursorDiskKV that match a pattern
 */
function listCursorDiskKVKeys(dbWrapper, pattern) {
	try {
		const escapedPattern = sqlEscapeLiteral(pattern);
		const sql = `SELECT hex(key) FROM cursorDiskKV WHERE key LIKE '${escapedPattern}';`;
		const out = execSqlite3ListHex(dbWrapper.path, sql);
		const keys = out
			.split(/\r?\n/)
			.map(l => l.trim())
			.filter(Boolean)
			.map(hexToUtf8)
			.filter(Boolean);
		return Promise.resolve(keys);
	} catch (err) {
		return Promise.reject(err);
	}
}

/**
 * List all backup files for a database
 */
function listBackups(dbPath) {
	const dir = path.dirname(dbPath);
	const baseName = path.basename(dbPath, '.vscdb');
	const pattern = new RegExp(`^${baseName}\\.backup-.*\\.vscdb$`);
	
	try {
		const files = fs.readdirSync(dir);
		return files
			.filter(f => pattern.test(f) && !f.endsWith('-wal') && !f.endsWith('-shm'))
			.map(f => ({
				path: path.join(dir, f),
				name: f,
				timestamp: f.match(/backup-(.+)\.vscdb$/)?.[1] || ''
			}))
			.sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // Most recent first
	} catch (err) {
		console.error('Error listing backups:', err);
		return [];
	}
}

module.exports = {
	openSqliteReadOnly,
	readItemTableComposer,
	readCursorDiskKV,
	readBubblesForComposer,
	listCursorDiskKVKeys,
	// CLI-based write operations (handles WAL properly)
	insertKVWithCLI,
	updateItemTableWithCLI,
	readItemTableWithCLI,
	execSqlite3,
	findSqlite3,
	// Backup operations
	checkIntegrity,
	createBackup,
	restoreFromBackup,
	removeBackup,
	listBackups,
	formatBytes,
};
