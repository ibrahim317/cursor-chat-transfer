'use strict';

const sqlite3 = require('@vscode/sqlite3').verbose();

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
 * Read all bubbles for a composerId.
 * Returns array of { key, value, bubbleId } where key format is bubbleId:<composerId>:<bubbleId>
 */
function readBubblesForComposer(db, composerId) {
	return new Promise((resolve, reject) => {
		const prefix = `bubbleId:${composerId}:`;
		db.all("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?", [`${prefix}%`], (err, rows) => {
			if (err) return reject(err);
			const bubbles = [];
			for (const row of rows || []) {
				if (!row || !row.key) continue;
				// Extract bubbleId from key: bubbleId:<composerId>:<bubbleId>
				const parts = row.key.split(':');
				if (parts.length >= 3 && parts[0] === 'bubbleId') {
					const bubbleId = parts.slice(2).join(':'); // Handle case where bubbleId itself contains colons
					const val = typeof row.value === 'string' ? row.value : row.value?.toString();
					bubbles.push({ key: row.key, value: val, bubbleId });
				}
			}
			resolve(bubbles);
		});
	});
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


