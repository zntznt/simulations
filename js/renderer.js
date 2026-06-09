const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const NODE_R = { pool: 32, source: 32, drain: 32, gate: 34, converter: 36, register: 32, delay: 32, queue: 32 };

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

function connPathD(src, tgt) {
  if (src.id === tgt.id) {
    // Self-loop: a small loop above the node (used by self state modifiers).
    const r = NODE_R[src.type] || 32;
    const x = src.x, y = src.y;
    return `M ${x - r * 0.55},${y - r * 0.8} C ${x - r * 1.6},${y - r * 2.6} `
         + `${x + r * 1.6},${y - r * 2.6} ${x + r * 0.55},${y - r * 0.8}`;
  }
  const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
  const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  // Slight perpendicular curve
  const cx = mx - dy * 0.12, cy = my + dx * 0.12;
  return `M ${p1.x},${p1.y} Q ${cx},${cy} ${p2.x},${p2.y}`;
}

function connLabelPos(src, tgt) {
  if (src.id === tgt.id) {
    const r = NODE_R[src.type] || 32;
    return { x: src.x, y: src.y - r * 2.2 };
  }
  const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
  const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  return { x: (p1.x + p2.x) / 2 - dy * 0.12 - 12, y: (p1.y + p2.y) / 2 + dx * 0.12 - 10 };
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
  constructor(svg, diagram) {
    this.svg = svg;
    this.diagram = diagram;
    this.selectedId = null;        // primary selection (node or connection)
    this.selectedIds = new Set();  // multi-selected node ids
    this._firing = new Set();
    this._nodeEls = new Map();
    this._connEls = new Map();
    this._groupEls = new Map();
    this._noteEls = new Map();
    this._panX = 0;
    this._panY = 0;
    this._scale = 1;

    this._setup();
    this.balls = new BallSystem(this.ballLayer);
  }

  _setup() {
    const defs = svgEl('defs');

    // Grid
    const pat = svgEl('pattern', { id: 'grid', width: '40', height: '40', patternUnits: 'userSpaceOnUse' });
    pat.appendChild(svgEl('path', { d: 'M40 0L0 0 0 40', fill: 'none', stroke: '#1a2035', 'stroke-width': '0.6' }));
    defs.appendChild(pat);

    // Dot overlay
    const pat2 = svgEl('pattern', { id: 'dots', width: '40', height: '40', patternUnits: 'userSpaceOnUse' });
    pat2.appendChild(svgEl('circle', { cx: '0', cy: '0', r: '1', fill: '#1e2840' }));
    defs.appendChild(pat2);

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
    this.svg.appendChild(svgEl('rect', { width: '100%', height: '100%', fill: '#0f1117' }));
    this.svg.appendChild(svgEl('rect', { width: '100%', height: '100%', fill: 'url(#grid)' }));

    this.root = svgEl('g', { id: 'root' });
    this.groupLayer = svgEl('g');
    this.connLayer = svgEl('g');
    this.nodeLayer = svgEl('g');
    this.noteLayer = svgEl('g');
    this.ballLayer = svgEl('g');
    this.tempLayer = svgEl('g');
    this.root.append(this.groupLayer, this.connLayer, this.nodeLayer, this.noteLayer, this.ballLayer, this.tempLayer);
    this.svg.appendChild(this.root);

    this._updateTransform();
  }

  setPan(x, y) { this._panX = x; this._panY = y; this._updateTransform(); }
  _updateTransform() {
    this.root.setAttribute('transform', `translate(${this._panX},${this._panY}) scale(${this._scale})`);
  }

  // Zoom by `factor` keeping the point under (clientX, clientY) fixed.
  zoomBy(factor, clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    const sx = clientX - r.left, sy = clientY - r.top;
    const wx = (sx - this._panX) / this._scale;
    const wy = (sy - this._panY) / this._scale;
    this._scale = Math.max(0.25, Math.min(3, this._scale * factor));
    this._panX = sx - wx * this._scale;
    this._panY = sy - wy * this._scale;
    this._updateTransform();
  }

  resetView() { this._panX = 0; this._panY = 0; this._scale = 1; this._updateTransform(); }

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
    this._renderNotes();
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
    g.appendChild(svgEl('text', { class: 'conn-label', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': '11', 'font-family': 'var(--font)' }));
    return g;
  }

  _updateConnEl(el, conn, src, tgt) {
    const isRes = conn.type === ConnectionType.RESOURCE;
    const isTrigger = !isRes && conn.trigger;
    const isActivator = !isRes && conn.activator;
    const isModifier = !isRes && conn.modifier;
    const isSel = this.selectedId === conn.id;
    const d = connPathD(src, tgt);
    const lp = connLabelPos(src, tgt);

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

    const label = el.querySelector('.conn-label');
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
    } else if (isModifier) {
      txt = `Δ ${conn.modFactor > 0 ? '+' : ''}${conn.modFactor}×`;
    } else if (isActivator) {
      txt = `⊢ ${conn.actOperator}${conn.actValue}`;
    } else {
      txt = conn.variableName || conn.label || '';
    }
    label.textContent = txt;
    label.setAttribute('x', lp.x);
    label.setAttribute('y', lp.y);
    label.setAttribute('fill', color);

    el.setAttribute('class', `conn${isSel ? ' selected' : ''}`);
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

    if (node.type === NodeType.POOL) {
      g.appendChild(svgEl('circle', { class: 'ns', r: '32' }));
      g.appendChild(svgEl('circle', { class: 'ns-color-ring', r: '26', fill: 'none', 'stroke-width': '4', opacity: '0.5' }));
    } else if (node.type === NodeType.SOURCE) {
      g.appendChild(svgEl('polygon', { class: 'ns', points: '0,-32 28,16 -28,16' }));
    } else if (node.type === NodeType.DRAIN) {
      g.appendChild(svgEl('polygon', { class: 'ns', points: '0,32 -28,-16 28,-16' }));
    } else if (node.type === NodeType.GATE) {
      g.appendChild(svgEl('polygon', { class: 'ns', points: '0,-34 34,0 0,34 -34,0' }));
    } else if (node.type === NodeType.CONVERTER) {
      g.appendChild(svgEl('circle', { class: 'ns ns-back', cx: '-14', r: '24' }));
      g.appendChild(svgEl('circle', { class: 'ns', cx: '14', r: '24' }));
      g.appendChild(svgEl('line', { x1: '0', y1: '-18', x2: '0', y2: '18', stroke: '#667', 'stroke-width': '1.5' }));
    } else if (node.type === NodeType.REGISTER) {
      g.appendChild(svgEl('rect', { class: 'ns', x: '-44', y: '-30', width: '88', height: '60', rx: '6' }));
    } else if (node.type === NodeType.DELAY) {
      g.appendChild(svgEl('circle', { class: 'ns', r: '32' }));
      g.appendChild(svgEl('circle', { class: 'delay-ring', r: '24', fill: 'none', 'stroke-dasharray': '5,3', 'stroke-width': '1.5' }));
    } else if (node.type === NodeType.QUEUE) {
      g.appendChild(svgEl('circle', { class: 'ns', r: '32' }));
      // FIFO motif: three units lined up near the bottom.
      for (const x of [-8, 0, 8])
        g.appendChild(svgEl('circle', { class: 'q-dot', cx: x, cy: '16', r: '2.2', fill: NODE_STROKE.queue }));
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
    // Nodes have highest priority.
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

    // Notes are rendered above nodes visually; test before connections.
    for (const [id] of this._noteEls) {
      const note = this.diagram.notes.get(id);
      if (!note) continue;
      if (x >= note.x && x <= note.x + note.w && y >= note.y && y <= note.y + note.h)
        return { type: 'note', id };
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
