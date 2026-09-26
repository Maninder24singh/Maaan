'use strict';
const { normPath, pathKey, baseName } = require('./paths');

// Turns a flat list of sessions into projects. A project is a working directory;
// a project whose folder sits inside another project's folder becomes its sub-project.
function buildModel(sessions) {
  const projects = new Map();

  for (const s of sessions) {
    if (!s.directory) continue;
    const key = pathKey(s.directory);
    let p = projects.get(key);
    if (!p) {
      p = { id: 'p:' + key, key, path: normPath(s.directory), sessionIds: [], sources: new Set(), lastActive: 0, parentId: null };
      projects.set(key, p);
    }
    p.sessionIds.push(s.id);
    p.sources.add(s.source);
    p.lastActive = Math.max(p.lastActive, s.end || 0);
    s.projectId = p.id;
  }

  // Nearest enclosing project folder is the parent. The filesystem root is never a parent.
  const list = [...projects.values()];
  for (const p of list) {
    let best = null;
    for (const q of list) {
      if (q === p || q.key === '/' || /^[a-z]:$/.test(q.key)) continue;
      if (p.key.startsWith(q.key + '/') && (!best || q.key.length > best.key.length)) best = q;
    }
    p.parentId = best ? best.id : null;
  }

  // Folder name, plus the parent folder when two projects share a name.
  const byName = new Map();
  for (const p of list) {
    const n = baseName(p.path) || p.path;
    if (!byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), []);
    byName.get(n.toLowerCase()).push(p);
  }
  for (const group of byName.values()) {
    for (const p of group) {
      const n = baseName(p.path) || p.path;
      if (group.length === 1) { p.name = n; continue; }
      const parts = p.path.split('/').filter(Boolean);
      p.name = parts.length > 1 ? `${n} (${parts[parts.length - 2]})` : n;
    }
  }

  // A parent counts as active whenever any sub-project is.
  const byId = new Map(list.map(p => [p.id, p]));
  for (const p of list) {
    let cur = p;
    for (let i = 0; i < 50 && cur.parentId; i++) {
      const parent = byId.get(cur.parentId);
      parent.lastActive = Math.max(parent.lastActive, p.lastActive);
      cur = parent;
    }
  }

  return {
    projects: list.map(p => ({
      id: p.id,
      name: p.name,
      path: p.path,
      parentId: p.parentId,
      sources: [...p.sources].sort(),
      sessionCount: p.sessionIds.length,
      lastActive: p.lastActive,
    })),
    sessions: sessions.filter(s => s.projectId),
  };
}

module.exports = { buildModel };
