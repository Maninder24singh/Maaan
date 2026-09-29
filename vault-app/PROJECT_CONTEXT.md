# Memory Vault: full project context

> **For Claude (or any AI assistant):** this file explains the Memory Vault app so you can help
> without re-reading the whole codebase. The owner (Maninder) prefers: a summary first, simple
> language, open source, everything local, no paid APIs, and one step at a time when installing.
> Always ask before running commands that change files outside the repo.

---

## 1. Summary

**Memory Vault** is a desktop app (Electron, Windows first) that shows all of Maninder's coding
work as an **Obsidian-style graph**: dots joined by lines, on a black background.

- It **reads** Claude Code and OpenCode session history automatically. There is nothing to set
  up in those tools.
- It **writes** one Markdown note per project and per session into a vault folder, which Obsidian
  can also open.
- You can add your own projects by **dragging `.md` files or folders** in.
- The graph can be drawn in the **shape of a photo** (a dotted portrait).
- Optional, each off until turned on: a **browser extension** to save pages, a **clipboard hotkey**,
  and a **local AI assistant** (Ollama) that can search the vault and find/open apps and files.

Everything runs offline on the laptop.

---

## 2. Where things are

| What | Where |
| --- | --- |
| GitHub repo | `Maninder24singh/Maaan` |
| Branch with the app | `claude/exciting-ptolemy-zexd72` |
| Pull request | https://github.com/Maninder24singh/Maaan/pull/2 |
| App code (in the repo) | `vault-app/` |
| App on the laptop | `F:\agent claude\All Memory\Maaan\vault-app` |
| Vault folder on the laptop | `F:\agent claude\All Memory\MemoryVault` |
| Claude Code sessions (read only) | `C:\Users\manin\.claude\projects\` |
| OpenCode database (read only) | `C:\Users\manin\.local\share\opencode\opencode.db` |
| App settings file | Electron `userData` folder, `settings.json` (on Windows, likely `%APPDATA%\Memory Vault\settings.json`) |
| Desktop shortcut | `Memory Vault.lnk` → `node_modules\electron\dist\electron.exe "<vault-app folder>"` |
| Old copy (can be deleted) | `C:\Users\manin\Documents\Maaan` |

**Laptop:** Acer Predator Helios Neo 16, i7 13th Gen HX, RTX 4060 **8 GB VRAM**, 32 GB RAM,
Windows. Node v24.18.1, npm 11.16.0, Git 2.55.

**Install status on the laptop:** cloned, `npm install` done, Electron v44.4.5 present,
`npm test` passed 11/11 at install time (14 now, after the clipboard fix), first-run permission done, photo shape set, desktop shortcut works.
**Not yet set up:** browser extension, clipboard key, local AI (Ollama).

**To update after new commits:**

```powershell
cd "F:\agent claude\All Memory\Maaan\vault-app"
git pull
npm install
```

---

## 3. Tech stack (all open source, pinned)

| Part | Version | Why |
| --- | --- | --- |
| Electron | 44.4.5 (ships Node 24) | Desktop window. Built-in `node:sqlite` reads OpenCode with no native modules to compile |
| d3 | 7.9.0 | Force layout, zoom/pan, tree layouts |
| @mediapipe/selfie_segmentation | 0.1.1675465747 | Cuts the person out of the photo, offline (model is inside the npm package) |
| Ollama (optional, separate install) | any recent | Local LLM for the Ask AI chat |
| Default AI model | `qwen2.5:3b` (Q4_K_M) | About 2.5 GB VRAM with 8K context, so it fits beside the voice agent's STT |

No web servers, no cloud, no telemetry. The only network listener is the optional clipper on
`127.0.0.1`.

---

## 4. How it works (data flow)

```
Claude Code  ~/.claude/projects/*/*.jsonl   ─┐
OpenCode     opencode.db (SQLite)            ─┼─► lib/engine.js ──► model (projects, sessions, notes)
Vault folder *.md (your notes, clips)        ─┘        │                     │
                                                       │ writes notes        ▼
                                                       ▼               renderer (graph UI)
                                            MemoryVault/<Project>/…
```

1. **`lib/engine.js`** watches the three sources (`fs.watch`, plus a 15-second poll as a backstop)
   and rebuilds the model about 600 ms after any change. It only sends to the window if something
   actually changed (signature check).
2. **`lib/claude.js`** reads Claude Code transcripts **incrementally** (only new bytes). For each
   session it keeps: `cwd` (the project folder), title (from `summary` / `custom-title` /
   `ai-title` lines, else the first prompt), first prompt, prompt count, start/end time, and files
   changed by the `Edit`, `Write`, `MultiEdit` and `NotebookEdit` tools. Sub-agent (sidechain)
   lines are skipped.
3. **`lib/opencode.js`** reads OpenCode 1.x's SQLite DB **read-only** (tables `session`, `message`,
   `part`). Files come from tool parts named `edit`, `write`, `patch`, `apply_patch` or
   `multiedit` (`state.input.filePath`, or patch text `*** Update File:` lines). Child sessions fold
   into their parent. If a read-only open fails, it reads a temporary copy instead.
4. **`lib/model.js`** turns sessions into **projects** (one per working folder). A folder inside
   another project's folder becomes a **sub-project**. Duplicate names get the parent folder added,
   e.g. `stt (agent)`. `mergeVaultProjects` also turns vault folders into projects (see section 6).
5. **`lib/vault.js`** writes the notes and reads your own notes (see section 6).
6. The **renderer** builds the graph for the selected project (plus its sub-projects).

---

## 5. The graph (what the dots mean)

| Dot | Meaning |
| --- | --- |
| Big gold | Project (a folder you worked in) |
| Orange | Sub-project |
| Coral | Claude Code session |
| Teal | OpenCode session |
| Small blue / lime / pink / purple / grey | Changed file (code / Python / web / docs / config) |
| White | Your own note |
| Rose | Clip saved from the browser or clipboard |
| Hollow dashed ring | A `[[link]]` to a note that doesn't exist yet |

- **Lines:** project→session, session→file changed, note→anything it `[[links]]`. A file changed in
  two sessions connects them.
- **Size:** more links means a bigger dot.
- **Controls:** drag to pan, scroll or `+`/`−` to zoom, `Fit` (key `0`), click for the info card,
  double-click a project to go into it, hover to highlight neighbours, and a search box.
- **Layouts:** `Web` (force, Obsidian-like), `Rings` (radial tree), `Tree` (left to right),
  `Shape (your image)`.

### Shape (your image)
- `renderer/shape.js`: the photo is scaled to 800 px on its long side, MediaPipe gives the person
  mask, Sobel edges are found inside the mask plus the mask outline, and dots are placed greedily
  on the strongest edges (min gap 3 px, up to 5,000 dots), plus up to 900 sparse fill dots inside
  the body. Dot colours come from the photo, with dark areas lightened so they show on black. Short
  strokes join neighbouring outline dots.
- Stored in the renderer's `localStorage` key `mv:shape`: **only the dot data (about 260 KB), never
  the photo.**
- `renderer/graph.js` assigns each real node to the free dot nearest its current position (so
  linked nodes stay close). Unused dots are drawn **dim** and cached as one offscreen image
  (re-rendered only when the zoom level changes a lot) for performance.
- It needs WebGL2 for MediaPipe. `enable-unsafe-swiftshader` is on as a software fallback (safe,
  because the window only loads the app's own files). Without a mask, it falls back to whole-image
  edges.

---

## 6. The vault folder

```
MemoryVault/
  <Project>/
    <Project>.md                      ← generated project note (sessions, sub-projects)
    sessions/
      2026-09-26 <title> (cc-xxxxxxxx).md   ← generated, one per session
    About <Project>.md                ← made by "New project" / folder import (yours to edit)
    <your notes>.md                   ← dropped/imported notes (copies)
    clips/2026-09-27 <title>.md       ← browser / clipboard clips (type: clip)
    <Sub folder>/                     ← becomes a sub-project
  Inbox/                              ← clips and AI notes with no project
```

- Generated notes carry `generated: memory-vault` in their frontmatter. **The app never overwrites
  a file without that marker.**
- A session note is **renamed** (not duplicated) when its title changes.
- Reserved sub-folders (not projects): `sessions`, `clips`, `attachments`, `assets`, `images`.
- Obsidian can open this folder and shows a similar graph.

**What a session note contains:** project, tool, prompt count, time range, first prompt (up to 600
characters), and files changed as `[[links]]`. **Not** the full conversation or Claude's answers.

---

## 7. Adding projects yourself

- Drag `.md` / `.txt` files or folders onto the **sidebar**, a **project row**, or the **canvas**.
  The buttons **+ New project** and **Add files** do the same.
- **`.md` file:** copied into the target project, or into a new project named after its `# Title`.
  Frontmatter gets `imported_from` and `imported_at`. The offline analysis (`lib/analyze.js`) finds
  the title, headings, `#tags`, open tasks, and mentions of existing project or note names, and
  those mentions are appended as `## Related` `[[links]]`.
- **Folder:** becomes a project (or a sub-project if dropped on a project row). An
  `About <name>.md` gets the README description or `package.json`/`pyproject.toml` description,
  the language counts (skipping `node_modules`, `.git`, `venv`, `dist`…), the key files and any
  mentions.
- With Local AI on, a `## Summary (local AI)` is added afterwards.

---

## 8. Connections (sidebar, bottom)

Each one is **off until the user turns it on**, and each shows what it will do first.

### Claude Code / OpenCode
Always on (read only). Shows whether the program is installed (`where claude` / `where opencode`)
and the session count. **"Start Claude Code / OpenCode here"** opens a terminal in the project
folder: Windows Terminal (`wt.exe -d <dir> cmd /k claude`) or `cmd start`; Terminal via
`osascript` on macOS; `x-terminal-emulator` on Linux.

### Browser (clipper)
- `lib/clipper.js`: an HTTP server on **`127.0.0.1:47321` only**.
- Every request needs header `x-vault-token` (a random key stored in settings, compared in constant
  time).
- Requests with a web-page `Origin` are refused (**403**). Only `chrome-extension://` (and other
  extension schemes) get CORS headers.
- Endpoints: `GET /ping`, `GET /projects`, `POST /clip {title,url,text,project}` (max 2 MB;
  non-http URLs dropped).
- The extension is in `vault-app/browser-extension/` (Manifest V3, Chrome/Edge). Load it with
  **Load unpacked**, then paste the key into its popup. It has a right-click menu (page / selection /
  link / image), `Alt+Shift+S`, and a popup to pick the project and add a note.

### Clipboard key
`CommandOrControl+Shift+M` (Ctrl on Windows, Cmd on Mac) saves the current clipboard text or URL
to `Inbox/clips/`. The clipboard is read only when the key is pressed. The Clipboard key window
also has a **Save my clipboard now (test)** button. **Electron 44's clipboard API is async**
(`readText()`/`writeText()` return Promises), so always `await` them.

### Local AI (Ollama)
- `lib/ai.js` talks to `http://127.0.0.1:11434` (`/api/tags`, `/api/chat` with tools,
  `think: false`, `keep_alive: 5m`, `num_ctx: 8192`).
- `lib/assistant.js` defines the tools: `search_vault`, `list_projects`, `find_app` (Start Menu
  shortcuts / `.desktop` / `.app`), `find_file` (Desktop, Documents, Downloads, Pictures, Videos,
  Music and project folders, 2.5 s limit), `save_note`, `open_app`, `open_path`, `open_url`.
- **Safety rule:** the `open_*` tools never run on their own. They become **Open / Skip** buttons
  in the chat, and only paths that a search tool actually returned can be opened (a made-up path is
  refused). URLs must be http(s).
- Setup: `winget install Ollama.Ollama`, then `ollama pull qwen2.5:3b`, then Connections → Local AI
  → Turn on.

---

## 9. Code map

```
vault-app/
  main.js              window, app:// protocol (serves only renderer/, d3, mediapipe), IPC, settings
  preload.js           contextBridge API `window.vault` (the only bridge; sandbox + contextIsolation)
  lib/paths.js         default paths per OS, path normalisation
  lib/claude.js        Claude Code transcript reader (incremental)
  lib/opencode.js      OpenCode SQLite reader
  lib/model.js         sessions → projects/sub-projects; vault folders → projects
  lib/vault.js         write/read notes, import, clips, saveNote, never overwrite user files
  lib/analyze.js       offline analysis of dropped notes/folders
  lib/engine.js        watching, refresh, change detection
  lib/features.js      clipper, hotkey, AI, import, launch terminal (all opt-in)
  lib/clipper.js       127.0.0.1 server for the extension
  lib/ai.js            Ollama client
  lib/assistant.js     AI tools + approve-before-open
  renderer/index.html  layout, CSP (script-src 'self' 'wasm-unsafe-eval')
  renderer/style.css   black theme, colour tokens
  renderer/app.js      sidebar, cards, connections, modals, drag-drop, chat drawer
  renderer/graph.js    canvas graph, zoom/pan, layouts, shape drawing + cache
  renderer/shape.js    photo → dots
  browser-extension/   MV3 extension (manifest, background, popup, shared)
  test/*.test.js       node:test unit tests (14)
  README.md            user guide
```

**IPC (`window.vault.*`):** `init`, `saveSettings`, `checkPaths`, `pick`, `refresh`, `open`,
`reveal`, `pathForFile`, `connections`, `setFeature`, `importPaths`, `newProject`, `launch`, `ask`,
`approve`, `resetChat`, `copy`, `showExtension`, `onData`, `onToast`. The newer handlers return
`{ ok, value }` or `{ ok: false, error }`.

**Settings keys:** `consented`, `claudeDir`, `opencodeDb`, `vaultDir`, `writeNotes`,
`clipper{enabled,port,token}`, `hotkey{enabled,accel}`, `ai{enabled,url,model,summarizeImports}`.
The env var `MEMORY_VAULT_USER_DATA` overrides the settings folder (used by tests).

**Tests:** `npm test` runs 14 tests. They cover the transcript parser (including half-written
lines), OpenCode tool parts, project nesting, vault writing and the never-overwrite rule, markdown
and folder analysis, drag-drop import, the clipper (key, 403 for websites, CORS), the assistant
(with a fake Ollama: a made-up path is refused, and search results can be opened), and the clipboard
key (with a fake Electron whose clipboard returns Promises, like Electron 44).

---

## 10. Security and privacy decisions

- A first-run permission screen lists every folder that is read and written. Nothing happens
  before **Allow and start**.
- Claude Code and OpenCode data are **read only**. Dropped files are **copied**, and the originals
  are never touched.
- The renderer is sandboxed, with `contextIsolation`, no Node in the page, and a strict CSP. It is
  served from `app://local/` and only three folders are exposed.
- The clipper is loopback-only, needs a key, and refuses web pages.
- The AI can't open anything without a click, and only paths it found.
- The photo is never stored, only the dot data.
- The vault may contain secrets pasted into prompts. Be careful before letting other tools
  (e.g. a voice agent) read it aloud.

---

## 11. Known limits and not yet tested

- **Tested on Linux only** (Electron with Playwright). Windows install works (confirmed by the
  owner), but these are not yet tested on Windows: the "Start Claude Code here" terminal, the
  `Ctrl+Shift+M` hotkey, the browser extension, and real Ollama (only a fake Ollama was tested).
- **Mac:** never run. The code has Mac paths (Terminal via `osascript`, `/Applications`). The UI
  text still says "Ctrl+Shift+M" (on a Mac it's Cmd). Recommended way to share: the sister clones
  the branch, runs `npm install`, then `npm start`. A `.dmg` would need a GitHub Actions macOS
  build, and without a paid Apple Developer account ($99/yr) it shows a Gatekeeper warning.
- A 3B local model is fine for search, find and open, but weak at multi-step "do my work" tasks.
- Session notes don't include the full chat or Claude's answers.
- If Claude Code runs inside **WSL**, the paths must point at `\\wsl$\…`, and it falls back to the
  15-second polling.
- The installer (`npm run dist` / electron-builder) exists but has not been built. The shortcut is
  used instead.

---

## 12. Open ideas / next steps (not built yet)

1. **Connect "Nova"** (the owner's local voice agent: wake word → STT → LLM → TTS) to the vault.
   The recommended option is a `/search` endpoint on the clipper server (key-protected,
   `127.0.0.1`) that Nova calls as a tool, with about 10–50 ms latency and no extra VRAM. It should
   redact anything that looks like a key or token before returning results. Still needed: where
   Nova's code lives, its language, and its model.
2. Keep a short **summary of each session** (not just the first prompt), so assistants can answer
   "what did Claude say about X".
3. A **"?" help button** explaining the dots.
4. A **custom app icon** (black, with gold/teal/coral dots).
5. **Mac** support check (Cmd text, Terminal permission) and optionally a `.dmg` via GitHub Actions.
6. Optional **embedding search** (`nomic-embed-text`, about 0.3 GB VRAM or CPU) for meaning-based
   search.

---

## 13. How to ask Claude about this project

Paste this file, then ask. Example prompts:

- "Using PROJECT_CONTEXT.md, add a `/search` endpoint to the clipper for my Nova voice agent. Go
  step by step and ask before changing files."
- "Using PROJECT_CONTEXT.md, explain why my OpenCode sessions don't show up. Here is the error: …"
- "Using PROJECT_CONTEXT.md, make session notes include a short summary of each chat."
- "Using PROJECT_CONTEXT.md, help my sister install this on her Mac, one step at a time."

If you are Claude Code running inside the repo, read `vault-app/README.md` and the files in
section 9 before making changes, run `npm test` after changes, and keep to the rules in section 10.
