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
      const infiniteSource = n.type === NodeType.SOURCE && !n.limited;
      n._initialResources = infiniteSource ? Infinity : n.resources;
      n._initialColorMap = { ...n.colorMap };
    }
  }

  reset() {
    this.stop();
    this.step = 0;
    this.history = [];
    this.ended = null;
    for (const n of this.diagram.nodes.values()) {
      const infiniteSource = n.type === NodeType.SOURCE && !n.limited;
      n.resources = n._initialResources ?? (infiniteSource ? Infinity : 0);
      n.colorMap = { ...(n._initialColorMap || {}) };
      if (n.type === NodeType.DELAY) n._queue = [];
      if (n.type === NodeType.QUEUE) {
        n._proc = null;
        // Rebuild the FIFO from any pre-loaded starting resources.
        n._fifo = Object.entries(n.colorMap).filter(([, a]) => a > 0).map(([color, amount]) => ({ amount, color }));
      }
      if (n.type === NodeType.SOURCE) n.produced = 0;
      if (n.type === NodeType.DRAIN) n.drained = 0;
      if (n.type === NodeType.REGISTER) n.value = 0;
      if (n.type === NodeType.TRADER) n.trades = 0;
    }
    this.diagram.variables = {};
    // Compute initial variable/register values so the display is correct
    // before the first step runs.
    this._sampleRandomVars('all');
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
    // Per-step random variables get a fresh value visible to this step's
    // rate formulas; per-play ones keep the value sampled when Run started.
    this._sampleRandomVars('step');
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
    // Pressing Play resamples 'play'-updated random variables once.
    this._sampleRandomVars('play');
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
    this._applyPushProposals(ctx);
    this._applyCtx(ctx);
    this._updateVariables();
    this._evalRegisters();
    if (this.onStep) this.onStep(this.step, fired, ctx.transfers);
    this._checkEnd();
  }

  // ── Core tick ───────────────────────────────────────────────────────────

  _makeCtx() {
    return {
      gives: new Map(),        // nodeId → {color: amount}
      delayIn: new Map(),      // nodeId → [{amount, color}]
      reserved: new Map(),     // nodeId → capacity reserved this step
      transfers: [],           // [{connId, color, amount}] for animation
      pushProposals: [],       // [{srcNode, srcId, tgtId, connId, colorFilter, want, ...}]
    };
  }

  _tick() {
    const d = this.diagram;
    const ctx = this._makeCtx();
    const fired = [];
    // A node activates at most once per step. This set is shared across the
    // initial, reverse-trigger, and artificial-player phases so a node that is
    // both automatic and triggered (or targeted by several triggers, or part of
    // a mutual-trigger pair) still fires exactly once.
    const activated = new Set();

    // Seed the fire queue with automatic / starting nodes, then let triggers
    // cascade. Connection rate formulas read diagram.variables, which holds the
    // values committed at the end of the previous step (or from reset()).
    const initial = [];
    const asyncMode = d.timeMode === 'async';
    for (const n of d.nodes.values()) {
      if (n.activation === ActivationMode.STARTING) {
        if (this.step === 1) initial.push({ node: n, forced: false });
        continue;
      }
      if (n.activation !== ActivationMode.AUTOMATIC) continue;
      // Asynchronous time mode: each automatic node fires on its own rhythm.
      if (asyncMode) {
        const every = Math.max(1, Math.round(n.fireEvery || 1));
        const phase = Math.max(0, Math.round(n.firePhase || 0));
        const t = (this.step - 1) - phase;
        if (t < 0 || t % every !== 0) continue;
      }
      initial.push({ node: n, forced: false });
    }
    this._runFireQueue(initial, ctx, fired, activated);

    // Reverse triggers: auto-nodes that didn't fire pulse their "fail" targets.
    const firedSet = new Set(fired);
    const failQueue = [];
    for (const { node } of initial) {
      if (firedSet.has(node.id)) continue;
      for (const c of d.outgoing(node.id)) {
        if (c.type === ConnectionType.STATE && c.reverseTrigger) {
          const tgt = d.nodes.get(c.targetId);
          if (tgt) failQueue.push({ node: tgt, forced: true });
        }
      }
    }
    if (failQueue.length) this._runFireQueue(failQueue, ctx, fired, activated);

    // Artificial player: fire scheduled / conditional interactive nodes as if a
    // user clicked them, within this same tick (flows still commit atomically).
    const ai = d.aiPlayer;
    if (ai && ai.enabled && Array.isArray(ai.rules) && ai.rules.length) {
      const aiQueue = [];
      for (const rule of ai.rules) {
        const node = d.nodes.get(rule.nodeId);
        if (!node || node.activation !== ActivationMode.INTERACTIVE) continue;
        if (this._aiRuleFires(rule)) aiQueue.push({ node, forced: true });
      }
      if (aiQueue.length) this._runFireQueue(aiQueue, ctx, fired, activated);
    }

    // Resolve cross-node push contention: fair-allocate capacity across
    // competing source nodes BEFORE delays/queues claim remaining room.
    this._applyPushProposals(ctx);

    // Advance delay queues and queue nodes (releases respect target capacity).
    this._advanceDelays(ctx);
    this._advanceQueues(ctx);

    // Commit all flows atomically.
    this._applyCtx(ctx);

    // Apply state-connection modifiers (in-place growth / decay) on the
    // committed state, then refresh shared variables + registers.
    this._applyModifiers();
    this._updateVariables();
    this._evalRegisters();

    return { fired, transfers: ctx.transfers };
  }

  // Fire a worklist of nodes; each successful fire enqueues its trigger targets
  // (state connections marked `trigger`). A node activates at most once per tick
  // (`activated`), which both enforces correct semantics and bounds cascades.
  _runFireQueue(initial, ctx, fired, activated = new Set()) {
    const d = this.diagram;
    const queue = [...initial];
    let guard = 0;
    while (queue.length && guard++ < 5000) {
      const { node, forced } = queue.shift();
      if (!node || activated.has(node.id)) continue;
      if (!this._nodeEnabled(node)) continue;
      if (!this._fireNode(node, ctx, forced)) continue;
      activated.add(node.id);
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
    if (node.type === NodeType.TRADER) return node.trades || 0;
    return node.resources;
  }

  // Resample custom random variables and publish them into the variable store.
  // which: 'all' (reset), 'step' (each step), 'play' (each Run press).
  _sampleRandomVars(which) {
    const d = this.diagram;
    for (const rv of d.randomVars || []) {
      if (which !== 'all' && (rv.update || 'step') !== which) continue;
      rv.value = sampleRandomVar(rv);
      if (rv.name && VALID_IDENT.test(rv.name)) d.variables[rv.name] = rv.value;
    }
  }

  _updateVariables() {
    const d = this.diagram;
    // Seed from user-defined params first, then random variables; state
    // connections override both.
    for (const [k, v] of Object.entries(d.params || {})) {
      if (VALID_IDENT.test(k) && typeof v === 'number' && isFinite(v)) d.variables[k] = v;
    }
    for (const rv of d.randomVars || []) {
      if (rv.name && VALID_IDENT.test(rv.name) && isFinite(rv.value)) d.variables[rv.name] = rv.value;
    }
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
    const regs = [...d.nodes.values()].filter(n => n.type === NodeType.REGISTER);
    if (!regs.length) return;
    // Re-evaluate to a fixpoint so registers that reference other registers'
    // labels resolve in one tick regardless of node-creation order. Bounded by
    // the register count (the longest possible dependency chain).
    for (let pass = 0; pass < regs.length; pass++) {
      let changed = false;
      for (const n of regs) {
        const prev = n.value;
        this._evalRegister(n, d);
        if (n.value !== prev) changed = true;
      }
      if (!changed) break;
    }
  }

  _evalRegister(n, d) {
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

  // ── Firing ────────────────────────────────────────────────────────────────

  _fireNode(node, ctx, interactive) {
    const d = this.diagram;
    let any = false;

    // Pull phase: pool/drain in pull mode draws along its incoming connections.
    if ((node.type === NodeType.POOL || node.type === NodeType.DRAIN) && node.flowMode === 'pull') {
      if (this._firePull(node, ctx, interactive)) any = true;
    }

    // Traders read both their incoming and outgoing connections, so they are
    // handled before the no-outputs early return below.
    if (node.type === NodeType.TRADER) {
      return this._fireTrader(node, ctx, interactive) || any;
    }

    const outs = d.outgoing(node.id).filter(c => c.type === ConnectionType.RESOURCE);
    if (!outs.length) return any;

    if (node.type === NodeType.GATE) {
      return (node.resources > 0 && this._fireGate(node, outs, ctx)) || any;
    }
    if (node.type === NodeType.CONVERTER) {
      return this._fireConverter(node, outs, ctx) || any;
    }
    if (node.type === NodeType.SOURCE) {
      // A limited source holds a finite stock and behaves like a pool (but
      // still tracks `produced`). An unlimited source emits independently.
      if (node.limited) return this._firePool(node, outs, ctx, interactive, true) || any;
      for (const conn of outs) {
        if (this._targetDriven(conn)) continue; // pulled by its target instead
        if (!interactive && !this._connFires(conn, node)) continue;
        if (this._pushSource(node, conn, ctx)) any = true;
      }
      return any;
    }
    if (node.type === NodeType.POOL) {
      return this._firePool(node, outs, ctx, interactive) || any;
    }
    return any;
  }

  // A resource connection is driven by its target (pull) when the target is in
  // pull mode and the provider is a pool or source; otherwise by its source.
  _targetDriven(conn) {
    const tgt = this.diagram.nodes.get(conn.targetId);
    const src = this.diagram.nodes.get(conn.sourceId);
    if (!tgt || !src) return false;
    return tgt.flowMode === 'pull' && (src.type === NodeType.POOL || src.type === NodeType.SOURCE);
  }

  // Pull phase for a pool/drain: draw each incoming target-driven connection's
  // rate from its provider (pool stock or infinite source), into this node.
  _firePull(node, ctx, interactive) {
    const d = this.diagram;
    const ins = d.incoming(node.id).filter(c => c.type === ConnectionType.RESOURCE && this._targetDriven(c));
    if (!ins.length) return false;

    const reqs = [];
    for (const conn of ins) {
      const src = d.nodes.get(conn.sourceId);
      if (!interactive && !this._connFires(conn, src)) continue;
      const want = Math.max(0, Math.round(this._connRate(conn)));
      if (want > 0) reqs.push({ conn, src, want });
    }
    if (!reqs.length) return false;

    // pull-all is atomic: move nothing unless EVERY provider can supply its full
    // rate (honouring colour filters) AND this node can hold the entire pull.
    if (node.pullPolicy === 'all') {
      let totalWant = 0;
      for (const r of reqs) {
        totalWant += r.want;
        let avail;
        if (r.src.type === NodeType.SOURCE && !r.src.limited) {
          // Infinite source: the filter must match its single output colour.
          const color = r.src.resourceColor || DEFAULT_COLOR;
          avail = (r.conn.colorFilter && color !== r.conn.colorFilter) ? 0 : r.want;
        } else {
          avail = r.conn.colorFilter ? (r.src.colorMap[r.conn.colorFilter] || 0) : r.src.resources;
        }
        if (avail < r.want) return false;
      }
      // The pulling node must have room for the whole batch (capacity-aware).
      if (this._acceptable(node.id, totalWant, ctx) < totalWant) return false;
    }

    let moved = false;
    for (const { conn, src, want } of reqs) {
      const amt = this._acceptable(node.id, want, ctx); // capped by this node's room
      if (amt <= 0) continue;
      if (src.type === NodeType.SOURCE && !src.limited) {
        const color = src.resourceColor || DEFAULT_COLOR;
        if (conn.colorFilter && color !== conn.colorFilter) continue;
        src.produced += amt;
        this._give(node.id, color, amt, conn.id, ctx);
        this._reserve(node.id, amt, ctx);
        moved = true;
      } else {
        const taken = src.takeResources(amt, conn.colorFilter || null);
        let total = 0;
        for (const { amount, color } of taken) { this._give(node.id, color, amount, conn.id, ctx); total += amount; }
        if (total > 0) {
          if (src.type === NodeType.SOURCE) src.produced += total; // limited source
          this._reserve(node.id, total, ctx);
          moved = true;
        }
      }
    }
    return moved;
  }

  // Sources are infinite, so each outgoing connection is independent.
  // We queue a proposal rather than applying immediately; _applyPushProposals
  // runs cross-node fair allocation across all competing pushers after all
  // nodes have declared their wants.
  _pushSource(node, conn, ctx) {
    const rate = Math.max(0, Math.round(this._connRate(conn)));
    if (rate <= 0) return false;
    const color = node.resourceColor || DEFAULT_COLOR;
    if (conn.colorFilter && color !== conn.colorFilter) return false;
    // Only enqueue if the target can accept at least 1 unit from non-pool
    // sources already seen (converters, gates, pull nodes). If the target is
    // already fully reserved by those, skip — the source didn't fire.
    if (this._acceptable(conn.targetId, 1, ctx) <= 0) return false;
    ctx.pushProposals.push({
      srcNode: node, srcId: node.id,
      tgtId: conn.targetId, connId: conn.id,
      colorFilter: conn.colorFilter || null,
      want: rate, isInfSource: true, srcColor: color,
    });
    return true;
  }

  // A pool's outgoing connections compete for its finite resources. Allocate
  // max-min fair (each activating connection gets its first unit before any
  // gets a second), so distribution is order-independent and a greedy
  // high-rate connection can't starve low-rate / probabilistic ones.
  //
  // Rather than applying immediately, we queue proposals into ctx.pushProposals.
  // _applyPushProposals (called after all nodes have declared their wants) then
  // runs cross-node fair allocation so two separate pools pushing into the same
  // capacity-limited target each receive a fair share — not first-come-first-served.
  _firePool(node, outs, ctx, interactive, trackProduced = false) {
    node.reconcile();
    if (node.resources <= 0) return false;

    // localReserved tracks this pool's own promises to the same target on
    // multiple connections (rare). It is separate from ctx.reserved (which only
    // holds non-pool contributions such as converters, gates, and pull nodes).
    const localReserved = new Map();
    const reqs = [];
    for (const conn of outs) {
      if (this._targetDriven(conn)) continue;
      if (!interactive && !this._connFires(conn, node)) continue;
      let want = Math.max(0, Math.round(this._connRate(conn)));
      if (want <= 0) continue;
      const tgt = this.diagram.nodes.get(conn.targetId);
      if (!tgt) continue;
      if (tgt.type === NodeType.SOURCE || tgt.type === NodeType.REGISTER
        || tgt.type === NodeType.TRADER) continue;
      // Work-conserving cap: use ctx.reserved (converters, gates, pull nodes)
      // plus localReserved (this pool's other connections to the same target).
      // We deliberately exclude other pools' proposals so _applyPushProposals
      // can distribute that remaining room fairly across all competing pools.
      if (tgt.capacity !== Infinity && tgt.type !== NodeType.DRAIN) {
        const lRes = localReserved.get(conn.targetId) || 0;
        const room = Math.max(0, tgt.capacity - tgt.resources - (ctx.reserved.get(conn.targetId) || 0) - lRes);
        want = Math.min(want, room);
      }
      if (want <= 0) continue;
      localReserved.set(conn.targetId, (localReserved.get(conn.targetId) || 0) + want);
      reqs.push({ conn, want });
    }
    if (!reqs.length) return false;

    const alloc = this._fairAllocate(node.resources, reqs.map(r => r.want));
    let any = false;
    reqs.forEach((r, i) => {
      if (alloc[i] <= 0) return;
      ctx.pushProposals.push({
        srcNode: node, srcId: node.id,
        tgtId: r.conn.targetId, connId: r.conn.id,
        colorFilter: r.conn.colorFilter || null,
        want: alloc[i], trackProduced,
      });
      any = true;
    });
    return any;
  }

  // Apply all push proposals accumulated during the fire phase. For each target
  // with proposals from multiple source nodes, run max-min fair allocation
  // across those source groups so capacity is shared equitably — not awarded by
  // node-insertion order. Conservation is maintained: sources only lose what the
  // target actually accepts.
  _applyPushProposals(ctx) {
    const d = this.diagram;
    if (!ctx.pushProposals.length) return;

    // Group proposals by target.
    const byTarget = new Map();
    for (const p of ctx.pushProposals) {
      if (!byTarget.has(p.tgtId)) byTarget.set(p.tgtId, []);
      byTarget.get(p.tgtId).push(p);
    }

    for (const [tgtId, proposals] of byTarget) {
      const tgt = d.nodes.get(tgtId);
      if (!tgt) continue;

      // Room after non-pool reservations (converters, gates, pull nodes).
      let room;
      if (tgt.type === NodeType.DRAIN || tgt.capacity === Infinity) {
        room = Infinity;
      } else {
        room = Math.max(0, tgt.capacity - tgt.resources - (ctx.reserved.get(tgtId) || 0));
      }

      // Group proposals by source node for cross-node fair allocation.
      const srcEntries = [];
      const srcIdx = new Map();
      for (const p of proposals) {
        if (!srcIdx.has(p.srcId)) {
          srcIdx.set(p.srcId, srcEntries.length);
          srcEntries.push({ proposals: [], totalWant: 0 });
        }
        const entry = srcEntries[srcIdx.get(p.srcId)];
        entry.proposals.push(p);
        entry.totalWant += p.want;
      }

      // Fair-allocate room across competing source nodes.
      const groupWants = srcEntries.map(e => e.totalWant);
      const groupAllocs = room === Infinity
        ? groupWants.slice()
        : this._fairAllocate(room, groupWants);

      srcEntries.forEach((entry, gi) => {
        let budget = groupAllocs[gi];
        if (budget <= 0) return;

        for (const p of entry.proposals) {
          if (budget <= 0) break;
          const give = Math.min(p.want, budget);
          if (give <= 0) continue;

          if (p.isInfSource) {
            p.srcNode.produced += give;
            this._give(tgtId, p.srcColor, give, p.connId, ctx);
            this._reserve(tgtId, give, ctx);
            budget -= give;
          } else {
            const taken = p.srcNode.takeResources(give, p.colorFilter);
            let moved = 0;
            for (const { amount, color } of taken) {
              this._give(tgtId, color, amount, p.connId, ctx);
              moved += amount;
            }
            if (moved > 0) {
              if (p.trackProduced) p.srcNode.produced += moved;
              this._reserve(tgtId, moved, ctx);
              budget -= moved;
            }
          }
        }
      });
    }
  }

  // Max-min fair integer allocation of `available` across `wants`.
  _fairAllocate(available, wants) {
    const alloc = wants.map(() => 0);
    let remaining = available;
    let active = wants.map((w, i) => i).filter(i => wants[i] > 0);

    while (remaining > 0 && active.length) {
      const share = Math.floor(remaining / active.length);
      if (share <= 0) break;
      let used = 0;
      for (const i of active) {
        const give = Math.min(share, wants[i] - alloc[i]);
        alloc[i] += give; used += give;
      }
      remaining -= used;
      active = active.filter(i => alloc[i] < wants[i]);
      if (used <= 0) break;
    }
    // Hand out the sub-unit remainder one at a time, round-robin.
    for (let k = 0; remaining > 0 && active.length; k++) {
      const i = active[k % active.length];
      alloc[i]++; remaining--;
      active = active.filter(j => alloc[j] < wants[j]);
    }
    return alloc;
  }

  // Split `total` into integer shares proportional to `weights` (remainder
  // distributed round-robin). Zero total weight falls back to an even split.
  _proportionalShares(total, weights) {
    const n = weights.length;
    const wSum = weights.reduce((a, b) => a + b, 0);
    const shares = weights.map(w => wSum > 0 ? Math.floor(total * w / wSum) : 0);
    let rem = total - shares.reduce((a, b) => a + b, 0);
    for (let i = 0; rem > 0 && n; i++, rem--) shares[i % n]++;
    return shares;
  }

  // Converter: consumes `inputAmount` of held resources per conversion and
  // emits each outgoing connection's rate in the converter's output color.
  _fireConverter(node, outs, ctx) {
    const need = Math.max(1, Math.round(node.inputAmount || 1));
    let conversions = 0, guard = 0;

    while (node.resources >= need && guard++ < 10000) {
      // Figure out how much each output can take, reserving as we go so two
      // connections to the same target can't jointly exceed its capacity.
      const grants = [];
      for (const c of outs) {
        const want = Math.max(0, Math.round(this._connRate(c)));
        const amt = this._acceptable(c.targetId, want, ctx);
        if (amt > 0) { this._reserve(c.targetId, amt, ctx); grants.push({ c, amt }); }
      }
      if (!grants.length) break; // every output full — stop, keep the input

      node.takeResources(need);
      conversions++;
      const color = node.outputColor || DEFAULT_COLOR;
      for (const g of grants) {
        this._give(g.c.targetId, color, g.amt, g.c.id, ctx); // already reserved above
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

    if (mode === 'all') {
      // All-outputs: each output gets its full weight amount (work-conserving).
      for (const conn of outs) {
        if (node.resources <= 0) break;
        const want = Math.max(0, Math.round(this._connWeight(conn)));
        if (want <= 0) continue;
        const amt = Math.min(want, node.resources);
        const accept = this._acceptable(conn.targetId, amt, ctx);
        if (accept <= 0) continue;
        const taken = node.takeResources(accept);
        let moved = 0;
        for (const { amount, color } of taken) {
          this._give(conn.targetId, color, amount, conn.id, ctx);
          moved += amount;
        }
        if (moved > 0) { this._reserve(conn.targetId, moved, ctx); movedAny = true; }
      }
      return movedAny;
    }

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
    const shares = this._proportionalShares(node.resources, weights);

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

  // Trader: an atomic exchange between two partner nodes.
  //
  //   A --x--> [T] --y--> B   means   "A pays x to B, B pays y back to A".
  //
  // The i-th incoming resource connection pairs with the i-th outgoing one
  // (wiring order). A pair trades only if BOTH sides can pay their full rate
  // AND both can accept what they receive — otherwise nothing moves (no
  // partial trades). The trader itself never holds resources; it counts
  // completed exchanges in `trades` (its chart/state value).
  //
  // Each connection's colour filter constrains what that side pays: the
  // incoming connection's filter is what A pays, the outgoing one's is what
  // B pays. Resources keep their colours as they change hands.
  _fireTrader(node, ctx, interactive) {
    const d = this.diagram;
    const ins = d.incoming(node.id).filter(c => c.type === ConnectionType.RESOURCE);
    const outs = d.outgoing(node.id).filter(c => c.type === ConnectionType.RESOURCE);
    const pairs = Math.min(ins.length, outs.length);
    let traded = false;

    // How much `n` could pay along `conn` (colour-filter aware); Infinity for
    // an unlimited source whose output colour passes the filter.
    const payable = (n, conn) => {
      if (n.type === NodeType.SOURCE && !n.limited) {
        const color = n.resourceColor || DEFAULT_COLOR;
        return (conn.colorFilter && color !== conn.colorFilter) ? 0 : Infinity;
      }
      n.reconcile();
      return conn.colorFilter ? (n.colorMap[conn.colorFilter] || 0) : n.resources;
    };

    // Move `amount` from `from` to `to` along `conn` (animation + commit via
    // ctx). Assumes payable/acceptable were verified.
    const pay = (from, to, amount, conn) => {
      if (from.type === NodeType.SOURCE && !from.limited) {
        from.produced += amount;
        this._give(to.id, from.resourceColor || DEFAULT_COLOR, amount, conn.id, ctx);
      } else {
        for (const { amount: amt, color } of from.takeResources(amount, conn.colorFilter || null)) {
          this._give(to.id, color, amt, conn.id, ctx);
        }
        if (from.type === NodeType.SOURCE) from.produced += amount; // limited source
      }
      this._reserve(to.id, amount, ctx);
    };

    for (let i = 0; i < pairs; i++) {
      const cin = ins[i], cout = outs[i];
      const A = d.nodes.get(cin.sourceId);
      const B = d.nodes.get(cout.targetId);
      if (!A || !B || A.id === B.id) continue;
      if (!interactive && (!this._connFires(cin, A) || !this._connFires(cout, B))) continue;

      const x = Math.max(0, Math.round(this._connRate(cin)));   // A pays x
      const y = Math.max(0, Math.round(this._connRate(cout)));  // B pays y
      if (x <= 0 && y <= 0) continue;

      // Atomicity: both sides must be able to pay AND receive in full. The
      // exchange is simultaneous, so each side's room is credited with what it
      // pays away (a full pool can still swap like-for-like).
      const canAccept = (n, recv, pays) => {
        if (recv <= 0) return true;
        if (n.type === NodeType.SOURCE || n.type === NodeType.REGISTER) return false;
        if (n.capacity === Infinity || n.type === NodeType.DRAIN) return true;
        return n.capacity - n.resources - (ctx.reserved.get(n.id) || 0) + pays >= recv;
      };
      if (payable(A, cin) < x || payable(B, cout) < y) continue;
      if (!canAccept(B, x, y) || !canAccept(A, y, x)) continue;

      if (x > 0) pay(A, B, x, cin);
      if (y > 0) pay(B, A, y, cout);
      node.trades = (node.trades || 0) + 1;
      traded = true;
    }
    return traded;
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

        // Release the matured amount split across all outputs by their rate
        // (treated as a weight), so a second output isn't starved by the first.
        const shares = this._proportionalShares(
          item.amount, outs.map(c => Math.max(0, this._connRate(c))));
        let leftover = 0;
        outs.forEach((c, i) => {
          const accept = this._acceptable(c.targetId, shares[i], ctx);
          if (accept > 0) {
            this._give(c.targetId, item.color, accept, c.id, ctx);
            this._reserve(c.targetId, accept, ctx);
            n.resources = Math.max(0, n.resources - accept);
            if (n.colorMap[item.color]) n.colorMap[item.color] = Math.max(0, n.colorMap[item.color] - accept);
          }
          leftover += shares[i] - accept;
        });
        if (leftover > 0) still.push({ amount: leftover, color: item.color, stepsLeft: 1 });
      }
      n._queue = still;
      for (const k of Object.keys(n.colorMap)) if (n.colorMap[k] <= 0) delete n.colorMap[k];
    }
  }

  // Queue: a single-server FIFO. One unit is "in service" at a time and takes
  // `processTime` steps; finished units are released to an output with room.
  // This serializes throughput (1 unit / processTime) and adds per-item latency
  // — distinct from a Delay (which releases a whole batch together).
  _advanceQueues(ctx) {
    const d = this.diagram;
    for (const n of d.nodes.values()) {
      if (n.type !== NodeType.QUEUE) continue;
      const pt = Math.max(1, Math.round(n.processTime || 1));
      const outs = d.outgoing(n.id).filter(c => c.type === ConnectionType.RESOURCE);

      // Progress the unit currently in service; release it when finished.
      if (n._proc) {
        if (n._proc.stepsLeft > 0) n._proc.stepsLeft--;
        if (n._proc.stepsLeft <= 0) {
          const color = n._proc.color;
          let released = false;
          for (const c of outs) {
            if (this._acceptable(c.targetId, 1, ctx) >= 1) {
              this._give(c.targetId, color, 1, c.id, ctx);
              this._reserve(c.targetId, 1, ctx);
              n.resources = Math.max(0, n.resources - 1);
              if (n.colorMap[color]) n.colorMap[color] = Math.max(0, n.colorMap[color] - 1);
              released = true;
              break;
            }
          }
          if (released) n._proc = null; // else hold (output full); retry next step
        }
      }

      // Start the next waiting unit if the server is idle.
      if (!n._proc) {
        const color = this._dequeueUnit(n);
        if (color != null) n._proc = { color, stepsLeft: pt };
      }

      for (const k of Object.keys(n.colorMap)) if (n.colorMap[k] <= 0) delete n.colorMap[k];
    }
  }

  // Remove one unit from the front of a queue's FIFO buffer (keeps it counted
  // in node.resources until it is actually released).
  _dequeueUnit(n) {
    while (n._fifo && n._fifo.length) {
      const head = n._fifo[0];
      if (head.amount <= 0) { n._fifo.shift(); continue; }
      head.amount -= 1;
      if (head.amount <= 0) n._fifo.shift();
      return head.color;
    }
    return null;
  }

  // State-connection modifiers: each step, add `modFactor * sourceValue` to the
  // target node's resources (negative factors decay it). Targets pools and
  // converters (accumulators).
  //
  // Source values are snapshotted BEFORE any delta is applied, so a network of
  // modifiers (mutual or chained, e.g. A→B→C) is order-independent and reads the
  // step's starting values — matching the engine's atomic, one-step-lag model.
  _applyModifiers() {
    const d = this.diagram;
    const mods = [];
    for (const conn of d.connections.values()) {
      if (conn.type !== ConnectionType.STATE || !conn.modifier) continue;
      const src = d.nodes.get(conn.sourceId);
      const tgt = d.nodes.get(conn.targetId);
      if (!src || !tgt || !this._canModify(tgt)) continue;
      const factor = Number(conn.modFactor);
      if (!isFinite(factor) || factor === 0) continue;
      const delta = Math.round(factor * this._stateValueOf(src)); // pre-apply snapshot
      if (!isFinite(delta) || delta === 0) continue;
      mods.push({ src, tgt, delta });
    }
    for (const { src, tgt, delta } of mods) {
      if (delta > 0) {
        const room = tgt.capacity === Infinity ? delta : Math.max(0, tgt.capacity - tgt.resources);
        const add = Math.min(delta, room);
        if (add > 0) {
          const color = dominantColor(tgt.colorMap)
            || (src.type === NodeType.SOURCE ? src.resourceColor : null) || DEFAULT_COLOR;
          tgt.addResources(add, color);
        }
      } else {
        tgt.takeResources(-delta);
      }
    }
  }

  _canModify(tgt) {
    return tgt.type === NodeType.POOL || tgt.type === NodeType.CONVERTER;
  }

  // ── Flow plumbing ─────────────────────────────────────────────────────────

  // How much a target can still accept this step (capacity-aware).
  _acceptable(targetId, want, ctx) {
    const tgt = this.diagram.nodes.get(targetId);
    if (!tgt || want <= 0) return 0;
    // Resources can't flow into a source or a register (registers are driven
    // by state connections / formulas, not by holding resources). A trader
    // never holds resources either — its connections are trade routes that
    // only the trader itself drives when it fires.
    if (tgt.type === NodeType.SOURCE || tgt.type === NodeType.REGISTER
      || tgt.type === NodeType.TRADER) return 0;
    // Drains are sinks (no capacity). Anything else with an unlimited capacity
    // accepts freely; a finite capacity (incl. on a delay) is honoured below.
    if (tgt.capacity === Infinity || tgt.type === NodeType.DRAIN) return want;
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
      for (const [color, amount] of Object.entries(colorAmounts)) {
        n.addResources(amount, color);
        // Queues line incoming resources up in arrival order (FIFO buffer).
        if (n.type === NodeType.QUEUE) { n._fifo = n._fifo || []; n._fifo.push({ amount, color }); }
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

  // Does an artificial-player rule fire this step? 'interval' fires every N
  // steps; 'condition' fires while a named variable satisfies the comparison.
  _aiRuleFires(rule) {
    if (rule.mode === 'condition') {
      const v = this.diagram.variables[rule.condVar] ?? 0;
      return this._evalCond(v, rule.condOp || '>=', Number(rule.condValue) || 0);
    }
    const every = Math.max(1, Math.round(rule.every || 1));
    return ((this.step - 1) % every) === 0;
  }

  _connFires(conn, sourceNode) {
    if (conn.interval > 1 && (this.step - 1) % conn.interval !== 0) return false;
    if (conn.chance < 100 && Math.random() * 100 >= conn.chance) return false;
    if (conn.condEnabled) {
      const val = (conn.condRefMode === 'variable' && conn.condVariable)
        ? (this.diagram.variables[conn.condVariable] ?? 0)
        : this._stateValueOf(sourceNode);
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
    let r;
    switch (conn.rateMode) {
      case RateMode.DICE:         r = rollDice(conn.dice); break;
      case RateMode.FORMULA:      r = evalFormula(conn.formula, this.diagram.variables); break;
      case RateMode.DISTRIBUTION: r = sampleDist(conn.distType, conn.distParam1, conn.distParam2); break;
      default:                    r = typeof conn.rate === 'number' ? conn.rate : parseFloat(conn.rate); break;
    }
    // Never propagate a non-finite rate — it would corrupt downstream node state.
    return isFinite(r) ? r : 0;
  }

  _record() {
    const snap = {};
    for (const n of this.diagram.nodes.values()) {
      if (n.type === NodeType.SOURCE && !n.limited) continue;
      snap[n.id] = n.chartValue;
    }
    this.history.push({ step: this.step, snap });
    if (this.history.length > 300) this.history.shift();
  }

  // ── Monte Carlo ───────────────────────────────────────────────────────────

  // Run the diagram `runs` times (each on an isolated clone, fresh RNG) for up
  // to `maxSteps` steps, and summarise the distribution of every tracked node's
  // final value plus goal statistics. Does not touch the live diagram.
  runMonteCarlo(runs = 100, maxSteps = 200) {
    runs = Math.max(1, Math.round(runs));
    maxSteps = Math.max(1, Math.round(maxSteps));
    const base = this.diagram.toJSON();
    const tracked = [...this.diagram.nodes.values()].filter(n => n.type !== NodeType.SOURCE || n.limited);
    const samples = new Map(tracked.map(n => [n.id, []]));
    const endSteps = [];
    let endedCount = 0;

    for (let r = 0; r < runs; r++) {
      const dg = new Diagram();
      dg.loadJSON(JSON.parse(JSON.stringify(base)));
      const eng = new SimEngine(dg);
      eng.reset();
      let s = 0;
      while (s < maxSteps && !eng.ended) { eng.doStep(); s++; }
      for (const [id, arr] of samples) {
        const n = dg.nodes.get(id);
        arr.push(n ? n.chartValue : 0);
      }
      if (eng.ended) { endedCount++; endSteps.push(eng.ended.step); }
    }

    return {
      runs, maxSteps,
      nodes: tracked.map(n => ({
        id: n.id, label: n.label, type: n.type, ...this._stats(samples.get(n.id)),
      })),
      endedRate: endedCount / runs,
      endStep: endSteps.length ? this._stats(endSteps) : null,
    };
  }

  _stats(arr) {
    if (!arr || !arr.length) return { mean: 0, min: 0, max: 0, p10: 0, p50: 0, p90: 0 };
    const s = [...arr].sort((a, b) => a - b);
    const pct = p => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return {
      mean: Math.round(mean * 100) / 100,
      min: s[0], max: s[s.length - 1],
      p10: pct(0.10), p50: pct(0.50), p90: pct(0.90),
    };
  }
}
