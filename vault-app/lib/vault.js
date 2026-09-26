'use strict';
const fs = require('fs');
const path = require('path');
const { pathKey, baseName } = require('./paths');

// Notes this app writes carry this marker. Anything without it is yours and is never touched.
const GENERATED = 'memory-vault';
const LINK_RE = /\[\[([^\[\]|#]+)(?:[#|][^\]]*)?\]\]/g;

function safeName(s, max = 60) {
  const clean = String(s || '')
    .replace(/[\\/:*?"<>|#^\[\]\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '');
  return clean || 'untitled';
}

function pad(n) { return String(n).padStart(2, '0'); }
function localDate(ms) {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localStamp(ms) {
  const d = new Date(ms || Date.now());
  return `${localDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseFrontmatter(text) {
  const fm = {};
  let body = text;
  if (/^---\r?\n/.test(text)) {
    const end = text.indexOf('\n---', 3);
    if (end > 0) {
      const head = text.slice(text.indexOf('\n') + 1, end);
      for (const line of head.split(/\r?\n/)) {
        const m = line.match(/^([\w-]+):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      const after = text.indexOf('\n', end + 1);
      body = after >= 0 ? text.slice(after + 1) : '';
    }
  }
  return { fm, body };
}

function linksIn(body) {
  const out = [];
  for (const m of body.matchAll(LINK_RE)) {
    const t = m[1].trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const SOURCE_LABEL = { claude: 'Claude Code', opencode: 'OpenCode' };

function renderSession(s, project, projectNote) {
  const quote = String(s.firstPrompt || '').slice(0, 600).split(/\r?\n/).map(l => '> ' + l).join('\n');
  const files = s.files.map(f => `- [[${safeName(baseName(f), 120)}]] \`${f}\``).join('\n');
  return [
    '---',
    `generated: ${GENERATED}`,
    `session: ${s.id}`,
    `source: ${SOURCE_LABEL[s.source] || s.source}`,
    `project: ${project.path}`,
    `started: ${new Date(s.start || s.end || 0).toISOString()}`,
    `updated: ${new Date(s.end || s.start || 0).toISOString()}`,
    `prompts: ${s.prompts}`,
    '---',
    `# ${String(s.title || 'Untitled session').split(/\r?\n/)[0].slice(0, 120)}`,
    '',
    `Project: [[${projectNote}]]`,
    `Tool: ${SOURCE_LABEL[s.source] || s.source} · ${s.prompts} prompt${s.prompts === 1 ? '' : 's'} · ${localStamp(s.start)} to ${localStamp(s.end)}`,
    '',
    ...(quote ? ['## First prompt', quote, ''] : []),
    '## Files changed',
    files || '_None yet._',
    '',
  ].join('\n');
}

function renderProject(p, parentNote, childNotes, sessionNotes) {
  return [
    '---',
    `generated: ${GENERATED}`,
    `project: ${p.path}`,
    '---',
    `# ${p.name}`,
    '',
    `Folder: \`${p.path}\``,
    ...(parentNote ? [`Part of: [[${parentNote}]]`] : []),
    '',
    ...(childNotes.length ? ['## Sub-projects', ...childNotes.map(n => `- [[${n}]]`), ''] : []),
    '## Sessions',
    ...(sessionNotes.length ? sessionNotes.map(n => `- [[${n}]]`) : ['_None yet._']),
    '',
  ].join('\n');
}

class Vault {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map(); // file -> { mtime, fm, links }
  }

  walk() {
    const out = [];
    const rec = (d, depth) => {
      if (depth > 8) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue; // .obsidian, .trash, etc.
        const p = path.join(d, e.name);
        if (e.isDirectory()) rec(p, depth + 1);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
      }
    };
    rec(this.dir, 0);
    return out;
  }

  readAll() {
    const seen = new Set();
    const notes = [];
    for (const file of this.walk()) {
      seen.add(file);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      let c = this.cache.get(file);
      if (!c || c.mtime !== st.mtimeMs) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const { fm, body } = parseFrontmatter(text);
        c = { mtime: st.mtimeMs, fm, links: linksIn(body) };
        this.cache.set(file, c);
      }
      notes.push({ file, fm: c.fm, links: c.links });
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    return notes;
  }

  writeIfChanged(file, content) {
    try {
      if (fs.readFileSync(file, 'utf8') === content) return false;
    } catch { /* new file */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return true;
  }

  // Writes one note per project and per session. Returns how many files changed.
  write(model) {
    const existing = new Map();
    for (const n of this.readAll()) {
      if (n.fm.generated === GENERATED && n.fm.session) existing.set(n.fm.session, n.file);
    }
    const projById = new Map(model.projects.map(p => [p.id, p]));
    const projNote = p => safeName(p.name, 80);
    const sessionsByProject = new Map();
    let written = 0;

    for (const s of model.sessions) {
      const p = projById.get(s.projectId);
      const folder = path.join(this.dir, projNote(p), 'sessions');
      const tag = (s.source === 'claude' ? 'cc-' : 'oc-') + s.id.slice(3, 11);
      const name = `${localDate(s.start)} ${safeName(s.title, 50)} (${tag})`;
      const target = path.join(folder, name + '.md');
      const old = existing.get(s.id);
      if (old && old !== target && fs.existsSync(old)) {
        // Title changed (Claude Code adds a summary later): rename instead of leaving a duplicate.
        try { fs.mkdirSync(folder, { recursive: true }); fs.renameSync(old, target); } catch { /* keep going */ }
      }
      if (this.writeIfChanged(target, renderSession(s, p, projNote(p)))) written++;
      if (!sessionsByProject.has(p.id)) sessionsByProject.set(p.id, []);
      sessionsByProject.get(p.id).push({ name, end: s.end || 0 });
    }

    for (const p of model.projects) {
      const parent = p.parentId ? projById.get(p.parentId) : null;
      const children = model.projects.filter(c => c.parentId === p.id).map(projNote);
      const sessions = (sessionsByProject.get(p.id) || []).sort((a, b) => b.end - a.end).map(x => x.name);
      const file = path.join(this.dir, projNote(p), projNote(p) + '.md');
      if (this.writeIfChanged(file, renderProject(p, parent && projNote(parent), children, sessions))) written++;
    }
    return written;
  }

  // Your own notes (no generated marker). The top folder decides which project a note belongs to.
  userNotes(model) {
    const byFolder = new Map(model.projects.map(p => [safeName(p.name, 80).toLowerCase(), p.id]));
    const out = [];
    for (const n of this.readAll()) {
      if (n.fm.generated === GENERATED) continue;
      const rel = path.relative(this.dir, n.file).split(path.sep);
      const projectId = rel.length > 1 ? byFolder.get(rel[0].toLowerCase()) || null : null;
      out.push({
        id: 'n:' + pathKey(n.file),
        title: path.basename(n.file, path.extname(n.file)),
        file: n.file,
        projectId,
        links: n.links,
      });
    }
    return out;
  }
}

module.exports = { Vault, safeName, parseFrontmatter, linksIn, GENERATED };
