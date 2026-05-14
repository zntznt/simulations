class SimEngine {
  constructor(diagram) {
    this.diagram = diagram;
    this.step = 0;
    this.running = false;
    this._tid = null;
    this.speed = 2;
    this.history = [];
    this.onStep = null; // (step, firedIds) => void
  }

  saveInitial() {
    for (const n of this.diagram.nodes.values()) {
      n._initialResources = n.type === NodeType.SOURCE ? Infinity : n.resources;
      n._initialQueue = n.type === NodeType.DELAY ? [] : undefined;
    }
  }

  reset() {
    this.stop();
    this.step = 0;
    this.history = [];
    for (const n of this.diagram.nodes.values()) {
      n.resources = n._initialResources ?? (n.type === NodeType.SOURCE ? Infinity : 0);
      if (n.type === NodeType.DELAY) n._queue = [];
    }
    if (this.onStep) this.onStep(0, []);
  }

  doStep() {
    if (this.step === 0) this.saveInitial();
    this.step++;
    const fired = this._tick();
    this._record();
    if (this.onStep) this.onStep(this.step, fired);
    return fired;
  }

  run() {
    if (this.running) { this.stop(); return; }
    this.running = true;
    if (this.step === 0) this.saveInitial();
    const ms = Math.round(1000 / Math.max(0.1, this.speed));
    this._tid = setInterval(() => this.doStep(), ms);
  }

  stop() {
    this.running = false;
    if (this._tid) { clearInterval(this._tid); this._tid = null; }
  }

  fireInteractive(nodeId) {
    const node = this.diagram.nodes.get(nodeId);
    if (!node || node.activation !== ActivationMode.INTERACTIVE) return;
    const ctx = this._makeCtx();
    this._fireNode(node, ctx);
    this._applyCtx(ctx);
    if (this.onStep) this.onStep(this.step, [nodeId]);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _makeCtx() {
    const deltas = new Map();    // nodeId -> resource delta (for non-delay targets)
    const delayIn = new Map();   // delay nodeId -> amount arriving this step (queued separately)
    for (const n of this.diagram.nodes.values()) deltas.set(n.id, 0);
    return { deltas, delayIn };
  }

  _tick() {
    const d = this.diagram;
    const ctx = this._makeCtx();
    const fired = [];

    for (const n of d.nodes.values()) {
      const fire =
        n.activation === ActivationMode.AUTOMATIC ||
        (n.activation === ActivationMode.STARTING && this.step === 1);
      if (!fire) continue;
      if (this._fireNode(n, ctx)) fired.push(n.id);
    }

    // Advance delay queues; released resources flow downstream
    for (const n of d.nodes.values()) {
      if (n.type !== NodeType.DELAY) continue;
      const still = [];
      for (const item of (n._queue || [])) {
        item.stepsLeft--;
        if (item.stepsLeft <= 0) {
          const outs = d.outgoing(n.id).filter(c => c.type === ConnectionType.RESOURCE);
          for (const c of outs) {
            this._send(c.targetId, item.amount, ctx);
          }
          ctx.deltas.set(n.id, (ctx.deltas.get(n.id) || 0) - item.amount);
        } else {
          still.push(item);
        }
      }
      n._queue = still;
    }

    this._applyCtx(ctx);
    return fired;
  }

  _fireNode(node, ctx) {
    const d = this.diagram;
    const outs = d.outgoing(node.id).filter(c => c.type === ConnectionType.RESOURCE);
    if (!outs.length) return false;

    if (node.type === NodeType.SOURCE) {
      for (const c of outs) this._send(c.targetId, this._rate(c), ctx);
      return true;
    }

    if (node.type === NodeType.POOL) {
      if (node.resources <= 0) return false;
      let avail = node.resources;
      for (const c of outs) {
        const r = this._rate(c);
        const actual = Math.min(r, avail);
        if (actual <= 0) continue;
        avail -= actual;
        ctx.deltas.set(node.id, (ctx.deltas.get(node.id) || 0) - actual);
        this._send(c.targetId, actual, ctx);
      }
      return avail < node.resources;
    }

    if (node.type === NodeType.GATE) {
      if (node.resources <= 0) return false;
      const total = node.resources;
      ctx.deltas.set(node.id, (ctx.deltas.get(node.id) || 0) - total);

      if (node.gateMode === 'random') {
        const pick = outs[Math.floor(Math.random() * outs.length)];
        this._send(pick.targetId, total, ctx);
      } else {
        // Distribute proportionally by rate labels
        const rates = outs.map(c => Math.max(0.001, this._rate(c)));
        const sum = rates.reduce((a, b) => a + b, 0);
        let rem = total;
        outs.forEach((c, i) => {
          const share = i === outs.length - 1 ? rem : Math.floor(total * rates[i] / sum);
          rem -= share;
          if (share > 0) this._send(c.targetId, share, ctx);
        });
      }
      return true;
    }

    if (node.type === NodeType.CONVERTER) {
      if (node.resources <= 0) return false;
      const consume = Math.min(node.resources, 1);
      ctx.deltas.set(node.id, (ctx.deltas.get(node.id) || 0) - consume);
      for (const c of outs) this._send(c.targetId, this._rate(c), ctx);
      return true;
    }

    return false;
  }

  // Route a resource amount to a target — delay nodes get queued separately
  _send(targetId, amount, ctx) {
    const tgt = this.diagram.nodes.get(targetId);
    if (tgt && tgt.type === NodeType.DELAY) {
      ctx.delayIn.set(targetId, (ctx.delayIn.get(targetId) || 0) + amount);
    } else {
      ctx.deltas.set(targetId, (ctx.deltas.get(targetId) || 0) + amount);
    }
  }

  _applyCtx({ deltas, delayIn }) {
    const d = this.diagram;

    for (const [id, delta] of deltas) {
      if (!delta) continue;
      const n = d.nodes.get(id);
      if (!n || n.type === NodeType.SOURCE || n.type === NodeType.DRAIN) continue;
      const cap = n.capacity === Infinity ? Infinity : n.capacity;
      n.resources = Math.max(0, cap === Infinity ? n.resources + delta : Math.min(cap, n.resources + delta));
    }

    // Queue incoming for delay nodes
    for (const [id, amount] of delayIn) {
      const n = d.nodes.get(id);
      if (!n) continue;
      n._queue = n._queue || [];
      n._queue.push({ amount, stepsLeft: n.delay });
      n.resources += amount;
    }
  }

  _rate(conn) {
    if (typeof conn.rate === 'number') return conn.rate;
    const v = parseFloat(conn.rate);
    return isNaN(v) ? 1 : v;
  }

  _record() {
    const snap = {};
    for (const n of this.diagram.nodes.values())
      if (n.type !== NodeType.SOURCE) snap[n.id] = n.resources;
    this.history.push({ step: this.step, snap });
    if (this.history.length > 300) this.history.shift();
  }
}
