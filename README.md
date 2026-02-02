# Cursor Chat Transfer

Transfer your AI chat conversations between Cursor IDE workspaces and devices with an intuitive UI.
<p align="center">
  <a href="https://github.com/ibrahim317/cursor-chat-transfer/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/ibrahim317/cursor-chat-transfer?style=for-the-badge&color=fabd2f" alt="License" />
  </a>
  <a href="https://open-vsx.org/extension/ibrahim317/cursor-chat-transfer">
    <img src="https://img.shields.io/open-vsx/v/ibrahim317/cursor-chat-transfer?style=for-the-badge&label=Open%20VSX&color=83a598" alt="Open VSX Version" />
  </a>
  <a href="https://open-vsx.org/extension/ibrahim317/cursor-chat-transfer">
    <img src="https://img.shields.io/open-vsx/dt/ibrahim317/cursor-chat-transfer?style=for-the-badge&color=d3869b" alt="Open VSX Downloads" />
  </a>
</p>


## Features

### Export Chats
- Export all chats or select specific ones
- Auto-detects workspace by name and path
- Saves to `.cursor-chat.json` format
- Includes all messages and bubbles

### Import Chats
- Import from exported files
- Creates copies with new IDs (safe for re-importing)
- Auto-detects target workspace
- Preserves all chat data and conversation history

## Usage

1. Open the **Cursor Chat Transfer** view in the Activity Bar (left sidebar)
2. Click any action:
   - **Export Chats** → Save chats to file for backup or transfer
   - **Import Chats** → Load chats from exported file

3. Follow the prompts to select workspaces and files

### Alternative: Command Palette

You can also access all features through the Command Palette (Cmd/Ctrl+Shift+P):
- `Cursor Chat Transfer: Export Chats`
- `Cursor Chat Transfer: Import Chats`

## Important

**After importing chats, you MUST completely close and reopen Cursor IDE for the chats to appear.** Simply reloading the window (Cmd/Ctrl+R) is not sufficient. Cursor loads chat data on startup, so a full restart is required to see the transferred conversations.

## Why Use This?

- **Switch Devices**: Moving to a new computer? Take your chat history with you
- **Backup Important Conversations**: Save your valuable AI interactions and code discussions
- **Share Context**: Transfer relevant chats to another workspace working on similar problems
- **Workspace Organization**: Reorganize chats across different project workspaces

## Auto-Detection

Works seamlessly across platforms:
- **Windows**: `%APPDATA%/Cursor/User/workspaceStorage`
- **macOS**: `~/Library/Application Support/Cursor/User/workspaceStorage`
- **Linux**: `~/.config/Cursor/User/workspaceStorage`
- **Linux Remote/SSH**: `~/.cursor-server/data/User/workspaceStorage`
- **WSL**: `/mnt/c/Users/<USER>/AppData/Roaming/Cursor/User/workspaceStorage`

The extension shows workspace names and folder paths (not internal hashes) for easy identification.

## Troubleshooting

### Large Databases
If your global database is very large and export feels slow, try:
1. **Clear old chat history** in Cursor settings
2. **Export specific chats** instead of all at once
3. **Delete old workspace folders** in Cursor's `workspaceStorage` directory

### sqlite3 Required
This extension requires `sqlite3` CLI to be installed for all database operations (read and write). It's usually pre-installed on:
- **Linux**: Most distributions
- **macOS**: Pre-installed

**Windows Installation:**
1. Download `sqlite-tools-win-x64-*.zip` from [sqlite.org](https://sqlite.org/download.html)
2. Extract `sqlite3.exe` to one of these locations (the extension will auto-detect):
   - `C:\sqlite3\sqlite3.exe` (recommended)
   - `C:\Program Files\sqlite3\sqlite3.exe`
   - Any directory in your system PATH
3. Alternatively, install via package manager:
   - **Chocolatey**: `choco install sqlite`
   - **Scoop**: `scoop install sqlite`

## Requirements

- Cursor IDE with chat composer feature
- `sqlite3` CLI (pre-installed on Linux/macOS, see above for Windows)

## License

MIT

---

*Technical Note: The extension uses the system `sqlite3` CLI for both reading and writing, which handles WAL mode databases while Cursor is running.*
