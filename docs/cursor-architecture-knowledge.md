# Cursor Chat Storage Architecture

This document describes how Cursor IDE stores chat conversation data internally, based on direct inspection of real Cursor SQLite databases on **Windows** (paths under `%APPDATA%/Cursor/User/`).

---

## 1. File Layout Overview

There are **two** SQLite databases involved in chat storage:

| Database | Location | Purpose |
|---|---|---|
| **Global DB** | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` | Central store for chat metadata headers, KV content data, bubbles, agent KV state, and cross-workspace data |
| **Workspace DB** | `%APPDATA%/Cursor/User/workspaceStorage/<hash>/state.vscdb` | Per-workspace store for UI state, workspace-specific settings, and the composing list of active chat IDs |

Each workspace gets a unique hash folder under `workspaceStorage/`. The mapping from hash to project is in `workspace.json` within each folder:

```json
{
  "folder": "file:///c%3A/Users/your-username/your-project"
}
```

---

## 2. Database Tables

Both databases have exactly two tables:

### `ItemTable`
A general-purpose key-value store for structured JSON blobs and settings.

**Schema:**
```sql
CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);
```

Key entries relevant to chat:

| Key | Location | Content |
|---|---|---|
| `composer.composerData` | Workspace DB | Lightweight JSON: `selectedComposerIds`, `lastFocusedComposerIds`, `hasMigratedComposerData`, `hasMigratedMultipleComposers`. May also contain `allComposers` array in pre-full-migration workspaces |
| `composer.composerHeaders` | **Global DB** | Full JSON with `allComposers` array — one entry per chat with metadata (name, timestamps, mode, workspaceIdentifier, etc.) |
| `__$__isNewStorageMarker` | Workspace DB | `"true"` or `"false"` — indicates whether the workspace was created under the new storage schema |
| `__$__targetStorageMarker` | Workspace DB | Large JSON blob enumerating all keys that have been migrated from old storage format |

### `cursorDiskKV`
A large key-value table for bulk binary/JSON payloads.

**Schema:**
```sql
CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
```

Observed key prefixes (representative sample from a production installation):

| Key Prefix | Count | Content |
|---|---|---|
| `agentKv:*` | 2,411 | Agent-related state (LLM responses, tool calls, etc.) |
| `bubbleId:<composerId>:<bubbleId>` | 855 | Individual chat message "bubbles" — the actual conversation content |
| `composerData:<composerId>` | 51 | Full composer conversation state as JSON (tabs, messages, context) |
| `checkpointId:*` | 44 | Conversation checkpoint snapshots |
| `ofsContent:*` | 36 | Off-screen / large content references |
| `codeBlockPartialInlineDiffFates:*` | 33 | Partial diff tracking |
| `composer.content.<sha256hash>` | 142 | Content-addressed file payloads (shared across conversations) |
| `inlineDiff:*` | 5 | Inline diff state |
| `bcCachedDetails:*` | 7 | Background composer cache |
| `composer.autoAccept.*` | 2 | Auto-accept tracking |
| `composerVirtualRowHeights` | 1 | Virtual scroll row heights |

---

## 3. The Composer Data Model

### 3.1 Composer Metadata (`composer.composerHeaders`)

Stored in **Global DB** → `ItemTable` → key `composer.composerHeaders`.

Structure:
```json
{
  "allComposers": [
    {
      "type": "head",
      "composerId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "name": "Example chat conversation",
      "lastUpdatedAt": 1700000000000,
      "conversationCheckpointLastUpdatedAt": 1700000001000,
      "createdAt": 1699999999000,
      "unifiedMode": "agent",
      "forceMode": "edit",
      "hasUnreadMessages": false,
      "contextUsagePercent": 12.5,
      "totalLinesAdded": 42,
      "totalLinesRemoved": 7,
      "filesChangedCount": 3,
      "subtitle": "Refactored auth module",
      "hasBlockingPendingActions": false,
      "hasPendingPlan": false,
      "isArchived": false,
      "isDraft": false,
      "isWorktree": false,
      "worktreeStartedReadOnly": false,
      "isSpec": false,
      "isProject": false,
      "isBestOfNSubcomposer": false,
      "numSubComposers": 0,
      "referencedPlans": [],
      "trackedGitRepos": [],
      "workspaceIdentifier": {
        "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "uri": {
          "$mid": 1,
          "fsPath": "/home/user/projects/example-project",
          "_sep": 1,
          "external": "file:///home/user/projects/example-project",
          "path": "/home/user/projects/example-project",
          "scheme": "file"
        }
      }
    }
  ]
}
```

Key field: `workspaceIdentifier.id` — the hash of the workspace folder this composer belongs to. This is what links composers in the Global DB back to a specific workspace.

### 3.2 Composer Data (`cursorDiskKV` → `composerData:<id>`)

Stored in **Global DB** → `cursorDiskKV`.

This is a large JSON string containing the full composer state: tabs, conversation history, context files, model settings, etc.

### 3.3 Bubbles (`cursorDiskKV` → `bubbleId:<composerId>:<bubbleId>`)

Stored in **Global DB** → `cursorDiskKV`.

Each "bubble" is a single message in a conversation. Key format: `bubbleId:<composerId>:<bubbleId>`. Value is the message content as a JSON string containing text, code blocks, tool calls, etc.

### 3.4 Content-Addressed Payloads (`composer.content.<sha>`)

Stored in **Global DB** → `cursorDiskKV`.

These appear to be content-addressed file snippets shared across conversations (deduplicated by SHA-256 hash of content). The extension currently does not read or write these keys.

---

## 4. Storage Migration: The Two-Stage Schema

Cursor migrated chat storage from an older architecture to a newer one. The migration happens in **two stages**, and different workspaces may be at different stages.

### Stage 0: The Old Schema (Pre-Migration)

```
Workspace DB:
  composer.composerData = {
    "allComposers": [ /* full metadata for ALL chats in this workspace */ ],
    "selectedComposerIds": [...],
    // NO hasMigratedComposerData flag
  }

Global DB:
  cursorDiskKV = {
    composerData:<id>: "...",   // per-composer full data
    bubbleId:<id>:<bubbleId>: "..." // per-bubble messages
  }
```

### Stage 1: Partially Migrated

```
Workspace DB:
  composer.composerData = {
    "allComposers": [ /* metadata STILL here */ ],
    "selectedComposerIds": [...],
    "hasMigratedComposerData": true,    // <-- new flag
    "hasMigratedMultipleComposers": true
  }
  __$__isNewStorageMarker = "false"

Global DB:
  cursorDiskKV = {
    composerData:<id>: "...",   // KV entries already moved here
    bubbleId:<id>:<bubbleId>: "..." 
  }
  // NO composer.composerHeaders yet
```

In this stage, Cursor **still reads** `allComposers` from the workspace DB. The KV data has already been migrated to global, but the metadata list remains in the workspace.

### Stage 2: Fully Migrated (New Schema)

```
Workspace DB:
  composer.composerData = {
    // NO allComposers anymore!
    "selectedComposerIds": [...],
    "lastFocusedComposerIds": [...],
    "hasMigratedComposerData": true,
    "hasMigratedMultipleComposers": true
  }
  __$__isNewStorageMarker = "false"

Global DB:
  cursorDiskKV = {
    composerData:<id>: "...",
    bubbleId:<id>:<bubbleId>: "...",
    composer.content.<sha>: "...",  // possibly new
    agentKv:*: "..."
  }
  ItemTable key "composer.composerHeaders" = {
    "allComposers": [ /* metadata moved here! */ ]
  }
```

In this stage, Cursor **reads** `allComposers` from the **Global DB** → `composer.composerHeaders` instead of the workspace DB.

### Stage 3: New Workspace (Created Under New Schema)

```
Workspace DB:
  composer.composerData = {
    "selectedComposerIds": [...],
    "hasMigratedComposerData": false,     // <-- never migrated, was born this way
    "hasMigratedMultipleComposers": true
  }
  __$__isNewStorageMarker = "true"        // <-- was never old

Global DB:
  composer.composerHeaders = { "allComposers": [...] }
  cursorDiskKV = { composerData:<id>: "...", bubbleId:<id>:<bubbleId>: "..." }
```

Same as Stage 2, but `__$__isNewStorageMarker = "true"` tells Cursor the workspace was created after the migration, so there's nothing to migrate.

## 5. Workspace `selectedComposerIds` Semantics

Each workspace DB's `composer.composerData` contains a `selectedComposerIds` array. This is the current workspace's "active" chat list — the chats you see in the sidebar.

**Important:** `selectedComposerIds` can be an **empty array** `[]`. This happens when:
- The user cleared their chat history
- The workspace was opened but no chats were ever explicitly "selected"
- All chats were archived

An empty `selectedComposerIds` means **"no active filters — show all composers in the global headers that belong to this workspace"**, NOT "show nothing".

---

## 6. Key Takeaways for the Extension

1. **`composer.composerData` in the workspace DB may or may not have `allComposers`** — always fall back to `composer.composerHeaders` in the global DB.

2. **`composer.composerHeaders` in the global DB is the source of truth** for the complete list of a user's chats across all workspaces. Each entry has `workspaceIdentifier.id` to link it to a workspace.

3. **KV payloads live in the global DB**, not in workspace DBs. Writing to workspace `cursorDiskKV` is pointless.

4. **`selectedComposerIds` can be empty** and should be treated as "no filter" not "match nothing".

5. **Imported chats must be registered in both places:**
   - `cursorDiskKV` in global → `composerData:<newId>` and `bubbleId:<newComposerId>:<newBubbleId>`
   - `composer.composerHeaders` in global → added to `allComposers` with correct `workspaceIdentifier`
   - `composer.composerData` in workspace → added to `selectedComposerIds` and optionally `allComposers`

6. **Content-addressed payloads** (`composer.content.<sha>`) and **agent KV state** (`agentKv:*`) exist but are currently not handled by the extension.
