// Minimal sparkline chart for node history
class Sparkline {
  constructor(container, nodeId, engine) {
    this.nodeId = nodeId;
    this.engine = engine;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 260;
    this.canvas.height = 60;
    this.canvas.className = 'sparkline';
    container.appendChild(this.canvas);
  }

  update() {
    const history = this.engine.history;
    if (!history.length) return;
    const values = history.map(h => h.snap[this.nodeId] ?? 0);
    const ctx = this.canvas.getContext('2d');
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const max = Math.max(...values, 1);
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, w, h);

    // Grid line at midpoint
    ctx.strokeStyle = '#1e2535';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    if (values.length < 2) return;
    const step = w / (values.length - 1);

    ctx.beginPath();
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 1.5;
    values.forEach((v, i) => {
      const x = i * step;
      const y = h - (v / max) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill under line
    ctx.lineTo((values.length - 1) * step, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74,158,255,0.12)';
    ctx.fill();

    // Current value label
    ctx.fillStyle = '#4a9eff';
    ctx.font = '11px monospace';
    const last = values[values.length - 1];
    ctx.fillText(`${last}`, w - 30, 12);
    ctx.fillStyle = '#556';
    ctx.fillText(`max: ${max}`, 4, 12);
  }

  destroy() { this.canvas.remove(); }
}

// Distinct colors for timeline series (cycled by node order).
const CHART_PALETTE = ['#4a9eff', '#4caf50', '#ef5350', '#ffa726', '#ba68c8', '#26c6da', '#ffeb3b', '#7c83ff', '#ff7043', '#9ccc65'];

// Multi-series timeline of every tracked node's value over the run.
class TimelineChart {
  constructor(canvas, legendEl, diagram, engine) {
    this.canvas = canvas;
    this.legendEl = legendEl;
    this.diagram = diagram;
    this.engine = engine;
    this._hidden = new Set();
    this._hoverX = null;
    this._cachedNodeIds = '';
    this._cachedNodes = [];
    this._bindHover();
  }

  _colorOf(globalIdx) {
    return CHART_PALETTE[globalIdx % CHART_PALETTE.length];
  }

  _bindHover() {
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this._hoverX = e.clientX - rect.left;
      this.update();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this._hoverX = null;
      this.update();
    });
  }

  toggleNode(id) {
    if (this._hidden.has(id)) this._hidden.delete(id);
    else this._hidden.add(id);
    this.update();
    this._refreshLegend();
  }

  _refreshLegend() {
    const el = this.legendEl;
    if (!el) return;
    el.innerHTML = '';
    this._cachedNodes.forEach((node, idx) => {
      const chip = document.createElement('button');
      const off = this._hidden.has(node.id);
      chip.className = 'tl-chip' + (off ? ' tl-chip-off' : '');
      chip.style.setProperty('--chip-color', this._colorOf(idx));
      chip.textContent = node.label || node.type;
      chip.title = (off ? 'Show' : 'Hide') + ` "${node.label || node.type}"`;
      chip.addEventListener('click', () => this.toggleNode(node.id));
      el.appendChild(chip);
    });
  }

  update() {
    const cv = this.canvas;
    const w = cv.width = cv.clientWidth || 600;
    const h = cv.height = cv.clientHeight || 180;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, w, h);

    const hist = this.engine.history;
    const ids = [];
    const seen = new Set();
    for (const snap of hist) for (const id of Object.keys(snap.snap)) {
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    const allNodes = ids.map(id => this.diagram.nodes.get(id)).filter(Boolean);

    // Refresh legend only when node list changes
    const newKey = allNodes.map(n => n.id).join(',');
    if (newKey !== this._cachedNodeIds) {
      // Remove hidden entries for nodes that no longer exist
      for (const id of this._hidden) {
        if (!allNodes.some(n => n.id === id)) this._hidden.delete(id);
      }
      this._cachedNodeIds = newKey;
      this._cachedNodes = allNodes;
      this._refreshLegend();
    }

    const nodes = allNodes.filter(n => !this._hidden.has(n.id));

    if (hist.length < 2 || !nodes.length) {
      ctx.fillStyle = '#556';
      ctx.font = '12px var(--font)';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText('Run the simulation to plot node values over time.', 12, h / 2);
      return;
    }

    let max = 1;
    for (const snap of hist) for (const node of nodes) max = Math.max(max, snap.snap[node.id] ?? 0);

    const padL = 44, padT = 10, padB = 22, padR = 10;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const n = hist.length;
    const xAt = i => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
    const yAt = v => padT + plotH - (v / max) * plotH;

    // Horizontal grid lines at 25/50/75/100%
    ctx.strokeStyle = '#1e2535';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (const pct of [0.25, 0.5, 0.75, 1.0]) {
      const y = padT + plotH - pct * plotH;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Axes
    ctx.strokeStyle = '#2a3550'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    // Y-axis labels
    ctx.font = '10px monospace'; ctx.fillStyle = '#556';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const pct of [0, 0.25, 0.5, 0.75, 1.0]) {
      const v = max * pct;
      const y = padT + plotH - pct * plotH;
      const label = v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v % 1 === 0 ? String(v) : v.toFixed(1);
      ctx.fillText(label, padL - 4, y);
    }

    // X-axis labels (step numbers)
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#556';
    const maxLabels = Math.max(2, Math.floor(plotW / 45));
    const xStep = Math.max(1, Math.ceil((n - 1) / maxLabels));
    // Label with the snapshot's real step number — long runs are recorded at a
    // stride, so history index and simulation step are not interchangeable.
    for (let i = 0; i < n; i += xStep) {
      const x = xAt(i);
      ctx.fillText(String(hist[i].step), x, padT + plotH + 5);
      ctx.strokeStyle = '#2a3550'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT + plotH); ctx.lineTo(x, padT + plotH + 3); ctx.stroke();
    }
    // Always label the last step if it wasn't already hit
    if ((n - 1) % xStep !== 0) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#556';
      ctx.fillText(String(hist[n - 1].step), xAt(n - 1), padT + plotH + 5);
    }

    // Series lines
    nodes.forEach((node) => {
      const idx = allNodes.indexOf(node);
      ctx.strokeStyle = this._colorOf(idx);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      hist.forEach((snap, i) => {
        const v = snap.snap[node.id] ?? 0;
        const x = xAt(i), y = yAt(v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    // Hover crosshair + tooltip
    if (this._hoverX !== null && n >= 2) {
      const tickF = ((this._hoverX - padL) / plotW) * (n - 1);
      const tick = Math.max(0, Math.min(n - 1, Math.round(tickF)));
      const cx = xAt(tick);

      ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);

      // Dot per series at this tick
      const snap = hist[tick];
      nodes.forEach((node) => {
        const idx = allNodes.indexOf(node);
        const v = snap.snap[node.id] ?? 0;
        ctx.fillStyle = this._colorOf(idx);
        ctx.beginPath(); ctx.arc(cx, yAt(v), 3, 0, Math.PI * 2); ctx.fill();
      });

      // Tooltip box
      const lines = [`Step ${tick}`, ...nodes.map(node => {
        const v = snap.snap[node.id] ?? 0;
        return `${node.label || node.type}: ${v}`;
      })];
      ctx.font = '10px monospace';
      const tw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 18;
      const th = lines.length * 14 + 10;
      let tx = cx + 10;
      if (tx + tw > w - 4) tx = cx - tw - 10;
      const ty = padT + 2;

      ctx.fillStyle = 'rgba(12,14,20,0.93)';
      ctx.strokeStyle = '#2a3550'; ctx.lineWidth = 1;
      this._roundRect(ctx, tx, ty, tw, th, 4);
      ctx.fill(); ctx.stroke();

      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? '#9aa3b2' : this._colorOf(allNodes.indexOf(nodes[i - 1]));
        ctx.fillText(line, tx + 9, ty + 5 + i * 14);
      });
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}
