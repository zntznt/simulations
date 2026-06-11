const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const NODE_R = { pool: 32, source: 32, drain: 32, gate: 34, converter: 36, register: 32, delay: 32, queue: 32, trader: 32 };

function nodeBoundaryPoint(node, tx, ty) {
  const dx = tx - node.x, dy = ty - node.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = dx / dist, ny = dy / dist;

  if (node.type === NodeType.REGISTER) {
    const hw = 42, hh = 30;
    const t = Math.min(hw / (Math.abs(nx) || 0.001), hh / (Math.abs(ny) || 0.001));
    return { x: node.x + nx * t, y: node.y + ny * t };
  }
  if (node.type === NodeType.GATE) {
    const r = 36;
    const t = r / ((Math.abs(nx) + Math.abs(ny)) || 1);
    return { x: node.x + nx * t, y: node.y + ny * t };
  }
  const r = NODE_R[node.type] || 32;
  return { x: node.x + nx * r, y: node.y + ny * r };
}

// Auto quadratic control-point: perpendicular nudge off the midpoint.
function connAutoCP(p1, p2) {
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  return { x: mx - dy * 0.12, y: my + dx * 0.12 };
}

// Actual control point for a curve connection (auto + stored offset).
function connCP(conn, p1, p2) {
  const a = connAutoCP(p1, p2);
  return { x: a.x + (conn.cpDx || 0), y: a.y + (conn.cpDy || 0) };
}

// ── Orthogonal (right-angle) connector routing ─────────────────────────────
// An ortho connection is a chain of axis-aligned segments. Its shape is stored
// as a list of interior corner points (conn.waypoints). Until the user drags it
// the route is the default H-V-H elbow derived from bendPct, so old diagrams
// (and freshly-styled connections) render unchanged.

// Interior corner points (centres), either explicit waypoints or the default.
function orthoWaypoints(conn, src, tgt) {
  if (conn.waypoints && conn.waypoints.length)
    return conn.waypoints.map(p => ({ x: p.x, y: p.y }));
  const bPct = conn.bendPct ?? 0.5;
  const bx = src.x + (tgt.x - src.x) * bPct;
  return [{ x: bx, y: src.y }, { x: bx, y: tgt.y }];
}

// Insert corners so every consecutive pair is axis-aligned (defensive: keeps a
// route looking orthogonal even after a node is moved out from under it).
function orthogonalizePts(pts) {
  if (pts.length < 2) return pts.map(p => ({ x: p.x, y: p.y }));
  const out = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5)
      out.push({ x: b.x, y: a.y }); // go horizontal first, then vertical
    out.push({ x: b.x, y: b.y });
  }
  return out;
}

// Drop duplicate and collinear corners so redundant bends collapse away.
function orthoCleanupFull(pts) {
  const p = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (last && Math.abs(last.x - q.x) < 0.5 && Math.abs(last.y - q.y) < 0.5) continue;
    p.push({ x: q.x, y: q.y });
  }
  let changed = true;
  while (changed && p.length > 2) {
    changed = false;
    for (let i = 1; i < p.length - 1; i++) {
      const a = p[i - 1], m = p[i], b = p[i + 1];
      const colX = Math.abs(a.x - m.x) < 0.5 && Math.abs(m.x - b.x) < 0.5;
      const colY = Math.abs(a.y - m.y) < 0.5 && Math.abs(m.y - b.y) < 0.5;
      if (colX || colY) { p.splice(i, 1); changed = true; break; }
    }
  }
  return p;
}

// Full corner chain in node-centre space: [src.centre, …corners, tgt.centre].
function orthoCenterPoints(conn, src, tgt) {
  const wps = orthoWaypoints(conn, src, tgt);
  return orthogonalizePts([{ x: src.x, y: src.y }, ...wps, { x: tgt.x, y: tgt.y }]);
}

// Same chain but with the first/last points clipped to the node boundaries —
// this is what actually gets drawn. Same length as orthoCenterPoints so handle
// indices map 1:1 to segments.
function orthoClippedPoints(conn, src, tgt) {
  const O = orthoCenterPoints(conn, src, tgt);
  if (O.length < 2) return O;
  O[0] = nodeBoundaryPoint(src, O[1].x, O[1].y);
  O[O.length - 1] = nodeBoundaryPoint(tgt, O[O.length - 2].x, O[O.length - 2].y);
  return O;
}

// Apply a perpendicular drag of one segment, keeping the route orthogonal.
// `base` is the orthoCenterPoints snapshot taken when the drag began; dx/dy are
// the total world-space movement since then. Writes the result to conn.waypoints.
// Dragging an end stub auto-inserts a bend so the fixed node attachment is kept.
function orthoDragSegment(conn, base, segIndex, dx, dy) {
  const n = base.length;
  if (segIndex < 0 || segIndex >= n - 1) return;
  const A = base[segIndex], B = base[segIndex + 1];
  const S = base[0], T = base[n - 1];
  const horiz = Math.abs(A.y - B.y) < 0.5;
  let interior = base.slice(1, n - 1).map(p => ({ x: p.x, y: p.y }));

  if (segIndex === 0) {
    // Stub leaving the source: insert a bend so src stays attached.
    if (horiz) { const ny = S.y + dy; interior = [{ x: S.x, y: ny }, { x: B.x, y: ny }, ...interior.slice(1)]; }
    else       { const nx = S.x + dx; interior = [{ x: nx, y: S.y }, { x: nx, y: B.y }, ...interior.slice(1)]; }
  } else if (segIndex === n - 2) {
    // Stub entering the target.
    if (horiz) { const ny = T.y + dy; interior = [...interior.slice(0, -1), { x: A.x, y: ny }, { x: T.x, y: ny }]; }
    else       { const nx = T.x + dx; interior = [...interior.slice(0, -1), { x: nx, y: A.y }, { x: nx, y: T.y }]; }
  } else {
    // Interior segment: slide it perpendicular by moving both its corners.
    if (horiz) { interior[segIndex - 1] = { x: A.x, y: A.y + dy }; interior[segIndex] = { x: B.x, y: B.y + dy }; }
    else       { interior[segIndex - 1] = { x: A.x + dx, y: A.y }; interior[segIndex] = { x: B.x + dx, y: B.y }; }
  }

  const full = orthoCleanupFull([S, ...interior, T]);
  let wp = full.slice(1, full.length - 1).map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  if (wp.length > 16) wp = wp.slice(0, 16);
  conn.waypoints = wp;
}

function connPathD(conn, src, tgt) {
  if (src.id === tgt.id) {
    // Self-loop: a small loop above the node (used by self state modifiers).
    const r = NODE_R[src.type] || 32;
    const x = src.x, y = src.y;
    return `M ${x - r * 0.55},${y - r * 0.8} C ${x - r * 1.6},${y - r * 2.6} `
         + `${x + r * 1.6},${y - r * 2.6} ${x + r * 0.55},${y - r * 0.8}`;
  }

  const style = conn.pathStyle || 'curve';

  if (style === 'straight') {
    const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
    const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
    return `M ${p1.x},${p1.y} L ${p2.x},${p2.y}`;
  }

  if (style === 'ortho') {
    const O = orthoClippedPoints(conn, src, tgt);
    if (O.length < 2) return `M ${src.x},${src.y} L ${tgt.x},${tgt.y}`;
    return `M ${O[0].x},${O[0].y}` + O.slice(1).map(p => ` L ${p.x},${p.y}`).join('');
  }

  // curve (default)
  const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
  const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
  const cp = connCP(conn, p1, p2);
  return `M ${p1.x},${p1.y} Q ${cp.x},${cp.y} ${p2.x},${p2.y}`;
}

function connLabelPos(conn, src, tgt) {
  if (src.id === tgt.id) {
    const r = NODE_R[src.type] || 32;
    return { x: src.x, y: src.y - r * 2.2 };
  }

  const t = (conn.labelT != null) ? conn.labelT : 0.5;
  const style = conn.pathStyle || 'curve';

  if (style === 'straight') {
    const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
    const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
    return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
  }

  if (style === 'ortho') {
    const O = orthoClippedPoints(conn, src, tgt);
    if (O.length < 2) return { x: (src.x + tgt.x) / 2, y: (src.y + tgt.y) / 2 };
    let totalLen = 0;
    for (let i = 0; i < O.length - 1; i++)
      totalLen += Math.hypot(O[i+1].x - O[i].x, O[i+1].y - O[i].y);
    let target = t * totalLen, walked = 0;
    for (let i = 0; i < O.length - 1; i++) {
      const segLen = Math.hypot(O[i+1].x - O[i].x, O[i+1].y - O[i].y);
      if (walked + segLen >= target || i === O.length - 2) {
        const u = segLen > 0 ? (target - walked) / segLen : 0;
        return { x: O[i].x + u * (O[i+1].x - O[i].x), y: O[i].y + u * (O[i+1].y - O[i].y) };
      }
      walked += segLen;
    }
    return { x: O[0].x, y: O[0].y };
  }

  // curve (quadratic bezier): evaluate at t
  const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
  const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
  const cp = connCP(conn, p1, p2);
  const mt = 1 - t;
  return { x: mt*mt*p1.x + 2*mt*t*cp.x + t*t*p2.x, y: mt*mt*p1.y + 2*mt*t*cp.y + t*t*p2.y };
}

// ── Ball animation system ─────────────────────────────────────────────────

class BallSystem {
  constructor(layer) {
    this.layer = layer;
    this._balls = [];
    this._running = false;
  }

  spawn(pathEl, amount, color, durationMs) {
    if (!pathEl) return;
    // Respect the user's motion preference: transfers still happen, the
    // travelling-ball animation is simply skipped.
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const capped = Math.min(amount, 12);
    const pathLen = pathEl.getTotalLength();
    if (pathLen < 1) return;

    const now = performance.now();
    const stagger = Math.min(durationMs * 0.07, 80);

    for (let i = 0; i < capped; i++) {
      const el = svgEl('circle', { r: '5', fill: color, opacity: '0', 'pointer-events': 'none' });
      // Darker stroke so balls are visible against light backgrounds
      el.setAttribute('stroke', this._darken(color));
      el.setAttribute('stroke-width', '1');
      this.layer.appendChild(el);
      this._balls.push({ el, pathEl, pathLen, start: now + i * stagger, dur: durationMs });
    }

    if (!this._running) this._loop();
  }

  clear() {
    for (const b of this._balls) b.el.remove();
    this._balls = [];
  }

  _loop() {
    this._running = true;
    const tick = (now) => {
      this._balls = this._balls.filter(b => {
        const t = (now - b.start) / b.dur;
        if (t < 0) { return true; }  // not started yet
        if (t >= 1) { b.el.remove(); return false; }
        try {
          const pt = b.pathEl.getPointAtLength(t * b.pathLen);
          b.el.setAttribute('cx', pt.x);
          b.el.setAttribute('cy', pt.y);
          b.el.setAttribute('opacity', String(0.9 - Math.pow(t - 0.5, 2) * 0.4));
        } catch { b.el.remove(); return false; }
        return true;
      });
      if (this._balls.length > 0) requestAnimationFrame(tick);
      else this._running = false;
    };
    requestAnimationFrame(tick);
  }

  _darken(hex) {
    try {
      const n = parseInt(hex.replace('#', ''), 16);
      const r = Math.max(0, (n >> 16) - 60);
      const g = Math.max(0, ((n >> 8) & 0xff) - 60);
      const b = Math.max(0, (n & 0xff) - 60);
      return `rgb(${r},${g},${b})`;
    } catch { return '#000'; }
  }
}

// ── Main Renderer ─────────────────────────────────────────────────────────

class Renderer {
  constructor(svg, diagram, engine = null) {
    this.svg = svg;
    this.diagram = diagram;
    this.engine = engine;          // for live on-canvas charts (reads history)
    this.selectedId = null;        // primary selection (node or connection)
    this.selectedIds = new Set();  // multi-selected node ids
    this._firing = new Set();
    this._nodeEls = new Map();
    this._connEls = new Map();
    this._groupEls = new Map();
    this._noteEls = new Map();
    this._chartEls = new Map();
    this._panX = 0;
    this._panY = 0;
    this._scale = 1;

    this._setup();
    this.balls = new BallSystem(this.ballLayer);
  }

  _setup() {
    const defs = svgEl('defs');

    // Grid — kept fixed to the viewport but its patternTransform tracks the
    // pan/zoom (see _updateTransform), so it visually moves and scales with the
    // content while always covering the screen.
    const pat = svgEl('pattern', { id: 'grid', width: '40', height: '40', patternUnits: 'userSpaceOnUse' });
    pat.appendChild(svgEl('path', { d: 'M40 0L0 0 0 40', fill: 'none', stroke: '#1a2035', 'stroke-width': '0.6' }));
    defs.appendChild(pat);
    this._gridPat = pat;

    // Dot overlay
    const pat2 = svgEl('pattern', { id: 'dots', width: '40', height: '40', patternUnits: 'userSpaceOnUse' });
    pat2.appendChild(svgEl('circle', { cx: '0', cy: '0', r: '1', fill: '#1e2840' }));
    defs.appendChild(pat2);
    this._dotPat = pat2;

    // Arrow markers
    const mkArrow = (id, color) => {
      const m = svgEl('marker', { id, markerWidth: '8', markerHeight: '6', refX: '7', refY: '3', orient: 'auto' });
      m.appendChild(svgEl('polygon', { points: '0 0,8 3,0 6', fill: color }));
      defs.appendChild(m);
    };
    mkArrow('arrow-resource', '#ffa726');
    mkArrow('arrow-state', '#78909c');
    mkArrow('arrow-trigger', '#66bb6a');
    mkArrow('arrow-sel', '#fff');

    // Glow
    const filt = svgEl('filter', { id: 'glow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
    filt.appendChild(svgEl('feGaussianBlur', { stdDeviation: '5', result: 'b' }));
    const merge = svgEl('feMerge');
    merge.appendChild(svgEl('feMergeNode', { in: 'b' }));
    merge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
    filt.appendChild(merge);
    defs.appendChild(filt);

    this.svg.appendChild(defs);
    this._bgRect = svgEl('rect', { width: '100%', height: '100%', fill: '#0f1117' });
    this._gridStroke = pat.firstChild;
    this.svg.appendChild(this._bgRect);
    this.svg.appendChild(svgEl('rect', { width: '100%', height: '100%', fill: 'url(#grid)' }));

    // Onboarding hint, shown only while the canvas is completely empty.
    // Lives outside the pan/zoom root so it stays centred in the viewport.
    this._emptyHint = svgEl('g', { 'pointer-events': 'none', visibility: 'hidden' });
    const hintLines = [
      ['Empty canvas', '16', '600', '#6b7793'],
      ['Pick a node from the left palette and click here to place it.', '12', '400', '#556070'],
      ['Connect nodes with the Resource (R) or State (T) tools — or load a template from the Library.', '12', '400', '#556070'],
    ];
    hintLines.forEach(([txt, size, weight, fill], i) => {
      const t = svgEl('text', {
        x: '50%', y: '50%', transform: `translate(0,${i * 24 - 24})`,
        'text-anchor': 'middle', 'font-family': 'var(--font)',
        'font-size': size, 'font-weight': weight, fill,
      });
      t.textContent = txt;
      this._emptyHint.appendChild(t);
    });
    this.svg.appendChild(this._emptyHint);

    this.root = svgEl('g', { id: 'root' });
    this.groupLayer = svgEl('g');
    this.connLayer = svgEl('g');
    this.nodeLayer = svgEl('g');
    this.chartLayer = svgEl('g');
    this.noteLayer = svgEl('g');
    this.ballLayer = svgEl('g');
    this.tempLayer = svgEl('g');
    this.root.append(this.groupLayer, this.connLayer, this.nodeLayer,
                     this.chartLayer, this.noteLayer, this.ballLayer, this.tempLayer);
    this.svg.appendChild(this.root);

    this._updateTransform();
  }

  setPan(x, y) { this._panX = x; this._panY = y; this._updateTransform(); }
  // Canvas background override (simulation meta). Empty string restores the
  // theme default. The grid stroke flips dark/light to stay visible.
  setBackground(color) {
    const bg = color || '#0f1117';
    this._bgRect.setAttribute('fill', bg);
    let light = false;
    const m = /^#([0-9a-f]{6})$/i.exec(bg);
    if (m) {
      const v = parseInt(m[1], 16);
      const lum = 0.299 * (v >> 16 & 255) + 0.587 * (v >> 8 & 255) + 0.114 * (v & 255);
      light = lum > 140;
    }
    if (this._gridStroke) this._gridStroke.setAttribute('stroke', light ? 'rgba(0,0,0,0.13)' : '#1a2035');
  }

  _updateTransform() {
    const t = `translate(${this._panX},${this._panY}) scale(${this._scale})`;
    this.root.setAttribute('transform', t);
    // Keep the grid in lock-step with the content so panning reads as motion.
    if (this._gridPat) this._gridPat.setAttribute('patternTransform', t);
    if (this._dotPat) this._dotPat.setAttribute('patternTransform', t);
    if (this.onViewChange) this.onViewChange(this._scale);
  }

  _clampScale(s) { return Math.max(0.25, Math.min(3, s)); }

  // Zoom by `factor` keeping the point under (clientX, clientY) fixed.
  zoomBy(factor, clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    const sx = clientX - r.left, sy = clientY - r.top;
    const wx = (sx - this._panX) / this._scale;
    const wy = (sy - this._panY) / this._scale;
    this._scale = this._clampScale(this._scale * factor);
    this._panX = sx - wx * this._scale;
    this._panY = sy - wy * this._scale;
    this._updateTransform();
  }

  // Zoom about the viewport centre (for the +/− buttons).
  zoomStep(factor) {
    const r = this.svg.getBoundingClientRect();
    this.zoomBy(factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  // Set an absolute zoom level, keeping the viewport centre fixed.
  zoomTo(scale) {
    const target = this._clampScale(scale);
    this.zoomStep(target / this._scale);
  }

  resetView() { this._panX = 0; this._panY = 0; this._scale = 1; this._updateTransform(); }

  // Bounding box (in world coords) of everything on the canvas, or null if empty.
  _contentBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    const ext = (x0, y0, x1, y1) => {
      any = true;
      minX = Math.min(minX, x0); minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
    };
    const NR = 40; // node half-extent incl. label padding
    for (const n of this.diagram.nodes.values()) ext(n.x - NR, n.y - NR, n.x + NR, n.y + NR);
    for (const g of this.diagram.groups.values()) ext(g.x, g.y, g.x + g.w, g.y + g.h);
    for (const nt of this.diagram.notes.values()) ext(nt.x, nt.y, nt.x + (nt.w || 160), nt.y + (nt.h || 100));
    for (const c of this.diagram.charts.values()) ext(c.x, c.y, c.x + (c.w || 280), c.y + (c.h || 180));
    return any ? { minX, minY, maxX, maxY } : null;
  }

  // Frame all content in the viewport with padding. Zooms out to fit large
  // diagrams; never zooms in past 100% (so a tiny diagram is centred, not blown
  // up). Falls back to a plain reset when the canvas is empty or unsized.
  fitView(pad = 80) {
    const box = this._contentBounds();
    const r = this.svg.getBoundingClientRect();
    if (!box || r.width < 10 || r.height < 10) { this.resetView(); return; }
    const cw = Math.max(1, box.maxX - box.minX);
    const ch = Math.max(1, box.maxY - box.minY);
    const fit = Math.min((r.width - pad * 2) / cw, (r.height - pad * 2) / ch);
    this._scale = this._clampScale(Math.min(1, fit));
    const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
    this._panX = r.width / 2 - cx * this._scale;
    this._panY = r.height / 2 - cy * this._scale;
    this._updateTransform();
  }

  svgPoint(cx, cy) {
    const r = this.svg.getBoundingClientRect();
    return {
      x: (cx - r.left - this._panX) / this._scale,
      y: (cy - r.top - this._panY) / this._scale,
    };
  }

  getConnPathEl(connId) {
    return this._connEls.get(connId)?.querySelector('.conn-path') || null;
  }

  setFiring(ids) {
    this._firing = new Set(ids);
    this.render();
    setTimeout(() => { this._firing.clear(); this.render(); }, 250);
  }

  render() {
    this._renderGroups();
    this._renderConns();
    this._renderNodes();
    this._renderCharts();
    this._renderNotes();

    const d = this.diagram;
    const empty = !d.nodes.size && !d.groups.size && !d.notes.size && !d.charts.size;
    this._emptyHint.setAttribute('visibility', empty ? 'visible' : 'hidden');
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  _renderGroups() {
    const d = this.diagram;
    for (const [id, el] of this._groupEls)
      if (!d.groups.has(id)) { el.remove(); this._groupEls.delete(id); }
    for (const group of d.groups.values()) {
      let el = this._groupEls.get(group.id);
      if (!el) { el = this._makeGroupEl(group); this.groupLayer.appendChild(el); this._groupEls.set(group.id, el); }
      this._updateGroupEl(el, group);
    }
  }

  _makeGroupEl(group) {
    const g = svgEl('g', { 'data-id': group.id, cursor: 'pointer' });
    g.appendChild(svgEl('rect', { class: 'grp-bg', rx: '8', 'stroke-dasharray': '6,4' }));
    g.appendChild(svgEl('text', { class: 'grp-label', 'font-size': '11', 'font-family': 'var(--font)', 'font-weight': '600', 'pointer-events': 'none' }));
    return g;
  }

  _updateGroupEl(el, group) {
    const isSel = this.selectedId === group.id;
    el.setAttribute('class', `group-container${isSel ? ' selected' : ''}`);
    const color = group.color || '#4a9eff';
    const rect = el.querySelector('.grp-bg');
    rect.setAttribute('x', group.x);
    rect.setAttribute('y', group.y);
    rect.setAttribute('width', group.w);
    rect.setAttribute('height', group.h);
    rect.setAttribute('fill', this._hexToRgba(color, 0.07));
    rect.setAttribute('stroke', color);
    rect.setAttribute('stroke-width', isSel ? '2.5' : '1.5');
    if (isSel) rect.setAttribute('filter', 'url(#glow)');
    else rect.removeAttribute('filter');
    const lbl = el.querySelector('.grp-label');
    lbl.setAttribute('x', String(group.x + 12));
    lbl.setAttribute('y', String(group.y + 16));
    lbl.textContent = group.label || '';
    lbl.setAttribute('fill', color);
    this._updateResizeHandles(el, group, isSel);
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  _renderNotes() {
    const d = this.diagram;
    for (const [id, el] of this._noteEls)
      if (!d.notes.has(id)) { el.remove(); this._noteEls.delete(id); }
    for (const note of d.notes.values()) {
      let el = this._noteEls.get(note.id);
      if (!el) { el = this._makeNoteEl(note); this.noteLayer.appendChild(el); this._noteEls.set(note.id, el); }
      this._updateNoteEl(el, note);
    }
  }

  _makeNoteEl(note) {
    const g = svgEl('g', { 'data-id': note.id, cursor: 'pointer' });
    g.appendChild(svgEl('rect', { class: 'note-bg', rx: '4', 'stroke-width': '1.5' }));
    g.appendChild(svgEl('text', { class: 'note-text', 'font-size': '11', 'font-family': 'var(--font)', 'pointer-events': 'none' }));
    return g;
  }

  _updateNoteEl(el, note) {
    const isSel = this.selectedId === note.id;
    el.setAttribute('class', `sticky-note${isSel ? ' selected' : ''}`);
    const color = note.color || '#f6e05e';
    const rect = el.querySelector('.note-bg');
    rect.setAttribute('x', note.x);
    rect.setAttribute('y', note.y);
    rect.setAttribute('width', note.w);
    rect.setAttribute('height', note.h);
    rect.setAttribute('fill', color);
    rect.setAttribute('stroke', this._darkenHex(color));
    if (isSel) rect.setAttribute('filter', 'url(#glow)');
    else rect.removeAttribute('filter');

    const textEl = el.querySelector('.note-text');
    while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
    const maxChars = Math.max(8, Math.floor((note.w - 16) / 6.5));
    const maxLines = Math.max(1, Math.floor((note.h - 12) / 15));
    const lines = this._wrapNoteText(note.text || '', maxChars);
    lines.slice(0, maxLines).forEach((line, i) => {
      if (!line) return;
      const ts = document.createElementNS(SVG_NS, 'tspan');
      ts.setAttribute('x', String(note.x + 8));
      ts.setAttribute('y', String(note.y + 16 + i * 15));
      ts.textContent = line;
      textEl.appendChild(ts);
    });
    textEl.setAttribute('fill', '#1a1a1a');
    this._updateResizeHandles(el, note, isSel);
  }

  _wrapNoteText(text, maxChars) {
    if (!text) return [];
    const result = [];
    for (const para of text.split('\n')) {
      if (!para) { result.push(''); continue; }
      const words = para.split(' ');
      let line = '';
      for (const word of words) {
        if (!word) continue;
        if (line && line.length + 1 + word.length > maxChars) {
          result.push(line); line = word;
        } else {
          line = line ? line + ' ' + word : word;
        }
      }
      result.push(line);
    }
    return result;
  }

  _darkenHex(hex) {
    try {
      const n = parseInt((hex || '#000').replace('#', ''), 16);
      const r = Math.max(0, (n >> 16) - 60);
      const g = Math.max(0, ((n >> 8) & 0xff) - 60);
      const b = Math.max(0, (n & 0xff) - 60);
      return `rgb(${r},${g},${b})`;
    } catch { return '#000'; }
  }

  _hexToRgba(hex, alpha) {
    try {
      const n = parseInt((hex || '#4a9eff').replace('#', ''), 16);
      const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
      return `rgba(${r},${g},${b},${alpha})`;
    } catch { return `rgba(74,158,255,${alpha})`; }
  }

  // Show a preview rect in the temp layer while dragging to create a group.
  setGroupPreview(x0, y0, x1, y1) {
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    this.tempLayer.innerHTML = '';
    if (w > 5 && h > 5) {
      this.tempLayer.appendChild(svgEl('rect', {
        x, y, width: w, height: h, rx: '8',
        fill: 'rgba(74,158,255,0.06)', stroke: '#4a9eff',
        'stroke-width': '1.5', 'stroke-dasharray': '6,4', 'pointer-events': 'none',
      }));
    }
  }

  // ── On-canvas charts ───────────────────────────────────────────────────────

  _renderCharts() {
    const d = this.diagram;
    for (const [id, el] of this._chartEls)
      if (!d.charts.has(id)) { el.remove(); this._chartEls.delete(id); }
    for (const chart of d.charts.values()) {
      let el = this._chartEls.get(chart.id);
      if (!el) { el = this._makeChartEl(chart); this.chartLayer.appendChild(el); this._chartEls.set(chart.id, el); }
      this._updateChartEl(el, chart);
    }
  }

  _makeChartEl(chart) {
    const g = svgEl('g', { 'data-id': chart.id, cursor: 'pointer' });
    g.appendChild(svgEl('rect', { class: 'chart-bg', rx: '6', 'stroke-width': '1.5' }));
    g.appendChild(svgEl('text', { class: 'chart-title', 'font-size': '11', 'font-family': 'var(--font)', 'font-weight': '600', 'pointer-events': 'none' }));
    g.appendChild(svgEl('g', { class: 'chart-plot', 'pointer-events': 'none' }));
    return g;
  }

  _updateChartEl(el, chart) {
    const palette = (typeof CHART_PALETTE !== 'undefined') ? CHART_PALETTE
      : ['#4a9eff', '#4caf50', '#ef5350', '#ffa726', '#ba68c8', '#26c6da', '#ffeb3b', '#7c83ff', '#ff7043', '#9ccc65'];
    const isSel = this.selectedId === chart.id;
    el.setAttribute('class', `chart-elem${isSel ? ' selected' : ''}`);

    const bg = el.querySelector('.chart-bg');
    bg.setAttribute('x', chart.x);
    bg.setAttribute('y', chart.y);
    bg.setAttribute('width', chart.w);
    bg.setAttribute('height', chart.h);
    bg.setAttribute('fill', '#0f1117');
    bg.setAttribute('stroke', isSel ? '#fff' : '#2a3550');
    if (isSel) bg.setAttribute('filter', 'url(#glow)');
    else bg.removeAttribute('filter');

    const title = el.querySelector('.chart-title');
    title.setAttribute('x', String(chart.x + 8));
    title.setAttribute('y', String(chart.y + 14));
    title.textContent = chart.label || 'Chart';
    title.setAttribute('fill', '#9aa3b2');

    this._updateResizeHandles(el, chart, isSel);

    const plot = el.querySelector('.chart-plot');
    while (plot.firstChild) plot.removeChild(plot.firstChild);

    const hint = (msg) => {
      const t = svgEl('text', {
        x: String(chart.x + chart.w / 2), y: String(chart.y + chart.h / 2 + 6),
        'text-anchor': 'middle', 'font-size': '10', 'font-family': 'var(--font)', fill: '#556070',
      });
      t.textContent = msg;
      plot.appendChild(t);
    };

    const ids = (chart.nodeIds || []).filter(id => this.diagram.nodes.has(id));
    if (!ids.length) { hint('Pick nodes in the panel →'); return; }

    const hist = (this.engine && this.engine.history) ? this.engine.history : [];
    if (hist.length < 2) { hint('Run the simulation to plot'); return; }

    // Plot geometry (relative to the chart box).
    const padL = 28, padT = 22, padB = 10, padR = 8;
    const x0 = chart.x + padL, y0 = chart.y + padT;
    const plotW = Math.max(10, chart.w - padL - padR);
    const plotH = Math.max(10, chart.h - padT - padB);

    let max = 1;
    for (const snap of hist) for (const id of ids) max = Math.max(max, snap.snap[id] ?? 0);

    const n = hist.length;
    const xAt = i => x0 + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
    const yAt = v => y0 + plotH - (v / max) * plotH;

    // Axes (left + baseline) with min/max labels.
    const axis = svgEl('path', {
      d: `M ${x0},${y0} L ${x0},${y0 + plotH} L ${x0 + plotW},${y0 + plotH}`,
      fill: 'none', stroke: '#1e2535', 'stroke-width': '1',
    });
    plot.appendChild(axis);
    const maxLbl = svgEl('text', { x: String(chart.x + 3), y: String(y0 + 6), 'font-size': '8', 'font-family': 'monospace', fill: '#556070' });
    maxLbl.textContent = String(+max.toFixed(max < 10 ? 1 : 0));
    plot.appendChild(maxLbl);
    const zeroLbl = svgEl('text', { x: String(chart.x + 3), y: String(y0 + plotH), 'font-size': '8', 'font-family': 'monospace', fill: '#556070' });
    zeroLbl.textContent = '0';
    plot.appendChild(zeroLbl);

    // One series per tracked node, drawn in the chart's visualization style,
    // plus a live end-value label.
    const type = chart.chartType || 'line';
    const baseY = y0 + plotH;
    ids.forEach((id, idx) => {
      const color = palette[idx % palette.length];
      const vals = hist.map(snap => snap.snap[id] ?? 0);

      if (type === 'bars') {
        // Grouped bars: each step's slot is shared between the series.
        const slot = plotW / n;
        const bw = Math.max(1, (slot * 0.8) / ids.length);
        vals.forEach((v, i) => {
          const h = (v / max) * plotH;
          if (h <= 0) return;
          plot.appendChild(svgEl('rect', {
            x: (x0 + i * slot + slot * 0.1 + idx * bw).toFixed(1),
            y: (baseY - h).toFixed(1),
            width: bw.toFixed(1), height: h.toFixed(1),
            fill: color, opacity: '0.85',
          }));
        });
      } else if (type === 'step') {
        // Staircase: hold each value until the next step — honest for counts.
        let dPath = `M ${xAt(0).toFixed(1)},${yAt(vals[0]).toFixed(1)}`;
        for (let i = 1; i < n; i++)
          dPath += ` H ${xAt(i).toFixed(1)} V ${yAt(vals[i]).toFixed(1)}`;
        plot.appendChild(svgEl('path', { d: dPath, fill: 'none', stroke: color, 'stroke-width': '1.5' }));
      } else {
        // line + area share the polyline; area adds a translucent fill below.
        const pts = vals.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
        if (type === 'area') {
          const poly = `${xAt(0).toFixed(1)},${baseY.toFixed(1)} ${pts} ${xAt(n - 1).toFixed(1)},${baseY.toFixed(1)}`;
          plot.appendChild(svgEl('polygon', { points: poly, fill: color, opacity: '0.18', stroke: 'none' }));
        }
        plot.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': '1.5' }));
      }

      const last = vals[vals.length - 1];
      const lbl = svgEl('text', {
        x: String(x0 + plotW), y: String(Math.max(y0 + 7, yAt(last) - 2)),
        'text-anchor': 'end', 'font-size': '8', 'font-family': 'monospace', fill: color,
      });
      lbl.textContent = String(+Number(last).toFixed(max < 10 ? 1 : 0));
      plot.appendChild(lbl);
    });
  }

  // ── Connections ──────────────────────────────────────────────────────────

  _renderConns() {
    const d = this.diagram;
    for (const [id, el] of this._connEls)
      if (!d.connections.has(id)) { el.remove(); this._connEls.delete(id); }

    for (const conn of d.connections.values()) {
      const src = d.nodes.get(conn.sourceId), tgt = d.nodes.get(conn.targetId);
      if (!src || !tgt) continue;
      let el = this._connEls.get(conn.id);
      if (!el) { el = this._makeConnEl(conn); this.connLayer.appendChild(el); this._connEls.set(conn.id, el); }
      this._updateConnEl(el, conn, src, tgt);
    }
  }

  _makeConnEl(conn) {
    const g = svgEl('g', { 'data-id': conn.id });
    g.appendChild(svgEl('path', { class: 'conn-hitbox', fill: 'none', stroke: 'transparent', 'stroke-width': '14', cursor: 'pointer' }));
    g.appendChild(svgEl('path', { class: 'conn-path', fill: 'none', 'stroke-width': '2' }));
    const lg = svgEl('g', { class: 'conn-label-g', 'data-conn-id': conn.id, cursor: 'grab' });
    lg.appendChild(svgEl('rect', { class: 'conn-label-bg', rx: '7', ry: '7', 'pointer-events': 'all' }));
    lg.appendChild(svgEl('text', { class: 'conn-label', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': '11', 'font-family': 'var(--font)', 'pointer-events': 'none' }));
    g.appendChild(lg);
    g.appendChild(svgEl('g', { class: 'conn-handles' }));
    return g;
  }

  _updateConnEl(el, conn, src, tgt) {
    const isRes = conn.type === ConnectionType.RESOURCE;
    const isTrigger = !isRes && conn.trigger;
    const isActivator = !isRes && conn.activator;
    const isModifier = !isRes && conn.modifier;
    const isSel = this.selectedId === conn.id;
    const d = connPathD(conn, src, tgt);
    const lp = connLabelPos(conn, src, tgt);

    const baseColor = isTrigger ? '#66bb6a' : (isModifier ? '#ffb74d' : (isRes ? '#ffa726' : '#78909c'));
    const color = isSel ? '#fff' : baseColor;

    el.querySelector('.conn-hitbox').setAttribute('d', d);

    const path = el.querySelector('.conn-path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    if (isTrigger) path.setAttribute('stroke-dasharray', '2,4');
    else if (!isRes) path.setAttribute('stroke-dasharray', '7,4');
    else path.removeAttribute('stroke-dasharray');
    const marker = isSel ? 'arrow-sel' : (isTrigger ? 'arrow-trigger' : (isRes ? 'arrow-resource' : 'arrow-state'));
    path.setAttribute('marker-end', `url(#${marker})`);

    const labelG = el.querySelector('.conn-label-g');
    const label = labelG.querySelector('.conn-label');
    const labelBg = labelG.querySelector('.conn-label-bg');
    let txt = conn.label || '';
    if (isRes) {
      if (conn.rateMode === RateMode.DICE) txt = txt || conn.dice;
      else if (conn.rateMode === RateMode.FORMULA) txt = txt || conn.formula;
      else if (conn.rate !== 1) txt = txt || String(conn.rate);
      if (conn.interval > 1) txt += (txt ? ' ' : '') + `/${conn.interval}`;
      if (conn.chance < 100) txt += (txt ? ' ' : '') + `${conn.chance}%`;
      if (conn.colorFilter) txt += (txt ? ' ' : '') + '●';
      if (src && src.type === NodeType.GATE) {
        const gmode = src.gateMode === 'random' ? 'probabilistic' : src.gateMode;
        if (gmode === 'probabilistic') {
          const getW = c => { const w = Number(c.weight); return isFinite(w) && w >= 0 ? w : 1; };
          const allOuts = [...this.diagram.connections.values()]
            .filter(c => c.sourceId === src.id && c.type === ConnectionType.RESOURCE);
          const totalW = allOuts.reduce((s, c) => s + getW(c), 0);
          if (totalW > 0) {
            const pct = Math.round(getW(conn) / totalW * 100);
            txt = (txt ? txt + ' ' : '') + `${pct}%`;
          }
        } else if (Number(conn.weight) !== 1) {
          txt += (txt ? ' ' : '') + `⚖${conn.weight}`;
        }
      }
    } else if (isTrigger) {
      txt = conn.label ? `✷ ${conn.label}` : '✷';
      if ((conn.triggerEvery || 1) > 1) txt += `/${conn.triggerEvery}`;
      if (conn.triggerChance != null && conn.triggerChance < 100) txt += ` ${conn.triggerChance}%`;
    } else if (isModifier) {
      const mode = conn.modMode || 'rate';
      if (conn.modFormula) {
        const f = conn.modFormula.length > 16 ? conn.modFormula.slice(0, 15) + '…' : conn.modFormula;
        txt = mode === 'pulse' ? `${f} ✷`
          : mode === 'step' ? `+${f}`
          : mode === 'delta' ? `${f}×Δ` : `Δ ${f}×`;
      } else {
        const sign = conn.modFactor > 0 ? '+' : '';
        if (mode === 'pulse') txt = `${sign}${conn.modFactor} ✷`;
        else if (mode === 'step') txt = `${sign}${conn.modFactor}`;
        else if (mode === 'delta') txt = `${sign}${conn.modFactor}×Δ`;
        else txt = `Δ ${sign}${conn.modFactor}×`;
      }
    } else if (isActivator) {
      txt = conn.actOperator === 'between'
        ? `⊢ ${Math.min(conn.actValue, conn.actValue2)}..${Math.max(conn.actValue, conn.actValue2)}`
        : `⊢ ${conn.actOperator}${conn.actValue}`;
    } else {
      txt = conn.variableName || conn.label || '';
    }
    if (txt) {
      labelG.style.display = '';
      label.textContent = txt;
      label.setAttribute('x', lp.x);
      label.setAttribute('y', lp.y);
      label.setAttribute('fill', color);
      try {
        const bb = label.getBBox();
        const px = 6, py = 3;
        labelBg.setAttribute('x', bb.x - px);
        labelBg.setAttribute('y', bb.y - py);
        labelBg.setAttribute('width', bb.width + px * 2);
        labelBg.setAttribute('height', bb.height + py * 2);
        labelBg.setAttribute('fill', isSel ? 'rgba(255,255,255,0.14)' : 'rgba(18,18,18,0.85)');
        labelBg.setAttribute('stroke', color);
        labelBg.setAttribute('stroke-width', '1');
      } catch (_) {}
    } else {
      label.textContent = '';
      labelG.style.display = 'none';
    }

    el.setAttribute('class', `conn${isSel ? ' selected' : ''}`);

    // Reshape handles — shown only while selected (and never on a self-loop).
    const hg = el.querySelector('.conn-handles');
    while (hg.firstChild) hg.removeChild(hg.firstChild);
    if (isSel && src.id !== tgt.id) {
      for (const h of this.getConnHandles(conn.id)) {
        hg.appendChild(svgEl('circle', {
          class: 'conn-cp-handle', r: '6', cx: h.x, cy: h.y,
          fill: 'rgba(74,158,255,0.25)', stroke: '#4a9eff', 'stroke-width': '1.5', cursor: 'move',
        }));
      }
    }
  }

  // Draggable reshape handles for a connection, in world coords. Each carries a
  // `kind` ('cp' | 'ortho') and `segIndex` so the editor knows what it's moving.
  // Returns [] for straight connections and self-loops.
  getConnHandles(connId) {
    const conn = this.diagram.connections.get(connId);
    if (!conn) return [];
    const src = this.diagram.nodes.get(conn.sourceId);
    const tgt = this.diagram.nodes.get(conn.targetId);
    if (!src || !tgt || src.id === tgt.id) return [];
    const style = conn.pathStyle || 'curve';
    if (style === 'straight') return [];
    if (style === 'curve') {
      const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
      const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
      const cp = connCP(conn, p1, p2);
      return [{ x: cp.x, y: cp.y, kind: 'cp', segIndex: 0 }];
    }
    // ortho: a handle at the midpoint of every segment long enough to grab.
    const O = orthoClippedPoints(conn, src, tgt);
    const handles = [];
    for (let i = 0; i < O.length - 1; i++) {
      const a = O[i], b = O[i + 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 16) continue;
      handles.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, kind: 'ortho', segIndex: i });
    }
    return handles;
  }

  // The four corner resize handles of a rect-like item (group/note/chart), in
  // world coords. Each carries a `corner` ('nw'|'ne'|'sw'|'se') so the editor
  // knows which edges to move. Returns [] for unknown ids.
  getResizeHandles(id) {
    const item = this.diagram.groups.get(id) || this.diagram.charts.get(id) || this.diagram.notes.get(id);
    if (!item) return [];
    const { x, y, w, h } = item;
    return [
      { x, y, corner: 'nw' },
      { x: x + w, y, corner: 'ne' },
      { x, y: y + h, corner: 'sw' },
      { x: x + w, y: y + h, corner: 'se' },
    ];
  }

  // Draw (or remove) the corner resize handles inside a selected item's group.
  // Kept as the last children so they paint above the item's own content.
  _updateResizeHandles(el, item, isSel) {
    let hg = el.querySelector('.resize-handles');
    if (!isSel) { if (hg) hg.remove(); return; }
    if (!hg) { hg = svgEl('g', { class: 'resize-handles' }); el.appendChild(hg); }
    else { while (hg.firstChild) hg.removeChild(hg.firstChild); el.appendChild(hg); }
    const corners = [
      { x: item.x, y: item.y, corner: 'nw' },
      { x: item.x + item.w, y: item.y, corner: 'ne' },
      { x: item.x, y: item.y + item.h, corner: 'sw' },
      { x: item.x + item.w, y: item.y + item.h, corner: 'se' },
    ];
    for (const c of corners) {
      const cursor = (c.corner === 'nw' || c.corner === 'se') ? 'nwse-resize' : 'nesw-resize';
      hg.appendChild(svgEl('rect', {
        class: 'resize-handle', 'data-corner': c.corner,
        x: c.x - 5, y: c.y - 5, width: '10', height: '10', rx: '2',
        fill: 'rgba(74,158,255,0.9)', stroke: '#fff', 'stroke-width': '1.5', cursor,
      }));
    }
  }

  // ── Nodes ────────────────────────────────────────────────────────────────

  _renderNodes() {
    const d = this.diagram;
    for (const [id, el] of this._nodeEls)
      if (!d.nodes.has(id)) { el.remove(); this._nodeEls.delete(id); }

    for (const node of d.nodes.values()) {
      let el = this._nodeEls.get(node.id);
      if (!el) { el = this._makeNodeEl(node); this.nodeLayer.appendChild(el); this._nodeEls.set(node.id, el); }
      this._updateNodeEl(el, node);
    }
  }

  _makeNodeEl(node) {
    const g = svgEl('g', { 'data-id': node.id, cursor: 'pointer' });
    // nd = node-decoration: functional motif, pointer-events off, never overridden by _updateNodeEl

    if (node.type === NodeType.POOL) {
      g.appendChild(svgEl('circle', { class: 'ns', r: '32' }));
      g.appendChild(svgEl('circle', { class: 'ns-color-ring', r: '26', fill: 'none', 'stroke-width': '4', opacity: '0.5' }));
    } else if (node.type === NodeType.SOURCE) {
      g.appendChild(svgEl('polygon', { class: 'ns', points: '0,-32 28,16 -28,16' }));
      // Emit motif: upward arrow pointing toward apex (resources generated, flowing out)
      g.appendChild(svgEl('path', { class: 'nd', d: 'M 0,14 V 4 M -4,8 L 0,4 L 4,8',
        fill: 'none', stroke: NODE_STROKE.source, 'stroke-width': '2',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
    } else if (node.type === NodeType.DRAIN) {
      g.appendChild(svgEl('polygon', { class: 'ns', points: '0,32 -28,-16 28,-16' }));
      // Absorb motif: downward arrow pointing toward drain tip (resources consumed)
      g.appendChild(svgEl('path', { class: 'nd', d: 'M 0,8 V 18 M -4,14 L 0,18 L 4,14',
        fill: 'none', stroke: NODE_STROKE.drain, 'stroke-width': '2',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
    } else if (node.type === NodeType.GATE) {
      g.appendChild(svgEl('polygon', { class: 'ns', points: '0,-34 34,0 0,34 -34,0' }));
      // Fork motif: Y-split showing one-in, many-out routing
      g.appendChild(svgEl('path', { class: 'nd', d: 'M 0,10 V 16 M 0,16 L -7,22 M 0,16 L 7,22',
        fill: 'none', stroke: NODE_STROKE.gate, 'stroke-width': '2',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
    } else if (node.type === NodeType.CONVERTER) {
      g.appendChild(svgEl('circle', { class: 'ns ns-back', cx: '-14', r: '24' }));
      g.appendChild(svgEl('circle', { class: 'ns', cx: '14', r: '24' }));
      g.appendChild(svgEl('line', { x1: '0', y1: '-18', x2: '0', y2: '18', stroke: '#667', 'stroke-width': '1.5' }));
      // Transform motif: right-pointing arrow across the divider (input left → output right)
      g.appendChild(svgEl('path', { class: 'nd', d: 'M -6,14 H 4 M 1,11 L 4,14 L 1,17',
        fill: 'none', stroke: NODE_STROKE.converter, 'stroke-width': '2',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
    } else if (node.type === NodeType.REGISTER) {
      g.appendChild(svgEl('rect', { class: 'ns', x: '-44', y: '-30', width: '88', height: '60', rx: '6' }));
      // Value-store motif: two stacked bars (stored variable rows)
      g.appendChild(svgEl('path', { class: 'nd', d: 'M -12,13 H 12 M -8,20 H 8',
        fill: 'none', stroke: NODE_STROKE.register, 'stroke-width': '2',
        'stroke-linecap': 'round', 'pointer-events': 'none' }));
    } else if (node.type === NodeType.DELAY) {
      g.appendChild(svgEl('circle', { class: 'ns', r: '32' }));
      g.appendChild(svgEl('circle', { class: 'delay-ring', r: '24', fill: 'none', 'stroke-dasharray': '5,3', 'stroke-width': '1.5' }));
      // Clock motif: pivot dot + two hands (resources deferred over time)
      g.appendChild(svgEl('circle', { class: 'nd', cx: '0', cy: '14', r: '1.8',
        fill: NODE_STROKE.delay, 'pointer-events': 'none' }));
      g.appendChild(svgEl('path', { class: 'nd', d: 'M 0,14 V 8 M 0,14 L 5,18',
        fill: 'none', stroke: NODE_STROKE.delay, 'stroke-width': '2',
        'stroke-linecap': 'round', 'pointer-events': 'none' }));
    } else if (node.type === NodeType.QUEUE) {
      g.appendChild(svgEl('circle', { class: 'ns', r: '32' }));
      // FIFO motif: entry arrow feeding into three waiting items
      const qc = NODE_STROKE.queue;
      g.appendChild(svgEl('path', { class: 'nd', d: 'M -20,14 H -13 M -16,11 L -13,14 L -16,17',
        fill: 'none', stroke: qc, 'stroke-width': '1.8',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
      for (const x of [-6, 2, 10])
        g.appendChild(svgEl('circle', { class: 'q-dot nd', cx: x, cy: '14', r: '2.5',
          fill: qc, 'pointer-events': 'none' }));
    } else if (node.type === NodeType.TRADER) {
      g.appendChild(svgEl('circle', { class: 'ns', r: '32' }));
      // Exchange motif (⇄): two opposing arrows
      const tc = NODE_STROKE.trader;
      g.appendChild(svgEl('path', { d: 'M -11,11 H 9 M 5,7 L 9,11 L 5,15',
        fill: 'none', stroke: tc, 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      g.appendChild(svgEl('path', { d: 'M 11,19 H -9 M -5,15 L -9,19 L -5,23',
        fill: 'none', stroke: tc, 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }

    g.appendChild(svgEl('text', { class: 'n-count', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'pointer-events': 'none' }));
    g.appendChild(svgEl('text', { class: 'n-label', 'text-anchor': 'middle', y: '50', 'pointer-events': 'none' }));
    g.appendChild(svgEl('text', { class: 'n-badge', 'text-anchor': 'middle', y: '-42', 'pointer-events': 'none' }));
    return g;
  }

  _updateNodeEl(el, node) {
    el.setAttribute('transform', `translate(${node.x},${node.y})`);

    const isSel = this.selectedId === node.id || this.selectedIds.has(node.id);
    const isFiring = this._firing.has(node.id);
    el.setAttribute('class', ['node', `n-${node.type}`, isSel && 'selected', isFiring && 'firing']
      .filter(Boolean).join(' '));

    const fill = NODE_FILL[node.type] || '#1a2a3a';
    const stroke = NODE_STROKE[node.type] || '#4a9eff';
    for (const s of el.querySelectorAll('.ns')) {
      s.setAttribute('fill', fill);
      s.setAttribute('stroke', stroke);
      s.setAttribute('stroke-width', isSel ? '3' : '2');
    }
    if (isSel) el.querySelectorAll('.ns').forEach(s => s.setAttribute('filter', 'url(#glow)'));
    else el.querySelectorAll('.ns').forEach(s => s.removeAttribute('filter'));

    // Color ring on pool showing dominant resource color
    const ring = el.querySelector('.ns-color-ring');
    if (ring) {
      const dc = node.displayColor;
      ring.setAttribute('stroke', dc || 'transparent');
      ring.setAttribute('opacity', dc ? '0.6' : '0');
    }

    const delayRing = el.querySelector('.delay-ring');
    if (delayRing) delayRing.setAttribute('stroke', stroke);

    // Source: tint triangle with resource color
    if (node.type === NodeType.SOURCE) {
      const shape = el.querySelector('.ns');
      if (shape && node.resourceColor) {
        shape.setAttribute('fill', this._tintFill(NODE_FILL.source, node.resourceColor, 0.35));
        shape.setAttribute('stroke', node.resourceColor);
      }
    }

    // Converter: left circle = held input color, right circle = output color
    if (node.type === NodeType.CONVERTER) {
      const back = el.querySelector('.ns-back');
      const front = [...el.querySelectorAll('.ns')].find(s => !s.classList.contains('ns-back'));
      const inColor = dominantColor(node.colorMap);
      if (back && inColor) back.setAttribute('fill', this._tintFill(NODE_FILL.converter, inColor, 0.4));
      if (front && node.outputColor) {
        front.setAttribute('fill', this._tintFill(NODE_FILL.converter, node.outputColor, 0.4));
        front.setAttribute('stroke', node.outputColor);
      }
    }

    el.querySelector('.n-count').textContent = node.displayCount;

    const lbl = el.querySelector('.n-label');
    lbl.textContent = node.label;
    if (node.type === NodeType.REGISTER && node.formula) {
      lbl.textContent = `${node.label} (${node.formula})`;
    }

    const badge = el.querySelector('.n-badge');
    const bMap = { passive: 'P', interactive: '▶', starting: '1×', automatic: '' };
    let b = bMap[node.activation] ?? '';
    if (node.flowMode === 'pull') b = '↤' + (b ? ' ' + b : '');
    if (node.endEnabled) b = (b ? b + ' ' : '') + '🏁';
    badge.textContent = b;
  }

  // Blend fill color with tint
  _tintFill(base, tint, amount) {
    try {
      const parse = h => [
        parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)
      ];
      const [br, bg, bb] = parse(base);
      const [tr, tg, tb] = parse(tint);
      const r = Math.round(br * (1 - amount) + tr * amount);
      const g = Math.round(bg * (1 - amount) + tg * amount);
      const b = Math.round(bb * (1 - amount) + tb * amount);
      return `rgb(${r},${g},${b})`;
    } catch { return base; }
  }

  // ── Temp connection line ─────────────────────────────────────────────────

  setTempConn(x1, y1, x2, y2, type = ConnectionType.RESOURCE) {
    this.tempLayer.innerHTML = '';
    const color = type === ConnectionType.RESOURCE ? '#ffa726' : '#78909c';
    this.tempLayer.appendChild(svgEl('line', {
      x1, y1, x2, y2, stroke: color, 'stroke-width': '2', 'stroke-dasharray': '8,5',
      'marker-end': `url(#arrow-${type === ConnectionType.RESOURCE ? 'resource' : 'state'})`,
    }));
  }

  clearTemp() { this.tempLayer.innerHTML = ''; if (this._marqueeEl) this._marqueeEl = null; }

  // ── Marquee (rubber-band) selection rectangle ──────────────────────────────

  setMarquee(x0, y0, x1, y1) {
    if (!this._marqueeEl) {
      this._marqueeEl = svgEl('rect', {
        fill: 'rgba(74,158,255,0.12)', stroke: '#4a9eff',
        'stroke-width': '1', 'stroke-dasharray': '4,3', 'pointer-events': 'none',
      });
      this.tempLayer.appendChild(this._marqueeEl);
    }
    this._marqueeEl.setAttribute('x', Math.min(x0, x1));
    this._marqueeEl.setAttribute('y', Math.min(y0, y1));
    this._marqueeEl.setAttribute('width', Math.abs(x1 - x0));
    this._marqueeEl.setAttribute('height', Math.abs(y1 - y0));
  }

  clearMarquee() { if (this._marqueeEl) { this._marqueeEl.remove(); this._marqueeEl = null; } }

  // Ids of nodes whose center falls inside the rectangle.
  nodesInRect(x0, y0, x1, y1) {
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
    const ids = [];
    for (const node of this.diagram.nodes.values())
      if (node.x >= xa && node.x <= xb && node.y >= ya && node.y <= yb) ids.push(node.id);
    return ids;
  }

  // ── Hit test ─────────────────────────────────────────────────────────────

  hitTest(x, y) {
    // Hit-test in reverse paint order (topmost-painted wins), so you select
    // what you see. Layer paint order is groups < conns < nodes < charts <
    // notes, so the test order is notes → charts → nodes → conns → groups.

    // Notes paint on top of everything except transient overlays.
    for (const [id] of this._noteEls) {
      const note = this.diagram.notes.get(id);
      if (!note) continue;
      if (x >= note.x && x <= note.x + note.w && y >= note.y && y <= note.y + note.h)
        return { type: 'note', id };
    }

    // Charts paint above nodes/connections.
    for (const [id] of this._chartEls) {
      const chart = this.diagram.charts.get(id);
      if (!chart) continue;
      if (x >= chart.x && x <= chart.x + chart.w && y >= chart.y && y <= chart.y + chart.h)
        return { type: 'chart', id };
    }

    // Nodes paint above connections and groups.
    for (const [id] of this._nodeEls) {
      const node = this.diagram.nodes.get(id);
      if (!node) continue;
      const dx = x - node.x, dy = y - node.y;
      let hit = false;
      if (node.type === NodeType.REGISTER) {
        hit = Math.abs(dx) <= 46 && Math.abs(dy) <= 32;
      } else if (node.type === NodeType.GATE) {
        hit = Math.abs(dx) + Math.abs(dy) <= 38;
      } else if (node.type === NodeType.CONVERTER) {
        hit = Math.hypot(dx - 14, dy) <= 28 || Math.hypot(dx + 14, dy) <= 28;
      } else {
        hit = Math.hypot(dx, dy) <= 36;
      }
      if (hit) return { type: 'node', id };
    }

    // Sample along each connection's real path so the whole line is clickable.
    for (const [id, g] of this._connEls) {
      if (!this.diagram.connections.has(id)) continue;
      const pathEl = g.querySelector('.conn-path');
      if (!pathEl) continue;
      let len;
      try { len = pathEl.getTotalLength(); } catch { continue; }
      if (!len) continue;
      const steps = Math.max(8, Math.floor(len / 12));
      for (let i = 0; i <= steps; i++) {
        const pt = pathEl.getPointAtLength((i / steps) * len);
        if (Math.hypot(x - pt.x, y - pt.y) <= 8) return { type: 'conn', id };
      }
    }

    // Groups are lowest priority — match any click inside their rect.
    for (const [id] of this._groupEls) {
      const grp = this.diagram.groups.get(id);
      if (!grp) continue;
      if (x >= grp.x && x <= grp.x + grp.w && y >= grp.y && y <= grp.y + grp.h)
        return { type: 'group', id };
    }

    return null;
  }
}
