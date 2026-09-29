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
| Rose | A page or text you saved from the browser or clipboard |
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

## Add your own projects

- **Drag and drop** `.md` files or whole folders onto the sidebar or the canvas.
  - Drop on a project row: the files go into that project.
  - Drop anywhere else: each `.md` becomes a new project named after its title, and each folder
    becomes a project (a sub-project if you dropped it on a project row).
- **+ New project** makes an empty project, optionally linked to a folder on your PC.
- **Add files** does the same as dropping, with a file picker.

What the app works out by itself (offline, no AI needed): the title, the section headings, `#tags`
and open tasks, and which of your projects or notes the text mentions. Those mentions become
`[[links]]`, so the new dots connect to the rest of your graph. For a folder it reads the README,
`package.json` / `pyproject.toml` / `requirements.txt`, and counts which languages are used.
With Local AI on, it also writes a short summary into the note.

Your dropped files are **copied** into the vault. The originals are never changed.

## Connections (bottom of the sidebar)

Every item here is off until you turn it on, and each one explains what it will do first.

| Connection | What it does |
| --- | --- |
| Claude Code, OpenCode | Always on (read only). Every session in any folder shows up by itself. Click one to open a terminal running `claude` or `opencode` in a project. The project card also has *Start Claude Code here* / *Start OpenCode here*. |
| Browser | Starts a server on `127.0.0.1:47321`, which only this PC can reach. Only the Memory Vault extension with your private key can save. Websites are refused. |
| Clipboard key | `Ctrl+Shift+M` anywhere saves whatever you copied (text or a link) to `Inbox`. The clipboard is read only when you press the key. |
| Local AI | A model running through Ollama on your laptop. See below. |

### Browser extension (Chrome or Edge)

1. In the app: **Connections → Browser → Turn on**, then **Copy** the key.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `vault-app/browser-extension` folder
   (the app's **Show extension folder** button opens it).
4. Click the extension icon, paste the key, and press **Connect**.

Then right-click a page, a selection, a link or an image and pick **Save to Memory Vault**, or press
`Alt+Shift+S`. The popup lets you pick which project to save into and add your own note.

### Local AI

```powershell
winget install Ollama.Ollama
ollama pull qwen2.5:3b
```

Then **Connections → Local AI → Turn on**, and click **Ask AI** at the top right.

- `qwen2.5:3b` (Q4_K_M) uses about 2.5 GB of VRAM with an 8K context. It fits next to
  faster-whisper small (about 1 GB) on an 8 GB RTX 4060. `qwen2.5:7b` uses about 5.5 GB, so only
  use it when your voice agent is off. The model unloads 5 minutes after your last question.
- It can: search the vault, list projects, find installed apps (Start Menu shortcuts), find files
  (Desktop, Documents, Downloads, Pictures, Videos, Music, project folders), save notes, and
  write summaries of dropped files.
- **Opening** an app, file or web page always shows an **Open / Skip** button first. The model can
  only open paths its own search returned, so it can't make up a path and run it.

## Layouts

`Web` (default) is Obsidian's force layout. `Rings` puts the selected project in the center
with sub-projects, sessions and files on rings around it. `Tree` lays it out left to right.

`Shape (your image)` draws the graph in the shape of a photo:

1. Pick **Shape (your image)** in the layout menu and choose a JPG or PNG.
2. The app finds the person in the photo (MediaPipe Selfie Segmentation, which ships inside
   the app and runs offline), traces the outline and details as colored dots, and puts your
   projects, sessions and files on those dots. Linked things stay near each other.
3. Leftover dots stay dim, so the picture shows even with only a few projects.

The photo itself is never saved or uploaded. Only the dot positions and colors (about 260 KB,
around 5,900 dots) are kept inside the app. Dots that don't hold a project, session or file are
drawn dim, and the whole picture is cached as one image, so panning and zooming stay smooth. **Change image…** swaps it for another one. This works best with one
person, facing the camera, upper body. It needs WebGL2, which any normal GPU has. Without it
the app uses every edge in the whole picture instead of cutting out the person.

## Files

```
main.js          window, permission handling, file open/reveal
preload.js       the only bridge between the page and the PC
lib/claude.js    reads Claude Code .jsonl transcripts (only new bytes each time)
lib/opencode.js  reads OpenCode's SQLite database (read-only, built-in node:sqlite)
lib/model.js     groups sessions into projects and sub-projects
lib/vault.js     writes and reads the Markdown vault
lib/engine.js    watches folders and pushes updates to the window
lib/analyze.js   works out what a dropped note or folder is about (offline)
lib/features.js  browser server, clipboard key, local AI, starting Claude Code / OpenCode
lib/clipper.js   the 127.0.0.1 server the browser extension talks to
lib/ai.js        Ollama client
lib/assistant.js the AI's tools and the approve-before-open rule
browser-extension/  Chrome/Edge extension (Manifest V3)
renderer/        sidebar, canvas graph, info card, shape.js (photo -> dots)
test/            unit tests: npm test
```
