'use strict';

const { openSqlite, exec, run, readItemTableComposer, writeItemTableComposer, readCursorDiskKV, hasCursorDiskKV, insertCursorDiskKV, upsertCursorDiskKV, readBubblesForComposer, listCursorDiskKVKeys } = require('./db');
const { randomUUID } = require('crypto');

async function buildExportObject(wsUri, glUri, selectedComposerIds = undefined) {
	const wsDb = await openSqlite(wsUri.fsPath);
	const glDb = await openSqlite(glUri.fsPath);
	const debugInfo = {
		totalComposers: 0,
		composerIds: [],
		composerDataKeysFound: 0,
		bubbleKeysFound: 0,
		sampleComposerDataKeys: [],
		sampleBubbleKeys: [],
		missingComposerData: [],
		composersWithData: 0,
		composersWithBubbles: 0
	};
	
	try {
		const composerData = await readItemTableComposer(wsDb);
		if (!composerData || !Array.isArray(composerData.allComposers)) {
			return { allComposers: [], composers: {}, bubbles: {}, debugInfo };
		}
		let allComposers = composerData.allComposers;
		if (Array.isArray(selectedComposerIds) && selectedComposerIds.length > 0) {
			const set = new Set(selectedComposerIds);
			allComposers = allComposers.filter(c => c && set.has(c.composerId));
		}
		
		const ids = allComposers.map(c => c.composerId).filter(Boolean);
		const composers = {};
		const bubbles = {};
		
		debugInfo.totalComposers = ids.length;
		debugInfo.composerIds = ids.slice(0, 5); // First 5 IDs for reference
		
		// Debug: List all cursorDiskKV keys that start with composerData or bubbleId
		console.log(`[debug] Looking for ${ids.length} composer IDs in global DB`);
		console.log(`[debug] Global DB path: ${glUri.fsPath}`);
		console.log(`[debug] First few composer IDs: ${ids.slice(0, 3).join(', ')}`);
		
		const composerDataKeys = await listCursorDiskKVKeys(glDb, 'composerData:%');
		const bubbleKeys = await listCursorDiskKVKeys(glDb, 'bubbleId:%');
		
		debugInfo.composerDataKeysFound = composerDataKeys.length;
		debugInfo.bubbleKeysFound = bubbleKeys.length;
		debugInfo.sampleComposerDataKeys = composerDataKeys.slice(0, 5);
		debugInfo.sampleBubbleKeys = bubbleKeys.slice(0, 5);
		
		console.log(`[debug] Found ${composerDataKeys.length} composerData keys in globalStorage`);
		console.log(`[debug] Found ${bubbleKeys.length} bubble keys in globalStorage`);
		if (composerDataKeys.length > 0) {
			console.log(`[debug] Sample composerData keys: ${composerDataKeys.slice(0, 3).join(', ')}`);
		}
		if (bubbleKeys.length > 0) {
			console.log(`[debug] Sample bubble keys: ${bubbleKeys.slice(0, 3).join(', ')}`);
		}
		
		// Cross-check: see if any of our composer IDs match the available keys
		const availableComposerIds = new Set(
			composerDataKeys.map(k => k.replace('composerData:', '')).filter(Boolean)
		);
		const matchedIds = ids.filter(id => availableComposerIds.has(id));
		console.log(`[debug] Cross-check: ${matchedIds.length}/${ids.length} composer IDs have matching composerData keys`);
		
		for (const id of ids) {
			// eslint-disable-next-line no-await-in-loop
			const val = await readCursorDiskKV(glDb, `composerData:${id}`);
			if (val != null) {
				composers[id] = val;
			} else {
				debugInfo.missingComposerData.push(id);
				console.warn(`[composer] No composer data found for ${id} in globalStorage`);
			}
			// eslint-disable-next-line no-await-in-loop
			const composerBubbles = await readBubblesForComposer(glDb, id);
			if (composerBubbles && composerBubbles.length > 0) {
				bubbles[id] = composerBubbles;
			}
		}
		
		debugInfo.composersWithData = Object.keys(composers).length;
		debugInfo.composersWithBubbles = Object.keys(bubbles).length;
		
		if (debugInfo.missingComposerData.length > 0) {
			console.warn(`[composer] Total composers missing data: ${debugInfo.missingComposerData.length}/${ids.length}`);
		}
		console.log(`[debug] Export summary: ${debugInfo.composersWithData} with data, ${debugInfo.composersWithBubbles} with bubbles`);
		
		return { allComposers, composers, bubbles, debugInfo };
	} finally {
		wsDb.close();
		glDb.close();
	}
}

async function importFromObject(obj, wsUri, glUri) {
	const wsDb = await openSqlite(wsUri.fsPath);
	const glDb = await openSqlite(glUri.fsPath);
	let inserted = 0;
	let wsCommitted = false;
	let glCommitted = false;
	
	try {
		// Start both transactions before making any changes
		await exec(glDb, 'BEGIN IMMEDIATE TRANSACTION');
		await exec(wsDb, 'BEGIN IMMEDIATE TRANSACTION');
		
		try {
			// First, import all data into global DB
			// Using INSERT OR IGNORE to prevent corruption from duplicate keys
			for (const [id, value] of Object.entries(obj.composers || {})) {
				const key = `composerData:${id}`;
				// eslint-disable-next-line no-await-in-loop
				await insertCursorDiskKV(glDb, key, value);
				inserted += 1;
			}
			
			// Import bubbles
			for (const [composerId, composerBubbles] of Object.entries(obj.bubbles || {})) {
				if (!Array.isArray(composerBubbles)) continue;
				for (const bubble of composerBubbles) {
					if (!bubble || !bubble.key || !bubble.value) continue;
					// eslint-disable-next-line no-await-in-loop
					await insertCursorDiskKV(glDb, bubble.key, bubble.value);
					inserted += 1;
				}
			}
			
			// Commit global DB first - if this fails, workspace won't be committed
			await exec(glDb, 'COMMIT');
			glCommitted = true;
			
			// Now update workspace DB with new composers
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
			
			if (additions.length > 0) {
				const merged = { ...current, allComposers: currentList.concat(additions) };
				await writeItemTableComposer(wsDb, merged);
			}
			
			await exec(wsDb, 'COMMIT');
			wsCommitted = true;
			
		} catch (e) {
			// Rollback both transactions on any error
			if (!glCommitted) {
				await exec(glDb, 'ROLLBACK').catch(() => {});
			}
			if (!wsCommitted) {
				await exec(wsDb, 'ROLLBACK').catch(() => {});
			}
			throw e;
		}

		// Only checkpoint if both transactions succeeded
		try { await run(glDb, 'PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
		try { await run(wsDb, 'PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
		
		// Read verification info BEFORE closing databases to avoid reopening
		const verify = (await readItemTableComposer(wsDb)) || {};
		const verifyList = Array.isArray(verify.allComposers) ? verify.allComposers : [];
		const verifyIds = new Set(verifyList.map(c => c.composerId).filter(Boolean));
		
		return {
			inserted,
			verification: {
				totalComposers: verifyIds.size,
				composerIds: Array.from(verifyIds)
			}
		};
	} finally {
		// Close databases in finally block - wrap in try-catch to prevent hanging
		try {
			glDb.close();
		} catch (err) {
			console.error('Error closing global DB:', err);
		}
		try {
			wsDb.close();
		} catch (err) {
			console.error('Error closing workspace DB:', err);
		}
	}
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
	
	// Create default composer data for any composers without data
	for (const [oldId, newId] of Object.entries(idMap)) {
		if (!cloned.composers[newId]) {
			// Find the composer metadata
			const composerMeta = cloned.allComposers.find(c => c.composerId === newId);
			const defaultData = {
				composerId: newId,
				tabs: [],
				bubbles: [],
				currentTab: null,
				version: 1
			};
			cloned.composers[newId] = JSON.stringify(defaultData);
		}
	}
	return { cloned, idMap, bubbleIdMap };
}

/**
 * Remove given composerIds from a workspace DB (source cut).
 */
async function removeComposersFromWorkspace(wsUri, composerIdsToRemove) {
	if (!composerIdsToRemove || composerIdsToRemove.length === 0) return;
	const wsDb = await openSqlite(wsUri.fsPath);
	try {
		await exec(wsDb, 'BEGIN IMMEDIATE TRANSACTION');
		try {
			const current = (await readItemTableComposer(wsDb)) || {};
			const currentList = Array.isArray(current.allComposers) ? current.allComposers : [];
			const removeSet = new Set(composerIdsToRemove);
			const nextList = currentList.filter(c => !c || !c.composerId || !removeSet.has(c.composerId));
			const merged = { ...current, allComposers: nextList };
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


