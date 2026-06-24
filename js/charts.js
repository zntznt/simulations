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
    ctx.fillStyle = '#95a3bc';
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
    // Brush-to-compare: select a window [aStep, bStep] (real step units) to
    // compare each series' value at the two endpoints. _drag holds the in-flight
    // gesture; onSelection notifies the app so it can show its head controls.
    this._sel = null;
    this._drag = null;
    this.onSelection = null;
    this._geom = null;
    // Y-axis scale: 'linear' (shared 0..max), 'log' (decades — keeps small and
    // large series both legible), or 'norm' (each series to its own min..max,
    // for comparing shapes regardless of magnitude). Readouts stay raw.
    this._scale = 'linear';
    // Supplied by the app: () => [{ id, name, history, visible }] — saved
    // timelines ("branches") drawn as dashed ghost traces for comparison.
    this.getBranches = null;
    this._bindHover();
  }

  _colorOf(globalIdx) {
    return CHART_PALETTE[globalIdx % CHART_PALETTE.length];
  }

  _bindHover() {
    const px = (e) => e.clientX - this.canvas.getBoundingClientRect().left;
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this._drag = { x0: px(e), x1: px(e), moved: false };
    });
    this.canvas.addEventListener('mousemove', (e) => {
      const x = px(e);
      if (this._drag) {
        this._drag.x1 = x;
        if (Math.abs(this._drag.x1 - this._drag.x0) > 3) this._drag.moved = true;
        this._hoverX = null;
      } else {
        this._hoverX = x;
      }
      this.update();
    });
    // Release anywhere: a dragged window commits a comparison; a plain click
    // clears any existing one.
    window.addEventListener('mouseup', () => {
      if (!this._drag) return;
      const d = this._drag; this._drag = null;
      if (d.moved) this._commitSelection(d.x0, d.x1);
      else this.clearSelection();
      this.update();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this._hoverX = null;
      this.update();
    });
  }

  // Map a canvas x to a step, then snap to the nearest recorded live snapshot
  // (history may be stride-sampled, so the readout uses real recorded values).
  _stepAtX(x) {
    const g = this._geom; if (!g) return 0;
    return Math.max(0, Math.min(g.maxStep, ((x - g.padL) / g.plotW) * g.maxStep));
  }
  _nearestSnap(stepF) {
    const hist = this.engine.history;
    if (!hist.length) return null;
    let best = 0;
    for (let i = 1; i < hist.length; i++) {
      if (Math.abs(hist[i].step - stepF) < Math.abs(hist[best].step - stepF)) best = i;
    }
    return hist[best];
  }
  _commitSelection(x0, x1) {
    const sa = this._nearestSnap(this._stepAtX(x0));
    const sb = this._nearestSnap(this._stepAtX(x1));
    if (!sa || !sb || sa.step === sb.step) { this.clearSelection(); return; }
    let aStep = sa.step, bStep = sb.step;
    if (aStep > bStep) { const t = aStep; aStep = bStep; bStep = t; }
    this._sel = { aStep, bStep };
    if (this.onSelection) this.onSelection({ aStep, bStep, span: bStep - aStep });
  }
  clearSelection() {
    if (!this._sel && !this._drag) return;
    this._sel = null; this._drag = null;
    if (this.onSelection) this.onSelection(null);
    this.update();
  }

  // Position of the scrub playhead (real step number), or null to hide it.
  setScrub(step) {
    this._scrubStep = step;
    this.update();
  }

  setScale(mode) {
    this._scale = (mode === 'log' || mode === 'norm') ? mode : 'linear';
    this.update();
  }

  toggleNode(id) {
    if (this._hidden.has(id)) this._hidden.delete(id);
    else this._hidden.add(id);
    this.update();
    this._refreshLegend();
  }

  // Show or hide every node series at once, so you don't have to click each
  // chip. Hides all when any series is currently visible; shows all when every
  // series is already hidden. Branch (ghost) overlays are left untouched.
  toggleAllNodes() {
    const allHidden = this._cachedNodes.length > 0
      && this._cachedNodes.every(n => this._hidden.has(n.id));
    for (const n of this._cachedNodes) {
      if (allHidden) this._hidden.delete(n.id);
      else this._hidden.add(n.id);
    }
    this.update();
    this._refreshLegend();
  }

  _refreshLegend() {
    const el = this.legendEl;
    if (!el) return;
    el.innerHTML = '';
    // Bulk toggle: one control to show/hide every node series at once. It
    // reflects the current state — "Hide all" while anything is visible,
    // "Show all" once every series is hidden — and only appears when there
    // are at least two series to make the shortcut worthwhile.
    if (this._cachedNodes.length >= 2) {
      const allHidden = this._cachedNodes.every(n => this._hidden.has(n.id));
      const allBtn = document.createElement('button');
      allBtn.className = 'tl-chip tl-chip-all';
      allBtn.textContent = allHidden ? 'Show all' : 'Hide all';
      allBtn.title = allHidden ? 'Show every series' : 'Hide every series';
      allBtn.setAttribute('aria-pressed', String(!allHidden));
      allBtn.addEventListener('click', () => this.toggleAllNodes());
      el.appendChild(allBtn);
    }
    this._cachedNodes.forEach((node, idx) => {
      const chip = document.createElement('button');
      const off = this._hidden.has(node.id);
      chip.className = 'tl-chip' + (off ? ' tl-chip-off' : '');
      chip.style.setProperty('--chip-color', this._colorOf(idx));
      chip.textContent = node.label || node.type;
      chip.title = (off ? 'Show' : 'Hide') + ` "${node.label || node.type}"`;
      chip.setAttribute('aria-pressed', String(!off));
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
    // A comparison pins two fixed points; drop it once the run is moving again.
    if (this._sel && this.engine.running) {
      this._sel = null;
      if (this.onSelection) this.onSelection(null);
    }
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
      ctx.fillStyle = '#95a3bc';
      ctx.font = '12px var(--font)';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      // Distinguish "no data yet" from "everything is toggled off" — the latter
      // is recoverable from the legend's Show all chip.
      const hasData = hist.length >= 2 || branches.length;
      const msg = (hasData && allNodes.length && !nodes.length)
        ? 'All series hidden. Click “Show all” in the legend to bring them back.'
        : 'Run the simulation to plot node values over time.';
      ctx.fillText(msg, 12, h / 2);
      return;
    }

    // Domain spans live run AND ghost branches, in real step units (history
    // entries may be stride-sampled, and branches can be longer than the
    // live run). Also gather the stats the log/normalized scales need.
    let max = 1, maxStep = 1, minPos = Infinity;
    const nstats = new Map(nodes.map(n => [n.id, { min: Infinity, max: -Infinity }]));
    const scan = (hh) => {
      for (const snap of hh) {
        if (snap.step > maxStep) maxStep = snap.step;
        for (const node of nodes) {
          const v = snap.snap[node.id];
          if (v == null) continue;
          if (v > max) max = v;
          if (v > 0 && v < minPos) minPos = v;
          const st = nstats.get(node.id);
          if (v < st.min) st.min = v;
          if (v > st.max) st.max = v;
        }
      }
    };
    scan(hist);
    for (const b of branches) scan(b.history);

    const padL = 44, padT = 10, padB = 22, padR = 10;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const xAt = s => padL + (s / maxStep) * plotW;
    // Expose geometry so the brush handlers can map pixels ↔ steps.
    this._geom = { padL, plotW, maxStep };

    const fmtTick = v => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k`
      : v % 1 === 0 ? String(v) : v.toFixed(1));

    // Build the y-mapping and the horizontal guide lines for the active scale.
    // `yOf(node, v)` maps a raw value to a pixel y; readouts always use raw v.
    let yOf, guides;
    const logOk = this._scale === 'log' && isFinite(minPos) && max > minPos;
    if (logOk) {
      const lo = Math.floor(Math.log10(minPos));
      const hi = Math.max(lo + 1, Math.ceil(Math.log10(max)));
      const span = hi - lo;
      yOf = (node, v) => {
        const lv = v > 0 ? Math.log10(v) : lo;
        return padT + plotH - ((Math.max(lo, Math.min(hi, lv)) - lo) / span) * plotH;
      };
      guides = [];
      for (let e = lo; e <= hi; e++) {
        guides.push({ y: padT + plotH - ((e - lo) / span) * plotH, label: fmtTick(Math.pow(10, e)) });
      }
    } else if (this._scale === 'norm') {
      yOf = (node, v) => {
        const st = nstats.get(node.id);
        if (!st || !isFinite(st.min) || !isFinite(st.max)) return padT + plotH;
        if (st.max - st.min < 1e-9) return padT + plotH - 0.5 * plotH;
        return padT + plotH - ((v - st.min) / (st.max - st.min)) * plotH;
      };
      guides = [0, 0.25, 0.5, 0.75, 1].map(p => ({ y: padT + plotH - p * plotH, label: `${p * 100}%` }));
    } else {
      yOf = (node, v) => padT + plotH - (v / max) * plotH;
      guides = [0, 0.25, 0.5, 0.75, 1].map(p => ({ y: padT + plotH - p * plotH, label: fmtTick(max * p) }));
    }

    // Horizontal grid lines
    ctx.strokeStyle = '#1e2535';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (const g of guides) {
      ctx.beginPath(); ctx.moveTo(padL, g.y); ctx.lineTo(padL + plotW, g.y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Axes
    ctx.strokeStyle = '#2a3550'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    // Y-axis labels
    ctx.font = '11px monospace'; ctx.fillStyle = '#95a3bc';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const g of guides) ctx.fillText(g.label, padL - 4, g.y);

    // X-axis labels at round step values
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#95a3bc';
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
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#95a3bc';
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
        const x = xAt(snap.step), y = yOf(node, snap.snap[node.id] ?? 0);
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

    // Provisional brush band while dragging out a comparison window.
    if (this._drag && this._drag.moved) {
      const l = Math.max(padL, Math.min(padL + plotW, Math.min(this._drag.x0, this._drag.x1)));
      const r = Math.max(padL, Math.min(padL + plotW, Math.max(this._drag.x0, this._drag.x1)));
      ctx.fillStyle = 'rgba(74,158,255,0.12)';
      ctx.fillRect(l, padT, r - l, plotH);
      ctx.strokeStyle = 'rgba(74,158,255,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l, padT); ctx.lineTo(l, padT + plotH);
      ctx.moveTo(r, padT); ctx.lineTo(r, padT + plotH);
      ctx.stroke();
    }

    // A committed comparison window: dim outside it (focus on the span), shade
    // inside, mark both endpoints, and draw the per-series A→B readout.
    if (this._sel) {
      const snapA = this._nearestSnap(this._sel.aStep);
      const snapB = this._nearestSnap(this._sel.bStep);
      if (snapA && snapB) {
        const xa = xAt(snapA.step), xb = xAt(snapB.step);
        const l = Math.min(xa, xb), r = Math.max(xa, xb);
        ctx.fillStyle = 'rgba(8,10,15,0.55)';
        ctx.fillRect(padL, padT, l - padL, plotH);
        ctx.fillRect(r, padT, padL + plotW - r, plotH);
        ctx.fillStyle = 'rgba(74,158,255,0.08)';
        ctx.fillRect(l, padT, r - l, plotH);
        ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(xa, padT); ctx.lineTo(xa, padT + plotH);
        ctx.moveTo(xb, padT); ctx.lineTo(xb, padT + plotH);
        ctx.stroke();
        ctx.font = '10px monospace'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
        ctx.fillStyle = '#4a9eff';
        ctx.fillText('A·' + snapA.step, Math.max(padL + 12, Math.min(padL + plotW - 12, xa)), padT + 1);
        ctx.fillText('B·' + snapB.step, Math.max(padL + 12, Math.min(padL + plotW - 12, xb)), padT + 1);
        this._drawComparePanel(ctx, w, padL, padT, plotW, plotH, l, r, snapA, snapB, nodes, allNodes);
      }
    }

    // Hover crosshair + tooltip (live run only; ghosts are visual context).
    // Suppressed while a comparison window is active — the band is the focus.
    if (this._hoverX !== null && hist.length >= 2 && !this._sel) {
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
        ctx.beginPath(); ctx.arc(cx, yOf(node, v), 3, 0, Math.PI * 2); ctx.fill();
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

  // Floating panel listing each visible series' value at A and B, the change,
  // and the % change. Placed opposite the selected band so it never covers it.
  _drawComparePanel(ctx, w, padL, padT, plotW, plotH, bandL, bandR, snapA, snapB, nodes, allNodes) {
    const fmt = v => (v % 1 === 0 ? String(v) : (Math.round(v * 100) / 100).toFixed(2));
    const rows = nodes.map(node => {
      const vA = snapA.snap[node.id] ?? 0, vB = snapB.snap[node.id] ?? 0;
      const d = vB - vA;
      const pct = vA !== 0 ? (d / Math.abs(vA)) * 100 : null;
      const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '–';
      const pctStr = pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%)`;
      return {
        color: this._colorOf(allNodes.indexOf(node)),
        main: `${node.label || node.type}: ${fmt(vA)} → ${fmt(vB)}`,
        delta: `  ${arrow} ${d > 0 ? '+' : ''}${fmt(d)}${pctStr}`,
        dcolor: d > 0 ? '#4caf50' : d < 0 ? '#ef5350' : '#95a3bc',
      };
    });
    const header = `Step ${snapA.step} → ${snapB.step}  ·  Δ${snapB.step - snapA.step} steps`;

    ctx.font = '10px monospace';
    const rowW = rows.map(r => ctx.measureText(r.main).width + ctx.measureText(r.delta).width);
    const tw = Math.max(ctx.measureText(header).width, ...rowW, 0) + 18;
    const th = (rows.length + 1) * 14 + 10;
    // Put the panel on whichever side of the band has more room.
    const center = (bandL + bandR) / 2;
    let tx = center < padL + plotW / 2 ? padL + plotW - tw - 6 : padL + 6;
    tx = Math.max(padL + 4, Math.min(padL + plotW - tw - 4, tx));
    const ty = padT + 2;

    ctx.fillStyle = 'rgba(12,14,20,0.95)';
    ctx.strokeStyle = '#2a3550'; ctx.lineWidth = 1;
    this._roundRect(ctx, tx, ty, tw, th, 4);
    ctx.fill(); ctx.stroke();

    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#9aa3b2';
    ctx.fillText(header, tx + 9, ty + 5);
    rows.forEach((r, i) => {
      const y = ty + 5 + (i + 1) * 14;
      ctx.fillStyle = r.color;
      ctx.fillText(r.main, tx + 9, y);
      ctx.fillStyle = r.dcolor;
      ctx.fillText(r.delta, tx + 9 + ctx.measureText(r.main).width, y);
    });
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
