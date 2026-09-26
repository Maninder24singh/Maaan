'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripThink } = require('./ai');

// What the local model is allowed to do. Reading tools run on their own;
// anything that opens something on the PC waits for a click from you.
const TOOL_DEFS = [
  ['search_vault', 'Search the memory vault: projects, coding sessions, notes and saved browser clips. Use this first for any question about the user\'s work.', { query: 'string' }, ['query']],
  ['list_projects', 'List all projects in the vault with their folders.', {}, []],
  ['find_app', 'Find an installed app on this PC by name.', { name: 'string' }, ['name']],
  ['find_file', 'Find files on this PC by part of the file name. Looks in Desktop, Documents, Downloads, Pictures, Videos, Music and project folders.', { name: 'string' }, ['name']],
  ['open_app', 'Open an app that find_app returned. The user must approve.', { path: 'string' }, ['path']],
  ['open_path', 'Open a file or folder. The user must approve.', { path: 'string' }, ['path']],
  ['open_url', 'Open a web page in the browser. The user must approve.', { url: 'string' }, ['url']],
  ['save_note', 'Save a note into the memory vault. Use project names from list_projects, or leave project empty for Inbox.', { title: 'string', text: 'string', project: 'string' }, ['title', 'text']],
];
const ACTIONS = new Set(['open_app', 'open_path', 'open_url']);

const tools = TOOL_DEFS.map(([name, description, props, required]) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
      required,
    },
  },
}));

const SKIP = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', '.venv', 'venv', '__pycache__', 'dist', 'build', '.cache', 'Library']);

function words(q) {
  return String(q || '').toLowerCase().split(/[^\p{L}\p{N}.]+/u).filter(w => w.length > 1);
}

function score(text, terms, weight = 1) {
  const t = String(text || '').toLowerCase();
  let s = 0;
  for (const w of terms) if (t.includes(w)) s += weight;
  return s;
}

function snippet(text, terms) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const low = t.toLowerCase();
  const i = Math.max(0, Math.min(...terms.map(w => { const j = low.indexOf(w); return j < 0 ? Infinity : j; })));
  const start = Number.isFinite(i) ? Math.max(0, i - 60) : 0;
  return (start ? '…' : '') + t.slice(start, start + 220);
}

function appDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(home, 'Desktop'),
      path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),
    ];
  }
  if (process.platform === 'darwin') return ['/Applications', '/System/Applications', path.join(home, 'Applications')];
  return ['/usr/share/applications', '/var/lib/flatpak/exports/share/applications', path.join(home, '.local', 'share', 'applications')];
}

function listApps(dirs) {
  const out = [];
  const rec = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.name.endsWith('.app')) { out.push({ name: e.name.slice(0, -4), path: p }); continue; }
      if (e.isDirectory()) { if (depth < 3) rec(p, depth + 1); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (ext === '.lnk' || ext === '.url' || ext === '.exe') {
        out.push({ name: path.basename(e.name, ext), path: p });
      } else if (ext === '.desktop') {
        let name = path.basename(e.name, ext);
        try {
          const m = fs.readFileSync(p, 'utf8').match(/^Name=(.+)$/m);
          if (m) name = m[1].trim();
        } catch { /* unreadable */ }
        out.push({ name, path: p });
      }
    }
  };
  for (const d of dirs) rec(d, 0);
  return out;
}

class Assistant {
  // deps: { ai, getData, vault, appDirs?, fileRoots? }
  constructor(deps) {
    this.deps = deps;
    this.appCache = null;
    this.seenPaths = new Set(); // paths the tools actually returned; the only ones that can be opened
  }

  apps() {
    if (!this.appCache || Date.now() - this.appCache.at > 10 * 60 * 1000) {
      this.appCache = { at: Date.now(), list: listApps(this.deps.appDirs || appDirs()) };
    }
    return this.appCache.list;
  }

  fileRoots() {
    if (this.deps.fileRoots) return this.deps.fileRoots;
    const home = os.homedir();
    const roots = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music'].map(d => path.join(home, d));
    const data = this.deps.getData() || { projects: [] };
    for (const p of data.projects) if (p.path && !roots.includes(p.path)) roots.push(p.path);
    return roots.filter(r => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
  }

  remember(list, key = 'path') {
    for (const x of list) if (x && x[key]) this.seenPaths.add(x[key]);
    return list;
  }

  run(name, args) {
    const data = this.deps.getData() || { projects: [], sessions: [], notes: [] };
    if (name === 'list_projects') {
      return data.projects.map(p => ({ name: p.name, folder: p.path, sessions: p.sessionCount }));
    }
    if (name === 'search_vault') {
      const terms = words(args.query);
      if (!terms.length) return { error: 'Empty search.' };
      const projName = new Map(data.projects.map(p => [p.id, p.name]));
      const hits = [];
      for (const p of data.projects) {
        const s = score(p.name, terms, 3) + score(p.path, terms) + score(p.about, terms);
        if (s) hits.push({ s, type: 'project', title: p.name, path: p.path, snippet: p.about || '' });
      }
      for (const x of data.sessions) {
        const s = score(x.title, terms, 3) + score(x.firstPrompt, terms) + score(x.files.join(' '), terms);
        if (s) hits.push({ s, type: x.source === 'claude' ? 'Claude Code session' : 'OpenCode session', title: x.title, project: projName.get(x.projectId), snippet: snippet(x.firstPrompt, terms), files: x.files.slice(0, 5) });
      }
      for (const n of data.notes.slice(0, 2000)) {
        let text = '';
        try { text = fs.readFileSync(n.file, 'utf8').slice(0, 8000); } catch { continue; }
        const s = score(n.title, terms, 3) + score(text, terms);
        if (s) hits.push({ s, type: n.kind === 'clip' ? 'browser clip' : 'note', title: n.title, project: projName.get(n.projectId), path: n.file, url: n.url || undefined, snippet: snippet(text.replace(/^---[\s\S]*?---/, ''), terms) });
      }
      hits.sort((a, b) => b.s - a.s);
      const top = hits.slice(0, 8).map(({ s, ...rest }) => rest);
      this.remember(top);
      return top.length ? top : { result: 'Nothing found in the vault.' };
    }
    if (name === 'find_app') {
      const terms = words(args.name);
      const found = this.apps()
        .map(a => ({ ...a, s: score(a.name, terms, 2) + (a.name.toLowerCase() === String(args.name).toLowerCase() ? 5 : 0) }))
        .filter(a => a.s > 0)
        .sort((a, b) => b.s - a.s || a.name.length - b.name.length)
        .slice(0, 5)
        .map(({ s, ...a }) => a);
      this.remember(found);
      return found.length ? found : { result: `No installed app matches "${args.name}".` };
    }
    if (name === 'find_file') {
      const terms = words(args.name);
      if (!terms.length) return { error: 'Empty file name.' };
      const found = [];
      const deadline = Date.now() + 2500;
      let seen = 0;
      const queue = this.fileRoots().map(r => [r, 0]);
      while (queue.length && Date.now() < deadline && seen < 60000) {
        const [d, depth] = queue.shift();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          seen++;
          if (e.name.startsWith('.')) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) { if (!SKIP.has(e.name) && depth < 6) queue.push([p, depth + 1]); }
          const low = e.name.toLowerCase();
          if (terms.every(w => low.includes(w))) {
            let mtime = 0;
            try { mtime = fs.statSync(p).mtimeMs; } catch { /* gone */ }
            found.push({ name: e.name, path: p, folder: e.isDirectory(), modified: new Date(mtime).toISOString().slice(0, 10), mtime });
          }
        }
      }
      found.sort((a, b) => b.mtime - a.mtime);
      const top = found.slice(0, 10).map(({ mtime, ...f }) => f);
      this.remember(top);
      return top.length ? top : { result: `No file named like "${args.name}" found.` };
    }
    if (name === 'save_note') {
      const proj = data.projects.find(p => p.name.toLowerCase() === String(args.project || '').toLowerCase());
      const saved = this.deps.vault().saveNote({ title: String(args.title || 'Note').slice(0, 120), text: String(args.text || ''), rel: proj ? proj.vaultRel : null });
      return { saved: saved.file };
    }
    return { error: `Unknown tool ${name}` };
  }

  // Checks an action before showing it to you. Only paths the tools found can be opened.
  describeAction(name, args) {
    if (name === 'open_url') {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) return { error: 'Only http and https links can be opened.' };
      return { tool: name, target: url, label: `Open ${url} in your browser` };
    }
    const p = String(args.path || '');
    if (!this.seenPaths.has(p)) return { error: 'That path did not come from a search, so it will not be opened. Search for it first.' };
    if (!fs.existsSync(p)) return { error: 'That file does not exist any more.' };
    return { tool: name, target: p, label: name === 'open_app' ? `Open app ${path.basename(p, path.extname(p))}` : `Open ${p}` };
  }

  systemPrompt() {
    const data = this.deps.getData() || { projects: [] };
    const names = data.projects.slice(0, 40).map(p => p.name).join(', ');
    return [
      'You are the assistant inside Memory Vault, an app on the user\'s own laptop.',
      `Today is ${new Date().toDateString()}. The computer runs ${process.platform === 'win32' ? 'Windows' : process.platform}.`,
      'Use the tools to answer. Search the vault before answering questions about the user\'s work.',
      'To open an app, first call find_app, then open_app with a path it returned. Same for files: find_file, then open_path.',
      'The user approves every open action with a button, so just call the tool.',
      'Answer in short, simple sentences. Never invent file paths.',
      names ? `Projects in the vault: ${names}.` : '',
    ].filter(Boolean).join('\n');
  }

  // One user turn. Returns the reply plus any actions waiting for approval.
  async ask(history, text) {
    const messages = [{ role: 'system', content: this.systemPrompt() }, ...history, { role: 'user', content: text }];
    const pending = [];
    const steps = [];
    for (let round = 0; round < 6; round++) {
      const r = await this.deps.ai.chat(messages, tools);
      const msg = r.message || { role: 'assistant', content: '' };
      messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
      const calls = msg.tool_calls || [];
      if (!calls.length) break;
      for (const c of calls) {
        const name = c.function && c.function.name;
        let args = (c.function && c.function.arguments) || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        let result;
        if (ACTIONS.has(name)) {
          const a = this.describeAction(name, args);
          if (a.error) result = { error: a.error };
          else { pending.push({ id: `${Date.now()}-${pending.length}`, ...a }); result = { status: 'Shown to the user as a button. It opens when they approve.' }; }
        } else {
          try { result = this.run(name, args); } catch (e) { result = { error: e.message }; }
        }
        steps.push({ tool: name, args });
        messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result).slice(0, 6000) });
      }
    }
    const last = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    const reply = stripThink(last ? last.content : '') || (pending.length ? 'Ready. Approve below.' : 'I could not find an answer.');
    // Keep only plain turns in history so the next question stays small.
    const nextHistory = [...history, { role: 'user', content: text }, { role: 'assistant', content: reply }].slice(-12);
    return { reply, actions: pending, steps, history: nextHistory };
  }
}

module.exports = { Assistant, tools, ACTIONS, listApps };
