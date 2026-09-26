'use strict';
const fs = require('fs');
const path = require('path');

// Offline "understanding" of what you drop in: no model needed.
// The local AI (when turned on) adds a written summary on top of this.

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', 'dist', 'build', 'out', '.next', 'target', '.idea', '.vscode', '.cache']);

const LANGS = {
  '.py': 'Python', '.ipynb': 'Jupyter', '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'React',
  '.ts': 'TypeScript', '.tsx': 'React', '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS', '.md': 'Markdown',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.rs': 'Rust', '.go': 'Go', '.java': 'Java',
  '.kt': 'Kotlin', '.cs': 'C#', '.cpp': 'C++', '.cc': 'C++', '.c': 'C', '.h': 'C/C++ header', '.sh': 'Shell',
  '.ps1': 'PowerShell', '.bat': 'Batch', '.sql': 'SQL', '.php': 'PHP', '.rb': 'Ruby', '.swift': 'Swift',
  '.vue': 'Vue', '.svelte': 'Svelte', '.lua': 'Lua', '.dart': 'Dart',
};

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Names from the vault that appear in the text as whole words and are not linked yet.
function findMentions(text, names, exclude) {
  const linked = new Set([...text.matchAll(/\[\[([^\[\]|#]+)/g)].map(m => m[1].trim().toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const name of names) {
    const k = String(name).toLowerCase();
    if (k.length < 3 || seen.has(k) || linked.has(k) || (exclude && k === exclude.toLowerCase())) continue;
    const re = new RegExp('(^|[^\\p{L}\\p{N}_])' + escapeRe(name) + '(?=$|[^\\p{L}\\p{N}_])', 'iu');
    if (re.test(text)) { out.push(name); seen.add(k); }
  }
  return out;
}

function analyzeMarkdown(text, fileName, names = []) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const h1 = body.match(/^#\s+(.+)$/m);
  const title = (h1 ? h1[1] : path.basename(fileName || 'Untitled', path.extname(fileName || ''))).trim();
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(m => m[1].trim()).slice(0, 12);
  const tags = [...new Set([...body.matchAll(/(^|\s)#([\p{L}][\p{L}\p{N}_/-]{1,40})/gu)].map(m => m[2]))].slice(0, 12);
  const words = (body.match(/[\p{L}\p{N}]+/gu) || []).length;
  const firstPara = body.split(/\r?\n\s*\r?\n/).map(p => p.trim()).find(p => p && !p.startsWith('#') && !p.startsWith('```')) || '';
  const tasks = (body.match(/^\s*[-*] \[ \]/gm) || []).length;
  return {
    title,
    headings,
    tags,
    words,
    tasks,
    firstParagraph: firstPara.slice(0, 400),
    mentions: findMentions(body, names, title),
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function analyzeFolder(dir, limit = 4000) {
  const counts = new Map();
  const keyFiles = [];
  let files = 0;
  const stack = [[dir, 0]];
  while (stack.length && files < limit) {
    const [d, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < 6) stack.push([p, depth + 1]);
        continue;
      }
      files++;
      const lang = LANGS[path.extname(e.name).toLowerCase()];
      if (lang) counts.set(lang, (counts.get(lang) || 0) + 1);
      if (depth === 0 && /^(readme|package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|dockerfile|docker-compose\.ya?ml|main\.\w+|app\.\w+|index\.\w+)$/i.test(e.name)) keyFiles.push(e.name);
      if (files >= limit) break;
    }
  }

  let about = '';
  const manifest = {};
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    manifest.kind = 'Node.js';
    manifest.name = pkg.name;
    about = pkg.description || '';
    manifest.uses = Object.keys({ ...(pkg.dependencies || {}) }).slice(0, 12);
  }
  for (const f of ['pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    let text = '';
    try { text = fs.readFileSync(p, 'utf8').slice(0, 20000); } catch { continue; }
    if (f === 'requirements.txt') {
      manifest.kind = manifest.kind || 'Python';
      manifest.uses = text.split(/\r?\n/).map(l => l.trim().split(/[=<>~!\[; ]/)[0]).filter(l => l && !l.startsWith('#')).slice(0, 12);
    } else if (f === 'pyproject.toml') {
      manifest.kind = 'Python';
      const d = text.match(/^description\s*=\s*"([^"]*)"/m);
      if (d && !about) about = d[1];
    } else if (f === 'Cargo.toml') {
      manifest.kind = 'Rust';
    } else {
      manifest.kind = 'Go';
    }
  }

  let readme = '';
  const readmeName = (() => { try { return fs.readdirSync(dir).find(n => /^readme(\.md|\.txt)?$/i.test(n)); } catch { return null; } })();
  if (readmeName) {
    try { readme = fs.readFileSync(path.join(dir, readmeName), 'utf8').slice(0, 6000); } catch { /* unreadable */ }
    if (!about) {
      const para = readme.replace(/^---[\s\S]*?---/, '').split(/\r?\n\s*\r?\n/).map(p => p.trim())
        .find(p => p && !p.startsWith('#') && !p.startsWith('!') && !p.startsWith('[!') && !p.startsWith('<') && !p.startsWith('```'));
      about = (para || '').replace(/\s+/g, ' ').slice(0, 400);
    }
  }

  const languages = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, files: n }));
  return { name: path.basename(dir), files, capped: files >= limit, languages, keyFiles, manifest, about, readme };
}

module.exports = { analyzeMarkdown, analyzeFolder, findMentions };
