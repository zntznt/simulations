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
    // One point draws nothing but an empty box and a stray midline, which read
    // as a broken chart at the top of the properties panel. Stay collapsed
    // until there are two points to join, then reveal.
    const drawable = history.length >= 2;
    this.canvas.classList.toggle('hidden', !drawable);
    if (!drawable) return;
    const values = history.map(h => h.snap[this.nodeId] ?? 0);
    const ctx = this.canvas.getContext('2d');
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const max = Math.max(...values, 1);
    ctx.fillStyle = '#0d0e11';
    ctx.fillRect(0, 0, w, h);

    // Grid line at midpoint
    ctx.strokeStyle = '#22252e';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    const step = w / (values.length - 1);

    ctx.beginPath();
    ctx.strokeStyle = '#b6e94d';
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
    ctx.fillStyle = 'rgba(182,233,77,0.10)';
    ctx.fill();

    // Current value label
    ctx.fillStyle = '#b6e94d';
    ctx.font = "11px 'JetBrains Mono', monospace";
    const last = values[values.length - 1];
    ctx.fillText(`${last}`, w - 30, 12);
    ctx.fillStyle = '#8a90a0';
    ctx.fillText(`max: ${max}`, 4, 12);
  }

  destroy() { this.canvas.remove(); }
}

// Distinct colors for chart series (cycled by node order).
const CHART_PALETTE = ['#4a9eff', '#4caf50', '#ef5350', '#ffa726', '#ba68c8', '#26c6da', '#ffeb3b', '#7c83ff', '#ff7043', '#9ccc65'];

// Canvas fonts can't reference CSS variables, so resolve the UI font family
// (`--font` on body) once and reuse it for every canvas label.
let _chartFontFamily = null;
function chartFont(px) {
  if (!_chartFontFamily)
    _chartFontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
  return `${px}px ${_chartFontFamily}`;
}

// Snap a rough gap to the nearest 1/2/5 x 10^n, the step ladder people read axis
// labels on. Picking the *closest* rung rather than always rounding up keeps the
// line count near the four asked for: a max of 94 wants 20, not 50. Used to put
// grid lines on values like 20 or 100 instead of on raw fractions of whatever
// the data happened to peak at.
function niceStep(rough) {
  if (!(rough > 0) || !isFinite(rough)) return 1;
  const power = Math.floor(Math.log10(rough));
  const err = rough / Math.pow(10, power);
  const factor = err >= Math.sqrt(50) ? 10 : err >= Math.sqrt(10) ? 5 : err >= Math.sqrt(2) ? 2 : 1;
  return factor * Math.pow(10, power);
}

// A readout value, trimmed to two decimals. Formula-driven series land on
// values like 1.1469463130731183, and printing those raw made the hover
// tooltip both unreadable and wide enough to shove itself off the canvas.
function fmtVal(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  return v % 1 === 0 ? String(v) : String(Math.round(v * 100) / 100);
}

// One color per node, keyed by its creation order in the diagram, shared by
// every chart surface (on-canvas charts, timeline, legends, hover readouts)
// so the same node always gets the same hue everywhere.
function chartSeriesColor(diagram, nodeId) {
  let i = 0;
  for (const id of diagram.nodes.keys()) { if (id === nodeId) break; i++; }
  return CHART_PALETTE[i % CHART_PALETTE.length];
}

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

  _colorOf(node) {
    return chartSeriesColor(this.diagram, node.id);
  }

  _bindHover() {
    const px = (e) => e.clientX - this.canvas.getBoundingClientRect().left;
    const py = (e) => e.clientY - this.canvas.getBoundingClientRect().top;
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this._drag = { x0: px(e), x1: px(e), y0: py(e), moved: false, cx: e.clientX, cy: e.clientY };
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
    // clears an existing one, and otherwise inspects the nearest series point
    // (spike attribution) when the app wired an onInspect handler.
    window.addEventListener('mouseup', () => {
      if (!this._drag) return;
      const d = this._drag; this._drag = null;
      if (d.moved) this._commitSelection(d.x0, d.x1);
      else if (this._sel) this.clearSelection();
      else this._inspectAt(d.x0, d.y0, d.cx, d.cy);
      this.update();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this._hoverX = null;
      this.update();
    });
  }

  // Plain click: find the recorded snapshot nearest the click's step and the
  // visible series nearest the click's y there, and hand both to the app
  // (onInspect) for the why-popover. Quietly does nothing when there's no
  // handler, no data, or the click is outside the plot.
  _inspectAt(x, y, clientX, clientY) {
    const g = this._geom;
    if (!this.onInspect || !g || !g.yOf || !g.nodes || !g.nodes.length) return;
    const hist = this.engine.history;
    if (hist.length < 2) return;
    if (x < g.padL - 6 || x > g.padL + g.plotW + 6) return;
    const snap = this._nearestSnap(this._stepAtX(x));
    if (!snap) return;
    const idx = hist.indexOf(snap);
    if (idx < 0) return;
    let best = null, bestDy = Infinity;
    for (const node of g.nodes) {
      const v = snap.snap[node.id];
      if (v == null) continue;
      const dy = Math.abs(g.yOf(node, v) - y);
      if (dy < bestDy) { bestDy = dy; best = node; }
    }
    if (best) this.onInspect(best.id, idx, clientX, clientY);
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
    this._cachedNodes.forEach((node) => {
      const chip = document.createElement('button');
      const off = this._hidden.has(node.id);
      chip.className = 'tl-chip' + (off ? ' tl-chip-off' : '');
      chip.style.setProperty('--chip-color', this._colorOf(node));
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
    const w = cv.clientWidth || 600;
    const h = cv.clientHeight || 180;
    // Size the bitmap in device pixels but keep every coordinate below in CSS
    // pixels, so the chart is sharp on a 2x display without disturbing the
    // pixel-to-step math the hover and brush hit tests depend on.
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#16181d';
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

    // Refresh legend only when the node list (ids or labels) or branch set changes
    const newKey = allNodes.map(n => n.id + ':' + n.label).join(',') + '|'
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
      ctx.fillStyle = '#8a90a0';
      ctx.font = chartFont(12);
      ctx.textBaseline = 'middle';
      // Centred, so the empty drawer reads as a deliberate placeholder rather
      // than a stray line of text stranded in the top-left corner.
      ctx.textAlign = 'center';
      // Distinguish "no data yet" from "everything is toggled off" — the latter
      // is recoverable from the legend's Show all chip.
      const hasData = hist.length >= 2 || branches.length;
      const msg = (hasData && allNodes.length && !nodes.length)
        ? 'All series hidden. Click “Show all” in the legend to bring them back.'
        : 'Run the simulation to plot node values over time.';
      ctx.fillText(msg, w / 2, h / 2);
      return;
    }

    // Domain spans live run AND ghost branches, in real step units (history
    // entries may be stride-sampled, and branches can be longer than the
    // live run). Also gather the stats the log/normalized scales need.
    // `min` floors at 0 so an all-positive chart keeps its familiar zero
    // baseline; it only drops below when a series actually goes negative, which
    // used to be mapped underneath the plot floor and never drawn at all.
    let max = 1, min = 0, maxStep = 1, minPos = Infinity;
    const nstats = new Map(nodes.map(n => [n.id, { min: Infinity, max: -Infinity }]));
    const scan = (hh) => {
      for (const snap of hh) {
        if (snap.step > maxStep) maxStep = snap.step;
        for (const node of nodes) {
          const v = snap.snap[node.id];
          if (v == null) continue;
          if (v > max) max = v;
          if (v < min) min = v;
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
    // Expose geometry so the brush handlers can map pixels ↔ steps. yOf and
    // the visible node list are filled in below, once the scale is built —
    // the click-to-inspect hit test reuses the exact drawing math.
    this._geom = { padL, plotW, maxStep, yOf: null, nodes };

    // One decimal place is not enough below 0.1: a register oscillating around
    // 0.05 rendered every tick as "0.0". Scale the precision to the value so
    // neighbouring labels never collapse into each other.
    const fmtTick = v => {
      if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
      if (v % 1 === 0) return String(v);
      const dp = Math.min(4, Math.max(1, 1 - Math.floor(Math.log10(Math.abs(v)))));
      return String(parseFloat(v.toFixed(dp)));
    };

    // Build the y-mapping and the horizontal guide lines for the active scale.
    // `yOf(node, v)` maps a raw value to a pixel y; readouts always use raw v.
    // How many guide lines the drawer can hold: labels are 11px, so a squeezed
    // timeline that used to stack five of them into ~34px now thins out first.
    const nTicks = Math.max(2, Math.min(4, Math.floor(plotH / 22)));
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
      const stride = Math.max(1, Math.ceil(span / nTicks));
      for (let e = lo; e <= hi; e += stride) {
        guides.push({ y: padT + plotH - ((e - lo) / span) * plotH, label: fmtTick(Math.pow(10, e)) });
      }
    } else if (this._scale === 'norm') {
      yOf = (node, v) => {
        const st = nstats.get(node.id);
        if (!st || !isFinite(st.min) || !isFinite(st.max)) return padT + plotH;
        if (st.max - st.min < 1e-9) return padT + plotH - 0.5 * plotH;
        return padT + plotH - ((v - st.min) / (st.max - st.min)) * plotH;
      };
      guides = Array.from({ length: nTicks + 1 }, (_, i) => i / nTicks)
        .map(p => ({ y: padT + plotH - p * plotH, label: `${Math.round(p * 100)}%` }));
    } else {
      // Span [min, max], where min is 0 unless a series really went negative.
      const span = (max - min) || 1;
      yOf = (node, v) => padT + plotH - ((v - min) / span) * plotH;
      // Grid lines land on round values (0, 20, 40 …) instead of raw quarters of
      // the data max, which produced labels like "23.5 / 47 / 70.5", and the
      // count follows the drawer height so short charts stop stacking five
      // labels into 34px.
      guides = [];
      const gstep = niceStep(span / nTicks);
      const first = Math.ceil(min / gstep) * gstep;
      for (let v = first; v <= max + 1e-9; v += gstep) {
        guides.push({ y: padT + plotH - ((v - min) / span) * plotH, label: fmtTick(v) });
      }
    }
    this._geom.yOf = yOf;

    // Horizontal grid lines
    ctx.strokeStyle = '#22252e';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (const g of guides) {
      ctx.beginPath(); ctx.moveTo(padL, g.y); ctx.lineTo(padL + plotW, g.y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Axes
    ctx.strokeStyle = '#2a2e38'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    // Y-axis labels
    ctx.font = "11px 'JetBrains Mono', monospace"; ctx.fillStyle = '#8a90a0';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const g of guides) ctx.fillText(g.label, padL - 4, g.y);

    // X-axis labels at round step values
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#8a90a0';
    const maxLabels = Math.max(2, Math.floor(plotW / 45));
    const tickStep = Math.max(1, Math.ceil(maxStep / maxLabels));
    // The final step gets its own label below, so skip any tick close enough
    // to collide with it (e.g. "80" mashed against "81" at the live edge).
    const lastLabelX = maxStep % tickStep !== 0 ? xAt(maxStep) : Infinity;
    for (let s = 0; s <= maxStep; s += tickStep) {
      const x = xAt(s);
      if (lastLabelX - x < 30) continue;
      ctx.fillText(String(s), x, padT + plotH + 5);
      ctx.strokeStyle = '#2a2e38'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT + plotH); ctx.lineTo(x, padT + plotH + 3); ctx.stroke();
    }
    // Always label the last step if it wasn't already hit
    if (maxStep % tickStep !== 0) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#8a90a0';
      ctx.fillText(String(maxStep), xAt(maxStep), padT + plotH + 5);
    }

    // Draw one timeline's series, step-based on x. Entries missing a node's
    // id (e.g. a node added after a branch was saved) are skipped.
    const drawSeries = (hh, node, width) => {
      ctx.strokeStyle = this._colorOf(node);
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
      ctx.strokeStyle = '#b6e94d'; ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#b6e94d';
      ctx.beginPath();
      ctx.moveTo(px - 4, padT); ctx.lineTo(px + 4, padT); ctx.lineTo(px, padT + 5);
      ctx.closePath(); ctx.fill();
    }

    // Provisional brush band while dragging out a comparison window.
    if (this._drag && this._drag.moved) {
      const l = Math.max(padL, Math.min(padL + plotW, Math.min(this._drag.x0, this._drag.x1)));
      const r = Math.max(padL, Math.min(padL + plotW, Math.max(this._drag.x0, this._drag.x1)));
      ctx.fillStyle = 'rgba(182,233,77,0.10)';
      ctx.fillRect(l, padT, r - l, plotH);
      ctx.strokeStyle = 'rgba(182,233,77,0.6)'; ctx.lineWidth = 1;
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
        ctx.fillStyle = 'rgba(182,233,77,0.08)';
        ctx.fillRect(l, padT, r - l, plotH);
        ctx.strokeStyle = '#b6e94d'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(xa, padT); ctx.lineTo(xa, padT + plotH);
        ctx.moveTo(xb, padT); ctx.lineTo(xb, padT + plotH);
        ctx.stroke();
        ctx.font = "10px 'JetBrains Mono', monospace"; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
        ctx.fillStyle = '#b6e94d';
        ctx.fillText('A·' + snapA.step, Math.max(padL + 12, Math.min(padL + plotW - 12, xa)), padT + 1);
        ctx.fillText('B·' + snapB.step, Math.max(padL + 12, Math.min(padL + plotW - 12, xb)), padT + 1);
        this._drawComparePanel(ctx, w, padL, padT, plotW, plotH, l, r, snapA, snapB, nodes);
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
        const v = snap.snap[node.id] ?? 0;
        ctx.fillStyle = this._colorOf(node);
        ctx.beginPath(); ctx.arc(cx, yOf(node, v), 3, 0, Math.PI * 2); ctx.fill();
      });

      // Tooltip box. A big diagram has more series than the drawer is tall, so
      // keep only the rows that fit and count the rest on the last line rather
      // than running the box off the bottom of the canvas.
      const rows = nodes.map(node => ({
        color: this._colorOf(node),
        text: `${node.label || node.type}: ${fmtVal(snap.snap[node.id] ?? 0)}`,
      }));
      // Measured against the canvas, not the plot box: the tooltip may sit over
      // the padding, it just must not run off the bottom edge.
      const fits = Math.max(1, Math.floor((h - 26) / 14) - 1);
      const shown = rows.slice(0, fits);
      if (rows.length > fits) {
        shown[fits - 1] = { color: '#8a90a0', text: `+${rows.length - fits + 1} more` };
      }
      const lines = [{ color: '#8a90a0', text: `Step ${snap.step}` }, ...shown];
      ctx.font = "10px 'JetBrains Mono', monospace";
      const tw = Math.max(...lines.map(l => ctx.measureText(l.text).width)) + 18;
      const th = lines.length * 14 + 10;
      let tx = cx + 10;
      if (tx + tw > w - 4) tx = cx - tw - 10;
      tx = Math.max(4, Math.min(tx, w - tw - 4));
      const ty = padT + 2; // row cap above guarantees th fits inside plotH

      ctx.fillStyle = 'rgba(13,14,17,0.93)';
      ctx.strokeStyle = '#2a2e38'; ctx.lineWidth = 1;
      this._roundRect(ctx, tx, ty, tw, th, 4);
      ctx.fill(); ctx.stroke();

      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach((line, i) => {
        ctx.fillStyle = line.color;
        ctx.fillText(line.text, tx + 9, ty + 5 + i * 14);
      });
    }
  }

  // Floating panel listing each visible series' value at A and B, the change,
  // and the % change. Placed opposite the selected band so it never covers it.
  _drawComparePanel(ctx, w, padL, padT, plotW, plotH, bandL, bandR, snapA, snapB, nodes) {
    const fmt = fmtVal;
    const rows = nodes.map(node => {
      const vA = snapA.snap[node.id] ?? 0, vB = snapB.snap[node.id] ?? 0;
      const d = vB - vA;
      const pct = vA !== 0 ? (d / Math.abs(vA)) * 100 : null;
      const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '–';
      const pctStr = pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%)`;
      return {
        color: this._colorOf(node),
        main: `${node.label || node.type}: ${fmt(vA)} → ${fmt(vB)}`,
        delta: `  ${arrow} ${d > 0 ? '+' : ''}${fmt(d)}${pctStr}`,
        dcolor: d > 0 ? '#4caf50' : d < 0 ? '#ef5350' : '#8a90a0',
      };
    });
    const header = `Step ${snapA.step} → ${snapB.step}  ·  Δ${snapB.step - snapA.step} steps`;

    ctx.font = "10px 'JetBrains Mono', monospace";
    const rowW = rows.map(r => ctx.measureText(r.main).width + ctx.measureText(r.delta).width);
    const tw = Math.max(ctx.measureText(header).width, ...rowW, 0) + 18;
    const th = (rows.length + 1) * 14 + 10;
    // Put the panel on whichever side of the band has more room.
    const center = (bandL + bandR) / 2;
    let tx = center < padL + plotW / 2 ? padL + plotW - tw - 6 : padL + 6;
    tx = Math.max(padL + 4, Math.min(padL + plotW - tw - 4, tx));
    const ty = padT + 2;

    ctx.fillStyle = 'rgba(13,14,17,0.95)';
    ctx.strokeStyle = '#2a2e38'; ctx.lineWidth = 1;
    this._roundRect(ctx, tx, ty, tw, th, 4);
    ctx.fill(); ctx.stroke();

    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#8a90a0';
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
