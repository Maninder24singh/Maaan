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
    if (e.target.closest('input, select, textarea') || !$('overlay').hidden) return;
    if (e.key === '+' || e.key === '=') graph.zoomBy(1.35);
    else if (e.key === '-' || e.key === '_') graph.zoomBy(1 / 1.35);
    else if (e.key === '0') graph.fit(true);
    else if (e.key === 'Escape') { graph.select(null); renderCard(null); }
  });

  $('layout').value = ui.layout;
  $('layout').addEventListener('change', e => { ui.layout = e.target.value; store.set('layout', ui.layout); graph.setLayout(ui.layout); });
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
    ['note', 'Your note'],
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
        nodes.push({ id: n.id, kind: 'note', color: 'note', label: n.title, ref: { type: 'note', item: n } });
        byTitle.set(n.title.toLowerCase(), n.id); // your own note wins a name clash
        if (n.projectId && inScope.has(n.projectId)) links.push({ source: n.projectId, target: n.id, kind: 'note' });
      }
      const ghosts = new Map();
      for (const n of notes) {
        for (const t of n.links) {
          let target = byTitle.get(t.toLowerCase());
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
      empty.innerHTML = '<div><strong>No sessions found yet</strong>Open a project in Claude Code or OpenCode and start working.<br>It shows up here within a second or two.</div>';
    } else {
      empty.hidden = true;
    }
  }

  // ---------- sidebar ----------
  const CHEVRON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

    const row = (p, depth) => {
      const kids = (childrenOf.get(p.id) || []).filter(c => !q || matches.has(c.id));
      const open = q ? true : ui.expanded.has(p.id);
      const srcs = p.sources.map(s => `<span class="src ${s}">${s === 'claude' ? 'CC' : 'OC'}</span>`).join('');
      const chev = kids.length
        ? `<button type="button" class="chev" data-toggle="${esc(p.id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} sub-projects of ${esc(p.name)}">${CHEVRON}</button>`
        : '<span></span>';
      let html = `<div class="row${ui.scope === p.id ? ' active' : ''}" data-id="${esc(p.id)}" style="--depth:${depth}" title="${esc(p.path)}" tabindex="0" role="treeitem" aria-selected="${ui.scope === p.id}">
        ${chev}<span class="swatch" style="background:var(--${depth ? 'subproject' : 'project'})"></span>
        <span class="name">${esc(p.name)}</span><span class="meta">${srcs}${totalSessions(p.id)}</span></div>`;
      if (kids.length) html += `<div class="children" ${open ? '' : 'hidden'}>${kids.map(k => row(k, depth + 1)).join('')}</div>`;
      return html;
    };

    const top = (childrenOf.get(null) || []).filter(p => !q || matches.has(p.id));
    const allRow = `<div class="row all${ui.scope === 'all' ? ' active' : ''}" data-id="all" tabindex="0" role="treeitem" aria-selected="${ui.scope === 'all'}">
      <span></span><span class="swatch" style="background:var(--ink)"></span><span class="name">All projects</span><span class="meta">${data.sessions.length}</span></div>`;
    tree.setAttribute('role', 'tree');
    tree.innerHTML = allRow + (top.length ? top.map(p => row(p, 0)).join('') : `<p class="tree-empty">${q ? 'No project matches.' : 'No projects yet.'}</p>`);
  }

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
        <div class="actions">${ui.scope !== item.id ? `<button type="button" data-scope="${esc(item.id)}">Open this project</button>` : ''}<button type="button" data-open="${esc(item.path)}">Open folder</button></div>`;
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
      html += `<div class="kind">${kindDot('note')}Your note</div>
        <h3>${esc(item.title)}</h3><div class="mono">${esc(item.file)}</div>
        ${item.links.length ? `<div>Links to:</div><ul>${item.links.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<div>No [[links]] in this note yet.</div>'}
        <div class="actions"><button type="button" data-open="${esc(item.file)}">Open note</button></div>`;
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
    const line = (label, src, extra) => `<div title="${esc(src.path)}"><span>${label}</span><span class="${src.found ? 'ok' : 'bad'}">${src.found ? extra : 'not found'}</span></div>`;
    $('sources').innerHTML =
      line('Claude Code', s.claude, `${s.claude.sessions} sessions`) +
      line('OpenCode', s.opencode, s.opencode.error ? 'read error' : `${s.opencode.sessions} sessions`) +
      `<div title="${esc(s.vault.path)}"><span>Vault notes</span><span class="${s.vault.error ? 'bad' : 'ok'}">${s.vault.error ? 'write error' : s.vault.writing ? 'writing' : 'off'}</span></div>`;
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
})();
