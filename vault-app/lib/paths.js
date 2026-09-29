'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code keeps one .jsonl transcript per session in <config>/projects/<encoded-cwd>/.
function defaultClaudeDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

// OpenCode 1.x keeps everything in one SQLite file. It follows XDG paths even on Windows,
// so ~/.local/share/opencode is the usual spot; the others are fallbacks.
function opencodeCandidates() {
  const c = [];
  if (process.env.XDG_DATA_HOME) c.push(path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
  c.push(path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'));
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) c.push(path.join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db'));
    if (process.env.APPDATA) c.push(path.join(process.env.APPDATA, 'opencode', 'opencode.db'));
  }
  if (process.platform === 'darwin') {
    c.push(path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'opencode.db'));
  }
  return c;
}

function defaultOpencodeDb() {
  const c = opencodeCandidates();
  return c.find(p => fs.existsSync(p)) || c[0];
}

function defaultVaultDir() {
  return path.join(os.homedir(), 'Documents', 'MemoryVault');
}

// Forward slashes, no trailing slash, upper-case drive letter.
function normPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

// Key used to compare paths. Windows paths compare case-insensitively.
function pathKey(p) {
  const n = normPath(p);
  return /^[A-Za-z]:\//.test(n) || n.startsWith('//') ? n.toLowerCase() : n;
}

function baseName(p) {
  const n = normPath(p);
  const i = n.lastIndexOf('/');
  return (i >= 0 ? n.slice(i + 1) : n) || n;
}

module.exports = { defaultClaudeDir, defaultOpencodeDb, defaultVaultDir, opencodeCandidates, normPath, pathKey, baseName };
