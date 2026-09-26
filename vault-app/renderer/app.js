/* global VaultGraph */
'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pathKey = p => {
    let s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[A-Za-z]:\//.test(s) || s.startsWith('//') ? s.toLowerCase() : s;
  };
  const baseName = p => { const s = String(p).replace(/\\/g, '/'); return s.slice(s.lastIndexOf('/') + 1) || s; };
  const firstLine = s => String(s || 'Untitled session').split(/\r?\n/)[0].trim();

  // ---------- per-viewer UI memory ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('mv:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('mv:' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const ui = {
    scope: store.get('scope', 'all'),
    expanded: new Set(store.get('expanded', [])),
    showFiles: store.get('showFiles', true),
    showNotes: store.get('showNotes', true),
    layout: store.get('layout', 'force'),
    sort: store.get('sort', 'recent'),
  };

  let data = { projects: [], sessions: [], notes: [], status: null };
  let projById = new Map();
  let childrenOf = new Map();

  // ---------- graph ----------
  const graph = new VaultGraph.Graph($('graph'), {
    onSelect: n => renderCard(n),
    onOpen: n => { if (n.ref && n.ref.type === 'project') setScope(n.id); },
    onZoom: k => { $('zoom-level').textContent = Math.round(k * 100) + '%'; },
  });

  $('zoom-in').addEventListener('click', () => graph.zoomBy(1.35));
  $('zoom-out').addEventListener('click', () => graph.zoomBy(1 / 1.35));
  $('zoom-fit').addEventListener('click', () => graph.fit(true));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('modal').hidden) { closeModal(); return; }
    if (e.target.closest('input, select, textarea') || !$('overlay').hidden || !$('modal').hidden) return;
    if (e.key === '+' || e.key === '=') graph.zoomBy(1.35);
    else if (e.key === '-' || e.key === '_') graph.zoomBy(1 / 1.35);
    else if (e.key === '0') graph.fit(true);
    else if (e.key === 'Escape') { graph.select(null); renderCard(null); }
  });

  // ---------- layouts, including the image shape ----------
  let shape = store.get('shape', null);
  if (shape) graph.shape = shape;
  if (ui.layout === 'shape' && !shape) ui.layout = 'force';

  function useLayout(name) {
    ui.layout = name;
    store.set('layout', name);
    $('layout').value = name;
    $('shape-pick').hidden = name !== 'shape';
    graph.setLayout(name);
  }

  function busy(text, isError) {
    const b = $('busy');
    b.hidden = !text;
    b.textContent = text || '';
    b.classList.toggle('error', !!isError);
  }

  let layoutBeforePick = ui.layout;
  function pickShape() {
    layoutBeforePick = ui.layout === 'shape' && !shape ? 'force' : ui.layout;
    $('shape-file').value = '';
    $('shape-file').click();
  }

  $('shape-file').addEventListener('cancel', () => { if (!shape) useLayout(layoutBeforePick); });
  $('shape-file').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) { if (!shape) useLayout(layoutBeforePick); return; }
    busy('Reading the picture… (stays on this PC)');
    try {
      const next = await window.VaultShape.fromFile(file);
      if (next.points.length < 50) throw new Error('Too few edges found. Try a sharper photo with the person in front.');
      shape = next;
      store.set('shape', shape);
      graph.shape = shape;
      useLayout('shape');
      busy(shape.segmented ? '' : 'Could not separate the person from the background, so the whole picture is used.', !shape.segmented);
      if (!shape.segmented) setTimeout(() => busy(''), 6000);
    } catch (err) {
      busy(err.message, true);
      setTimeout(() => busy(''), 6000);
      if (!shape) useLayout(layoutBeforePick);
    }
  });
  $('shape-pick').addEventListener('click', pickShape);

  $('layout').value = ui.layout;
  $('shape-pick').hidden = ui.layout !== 'shape';
  $('layout').addEventListener('change', e => {
    if (e.target.value === 'shape' && !shape) { pickShape(); return; }
    useLayout(e.target.value);
  });
  graph.layout = ui.layout;

  $('show-files').checked = ui.showFiles;
  $('show-notes').checked = ui.showNotes;
  $('show-files').addEventListener('change', e => { ui.showFiles = e.target.checked; store.set('showFiles', ui.showFiles); renderGraph(false); });
  $('show-notes').addEventListener('change', e => { ui.showNotes = e.target.checked; store.set('showNotes', ui.showNotes); renderGraph(false); });

  $('node-search').addEventListener('input', e => graph.setQuery(e.target.value));
  $('node-search').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const hits = graph.setQuery(e.target.value);
    if (hits.length) { graph.select(hits[0].id); graph.centerOn(hits[0]); renderCard(hits[0]); }
  });

  const legendItems = [
    ['project', 'Project'], ['subproject', 'Sub-project'], ['claude', 'Claude Code session'], ['opencode', 'OpenCode session'],
    ['file-code', 'Code file'], ['file-py', 'Python'], ['file-web', 'Web'], ['file-doc', 'Docs'], ['file-data', 'Config/data'],
    ['note', 'Your note'], ['clip', 'Saved from browser'],
  ];
  $('legend').innerHTML = legendItems.map(([c, l]) => `<li><i style="background:var(--${c})"></i>${l}</li>`).join('') +
    '<li><i class="ring"></i>Linked, not written yet</li>';

  // ---------- model helpers ----------
  function index() {
    projById = new Map(data.projects.map(p => [p.id, p]));
    childrenOf = new Map();
    for (const p of data.projects) {
      const k = p.parentId && projById.has(p.parentId) ? p.parentId : null;
      if (!childrenOf.has(k)) childrenOf.set(k, []);
      childrenOf.get(k).push(p);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => b.lastActive - a.lastActive || a.name.localeCompare(b.name));
  }

  function descendants(id) {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const c of childrenOf.get(out[i]) || []) out.push(c.id);
    return out;
  }

  function totalSessions(id) {
    return descendants(id).reduce((n, pid) => n + (projById.get(pid)?.sessionCount || 0), 0);
  }

  function ancestors(id) {
    const out = [];
    let cur = projById.get(id);
    for (let i = 0; cur && cur.parentId && i < 50; i++) { out.push(cur.parentId); cur = projById.get(cur.parentId); }
    return out;
  }

  // ---------- graph data for the selected project ----------
  function buildGraph() {
    const all = ui.scope === 'all' || !projById.has(ui.scope);
    const scopeIds = all ? data.projects.map(p => p.id) : descendants(ui.scope);
    const inScope = new Set(scopeIds);
    const nodes = [];
    const links = [];
    const byTitle = new Map();
    const remember = (title, id) => { const k = String(title).toLowerCase(); if (!byTitle.has(k)) byTitle.set(k, id); };

    for (const pid of scopeIds) {
      const p = projById.get(pid);
      const hasParent = !!(p.parentId && inScope.has(p.parentId));
      const kind = all ? (hasParent ? 'subproject' : 'project') : (pid === ui.scope ? 'project' : 'subproject');
      nodes.push({ id: pid, kind, color: kind, label: p.name, hasParent, ref: { type: 'project', item: p } });
      remember(p.name, pid);
      if (hasParent) links.push({ source: p.parentId, target: pid, kind: 'project-project' });
    }

    const files = new Map();
    for (const s of data.sessions) {
      if (!inScope.has(s.projectId)) continue;
      nodes.push({ id: s.id, kind: 'session', color: s.source, label: firstLine(s.title), ref: { type: 'session', item: s } });
      remember(firstLine(s.title), s.id);
      links.push({ source: s.projectId, target: s.id, kind: 'project-session' });
      if (!ui.showFiles) continue;
      for (const f of s.files) {
        const id = 'f:' + pathKey(f);
        if (!files.has(id)) {
          const name = baseName(f);
          files.set(id, { id, kind: 'file', color: VaultGraph.fileColor(name), label: name, ref: { type: 'file', item: { path: f, sessions: [] } } });
          remember(name, id);
        }
        files.get(id).ref.item.sessions.push(s);
        links.push({ source: s.id, target: id, kind: 'session-file' });
      }
    }
    nodes.push(...files.values());

    if (ui.showNotes) {
      const notes = data.notes.filter(n => (all ? true : inScope.has(n.projectId)));
      for (const n of notes) {
        nodes.push({ id: n.id, kind: 'note', color: n.kind === 'clip' ? 'clip' : 'note', label: n.title, ref: { type: 'note', item: n } });
        byTitle.set(n.title.toLowerCase(), n.id); // your own note wins a name clash
        if (n.projectId && inScope.has(n.projectId)) links.push({ source: n.projectId, target: n.id, kind: 'note' });
      }
      const ghosts = new Map();
      for (const n of notes) {
        for (const t of n.links) {
          let target = byTitle.get(t.toLowerCase());
          if (!target) {
            // A real project or note outside this view: show it instead of a "not written yet" ring.
            const outside = data.projects.find(p => p.name.toLowerCase() === t.toLowerCase()) ||
              data.notes.find(x => x.title.toLowerCase() === t.toLowerCase());
            if (outside) {
              const isProject = !!outside.path && outside.sessionCount !== undefined;
              target = outside.id;
              if (!nodes.some(x => x.id === target)) {
                nodes.push(isProject
                  ? { id: target, kind: 'subproject', color: 'subproject', label: outside.name, ref: { type: 'project', item: outside } }
                  : { id: target, kind: 'note', color: outside.kind === 'clip' ? 'clip' : 'note', label: outside.title, ref: { type: 'note', item: outside } });
              }
              byTitle.set(t.toLowerCase(), target);
            }
          }
          if (!target) {
            target = 'g:' + t.toLowerCase();
            if (!ghosts.has(target)) ghosts.set(target, { id: target, kind: 'ghost', color: 'ghost', label: t, ref: { type: 'ghost', item: { title: t, from: [] } } });
            ghosts.get(target).ref.item.from.push(n);
          }
          if (target !== n.id) links.push({ source: n.id, target, kind: 'note' });
        }
      }
      nodes.push(...ghosts.values());
    }

    // Drop duplicate edges (a note linking the same thing twice).
    const seen = new Set();
    const unique = links.filter(l => {
      const k = l.source < l.target ? l.source + '|' + l.target : l.target + '|' + l.source;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { nodes, links: unique, rootId: all ? null : ui.scope };
  }

  function renderGraph(scopeChanged) {
    graph.setData(buildGraph(), scopeChanged);
    graph.setQuery($('node-search').value);
    const sel = graph.selected;
    renderCard(sel);
    const empty = $('empty');
    if (!data.projects.length) {
      empty.hidden = false;
      empty.innerHTML = '<div><strong>Nothing here yet</strong>Start working in Claude Code or OpenCode, or drop .md files and folders here.<br>They show up within a second or two.</div>';
    } else {
      empty.hidden = true;
    }
  }

  // ---------- sidebar ----------
  const CHEVRON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const FOLDER = c => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-10.9a1 1 0 0 1-1-1z" fill="${c}" fill-opacity="0.22" stroke="${c}" stroke-width="1.2"/></svg>`;
  const ALL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="5" r="2" fill="var(--project)"/><circle cx="12" cy="4" r="1.6" fill="var(--opencode)"/><circle cx="8" cy="12" r="1.8" fill="var(--claude)"/><path d="M4 5 12 4M4 5l4 7M12 4l-4 8" stroke="#55555D" stroke-width="0.8"/></svg>';
  const SRC_LABEL = { claude: 'CC', opencode: 'OC', vault: 'MY' };
  const SRC_TITLE = { claude: 'Claude Code', opencode: 'OpenCode', vault: 'Added by you' };

  function ago(ms) {
    if (!ms) return '';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    if (m < 1440) return Math.round(m / 60) + 'h';
    if (m < 60 * 24 * 60) return Math.round(m / 1440) + 'd';
    return new Date(ms).toLocaleDateString([], { month: 'short', year: '2-digit' });
  }

  function sortList(list) {
    return [...list].sort(ui.sort === 'az'
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => b.lastActive - a.lastActive || a.name.localeCompare(b.name));
  }

  function renderTree() {
    const tree = $('tree');
    const q = $('project-filter').value.trim().toLowerCase();
    const matches = new Set();
    if (q) {
      for (const p of data.projects) {
        if (p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) {
          matches.add(p.id);
          for (const a of ancestors(p.id)) matches.add(a);
        }
      }
    }
    $('sort-btn').textContent = ui.sort === 'az' ? 'A–Z' : 'Recent';

    const row = (p, depth) => {
      const kids = sortList((childrenOf.get(p.id) || []).filter(c => !q || matches.has(c.id)));
      const open = q ? true : ui.expanded.has(p.id);
      const srcs = p.sources.map(s => `<span class="src ${s}" title="${SRC_TITLE[s] || s}">${SRC_LABEL[s] || s}</span>`).join('');
      const total = totalSessions(p.id);
      const working = Date.now() - p.lastActive < 10 * 60 * 1000 && p.sessionCount > 0;
      const chev = kids.length
        ? `<button type="button" class="chev" data-toggle="${esc(p.id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} sub-projects of ${esc(p.name)}">${CHEVRON}</button>`
        : '<span></span>';
      const sub = [kids.length ? `${kids.length} sub` : '', total ? `${total} session${total === 1 ? '' : 's'}` : '', ago(p.lastActive)].filter(Boolean).join(' · ');
      let html = `<div class="row${ui.scope === p.id ? ' active' : ''}" data-id="${esc(p.id)}" style="--depth:${depth}" title="${esc(p.path)}" tabindex="0" role="treeitem" aria-selected="${ui.scope === p.id}"${kids.length ? ` aria-expanded="${open}"` : ''}>
        ${chev}<span class="icon">${FOLDER(depth ? 'var(--subproject)' : 'var(--project)')}</span>
        <span class="text"><span class="name">${esc(p.name)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
        <span class="meta">${working ? '<span class="working" title="Worked on in the last 10 minutes"></span>' : ''}${srcs}</span></div>`;
      if (kids.length) html += `<div class="children" style="--depth:${depth}" role="group" ${open ? '' : 'hidden'}>${kids.map(k => row(k, depth + 1)).join('')}</div>`;
      return html;
    };

    const top = sortList((childrenOf.get(null) || []).filter(p => !q || matches.has(p.id)));
    const allRow = `<div class="row all${ui.scope === 'all' ? ' active' : ''}" data-id="all" tabindex="0" role="treeitem" aria-selected="${ui.scope === 'all'}">
      <span></span><span class="icon">${ALL_ICON}</span><span class="text"><span class="name">All projects</span><span class="sub">${data.projects.length} projects · ${data.sessions.length} sessions</span></span><span class="meta"></span></div>`;
    tree.setAttribute('role', 'tree');
    tree.innerHTML = allRow + (top.length ? top.map(p => row(p, 0)).join('') : `<p class="tree-empty">${q ? 'No project matches.' : 'No projects yet. Drop .md files or a folder here.'}</p>`);
  }

  $('sort-btn').addEventListener('click', () => { ui.sort = ui.sort === 'az' ? 'recent' : 'az'; store.set('sort', ui.sort); renderTree(); });

  $('tree').addEventListener('click', e => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const id = t.dataset.toggle;
      if (ui.expanded.has(id)) ui.expanded.delete(id); else ui.expanded.add(id);
      store.set('expanded', [...ui.expanded]);
      renderTree();
      return;
    }
    const r = e.target.closest('.row');
    if (r) setScope(r.dataset.id);
  });
  $('tree').addEventListener('keydown', e => {
    const r = e.target.closest('.row');
    if (!r) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setScope(r.dataset.id); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const id = r.dataset.id;
      if (e.key === 'ArrowRight') ui.expanded.add(id); else ui.expanded.delete(id);
      store.set('expanded', [...ui.expanded]);
      renderTree();
      const again = $('tree').querySelector(`.row[data-id="${CSS.escape(id)}"]`);
      if (again) again.focus();
    }
  });
  $('project-filter').addEventListener('input', renderTree);

  function setScope(id) {
    if (id !== 'all' && !projById.has(id)) id = 'all';
    const changed = id !== ui.scope;
    ui.scope = id;
    store.set('scope', id);
    for (const a of id === 'all' ? [] : ancestors(id)) ui.expanded.add(a);
    store.set('expanded', [...ui.expanded]);
    renderTree();
    renderCrumbs();
    if (changed) { graph.select(null); renderCard(null); }
    renderGraph(changed);
  }

  function renderCrumbs() {
    const p = projById.get(ui.scope);
    if (!p) {
      $('crumbs').innerHTML = `<span class="title">All projects</span><span class="path">${data.projects.length} projects · ${data.sessions.length} sessions</span>`;
      return;
    }
    const chain = [...ancestors(p.id)].reverse().map(id => projById.get(id).name);
    $('crumbs').innerHTML = `<span class="title">${esc([...chain, p.name].join(' / '))}</span><span class="path">${esc(p.path)}</span>`;
  }

  // ---------- info card ----------
  const SOURCE = { claude: 'Claude Code', opencode: 'OpenCode' };
  function when(ms) {
    if (!ms) return 'unknown time';
    const d = new Date(ms);
    const mins = Math.round((Date.now() - ms) / 60000);
    const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${rel})`;
  }
  const kindDot = c => `<i style="background:var(--${c})"></i>`;
  const jump = (id, label) => `<li><button type="button" data-jump="${esc(id)}">${esc(label)}</button></li>`;

  function renderCard(n) {
    const card = $('card');
    if (!n || !n.ref) { card.hidden = true; return; }
    const { type, item } = n.ref;
    let html = '<button type="button" class="close" data-close aria-label="Close">×</button>';

    if (type === 'project') {
      const kids = childrenOf.get(item.id) || [];
      html += `<div class="kind">${kindDot(n.color)}${n.kind === 'project' ? 'Project' : 'Sub-project'}</div>
        <h3>${esc(item.name)}</h3><div class="mono">${esc(item.path)}</div>
        <div>${item.sessionCount} session${item.sessionCount === 1 ? '' : 's'} here${kids.length ? `, ${kids.length} sub-project${kids.length === 1 ? '' : 's'}` : ''}. Last work: ${esc(when(item.lastActive))}</div>
        ${item.about ? `<blockquote>${esc(item.about)}</blockquote>` : ''}
        <div class="actions">${ui.scope !== item.id ? `<button type="button" data-scope="${esc(item.id)}">Open this project</button>` : ''}<button type="button" data-open="${esc(item.path)}">Open folder</button></div>
        <div class="actions"><button type="button" data-launch="claude" data-pid="${esc(item.id)}">Start Claude Code here</button><button type="button" data-launch="opencode" data-pid="${esc(item.id)}">Start OpenCode here</button><button type="button" data-addto="${esc(item.id)}">Add notes here</button></div>`;
    } else if (type === 'session') {
      html += `<div class="kind">${kindDot(item.source)}${SOURCE[item.source]} session</div>
        <h3>${esc(firstLine(item.title))}</h3>
        <div>${esc(when(item.end))} · ${item.prompts} prompt${item.prompts === 1 ? '' : 's'}</div>
        ${item.firstPrompt ? `<blockquote>${esc(item.firstPrompt.slice(0, 500))}</blockquote>` : ''}
        ${item.files.length ? `<div>Changed ${item.files.length} file${item.files.length === 1 ? '' : 's'}:</div><ul>${item.files.slice(0, 30).map(f => jump('f:' + pathKey(f), baseName(f))).join('')}</ul>` : '<div class="mono">No file changes yet.</div>'}
        <div class="actions"><button type="button" data-reveal="${esc(item.transcript)}">Show transcript file</button></div>`;
    } else if (type === 'file') {
      html += `<div class="kind">${kindDot(n.color)}File</div>
        <h3>${esc(baseName(item.path))}</h3><div class="mono">${esc(item.path)}</div>
        <div>Changed in ${item.sessions.length} session${item.sessions.length === 1 ? '' : 's'}:</div>
        <ul>${item.sessions.map(s => jump(s.id, firstLine(s.title))).join('')}</ul>
        <div class="actions"><button type="button" data-open="${esc(item.path)}">Open file</button><button type="button" data-reveal="${esc(item.path)}">Show in folder</button></div>`;
    } else if (type === 'note') {
      const isClip = item.kind === 'clip';
      html += `<div class="kind">${kindDot(isClip ? 'clip' : 'note')}${isClip ? 'Saved from browser' : 'Your note'}</div>
        <h3>${esc(item.title)}</h3><div class="mono">${esc(item.file)}</div>
        ${item.url ? `<div class="mono">${esc(item.url)}</div>` : ''}
        ${item.links.length ? `<div>Links to:</div><ul>${item.links.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : isClip ? '' : '<div>No [[links]] in this note yet.</div>'}
        <div class="actions"><button type="button" data-open="${esc(item.file)}">Open note</button>${item.url ? `<button type="button" data-url="${esc(item.url)}">Open page</button>` : ''}</div>`;
    } else if (type === 'ghost') {
      html += `<div class="kind"><i style="border:1.5px dashed var(--ghost)"></i>Linked, not written yet</div>
        <h3>${esc(item.title)}</h3><div>Your notes point here, but no note has this name yet.</div>
        <ul>${item.from.map(f => jump(f.id, f.title)).join('')}</ul>`;
    }
    html += '<p class="msg" id="card-msg" aria-live="polite"></p>';
    card.innerHTML = html;
    card.hidden = false;
  }

  $('card').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-close')) { graph.select(null); renderCard(null); return; }
    if (b.dataset.scope) { setScope(b.dataset.scope); return; }
    if (b.dataset.launch) {
      const r = await window.vault.launch(b.dataset.launch, b.dataset.pid);
      toast(r.ok ? `Started ${b.dataset.launch === 'claude' ? 'Claude Code' : 'OpenCode'} in ${r.value.dir}` : r.error, !r.ok);
      return;
    }
    if (b.dataset.addto) { addFilesTarget = b.dataset.addto; $('add-files-input').click(); return; }
    if (b.dataset.url) { window.open(b.dataset.url); return; }
    if (b.dataset.jump) {
      const n = graph.select(b.dataset.jump);
      if (n) { graph.centerOn(n); renderCard(n); }
      return;
    }
    const err = b.dataset.open ? await window.vault.open(b.dataset.open)
      : b.dataset.reveal ? await window.vault.reveal(b.dataset.reveal) : null;
    const msg = $('card-msg');
    if (msg) msg.textContent = err || '';
  });

  // ---------- status ----------
  function renderStatus() {
    const s = data.status;
    if (!s) return;
    const live = $('live');
    live.title = 'Watching Claude Code and OpenCode. Last change: ' + new Date(s.updated).toLocaleString();
    live.classList.add('on');
    live.classList.remove('pulse'); void live.offsetWidth; live.classList.add('pulse');
    $('live-text').textContent = 'Live ' + new Date(s.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    renderConnections();
  }

  function apply(next, first) {
    const hadScope = ui.scope;
    data = next;
    index();
    if (ui.scope !== 'all' && !projById.has(ui.scope)) ui.scope = 'all';
    renderTree();
    renderCrumbs();
    renderStatus();
    renderGraph(first || hadScope !== ui.scope);
  }

  // ---------- toasts ----------
  function toast(text, isError) {
    const t = document.createElement('div');
    t.className = 'toast';
    if (isError) t.style.color = '#FF9A9A';
    t.textContent = text;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), isError ? 7000 : 4000);
  }

  // ---------- modal ----------
  let modalReturnFocus = null;
  function openModal(html, onClick) {
    modalReturnFocus = document.activeElement;
    const body = $('modal-body');
    body.innerHTML = html + '<button type="button" class="close-x" data-close aria-label="Close" style="position:absolute;top:10px;right:12px;background:none;border:0;color:var(--muted);font-size:18px;cursor:pointer">×</button>';
    body.style.position = 'relative';
    body.onclick = async e => {
      if (e.target.closest('[data-close]')) { closeModal(); return; }
      if (onClick) await onClick(e);
    };
    $('modal').hidden = false;
    const first = body.querySelector('input, select, textarea, button.primary, button');
    if (first) first.focus();
  }
  function closeModal() {
    $('modal').hidden = true;
    $('modal-body').innerHTML = '';
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  }
  $('modal').addEventListener('mousedown', e => { if (e.target === $('modal')) closeModal(); });

  // ---------- connections ----------
  let conn = null;
  async function renderConnections() {
    const r = await window.vault.connections();
    if (!r.ok) return;
    conn = r.value;
    const c = conn;
    const items = [
      ['claude', 'Claude Code', c.claude.found ? 'on' : c.claude.installed ? 'warn' : '', c.claude.found ? `${c.claude.sessions} sessions` : c.claude.installed ? 'no sessions yet' : 'not found'],
      ['opencode', 'OpenCode', c.opencode.found ? 'on' : c.opencode.installed ? 'warn' : '', c.opencode.found ? `${c.opencode.sessions} sessions` : c.opencode.installed ? 'no sessions yet' : 'not found'],
      ['clipper', 'Browser', c.clipper.running ? 'on' : c.clipper.error ? 'warn' : '', c.clipper.running ? 'on' : c.clipper.error ? 'error' : 'off'],
      ['hotkey', 'Clipboard key', c.hotkey.registered ? 'on' : c.hotkey.enabled ? 'warn' : '', c.hotkey.registered ? 'Ctrl+Shift+M' : c.hotkey.enabled ? 'key busy' : 'off'],
      ['ai', 'Local AI', c.ai.enabled && c.ai.hasModel ? 'on' : c.ai.enabled ? 'warn' : '', c.ai.enabled ? (c.ai.hasModel ? c.ai.model : c.ai.running ? 'model missing' : 'Ollama off') : 'off'],
    ];
    $('conns').innerHTML = items.map(([id, label, dot, state]) =>
      `<li><button type="button" class="conn" data-conn="${id}"><span class="dot ${dot}"></span><span class="label">${label}</span><span class="state${state === 'off' ? ' off' : ''}">${esc(state)}</span></button></li>`).join('');
    $('model-tag').textContent = c.ai.enabled ? c.ai.model : '';
  }

  const projectOptions = (selected, withNone) => (withNone ? `<option value="">${withNone}</option>` : '') +
    sortList(data.projects).map(p => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('');

  async function setFeature(name, patch) {
    const r = await window.vault.setFeature(name, patch);
    if (!r.ok) { toast(r.error, true); return null; }
    conn = r.value;
    renderConnections();
    return r.value;
  }

  function toolModal(tool) {
    const t = conn[tool];
    const label = tool === 'claude' ? 'Claude Code' : 'OpenCode';
    const scopeId = projById.has(ui.scope) ? ui.scope : '';
    openModal(`
      <h1>${label}</h1>
      <p class="lead">${t.found
        ? `Connected. Every ${label} session shows up here by itself, whatever folder you start it in. Nothing to install.`
        : `No ${label} sessions found yet. Once you use ${label}, sessions show up here by themselves.`}</p>
      <ul class="plain">
        <li>Program: ${t.installed ? `<code>${esc(t.installed)}</code>` : 'not found on PATH'}</li>
        <li>Reads (never changes): <code>${esc(t.path)}</code></li>
        <li>Sessions found: ${t.sessions}</li>
      </ul>
      <h2>Start ${label} in a project</h2>
      <div class="grid2"><select id="launch-project">${projectOptions(scopeId)}</select></div>
      <div class="actions"><button type="button" class="primary" data-go>Open terminal with ${label}</button></div>
      <p class="warn">This opens a new terminal window in the project folder and runs <code>${tool}</code>.</p>`,
    async e => {
      if (!e.target.closest('[data-go]')) return;
      const r = await window.vault.launch(tool, $('launch-project').value);
      if (r.ok) { toast(`Started ${label} in ${r.value.dir}`); closeModal(); } else toast(r.error, true);
    });
  }

  function clipperModal() {
    const c = conn.clipper;
    if (!c.enabled) {
      openModal(`
        <h1>Save from your browser</h1>
        <p class="lead">Right-click any page or selected text and pick <b>Save to Memory Vault</b>. It lands in your vault as a note, with the link.</p>
        <h2>What turning this on does</h2>
        <ul class="plain">
          <li>Starts a small server at <code>127.0.0.1:${c.port}</code>. Only this PC can reach it.</li>
          <li>Only the Memory Vault browser extension with your private key can save. Websites cannot.</li>
          <li>The app never reads your browsing. It only gets what you choose to save.</li>
        </ul>
        <div class="actions"><button type="button" class="primary" data-on>Turn on</button><button type="button" data-close>Not now</button></div>`,
      async e => { if (e.target.closest('[data-on]')) { await setFeature('clipper', { enabled: true }); clipperModal(); } });
      return;
    }
    openModal(`
      <h1>Save from your browser</h1>
      <p class="lead">${c.running ? `On. Listening at <code>127.0.0.1:${c.port}</code>.` : `<span class="warn">${esc(c.error || 'Not running.')}</span>`}</p>
      <h2>Your key</h2>
      <div class="keyline"><span class="key" id="key-text">${'•'.repeat(12)}</span><button type="button" data-show>Show</button><button type="button" data-copy>Copy</button></div>
      <h2>Install the extension (once)</h2>
      <ul class="plain">
        <li>Open <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>).</li>
        <li>Turn on <b>Developer mode</b> (top right).</li>
        <li>Click <b>Load unpacked</b> and pick the extension folder: <button type="button" data-ext>Show extension folder</button></li>
        <li>Click the extension icon, paste the key, press Connect.</li>
      </ul>
      <p class="lead">Then: right-click → <b>Save to Memory Vault</b>, or press <b>Alt+Shift+S</b> on any page.</p>
      <div class="actions"><button type="button" data-newkey>Make a new key</button><button type="button" data-off>Turn off</button></div>`,
    async e => {
      if (e.target.closest('[data-show]')) $('key-text').textContent = c.token;
      if (e.target.closest('[data-copy]')) { await window.vault.copy(c.token); toast('Key copied'); }
      if (e.target.closest('[data-ext]')) { const r = await window.vault.showExtension(); if (r.ok) toast('Opened ' + r.value); }
      if (e.target.closest('[data-newkey]')) { await setFeature('clipper', { newToken: true }); toast('New key made. Paste it into the extension again.'); clipperModal(); }
      if (e.target.closest('[data-off]')) { await setFeature('clipper', { enabled: false }); closeModal(); toast('Browser connection turned off'); }
    });
  }

  function hotkeyModal() {
    const c = conn.hotkey;
    openModal(`
      <h1>Clipboard key</h1>
      <p class="lead">Copy anything (text or a link) in any app, then press <b>Ctrl+Shift+M</b>. It is saved to your vault Inbox right away.</p>
      <h2>What turning this on does</h2>
      <ul class="plain">
        <li>Adds the shortcut Ctrl+Shift+M for the whole PC while the app is open.</li>
        <li>Reads your clipboard only at the moment you press it. Never in the background.</li>
      </ul>
      ${c.enabled && !c.registered ? '<p class="warn">Another app already uses Ctrl+Shift+M, so this key could not be added.</p>' : ''}
      <div class="actions">${c.enabled ? '<button type="button" data-off>Turn off</button>' : '<button type="button" class="primary" data-on>Turn on</button><button type="button" data-close>Not now</button>'}</div>`,
    async e => {
      if (e.target.closest('[data-on]')) { await setFeature('hotkey', { enabled: true }); closeModal(); toast(conn.hotkey.registered ? 'Ctrl+Shift+M now saves your clipboard' : 'That key is taken by another app', !conn.hotkey.registered); }
      if (e.target.closest('[data-off]')) { await setFeature('hotkey', { enabled: false }); closeModal(); }
    });
  }

  function aiModal() {
    const c = conn.ai;
    const state = !c.enabled ? '' : !c.running
      ? '<p class="warn">Ollama is not running. Install it, then it starts by itself.</p>'
      : !c.hasModel ? `<p class="warn">Ollama is running but <code>${esc(c.model)}</code> is not downloaded yet. Run the pull command below.</p>`
      : `<p class="lead" style="color:var(--live)">Ready: ${esc(c.model)} on this PC.</p>`;
    openModal(`
      <h1>Local AI</h1>
      <p class="lead">A small model running on your laptop through Ollama. It can search your vault, find and open apps and files, open web pages, save notes, and write summaries of files you drop in. Nothing goes to the internet.</p>
      ${state}
      <h2>Setup (once)</h2>
      <ul class="plain">
        <li>Install Ollama: <code>winget install Ollama.Ollama</code></li>
        <li>Download the model: <code>ollama pull ${esc(c.model)}</code></li>
      </ul>
      <h2>Model</h2>
      <div class="grid2">
        <input type="text" id="ai-model" value="${esc(c.model)}" aria-label="Model name">
        <p class="warn"><code>qwen2.5:3b</code> (Q4_K_M) uses about 2.5 GB of VRAM (with an 8K context). It fits next to faster-whisper small (about 1 GB) on your 8 GB RTX 4060. <code>qwen2.5:7b</code> uses about 5.5 GB. Only use it when your voice agent is off. The model unloads 5 minutes after the last question.</p>
        ${c.models && c.models.length ? `<p class="lead">Downloaded: ${c.models.map(m => `<code>${esc(m)}</code>`).join(' ')}</p>` : ''}
      </div>
      <h2>Safety</h2>
      <ul class="plain">
        <li>Searching is automatic. <b>Opening</b> an app, file or web page always waits for your click.</li>
        <li>It can only open things its own search found, so it cannot make up a path and run it.</li>
      </ul>
      <label class="check big"><input type="checkbox" id="ai-summ" ${c.summarizeImports ? 'checked' : ''}> Write a short summary into notes and folders I drop in</label>
      <div class="actions">${c.enabled
        ? '<button type="button" class="primary" data-save>Save</button><button type="button" data-off>Turn off</button>'
        : '<button type="button" class="primary" data-on>Turn on</button><button type="button" data-close>Not now</button>'}</div>`,
    async e => {
      const model = () => $('ai-model').value.trim() || 'qwen2.5:3b';
      if (e.target.closest('[data-on]') || e.target.closest('[data-save]')) {
        await setFeature('ai', { enabled: true, model: model(), summarizeImports: $('ai-summ').checked });
        aiModal();
      }
      if (e.target.closest('[data-off]')) { await setFeature('ai', { enabled: false }); closeModal(); }
    });
  }

  $('conns').addEventListener('click', e => {
    const b = e.target.closest('[data-conn]');
    if (!b || !conn) return;
    const id = b.dataset.conn;
    if (id === 'claude' || id === 'opencode') toolModal(id);
    else if (id === 'clipper') clipperModal();
    else if (id === 'hotkey') hotkeyModal();
    else if (id === 'ai') aiModal();
  });

  // ---------- adding projects: drag and drop, Add files, New project ----------
  let addFilesTarget = null;

  async function importPaths(paths, targetId) {
    if (!paths.length) { toast('Nothing to add. Drop .md files or folders.', true); return; }
    const r = await window.vault.importPaths(paths, targetId);
    if (!r.ok) { toast(r.error, true); return; }
    const target = targetId ? projById.get(targetId) : null;
    const lines = r.value.map(x => {
      if (!x.ok) return `<div class="bad">✗ ${esc(x.name)}: ${esc(x.error)}</div>`;
      if (x.kind === 'folder') {
        const langs = x.languages.map(l => `${l.name} (${l.files})`).join(', ');
        return `<div>✓ Folder <b>${esc(x.name)}</b> is now a project${target ? ` inside ${esc(target.name)}` : ''}.<br>${langs ? `Mostly ${esc(langs)}. ` : ''}${x.about ? esc(x.about) : 'No README description found.'}</div>`;
      }
      return `<div>✓ <b>${esc(x.name)}</b> → project <b>${esc(x.rel.join(' / '))}</b>. Title: “${esc(x.title)}”.${x.headings.length ? ` Sections: ${esc(x.headings.slice(0, 5).join(', '))}.` : ''}${x.mentions.length ? ` Linked to ${x.mentions.map(m => `[[${esc(m)}]]`).join(', ')}.` : ''}</div>`;
    }).join('');
    const aiNote = conn && conn.ai.enabled && conn.ai.summarizeImports ? '<p class="lead">The local AI is writing a short summary into each one now.</p>' : '';
    openModal(`<h1>Added to your vault</h1><div class="result">${lines}</div>${aiNote}<div class="actions"><button type="button" class="primary" data-close>Done</button></div>`);
  }

  const droppedPaths = e => [...(e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [])].map(f => { try { return window.vault.pathForFile(f); } catch { return ''; } }).filter(Boolean);
  const isFileDrag = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
  document.addEventListener('drop', e => { if (isFileDrag(e)) e.preventDefault(); });

  // Sidebar: drop on a project row adds into it, anywhere else makes new projects.
  const sidebar = $('sidebar');
  let rowTarget = null;
  sidebar.addEventListener('dragover', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const row = e.target.closest('.row');
    const id = row && row.dataset.id !== 'all' ? row.dataset.id : null;
    if (rowTarget !== id) {
      sidebar.querySelectorAll('.drop-target').forEach(r => r.classList.remove('drop-target'));
      if (row && id) row.classList.add('drop-target');
      rowTarget = id;
    }
    $('tree').classList.toggle('drop-all', !id);
    $('drop-hint').textContent = id ? `Drop to add into ${projById.get(id).name}` : 'Drop to add as new projects';
  });
  const clearSidebarDrop = () => {
    sidebar.querySelectorAll('.drop-target').forEach(r => r.classList.remove('drop-target'));
    $('tree').classList.remove('drop-all');
    $('drop-hint').textContent = 'Drop .md files or folders here to add projects';
    rowTarget = null;
  };
  sidebar.addEventListener('dragleave', e => { if (!sidebar.contains(e.relatedTarget)) clearSidebarDrop(); });
  sidebar.addEventListener('drop', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const target = rowTarget;
    clearSidebarDrop();
    importPaths(droppedPaths(e), target);
  });

  // Canvas: drop adds into the project on screen, or as new projects on "All projects".
  const wrap = $('canvas-wrap');
  let veilDepth = 0;
  wrap.addEventListener('dragenter', e => {
    if (!isFileDrag(e)) return;
    veilDepth++;
    const p = projById.get(ui.scope);
    $('drop-veil-text').textContent = p ? `Drop to add into ${p.name}` : 'Drop to add as new projects';
    $('drop-veil').hidden = false;
  });
  wrap.addEventListener('dragleave', () => { veilDepth = Math.max(0, veilDepth - 1); if (!veilDepth) $('drop-veil').hidden = true; });
  wrap.addEventListener('drop', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    veilDepth = 0;
    $('drop-veil').hidden = true;
    importPaths(droppedPaths(e), projById.has(ui.scope) ? ui.scope : null);
  });

  $('add-files').addEventListener('click', () => { addFilesTarget = null; $('add-files-input').click(); });
  $('add-files-input').addEventListener('change', e => {
    const paths = [...e.target.files].map(f => window.vault.pathForFile(f)).filter(Boolean);
    e.target.value = '';
    importPaths(paths, addFilesTarget);
    addFilesTarget = null;
  });

  $('new-project').addEventListener('click', () => {
    let folder = null;
    openModal(`
      <h1>New project</h1>
      <div class="grid2">
        <label class="field-label" for="np-name">Name</label>
        <input type="text" id="np-name" placeholder="Garden robot">
        <label class="field-label" for="np-parent">Inside</label>
        <select id="np-parent">${projectOptions(projById.has(ui.scope) ? ui.scope : '', 'Nothing (top level)')}</select>
        <label class="field-label">Folder on this PC (optional)</label>
        <div class="keyline"><span class="key" id="np-folder">None. The project lives only in the vault.</span><button type="button" data-pickdir>Choose…</button></div>
      </div>
      <p class="lead">Tip: you can also drag .md files or folders onto the sidebar.</p>
      <div class="actions"><button type="button" class="primary" data-create>Create</button><button type="button" data-close>Cancel</button></div>
      <p class="msg" id="np-msg"></p>`,
    async e => {
      if (e.target.closest('[data-pickdir]')) {
        const p = await window.vault.pick('dir');
        if (p) { folder = p; $('np-folder').textContent = p; if (!$('np-name').value) $('np-name').value = baseName(p); }
      }
      if (e.target.closest('[data-create]')) {
        const name = $('np-name').value.trim();
        const parentId = $('np-parent').value || null;
        if (!name && !folder) { $('np-msg').textContent = 'Give the project a name.'; return; }
        if (folder) { closeModal(); importPaths([folder], parentId); return; }
        const r = await window.vault.newProject({ name, parentId });
        if (!r.ok) { $('np-msg').textContent = r.error; return; }
        closeModal();
        toast(`Created ${name}. Drop notes onto it in the sidebar.`);
      }
    });
    $('np-name').focus();
  });

  // ---------- Ask AI drawer ----------
  const STEP_TEXT = {
    search_vault: a => `Searched vault: ${a.query}`, find_app: a => `Looked for app: ${a.name}`, find_file: a => `Looked for file: ${a.name}`,
    list_projects: () => 'Listed projects', save_note: a => `Saved note: ${a.title}`,
    open_app: () => 'Asked to open an app', open_path: () => 'Asked to open a file', open_url: () => 'Asked to open a page',
  };
  function chatAdd(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    $('chat').appendChild(d);
    $('chat').scrollTop = $('chat').scrollHeight;
    return d;
  }
  function chatIntro() {
    const on = conn && conn.ai.enabled;
    $('chat').innerHTML = `<div class="chat-empty">${on
      ? 'Ask about your work or tell it what to do.<br><b>open spotify</b> · <b>find my resume pdf</b> · <b>what did I change in voice-agent?</b> · <b>save a note: buy a USB mic</b><br>Opening anything always waits for your click.'
      : 'Local AI is off. It runs on your laptop through Ollama, nothing goes online.<br><br><button type="button" class="primary-sm" style="padding:6px 12px" data-ai-setup>Set up Local AI</button>'}</div>`;
  }
  function toggleDrawer(open) {
    const d = $('drawer');
    d.hidden = !open;
    $('ask-toggle').setAttribute('aria-expanded', String(open));
    if (open) { if (!$('chat').children.length) chatIntro(); $('chat-input').focus(); }
  }
  $('ask-toggle').addEventListener('click', () => toggleDrawer($('drawer').hidden));
  $('drawer-close').addEventListener('click', () => toggleDrawer(false));
  $('chat-reset').addEventListener('click', async () => { await window.vault.resetChat(); chatIntro(); });
  $('chat').addEventListener('click', async e => {
    if (e.target.closest('[data-ai-setup]')) { aiModal(); return; }
    const b = e.target.closest('[data-approve], [data-skip]');
    if (!b) return;
    const card = b.closest('.action');
    card.classList.add('done');
    card.querySelectorAll('button').forEach(x => { x.disabled = true; });
    if (b.dataset.skip) { card.querySelector('.what').textContent += ' (skipped)'; return; }
    const r = await window.vault.approve(b.dataset.approve);
    chatAdd(r.ok ? 'msg-a' : 'msg-a error', r.ok ? r.value : r.error);
  });
  $('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chat-form').requestSubmit(); }
  });
  $('chat-form').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    const intro = $('chat').querySelector('.chat-empty');
    if (intro) intro.remove();
    $('chat-input').value = '';
    chatAdd('msg-u', text);
    const wait = chatAdd('msg-a thinking', 'Thinking…');
    $('chat-send').disabled = true;
    const r = await window.vault.ask(text);
    $('chat-send').disabled = false;
    wait.remove();
    if (!r.ok) { chatAdd('msg-a error', r.error); return; }
    if (r.value.steps.length) {
      const st = document.createElement('div');
      st.className = 'steps';
      st.innerHTML = r.value.steps.map(x => `<span class="step">${esc((STEP_TEXT[x.tool] || (() => x.tool))(x.args || {}))}</span>`).join('');
      $('chat').appendChild(st);
    }
    chatAdd('msg-a', r.value.reply);
    for (const a of r.value.actions) {
      const card = document.createElement('div');
      card.className = 'action';
      card.innerHTML = `<div class="what">${esc(a.label)}</div><div class="row-btns"><button type="button" class="primary-sm" style="padding:5px 12px" data-approve="${esc(a.id)}">Open</button><button type="button" class="ghost-sm" data-skip="1">Skip</button></div>`;
      $('chat').appendChild(card);
    }
    $('chat').scrollTop = $('chat').scrollHeight;
    if (r.value.steps.some(x => x.tool === 'save_note')) window.vault.refresh();
  });

  // ---------- permission screen ----------
  const fields = { claudeDir: 'claude-dir', opencodeDb: 'opencode-db', vaultDir: 'vault-dir' };
  let consented = false;

  async function showFound() {
    const found = await window.vault.checkPaths(readForm());
    for (const [k, id] of Object.entries(fields)) {
      const el = $(id + '-found');
      el.textContent = found[k] ? 'Found' : k === 'vaultDir' ? 'Will be created' : 'Not found yet (fine if you do not use this tool)';
      el.className = 'found' + (found[k] ? ' ok' : '');
    }
  }
  function readForm() {
    return { claudeDir: $('claude-dir').value.trim(), opencodeDb: $('opencode-db').value.trim(), vaultDir: $('vault-dir').value.trim(), writeNotes: $('write-notes').checked };
  }
  function openSettings(settings) {
    $('claude-dir').value = settings.claudeDir;
    $('opencode-db').value = settings.opencodeDb;
    $('vault-dir').value = settings.vaultDir;
    $('write-notes').checked = !!settings.writeNotes;
    $('allow').textContent = consented ? 'Save' : 'Allow and start';
    $('cancel-settings').hidden = !consented;
    $('consent-msg').textContent = '';
    $('overlay').hidden = false;
    showFound();
    $('allow').focus();
  }
  let settingsCache = null;
  for (const id of Object.values(fields)) $(id).addEventListener('change', showFound);
  $('consent').addEventListener('click', async e => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const p = await window.vault.pick(b.dataset.kind);
    if (p) { $(b.dataset.pick).value = p; showFound(); }
  });
  $('consent').addEventListener('submit', async e => {
    e.preventDefault();
    const f = readForm();
    if (!f.vaultDir) { $('consent-msg').textContent = 'Pick a vault folder first.'; return; }
    $('allow').disabled = true;
    try {
      const res = await window.vault.saveSettings(f);
      consented = true;
      settingsCache = res.settings;
      $('overlay').hidden = true;
      apply(res.data, true);
      renderConnections();
    } catch (err) {
      $('consent-msg').textContent = 'Could not start: ' + err.message;
    } finally {
      $('allow').disabled = false;
    }
  });
  $('cancel-settings').addEventListener('click', () => { $('overlay').hidden = true; });
  $('open-settings').addEventListener('click', () => openSettings(settingsCache));

  // ---------- boot ----------
  window.vault.onData(d => { if (consented) apply(d, false); });
  window.vault.init().then(res => {
    settingsCache = res.settings;
    consented = !!res.settings.consented;
    if (!consented) { openSettings(res.settings); return; }
    apply(res.data, true);
  });
  window.vault.onToast(t => toast(t));
  setInterval(() => { if (consented) renderConnections(); }, 20000);
})();
