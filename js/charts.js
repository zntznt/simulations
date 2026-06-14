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

// Dash patterns for ghost-branch overlays (cycled by branch order) — same hue
// as the live node, different dash, so "same color = same node" holds across
// timelines.
const BRANCH_DASHES = [[5, 4], [2, 3], [9, 3, 2, 3], [12, 4]];

// Multi-series timeline of every tracked node's value over the run.
class TimelineChart {
  constructor(canvas, legendEl, diagram, engine) {
    this.canvas = canvas;
    this.legendEl = legendEl;
    this.diagram = diagram;
    this.engine = engine;
    this._hidden = new Set();
    this._hoverX = null;
    this._scrubStep = null;  // solid playhead drawn while scrubbing history
    this._cachedNodeIds = '';
    this._cachedNodes = [];
    // Supplied by the app: () => [{ id, name, history, visible }] — saved
    // timelines ("branches") drawn as dashed ghost traces for comparison.
    this.getBranches = null;
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

  // Position of the scrub playhead (real step number), or null to hide it.
  setScrub(step) {
    this._scrubStep = step;
    this.update();
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
    // Ghost-branch chips: dashed outline, click toggles the overlay.
    for (const b of (this.getBranches ? this.getBranches() : [])) {
      const chip = document.createElement('button');
      chip.className = 'tl-chip tl-branch-chip' + (b.visible ? '' : ' tl-chip-off');
      chip.textContent = b.name;
      chip.title = (b.visible ? 'Hide' : 'Show') + ` branch "${b.name}"`;
      chip.addEventListener('click', () => { b.visible = !b.visible; this.update(); });
      el.appendChild(chip);
    }
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
    const allBranches = this.getBranches ? this.getBranches() : [];
    const branches = allBranches.filter(b => b.visible && b.history.length >= 2);

    // Series ids: union of the live history and every visible branch, in
    // first-seen order, mapped to nodes that still exist in the diagram.
    const ids = [];
    const seen = new Set();
    const collect = (hh) => {
      for (const snap of hh) for (const id of Object.keys(snap.snap)) {
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
    };
    collect(hist);
    for (const b of branches) collect(b.history);
    const allNodes = ids.map(id => this.diagram.nodes.get(id)).filter(Boolean);

    // Refresh legend only when the node list or branch set changes
    const newKey = allNodes.map(n => n.id).join(',') + '|'
      + allBranches.map(b => b.id + (b.visible ? '+' : '-') + b.name).join(',');
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

    if ((hist.length < 2 && !branches.length) || !nodes.length) {
      ctx.fillStyle = '#556';
      ctx.font = '12px var(--font)';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText('Run the simulation to plot node values over time.', 12, h / 2);
      return;
    }

    // Domain spans live run AND ghost branches, in real step units (history
    // entries may be stride-sampled, and branches can be longer than the
    // live run).
    let max = 1, maxStep = 1;
    const scan = (hh) => {
      for (const snap of hh) {
        if (snap.step > maxStep) maxStep = snap.step;
        for (const node of nodes) max = Math.max(max, snap.snap[node.id] ?? 0);
      }
    };
    scan(hist);
    for (const b of branches) scan(b.history);

    const padL = 44, padT = 10, padB = 22, padR = 10;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const xAt = s => padL + (s / maxStep) * plotW;
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

    // X-axis labels at round step values
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#556';
    const maxLabels = Math.max(2, Math.floor(plotW / 45));
    const tickStep = Math.max(1, Math.ceil(maxStep / maxLabels));
    for (let s = 0; s <= maxStep; s += tickStep) {
      const x = xAt(s);
      ctx.fillText(String(s), x, padT + plotH + 5);
      ctx.strokeStyle = '#2a3550'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT + plotH); ctx.lineTo(x, padT + plotH + 3); ctx.stroke();
    }
    // Always label the last step if it wasn't already hit
    if (maxStep % tickStep !== 0) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#556';
      ctx.fillText(String(maxStep), xAt(maxStep), padT + plotH + 5);
    }

    // Draw one timeline's series, step-based on x. Entries missing a node's
    // id (e.g. a node added after a branch was saved) are skipped.
    const drawSeries = (hh, node, width) => {
      const idx = allNodes.indexOf(node);
      ctx.strokeStyle = this._colorOf(idx);
      ctx.lineWidth = width;
      ctx.beginPath();
      let started = false;
      for (const snap of hh) {
        if (!(node.id in snap.snap)) continue;
        const x = xAt(snap.step), y = yAt(snap.snap[node.id] ?? 0);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    // Ghost branches first (under the live run): same node colors, dashed
    // and faded — "same color = same node" across timelines.
    branches.forEach((b, bi) => {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.setLineDash(BRANCH_DASHES[bi % BRANCH_DASHES.length]);
      for (const node of nodes) drawSeries(b.history, node, 1.2);
      ctx.restore();
    });

    // Live series on top
    if (hist.length >= 2) for (const node of nodes) drawSeries(hist, node, 1.5);

    // Scrub playhead: a solid accent line marking the step being previewed.
    if (this._scrubStep != null) {
      const px = xAt(Math.max(0, Math.min(maxStep, this._scrubStep)));
      ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH); ctx.stroke();
      ctx.fillStyle = '#4a9eff';
      ctx.beginPath();
      ctx.moveTo(px - 4, padT); ctx.lineTo(px + 4, padT); ctx.lineTo(px, padT + 5);
      ctx.closePath(); ctx.fill();
    }

    // Hover crosshair + tooltip (live run only; ghosts are visual context)
    if (this._hoverX !== null && hist.length >= 2) {
      const stepF = ((this._hoverX - padL) / plotW) * maxStep;
      // Nearest recorded snapshot by step (history may be stride-sampled).
      let best = 0;
      for (let i = 1; i < hist.length; i++) {
        if (Math.abs(hist[i].step - stepF) < Math.abs(hist[best].step - stepF)) best = i;
      }
      const snap = hist[best];
      const cx = xAt(snap.step);

      ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);

      // Dot per series at this step
      nodes.forEach((node) => {
        const idx = allNodes.indexOf(node);
        const v = snap.snap[node.id] ?? 0;
        ctx.fillStyle = this._colorOf(idx);
        ctx.beginPath(); ctx.arc(cx, yAt(v), 3, 0, Math.PI * 2); ctx.fill();
      });

      // Tooltip box
      const lines = [`Step ${snap.step}`, ...nodes.map(node => {
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
