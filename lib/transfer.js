'use strict';

const { openSqlite, exec, run, readItemTableComposer, writeItemTableComposer, readCursorDiskKV, hasCursorDiskKV, insertCursorDiskKV, readBubblesForComposer } = require('./db');
const { randomUUID } = require('crypto');

async function buildExportObject(wsUri, glUri, selectedComposerIds = undefined) {
	const wsDb = openSqlite(wsUri.fsPath);
	const glDb = openSqlite(glUri.fsPath);
	try {
		const composerData = await readItemTableComposer(wsDb);
		if (!composerData || !Array.isArray(composerData.allComposers)) {
			return { allComposers: [], composers: {}, bubbles: {} };
		}
		let allComposers = composerData.allComposers;
		if (Array.isArray(selectedComposerIds) && selectedComposerIds.length > 0) {
			const set = new Set(selectedComposerIds);
			allComposers = allComposers.filter(c => c && set.has(c.composerId));
		}
		const ids = allComposers.map(c => c.composerId).filter(Boolean);
		const composers = {};
		const bubbles = {};
		for (const id of ids) {
			// eslint-disable-next-line no-await-in-loop
			const val = await readCursorDiskKV(glDb, `composerData:${id}`);
			if (val != null) {
				composers[id] = val;
			}
			// eslint-disable-next-line no-await-in-loop
			const composerBubbles = await readBubblesForComposer(glDb, id);
			if (composerBubbles && composerBubbles.length > 0) {
				bubbles[id] = composerBubbles;
			}
		}
		return { allComposers, composers, bubbles };
	} finally {
		wsDb.close();
		glDb.close();
	}
}

async function importFromObject(obj, wsUri, glUri) {
	const wsDb = openSqlite(wsUri.fsPath);
	const glDb = openSqlite(glUri.fsPath);
	let inserted = 0;
	try {
		await exec(wsDb, 'BEGIN IMMEDIATE TRANSACTION');
		try {
			const current = (await readItemTableComposer(wsDb)) || {};
			const currentList = Array.isArray(current.allComposers) ? current.allComposers : [];
			const existingIds = new Set(currentList.map(c => c.composerId).filter(Boolean));
			const additions = [];
			for (const c of (obj.allComposers || [])) {
				if (!c || !c.composerId) continue;
				if (!existingIds.has(c.composerId)) {
					additions.push(c);
					existingIds.add(c.composerId);
				}
			}
			const merged = { ...current, allComposers: currentList.concat(additions) };
			await writeItemTableComposer(wsDb, merged);
			await exec(wsDb, 'COMMIT');
		} catch (e) {
			await exec(wsDb, 'ROLLBACK').catch(() => {});
			throw e;
		}

		await exec(glDb, 'BEGIN IMMEDIATE TRANSACTION');
		try {
			for (const [id, value] of Object.entries(obj.composers || {})) {
				const key = `composerData:${id}`;
				// eslint-disable-next-line no-await-in-loop
				const exists = await hasCursorDiskKV(glDb, key);
				if (!exists) {
					// eslint-disable-next-line no-await-in-loop
					await insertCursorDiskKV(glDb, key, value);
					inserted += 1;
				}
			}
			// Import bubbles
			for (const [composerId, composerBubbles] of Object.entries(obj.bubbles || {})) {
				if (!Array.isArray(composerBubbles)) continue;
				for (const bubble of composerBubbles) {
					if (!bubble || !bubble.key || !bubble.value) continue;
					// eslint-disable-next-line no-await-in-loop
					const exists = await hasCursorDiskKV(glDb, bubble.key);
					if (!exists) {
						// eslint-disable-next-line no-await-in-loop
						await insertCursorDiskKV(glDb, bubble.key, bubble.value);
						inserted += 1;
					}
				}
			}
			await exec(glDb, 'COMMIT');
		} catch (e) {
			await exec(glDb, 'ROLLBACK').catch(() => {});
			throw e;
		}

		try { await run(wsDb, 'PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
		try { await run(glDb, 'PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
	} finally {
		wsDb.close();
		glDb.close();
	}
	return inserted;
}

/**
 * Clone export object with new composerIds and bubbleIds (copy mode).
 * Returns { cloned, idMap, bubbleIdMap }
 */
function cloneExportObjectForCopy(obj) {
	const idMap = {};
	const bubbleIdMap = {}; // old bubbleId -> new bubbleId
	const cloned = { allComposers: [], composers: {}, bubbles: {} };
	const now = Date.now();
	let idx = 0;
	
	// Clone composers and create composerId mapping
	for (const c of obj.allComposers || []) {
		if (!c || !c.composerId) continue;
		const newId = randomUUID();
		idMap[c.composerId] = newId;
		const nc = {
			...c,
			composerId: newId,
			name: c.name ? `${c.name} (Copy)` : 'Copied Chat',
			createdAt: now + idx,
			lastUpdatedAt: now + idx
		};
		cloned.allComposers.push(nc);
		idx += 1;
	}
	
	// Clone bubbles with new IDs
	for (const [oldComposerId, composerBubbles] of Object.entries(obj.bubbles || {})) {
		const newComposerId = idMap[oldComposerId];
		if (!newComposerId || !Array.isArray(composerBubbles)) continue;
		const newBubbles = [];
		for (const bubble of composerBubbles) {
			if (!bubble || !bubble.bubbleId) continue;
			const newBubbleId = randomUUID();
			bubbleIdMap[bubble.bubbleId] = newBubbleId;
			const newKey = `bubbleId:${newComposerId}:${newBubbleId}`;
			// Update bubble value to replace old bubbleId references
			let bubbleValue = bubble.value || '';
			if (typeof bubbleValue === 'string') {
				bubbleValue = bubbleValue.split(bubble.bubbleId).join(newBubbleId);
				bubbleValue = bubbleValue.split(oldComposerId).join(newComposerId);
			}
			newBubbles.push({ key: newKey, value: bubbleValue, bubbleId: newBubbleId });
		}
		if (newBubbles.length > 0) {
			cloned.bubbles[newComposerId] = newBubbles;
		}
	}
	
	// Clone composer data and update all references
	for (const [oldId, val] of Object.entries(obj.composers || {})) {
		const newId = idMap[oldId];
		if (!newId) continue;
		let text = typeof val === 'string' ? val : String(val);
		try {
			const parsed = JSON.parse(text);
			parsed.composerId = newId;
			// Replace composerId references
			let serialized = JSON.stringify(parsed);
			serialized = serialized.split(oldId).join(newId);
			// Replace bubbleId references
			for (const [oldBubbleId, newBubbleId] of Object.entries(bubbleIdMap)) {
				serialized = serialized.split(oldBubbleId).join(newBubbleId);
			}
			cloned.composers[newId] = serialized;
		} catch {
			// fallback: replace occurrences in raw string
			let replaced = text.split(oldId).join(newId);
			for (const [oldBubbleId, newBubbleId] of Object.entries(bubbleIdMap)) {
				replaced = replaced.split(oldBubbleId).join(newBubbleId);
			}
			cloned.composers[newId] = replaced;
		}
	}
	return { cloned, idMap, bubbleIdMap };
}

/**
 * Remove given composerIds from a workspace DB (source cut).
 */
async function removeComposersFromWorkspace(wsUri, composerIdsToRemove) {
	if (!composerIdsToRemove || composerIdsToRemove.length === 0) return;
	const wsDb = openSqlite(wsUri.fsPath);
	try {
		await exec(wsDb, 'BEGIN IMMEDIATE TRANSACTION');
		try {
			const current = (await readItemTableComposer(wsDb)) || {};
			const currentList = Array.isArray(current.allComposers) ? current.allComposers : [];
			const removeSet = new Set(composerIdsToRemove);
			const next = currentList.filter(c => !c?.composerId || !removeSet.has(c.composerId));
			const merged = { ...current, allComposers: next };
			await writeItemTableComposer(wsDb, merged);
			await exec(wsDb, 'COMMIT');
		} catch (e) {
			await exec(wsDb, 'ROLLBACK').catch(() => {});
			throw e;
		}
		try { await run(wsDb, 'PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
	} finally {
		wsDb.close();
	}
}

module.exports = {
	buildExportObject,
	importFromObject,
	cloneExportObjectForCopy,
	removeComposersFromWorkspace
};


