'use strict';
const { shell, clipboard, globalShortcut, Notification } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Clipper, newToken } = require('./clipper');
const { LocalAI } = require('./ai');
const { Assistant } = require('./assistant');

// Everything that reaches outside the vault lives here, and each piece is off
// until you turn it on in the app: browser connection, clipboard hotkey, local AI.

const DEFAULTS = {
  clipper: { enabled: false, port: 47321, token: '' },
  hotkey: { enabled: false, accel: 'CommandOrControl+Shift+M' },
  ai: { enabled: false, url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', summarizeImports: true },
};

const TOOLS = { claude: 'claude', opencode: 'opencode' };

function which(cmd) {
  return new Promise(resolve => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeout: 3000, windowsHide: true }, (err, out) => {
      resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null);
    });
  });
}

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Opens a new terminal window in `dir` running `cmd` (claude or opencode).
function launchInTerminal(cmd, dir) {
  const opts = { detached: true, stdio: 'ignore' };
  if (process.platform === 'win32') {
    const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
    if (fs.existsSync(wt)) spawn(wt, ['-d', dir, 'cmd', '/k', cmd], opts).unref();
    else spawn('cmd.exe', ['/c', 'start', 'Memory Vault', '/D', dir, 'cmd', '/k', cmd], { ...opts, windowsHide: false }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(`cd ${shQuote(dir)} && ${cmd}`)}`], opts).unref();
    return;
  }
  const script = `cd ${shQuote(dir)} && ${cmd}; exec bash`;
  for (const term of [['x-terminal-emulator', ['-e', 'bash', '-lc', script]], ['gnome-terminal', ['--', 'bash', '-lc', script]], ['konsole', ['-e', 'bash', '-lc', script]]]) {
    try { spawn(term[0], term[1], opts).on('error', () => {}).unref(); return; } catch { /* try next */ }
  }
}

function createFeatures({ getSettings, saveSettings, getEngine, getData, refresh, toast }) {
  let clipper = null;
  let clipperError = null;
  let hotkeyRegistered = false;
  let ai = null;
  let assistant = null;
  let history = [];
  const pending = new Map();
  const installed = { at: 0, claude: null, opencode: null };

  const settings = () => {
    const s = getSettings();
    for (const k of Object.keys(DEFAULTS)) s[k] = { ...DEFAULTS[k], ...(s[k] || {}) };
    return s;
  };
  const vault = () => { const e = getEngine(); if (!e) throw new Error('Allow the app to start first.'); return e.vault; };

  function projectByRel(relText) {
    const data = getData();
    if (!relText || !data) return null;
    return data.projects.find(p => p.vaultRel && p.vaultRel.join('/').toLowerCase() === relText.toLowerCase()) || null;
  }

  function knownNames() {
    const data = getData() || { projects: [], notes: [] };
    return [...data.projects.map(p => p.name), ...data.notes.map(n => n.title)];
  }

  // ---------- browser connection ----------
  async function startClipper() {
    const s = settings();
    await stopClipper();
    if (!s.clipper.enabled) return;
    if (!s.clipper.token) { s.clipper.token = newToken(); saveSettings(s); }
    clipper = new Clipper({
      port: s.clipper.port,
      token: s.clipper.token,
      listProjects: () => (getData() || { projects: [] }).projects.map(p => ({ name: p.name, rel: p.vaultRel.join('/') })),
      onClip: clip => {
        const p = projectByRel(clip.project);
        const saved = vault().saveClip({ ...clip, rel: p ? p.vaultRel : null });
        toast(`Saved from browser: ${clip.title || clip.url || 'clip'}`);
        refresh();
        return saved;
      },
    });
    try {
      await clipper.start();
      clipperError = null;
    } catch (e) {
      clipperError = e.code === 'EADDRINUSE' ? `Port ${s.clipper.port} is busy. Pick another port.` : e.message;
      clipper = null;
    }
  }
  async function stopClipper() {
    if (clipper) { await clipper.stop(); clipper = null; }
  }

  // ---------- clipboard hotkey ----------
  // Electron 44 made clipboard.readText() return a Promise, so it has to be awaited.
  async function saveClipboard() {
    const text = String((await clipboard.readText()) || '').trim();
    if (!text) { toast('Clipboard is empty. Copy something first.'); return null; }
    const isUrl = /^https?:\/\/\S+$/i.test(text);
    const title = isUrl ? text.replace(/^https?:\/\//, '').slice(0, 80) : text.split(/\r?\n/)[0].slice(0, 80);
    const saved = vault().saveClip({ title, url: isUrl ? text : null, text: isUrl ? '' : text, rel: null });
    if (Notification.isSupported()) new Notification({ title: 'Saved to Memory Vault', body: `Inbox: ${title}` }).show();
    toast(`Saved clipboard to Inbox: ${title}`);
    refresh();
    return saved;
  }
  function applyHotkey() {
    const s = settings();
    if (hotkeyRegistered) { globalShortcut.unregister(s.hotkey.accel); hotkeyRegistered = false; }
    if (s.hotkey.enabled) hotkeyRegistered = globalShortcut.register(s.hotkey.accel, () => { saveClipboard().catch(e => toast(e.message)); });
  }

  // ---------- local AI ----------
  function applyAI() {
    const s = settings();
    ai = s.ai.enabled ? new LocalAI({ url: s.ai.url, model: s.ai.model }) : null;
    assistant = ai ? new Assistant({ ai, getData, vault }) : null;
    history = [];
  }

  async function status() {
    const s = settings();
    if (Date.now() - installed.at > 60000) {
      installed.claude = await which(TOOLS.claude);
      installed.opencode = await which(TOOLS.opencode);
      installed.at = Date.now();
    }
    const data = getData();
    const st = data && data.status;
    return {
      claude: { installed: installed.claude, found: st ? st.claude.found : false, sessions: st ? st.claude.sessions : 0, path: s.claudeDir },
      opencode: { installed: installed.opencode, found: st ? st.opencode.found : false, sessions: st ? st.opencode.sessions : 0, path: s.opencodeDb },
      clipper: { enabled: s.clipper.enabled, running: !!clipper, port: s.clipper.port, token: s.clipper.token, error: clipperError },
      hotkey: { enabled: s.hotkey.enabled, accel: s.hotkey.accel, registered: hotkeyRegistered },
      ai: { enabled: s.ai.enabled, url: s.ai.url, model: s.ai.model, summarizeImports: s.ai.summarizeImports, ...(ai ? await ai.status() : { running: false, models: [] }) },
    };
  }

  async function setFeature(name, patch) {
    const s = settings();
    if (!DEFAULTS[name]) throw new Error('Unknown feature');
    const oldAccel = s.hotkey.accel;
    s[name] = { ...s[name], ...patch };
    if (name === 'clipper' && patch.newToken) { s.clipper.token = newToken(); delete s.clipper.newToken; }
    if (name === 'hotkey' && hotkeyRegistered) { globalShortcut.unregister(oldAccel); hotkeyRegistered = false; }
    saveSettings(s);
    if (name === 'clipper') await startClipper();
    if (name === 'hotkey') applyHotkey();
    if (name === 'ai') applyAI();
    return status();
  }

  // ---------- import (drag and drop, New project) ----------
  async function importPaths(list, targetId) {
    const data = getData() || { projects: [] };
    const target = targetId ? data.projects.find(p => p.id === targetId) : null;
    const names = knownNames();
    const results = [];
    const readmes = new Map();
    for (const p of list) {
      const name = path.basename(p);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          const r = vault().importFolder(p, target ? target.vaultRel : [], names);
          readmes.set(r.file, r.analysis.readme);
          results.push({ name, ok: true, kind: 'folder', rel: r.rel, file: r.file, about: r.analysis.about, languages: r.analysis.languages });
        } else if (/\.(md|markdown|txt)$/i.test(p)) {
          const r = vault().importMarkdown(p, target ? target.vaultRel : null, names);
          results.push({ name, ok: true, kind: 'note', rel: r.rel, file: r.file, title: r.analysis.title, mentions: r.analysis.mentions, headings: r.analysis.headings });
        } else {
          results.push({ name, ok: false, error: 'Only .md, .txt and folders can be added.' });
        }
      } catch (e) {
        results.push({ name, ok: false, error: e.message });
      }
    }
    refresh();
    // The written summary comes later, from the local model, if it is on.
    const s = settings();
    if (ai && s.ai.summarizeImports) {
      (async () => {
        for (const r of results.filter(x => x.ok)) {
          try {
            const text = fs.readFileSync(r.file, 'utf8');
            const extra = readmes.get(r.file) ? `\n\nREADME:\n${readmes.get(r.file)}` : '';
            const summary = await ai.summarize(text + extra);
            if (summary) fs.appendFileSync(r.file, `\n\n## Summary (local AI)\n\n${summary}\n`, 'utf8');
          } catch (e) { toast(`Summary skipped for ${r.name}: ${e.message}`); break; }
        }
        refresh();
        toast('Local AI added summaries to the new notes.');
      })();
    }
    return results;
  }

  function newProject({ name, parentId }) {
    const data = getData() || { projects: [] };
    const parent = parentId ? data.projects.find(p => p.id === parentId) : null;
    const r = vault().createProject(String(name || '').trim() || 'New project', parent ? parent.vaultRel : []);
    refresh();
    return r;
  }

  // ---------- Claude Code / OpenCode ----------
  function launch(tool, projectId) {
    const cmd = TOOLS[tool];
    if (!cmd) throw new Error('Unknown tool');
    const data = getData() || { projects: [] };
    const p = data.projects.find(x => x.id === projectId);
    if (!p) throw new Error('Pick a project first.');
    let dir = p.path;
    if (/^[A-Za-z]:\//.test(dir)) dir = dir.replace(/\//g, '\\');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`The folder ${p.path} is not on this PC.`);
    launchInTerminal(cmd, dir);
    return { ok: true, dir };
  }

  // ---------- assistant ----------
  async function ask(text) {
    if (!assistant) throw new Error('Turn on Local AI first (Connections in the sidebar).');
    const r = await assistant.ask(history, String(text).slice(0, 4000));
    history = r.history;
    for (const a of r.actions) pending.set(a.id, a);
    while (pending.size > 30) pending.delete(pending.keys().next().value);
    return { reply: r.reply, actions: r.actions, steps: r.steps };
  }

  async function approve(id) {
    const a = pending.get(id);
    if (!a) throw new Error('That action expired. Ask again.');
    pending.delete(id);
    if (a.tool === 'open_url') { await shell.openExternal(a.target); return `Opened ${a.target}`; }
    if (a.tool === 'open_app' && a.target.endsWith('.desktop')) {
      spawn('gtk-launch', [path.basename(a.target, '.desktop')], { detached: true, stdio: 'ignore' }).on('error', () => shell.openPath(a.target)).unref();
      return `Opened ${path.basename(a.target, '.desktop')}`;
    }
    const err = await shell.openPath(a.target);
    if (err) throw new Error(err);
    history.push({ role: 'assistant', content: `(The user approved: ${a.label}.)` });
    return `Opened ${path.basename(a.target)}`;
  }

  async function startAll() {
    applyAI();
    applyHotkey();
    await startClipper();
  }

  async function stopAll() {
    globalShortcut.unregisterAll();
    await stopClipper();
  }

  return { status, setFeature, importPaths, newProject, launch, ask, approve, resetChat: () => { history = []; }, startAll, stopAll, saveClipboard };
}

module.exports = { createFeatures, DEFAULTS, launchInTerminal };
