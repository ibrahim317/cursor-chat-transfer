'use strict';

const initSqlJs = require('sql.js');
const fs = require('fs');

let SQL = null;

async function ensureSqlJs() {
	if (!SQL) {
		SQL = await initSqlJs();
	}
	return SQL;
}

/**
 * Open SQLite database and return a wrapped object with:
 * - db: the sql.js Database instance
 * - path: the file path
 * - close(): saves changes back to disk and closes
 */
async function openSqlite(dbPath) {
	await ensureSqlJs();
	const buffer = fs.readFileSync(dbPath);
	const db = new SQL.Database(buffer);
	
	return {
		db,
		path: dbPath,
		close() {
			try {
				const data = db.export();
				fs.writeFileSync(dbPath, data);
				db.close();
			} catch (err) {
				console.error('Error closing database:', err);
				throw err;
			}
		}
	};
}

function run(dbWrapper, sql, params = []) {
	try {
		dbWrapper.db.run(sql, params);
		return Promise.resolve();
	} catch (err) {
		return Promise.reject(err);
	}
}

function exec(dbWrapper, sql) {
	try {
		dbWrapper.db.exec(sql);
		return Promise.resolve();
	} catch (err) {
		return Promise.reject(err);
	}
}

function readItemTableComposer(dbWrapper) {
	try {
		const stmt = dbWrapper.db.prepare("SELECT value FROM ItemTable WHERE key = ?");
		stmt.bind(['composer.composerData']);
		
		if (stmt.step()) {
			const row = stmt.getAsObject();
			stmt.free();
			
			if (!row.value) return Promise.resolve(null);
			
			const text = typeof row.value === 'string' ? row.value : 
			             (row.value instanceof Uint8Array ? new TextDecoder().decode(row.value) : String(row.value));
			const json = JSON.parse(text);
			return Promise.resolve(json);
		}
		
		stmt.free();
		return Promise.resolve(null);
	} catch (err) {
		return Promise.reject(err);
	}
}

function writeItemTableComposer(dbWrapper, json) {
	try {
		const payload = JSON.stringify(json);
		dbWrapper.db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", 
			['composer.composerData', payload]);
		return Promise.resolve();
	} catch (err) {
		return Promise.reject(err);
	}
}

function readCursorDiskKV(dbWrapper, key) {
	try {
		const stmt = dbWrapper.db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
		stmt.bind([key]);
		
		if (stmt.step()) {
			const row = stmt.getAsObject();
			stmt.free();
			
			if (!row.value) return Promise.resolve(null);
			
			const val = typeof row.value === 'string' ? row.value : 
			            (row.value instanceof Uint8Array ? new TextDecoder().decode(row.value) : String(row.value));
			return Promise.resolve(val);
		}
		
		stmt.free();
		return Promise.resolve(null);
	} catch (err) {
		return Promise.reject(err);
	}
}

function hasCursorDiskKV(dbWrapper, key) {
	try {
		const stmt = dbWrapper.db.prepare("SELECT 1 AS ok FROM cursorDiskKV WHERE key = ? LIMIT 1");
		stmt.bind([key]);
		const exists = stmt.step();
		stmt.free();
		return Promise.resolve(exists);
	} catch (err) {
		return Promise.reject(err);
	}
}

function insertCursorDiskKV(dbWrapper, key, value) {
	try {
		dbWrapper.db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [key, value]);
		return Promise.resolve();
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
		const stmt = dbWrapper.db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?");
		stmt.bind([`${prefix}%`]);
		
		const bubbles = [];
		while (stmt.step()) {
			const row = stmt.getAsObject();
			if (!row || !row.key) continue;
			
			// Extract bubbleId from key: bubbleId:<composerId>:<bubbleId>
			const parts = row.key.split(':');
			if (parts.length >= 3 && parts[0] === 'bubbleId') {
				const bubbleId = parts.slice(2).join(':'); // Handle case where bubbleId itself contains colons
				const val = typeof row.value === 'string' ? row.value : 
				            (row.value instanceof Uint8Array ? new TextDecoder().decode(row.value) : String(row.value));
				bubbles.push({ key: row.key, value: val, bubbleId });
			}
		}
		
		stmt.free();
		return Promise.resolve(bubbles);
	} catch (err) {
		return Promise.reject(err);
	}
}

module.exports = {
	openSqlite,
	run,
	exec,
	readItemTableComposer,
	writeItemTableComposer,
	readCursorDiskKV,
	hasCursorDiskKV,
	insertCursorDiskKV,
	readBubblesForComposer
};
