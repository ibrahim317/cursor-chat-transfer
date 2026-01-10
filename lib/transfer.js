'use strict';

const { 
	openSqliteReadOnly, 
	readItemTableComposer, 
	readCursorDiskKV, 
	readBubblesForComposer, 
	listCursorDiskKVKeys,
	insertKVWithCLI,
	updateItemTableWithCLI,
	readItemTableWithCLI,
	checkIntegrity,
	createBackup,
	removeBackup
} = require('./db');
const { randomUUID } = require('crypto');

async function buildExportObject(wsUri, glUri, selectedComposerIds = undefined) {
	// Use read-only mode for export (no changes to source databases)
	const wsDb = await openSqliteReadOnly(wsUri.fsPath);
	const glDb = await openSqliteReadOnly(glUri.fsPath);
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
		// Close read-only (no save needed)
		wsDb.closeReadOnly();
		glDb.closeReadOnly();
	}
}

async function importFromObject(obj, wsUri, glUri) {
	let inserted = 0;
	let wsBackupPath = null;
	let glBackupPath = null;
	
	try {
		// Create backups before any modifications
		console.log('[import] Creating backups...');
		wsBackupPath = createBackup(wsUri.fsPath);
		glBackupPath = createBackup(glUri.fsPath);
		console.log(`[import] Workspace backup: ${wsBackupPath}`);
		console.log(`[import] Global backup: ${glBackupPath}`);
		
		// Verify database integrity before starting
		const wsIntegrity = await checkIntegrity(wsUri.fsPath);
		const glIntegrity = await checkIntegrity(glUri.fsPath);
		
		if (!wsIntegrity || !glIntegrity) {
			throw new Error(
				`Database integrity check failed before import. ` +
				`Workspace DB: ${wsIntegrity ? 'OK' : 'CORRUPTED'}, ` +
				`Global DB: ${glIntegrity ? 'OK' : 'CORRUPTED'}. ` +
				`Import aborted to prevent further damage.`
			);
		}
		
		// Prepare KV pairs for global database
		const kvPairs = [];
		
		// Add composer data
		for (const [id, value] of Object.entries(obj.composers || {})) {
			kvPairs.push({ key: `composerData:${id}`, value });
		}
		
		// Add bubbles
		for (const [composerId, composerBubbles] of Object.entries(obj.bubbles || {})) {
			if (!Array.isArray(composerBubbles)) continue;
			for (const bubble of composerBubbles) {
				if (!bubble || !bubble.key || !bubble.value) continue;
				kvPairs.push({ key: bubble.key, value: bubble.value });
			}
		}
		
		// Insert into global DB using sqlite3 CLI (handles WAL properly)
		if (kvPairs.length > 0) {
			console.log(`[import] Inserting ${kvPairs.length} KV pairs into global DB...`);
			inserted = insertKVWithCLI(glUri.fsPath, kvPairs);
			console.log(`[import] Inserted ${inserted} KV pairs`);
		}
		
		// Update workspace DB with new composer list
		// First read current data using CLI
		const currentJson = readItemTableWithCLI(wsUri.fsPath, 'composer.composerData');
		const current = currentJson ? JSON.parse(currentJson) : {};
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
			const mergedJson = JSON.stringify(merged);
			console.log(`[import] Adding ${additions.length} composers to workspace DB...`);
			updateItemTableWithCLI(wsUri.fsPath, 'composer.composerData', mergedJson);
		}
		
		// Verify integrity after changes
		const wsIntegrityAfter = await checkIntegrity(wsUri.fsPath);
		const glIntegrityAfter = await checkIntegrity(glUri.fsPath);
		
		if (!wsIntegrityAfter || !glIntegrityAfter) {
			throw new Error(
				`Database integrity check failed after import. ` +
				`Workspace DB: ${wsIntegrityAfter ? 'OK' : 'CORRUPTED'}, ` +
				`Global DB: ${glIntegrityAfter ? 'OK' : 'CORRUPTED'}. `
			);
		}
		
		// Get verification info
		const verifyJson = readItemTableWithCLI(wsUri.fsPath, 'composer.composerData');
		const verify = verifyJson ? JSON.parse(verifyJson) : {};
		const verifyList = Array.isArray(verify.allComposers) ? verify.allComposers : [];
		const verifyIds = new Set(verifyList.map(c => c.composerId).filter(Boolean));
		
		// Success - clean up backups
		console.log('[import] Success! Cleaning up backups...');
		removeBackup(wsBackupPath);
		removeBackup(glBackupPath);
		
		return {
			inserted,
			verification: {
				totalComposers: verifyIds.size,
				composerIds: Array.from(verifyIds)
			}
		};
	} catch (err) {
		console.error('[import] Error during import:', err);
		// Keep backups on error for manual recovery
		console.log('[import] Backups preserved for recovery:');
		if (wsBackupPath) console.log(`  Workspace: ${wsBackupPath}`);
		if (glBackupPath) console.log(`  Global: ${glBackupPath}`);
		throw err;
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
	
	const backupPath = createBackup(wsUri.fsPath);
	
	try {
		const currentJson = readItemTableWithCLI(wsUri.fsPath, 'composer.composerData');
		const current = currentJson ? JSON.parse(currentJson) : {};
		const currentList = Array.isArray(current.allComposers) ? current.allComposers : [];
		const removeSet = new Set(composerIdsToRemove);
		const nextList = currentList.filter(c => !c || !c.composerId || !removeSet.has(c.composerId));
		const merged = { ...current, allComposers: nextList };
		updateItemTableWithCLI(wsUri.fsPath, 'composer.composerData', JSON.stringify(merged));
		
		// Success - remove backup
		removeBackup(backupPath);
	} catch (err) {
		console.error('[remove] Error removing composers:', err);
		console.log(`[remove] Backup preserved: ${backupPath}`);
		throw err;
	}
}

module.exports = {
	buildExportObject,
	importFromObject,
	cloneExportObjectForCopy,
	removeComposersFromWorkspace
};
