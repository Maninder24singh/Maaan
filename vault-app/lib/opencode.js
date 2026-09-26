'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normPath } = require('./paths');

const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit']);

function isAbs(p) {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p);
}

// One row of the `part` table -> list of files that tool call changed.
function filesFromPart(data) {
  const out = [];
  if (!data || data.type !== 'tool' || !EDIT_TOOLS.has(String(data.tool || '').toLowerCase())) return out;
  const input = (data.state && data.state.input) || data.input || {};
  for (const k of ['filePath', 'file_path', 'path']) {
    if (typeof input[k] === 'string' && input[k]) out.push(input[k]);
  }
  const patch = input.patchText || input.patch;
  if (typeof patch === 'string') {
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  }
  return out;
}

function filesFromDiffs(json) {
  const out = [];
  if (!json) return out;
  let v;
  try { v = typeof json === 'string' ? JSON.parse(json) : json; } catch { return out; }
  if (Array.isArray(v)) for (const d of v) if (d && typeof d.file === 'string') out.push(d.file);
  return out;
}

class OpencodeSource {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.files = new Map(); // session id -> Set of paths
    this.cursor = 0;        // newest part.time_updated already read
    this.lastSessions = [];
    this.lastError = null;
  }

  open() {
    const { DatabaseSync } = require('node:sqlite');
    try {
      return new DatabaseSync(this.dbPath, { readOnly: true });
    } catch {
      // Some setups refuse a read-only open of a WAL database. Read a private copy instead;
      // OpenCode's own file is never opened for writing.
      const tmp = path.join(os.tmpdir(), 'memory-vault-opencode');
      fs.mkdirSync(tmp, { recursive: true });
      for (const ext of ['', '-wal', '-shm']) {
        const src = this.dbPath + ext;
        const dst = path.join(tmp, 'opencode.db' + ext);
        if (fs.existsSync(src)) fs.copyFileSync(src, dst);
        else fs.rmSync(dst, { force: true });
      }
      return new DatabaseSync(path.join(tmp, 'opencode.db'), { readOnly: true });
    }
  }

  scan() {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return [];
    let db;
    try {
      db = this.open();

      const parts = db.prepare(
        `SELECT session_id, data, time_updated FROM part
         WHERE time_updated >= ? AND data LIKE '%"tool"%' ORDER BY time_updated`
      ).all(this.cursor);
      for (const row of parts) {
        let data;
        try { data = JSON.parse(row.data); } catch { continue; }
        const found = filesFromPart(data);
        if (found.length) {
          if (!this.files.has(row.session_id)) this.files.set(row.session_id, new Set());
          for (const f of found) this.files.get(row.session_id).add(f);
        }
        if (row.time_updated > this.cursor) this.cursor = row.time_updated;
      }

      const prompts = new Map();
      try {
        for (const r of db.prepare(
          `SELECT session_id, COUNT(*) AS n FROM message
           WHERE json_extract(data, '$.role') = 'user' GROUP BY session_id`
        ).all()) prompts.set(r.session_id, r.n);
      } catch { /* older schema: leave counts empty */ }

      const rows = db.prepare(
        `SELECT id, parent_id, directory, title, time_created, time_updated, summary_diffs
         FROM session WHERE time_archived IS NULL`
      ).all();

      const byId = new Map(rows.map(r => [r.id, r]));
      const rootOf = r => {
        let cur = r;
        for (let i = 0; i < 20 && cur.parent_id && byId.has(cur.parent_id); i++) cur = byId.get(cur.parent_id);
        return cur;
      };

      const sessions = new Map();
      for (const r of rows) {
        const root = rootOf(r);
        let s = sessions.get(root.id);
        if (!s) {
          s = {
            id: 'oc:' + root.id,
            source: 'opencode',
            directory: root.directory,
            title: root.title,
            firstPrompt: null,
            prompts: 0,
            start: root.time_created,
            end: root.time_updated,
            files: new Set(),
            transcript: this.dbPath,
          };
          sessions.set(root.id, s);
        }
        // Sub-agent sessions fold into the session that started them.
        s.end = Math.max(s.end, r.time_updated);
        s.prompts += prompts.get(r.id) || 0;
        const base = root.directory || '';
        for (const f of [...(this.files.get(r.id) || []), ...filesFromDiffs(r.summary_diffs)]) {
          s.files.add(isAbs(f) ? f : normPath(path.join(base, f)));
        }
      }

      this.lastError = null;
      this.lastSessions = [...sessions.values()].map(s => ({ ...s, files: [...s.files] }));
      return this.lastSessions;
    } catch (e) {
      this.lastError = e.message;
      return this.lastSessions;
    } finally {
      if (db) db.close();
    }
  }
}

module.exports = { OpencodeSource, filesFromPart, filesFromDiffs };
