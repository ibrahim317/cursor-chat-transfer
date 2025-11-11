# Cursor Chat Transfer

Transfer your AI chat conversations between Cursor IDE workspaces and devices with an intuitive UI.
<p align="center">
  <a href="https://github.com/ibrahim317/cursor-chat-transfer/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/ibrahim317/cursor-chat-transfer?style=for-the-badge&color=fabd2f" alt="License" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=ibrahim317.cursor-chat-transfer">
    <img src="https://img.shields.io/visual-studio-marketplace/v/ibrahim317.cursor-chat-transfer?style=for-the-badge&label=VS%20Marketplace&color=83a598" alt="Visual Studio Marketplace Version" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=ibrahim317.cursor-chat-transfer">
    <img src="https://img.shields.io/visual-studio-marketplace/i/ibrahim317.cursor-chat-transfer?style=for-the-badge&color=d3869b" alt="Visual Studio Marketplace Installs" />
  </a>
</p>


## Features

### 🎨 Clean Interface
- Dedicated sidebar with clickable items
- Clear icons for each action (Export, Import, Local Transfer)
- Hover tooltips with descriptions

### 📤 Export Chats
- Export all chats or select specific ones
- Auto-detects workspace by name and path
- Saves to `.cursor-chat.json` format
- Includes all messages and bubbles

### 📥 Import Chats
- Import from exported files
- Safe merge (no overwrites)
- Auto-detects target workspace
- Preserves all chat data and conversation history

### 🔄 Local Import (Move Chats)
- **Copy**: Duplicate chats with new IDs (default) - fully independent copies
- **Cut**: Move chats from source to target workspace
- **Ref**: Link to existing chats (shared references)
- Auto-targets current workspace for convenience

## Usage

1. Open the **Cursor Chat Transfer** view in the Activity Bar (left sidebar)
2. Click any action:
   - **Export Chats** → Save chats to file for backup or transfer
   - **Import Chats** → Load chats from exported file
   - **Local Import** → Copy/move between workspaces on the same machine

3. Follow the prompts to select workspaces and files

### Alternative: Command Palette

You can also access all features through the Command Palette (Cmd/Ctrl+Shift+P):
- `Cursor Chat Transfer: Export Chats`
- `Cursor Chat Transfer: Import Chats`
- `Cursor Chat Transfer: Local Import (Move Chats)`

## ⚠️ Important

**After importing or moving chats, you MUST completely close and reopen Cursor IDE for the chats to appear.** Simply reloading the window (Cmd/Ctrl+R) is not sufficient. Cursor loads chat data on startup, so a full restart is required to see the transferred conversations.

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

## Requirements

- Cursor IDE with chat composer feature
- Node.js (for development only)

## License

MIT

---

*Technical Note: The extension reads Cursor's internal SQLite databases to access and transfer chat data while respecting the integrity of your workspace.*
