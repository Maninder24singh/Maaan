/* global d3 */
'use strict';

// Canvas graph: pan anywhere, wheel/pinch zoom, drag dots, three layouts.
(function () {
  const css = getComputedStyle(document.documentElement);
  const C = name => css.getPropertyValue('--' + name).trim();
  const COLOR = {
    project: C('project'), subproject: C('subproject'), claude: C('claude'), opencode: C('opencode'),
    'file-code': C('file-code'), 'file-py': C('file-py'), 'file-web': C('file-web'),
    'file-doc': C('file-doc'), 'file-data': C('file-data'), note: C('note'), ghost: C('ghost'),
    focus: C('focus'), ink: C('ink'), muted: C('muted'),
  };

  function fileColor(name) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    if (['py', 'ipynb', 'pyi'].includes(ext)) return 'file-py';
    if (['html', 'htm', 'css', 'scss', 'vue', 'svelte', 'jsx', 'tsx'].includes(ext)) return 'file-web';
    if (['md', 'mdx', 'txt', 'rst'].includes(ext)) return 'file-doc';
    if (['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'xml', 'csv', 'cfg'].includes(ext)) return 'file-data';
    return 'file-code';
  }

  const LINK_DISTANCE = { 'project-project': 140, 'project-session': 80, 'session-file': 45, note: 60 };

  class Graph {
    constructor(canvas, handlers) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.handlers = handlers;
      this.nodes = [];
      this.links = [];
      this.byId = new Map();
      this.rootId = null;
      this.layout = 'force';
      this.selected = null;
      this.hovered = null;
      this.query = '';
      this.transform = d3.zoomIdentity;
      this.W = 0; this.H = 0; this.dpr = 1;
      this.needFit = true;
      this.anim = null;

      this.sim = d3.forceSimulation()
        .force('link', d3.forceLink().id(d => d.id)
          .distance(l => LINK_DISTANCE[l.kind] || 60)
          .strength(l => (l.kind === 'session-file' ? 0.7 : 0.4)))
        .force('charge', d3.forceManyBody().strength(d => (d.kind === 'file' ? -60 : -260)).distanceMax(900))
        .force('x', d3.forceX(0).strength(0.03))
        .force('y', d3.forceY(0).strength(0.03))
        .force('collide', d3.forceCollide().radius(d => d.r + 4))
        .alphaDecay(0.03)
        .on('tick', () => {
          if (this.needFit && this.sim.alpha() < 0.25) { this.needFit = false; this.fit(false); }
          this.draw();
        })
        .stop();

      this.zoom = d3.zoom()
        .scaleExtent([0.05, 8])
        .on('zoom', e => {
          this.transform = e.transform;
          if (this.handlers.onZoom) this.handlers.onZoom(e.transform.k);
          this.draw();
        });

      this.bindPointer();
      new ResizeObserver(() => this.resize()).observe(canvas);
    }

    // ---------- data ----------
    setData({ nodes, links, rootId }, scopeChanged) {
      const old = this.byId;
      this.byId = new Map();
      for (const n of nodes) {
        const prev = old.get(n.id);
        if (prev) {
          Object.assign(prev, n);
          this.byId.set(n.id, prev);
        } else {
          this.byId.set(n.id, n);
        }
      }
      this.nodes = [...this.byId.values()];
      this.links = links.filter(l => this.byId.has(l.source) && this.byId.has(l.target));
      this.rootId = rootId;

      // Degree drives dot size; neighbours drive hover highlight.
      for (const n of this.nodes) { n.deg = 0; n.nbrs = new Set(); }
      for (const l of this.links) {
        const a = this.byId.get(l.source), b = this.byId.get(l.target);
        a.deg++; b.deg++; a.nbrs.add(b.id); b.nbrs.add(a.id);
      }
      for (const n of this.nodes) n.r = radius(n);

      // New dots start next to something they connect to, so live updates grow in place.
      const placed = n => typeof n.x === 'number' && !Number.isNaN(n.x);
      for (const n of this.nodes) {
        if (placed(n)) continue;
        const anchor = [...n.nbrs].map(id => this.byId.get(id)).find(placed);
        const a = anchor || { x: 0, y: 0 };
        n.x = a.x + (Math.random() - 0.5) * 60;
        n.y = a.y + (Math.random() - 0.5) * 60;
      }

      if (this.selected && !this.byId.has(this.selected.id)) this.selected = null;
      if (this.hovered && !this.byId.has(this.hovered.id)) this.hovered = null;
      if (scopeChanged) this.needFit = true;

      this.sim.nodes(this.nodes);
      this.sim.force('link').links(this.links.map(l => ({ ...l })));
      this.applyLayout(scopeChanged ? 1 : 0.35);
    }

    setLayout(name) {
      this.layout = name;
      this.needFit = true;
      this.applyLayout(1);
    }

    applyLayout(heat) {
      if (this.anim) { this.anim.stop(); this.anim = null; }
      if (this.layout === 'force') {
        for (const n of this.nodes) { n.fx = null; n.fy = null; }
        this.sim.alpha(Math.max(this.sim.alpha(), heat)).restart();
        return;
      }
      this.sim.stop();
      const targets = staticLayout(this.layout, this.nodes, this.links, this.rootId);
      const from = new Map(this.nodes.map(n => [n.id, [n.x, n.y]]));
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const done = () => { if (this.needFit) { this.needFit = false; this.fit(true); } };
      if (reduce) {
        for (const n of this.nodes) { const t = targets.get(n.id); n.x = t[0]; n.y = t[1]; }
        this.draw(); done();
        return;
      }
      this.anim = d3.timer(elapsed => {
        const k = d3.easeCubicInOut(Math.min(1, elapsed / 650));
        for (const n of this.nodes) {
          const f = from.get(n.id), t = targets.get(n.id);
          n.x = f[0] + (t[0] - f[0]) * k;
          n.y = f[1] + (t[1] - f[1]) * k;
        }
        this.draw();
        if (k >= 1) { this.anim.stop(); this.anim = null; done(); }
      });
    }

    // ---------- view ----------
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.W = r.width; this.H = r.height;
      this.canvas.width = Math.round(this.W * this.dpr);
      this.canvas.height = Math.round(this.H * this.dpr);
      if (!this.sized && this.W > 0) {
        this.sized = true;
        d3.select(this.canvas).call(this.zoom.transform, d3.zoomIdentity.translate(this.W / 2, this.H / 2));
      }
      this.draw();
    }

    zoomBy(factor) {
      d3.select(this.canvas).transition().duration(180).call(this.zoom.scaleBy, factor);
    }

    fit(animate = true) {
      if (!this.nodes.length || !this.W) return;
      const xs = this.nodes.map(n => n.x), ys = this.nodes.map(n => n.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const pad = 70;
      const k = Math.max(0.05, Math.min(2, (this.W - pad * 2) / Math.max(1, x1 - x0), (this.H - pad * 2) / Math.max(1, y1 - y0)));
      const t = d3.zoomIdentity.translate(this.W / 2, this.H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      const sel = d3.select(this.canvas);
      (animate ? sel.transition().duration(350) : sel).call(this.zoom.transform, t);
    }

    centerOn(n) {
      if (!n) return;
      const k = Math.max(this.transform.k, 0.9);
      const t = d3.zoomIdentity.translate(this.W / 2, this.H / 2).scale(k).translate(-n.x, -n.y);
      d3.select(this.canvas).transition().duration(350).call(this.zoom.transform, t);
    }

    select(id) {
      this.selected = id ? this.byId.get(id) || null : null;
      this.draw();
      return this.selected;
    }

    setQuery(q) {
      this.query = q.trim().toLowerCase();
      this.draw();
      return this.query ? this.nodes.filter(n => n.label.toLowerCase().includes(this.query)) : [];
    }

    // ---------- input ----------
    nodeAt(px, py) {
      const [x, y] = this.transform.invert([px, py]);
      let best = null, bestD = Infinity;
      for (const n of this.nodes) {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < n.r + 5 / this.transform.k && d < bestD) { best = n; bestD = d; }
      }
      return best;
    }

    bindPointer() {
      const canvas = this.canvas;
      let start = null;
      const drag = d3.drag()
        .subject(e => { const [px, py] = d3.pointer(e, canvas); return this.nodeAt(px, py); })
        .on('start', e => {
          start = d3.pointer(e, canvas);
          canvas.classList.add('grabbing');
          if (this.layout === 'force') this.sim.alphaTarget(0.2).restart();
          e.subject.fx = e.subject.x; e.subject.fy = e.subject.y;
        })
        .on('drag', e => {
          const [x, y] = this.transform.invert(d3.pointer(e, canvas));
          e.subject.fx = x; e.subject.fy = y;
          if (this.layout !== 'force') { e.subject.x = x; e.subject.y = y; this.draw(); }
        })
        .on('end', e => {
          const p = d3.pointer(e, canvas);
          canvas.classList.remove('grabbing');
          this.sim.alphaTarget(0);
          e.subject.fx = null; e.subject.fy = null;
          if (start && Math.hypot(p[0] - start[0], p[1] - start[1]) < 4) {
            this.selected = e.subject;
            this.draw();
            this.handlers.onSelect(e.subject);
          }
          start = null;
        });

      d3.select(canvas).call(drag).call(this.zoom).on('dblclick.zoom', null);

      canvas.addEventListener('pointermove', ev => {
        const r = canvas.getBoundingClientRect();
        const n = this.nodeAt(ev.clientX - r.left, ev.clientY - r.top);
        if (n !== this.hovered) { this.hovered = n; canvas.classList.toggle('on-node', !!n); this.draw(); }
      });
      canvas.addEventListener('pointerleave', () => { if (this.hovered) { this.hovered = null; this.draw(); } });
      canvas.addEventListener('dblclick', ev => {
        const r = canvas.getBoundingClientRect();
        const n = this.nodeAt(ev.clientX - r.left, ev.clientY - r.top);
        if (n && this.handlers.onOpen) this.handlers.onOpen(n);
      });
      canvas.addEventListener('click', ev => {
        const r = canvas.getBoundingClientRect();
        if (!this.nodeAt(ev.clientX - r.left, ev.clientY - r.top) && this.selected) {
          this.selected = null; this.draw(); this.handlers.onSelect(null);
        }
      });
    }

    // ---------- drawing ----------
    draw() {
      if (!this.W) return;
      const { ctx } = this;
      const k = this.transform.k;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.translate(this.transform.x, this.transform.y);
      ctx.scale(k, k);

      const focus = this.hovered || this.selected;
      const q = this.query;
      const hit = n => !q || n.label.toLowerCase().includes(q);
      const near = n => !focus || n === focus || focus.nbrs.has(n.id);

      // Links: dim ones first in one batch, highlighted ones on top.
      ctx.lineWidth = 1 / k;
      ctx.strokeStyle = focus || q ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      const hot = [];
      for (const l of this.links) {
        const a = this.byId.get(typeof l.source === 'object' ? l.source.id : l.source);
        const b = this.byId.get(typeof l.target === 'object' ? l.target.id : l.target);
        if (!a || !b) continue;
        if (focus && (a === focus || b === focus)) { hot.push([a, b]); continue; }
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      if (hot.length) {
        ctx.strokeStyle = 'rgba(245,197,66,0.75)';
        ctx.lineWidth = 1.6 / k;
        ctx.beginPath();
        for (const [a, b] of hot) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
        ctx.stroke();
      }

      for (const n of this.nodes) {
        const dim = !near(n) || !hit(n);
        ctx.globalAlpha = dim ? 0.18 : 1;
        const color = COLOR[n.color] || COLOR.ghost;
        if (n.kind === 'project' || n.kind === 'subproject') {
          // Soft halo marks projects as hubs.
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 1.9, 0, Math.PI * 2);
          ctx.fillStyle = hexA(color, 0.12); ctx.fill();
        }
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        if (n.kind === 'ghost') {
          ctx.fillStyle = '#000'; ctx.fill();
          ctx.setLineDash([3 / k, 2.5 / k]);
          ctx.strokeStyle = color; ctx.lineWidth = 1.4 / k; ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = color; ctx.fill();
        }
        if (n === this.selected) {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4 / k, 0, Math.PI * 2);
          ctx.strokeStyle = COLOR.focus; ctx.lineWidth = 2 / k; ctx.stroke();
        }
      }

      // Labels keep a steady on-screen size; small dots only get one when zoomed in.
      const fs = 12 / k;
      ctx.font = `${fs}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      for (const n of this.nodes) {
        const important = n.kind === 'project' || n.kind === 'subproject';
        const show = important || n === focus || (focus && focus.nbrs.has(n.id)) || (q && hit(n)) ||
          ((n.kind === 'session' || n.kind === 'note' || n.kind === 'ghost') && k > 0.7) || k > 1.4;
        if (!show) continue;
        ctx.globalAlpha = !near(n) || !hit(n) ? 0.25 : 1;
        const text = n.label.length > 42 ? n.label.slice(0, 40) + '…' : n.label;
        const y = n.y + n.r + 4 / k;
        ctx.strokeStyle = '#000'; ctx.lineWidth = 4 / k; ctx.strokeText(text, n.x, y);
        ctx.fillStyle = important ? COLOR.ink : n.kind === 'ghost' ? COLOR.muted : '#C9C9CE';
        if (important) ctx.font = `600 ${fs * 1.1}px "Segoe UI", system-ui, sans-serif`;
        ctx.fillText(text, n.x, y);
        if (important) ctx.font = `${fs}px "Segoe UI", system-ui, sans-serif`;
      }
      ctx.globalAlpha = 1;
    }
  }

  function radius(n) {
    switch (n.kind) {
      case 'project': return 13;
      case 'subproject': return 10;
      case 'session': return Math.min(11, 5 + Math.sqrt(n.deg) * 1.2);
      case 'file': return Math.min(9, 3.5 + Math.sqrt(n.deg) * 1.4);
      case 'note': return Math.min(10, 5 + Math.sqrt(n.deg));
      default: return 4;
    }
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }

  // Rings and Tree: build a spanning tree from the root, then let d3 place it.
  function staticLayout(kind, nodes, links, rootId) {
    const adj = new Map(nodes.map(n => [n.id, []]));
    for (const l of links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      if (adj.has(s) && adj.has(t)) { adj.get(s).push(t); adj.get(t).push(s); }
    }
    const ROOT = '__root__';
    const parent = new Map();
    const order = [];
    const starts = rootId && adj.has(rootId) ? [rootId] : nodes.filter(n => n.kind === 'project' && !n.hasParent).map(n => n.id);
    for (const s of starts) parent.set(s, ROOT);
    const queue = [...starts];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const nb of adj.get(id)) if (!parent.has(nb)) { parent.set(nb, id); queue.push(nb); }
    }
    // Anything unreachable (a note with no links) hangs off the root.
    for (const n of nodes) if (!parent.has(n.id)) parent.set(n.id, starts.length === 1 ? starts[0] : ROOT);

    const rows = [{ id: ROOT, parent: null }, ...nodes.map(n => ({ id: n.id, parent: parent.get(n.id) === n.id ? ROOT : parent.get(n.id) }))];
    const root = d3.stratify().id(d => d.id).parentId(d => d.parent)(rows);
    const count = nodes.length;
    const out = new Map();

    if (kind === 'rings') {
      const R = Math.max(260, Math.sqrt(count) * 70);
      d3.tree().size([2 * Math.PI, R]).separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth))(root);
      root.each(d => { if (d.id !== ROOT) out.set(d.id, [Math.cos(d.x - Math.PI / 2) * d.y, Math.sin(d.x - Math.PI / 2) * d.y]); });
    } else {
      d3.tree().nodeSize([22, 190]).separation((a, b) => (a.parent === b.parent ? 1 : 1.6))(root);
      root.each(d => { if (d.id !== ROOT) out.set(d.id, [d.y - 190, d.x]); });
    }
    // A single real root sits at the centre instead of on the first ring.
    if (starts.length === 1 && kind === 'rings') out.set(starts[0], [0, 0]);
    return out;
  }

  window.VaultGraph = { Graph, fileColor };
})();
