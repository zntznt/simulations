// The "why" layer: spike attribution.
//
// attributeChange(diagram, history, nodeId, index) explains the change in one
// node's charted value between history entries index-1 and index: which
// resource flows arrived, which left, what modifiers applied, and whatever
// remains as internal behavior (converter consumption, queue balk/renege,
// register recomputation). Works on the flow records SimEngine attaches to
// every history entry (`flows`), which aggregate over the entry's whole span,
// so the identity  delta = inflows − outflows + modifiers + residual  holds
// exactly even when long runs are stride-sampled.
//
// Chart-value semantics per node type are respected: a drain's value is its
// cumulative intake (outflows never apply), a limited source's is its stock
// (inflows never apply), a register's is its formula (no flows at all).
//
// DOM-free (browser, cli.js, test/run.js); loads after model.js.

/* exported attributeChange */

function attributeChange(diagram, history, nodeId, index) {
  if (!history || index < 0 || index >= history.length) return null;
  const node = diagram.nodes.get(nodeId);
  if (!node) return null;
  const cur = history[index];
  const label = node.label || node.type;

  if (index === 0) {
    return {
      nodeId, label, initial: true,
      fromStep: cur.step, toStep: cur.step,
      from: cur.snap[nodeId] ?? 0, to: cur.snap[nodeId] ?? 0,
      delta: 0, entries: [], residual: 0,
      register: node.type === NodeType.REGISTER,
    };
  }

  const prev = history[index - 1];
  const from = prev.snap[nodeId] ?? 0;
  const to = cur.snap[nodeId] ?? 0;
  const delta = to - from;
  const flows = cur.flows || { conns: {}, mods: {} };
  const entries = [];
  const nameOf = id => { const n = diagram.nodes.get(id); return (n && n.label) || id || '?'; };

  // A trader holds nothing: it swaps between the two partners of a paired
  // incoming/outgoing connection (SimEngine._fireTrader pairs ins[i] with
  // outs[i], so the pairing is reconstructible here). Crucially the flow booked
  // on the OUTGOING leg is what that partner PAID, not what it received, so
  // reading direction off sourceId/targetId reported a payment as income, never
  // credited either partner with what it got, and gave the trader itself two
  // rows for resources that never touched it. Map each leg to its real payer
  // and payee instead.
  const traderLegs = new Map();   // connId -> { payer, payee, trader }
  for (const t of diagram.nodes.values()) {
    if (t.type !== NodeType.TRADER) continue;
    const ins = diagram.incoming(t.id).filter(c => c.type === ConnectionType.RESOURCE);
    const outs = diagram.outgoing(t.id).filter(c => c.type === ConnectionType.RESOURCE);
    for (let i = 0; i < Math.min(ins.length, outs.length); i++) {
      const cin = ins[i], cout = outs[i];
      traderLegs.set(cin.id, { payer: cin.sourceId, payee: cout.targetId, trader: t.id });
      traderLegs.set(cout.id, { payer: cout.targetId, payee: cin.sourceId, trader: t.id });
    }
  }

  const isRegister = node.type === NodeType.REGISTER;
  if (!isRegister) {
    for (const [connId, amt] of Object.entries(flows.conns)) {
      if (!amt) continue;
      const c = diagram.connections.get(connId);
      if (!c) continue;
      const leg = traderLegs.get(connId);
      if (leg) {
        // The trader's own charted value is its trade count, not a balance, so
        // these resources are none of its business.
        if (nodeId === leg.trader) continue;
        if (nodeId === leg.payer && node.type !== NodeType.DRAIN) {
          entries.push({ kind: 'flow out', connId, amount: -amt, label: `to ${nameOf(leg.payee)}` });
        }
        if (nodeId === leg.payee && node.type !== NodeType.SOURCE) {
          entries.push({ kind: 'flow in', connId, amount: amt, label: `from ${nameOf(leg.payer)}` });
        }
        continue;
      }
      // A drain's charted value only ever grows with intake; a limited
      // source's stock only ever falls with output. Everything else counts
      // both directions. (A self-loop connection nets to zero via two rows.)
      if (c.targetId === nodeId && node.type !== NodeType.SOURCE) {
        entries.push({ kind: 'flow in', connId, amount: amt, label: `from ${nameOf(c.sourceId)}` });
      }
      if (c.sourceId === nodeId && node.type !== NodeType.DRAIN) {
        entries.push({ kind: 'flow out', connId, amount: -amt, label: `to ${nameOf(c.targetId)}` });
      }
    }
    for (const [connId, applied] of Object.entries(flows.mods)) {
      if (!applied) continue;
      const c = diagram.connections.get(connId);
      if (!c || c.targetId !== nodeId) continue;
      entries.push({ kind: 'modifier', connId, amount: applied, label: `${nameOf(c.sourceId)} modifier` });
    }
  }

  const accounted = entries.reduce((s, e) => s + e.amount, 0);
  // Guard against float dust so "residual 0" really reads as zero.
  let residual = delta - accounted;
  if (Math.abs(residual) < 1e-9) residual = 0;

  entries.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return {
    nodeId, label, initial: false,
    fromStep: prev.step, toStep: cur.step,
    from, to, delta, entries, residual,
    register: isRegister,
  };
}
