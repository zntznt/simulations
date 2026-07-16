// The "why" layer: feedback-loop detection.
//
// detectLoops(diagram) finds every elementary cycle in the diagram's causal
// graph and classifies it as reinforcing (R), balancing (B), a pure resource
// circulation (F) or unclear (?) from the product of its link polarities —
// the classic system-dynamics rule: an even number of negative links
// amplifies, an odd number stabilizes.
//
// The causal graph is wider than the drawn arrows. Edges come from:
//   - resource connections (flow feeds the target: +)
//   - state-connection roles: trigger (+), reverse trigger (−), activator
//     (sign from its operator: >/>= +, </<= −, otherwise unknown), modifier
//     (sign of the factor, or a numeric probe of the formula)
//   - a plain state connection mirrored into a formula-less register (+)
//   - implicit formula reads: a register formula, a connection's rate/weight/
//     modifier formula, or a variable condition consumes a published variable
//     (state-connection names, register labels) — an edge from the publishing
//     node to the affected node, signed by numerically probing the formula
//     (seeded, so stochastic formulas probe deterministically)
//
// Parallel edges between the same pair collapse into one link (mixed signs
// become unknown). Enumeration is a bounded Johnson-style DFS: cycles only
// start at their smallest node index, and maxLoops/maxLen caps guard against
// dense graphs — `truncated` reports when a cap bit.
//
// DOM-free (browser, cli.js, test/run.js); loads after model.js, which
// provides evalFormula, SimRandom and VALID_IDENT.

/* exported detectLoops */

// Names that appear in formulas without being diagram variables.
const LOOP_BUILTINS = new Set([
  'round', 'floor', 'ceil', 'abs', 'min', 'max', 'sqrt', 'log', 'exp', 'mod', 'pow',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sign', 'clamp',
  'random', 'randomInt', 'pickRandom', 'pi', 'e', 'PI', 'E',
  'true', 'false', 'and', 'or', 'not', 'xor', 'to', 'in', 'Math', 'Infinity', 'NaN',
]);

function _loopIdents(expr) {
  const out = new Set();
  for (const m of String(expr || '').matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    if (!LOOP_BUILTINS.has(m[0])) out.add(m[0]);
  }
  return out;
}

// Sign of d(expr)/d(name), sampled numerically at a few base points with every
// other identifier held fixed. Returns +1, -1, 0 (mixed / non-monotonic) or
// null (no measurable influence — the edge is dropped). Stochastic formulas
// probe deterministically: the RNG is re-seeded identically before each
// evaluation, so the sampled difference isolates the probed variable.
function _loopProbeSign(expr, name, baseVars) {
  const rng = SimRandom.getState();
  const signs = new Set();
  try {
    for (const base of [0.7, 3, 11]) {
      const at = (v) => {
        SimRandom.seed('loop-probe');
        return evalFormula(expr, { ...baseVars, [name]: v });
      };
      const d = at(base * 1.07 + 0.4) - at(base);
      if (d > 1e-9) signs.add(1);
      else if (d < -1e-9) signs.add(-1);
    }
  } finally {
    SimRandom.setState(rng);
  }
  if (signs.size === 1) return [...signs][0];
  return signs.size === 0 ? null : 0;
}

function _loopOpSign(op) {
  if (op === '>' || op === '>=') return 1;
  if (op === '<' || op === '<=') return -1;
  return 0; // ==, !=, between: no monotone polarity
}

function detectLoops(diagram, opts = {}) {
  const maxLoops = opts.maxLoops ?? 100;
  const maxLen = opts.maxLen ?? 10;
  const d = diagram;

  // Publishers: variable name → node id whose value the engine writes there.
  // Mirrors _updateVariables (state connections) and _evalRegister (labels);
  // like the engine, later state connections win a name collision.
  const pub = new Map();
  for (const n of d.nodes.values()) {
    if (n.type === NodeType.REGISTER && n.label && VALID_IDENT.test(n.label)) pub.set(n.label, n.id);
  }
  for (const c of d.connections.values()) {
    if (c.type !== ConnectionType.STATE) continue;
    const name = c.variableName || c.label;
    if (name && d.nodes.has(c.sourceId)) pub.set(name, c.sourceId);
  }

  // Neutral variable snapshot for probing: every published/param name at its
  // current value where one exists, 1 otherwise (set per formula below).
  const baseVars = {};
  for (const [k, v] of Object.entries(d.variables || {})) if (isFinite(v)) baseVars[k] = v;
  for (const [k, v] of Object.entries(d.params || {})) if (isFinite(v)) baseVars[k] = v;

  // Raw directed edges: {from, to, sign, kind, connId, via}.
  // sign: +1 | -1 | 0 (unknown). Edges with no influence are skipped.
  const raw = [];
  const addFormulaEdges = (expr, toId, via) => {
    const idents = _loopIdents(expr);
    if (!idents.size) return;
    const vars = { ...baseVars };
    for (const id of idents) if (!(id in vars)) vars[id] = 1;
    for (const id of idents) {
      const from = pub.get(id);
      if (!from || !d.nodes.has(toId)) continue;
      const sign = _loopProbeSign(expr, id, vars);
      if (sign === null) continue;
      raw.push({ from, to: toId, sign, kind: 'formula', connId: null, via });
    }
  };

  for (const c of d.connections.values()) {
    if (!d.nodes.has(c.sourceId) || !d.nodes.has(c.targetId)) continue;
    if (c.type === ConnectionType.RESOURCE) {
      raw.push({ from: c.sourceId, to: c.targetId, sign: 1, kind: 'flow', connId: c.id });
      if (c.rateMode === RateMode.FORMULA && c.formula) addFormulaEdges(c.formula, c.targetId, 'rate');
      if (c.weightFormula) addFormulaEdges(c.weightFormula, c.targetId, 'weight');
      if (c.condEnabled && c.condRefMode === 'variable' && c.condVariable) {
        const from = pub.get(c.condVariable);
        if (from) raw.push({ from, to: c.targetId, sign: _loopOpSign(c.condOperator), kind: 'condition', connId: null, via: 'condition' });
      }
    } else {
      const tgt = d.nodes.get(c.targetId);
      if (c.trigger) raw.push({ from: c.sourceId, to: c.targetId, sign: 1, kind: 'trigger', connId: c.id });
      if (c.reverseTrigger) raw.push({ from: c.sourceId, to: c.targetId, sign: -1, kind: 'reverse trigger', connId: c.id });
      if (c.activator) raw.push({ from: c.sourceId, to: c.targetId, sign: _loopOpSign(c.actOperator), kind: 'activator', connId: c.id });
      if (c.modifier) {
        // The source's influence on the target runs through the amount:
        // 'rate' adds amount × source, 'delta' adds amount × Δsource, 'pulse'
        // adds the amount when the source fires — all signed by the amount.
        // 'step' adds the amount regardless of the source, so the drawn edge
        // itself carries no influence (formula reads still do, added below).
        let amountSign;
        if (c.modFormula) {
          const idents = _loopIdents(c.modFormula);
          const vars = { ...baseVars };
          for (const id of idents) if (!(id in vars)) vars[id] = 1;
          const rng = SimRandom.getState();
          SimRandom.seed('loop-probe');
          amountSign = Math.sign(evalFormula(c.modFormula, vars)) || 0;
          SimRandom.setState(rng);
          addFormulaEdges(c.modFormula, c.targetId, 'modifier');
        } else {
          amountSign = Math.sign(c.modFactor || 0) || 0;
        }
        if ((c.modMode || 'rate') !== 'step') {
          raw.push({ from: c.sourceId, to: c.targetId, sign: amountSign, kind: 'modifier', connId: c.id });
        }
      }
      // A bare state connection only carries influence by itself when a
      // formula-less register mirrors its source.
      if (!c.trigger && !c.reverseTrigger && !c.activator && !c.modifier
        && tgt && tgt.type === NodeType.REGISTER && !(tgt.formula && tgt.formula.trim())) {
        raw.push({ from: c.sourceId, to: c.targetId, sign: 1, kind: 'state', connId: c.id });
      }
    }
  }
  for (const n of d.nodes.values()) {
    if (n.type === NodeType.REGISTER && n.formula && n.formula.trim()) {
      addFormulaEdges(n.formula, n.id, 'register formula');
    }
  }

  // Collapse parallel edges per (from → to): one link, mixed signs → unknown.
  const linkMap = new Map();
  for (const e of raw) {
    const key = e.from + ' ' + e.to;
    let l = linkMap.get(key);
    if (!l) { l = { from: e.from, to: e.to, sign: e.sign, kinds: new Set(), connIds: new Set() }; linkMap.set(key, l); }
    else if (l.sign !== e.sign) l.sign = 0;
    l.kinds.add(e.kind);
    if (e.connId) l.connIds.add(e.connId);
  }
  const links = [...linkMap.values()];

  // Bounded elementary-cycle enumeration: a cycle is only emitted from its
  // smallest node index, so each is found exactly once.
  const ids = [...d.nodes.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const adj = new Map(ids.map(id => [id, []]));
  for (const l of links) if (adj.has(l.from) && adj.has(l.to)) adj.get(l.from).push(l);

  const loops = [];
  let truncated = false;
  const path = [], pathLinks = [], onPath = new Set();
  // Hard ceiling on explored edges so a dense graph can't hang the panel;
  // typical diagrams explore a tiny fraction of this.
  let budget = 200000;

  const dfs = (startIdx, nodeId) => {
    if (loops.length >= maxLoops || budget <= 0) { truncated = true; return; }
    for (const l of adj.get(nodeId)) {
      if (loops.length >= maxLoops || --budget <= 0) { truncated = true; return; }
      const ti = index.get(l.to);
      if (ti < startIdx) continue;
      if (l.to === ids[startIdx]) {
        loops.push({ nodes: [...path], links: [...pathLinks, l] });
        continue;
      }
      if (onPath.has(l.to) || path.length >= maxLen) { if (path.length >= maxLen) truncated = true; continue; }
      onPath.add(l.to); path.push(l.to); pathLinks.push(l);
      dfs(startIdx, l.to);
      onPath.delete(l.to); path.pop(); pathLinks.pop();
    }
  };
  for (let s = 0; s < ids.length && loops.length < maxLoops && budget > 0; s++) {
    onPath.add(ids[s]); path.push(ids[s]);
    dfs(s, ids[s]);
    onPath.delete(ids[s]); path.pop();
  }

  // Classify and shape the result. A cycle made purely of resource flows is a
  // circulation (resources going around), not a feedback polarity — type 'F'.
  const out = loops.map(({ nodes, links: ls }) => {
    let product = 1, unknown = false;
    for (const l of ls) {
      if (l.sign === 0) unknown = true;
      else product *= l.sign;
    }
    const pureFlow = ls.every(l => l.kinds.size === 1 && l.kinds.has('flow'));
    const type = pureFlow ? 'F' : (unknown ? '?' : (product > 0 ? 'R' : 'B'));
    return {
      type,
      nodes,
      labels: nodes.map(id => { const n = d.nodes.get(id); return (n && n.label) || id; }),
      links: ls.map(l => ({
        from: l.from, to: l.to, sign: l.sign,
        kinds: [...l.kinds], connIds: [...l.connIds],
      })),
      connIds: [...new Set(ls.flatMap(l => [...l.connIds]))],
    };
  });
  // Reinforcing first, then balancing, circulations, then unclear; short
  // loops before long ones.
  const rank = { R: 0, B: 1, F: 2, '?': 3 };
  out.sort((a, b) => (rank[a.type] - rank[b.type]) || (a.nodes.length - b.nodes.length));
  return { loops: out, truncated };
}
