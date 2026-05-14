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
