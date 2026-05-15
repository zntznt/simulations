const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const NODE_R = { pool: 32, source: 32, drain: 32, gate: 34, converter: 36, register: 32, delay: 32 };

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
  const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
  const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  // Slight perpendicular curve
  const cx = mx - dy * 0.12, cy = my + dx * 0.12;
  return `M ${p1.x},${p1.y} Q ${cx},${cy} ${p2.x},${p2.y}`;
}

function connLabelPos(src, tgt) {
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
    this.selectedId = null;
    this._firing = new Set();
    this._nodeEls = new Map();
    this._connEls = new Map();
    this._panX = 0;
    this._panY = 0;

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
    this.connLayer = svgEl('g');
    this.nodeLayer = svgEl('g');
    this.ballLayer = svgEl('g');
    this.tempLayer = svgEl('g');
    this.root.append(this.connLayer, this.nodeLayer, this.ballLayer, this.tempLayer);
    this.svg.appendChild(this.root);

    this._updateTransform();
  }

  setPan(x, y) { this._panX = x; this._panY = y; this._updateTransform(); }
  _updateTransform() { this.root.setAttribute('transform', `translate(${this._panX},${this._panY})`); }

  svgPoint(cx, cy) {
    const r = this.svg.getBoundingClientRect();
    return { x: cx - r.left - this._panX, y: cy - r.top - this._panY };
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
    this._renderConns();
    this._renderNodes();
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
    const isSel = this.selectedId === conn.id;
    const d = connPathD(src, tgt);
    const lp = connLabelPos(src, tgt);

    el.querySelector('.conn-hitbox').setAttribute('d', d);

    const path = el.querySelector('.conn-path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', isSel ? '#fff' : (isRes ? '#ffa726' : '#78909c'));
    if (!isRes) path.setAttribute('stroke-dasharray', '7,4');
    else path.removeAttribute('stroke-dasharray');
    const marker = isSel ? 'arrow-sel' : (isRes ? 'arrow-resource' : 'arrow-state');
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
    } else {
      txt = conn.variableName || conn.label || '';
    }
    label.textContent = txt;
    label.setAttribute('x', lp.x);
    label.setAttribute('y', lp.y);
    label.setAttribute('fill', isSel ? '#fff' : (isRes ? '#ffa726' : '#78909c'));

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
    }

    g.appendChild(svgEl('text', { class: 'n-count', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'pointer-events': 'none' }));
    g.appendChild(svgEl('text', { class: 'n-label', 'text-anchor': 'middle', y: '50', 'pointer-events': 'none' }));
    g.appendChild(svgEl('text', { class: 'n-badge', 'text-anchor': 'middle', y: '-42', 'pointer-events': 'none' }));
    return g;
  }

  _updateNodeEl(el, node) {
    el.setAttribute('transform', `translate(${node.x},${node.y})`);

    const isSel = this.selectedId === node.id;
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

    el.querySelector('.n-count').textContent = node.displayCount;

    const lbl = el.querySelector('.n-label');
    lbl.textContent = node.label;
    if (node.type === NodeType.REGISTER && node.formula) {
      lbl.textContent = `${node.label} (${node.formula})`;
    }

    const badge = el.querySelector('.n-badge');
    const bMap = { passive: 'P', interactive: '▶', starting: '1×', automatic: '' };
    badge.textContent = bMap[node.activation] ?? '';
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

  clearTemp() { this.tempLayer.innerHTML = ''; }

  // ── Hit test ─────────────────────────────────────────────────────────────

  hitTest(x, y) {
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

    for (const [id] of this._connEls) {
      const conn = this.diagram.connections.get(id);
      if (!conn) continue;
      const src = this.diagram.nodes.get(conn.sourceId);
      const tgt = this.diagram.nodes.get(conn.targetId);
      if (!src || !tgt) continue;
      const mx = (src.x + tgt.x) / 2, my = (src.y + tgt.y) / 2;
      if (Math.hypot(x - mx, y - my) <= 18) return { type: 'conn', id };
    }
    return null;
  }
}
