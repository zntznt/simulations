const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Node geometry constants
const NODE_R = {
  pool: 32, source: 32, drain: 32, gate: 34,
  converter: 36, register: 32, delay: 32,
};

function nodeBoundaryPoint(node, tx, ty) {
  const dx = tx - node.x, dy = ty - node.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = dx / dist, ny = dy / dist;

  if (node.type === NodeType.REGISTER) {
    const hw = 40, hh = 28;
    const tx2 = hw / (Math.abs(nx) || 0.001), ty2 = hh / (Math.abs(ny) || 0.001);
    const t = Math.min(tx2, ty2);
    return { x: node.x + nx * t, y: node.y + ny * t };
  }
  if (node.type === NodeType.GATE) {
    const r = 34;
    const t = r / ((Math.abs(nx) + Math.abs(ny)) || 1);
    return { x: node.x + nx * t, y: node.y + ny * t };
  }
  const r = NODE_R[node.type] || 32;
  return { x: node.x + nx * r, y: node.y + ny * r };
}

function connPath(src, tgt) {
  const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
  const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const perp = { x: -dy * 0.15, y: dx * 0.15 };
  const cx = mx + perp.x, cy = my + perp.y;
  return `M ${p1.x},${p1.y} Q ${cx},${cy} ${p2.x},${p2.y}`;
}

function connLabelPoint(src, tgt) {
  const p1 = nodeBoundaryPoint(src, tgt.x, tgt.y);
  const p2 = nodeBoundaryPoint(tgt, src.x, src.y);
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  return { x: mx - dy * 0.15 - 10, y: my + dx * 0.15 - 10 };
}

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
  }

  _setup() {
    const defs = svgEl('defs');

    // Grid pattern
    const pat = svgEl('pattern', { id: 'grid', width: '40', height: '40', patternUnits: 'userSpaceOnUse' });
    const pl = svgEl('path', { d: 'M 40 0 L 0 0 0 40', fill: 'none', stroke: '#1e2535', 'stroke-width': '0.5' });
    pat.appendChild(pl);
    defs.appendChild(pat);

    // Dot grid overlay
    const pat2 = svgEl('pattern', { id: 'dots', width: '40', height: '40', patternUnits: 'userSpaceOnUse' });
    const dot = svgEl('circle', { cx: '0', cy: '0', r: '1', fill: '#252d40' });
    pat2.appendChild(dot);
    defs.appendChild(pat2);

    // Arrow marker for resource connections
    const marker = svgEl('marker', {
      id: 'arrow-resource', markerWidth: '8', markerHeight: '6',
      refX: '7', refY: '3', orient: 'auto',
    });
    const arrow = svgEl('polygon', { points: '0 0, 8 3, 0 6', fill: '#ffa726' });
    marker.appendChild(arrow);
    defs.appendChild(marker);

    // Arrow marker for state connections
    const marker2 = svgEl('marker', {
      id: 'arrow-state', markerWidth: '8', markerHeight: '6',
      refX: '7', refY: '3', orient: 'auto',
    });
    const arrow2 = svgEl('polygon', { points: '0 0, 8 3, 0 6', fill: '#78909c' });
    marker2.appendChild(arrow2);
    defs.appendChild(marker2);

    // Glow filter
    const filt = svgEl('filter', { id: 'glow', x: '-30%', y: '-30%', width: '160%', height: '160%' });
    const blur = svgEl('feGaussianBlur', { stdDeviation: '4', result: 'blur' });
    const merge = svgEl('feMerge');
    const m1 = svgEl('feMergeNode', { in: 'blur' });
    const m2 = svgEl('feMergeNode', { in: 'SourceGraphic' });
    merge.appendChild(m1); merge.appendChild(m2);
    filt.appendChild(blur); filt.appendChild(merge);
    defs.appendChild(filt);

    this.svg.appendChild(defs);

    // Background
    const bg = svgEl('rect', { width: '100%', height: '100%', fill: '#0f1117' });
    this.svg.appendChild(bg);
    const gridRect = svgEl('rect', { width: '100%', height: '100%', fill: 'url(#grid)' });
    this.svg.appendChild(gridRect);

    // Root group (panned)
    this.root = svgEl('g', { id: 'diagram-root' });
    this.connLayer = svgEl('g');
    this.nodeLayer = svgEl('g');
    this.tempLayer = svgEl('g');
    this.root.appendChild(this.connLayer);
    this.root.appendChild(this.nodeLayer);
    this.root.appendChild(this.tempLayer);
    this.svg.appendChild(this.root);

    this._updatePan();
  }

  setPan(x, y) {
    this._panX = x; this._panY = y;
    this._updatePan();
  }

  _updatePan() {
    this.root.setAttribute('transform', `translate(${this._panX},${this._panY})`);
  }

  svgPoint(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: clientX - rect.left - this._panX,
      y: clientY - rect.top - this._panY,
    };
  }

  setFiring(ids) {
    this._firing = new Set(ids);
    setTimeout(() => { this._firing.clear(); this.render(); }, 200);
    this.render();
  }

  render() {
    this._renderConns();
    this._renderNodes();
  }

  _renderConns() {
    const d = this.diagram;
    // Remove stale
    for (const [id, el] of this._connEls)
      if (!d.connections.has(id)) { el.remove(); this._connEls.delete(id); }

    for (const conn of d.connections.values()) {
      const src = d.nodes.get(conn.sourceId);
      const tgt = d.nodes.get(conn.targetId);
      if (!src || !tgt) continue;

      let el = this._connEls.get(conn.id);
      if (!el) {
        el = this._makeConnEl(conn);
        this.connLayer.appendChild(el);
        this._connEls.set(conn.id, el);
      }
      this._updateConnEl(el, conn, src, tgt);
    }
  }

  _makeConnEl(conn) {
    const g = svgEl('g', { 'data-id': conn.id, class: 'conn' });
    const hitbox = svgEl('path', { class: 'conn-hitbox', fill: 'none', stroke: 'transparent', 'stroke-width': '12', cursor: 'pointer' });
    const path = svgEl('path', { class: 'conn-path', fill: 'none', 'stroke-width': '2' });
    const label = svgEl('text', { class: 'conn-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    g.appendChild(hitbox);
    g.appendChild(path);
    g.appendChild(label);
    return g;
  }

  _updateConnEl(el, conn, src, tgt) {
    const isRes = conn.type === ConnectionType.RESOURCE;
    const isSelected = this.selectedId === conn.id;
    const d = connPath(src, tgt);
    const lp = connLabelPoint(src, tgt);

    el.querySelector('.conn-hitbox').setAttribute('d', d);

    const path = el.querySelector('.conn-path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', isSelected ? '#fff' : (isRes ? '#ffa726' : '#78909c'));
    if (!isRes) path.setAttribute('stroke-dasharray', '6,4');
    else path.removeAttribute('stroke-dasharray');
    path.setAttribute('marker-end', `url(#arrow-${isRes ? 'resource' : 'state'})`);

    const label = el.querySelector('.conn-label');
    const displayRate = (conn.rate !== 1 || conn.label) ? (conn.label || String(conn.rate)) : '';
    label.textContent = displayRate;
    label.setAttribute('x', lp.x);
    label.setAttribute('y', lp.y);
    label.setAttribute('fill', isRes ? '#ffa726' : '#78909c');

    el.setAttribute('class', `conn${isSelected ? ' selected' : ''}`);
  }

  _renderNodes() {
    const d = this.diagram;
    for (const [id, el] of this._nodeEls)
      if (!d.nodes.has(id)) { el.remove(); this._nodeEls.delete(id); }

    for (const node of d.nodes.values()) {
      let el = this._nodeEls.get(node.id);
      if (!el) {
        el = this._makeNodeEl(node);
        this.nodeLayer.appendChild(el);
        this._nodeEls.set(node.id, el);
      }
      this._updateNodeEl(el, node);
    }
  }

  _makeNodeEl(node) {
    const g = svgEl('g', { 'data-id': node.id, class: 'node', cursor: 'pointer' });

    if (node.type === NodeType.POOL) {
      g.appendChild(svgEl('circle', { class: 'node-shape', r: '32' }));
    } else if (node.type === NodeType.SOURCE) {
      g.appendChild(svgEl('polygon', { class: 'node-shape', points: '0,-32 28,16 -28,16' }));
    } else if (node.type === NodeType.DRAIN) {
      g.appendChild(svgEl('polygon', { class: 'node-shape', points: '0,32 -28,-16 28,-16' }));
    } else if (node.type === NodeType.GATE) {
      g.appendChild(svgEl('polygon', { class: 'node-shape', points: '0,-34 34,0 0,34 -34,0' }));
    } else if (node.type === NodeType.CONVERTER) {
      g.appendChild(svgEl('circle', { class: 'node-shape node-shape-bg', cx: '-14', r: '24' }));
      g.appendChild(svgEl('circle', { class: 'node-shape', cx: '14', r: '24' }));
      const line = svgEl('line', { x1: '0', y1: '-18', x2: '0', y2: '18', 'stroke-width': '2', stroke: '#888' });
      g.appendChild(line);
    } else if (node.type === NodeType.REGISTER) {
      g.appendChild(svgEl('rect', { class: 'node-shape', x: '-40', y: '-28', width: '80', height: '56', rx: '6' }));
    } else if (node.type === NodeType.DELAY) {
      g.appendChild(svgEl('circle', { class: 'node-shape', r: '32' }));
      g.appendChild(svgEl('circle', { r: '24', fill: 'none', 'stroke-dasharray': '5,3', 'stroke-width': '1.5', class: 'delay-ring' }));
    }

    const count = svgEl('text', { class: 'node-count', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    g.appendChild(count);

    const lbl = svgEl('text', { class: 'node-label', 'text-anchor': 'middle', y: '50' });
    g.appendChild(lbl);

    // Activation badge
    const badge = svgEl('text', { class: 'node-badge', 'text-anchor': 'middle', y: '-38' });
    g.appendChild(badge);

    return g;
  }

  _updateNodeEl(el, node) {
    el.setAttribute('transform', `translate(${node.x},${node.y})`);

    const classes = ['node', `node-${node.type}`];
    if (this.selectedId === node.id) classes.push('selected');
    if (this._firing.has(node.id)) classes.push('firing');
    el.setAttribute('class', classes.join(' '));

    const fill = NODE_FILL[node.type] || '#1a2a3a';
    const stroke = NODE_STROKE[node.type] || '#4a9eff';
    for (const shape of el.querySelectorAll('.node-shape')) {
      shape.setAttribute('fill', fill);
      shape.setAttribute('stroke', stroke);
      shape.setAttribute('stroke-width', this.selectedId === node.id ? '3' : '2');
    }
    const delayRing = el.querySelector('.delay-ring');
    if (delayRing) delayRing.setAttribute('stroke', stroke);

    el.querySelector('.node-count').textContent = node.displayCount;
    el.querySelector('.node-label').textContent = node.label;

    const badge = el.querySelector('.node-badge');
    const badgeMap = { automatic: '', passive: 'P', interactive: '▶', starting: '1×' };
    badge.textContent = badgeMap[node.activation] || '';

    if (node.type === NodeType.POOL && node.capacity !== Infinity) {
      el.querySelector('.node-count').textContent = `${node.resources}/${node.capacity}`;
    }
  }

  // Draw temp connection line while dragging
  setTempConn(x1, y1, x2, y2, type = ConnectionType.RESOURCE) {
    this.tempLayer.innerHTML = '';
    if (x1 == null) return;
    const color = type === ConnectionType.RESOURCE ? '#ffa726' : '#78909c';
    const line = svgEl('line', {
      x1, y1, x2, y2,
      stroke: color, 'stroke-width': '2', 'stroke-dasharray': '8,4',
      'marker-end': `url(#arrow-${type === ConnectionType.RESOURCE ? 'resource' : 'state'})`,
    });
    this.tempLayer.appendChild(line);
  }

  clearTemp() { this.tempLayer.innerHTML = ''; }

  hitTest(x, y) {
    // Returns {type:'node'|'conn', id} or null
    for (const [id, el] of this._nodeEls) {
      const node = this.diagram.nodes.get(id);
      if (!node) continue;
      const dx = x - node.x, dy = y - node.y;
      let hit = false;
      if (node.type === NodeType.REGISTER) {
        hit = Math.abs(dx) <= 42 && Math.abs(dy) <= 30;
      } else if (node.type === NodeType.GATE) {
        hit = Math.abs(dx) + Math.abs(dy) <= 36;
      } else {
        hit = Math.hypot(dx, dy) <= (NODE_R[node.type] || 32) + 4;
      }
      if (hit) return { type: 'node', id };
    }

    // Connection hit (within 10px of path - approximate with bounding box check)
    for (const [id, el] of this._connEls) {
      const conn = this.diagram.connections.get(id);
      if (!conn) continue;
      const src = this.diagram.nodes.get(conn.sourceId);
      const tgt = this.diagram.nodes.get(conn.targetId);
      if (!src || !tgt) continue;
      const mx = (src.x + tgt.x) / 2, my = (src.y + tgt.y) / 2;
      if (Math.hypot(x - mx, y - my) <= 16) return { type: 'conn', id };
    }
    return null;
  }
}
