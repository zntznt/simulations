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

  // Ceiling on simultaneously animating dots (see spawn).
  static get MAX_LIVE() { return 240; }

  spawn(pathEl, amount, color, durationMs) {
    if (!pathEl) return;
    // Respect the user's motion preference: transfers still happen, the
    // travelling-ball animation is simply skipped.
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Nothing to animate for, and nothing that would ever clear it. Cleanup runs
    // from requestAnimationFrame, which a browser suspends in a hidden tab while
    // it keeps the setInterval that drives the steps running (throttled). So a
    // run left in a background tab kept producing dots that nothing consumed:
    // measured climbing past 30,000 elements with the step cost going from 27ms
    // to 485ms. Producing only while something can consume keeps the two in step.
    if (typeof document !== 'undefined' && document.hidden) return;
    // Hard ceiling on live dots. They are decoration: past this many the canvas
    // is a solid mass of them anyway, and each one costs a getPointAtLength per
    // frame. A big model at the top of the speed slider used to hold 1,500 at
    // once and drag the page to about 17fps.
    if (this._balls.length >= BallSystem.MAX_LIVE) return;
    const capped = Math.min(amount, 12);
    const pathLen = pathEl.getTotalLength();
    if (pathLen < 1) return;

    const now = performance.now();
    const stagger = Math.min(durationMs * 0.07, 80);

    // Uncolored/default flows travel as warm amber dots (the design's #ffd27a);
    // explicitly typed resources keep their own color so the type still reads.
    if (color === '#ffa726' || color === '#9e9e9e') color = '#ffd27a';

    for (let i = 0; i < capped; i++) {
      const el = svgEl('circle', { r: '3.5', fill: color, opacity: '0', 'pointer-events': 'none' });
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

// ── Live flow readout ──────────────────────────────────────────────────────
// Transient "+N" badges that pulse on a connection's midpoint each step,
// showing the actual amount that flowed (the static label only shows the
// configured rate). Each badge fades in, drifts off the line, and fades out.
class FlowFx {
  constructor(layer) {
    this.layer = layer;
    this._items = [];
    this._running = false;
    this._reduce = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  flash(pathEl, text, color, durationMs) {
    if (!pathEl) return;
    let pathLen;
    try { pathLen = pathEl.getTotalLength(); } catch { return; }
    if (pathLen < 1) return;

    // Midpoint and an upward-ish normal, so the badge sits clear of the line
    // and the static rate label that lives at the midpoint.
    let p, nx = 0, ny = -1;
    try {
      p = pathEl.getPointAtLength(pathLen * 0.5);
      const a = pathEl.getPointAtLength(Math.max(0, pathLen * 0.5 - 2));
      const b = pathEl.getPointAtLength(Math.min(pathLen, pathLen * 0.5 + 2));
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      nx = -dy / len; ny = dx / len;
      if (ny > 0) { nx = -nx; ny = -ny; }  // prefer the upward normal
    } catch { return; }

    const g = svgEl('g', { 'pointer-events': 'none', opacity: '0' });
    // Live readout pill: opaque lime-tint fill so it stays readable over lines.
    const rect = svgEl('rect', { rx: '9', ry: '9', fill: '#242d18', stroke: color, 'stroke-width': '1' });
    const t = svgEl('text', {
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-size': '11', 'font-family': "'JetBrains Mono', monospace", 'font-weight': '600', fill: color,
    });
    t.textContent = text;
    g.appendChild(rect); g.appendChild(t);
    this.layer.appendChild(g);
    try {
      const bb = t.getBBox(), px = 6, py = 3;
      rect.setAttribute('x', bb.x - px); rect.setAttribute('y', bb.y - py);
      rect.setAttribute('width', bb.width + px * 2); rect.setAttribute('height', bb.height + py * 2);
    } catch { /* ignore */ }

    const off = 13;
    this._items.push({
      g, nx, ny, baseX: p.x + nx * off, baseY: p.y + ny * off,
      start: performance.now(), dur: durationMs,
    });
    if (!this._running) this._loop();
  }

  clear() { for (const it of this._items) it.g.remove(); this._items = []; }

  _loop() {
    this._running = true;
    const tick = (now) => {
      this._items = this._items.filter(it => {
        const t = (now - it.start) / it.dur;
        if (t >= 1) { it.g.remove(); return false; }
        const op = t < 0.2 ? t / 0.2 : t > 0.6 ? (1 - t) / 0.4 : 1;
        const drift = this._reduce ? 0 : t * 11;
        it.g.setAttribute('opacity', String(Math.max(0, op)));
        it.g.setAttribute('transform', `translate(${it.baseX + it.nx * drift},${it.baseY + it.ny * drift})`);
        return true;
      });
      if (this._items.length) requestAnimationFrame(tick);
      else this._running = false;
    };
    requestAnimationFrame(tick);
  }
}

// ── Minimap ────────────────────────────────────────────────────────────────
// A small overview of the whole diagram with a draggable viewport rectangle —
// for navigating the large, sprawling models. Drawn on a <canvas> for cheap
// rendering of hundreds of nodes; click/drag re-centres the main view.
class Minimap {
  constructor(container, canvas, diagram, renderer) {
    this.container = container;
    this.canvas = canvas;
    this.diagram = diagram;
    this.renderer = renderer;
    this.visible = false;
    this._mm = null;  // last { scale, offX, offY } mapping world → minimap px
    this._bindInteraction();
  }

  setVisible(v) {
    this.visible = v;
    this.container.classList.toggle('hidden', !v);
    if (v) this.update();
  }

  update() {
    if (!this.visible) return;
    const cv = this.canvas;
    const W = cv.width = cv.clientWidth || 180;
    const H = cv.height = cv.clientHeight || 120;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(13,14,17,0.94)';
    ctx.fillRect(0, 0, W, H);

    const box = this.renderer._contentBounds();
    const vp = this.renderer._viewportWorld();
    if (!box) { this._mm = null; this._drawViewport(ctx, vp, 1, 0, 0); return; }

    // Map the union of content + current viewport so the rectangle is always
    // visible even after panning into empty space.
    const minX = Math.min(box.minX, vp.x0), minY = Math.min(box.minY, vp.y0);
    const maxX = Math.max(box.maxX, vp.x1), maxY = Math.max(box.maxY, vp.y1);
    const pad = 14;
    const cw = Math.max(1, maxX - minX), ch = Math.max(1, maxY - minY);
    const scale = Math.min((W - pad * 2) / cw, (H - pad * 2) / ch);
    const offX = (W - cw * scale) / 2 - minX * scale;
    const offY = (H - ch * scale) / 2 - minY * scale;
    this._mm = { scale, offX, offY };
    const wx = x => x * scale + offX, wy = y => y * scale + offY;

    // Groups as faint rects.
    ctx.fillStyle = 'rgba(138,144,160,0.10)';
    for (const g of this.diagram.groups.values())
      ctx.fillRect(wx(g.x), wy(g.y), g.w * scale, g.h * scale);

    // Connections as hairlines.
    ctx.strokeStyle = 'rgba(120,140,170,0.30)'; ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (const c of this.diagram.connections.values()) {
      const s = this.diagram.nodes.get(c.sourceId), t = this.diagram.nodes.get(c.targetId);
      if (!s || !t) continue;
      ctx.moveTo(wx(s.x), wy(s.y)); ctx.lineTo(wx(t.x), wy(t.y));
    }
    ctx.stroke();

    // Nodes as dots, coloured by type.
    const NS = (typeof NODE_STROKE !== 'undefined') ? NODE_STROKE : {};
    for (const n of this.diagram.nodes.values()) {
      ctx.fillStyle = NS[n.type] || '#4a9eff';
      ctx.beginPath(); ctx.arc(wx(n.x), wy(n.y), 2, 0, Math.PI * 2); ctx.fill();
    }

    this._drawViewport(ctx, vp, scale, offX, offY);
  }

  _drawViewport(ctx, vp, scale, offX, offY) {
    const x = vp.x0 * scale + offX, y = vp.y0 * scale + offY;
    const w = (vp.x1 - vp.x0) * scale, h = (vp.y1 - vp.y0) * scale;
    ctx.fillStyle = 'rgba(182,233,77,0.08)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#b6e94d'; ctx.lineWidth = 1.2;
    ctx.strokeRect(x, y, w, h);
  }

  _panToEvent(e) {
    if (!this._mm) return;
    const rect = this.canvas.getBoundingClientRect();
    const wx = (e.clientX - rect.left - this._mm.offX) / this._mm.scale;
    const wy = (e.clientY - rect.top - this._mm.offY) / this._mm.scale;
    this.renderer.centerOn(wx, wy);
    this.update();
  }

  _bindInteraction() {
    let dragging = false;
    this.canvas.addEventListener('mousedown', (e) => { dragging = true; this._panToEvent(e); e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (dragging) this._panToEvent(e); });
    window.addEventListener('mouseup', () => { dragging = false; });
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
    this._flowing = new Set();     // conn ids that carried flow this step (dash-march)
    this._flowingTimer = null;
    this._firingTimer = null;      // pending setFiring clear (see setFiring)
    this._nodeEls = new Map();
    this._connEls = new Map();
    this._groupEls = new Map();
    this._noteEls = new Map();
    this._chartEls = new Map();
    this._chartHover = null;  // { id, idx } — on-canvas chart hover readout
    this._scrubSnap = null;   // { nodeId: value } — history preview during scrubbing
    this.emphasis = null;     // { nodes:Set, conns:Set } — spotlight (Loops panel)
    this._panX = 0;
    this._panY = 0;
    this._scale = 1;

    this._setup();
    this.balls = new BallSystem(this.ballLayer);
    this.flowFx = new FlowFx(this.flowLayer);
  }

  _setup() {
    const defs = svgEl('defs');

    // Grid — kept fixed to the viewport but its patternTransform tracks the
    // pan/zoom (see _updateTransform), so it visually moves and scales with the
    // content while always covering the screen.
    const pat = svgEl('pattern', { id: 'grid', width: '26', height: '26', patternUnits: 'userSpaceOnUse' });
    pat.appendChild(svgEl('path', { d: 'M26 0L0 0 0 26', fill: 'none', stroke: '#1a1c22', 'stroke-width': '1' }));
    defs.appendChild(pat);
    this._gridPat = pat;

    // Dot overlay
    const pat2 = svgEl('pattern', { id: 'dots', width: '26', height: '26', patternUnits: 'userSpaceOnUse' });
    pat2.appendChild(svgEl('circle', { cx: '0', cy: '0', r: '1', fill: '#22252e' }));
    defs.appendChild(pat2);
    this._dotPat = pat2;

    // Arrow markers. userSpaceOnUse keeps arrowheads a constant size regardless
    // of each path's stroke width.
    const mkArrow = (id, color) => {
      const m = svgEl('marker', { id, markerUnits: 'userSpaceOnUse', markerWidth: '9', markerHeight: '9', refX: '6.5', refY: '4.5', orient: 'auto' });
      m.appendChild(svgEl('path', { d: 'M0,1 L8,4.5 L0,8 Z', fill: color }));
      defs.appendChild(m);
    };
    mkArrow('arrow-resource', '#ffa726');
    mkArrow('arrow-state', '#7f879c');
    mkArrow('arrow-trigger', '#7f879c');
    mkArrow('arrow-sel', '#b6e94d');

    // Glow
    const filt = svgEl('filter', { id: 'glow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
    filt.appendChild(svgEl('feGaussianBlur', { stdDeviation: '5', result: 'b' }));
    const merge = svgEl('feMerge');
    merge.appendChild(svgEl('feMergeNode', { in: 'b' }));
    merge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
    filt.appendChild(merge);
    defs.appendChild(filt);

    this.svg.appendChild(defs);
    this._bgRect = svgEl('rect', { width: '100%', height: '100%', fill: '#0d0e11' });
    this._gridStroke = pat.firstChild;
    this.svg.appendChild(this._bgRect);
    this.svg.appendChild(svgEl('rect', { width: '100%', height: '100%', fill: 'url(#grid)' }));

    // Onboarding hint, shown only while the canvas is completely empty:
    // a ghost of the chase-loop mark above the copy (12c).
    // Lives outside the pan/zoom root so it stays centred in the viewport.
    this._emptyHint = svgEl('g', { 'pointer-events': 'none', visibility: 'hidden' });
    // Nested <svg> anchored at the viewport centre; overflow:visible lets the
    // mark draw around that point without knowing the canvas size.
    const ghostWrap = svgEl('svg', { x: '50%', y: '50%', width: '1', height: '1', overflow: 'visible' });
    const ghostMark = svgEl('g', { transform: 'translate(0,-96) scale(1.7) translate(-16,-16)' });
    for (const d of ['M6.6,12.6 A10,10 0 0 1 25.4,12.6', 'M25.4,19.4 A10,10 0 0 1 6.6,19.4'])
      ghostMark.appendChild(svgEl('path', { d, fill: 'none', stroke: '#2f3542', 'stroke-width': '3', 'stroke-linecap': 'round' }));
    ghostMark.appendChild(svgEl('circle', { cx: '16', cy: '16', r: '3.4', fill: '#2f3542' }));
    ghostWrap.appendChild(ghostMark);
    this._emptyHint.appendChild(ghostWrap);
    // Short lines on purpose: SVG text does not wrap, so the one long sentence
    // this used to be ran 612px wide and was chopped at both ends on any canvas
    // narrower than that, which includes a 1024px window.
    const hintLines = [
      ['An empty economy', '16', '600', '#8a90a0'],
      ['Pick a node from the palette, then click to place it.', '12', '400', '#6b7180'],
      ['Connect nodes with Resource (R) or State (T).', '12', '400', '#6b7180'],
      ['Or browse the starter templates in Library.', '12', '400', '#6b7180'],
    ];
    hintLines.forEach(([txt, size, weight, fill], i) => {
      const t = svgEl('text', {
        x: '50%', y: '50%', transform: `translate(0,${(i - (hintLines.length - 1) / 2) * 24})`,
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
    // Selection handles live here rather than inside the item they belong to.
    // A group's element sits in groupLayer and a connection's in connLayer,
    // both below nodeLayer, so a node parked near a corner covered the handle
    // completely: the press still started a resize (the editor probes handles
    // before the hit test, which is deliberate and correct), so the user
    // pressed a node, the node did not move, and the group silently resized.
    // A plain click was swallowed the same way, leaving the node unselectable
    // there. Note and chart handles never had the problem because their layers
    // already paint above nodeLayer. Drawing every handle above the content
    // makes the hot region and the visible region the same thing again.
    this.handleLayer = svgEl('g');
    this.ballLayer = svgEl('g');
    this.flowLayer = svgEl('g');
    this.tempLayer = svgEl('g');
    this.root.append(this.groupLayer, this.connLayer, this.nodeLayer,
                     this.chartLayer, this.noteLayer, this.handleLayer, this.ballLayer, this.flowLayer, this.tempLayer);
    this.svg.appendChild(this.root);

    this._updateTransform();
  }

  setPan(x, y) { this._panX = x; this._panY = y; this._updateTransform(); }
  // Canvas background override (simulation meta). Empty string restores the
  // theme default. The grid stroke flips dark/light to stay visible.
  setBackground(color) {
    const bg = color || '#0d0e11';
    this._bgRect.setAttribute('fill', bg);
    let light = false;
    const m = /^#([0-9a-f]{6})$/i.exec(bg);
    if (m) {
      const v = parseInt(m[1], 16);
      const lum = 0.299 * (v >> 16 & 255) + 0.587 * (v >> 8 & 255) + 0.114 * (v & 255);
      light = lum > 140;
    }
    if (this._gridStroke) this._gridStroke.setAttribute('stroke', light ? 'rgba(0,0,0,0.13)' : '#1a1c22');
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

  // Mark connections that carried resources this step: they get the dash-march
  // animation until the next step replaces the set (empty array clears it).
  setFlowing(ids) {
    this._flowing = new Set(ids);
    clearTimeout(this._flowingTimer);
    // Fade the march out if the run stops feeding new steps.
    this._flowingTimer = setTimeout(() => { this._flowing.clear(); this.render(); }, 900);
  }

  setFiring(ids) {
    this._firing = new Set(ids);
    this.render();
    // 18e: besides the white flash (CSS), each firing node emits a brief
    // expanding ring. Skipped under prefers-reduced-motion.
    const reduce = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      for (const id of this._firing) {
        const node = this.diagram.nodes.get(id);
        if (!node) continue;
        const r = (NODE_R[node.type] || 32) + 2;
        const ring = svgEl('circle', {
          class: 'fire-ring', cx: node.x, cy: node.y, r: String(r),
          fill: 'none', stroke: '#fff', 'stroke-width': '2', 'pointer-events': 'none',
          style: `transform-origin:${node.x}px ${node.y}px`,
        });
        this.ballLayer.appendChild(ring);
        setTimeout(() => ring.remove(), 300);
      }
    }
    // Cancel the previous flash's timer so a stale one can't clear this set early.
    clearTimeout(this._firingTimer);
    this._firingTimer = setTimeout(() => { this._firing.clear(); this.render(); }, 250);
  }

  // Preview a recorded history snapshot ({ nodeId: value }) on the nodes, or
  // pass null to return to live values. Used by the timeline scrubber.
  setScrub(snap) {
    this._scrubSnap = snap || null;
    this.svg.classList.toggle('scrubbing', !!this._scrubSnap);
    this.render();
  }

  render() {
    // Handles are re-emitted every frame by the item renderers below.
    while (this.handleLayer.firstChild) this.handleLayer.removeChild(this.handleLayer.firstChild);
    this._renderGroups();
    this._renderConns();
    this._renderNodes();
    this._renderCharts();
    this._renderNotes();
    this._applyEmphasis();

    const d = this.diagram;
    const empty = !d.nodes.size && !d.groups.size && !d.notes.size && !d.charts.size;
    this._emptyHint.setAttribute('visibility', empty ? 'visible' : 'hidden');
    if (this.onRender) this.onRender();
  }

  // Spotlight mode (Loops panel): members of `emphasis` render at full
  // strength, everything else fades back. Applied after the sub-renders so it
  // wins over any per-element attributes they set; cleared by setting
  // `emphasis` back to null.
  _applyEmphasis() {
    const em = this.emphasis;
    for (const [id, el] of this._nodeEls)
      el.setAttribute('opacity', !em ? '1' : (em.nodes.has(id) ? '1' : '0.18'));
    for (const [id, el] of this._connEls)
      el.setAttribute('opacity', !em ? '1' : (em.conns.has(id) ? '1' : '0.12'));
    const dim = !em ? '1' : '0.15';
    for (const layer of [this.groupLayer, this.noteLayer, this.chartLayer])
      layer.setAttribute('opacity', dim);
  }

  // World-coordinate rectangle currently visible in the viewport.
  _viewportWorld() {
    const r = this.svg.getBoundingClientRect();
    return {
      x0: -this._panX / this._scale,
      y0: -this._panY / this._scale,
      x1: (r.width - this._panX) / this._scale,
      y1: (r.height - this._panY) / this._scale,
    };
  }

  // Pan so that the world point (wx, wy) sits at the viewport centre (zoom kept).
  centerOn(wx, wy) {
    const r = this.svg.getBoundingClientRect();
    this._panX = r.width / 2 - wx * this._scale;
    this._panY = r.height / 2 - wy * this._scale;
    this._updateTransform();
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
    // Clip the text to the note. Wrapping alone cannot guarantee a fit: it
    // counts characters against a width, so wide glyphs and CJK overrun a line
    // the wrapper believes fits. Unclipped, that text painted outside the note
    // in near-black on the dark canvas, and noteLayer sits above nodeLayer so it
    // covered whatever was to the right. Belt and braces with the hard break in
    // _wrapNoteText.
    const clip = svgEl('clipPath', { id: `noteclip-${note.id}` });
    clip.appendChild(svgEl('rect', { class: 'note-clip-rect' }));
    g.appendChild(clip);
    g.appendChild(svgEl('text', {
      class: 'note-text', 'font-size': '11', 'font-family': 'var(--font)',
      'pointer-events': 'none', 'clip-path': `url(#noteclip-${note.id})`,
    }));
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
    const clipRect = el.querySelector('.note-clip-rect');
    if (clipRect) {
      clipRect.setAttribute('x', String(note.x));
      clipRect.setAttribute('y', String(note.y));
      clipRect.setAttribute('width', String(Math.max(0, note.w)));
      clipRect.setAttribute('height', String(Math.max(0, note.h)));
    }
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
        // A word longer than the line can never fit by moving it down, so break
        // it. Without this a pasted URL was one 57-character "word" emitted as a
        // single line that ran far past the note's edge.
        if (word.length > maxChars) {
          if (line) { result.push(line); line = ''; }
          for (let i = 0; i < word.length; i += maxChars) result.push(word.slice(i, i + maxChars));
          line = result.pop();
          continue;
        }
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
        fill: 'rgba(182,233,77,0.06)', stroke: '#b6e94d',
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
    // Hover overlay (crosshair + value readout), painted above the plot. The
    // background rect is the only pointer target, so mousemove bubbles to here.
    g.appendChild(svgEl('g', { class: 'chart-hover', 'pointer-events': 'none' }));

    const cid = chart.id;
    g.addEventListener('mousemove', (e) => {
      const ctx = g._chartCtx;
      if (!ctx || ctx.n < 2) return;
      const p = this.svgPoint(e.clientX, e.clientY);
      this._chartHover = { id: cid, idx: this._chartIndexAtPoint(ctx, p) };
      this._drawChartHover(g);
    });
    g.addEventListener('mouseleave', () => {
      if (this._chartHover && this._chartHover.id === cid) this._chartHover = null;
      const hov = g.querySelector('.chart-hover');
      while (hov.firstChild) hov.removeChild(hov.firstChild);
    });
    return g;
  }

  _updateChartEl(el, chart) {
    // Shared per-node color (charts.js) so on-canvas charts match the timeline;
    // fall back to a local palette if charts.js isn't loaded (tests, embeds).
    const fallback = ['#4a9eff', '#4caf50', '#ef5350', '#ffa726', '#ba68c8', '#26c6da', '#ffeb3b', '#7c83ff', '#ff7043', '#9ccc65'];
    const colorOf = (id, idx) => (typeof chartSeriesColor === 'function')
      ? chartSeriesColor(this.diagram, id)
      : fallback[idx % fallback.length];
    const isSel = this.selectedId === chart.id;
    el.setAttribute('class', `chart-elem${isSel ? ' selected' : ''}`);

    const bg = el.querySelector('.chart-bg');
    bg.setAttribute('x', chart.x);
    bg.setAttribute('y', chart.y);
    bg.setAttribute('width', chart.w);
    bg.setAttribute('height', chart.h);
    bg.setAttribute('fill', '#0d0e11');
    bg.setAttribute('stroke', isSel ? '#b6e94d' : '#2a2e38');
    bg.setAttribute('stroke-dasharray', isSel ? '5,4' : '');

    const title = el.querySelector('.chart-title');
    title.setAttribute('x', String(chart.x + 8));
    title.setAttribute('y', String(chart.y + 14));
    title.textContent = chart.label || 'Chart';
    title.setAttribute('fill', '#8a90a0');

    this._updateResizeHandles(el, chart, isSel);

    const plot = el.querySelector('.chart-plot');
    const clearPlot = () => { while (plot.firstChild) plot.removeChild(plot.firstChild); };

    const clearHover = () => {
      el._chartCtx = null;
      const hov = el.querySelector('.chart-hover');
      if (hov) while (hov.firstChild) hov.removeChild(hov.firstChild);
    };

    const hint = (msg) => {
      clearPlot();
      const t = svgEl('text', {
        x: String(chart.x + chart.w / 2), y: String(chart.y + chart.h / 2 + 6),
        'text-anchor': 'middle', 'font-size': '10', 'font-family': 'var(--font)', fill: '#6b7180',
      });
      t.textContent = msg;
      plot.appendChild(t);
    };

    const ids = (chart.nodeIds || []).filter(id => this.diagram.nodes.has(id));
    if (!ids.length) { clearHover(); el._plotSig = null; hint('Pick nodes in the panel →'); return; }

    const hist = (this.engine && this.engine.history) ? this.engine.history : [];
    if (hist.length < 2) { clearHover(); el._plotSig = null; hint('Run the simulation to plot'); return; }

    // ponytail: the plot DOM is rebuilt from scratch below — skip it when nothing
    // that affects the drawing changed. Signature folds in everything _drawPlot reads:
    // series set, history length, last value per series (catches scrub edits), type,
    // and box size. Cheaper than rebuilding a growing path on every settled tick.
    const last = hist[hist.length - 1].snap;
    const sig = `${ids.join(',')}|${hist.length}|${chart.chartType || 'line'}|`
      + `${chart.x},${chart.y},${chart.w},${chart.h}|`
      + ids.map(id => last[id] ?? 0).join(',');
    if (el._plotSig === sig) { this._drawChartHover(el); return; }
    el._plotSig = sig;
    clearPlot();

    // Plot geometry (relative to the chart box).
    const padL = 28, padT = 22, padB = 10, padR = 8;
    const x0 = chart.x + padL, y0 = chart.y + padT;
    const plotW = Math.max(10, chart.w - padL - padR);
    const plotH = Math.max(10, chart.h - padT - padB);
    const type = chart.chartType || 'line';

    // Phase portrait: state space instead of time. The first tracked node is
    // the x axis, the second the y axis; the run traces a trajectory whose
    // older segments fade, with a hollow dot at the start and a solid one at
    // the live end. Orbits (predator-prey), spirals toward an equilibrium and
    // runaway curves become visible shapes.
    if (type === 'phase') {
      if (ids.length < 2) { clearHover(); el._plotSig = null; hint('Phase needs two tracked nodes'); return; }
      const xId = ids[0], yId = ids[1];
      const xs = hist.map(h => h.snap[xId] ?? 0);
      const ys = hist.map(h => h.snap[yId] ?? 0);
      let xMin = Math.min(...xs), xMax = Math.max(...xs);
      let yMin = Math.min(...ys), yMax = Math.max(...ys);
      const fmtv = v => String(+Number(v).toFixed(Math.abs(v) < 10 ? 1 : 0));
      const rawX = [xMin, xMax], rawY = [yMin, yMax];
      if (xMax - xMin < 1e-9) { xMin -= 1; xMax += 1; } else { const p = (xMax - xMin) * 0.06; xMin -= p; xMax += p; }
      if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; } else { const p = (yMax - yMin) * 0.06; yMin -= p; yMax += p; }
      const pxAt = v => x0 + ((v - xMin) / (xMax - xMin)) * plotW;
      const pyAt = v => y0 + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
      const pts = xs.map((v, i) => [pxAt(v), pyAt(ys[i])]);
      const xColor = colorOf(xId, 0), yColor = colorOf(yId, 1);
      const baseY = y0 + plotH;

      plot.appendChild(svgEl('path', {
        d: `M ${x0},${y0} L ${x0},${baseY} L ${x0 + plotW},${baseY}`,
        fill: 'none', stroke: '#22252e', 'stroke-width': '1',
      }));
      // Axis extents (raw data range) and axis-node labels in series colors.
      const lbl = (x, y, text, fill, anchor = 'start') => {
        const t = svgEl('text', { x: String(x), y: String(y), 'font-size': '8', 'font-family': 'monospace', fill, 'text-anchor': anchor });
        t.textContent = text;
        plot.appendChild(t);
      };
      lbl(chart.x + 3, y0 + 6, fmtv(rawY[1]), '#6b7180');
      lbl(chart.x + 3, baseY, fmtv(rawY[0]), '#6b7180');
      lbl(x0, baseY + 8, fmtv(rawX[0]), '#6b7180');
      lbl(x0 + plotW, baseY + 8, fmtv(rawX[1]), '#6b7180', 'end');
      const xNode = this.diagram.nodes.get(xId), yNode = this.diagram.nodes.get(yId);
      lbl(x0 + plotW, baseY - 4, (xNode && (xNode.label || xNode.type)) || '', xColor, 'end');
      lbl(x0 + 4, y0 + 6, (yNode && (yNode.label || yNode.type)) || '', yColor);

      // Trajectory in ~12 chunks with rising opacity, so time direction reads
      // at a glance without per-segment elements.
      const chunks = Math.min(12, Math.max(1, pts.length - 1));
      const per = Math.ceil((pts.length - 1) / chunks);
      for (let c = 0; c < chunks; c++) {
        const from = c * per, to = Math.min(pts.length - 1, (c + 1) * per);
        if (to <= from) break;
        const seg = pts.slice(from, to + 1).map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
        plot.appendChild(svgEl('polyline', {
          points: seg, fill: 'none', stroke: yColor, 'stroke-width': '1.5',
          opacity: String((0.18 + 0.72 * ((c + 1) / chunks)).toFixed(2)),
        }));
      }
      const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
      plot.appendChild(svgEl('circle', { cx: sx.toFixed(1), cy: sy.toFixed(1), r: '3', fill: 'none', stroke: yColor, 'stroke-width': '1.2', opacity: '0.7' }));
      plot.appendChild(svgEl('circle', { cx: ex.toFixed(1), cy: ey.toFixed(1), r: '3', fill: yColor }));

      el._chartCtx = { isPhase: true, x0, y0, plotW, plotH, n: hist.length, ids: [xId, yId], colors: [xColor, yColor], hist, chart, type, pts };
      this._drawChartHover(el);
      return;
    }

    let max = 1;
    for (const snap of hist) for (const id of ids) max = Math.max(max, snap.snap[id] ?? 0);

    const n = hist.length;
    const xAt = i => x0 + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
    const yAt = v => y0 + plotH - (v / max) * plotH;

    // Axes (left + baseline) with min/max labels.
    const axis = svgEl('path', {
      d: `M ${x0},${y0} L ${x0},${y0 + plotH} L ${x0 + plotW},${y0 + plotH}`,
      fill: 'none', stroke: '#22252e', 'stroke-width': '1',
    });
    plot.appendChild(axis);
    const maxLbl = svgEl('text', { x: String(chart.x + 3), y: String(y0 + 6), 'font-size': '8', 'font-family': 'monospace', fill: '#6b7180' });
    maxLbl.textContent = String(+max.toFixed(max < 10 ? 1 : 0));
    plot.appendChild(maxLbl);
    const zeroLbl = svgEl('text', { x: String(chart.x + 3), y: String(y0 + plotH), 'font-size': '8', 'font-family': 'monospace', fill: '#6b7180' });
    zeroLbl.textContent = '0';
    plot.appendChild(zeroLbl);

    // One series per tracked node, drawn in the chart's visualization style,
    // plus a live end-value label.
    const baseY = y0 + plotH;
    ids.forEach((id, idx) => {
      const color = colorOf(id, idx);
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

    // Stash the plot geometry so the hover handler can map cursor → step and
    // read values without recomputing, then refresh the overlay in case this
    // chart is the one currently hovered.
    el._chartCtx = { x0, y0, plotW, plotH, max, n: hist.length, ids, colors: ids.map(colorOf), hist, chart, type };
    this._drawChartHover(el);
  }

  // Map between a hovered step index and its x position. Bars lay each step in
  // its own slot (centre at the slot middle); line/area/step space points
  // edge-to-edge across the plot. Both hover hit-testing and the crosshair use
  // these so the readout lands on what you're pointing at.
  _chartIndexAtX(ctx, worldX) {
    let i;
    if (ctx.type === 'bars') i = Math.floor((worldX - ctx.x0) / (ctx.plotW / ctx.n));
    else i = Math.round(((worldX - ctx.x0) / ctx.plotW) * (ctx.n - 1));
    return Math.max(0, Math.min(ctx.n - 1, i));
  }

  // Time-based charts hit-test on x alone; a phase portrait's trajectory
  // wanders in 2D, so it snaps to the nearest recorded point instead.
  _chartIndexAtPoint(ctx, p) {
    if (!ctx.isPhase) return this._chartIndexAtX(ctx, p.x);
    let best = 0, bd = Infinity;
    for (let i = 0; i < ctx.pts.length; i++) {
      const dx = ctx.pts[i][0] - p.x, dy = ctx.pts[i][1] - p.y;
      const dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  }

  _chartXAtIndex(ctx, i) {
    if (ctx.type === 'bars') return ctx.x0 + (i + 0.5) * (ctx.plotW / ctx.n);
    return ctx.x0 + (ctx.n <= 1 ? 0 : (i / (ctx.n - 1)) * ctx.plotW);
  }

  // Crosshair + per-series value readout for the on-canvas chart at the hovered
  // step. Reads el._chartCtx (set by _updateChartEl) and this._chartHover.
  _drawChartHover(el) {
    const hov = el.querySelector('.chart-hover');
    if (!hov) return;
    while (hov.firstChild) hov.removeChild(hov.firstChild);

    const ctx = el._chartCtx, hover = this._chartHover;
    if (!ctx || !hover || hover.id !== el.getAttribute('data-id') || ctx.n < 2) return;

    const i = Math.max(0, Math.min(ctx.n - 1, hover.idx));
    const snap = ctx.hist[i];
    if (!snap) return;
    const rows = [{ t: `Step ${snap.step}`, color: '#9aa3b2' }];
    let cx;

    if (ctx.isPhase) {
      // Phase portrait: ring the snapped trajectory point; the readout shows
      // the (x, y) pair that point represents.
      const [px2, py2] = ctx.pts[i];
      cx = px2;
      hov.appendChild(svgEl('circle', {
        cx: px2.toFixed(1), cy: py2.toFixed(1), r: '4.5',
        fill: 'none', stroke: 'rgba(255,255,255,0.7)', 'stroke-width': '1',
      }));
      hov.appendChild(svgEl('circle', { cx: px2.toFixed(1), cy: py2.toFixed(1), r: '2', fill: ctx.colors[1] }));
      const fmtP = v => String(+Number(v).toFixed(Math.abs(v) < 10 ? 1 : 0));
      ctx.ids.forEach((id, k) => {
        const node = this.diagram.nodes.get(id);
        rows.push({ t: `${node ? (node.label || node.type) : id}: ${fmtP(snap.snap[id] ?? 0)}`, color: ctx.colors[k] });
      });
    } else {
      cx = this._chartXAtIndex(ctx, i);
      const yAt = v => ctx.y0 + ctx.plotH - (v / ctx.max) * ctx.plotH;
      const fmt = v => String(+Number(v).toFixed(ctx.max < 10 ? 1 : 0));

      // Crosshair at the hovered step.
      hov.appendChild(svgEl('line', {
        x1: cx.toFixed(1), y1: ctx.y0, x2: cx.toFixed(1), y2: ctx.y0 + ctx.plotH,
        stroke: 'rgba(255,255,255,0.28)', 'stroke-width': '1', 'stroke-dasharray': '3,3',
      }));

      // A dot on each series and the readout rows.
      ctx.ids.forEach((id, k) => {
        const v = snap.snap[id] ?? 0;
        const color = ctx.colors[k];
        hov.appendChild(svgEl('circle', { cx: cx.toFixed(1), cy: yAt(v).toFixed(1), r: '2.5', fill: color }));
        const node = this.diagram.nodes.get(id);
        rows.push({ t: `${node ? (node.label || node.type) : id}: ${fmt(v)}`, color });
      });
    }

    // Tooltip box, flipped to the left edge if it would overflow the chart.
    const lh = 11, padX = 5, padY = 4, charW = 4.9;
    const tw = Math.max(...rows.map(r => r.t.length)) * charW + padX * 2;
    const th = rows.length * lh + padY * 2;
    let tx = cx + 8;
    if (tx + tw > ctx.chart.x + ctx.chart.w - 2) tx = cx - tw - 8;
    if (tx < ctx.chart.x + 2) tx = ctx.chart.x + 2;
    const ty = ctx.y0;

    hov.appendChild(svgEl('rect', {
      x: tx.toFixed(1), y: ty.toFixed(1), width: tw.toFixed(1), height: th.toFixed(1), rx: '3',
      fill: 'rgba(13,14,17,0.94)', stroke: '#2a2e38', 'stroke-width': '1',
    }));
    rows.forEach((r, k) => {
      const t = svgEl('text', {
        x: (tx + padX).toFixed(1), y: (ty + padY + lh * k + 8).toFixed(1),
        'font-size': '8', 'font-family': 'monospace', fill: r.color,
      });
      t.textContent = r.t;
      hov.appendChild(t);
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
    g.appendChild(svgEl('path', { class: 'conn-hitbox', fill: 'none', stroke: 'transparent', 'stroke-width': '24', cursor: 'pointer' }));
    g.appendChild(svgEl('path', { class: 'conn-path', fill: 'none', 'stroke-width': '2' }));
    const lg = svgEl('g', { class: 'conn-label-g', 'data-conn-id': conn.id, cursor: 'grab' });
    lg.appendChild(svgEl('rect', { class: 'conn-label-bg', rx: '11', ry: '11', 'pointer-events': 'all' }));
    lg.appendChild(svgEl('text', { class: 'conn-label', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': '11', 'pointer-events': 'none' }));
    g.appendChild(lg);
    // State-role badge (✷ trigger / ⊢ activator / Δ modifier), sitting on the
    // line just before the arrowhead.
    g.appendChild(svgEl('g', { class: 'conn-role', 'pointer-events': 'none' }));
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

    // One line language: resource = solid orange 2.5px, state = dashed slate
    // 2px (role carried by the badge, not the line color), selected = lime.
    const baseColor = isRes ? '#ffa726' : '#7f879c';
    const color = isSel ? '#b6e94d' : baseColor;

    // Pull mode: the target draws resources along this connection, so the line
    // reads as fine dots driven from the far end, and the pill says so.
    const isPull = isRes && tgt && (tgt.flowMode === 'pull')
      && (tgt.type === NodeType.POOL || tgt.type === NodeType.DRAIN)
      && src && (src.type === NodeType.POOL || src.type === NodeType.SOURCE);
    // Blocked: an activator is currently disallowing the source node, so
    // nothing can flow here until the condition holds again.
    let isBlocked = false;
    if (isRes && !isPull && this.engine && src) {
      try { isBlocked = !this.engine._nodeEnabled(src, true); } catch (_) {}
    }

    el.querySelector('.conn-hitbox').setAttribute('d', d);

    const path = el.querySelector('.conn-path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', isRes ? '2.5' : '2');
    if (this._flowing && this._flowing.has(conn.id)) path.setAttribute('stroke-dasharray', '6,5');
    else if (!isRes) path.setAttribute('stroke-dasharray', '5,4');
    else path.removeAttribute('stroke-dasharray');
    const marker = isSel ? 'arrow-sel' : (isRes ? 'arrow-resource' : 'arrow-state');
    path.setAttribute('marker-end', `url(#${marker})`);
    // Runtime states (11a): pull = fine dots driven by the target; blocked =
    // the line falls back to 30% while an activator holds the source shut.
    if (isPull && !isSel) { path.setAttribute('stroke-dasharray', '2.5,4'); path.setAttribute('opacity', '0.55'); }
    else if (isBlocked && !isSel) path.setAttribute('opacity', '0.3');
    else path.removeAttribute('opacity');

    // Role badge: a small stamped circle 16px before the arrowhead.
    const roleG = el.querySelector('.conn-role');
    while (roleG.firstChild) roleG.removeChild(roleG.firstChild);
    const role = isTrigger ? { glyph: '✷', color: '#ffd27a' }
      : isActivator ? { glyph: '⊢', color: '#8fe08f' }
      : isModifier ? { glyph: 'Δ', color: '#7cc7ff' }
      : null;
    if (role) {
      try {
        const len = path.getTotalLength();
        if (len > 40) {
          const p = path.getPointAtLength(len - 16);
          roleG.appendChild(svgEl('circle', {
            cx: p.x, cy: p.y, r: '9',
            fill: '#0d0e11', stroke: isSel ? '#b6e94d' : role.color, 'stroke-width': '1.5',
          }));
          const t = svgEl('text', {
            x: p.x, y: p.y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
            'font-size': '10', 'font-family': "'JetBrains Mono', monospace", fill: role.color,
          });
          t.textContent = role.glyph;
          roleG.appendChild(t);
        }
      } catch (_) {}
    }

    const labelG = el.querySelector('.conn-label-g');
    const label = labelG.querySelector('.conn-label');
    const labelBg = labelG.querySelector('.conn-label-bg');
    let txt = conn.label || '';
    // Pill segments: the rate value first, then one glyph per modifier, each in
    // its fixed color (interval cyan, chance purple, condition amber, formula
    // green, modifier blue) so a pill reads the same everywhere (11a).
    const SEG = {
      base: '#e8ebf2', interval: '#26c6da', chance: '#ba68c8',
      cond: '#ffd27a', formula: '#8fe08f', modifier: '#7cc7ff', dim: '#8a90a0',
    };
    let segs = null;   // [{ t, color }] — set for resource pills below
    if (isRes) {
      const fromGate = src && src.type === NodeType.GATE;
      // Show the configured rate at rest so every wire communicates its flow
      // strength — including the default 1, which used to be hidden and left new
      // users unsure a rate was even editable. Gate outputs distribute by weight
      // (shown below), not rate, so they're excluded.
      segs = [];
      if (txt) segs.push({ t: txt, color: SEG.base });
      else if (conn.rateMode === RateMode.DICE) segs.push({ t: conn.dice, color: SEG.base });
      else if (conn.rateMode === RateMode.FORMULA) {
        const f = conn.formula.length > 18 ? conn.formula.slice(0, 17) + '…' : conn.formula;
        segs.push({ t: `ƒ ${f}`, color: SEG.formula });
      } else if (conn.rateMode === RateMode.DISTRIBUTION) {
        const p1 = conn.distParam1 ?? '', p2 = conn.distParam2;
        const d = conn.distType === 'normal' ? `~N(${p1}, ${p2 ?? 1})`
          : conn.distType === 'uniform' ? `~U(${p1}, ${p2 ?? p1})`
          : `~${conn.distType || 'dist'}(${p1})`;
        segs.push({ t: d, color: SEG.base });
      } else if (!fromGate) segs.push({ t: String(conn.rate), color: SEG.base });
      if (conn.interval > 1) segs.push({ t: `⏱${conn.interval}`, color: SEG.interval });
      if (conn.chance < 100) segs.push({ t: `${conn.chance}%`, color: SEG.chance });
      if (conn.colorFilter) segs.push({ t: '●', color: conn.colorFilter });
      if (conn.condEnabled) {
        const ref = conn.condRefMode === 'variable' ? (conn.condVariable || 'var') : 'src';
        const cond = conn.condOperator === 'between'
          ? `if ${ref} in ${Math.min(conn.condValue, conn.condValue2)}..${Math.max(conn.condValue, conn.condValue2)}`
          : `if ${ref}${conn.condOperator}${conn.condValue}`;
        segs.push({ t: cond, color: SEG.cond });
      }
      if (fromGate) {
        const gmode = src.gateMode === 'random' ? 'probabilistic' : src.gateMode;
        // Mirror engine._connWeight so formula weights make the labels live.
        // Drawing a label must not advance the shared RNG: a weight formula can
        // draw random numbers, and the canvas repaints on hover, pan, zoom,
        // selection and every step, so painting was eating draws the run was
        // about to make. The same diagram under the same seed then produced
        // different results depending on how much the user moved the mouse.
        // detectLoops guards its own probes the same way.
        const getW = c => {
          if (!c.weightFormula) { const w = Number(c.weight); return isFinite(w) && w >= 0 ? w : 1; }
          const rng = SimRandom.getState();
          try {
            const w = evalFormula(c.weightFormula, this.diagram.variables);
            return isFinite(w) && w >= 0 ? w : 0;
          } finally { SimRandom.setState(rng); }
        };
        if (gmode === 'probabilistic') {
          const allOuts = [...this.diagram.connections.values()]
            .filter(c => c.sourceId === src.id && c.type === ConnectionType.RESOURCE);
          const totalW = allOuts.reduce((s, c) => s + getW(c), 0);
          if (totalW > 0) {
            const pct = Math.round(getW(conn) / totalW * 100);
            segs.push({ t: `${pct}%`, color: SEG.chance });
          }
        } else if (conn.weightFormula) {
          segs.push({ t: `⚖${conn.weightFormula}`, color: SEG.formula });
        } else if (Number(conn.weight) !== 1) {
          segs.push({ t: `⚖${conn.weight}`, color: SEG.base });
        }
      }
      // The pull pill replaces the rate story: the target decides what moves.
      if (isPull) segs = [{ t: `pull · ${tgt.pullPolicy || 'any'}`, color: SEG.dim }];
      txt = segs.map(s => s.t).join(' ');
    } else if (isTrigger) {
      // The role badge already stamps ✷ on the line; the pill only appears when
      // there is more to say (a label, an every-N rhythm, or a chance).
      txt = conn.label ? `✷ ${conn.label}` : '';
      if ((conn.triggerEvery || 1) > 1) txt += (txt ? '' : '✷') + `/${conn.triggerEvery}`;
      if (conn.triggerChance != null && conn.triggerChance < 100) txt += (txt ? ' ' : '✷ ') + `${conn.triggerChance}%`;
      if (txt) segs = [{ t: txt, color: SEG.cond }];
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
      segs = [{ t: txt, color: SEG.modifier }];
    } else if (isActivator) {
      txt = conn.actOperator === 'between'
        ? `⊢ ${Math.min(conn.actValue, conn.actValue2)}..${Math.max(conn.actValue, conn.actValue2)}`
        : `⊢ ${conn.actOperator}${conn.actValue}`;
      segs = [{ t: txt, color: SEG.formula }];
    } else {
      txt = conn.variableName || conn.label || '';
    }
    if (txt) {
      labelG.style.display = '';
      // Multi-color pills: one tspan per segment. Selection and blocked states
      // override every segment with a single voice (lime / muted).
      while (label.firstChild) label.removeChild(label.firstChild);
      const renderSegs = (segs && segs.length) ? segs : [{ t: txt, color: SEG.base }];
      renderSegs.forEach((s, i) => {
        const ts = document.createElementNS(SVG_NS, 'tspan');
        ts.textContent = (i ? ' ' : '') + s.t;
        ts.setAttribute('fill', isSel ? '#b6e94d' : (isBlocked ? '#565c68' : s.color));
        label.appendChild(ts);
      });
      label.setAttribute('x', lp.x);
      label.setAttribute('y', lp.y);
      try {
        // ponytail: getBBox() forces a synchronous layout flush; the label's size
        // depends only on its text (anchor=middle/central, so it's centred on lp).
        // Cache size keyed on text and reflow only when the string changes.
        let sz = label._sizeCache;
        if (!sz || sz.txt !== txt) {
          const bb = label.getBBox();
          sz = label._sizeCache = { txt, w: bb.width, h: bb.height };
        }
        // 22px-tall pill, radius 11, always opaque and painted above the line.
        const px = 8, h = 22;
        labelBg.setAttribute('x', lp.x - sz.w / 2 - px);
        labelBg.setAttribute('y', lp.y - h / 2);
        labelBg.setAttribute('width', sz.w + px * 2);
        labelBg.setAttribute('height', h);
        labelBg.setAttribute('fill', isSel ? '#242d18' : (isBlocked ? '#16181d' : '#1d2027'));
        labelBg.setAttribute('stroke', isSel ? '#b6e94d' : (isBlocked ? '#22252e' : '#2a2e38'));
        labelBg.setAttribute('stroke-width', '1');
      } catch (_) {}
    } else {
      label.textContent = '';
      labelG.style.display = 'none';
    }

    const isFlowing = this._flowing && this._flowing.has(conn.id);
    el.setAttribute('class', `conn${isSel ? ' selected' : ''}${isFlowing ? ' flowing' : ''}`);

    // Reshape handles — shown only while selected (and never on a self-loop).
    // Drawn into handleLayer for the same reason as the resize handles above.
    if (isSel && src.id !== tgt.id) {
      const hg = svgEl('g', { class: 'conn-handles' });
      this.handleLayer.appendChild(hg);
      for (const h of this.getConnHandles(conn.id)) {
        hg.appendChild(svgEl('circle', {
          class: 'conn-cp-handle', r: '6', cx: h.x, cy: h.y,
          fill: 'rgba(182,233,77,0.25)', stroke: '#b6e94d', 'stroke-width': '1.5', cursor: 'move',
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
    if (!isSel) return;   // handleLayer was cleared at the top of render()
    const hg = svgEl('g', { class: 'resize-handles' });
    this.handleLayer.appendChild(hg);
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
        fill: 'rgba(182,233,77,0.9)', stroke: '#14151a', 'stroke-width': '1.5', cursor,
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
    // Sculpted-shape identity (3a): mono glyphs in a lighter tint of each
    // node's stroke color, fill-level arcs on pools, fading dots on queues.
    const glyph = (txt, attrs) => {
      const t = svgEl('text', {
        class: 'n-glyph nd', 'text-anchor': 'middle', 'pointer-events': 'none', ...attrs,
      });
      t.textContent = txt;
      return t;
    };

    if (node.type === NodeType.POOL) {
      g.appendChild(svgEl('circle', { class: 'ns', r: '32' }));
      // Fill-level chord segment: how full the pool is, at a glance.
      g.appendChild(svgEl('path', { class: 'ns-fill nd', d: '', 'pointer-events': 'none' }));
      g.appendChild(svgEl('circle', { class: 'ns-color-ring', r: '26', fill: 'none', 'stroke-width': '4', opacity: '0.5' }));
    } else if (node.type === NodeType.SOURCE) {
      g.appendChild(svgEl('polygon', { class: 'ns', points: '0,-32 28,16 -28,16', 'stroke-linejoin': 'round' }));
      g.appendChild(glyph('∞', { y: '10', 'font-size': '20', fill: '#8fe08f' }));
    } else if (node.type === NodeType.DRAIN) {
      g.appendChild(svgEl('polygon', { class: 'ns', points: '0,32 -28,-16 28,-16', 'stroke-linejoin': 'round' }));
      g.appendChild(glyph('×', { y: '10', 'font-size': '20', fill: '#ff9e9c' }));
    } else if (node.type === NodeType.GATE) {
      g.appendChild(svgEl('polygon', { class: 'ns', points: '0,-34 34,0 0,34 -34,0', 'stroke-linejoin': 'round' }));
      g.appendChild(glyph('%', { y: '5', 'font-size': '15', fill: '#d79ce2' }));
    } else if (node.type === NodeType.CONVERTER) {
      g.appendChild(svgEl('circle', { class: 'ns ns-back', cx: '-14', r: '24' }));
      g.appendChild(svgEl('circle', { class: 'ns', cx: '14', r: '24' }));
      // Transform motif: small arrow between the overlapping cells (in → out).
      g.appendChild(svgEl('path', { class: 'nd', d: 'M -6,14 H 4 M 1,11 L 4,14 L 1,17',
        fill: 'none', stroke: '#ffd27a', 'stroke-width': '2',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
      // Recipe caption (e.g. 2:1) under the label.
      g.appendChild(svgEl('text', { class: 'n-caption nd', 'text-anchor': 'middle', y: '64', 'pointer-events': 'none' }));
    } else if (node.type === NodeType.REGISTER) {
      g.appendChild(svgEl('rect', { class: 'ns', x: '-44', y: '-30', width: '88', height: '60', rx: '9' }));
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
      // FIFO motif: three fading dots — the line itself.
      [1, 0.7, 0.4].forEach((op, i) => {
        g.appendChild(svgEl('circle', { class: 'q-dot nd', cx: String(-8 + i * 8), cy: '14', r: '2.8',
          fill: '#a9adff', opacity: String(op), 'pointer-events': 'none' }));
      });
    } else if (node.type === NodeType.TRADER) {
      g.appendChild(svgEl('circle', { class: 'ns', r: '32' }));
      // Exchange motif (⇄): two opposing arrows
      const tc = '#ffa8c5';
      g.appendChild(svgEl('path', { class: 'nd', d: 'M -11,11 H 9 M 5,7 L 9,11 L 5,15',
        fill: 'none', stroke: tc, 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
      g.appendChild(svgEl('path', { class: 'nd', d: 'M 11,19 H -9 M -5,15 L -9,19 L -5,23',
        fill: 'none', stroke: tc, 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
    }

    // Selection = dashed lime orbit around the node (no glow, no halo).
    const orbitR = (NODE_R[node.type] || 32) + 7;
    const orbit = node.type === NodeType.REGISTER
      ? svgEl('rect', { class: 'sel-orbit', x: '-51', y: '-37', width: '102', height: '74', rx: '14' })
      : svgEl('circle', { class: 'sel-orbit', r: String(orbitR) });
    orbit.setAttribute('fill', 'none');
    orbit.setAttribute('stroke', '#b6e94d');
    orbit.setAttribute('stroke-width', '1.8');
    orbit.setAttribute('stroke-dasharray', '5,4');
    orbit.setAttribute('pointer-events', 'none');
    orbit.setAttribute('visibility', 'hidden');
    g.appendChild(orbit);

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

    const fill = NODE_FILL[node.type] || '#10233f';
    const stroke = NODE_STROKE[node.type] || '#4a9eff';
    for (const s of el.querySelectorAll('.ns')) {
      s.setAttribute('fill', fill);
      s.setAttribute('stroke', stroke);
      s.setAttribute('stroke-width', '2.5');
    }
    // Selection = dashed lime orbit (no glow filter, no halo).
    const orbit = el.querySelector('.sel-orbit');
    if (orbit) orbit.setAttribute('visibility', isSel ? 'visible' : 'hidden');

    // Pool fill level: a chord segment whose height tracks resources/capacity.
    if (node.type === NodeType.POOL) {
      const fillPath = el.querySelector('.ns-fill');
      if (fillPath) {
        const cap = node.capacity;
        let p = (isFinite(cap) && cap > 0) ? node.resources / cap : 0;
        p = Math.max(0, Math.min(1, p));
        if (p > 0.02) {
          const r = 32;
          const dy = r - 2 * r * p;                       // chord height (down = +)
          const w = Math.sqrt(Math.max(0, r * r - dy * dy));
          const largeArc = p > 0.5 ? 1 : 0;
          fillPath.setAttribute('d', `M ${-w},${dy} A ${r},${r} 0 ${largeArc} 0 ${w},${dy} Z`);
          fillPath.setAttribute('fill', this._hexToRgba(node.displayColor || stroke, 0.22));
        } else {
          fillPath.setAttribute('d', '');
        }
      }
    }

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
      if (back && inColor) back.setAttribute('fill', this._tintFill(NODE_FILL.converter, inColor, 0.25));
      if (front && node.outputColor) {
        front.setAttribute('fill', this._tintFill(NODE_FILL.converter, node.outputColor, 0.25));
        front.setAttribute('stroke', node.outputColor);
      }
    }

    // During history scrubbing, show the recorded value for this step instead
    // of the live count (falls back to the live count for nodes not recorded,
    // e.g. unlimited sources).
    const countEl = el.querySelector('.n-count');
    let countTxt;
    if (this._scrubSnap && node.id in this._scrubSnap) {
      const v = this._scrubSnap[node.id];
      countTxt = String(Number.isInteger(v) ? v : +Number(v).toFixed(2));
    } else {
      countTxt = String(node.displayCount);
    }
    // Glyph-bearing shapes show their identity glyph (∞ × %) until there is a
    // live number worth reading; then the number takes the spot.
    const glyphEl = el.querySelector('.n-glyph');
    if (node.type === NodeType.SOURCE) {
      if (countTxt === '∞') countTxt = '';
    } else if (node.type === NodeType.DRAIN || node.type === NodeType.GATE) {
      if (countTxt === '0') countTxt = '';
    } else if (node.type === NodeType.REGISTER && countTxt) {
      countTxt = `ƒx ${countTxt}`;
    }
    if (glyphEl) glyphEl.setAttribute('opacity', countTxt ? '0' : '1');
    countEl.textContent = countTxt;

    const lbl = el.querySelector('.n-label');
    lbl.textContent = node.label;

    // Converter recipe caption (e.g. 2:1) in mono under the label.
    if (node.type === NodeType.CONVERTER) {
      const cap = el.querySelector('.n-caption');
      if (cap) {
        const inN = (node.inputRecipe && node.inputRecipe.length)
          ? node.inputRecipe.reduce((s, r) => s + (Number(r.amount) || 0), 0)
          : (Number(node.inputAmount) || 1);
        cap.textContent = `${inN}:1`;
      }
    }

    const badge = el.querySelector('.n-badge');
    const bMap = { passive: 'P', interactive: '▶', starting: '1×', automatic: '' };
    let b = bMap[node.activation] ?? '';
    if (node.flowMode === 'pull') b = '↤' + (b ? ' ' + b : '');
    if (node.type === NodeType.QUEUE && (node.servers || 1) > 1) b = (b ? b + ' ' : '') + `×${node.servers}`;
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
    this._connectHoverEl = null; // cleared with innerHTML above
    const color = type === ConnectionType.RESOURCE ? '#ffa726' : '#7f879c';
    this.tempLayer.appendChild(svgEl('line', {
      x1, y1, x2, y2, stroke: color, 'stroke-width': '2', 'stroke-dasharray': '8,5',
      'marker-end': `url(#arrow-${type === ConnectionType.RESOURCE ? 'resource' : 'state'})`,
    }));
  }

  clearTemp() {
    this.tempLayer.innerHTML = '';
    this._marqueeEl = null;
    this._connectHoverEl = null;
  }

  // Draw (or clear) a dashed ring on a node in the temp layer while a connect
  // tool is active — shows which node the user is about to connect from/to.
  setConnectHover(nodeId, type) {
    // Wipe any previous hover ring (it lives in tempLayer so setTempConn also wipes it,
    // but we keep a reference so we can remove it cheaply when the tool changes).
    if (this._connectHoverEl) { this._connectHoverEl.remove(); this._connectHoverEl = null; }
    if (!nodeId) return;
    const node = this.diagram.nodes.get(nodeId);
    if (!node) return;
    const color = type === ConnectionType.STATE ? '#7f879c' : '#ffa726';
    const r = (NODE_R[node.type] || 32) + 7;
    this._connectHoverEl = svgEl('circle', {
      cx: node.x, cy: node.y, r,
      fill: 'none', stroke: color, 'stroke-width': '2',
      opacity: '0.7', 'stroke-dasharray': '4,3', 'pointer-events': 'none',
    });
    this.tempLayer.appendChild(this._connectHoverEl);
  }

  // ── Marquee (rubber-band) selection rectangle ──────────────────────────────

  setMarquee(x0, y0, x1, y1) {
    if (!this._marqueeEl) {
      this._marqueeEl = svgEl('rect', {
        fill: 'rgba(182,233,77,0.10)', stroke: '#b6e94d',
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
    // Within a layer the cache Maps hold insertion (= paint) order, so each
    // loop walks its cache in reverse to test the topmost element first.

    // Notes paint on top of everything except transient overlays.
    for (const id of [...this._noteEls.keys()].reverse()) {
      const note = this.diagram.notes.get(id);
      if (!note) continue;
      if (x >= note.x && x <= note.x + note.w && y >= note.y && y <= note.y + note.h)
        return { type: 'note', id };
    }

    // Charts paint above nodes/connections.
    for (const id of [...this._chartEls.keys()].reverse()) {
      const chart = this.diagram.charts.get(id);
      if (!chart) continue;
      if (x >= chart.x && x <= chart.x + chart.w && y >= chart.y && y <= chart.y + chart.h)
        return { type: 'chart', id };
    }

    // Nodes paint above connections and groups.
    for (const id of [...this._nodeEls.keys()].reverse()) {
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
    for (const [id, g] of [...this._connEls].reverse()) {
      if (!this.diagram.connections.has(id)) continue;
      const pathEl = g.querySelector('.conn-path');
      if (!pathEl) continue;
      let len;
      try { len = pathEl.getTotalLength(); } catch { continue; }
      if (!len) continue;
      const steps = Math.max(16, Math.floor(len / 6));
      for (let i = 0; i <= steps; i++) {
        const pt = pathEl.getPointAtLength((i / steps) * len);
        if (Math.hypot(x - pt.x, y - pt.y) <= 12) return { type: 'conn', id };
      }
    }

    // Groups are lowest priority — match any click inside their rect.
    for (const id of [...this._groupEls.keys()].reverse()) {
      const grp = this.diagram.groups.get(id);
      if (!grp) continue;
      if (x >= grp.x && x <= grp.x + grp.w && y >= grp.y && y <= grp.y + grp.h)
        return { type: 'group', id };
    }

    return null;
  }
}
