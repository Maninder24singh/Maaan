# Memory Vault

A desktop app that turns your Claude Code and OpenCode work into an Obsidian-style graph.
Everything runs on your PC. No internet, no accounts, no paid APIs.

- **Left sidebar:** every project you have worked on. A project inside another project's folder
  shows up as a sub-project under an arrow you can open and close.
- **Canvas:** black background, colored dots, lines between related things. Drag anywhere to move
  around, scroll to zoom, or use the `+`, `−` and `Fit` buttons (keys `+`, `-`, `0`).
- **Live:** when you work in Claude Code or OpenCode, new sessions and changed files show up
  within about a second. You don't need to set anything up in either tool.

## What the dots mean

| Dot | Meaning |
| --- | --- |
| Gold, big | Project (a folder you worked in) |
| Orange | Sub-project (a folder inside another project) |
| Coral | Claude Code session |
| Teal | OpenCode session |
| Blue / lime / pink / purple / grey | File that was changed (code / Python / web / docs / config) |
| White | A note you wrote yourself in the vault folder |
| Hollow, dashed | A `[[link]]` in your notes that points to a note that doesn't exist yet |

A file changed in two sessions links both sessions, so related work pulls together.

## Run it on Windows

You need [Node.js 22 LTS or newer](https://nodejs.org). Then, in PowerShell:

```powershell
git clone https://github.com/maninder24singh/maaan.git
cd maaan\vault-app
npm install
npm start
```

The first time it opens, it asks for permission and shows you exactly which folders it will read
and write. Nothing is read before you click **Allow and start**. You can change this later
with **Folders and permissions** at the bottom of the sidebar.

To build an installer (`.exe`), run this on the Windows PC:

```powershell
npx electron-builder@26 --win nsis portable
```

The files land in `vault-app\dist\`.

## Where it reads and writes

| What | Default path on Windows | Access |
| --- | --- | --- |
| Claude Code sessions | `%USERPROFILE%\.claude\projects\` | read only |
| OpenCode database | `%USERPROFILE%\.local\share\opencode\opencode.db` | read only |
| Vault notes | `%USERPROFILE%\Documents\MemoryVault\` | read and write |

- If you run Claude Code or OpenCode **inside WSL**, their files live in the Linux home folder.
  Point the app at `\\wsl$\Ubuntu\home\<you>\.claude\projects` and
  `\\wsl$\Ubuntu\home\<you>\.local\share\opencode\opencode.db`. Change events don't
  cross into WSL well, so the app also checks every 15 seconds.
- The vault gets one Markdown file per project and per session. Open the same folder in Obsidian
  and you get the same graph there.
- Files the app writes carry `generated: memory-vault` in their header. It never edits any other file.
  Put your own notes in `MemoryVault\<project name>\` and they show up as white dots linked to that project.

## Layouts

`Web` (default) is Obsidian's force layout. `Rings` puts the selected project in the center
with sub-projects, sessions and files on rings around it. `Tree` lays it out left to right.

## Files

```
main.js          window, permission handling, file open/reveal
preload.js       the only bridge between the page and the PC
lib/claude.js    reads Claude Code .jsonl transcripts (only new bytes each time)
lib/opencode.js  reads OpenCode's SQLite database (read-only, built-in node:sqlite)
lib/model.js     groups sessions into projects and sub-projects
lib/vault.js     writes and reads the Markdown vault
lib/engine.js    watches folders and pushes updates to the window
renderer/        sidebar, canvas graph, info card
test/            unit tests: npm test
```
