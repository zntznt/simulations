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
    // Terminal state when a node's end/goal condition is met.
    this.ended = null;        // { nodeId, label, step, value } | null
    this.onEnd = null;        // Callback(ended)
  }

  saveInitial() {
    for (const n of this.diagram.nodes.values()) {
      n._initialResources = n.type === NodeType.SOURCE ? Infinity : n.resources;
      n._initialColorMap = { ...n.colorMap };
    }
  }

  reset() {
    this.stop();
    this.step = 0;
    this.history = [];
    this.ended = null;
    for (const n of this.diagram.nodes.values()) {
      n.resources = n._initialResources ?? (n.type === NodeType.SOURCE ? Infinity : 0);
      n.colorMap = { ...(n._initialColorMap || {}) };
      if (n.type === NodeType.DELAY) n._queue = [];
      if (n.type === NodeType.SOURCE) n.produced = 0;
      if (n.type === NodeType.DRAIN) n.drained = 0;
      if (n.type === NodeType.REGISTER) n.value = 0;
    }
    this.diagram.variables = {};
    // Compute initial variable/register values so the display is correct
    // before the first step runs.
    this._updateVariables();
    this._evalRegisters();
    if (this.onStep) this.onStep(0, [], []);
  }

  doStep() {
    if (this.step === 0) {
      this.saveInitial();
      this._updateVariables();
      this._evalRegisters();
    }
    this.step++;
    const { fired, transfers } = this._tick();
    this._record();
    if (this.onStep) this.onStep(this.step, fired, transfers);
    this._checkEnd();
  }

  run() {
    if (this.running) { this.stop(); return; }
    // Allow running past a previously-reached goal (it will re-trigger if the
    // condition still holds after the next step).
    this.ended = null;
    this.running = true;
    if (this.step === 0) {
      this.saveInitial();
      this._updateVariables();
      this._evalRegisters();
    }
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
    const fired = [];
    this._runFireQueue([{ node, forced: true }], ctx, fired);
    this._applyCtx(ctx);
    this._updateVariables();
    this._evalRegisters();
    if (this.onStep) this.onStep(this.step, fired, ctx.transfers);
    this._checkEnd();
  }

  // ── Core tick ───────────────────────────────────────────────────────────

  _makeCtx() {
    return {
      gives: new Map(),     // nodeId → {color: amount}
      delayIn: new Map(),   // nodeId → [{amount, color}]
      reserved: new Map(),  // nodeId → capacity reserved this step
      transfers: [],        // [{connId, color, amount}] for animation
    };
  }

  _tick() {
    const d = this.diagram;
    const ctx = this._makeCtx();
    const fired = [];

    // Seed the fire queue with automatic / starting nodes, then let triggers
    // cascade. Connection rate formulas read diagram.variables, which holds the
    // values committed at the end of the previous step (or from reset()).
    const initial = [];
    for (const n of d.nodes.values()) {
      const auto =
        n.activation === ActivationMode.AUTOMATIC ||
        (n.activation === ActivationMode.STARTING && this.step === 1);
      if (auto) initial.push({ node: n, forced: false });
    }
    this._runFireQueue(initial, ctx, fired);

    // Advance delay queues (releases respect target capacity).
    this._advanceDelays(ctx);

    // Commit all flows atomically.
    this._applyCtx(ctx);

    // Refresh shared variables + registers to reflect the new committed state.
    this._updateVariables();
    this._evalRegisters();

    return { fired, transfers: ctx.transfers };
  }

  // Fire a worklist of nodes; each successful fire enqueues its trigger targets
  // (state connections marked `trigger`). Loop-guarded against cycles.
  _runFireQueue(initial, ctx, fired) {
    const d = this.diagram;
    const queue = [...initial];
    let guard = 0;
    while (queue.length && guard++ < 5000) {
      const { node, forced } = queue.shift();
      if (!node || !this._nodeEnabled(node)) continue;
      if (!this._fireNode(node, ctx, forced)) continue;
      fired.push(node.id);
      for (const t of d.outgoing(node.id)) {
        if (t.type === ConnectionType.STATE && t.trigger) {
          const tgt = d.nodes.get(t.targetId);
          if (tgt) queue.push({ node: tgt, forced: true });
        }
      }
    }
  }

  // A node may fire only while every incoming activator's condition holds.
  _nodeEnabled(node) {
    for (const conn of this.diagram.incoming(node.id)) {
      if (conn.type !== ConnectionType.STATE || !conn.activator) continue;
      const src = this.diagram.nodes.get(conn.sourceId);
      const val = this._stateValueOf(src);
      if (!this._evalCond(val, conn.actOperator, conn.actValue)) return false;
    }
    return true;
  }

  // Halt the simulation if any node's end/goal condition is satisfied.
  _checkEnd() {
    if (this.ended) return;
    for (const n of this.diagram.nodes.values()) {
      if (!n.endEnabled) continue;
      const val = n.chartValue;
      if (this._evalCond(val, n.endOperator, n.endValue)) {
        this.ended = { nodeId: n.id, label: n.label, step: this.step, value: val };
        this.stop();
        if (this.onEnd) this.onEnd(this.ended);
        return;
      }
    }
  }

  // ── Variables & registers ─────────────────────────────────────────────────

  _stateValueOf(node) {
    if (!node) return 0;
    if (node.type === NodeType.REGISTER) return isFinite(node.value) ? node.value : 0;
    if (node.type === NodeType.SOURCE) return node.produced || 0;
    if (node.type === NodeType.DRAIN) return node.drained || 0;
    return node.resources;
  }

  _updateVariables() {
    const d = this.diagram;
    for (const conn of d.connections.values()) {
      if (conn.type !== ConnectionType.STATE) continue;
      const src = d.nodes.get(conn.sourceId);
      if (!src) continue;
      const name = conn.variableName || conn.label;
      if (!name) continue;
      const val = this._stateValueOf(src);
      d.variables[name] = isFinite(val) ? val : 0;
    }
  }

  _evalRegisters() {
    const d = this.diagram;
    for (const n of d.nodes.values()) {
      if (n.type !== NodeType.REGISTER) continue;
      if (n.formula && n.formula.trim()) {
        n.value = evalFormula(n.formula, d.variables);
      } else {
        // No formula: mirror the first incoming state connection's source.
        const inc = d.incoming(n.id).filter(c => c.type === ConnectionType.STATE);
        n.value = inc.length ? this._stateValueOf(d.nodes.get(inc[0].sourceId)) : 0;
      }
      if (!isFinite(n.value)) n.value = 0;
      // Publish under the register's label so other formulas can chain on it.
      if (n.label && VALID_IDENT.test(n.label)) d.variables[n.label] = n.value;
    }
  }

  // ── Firing ────────────────────────────────────────────────────────────────

  _fireNode(node, ctx, interactive) {
    const d = this.diagram;
    const outs = d.outgoing(node.id).filter(c => c.type === ConnectionType.RESOURCE);
    if (!outs.length) return false;

    if (node.type === NodeType.GATE) {
      return node.resources > 0 ? this._fireGate(node, outs, ctx) : false;
    }
    if (node.type === NodeType.CONVERTER) {
      return this._fireConverter(node, outs, ctx);
    }

    let any = false;
    for (const conn of outs) {
      if (!interactive && !this._connFires(conn, node)) continue;
      if (this._pushConn(node, conn, ctx)) any = true;
    }
    return any;
  }

  // Push along one resource connection from a Source or Pool.
  _pushConn(node, conn, ctx) {
    const rate = Math.max(0, Math.round(this._connRate(conn)));
    if (rate <= 0) return false;

    if (node.type === NodeType.SOURCE) {
      const color = node.resourceColor || DEFAULT_COLOR;
      if (conn.colorFilter && color !== conn.colorFilter) return false;
      const accept = this._acceptable(conn.targetId, rate, ctx);
      if (accept <= 0) return false;
      node.produced += accept;
      this._give(conn.targetId, color, accept, conn.id, ctx);
      this._reserve(conn.targetId, accept, ctx);
      return true;
    }

    if (node.type === NodeType.POOL) {
      if (node.resources <= 0) return false;
      const accept = this._acceptable(conn.targetId, rate, ctx);
      if (accept <= 0) return false;
      const taken = node.takeResources(accept, conn.colorFilter || null);
      let total = 0;
      for (const { amount, color } of taken) {
        if (amount > 0) { this._give(conn.targetId, color, amount, conn.id, ctx); total += amount; }
      }
      if (total > 0) this._reserve(conn.targetId, total, ctx);
      return total > 0;
    }

    return false;
  }

  // Converter: consumes `inputAmount` of held resources per conversion and
  // emits each outgoing connection's rate in the converter's output color.
  _fireConverter(node, outs, ctx) {
    const need = Math.max(1, Math.round(node.inputAmount || 1));
    let conversions = 0, guard = 0;

    while (node.resources >= need && guard++ < 10000) {
      // Figure out how much each output can take before consuming input.
      let canPlace = false;
      const grants = outs.map(c => {
        const want = Math.max(0, Math.round(this._connRate(c)));
        const amt = this._acceptable(c.targetId, want, ctx);
        if (amt > 0) canPlace = true;
        return { c, amt };
      });
      if (!canPlace) break; // every output full — stop, keep the input

      node.takeResources(need);
      conversions++;
      const color = node.outputColor || DEFAULT_COLOR;
      for (const g of grants) {
        if (g.amt > 0) {
          this._give(g.c.targetId, color, g.amt, g.c.id, ctx);
          this._reserve(g.c.targetId, g.amt, ctx);
        }
      }
    }
    return conversions > 0;
  }

  // Per-output gate weight (>= 0). Non-numeric falls back to 1.
  _connWeight(conn) {
    const w = Number(conn.weight);
    return isFinite(w) && w >= 0 ? w : 1;
  }

  // Gate: redistributes everything it holds across its outputs by weight.
  // `probabilistic` (alias of legacy `random`) routes each unit by weighted
  // chance; `deterministic` splits the total proportionally to the weights.
  _fireGate(node, outs, ctx) {
    node.reconcile();
    let movedAny = false;
    const weights = outs.map(c => this._connWeight(c));
    const mode = node.gateMode === 'random' ? 'probabilistic' : node.gateMode;

    if (mode === 'probabilistic') {
      // Route each unit to a weighted-random output that still has room.
      for (const color of Object.keys(node.colorMap)) {
        while (node.colorMap[color] > 0) {
          let pool = 0;
          const cand = outs.map((c, i) => {
            const w = this._acceptable(c.targetId, 1, ctx) >= 1 ? weights[i] : 0;
            pool += w;
            return { c, w };
          });
          if (pool <= 0) break;
          let r = Math.random() * pool, pick = null;
          for (const a of cand) { if (a.w <= 0) continue; r -= a.w; if (r <= 0) { pick = a; break; } }
          if (!pick) pick = cand.filter(a => a.w > 0).pop();
          this._give(pick.c.targetId, color, 1, pick.c.id, ctx);
          this._reserve(pick.c.targetId, 1, ctx);
          node.colorMap[color] -= 1;
          node.resources -= 1;
          movedAny = true;
        }
      }
      for (const k of Object.keys(node.colorMap)) if (node.colorMap[k] <= 0) delete node.colorMap[k];
      return movedAny;
    }

    // Deterministic: split proportionally to output weights.
    const total = node.resources;
    const wSum = weights.reduce((a, b) => a + b, 0);
    const shares = outs.map((c, i) => Math.floor(total * (wSum > 0 ? weights[i] : 1) / (wSum > 0 ? wSum : outs.length)));
    let rem = total - shares.reduce((a, b) => a + b, 0);
    for (let i = 0; rem > 0 && outs.length; i++, rem--) shares[i % outs.length]++;

    outs.forEach((conn, i) => {
      const accept = this._acceptable(conn.targetId, shares[i], ctx);
      if (accept <= 0) return;
      const taken = node.takeResources(accept);
      let moved = 0;
      for (const { amount, color } of taken) {
        this._give(conn.targetId, color, amount, conn.id, ctx);
        moved += amount;
      }
      if (moved > 0) { this._reserve(conn.targetId, moved, ctx); movedAny = true; }
    });
    return movedAny;
  }

  _advanceDelays(ctx) {
    const d = this.diagram;
    for (const n of d.nodes.values()) {
      if (n.type !== NodeType.DELAY) continue;
      const outs = d.outgoing(n.id).filter(c => c.type === ConnectionType.RESOURCE);
      const still = [];
      for (const item of (n._queue || [])) {
        item.stepsLeft--;
        if (item.stepsLeft > 0) { still.push(item); continue; }

        if (!outs.length) { still.push({ ...item, stepsLeft: 1 }); continue; }

        let remaining = item.amount;
        for (const c of outs) {
          if (remaining <= 0) break;
          const accept = this._acceptable(c.targetId, remaining, ctx);
          if (accept <= 0) continue;
          this._give(c.targetId, item.color, accept, c.id, ctx);
          this._reserve(c.targetId, accept, ctx);
          n.resources = Math.max(0, n.resources - accept);
          if (n.colorMap[item.color]) n.colorMap[item.color] = Math.max(0, n.colorMap[item.color] - accept);
          remaining -= accept;
        }
        if (remaining > 0) still.push({ amount: remaining, color: item.color, stepsLeft: 1 });
      }
      n._queue = still;
      for (const k of Object.keys(n.colorMap)) if (n.colorMap[k] <= 0) delete n.colorMap[k];
    }
  }

  // ── Flow plumbing ─────────────────────────────────────────────────────────

  // How much a target can still accept this step (capacity-aware).
  _acceptable(targetId, want, ctx) {
    const tgt = this.diagram.nodes.get(targetId);
    if (!tgt || want <= 0) return 0;
    if (tgt.type === NodeType.SOURCE) return 0; // can't push into a source
    if (tgt.capacity === Infinity || tgt.type === NodeType.DRAIN || tgt.type === NodeType.DELAY)
      return want;
    const reserved = ctx.reserved.get(targetId) || 0;
    const room = tgt.capacity - tgt.resources - reserved;
    return Math.max(0, Math.min(want, room));
  }

  _reserve(targetId, amt, ctx) {
    ctx.reserved.set(targetId, (ctx.reserved.get(targetId) || 0) + amt);
  }

  _give(targetId, color, amount, connId, ctx) {
    if (amount <= 0) return;
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
      if (!n || n.type === NodeType.SOURCE) continue;
      if (n.type === NodeType.DRAIN) {
        for (const amt of Object.values(colorAmounts)) n.drained = (n.drained || 0) + amt;
        continue;
      }
      for (const [color, amount] of Object.entries(colorAmounts)) n.addResources(amount, color);
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

  _connFires(conn, sourceNode) {
    if (conn.interval > 1 && (this.step - 1) % conn.interval !== 0) return false;
    if (conn.chance < 100 && Math.random() * 100 >= conn.chance) return false;
    if (conn.condEnabled) {
      const val = this._stateValueOf(sourceNode);
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
      default:               return typeof conn.rate === 'number' ? conn.rate : (parseFloat(conn.rate) || 0);
    }
  }

  _record() {
    const snap = {};
    for (const n of this.diagram.nodes.values()) {
      if (n.type === NodeType.SOURCE) continue;
      snap[n.id] = n.chartValue;
    }
    this.history.push({ step: this.step, snap });
    if (this.history.length > 300) this.history.shift();
  }
}
