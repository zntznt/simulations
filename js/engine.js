class SimEngine {
  constructor(diagram) {
    this.diagram = diagram;
    this.step = 0;
    this.running = false;
    this._tid = null;
    this.speed = 2;
    this.history = [];
    // Callback: (step, firedIds, transfers[{connId, color, amount}])
    this.onStep = null;
  }

  saveInitial() {
    for (const n of this.diagram.nodes.values()) {
      n._initialResources = n.type === NodeType.SOURCE ? Infinity : n.resources;
      n._initialColorMap = { ...n.colorMap };
      if (n.type === NodeType.DELAY) n._initialQueue = [];
    }
  }

  reset() {
    this.stop();
    this.step = 0;
    this.history = [];
    for (const n of this.diagram.nodes.values()) {
      n.resources = n._initialResources ?? (n.type === NodeType.SOURCE ? Infinity : 0);
      n.colorMap = { ...(n._initialColorMap || {}) };
      if (n.type === NodeType.DELAY) n._queue = [];
    }
    this.diagram.variables = {};
    if (this.onStep) this.onStep(0, [], []);
  }

  doStep() {
    if (this.step === 0) this.saveInitial();
    this.step++;
    const { fired, transfers } = this._tick();
    this._record();
    if (this.onStep) this.onStep(this.step, fired, transfers);
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
    this._fireNode(node, ctx, true);
    this._applyCtx(ctx);
    if (this.onStep) this.onStep(this.step, [nodeId], ctx.transfers);
  }

  // ── Core ──────────────────────────────────────────────────────────────────

  _makeCtx() {
    return {
      gives: new Map(),     // nodeId → {color: amount} to receive
      delayIn: new Map(),   // nodeId → [{amount, color}]
      transfers: [],        // [{connId, color, amount}] for animation
    };
  }

  _tick() {
    const d = this.diagram;
    const ctx = this._makeCtx();
    const fired = [];

    // 1. Update diagram.variables from all state connections
    this._updateVariables();

    // 2. Evaluate registers
    this._evalRegisters();

    // 3. Fire automatic/starting nodes
    for (const n of d.nodes.values()) {
      const fire =
        n.activation === ActivationMode.AUTOMATIC ||
        (n.activation === ActivationMode.STARTING && this.step === 1);
      if (!fire) continue;
      if (this._fireNode(n, ctx, false)) fired.push(n.id);
    }

    // 4. Advance delay queues
    this._advanceDelays(ctx);

    // 5. Apply accumulated gives
    this._applyCtx(ctx);

    return { fired, transfers: ctx.transfers };
  }

  // State connections → diagram.variables
  _updateVariables() {
    const d = this.diagram;
    for (const conn of d.connections.values()) {
      if (conn.type !== ConnectionType.STATE) continue;
      const src = d.nodes.get(conn.sourceId);
      if (!src) continue;
      const val = src.type === NodeType.REGISTER ? src.value : src.resources;
      const name = conn.variableName || conn.label;
      if (name) d.variables[name] = val;
    }
  }

  // Evaluate all register formulas
  _evalRegisters() {
    const d = this.diagram;
    for (const n of d.nodes.values()) {
      if (n.type !== NodeType.REGISTER) continue;
      if (n.formula.trim()) {
        n.value = evalFormula(n.formula, d.variables);
      } else {
        // No formula: show value of first incoming state connection's source
        const inc = d.incoming(n.id).filter(c => c.type === ConnectionType.STATE);
        if (inc.length > 0) {
          const src = d.nodes.get(inc[0].sourceId);
          n.value = src ? (src.type === NodeType.REGISTER ? src.value : src.resources) : 0;
        }
      }
      // Publish register value under its label (so other formulas can read it)
      if (n.label) d.variables[n.label] = n.value;
    }
  }

  _fireNode(node, ctx, interactive) {
    const d = this.diagram;
    const outs = d.outgoing(node.id).filter(c => c.type === ConnectionType.RESOURCE);
    if (!outs.length) return false;

    let anyFired = false;

    if (node.type === NodeType.GATE) {
      // Gate distributes its accumulated pool to outgoing connections
      if (node.resources > 0) {
        anyFired = this._fireGate(node, outs, ctx);
      }
    } else {
      for (const conn of outs) {
        if (!interactive && !this._connFires(conn, node)) continue;
        const moved = this._pushConn(node, conn, ctx);
        if (moved) anyFired = true;
      }
    }

    return anyFired;
  }

  // Returns true if resources were sent
  _pushConn(node, conn, ctx) {
    const rate = this._connRate(conn);
    if (rate <= 0) return false;

    if (node.type === NodeType.SOURCE) {
      const color = node.resourceColor || '#ffa726';
      if (conn.colorFilter && color !== conn.colorFilter) return false;
      this._give(conn.targetId, color, rate, conn.id, ctx);
      return true;
    }

    if (node.type === NodeType.POOL || node.type === NodeType.CONVERTER) {
      if (node.resources <= 0) return false;
      const filter = conn.colorFilter || null;
      const taken = node.takeResources(rate, filter);
      let any = false;
      for (const { amount, color } of taken) {
        if (amount > 0) { this._give(conn.targetId, color, amount, conn.id, ctx); any = true; }
      }
      return any;
    }

    return false;
  }

  _fireGate(node, outs, ctx) {
    if (!outs.length || node.resources <= 0) return false;
    const total = node.resources;

    // Take resources proportionally from colorMap
    const totalTaken = node.takeResources(total);

    if (node.gateMode === 'random') {
      const pick = outs[Math.floor(Math.random() * outs.length)];
      for (const { amount, color } of totalTaken)
        this._give(pick.targetId, color, amount, pick.id, ctx);
    } else {
      // Proportional distribution by connection rates
      const rates = outs.map(c => Math.max(0.001, this._connRate(c)));
      const rateSum = rates.reduce((a, b) => a + b, 0);

      for (const { amount, color } of totalTaken) {
        let rem = amount;
        outs.forEach((conn, i) => {
          const share = i === outs.length - 1 ? rem : Math.floor(amount * rates[i] / rateSum);
          rem -= share;
          if (share > 0) this._give(conn.targetId, color, share, conn.id, ctx);
        });
      }
    }
    return true;
  }

  _advanceDelays(ctx) {
    const d = this.diagram;
    for (const n of d.nodes.values()) {
      if (n.type !== NodeType.DELAY) continue;
      const still = [];
      for (const item of (n._queue || [])) {
        item.stepsLeft--;
        if (item.stepsLeft <= 0) {
          const outs = d.outgoing(n.id).filter(c => c.type === ConnectionType.RESOURCE);
          for (const c of outs)
            this._give(c.targetId, item.color, item.amount, c.id, ctx);
          n.resources = Math.max(0, n.resources - item.amount);
          if (n.colorMap[item.color])
            n.colorMap[item.color] = Math.max(0, n.colorMap[item.color] - item.amount);
        } else {
          still.push(item);
        }
      }
      n._queue = still;
    }
  }

  // Route `amount` of `color` to target node
  _give(targetId, color, amount, connId, ctx) {
    const tgt = this.diagram.nodes.get(targetId);
    ctx.transfers.push({ connId, color, amount });

    if (tgt && tgt.type === NodeType.DELAY) {
      const arr = ctx.delayIn.get(targetId) || [];
      arr.push({ amount, color });
      ctx.delayIn.set(targetId, arr);
    } else {
      const gives = ctx.gives.get(targetId) || {};
      gives[color] = (gives[color] || 0) + amount;
      ctx.gives.set(targetId, gives);
    }
  }

  _applyCtx({ gives, delayIn }) {
    const d = this.diagram;

    for (const [id, colorAmounts] of gives) {
      const n = d.nodes.get(id);
      if (!n || n.type === NodeType.SOURCE || n.type === NodeType.DRAIN) continue;
      for (const [color, amount] of Object.entries(colorAmounts)) {
        const cap = n.capacity;
        const space = cap === Infinity ? amount : Math.min(amount, cap - n.resources);
        if (space > 0) n.addResources(space, color);
      }
    }

    for (const [id, items] of delayIn) {
      const n = d.nodes.get(id);
      if (!n) continue;
      for (const { amount, color } of items) {
        n._queue = n._queue || [];
        n._queue.push({ amount, color, stepsLeft: n.delay });
        n.resources += amount;
        n.colorMap[color] = (n.colorMap[color] || 0) + amount;
      }
    }
  }

  // ── Connection helpers ────────────────────────────────────────────────────

  // Should this resource connection fire this step?
  _connFires(conn, sourceNode) {
    // Interval
    if (conn.interval > 1 && (this.step - 1) % conn.interval !== 0) return false;
    // Chance
    if (conn.chance < 100 && Math.random() * 100 >= conn.chance) return false;
    // Condition on source's resource count (or register value)
    if (conn.condEnabled) {
      const val = sourceNode.type === NodeType.REGISTER ? sourceNode.value : sourceNode.resources;
      if (!this._evalCond(val, conn.condOperator, conn.condValue)) return false;
    }
    return true;
  }

  _evalCond(val, op, threshold) {
    switch (op) {
      case '>':  return val > threshold;
      case '>=': return val >= threshold;
      case '<':  return val < threshold;
      case '<=': return val <= threshold;
      case '==': return val === threshold;
      case '!=': return val !== threshold;
      default:   return true;
    }
  }

  _connRate(conn) {
    switch (conn.rateMode) {
      case RateMode.DICE:    return rollDice(conn.dice);
      case RateMode.FORMULA: return evalFormula(conn.formula, this.diagram.variables);
      default:               return typeof conn.rate === 'number' ? conn.rate : (parseFloat(conn.rate) || 1);
    }
  }

  _record() {
    const snap = {};
    for (const n of this.diagram.nodes.values())
      if (n.type !== NodeType.SOURCE) snap[n.id] = n.resources;
    this.history.push({ step: this.step, snap });
    if (this.history.length > 300) this.history.shift();
  }
}
