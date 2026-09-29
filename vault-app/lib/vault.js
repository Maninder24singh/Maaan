'use strict';
const fs = require('fs');
const path = require('path');
const { pathKey, baseName, normPath } = require('./paths');
const { analyzeMarkdown, analyzeFolder } = require('./analyze');

// Notes this app writes carry this marker. Anything without it is yours and is never touched.
const GENERATED = 'memory-vault';
// Folders inside a project that hold notes, not sub-projects.
const RESERVED = new Set(['sessions', 'clips', 'attachments', 'assets', 'images']);
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

function isoNow() { return new Date().toISOString(); }

// Adds keys to a note's frontmatter (creating it if needed) without touching existing keys.
function withFrontmatter(text, fields) {
  const lines = Object.entries(fields).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${String(v).replace(/\r?\n/g, ' ')}`);
  if (!lines.length) return text;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return ['---', ...lines, '---', '', text].join('\n');
  const have = new Set(m[1].split(/\r?\n/).map(l => (l.match(/^([\w-]+):/) || [])[1]).filter(Boolean));
  const add = lines.filter(l => !have.has(l.split(':')[0]));
  return '---\n' + [m[1], ...add].join('\n') + '\n---\n' + text.slice(m[0].length);
}

function uniqueFile(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file), base = file.slice(0, -ext.length);
  for (let i = 2; i < 1000; i++) if (!fs.existsSync(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  return `${base} (${Date.now()})${ext}`;
}

function relatedSection(names) {
  return names.length ? '\n\n## Related\n' + names.map(n => `- [[${n}]]`).join('\n') + '\n' : '';
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
      const old = fs.readFileSync(file, 'utf8');
      if (old === content) return false;
      // Never overwrite a note you wrote, even if it has the same name as one of ours.
      if (!parseFrontmatter(old).fm.generated) return false;
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

  // Folders in the vault that count as projects: every folder except hidden and RESERVED ones.
  folders() {
    const notes = this.readAll();
    const about = new Map();
    for (const n of notes) {
      if (n.fm.type === 'project') about.set(path.dirname(n.file), n.fm);
    }
    const out = [];
    const rec = (dir, rel) => {
      if (rel.length > 4) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || RESERVED.has(e.name.toLowerCase())) continue;
        const d = path.join(dir, e.name);
        let mtime = 0;
        try { mtime = fs.statSync(d).mtimeMs; } catch { /* gone */ }
        const fm = about.get(d) || {};
        out.push({ rel: [...rel, e.name], dir: d, mtime, folder: fm.folder || null, about: fm.about || '' });
        rec(d, [...rel, e.name]);
      }
    };
    rec(this.dir, []);
    return out;
  }

  // Your own notes (no generated marker). The deepest project folder a note sits in owns it.
  userNotes(idByRel) {
    const out = [];
    for (const n of this.readAll()) {
      if (n.fm.generated === GENERATED) continue;
      const parts = path.relative(this.dir, n.file).split(path.sep).slice(0, -1);
      let projectId = null;
      for (let i = parts.length; i > 0 && !projectId; i--) projectId = idByRel.get(parts.slice(0, i).join('/').toLowerCase()) || null;
      out.push({
        id: 'n:' + pathKey(n.file),
        title: path.basename(n.file, path.extname(n.file)),
        file: n.file,
        kind: n.fm.type === 'clip' ? 'clip' : n.fm.type === 'project' ? 'about' : 'note',
        url: n.fm.source_url || null,
        projectId,
        links: n.links,
      });
    }
    return out;
  }

  dirFor(rel) {
    const dir = path.join(this.dir, ...rel.map(r => safeName(r, 80)));
    const back = path.relative(this.dir, dir);
    if (back.startsWith('..') || path.isAbsolute(back)) throw new Error('That folder is outside the vault.');
    return dir;
  }

  // New project = a folder in the vault with an "About" note you can edit.
  createProject(name, parentRel = [], opts = {}) {
    const clean = safeName(name, 80);
    const rel = [...parentRel, clean];
    const dir = this.dirFor(rel);
    fs.mkdirSync(dir, { recursive: true });
    const aboutFile = path.join(dir, `About ${clean}.md`);
    if (!fs.existsSync(aboutFile)) {
      const head = { type: 'project', folder: opts.folder || null, about: opts.about || null, created: isoNow() };
      fs.writeFileSync(aboutFile, withFrontmatter(`# ${clean}\n\n${opts.body || opts.about || 'What is this project about?'}\n`, head), 'utf8');
    }
    return { rel, dir, aboutFile };
  }

  // Copies a dropped .md into a project (a new one named after the note if no target).
  importMarkdown(src, targetRel, names = []) {
    const text = fs.readFileSync(src, 'utf8');
    const a = analyzeMarkdown(text, path.basename(src), names);
    let rel = targetRel;
    if (!rel || !rel.length) rel = this.createProject(a.title, [], { about: a.firstParagraph }).rel;
    const dir = this.dirFor(rel);
    fs.mkdirSync(dir, { recursive: true });
    const dest = uniqueFile(path.join(dir, safeName(path.basename(src, path.extname(src)), 100) + '.md'));
    const content = withFrontmatter(text, { imported_from: src, imported_at: isoNow() }).replace(/\s*$/, '') + relatedSection(a.mentions);
    fs.writeFileSync(dest, content + (content.endsWith('\n') ? '' : '\n'), 'utf8');
    return { file: dest, rel, analysis: a };
  }

  // Registers a folder on disk as a project and writes what the app could work out about it.
  importFolder(src, parentRel = [], names = []) {
    const a = analyzeFolder(src);
    const langs = a.languages.map(l => `${l.name} (${l.files})`).join(', ');
    const mentions = require('./analyze').findMentions(a.readme, names, a.name);
    const body = [
      `# ${a.name}`,
      '',
      a.about || '_No README description found._',
      '',
      '## What is inside',
      `- ${a.files}${a.capped ? '+' : ''} files${langs ? `. Mostly ${langs}` : ''}`,
      ...(a.manifest.kind ? [`- ${a.manifest.kind} project${a.manifest.uses && a.manifest.uses.length ? `, uses ${a.manifest.uses.join(', ')}` : ''}`] : []),
      ...(a.keyFiles.length ? ['', '## Key files', ...a.keyFiles.map(f => `- \`${f}\``)] : []),
    ].join('\n');
    const { rel, aboutFile } = this.createProject(a.name, parentRel, { folder: normPath(src), about: a.about, body: body.split('\n').slice(2).join('\n') });
    if (mentions.length) fs.appendFileSync(aboutFile, relatedSection(mentions), 'utf8');
    return { rel, file: aboutFile, analysis: a };
  }

  // A clip from the browser or clipboard. Goes to the project's clips/ folder, or Inbox.
  saveClip({ title, url, text, rel }) {
    const target = rel && rel.length ? rel : ['Inbox'];
    const dir = path.join(this.dirFor(target), 'clips');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const name = safeName(title || (url ? url.replace(/^https?:\/\//, '') : 'Clip'), 70);
    const file = uniqueFile(path.join(dir, `${stamp} ${name}.md`));
    const quote = String(text || '').trim().slice(0, 20000).split(/\r?\n/).map(l => '> ' + l).join('\n');
    const body = [`# ${String(title || name).slice(0, 200)}`, '', ...(quote ? [quote, ''] : []), ...(url ? [`Source: ${url}`, ''] : [])].join('\n');
    fs.writeFileSync(file, withFrontmatter(body, { type: 'clip', source_url: url || null, saved_at: isoNow() }), 'utf8');
    return { file, rel: target };
  }

  // A note written by the local AI or typed in the app.
  saveNote({ title, text, rel }) {
    const target = rel && rel.length ? rel : ['Inbox'];
    const dir = this.dirFor(target);
    fs.mkdirSync(dir, { recursive: true });
    const file = uniqueFile(path.join(dir, safeName(title || 'Note', 80) + '.md'));
    fs.writeFileSync(file, withFrontmatter(`# ${title || 'Note'}\n\n${text || ''}\n`, { created: isoNow() }), 'utf8');
    return { file, rel: target };
  }
}

module.exports = { Vault, safeName, parseFrontmatter, linksIn, withFrontmatter, GENERATED, RESERVED };
