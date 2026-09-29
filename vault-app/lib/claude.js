'use strict';
const fs = require('fs');
const path = require('path');

// Tools that change a file. Reads are left out on purpose: they would flood the graph.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function userText(content) {
  let t = '';
  if (typeof content === 'string') t = content;
  else if (Array.isArray(content)) {
    if (content.some(p => p && p.type === 'tool_result')) return '';
    const part = content.find(p => p && p.type === 'text');
    t = part ? part.text || '' : '';
  }
  t = t.trim();
  // Slash-command wrappers, hook output and system notes all start with a tag.
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return '';
  return t;
}

function freshState(file) {
  return {
    offset: 0,
    sessionId: path.basename(file, '.jsonl'),
    cwd: null,
    start: 0,
    end: 0,
    title: null,
    firstPrompt: null,
    prompts: 0,
    files: new Set(),
  };
}

function parseLine(st, line) {
  if (!line.trim()) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (!d || typeof d !== 'object') return;

  if (d.cwd && !st.cwd) st.cwd = d.cwd;
  if (d.timestamp) {
    const t = Date.parse(d.timestamp);
    if (!Number.isNaN(t)) {
      if (!st.start || t < st.start) st.start = t;
      if (t > st.end) st.end = t;
    }
  }
  if (d.type === 'summary' && typeof d.summary === 'string') st.title = d.summary;
  if (d.type === 'custom-title' && typeof d.customTitle === 'string') st.title = d.customTitle;
  if (d.type === 'ai-title' && typeof d.aiTitle === 'string' && !st.title) st.title = d.aiTitle;

  if (d.isSidechain) return;
  const m = d.message;
  if (!m || typeof m !== 'object') return;

  if (d.type === 'user') {
    const text = userText(m.content);
    if (text) {
      st.prompts++;
      if (!st.firstPrompt) st.firstPrompt = text;
    }
  } else if (d.type === 'assistant' && Array.isArray(m.content)) {
    for (const p of m.content) {
      if (p && p.type === 'tool_use' && EDIT_TOOLS.has(p.name) && p.input) {
        const f = p.input.file_path || p.input.notebook_path;
        if (typeof f === 'string' && f) st.files.add(f);
      }
    }
  }
}

class ClaudeSource {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map(); // transcript path -> parse state
  }

  // Transcripts are append-only, so each call only reads the new bytes.
  readFile(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    let st = this.cache.get(file);
    if (!st || stat.size < st.offset) {
      st = freshState(file);
      this.cache.set(file, st);
    }
    if (stat.size === st.offset) return st;

    const len = stat.size - st.offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.offset); } finally { fs.closeSync(fd); }

    // Only consume up to the last complete line; a half-written line is read next time.
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return st;
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) parseLine(st, line);
    st.offset += lastNl + 1;
    return st;
  }

  scan() {
    const sessions = [];
    const seen = new Set();
    let dirs = [];
    try { dirs = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return sessions; }

    for (const d of dirs) {
      const pdir = path.join(this.dir, d.name);
      let entries = [];
      try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const file = path.join(pdir, e.name);
        seen.add(file);
        const st = this.readFile(file);
        if (!st || !st.cwd || !st.prompts) continue;
        sessions.push({
          id: 'cc:' + st.sessionId,
          source: 'claude',
          directory: st.cwd,
          title: st.title || st.firstPrompt,
          firstPrompt: st.firstPrompt,
          prompts: st.prompts,
          start: st.start,
          end: st.end,
          files: [...st.files],
          transcript: file,
        });
      }
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    return sessions;
  }
}

module.exports = { ClaudeSource, parseLine, freshState, userText };
