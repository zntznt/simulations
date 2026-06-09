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
  constructor(canvas, diagram, engine) {
    this.canvas = canvas;
    this.diagram = diagram;
    this.engine = engine;
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
    const nodes = ids.map(id => this.diagram.nodes.get(id)).filter(Boolean);

    if (hist.length < 2 || !nodes.length) {
      ctx.fillStyle = '#556';
      ctx.font = '12px var(--font)';
      ctx.fillText('Run the simulation to plot node values over time.', 12, h / 2);
      return;
    }

    let max = 1;
    for (const snap of hist) for (const id of ids) max = Math.max(max, snap.snap[id] ?? 0);

    const padL = 34, padT = 22, padB = 16, padR = 10;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    ctx.strokeStyle = '#1e2535'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = '#556'; ctx.font = '10px monospace';
    ctx.fillText(String(+max.toFixed(1)), 2, padT + 8);
    ctx.fillText('0', 2, padT + plotH);

    const n = hist.length;
    const xAt = i => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
    const yAt = v => padT + plotH - (v / max) * plotH;
    const colorOf = (i) => CHART_PALETTE[i % CHART_PALETTE.length];

    nodes.forEach((node, idx) => {
      ctx.strokeStyle = colorOf(idx);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      hist.forEach((snap, i) => {
        const v = snap.snap[node.id] ?? 0;
        const x = xAt(i), y = yAt(v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    // Legend across the top.
    let lx = padL + 2;
    ctx.font = '10px var(--font)';
    nodes.forEach((node, idx) => {
      const label = node.label || node.type;
      const tw = ctx.measureText(label).width;
      if (lx + tw + 16 > w - 4) return;
      ctx.fillStyle = colorOf(idx);
      ctx.fillRect(lx, 6, 8, 8);
      ctx.fillStyle = '#9aa3b2';
      ctx.fillText(label, lx + 11, 14);
      lx += tw + 26;
    });
  }
}
