#!/usr/bin/env node
// Headless test suite for the Simulations engine (no DOM required).
//
// model.js and engine.js are plain browser scripts that declare globals via
// `const`/`class`. We load them into a single function scope and return the
// symbols the tests need.
//
// Run with:  node test/run.js
'use strict';

const fs = require('fs');
const path = require('path');

function loadEngine() {
  const base = path.join(__dirname, '..', 'js');
  const src =
    fs.readFileSync(path.join(base, 'model.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'engine.js'), 'utf8') + '\n' +
    'return { NodeType, ConnectionType, ActivationMode, RateMode, DEFAULT_COLOR,' +
    ' MNode, MConnection, Diagram, SimEngine, evalFormula, rollDice, dominantColor };';
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

const API = loadEngine();
const {
  NodeType, ConnectionType, ActivationMode, RateMode, DEFAULT_COLOR,
  MNode, MConnection, Diagram, SimEngine, evalFormula, rollDice,
} = API;

// ── Tiny test harness ───────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`${msg || 'expected equal'}: got ${actual}, want ${expected}`);
}

// Deterministic Math.random for the duration of `fn`.
function withRandom(value, fn) {
  const orig = Math.random;
  Math.random = typeof value === 'function' ? value : () => value;
  try { fn(); } finally { Math.random = orig; }
}

// Build helpers
function setup() {
  const d = new Diagram();
  const e = new SimEngine(d);
  return { d, e };
}
function node(d, type, x = 0, y = 0) { return d.addNode(new MNode(type, x, y)); }
function conn(d, src, tgt, type = ConnectionType.RESOURCE) {
  return d.addConnection(new MConnection(src.id, tgt.id, type));
}
function steps(e, n) { e.reset(); for (let i = 0; i < n; i++) e.doStep(); }

// ── Regression: core flows ──────────────────────────────────────────────────
console.log('\nCore flows');

test('source pushes a fixed rate into a pool', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 3;
  steps(e, 2);
  eq(p.resources, 6, 'pool after 2 steps');
  eq(s.produced, 6, 'source produced count');
});

test('pool drains into a drain and records throughput', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(10);
  const dr = node(d, NodeType.DRAIN);
  conn(d, p, dr).rate = 2;
  steps(e, 1);
  eq(p.resources, 8, 'pool after drain');
  eq(dr.drained, 2, 'drained count');
});

test('capacity caps inflow without losing extra into the void', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL); p.capacity = 5;
  conn(d, s, p).rate = 10;
  steps(e, 3);
  eq(p.resources, 5, 'pool clamps to capacity');
});

test('color filter only passes matching resources', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.resourceColor = '#ff0000';
  const pass = node(d, NodeType.POOL);
  const block = node(d, NodeType.POOL);
  conn(d, s, pass).colorFilter = '#ff0000';
  conn(d, s, block).colorFilter = '#0000ff';
  steps(e, 1);
  assert(pass.resources > 0, 'matching color passes');
  eq(block.resources, 0, 'non-matching color blocked');
});

test('converter consumes input ratio and emits output color', () => {
  const { d, e } = setup();
  const c = node(d, NodeType.CONVERTER); c.setCount(4); c.inputAmount = 2; c.outputColor = '#00ff00';
  const out = node(d, NodeType.POOL);
  conn(d, c, out).rate = 1;
  steps(e, 1);
  eq(c.resources, 0, 'converter consumed all input');
  eq(out.resources, 2, 'two conversions emitted one each');
  eq(out.colorMap['#00ff00'], 2, 'output is in converter output color');
});

test('delay holds resources then releases', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(5);
  const dl = node(d, NodeType.DELAY); dl.delay = 2;
  const b = node(d, NodeType.POOL);
  conn(d, a, dl).rate = 5;
  conn(d, dl, b).rate = 5;
  e.reset();
  e.doStep();                       // step1: 5 enters delay (stepsLeft=2)
  eq(b.resources, 0, 'nothing released yet (step1)');
  e.doStep();                       // step2: stepsLeft 2->1
  eq(b.resources, 0, 'still held (step2)');
  e.doStep();                       // step3: released
  eq(b.resources, 5, 'released after delay');
});

// ── Fair contention (order-independent allocation) ──────────────────────────
console.log('\nFair contention');

test('pool allocates max-min fair; greedy output cannot starve small ones', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(3);
  const greedy = node(d, NodeType.DRAIN);  // created first, wants 5
  const a = node(d, NodeType.DRAIN);
  const b = node(d, NodeType.DRAIN);
  conn(d, p, greedy).rate = 5;             // would have hogged everything before
  conn(d, p, a).rate = 1;
  conn(d, p, b).rate = 1;
  steps(e, 1);
  eq(greedy.drained, 1, 'greedy gets only its fair first unit');
  eq(a.drained, 1, 'small output served');
  eq(b.drained, 1, 'small output served');
  eq(p.resources, 0, 'pool emptied');
});

test('pool fair allocation gives surplus to the high-demand output', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(6);
  const big = node(d, NodeType.DRAIN);
  const a = node(d, NodeType.DRAIN);
  const b = node(d, NodeType.DRAIN);
  conn(d, p, big).rate = 5;
  conn(d, p, a).rate = 1;
  conn(d, p, b).rate = 1;
  steps(e, 1);
  eq(big.drained, 4, 'big output gets the surplus after others satisfied');
  eq(a.drained, 1, 'small satisfied');
  eq(b.drained, 1, 'small satisfied');
});

test('delay splits matured resources across multiple outputs', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const dl = node(d, NodeType.DELAY); dl.delay = 1;
  const a = node(d, NodeType.DRAIN);
  const b = node(d, NodeType.DRAIN);
  conn(d, s, dl).rate = 2;
  conn(d, dl, a).rate = 1;
  conn(d, dl, b).rate = 1;
  e.reset();
  e.doStep();   // 2 enters delay
  e.doStep();   // matures, splits across both outputs
  eq(a.drained, 1, 'output A gets its share');
  eq(b.drained, 1, 'output B not starved');
});

// ── Capacity & integrity ────────────────────────────────────────────────────
console.log('\nCapacity & integrity');

test('pool allocation is work-conserving when one target is full', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.POOL); s.setCount(10);
  const a = node(d, NodeType.POOL); a.capacity = 1; a.setCount(1);  // already full
  const b = node(d, NodeType.POOL);
  conn(d, s, a).rate = 5;
  conn(d, s, b).rate = 10;
  steps(e, 1);
  eq(b.resources, 10, 'B uses the resources A could not accept');
  eq(a.resources, 1, 'A stays full');
});

test('converter cannot exceed a shared target capacity', () => {
  const { d, e } = setup();
  const c = node(d, NodeType.CONVERTER); c.setCount(10); c.inputAmount = 1;
  const t = node(d, NodeType.POOL); t.capacity = 3;
  conn(d, c, t).rate = 2;
  conn(d, c, t).rate = 2;
  steps(e, 1);
  eq(t.resources, 3, 'two outputs to one target respect its capacity');
});

test('resources cannot flow into a register', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const r = node(d, NodeType.REGISTER);
  conn(d, s, r).rate = 5;
  steps(e, 5);
  eq(r.resources, 0, 'register never holds resources');
});

test('a closed resource cycle conserves total exactly', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(100);
  const b = node(d, NodeType.POOL);
  const c = node(d, NodeType.POOL);
  conn(d, a, b).rate = 7;
  conn(d, b, c).rate = 3;
  conn(d, c, a).rate = 5;
  e.reset();
  for (let i = 0; i < 500; i++) {
    e.doStep();
    eq(a.resources + b.resources + c.resources, 100, 'total conserved at step ' + (i + 1));
  }
});

// ── Registers, variables, formulas ──────────────────────────────────────────
console.log('\nRegisters & formulas');

test('register evaluates a formula over a state variable', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(5);
  const r = node(d, NodeType.REGISTER); r.formula = 'p * 2';
  const sc = conn(d, p, r, ConnectionType.STATE); sc.variableName = 'p';
  steps(e, 1);
  eq(r.value, 10, 'register = p*2');
});

test('register chains resolve in one tick regardless of node order', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(5);
  // Create the dependent register FIRST so creation order != dependency order.
  const rb = node(d, NodeType.REGISTER); rb.label = 'b'; rb.formula = 'a * 2';
  const ra = node(d, NodeType.REGISTER); ra.label = 'a'; ra.formula = 'x';
  const sc = conn(d, p, ra, ConnectionType.STATE); sc.variableName = 'x';
  steps(e, 1);
  eq(ra.value, 5, 'a = x');
  eq(rb.value, 10, 'b = a*2 resolved same tick (no lag)');
});

test('source state value is produced count, never Infinity', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const r = node(d, NodeType.REGISTER); r.formula = 'made';
  conn(d, s, p).rate = 3;
  const sc = conn(d, s, r, ConnectionType.STATE); sc.variableName = 'made';
  steps(e, 2);
  eq(r.value, 6, 'register mirrors produced, not Infinity');
  assert(isFinite(r.value), 'register value finite');
});

test('evalFormula ignores invalid variable names safely', () => {
  eq(evalFormula('a + b', { a: 2, b: 3 }), 5, 'basic');
  eq(evalFormula('a + 1', { a: 2, 'bad name': 99 }), 3, 'bad var ignored');
  eq(evalFormula('nope', {}), 0, 'unknown identifier -> 0');
  eq(evalFormula('1/0', {}), 0, 'non-finite -> 0');
});

// ── Connection gating: interval / chance / condition ────────────────────────
console.log('\nConnection gating');

test('interval fires every N steps', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p); c.rate = 1; c.interval = 2;
  e.reset();
  e.doStep(); eq(p.resources, 1, 'fires on step 1');
  e.doStep(); eq(p.resources, 1, 'skips step 2');
  e.doStep(); eq(p.resources, 2, 'fires on step 3');
});

test('chance gates firing by Math.random', () => {
  withRandom(0.4, () => {
    const { d, e } = setup();
    const s = node(d, NodeType.SOURCE); const p = node(d, NodeType.POOL);
    const c = conn(d, s, p); c.rate = 1; c.chance = 50;
    steps(e, 1);
    eq(p.resources, 1, '40% roll < 50% -> fires');
  });
  withRandom(0.9, () => {
    const { d, e } = setup();
    const s = node(d, NodeType.SOURCE); const p = node(d, NodeType.POOL);
    const c = conn(d, s, p); c.rate = 1; c.chance = 50;
    steps(e, 1);
    eq(p.resources, 0, '90% roll >= 50% -> blocked');
  });
});

test('condition compares source value to a threshold', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(5);
  const dr = node(d, NodeType.DRAIN);
  const c = conn(d, a, dr); c.rate = 1; c.condEnabled = true; c.condOperator = '>'; c.condValue = 3;
  steps(e, 10);
  eq(a.resources, 3, 'drains only while > 3, settles at 3');
});

test('dice rate uses XdY notation', () => {
  withRandom(0, () => {           // floor(0*sides)+1 = 1 per die
    const { d, e } = setup();
    const s = node(d, NodeType.SOURCE); const p = node(d, NodeType.POOL);
    const c = conn(d, s, p); c.rateMode = RateMode.DICE; c.dice = '3d6';
    steps(e, 1);
    eq(p.resources, 3, '3d6 with min rolls = 3');
  });
});

// ── NEW: triggers ───────────────────────────────────────────────────────────
console.log('\nTriggers');

test('a passive node does not fire on its own', () => {
  const { d, e } = setup();
  const c = node(d, NodeType.CONVERTER); c.setCount(6); c.inputAmount = 2;
  c.activation = ActivationMode.PASSIVE;
  const out = node(d, NodeType.POOL);
  conn(d, c, out).rate = 1;
  steps(e, 3);
  eq(out.resources, 0, 'passive converter stays idle');
});

test('trigger fires a passive node when the source fires', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const dr = node(d, NodeType.DRAIN);
  conn(d, a, dr).rate = 1;                    // makes A fire each step

  const c = node(d, NodeType.CONVERTER); c.setCount(6); c.inputAmount = 2;
  c.activation = ActivationMode.PASSIVE;
  const out = node(d, NodeType.POOL);
  conn(d, c, out).rate = 1;

  const trig = conn(d, a, c, ConnectionType.STATE); trig.trigger = true;
  steps(e, 1);
  eq(dr.drained, 1, 'A fired into drain');
  eq(out.resources, 3, 'triggered converter ran (6/2 conversions)');
  eq(c.resources, 0, 'converter consumed its input');
});

test('trigger cascade is loop-guarded (no infinite loop)', () => {
  const { d, e } = setup();
  // Two pools that trigger each other; both have resources to keep firing.
  const a = node(d, NodeType.POOL); a.setCount(100);
  const b = node(d, NodeType.POOL); b.setCount(100);
  const sink = node(d, NodeType.DRAIN);
  conn(d, a, sink).rate = 1;
  conn(d, b, sink).rate = 1;
  conn(d, a, b, ConnectionType.STATE).trigger = true;
  conn(d, b, a, ConnectionType.STATE).trigger = true;
  // Should terminate without hanging.
  steps(e, 1);
  assert(true, 'completed without hanging');
});

// ── NEW: activators ─────────────────────────────────────────────────────────
console.log('\nActivators');

test('activator disables target node while condition fails', () => {
  const { d, e } = setup();
  const g = node(d, NodeType.POOL); g.setCount(5);   // gate value
  const a = node(d, NodeType.POOL); a.setCount(10);
  const b = node(d, NodeType.POOL);
  conn(d, a, b).rate = 2;
  const act = conn(d, g, a, ConnectionType.STATE);
  act.activator = true; act.actOperator = '>='; act.actValue = 10;
  steps(e, 1);
  eq(b.resources, 0, 'A disabled while g(5) < 10');
});

test('activator enables target node when condition holds', () => {
  const { d, e } = setup();
  const g = node(d, NodeType.POOL); g.setCount(20);
  const a = node(d, NodeType.POOL); a.setCount(10);
  const b = node(d, NodeType.POOL);
  conn(d, a, b).rate = 2;
  const act = conn(d, g, a, ConnectionType.STATE);
  act.activator = true; act.actOperator = '>='; act.actValue = 10;
  steps(e, 1);
  eq(b.resources, 2, 'A enabled while g(20) >= 10');
});

// ── NEW: weighted gates ─────────────────────────────────────────────────────
console.log('\nWeighted gates');

test('deterministic gate splits proportionally to weights', () => {
  const { d, e } = setup();
  const g = node(d, NodeType.GATE); g.setCount(10); g.gateMode = 'deterministic';
  const p1 = node(d, NodeType.POOL);
  const p2 = node(d, NodeType.POOL);
  conn(d, g, p1).weight = 3;
  conn(d, g, p2).weight = 1;
  steps(e, 1);
  eq(p1.resources, 8, 'weight 3 share (7 + remainder)');
  eq(p2.resources, 2, 'weight 1 share');
  eq(g.resources, 0, 'gate emptied');
});

test('probabilistic gate never routes to a zero-weight output', () => {
  withRandom(0.5, () => {
    const { d, e } = setup();
    const g = node(d, NodeType.GATE); g.setCount(10); g.gateMode = 'probabilistic';
    const p1 = node(d, NodeType.POOL);
    const p2 = node(d, NodeType.POOL);
    conn(d, g, p1).weight = 1;
    conn(d, g, p2).weight = 0;
    steps(e, 1);
    eq(p1.resources, 10, 'all units to weight-1 output');
    eq(p2.resources, 0, 'zero-weight output gets nothing');
  });
});

test('legacy "random" gate mode still works (alias of probabilistic)', () => {
  withRandom(0.5, () => {
    const { d, e } = setup();
    const g = node(d, NodeType.GATE); g.setCount(4); g.gateMode = 'random';
    const p1 = node(d, NodeType.POOL);
    conn(d, g, p1).weight = 1;
    steps(e, 1);
    eq(p1.resources, 4, 'all routed to the only output');
  });
});

// ── NEW: end conditions ─────────────────────────────────────────────────────
console.log('\nEnd conditions');

test('end condition halts the simulation when met', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 5;
  p.endEnabled = true; p.endOperator = '>='; p.endValue = 12;
  e.reset();
  e.doStep(); assert(!e.ended, 'not ended at 5');
  e.doStep(); assert(!e.ended, 'not ended at 10');
  e.doStep();
  assert(e.ended, 'ended at 15');
  eq(e.ended.nodeId, p.id, 'correct node');
  eq(e.ended.step, 3, 'ended on step 3');
  assert(!e.running, 'engine stopped');
});

test('end condition fires onEnd callback once', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 100;
  p.endEnabled = true; p.endOperator = '>='; p.endValue = 50;
  let calls = 0;
  e.onEnd = () => calls++;
  e.reset();
  e.doStep();             // 100 >= 50 -> end
  e.doStep();             // already ended -> no second callback
  eq(calls, 1, 'onEnd called exactly once');
});

// ── Serialization round-trip ────────────────────────────────────────────────
console.log('\nSerialization');

test('toJSON/loadJSON preserves new fields', () => {
  const { d } = setup();
  const a = node(d, NodeType.POOL); a.setCount(7);
  a.endEnabled = true; a.endOperator = '<'; a.endValue = 3;
  const b = node(d, NodeType.POOL);
  const c = conn(d, a, b);
  c.weight = 4;
  const tr = conn(d, a, b, ConnectionType.STATE); tr.trigger = true;
  const ac = conn(d, a, b, ConnectionType.STATE); ac.activator = true; ac.actOperator = '<='; ac.actValue = 9;

  const json = JSON.parse(JSON.stringify(d.toJSON()));
  const d2 = new Diagram();
  d2.loadJSON(json);

  const a2 = [...d2.nodes.values()].find(n => n.endEnabled);
  assert(a2, 'end node survived');
  eq(a2.endOperator, '<', 'endOperator preserved');
  eq(a2.endValue, 3, 'endValue preserved');

  const conns = [...d2.connections.values()];
  assert(conns.find(x => x.weight === 4), 'weight preserved');
  assert(conns.find(x => x.trigger === true), 'trigger preserved');
  const av = conns.find(x => x.activator === true);
  assert(av, 'activator preserved');
  eq(av.actOperator, '<=', 'actOperator preserved');
  eq(av.actValue, 9, 'actValue preserved');
});

// ── P1: finite source / queue / modifiers ──────────────────────────────────
console.log('\nFinite source');

test('a limited source emits its stock then runs dry', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.limited = true; s.setCount(10, s.resourceColor);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 3;
  steps(e, 10);
  eq(p.resources, 10, 'pool received exactly the stock');
  eq(s.resources, 0, 'source ran dry');
  eq(s.produced, 10, 'produced equals the emitted stock');
});

test('an unlimited source is unaffected (regression)', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 4;
  steps(e, 5);
  eq(p.resources, 20, 'unlimited source keeps emitting');
});

console.log('\nQueue (single-server FIFO)');

test('queue serializes throughput to ~1 per process-time', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 3;
  const dr = node(d, NodeType.DRAIN);
  conn(d, s, q).rate = 1;     // 1 unit in per step
  conn(d, q, dr).rate = 1;
  steps(e, 30);
  assert(dr.drained >= 8 && dr.drained <= 10, `~30/3 released (got ${dr.drained})`);
  assert(dr.drained < 30, 'far below the 30 that arrived (bottleneck)');
  assert(q.resources > 15, 'queue backs up behind the bottleneck');
});

test('queue adds per-item latency before the first release', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 3;
  const dr = node(d, NodeType.DRAIN);
  conn(d, s, q).rate = 1;
  conn(d, q, dr).rate = 1;
  e.reset();
  for (let i = 0; i < 4; i++) e.doStep();
  eq(dr.drained, 0, 'nothing released yet during the processing latency');
  e.doStep();
  eq(dr.drained, 1, 'first unit released after latency');
});

console.log('\nState modifiers');

test('self modifier grows a pool (interest)', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(100);
  const c = conn(d, p, p, ConnectionType.STATE); c.modifier = true; c.modFactor = 0.1;
  e.reset();
  e.doStep(); eq(p.resources, 110, '+10% after one step');
  e.doStep(); eq(p.resources, 121, 'compounds');
});

test('self modifier with negative factor decays a pool', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(100);
  const c = conn(d, p, p, ConnectionType.STATE); c.modifier = true; c.modFactor = -0.2;
  steps(e, 1);
  eq(p.resources, 80, '-20% after one step');
});

test('modifier from another node adds source value each step', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(5);   // no outflow, stays 5
  const b = node(d, NodeType.POOL);
  const c = conn(d, a, b, ConnectionType.STATE); c.modifier = true; c.modFactor = 1;
  steps(e, 2);
  eq(b.resources, 10, 'B grew by A (5) each step');
  eq(a.resources, 5, 'A unchanged');
});

test('modifier respects target capacity', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(100);
  const b = node(d, NodeType.POOL); b.capacity = 8;
  const c = conn(d, a, b, ConnectionType.STATE); c.modifier = true; c.modFactor = 1;
  steps(e, 1);
  eq(b.resources, 8, 'capped at capacity');
});

test('toJSON/loadJSON preserves limited source, queue, and modifier', () => {
  const { d } = setup();
  const s = node(d, NodeType.SOURCE); s.limited = true; s.setCount(7, s.resourceColor);
  const q = node(d, NodeType.QUEUE); q.processTime = 4;
  const m = conn(d, s, q, ConnectionType.STATE); m.modifier = true; m.modFactor = -0.5;
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  const d2 = new Diagram(); d2.loadJSON(json);
  const s2 = [...d2.nodes.values()].find(n => n.type === NodeType.SOURCE);
  const q2 = [...d2.nodes.values()].find(n => n.type === NodeType.QUEUE);
  const m2 = [...d2.connections.values()].find(c => c.modifier);
  assert(s2 && s2.limited === true && s2.resources === 7, 'limited stock preserved');
  assert(q2 && q2.processTime === 4, 'queue process time preserved');
  assert(m2 && m2.modFactor === -0.5, 'modifier factor preserved');
});

console.log('\nMonte Carlo');

test('deterministic diagram gives identical stats across runs', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 5;
  const res = e.runMonteCarlo(5, 10);
  const pn = res.nodes.find(x => x.id === p.id);
  eq(pn.mean, 50, 'mean'); eq(pn.min, 50, 'min'); eq(pn.max, 50, 'max');
  assert(!res.nodes.find(x => x.type === NodeType.SOURCE), 'unlimited source not tracked');
});

test('random diagram yields a spread around the expected mean', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p); c.rate = 1; c.chance = 50;
  const res = e.runMonteCarlo(60, 100);
  const pn = res.nodes.find(x => x.id === p.id);
  assert(pn.mean >= 35 && pn.mean <= 65, `~50 mean (got ${pn.mean})`);
  assert(pn.max > pn.min, 'runs vary');
});

test('Monte Carlo reports goal reach rate and end-step stats', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 5;
  p.endEnabled = true; p.endOperator = '>='; p.endValue = 12;
  const res = e.runMonteCarlo(10, 50);
  eq(res.endedRate, 1, 'always reaches the goal');
  assert(res.endStep && res.endStep.min === 3 && res.endStep.max === 3, 'ends at step 3 each run');
});

test('Monte Carlo does not disturb the live diagram', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL); p.setCount(7);
  conn(d, s, p).rate = 5;
  e.runMonteCarlo(10, 20);
  eq(p.resources, 7, 'live pool untouched');
  eq(e.step, 0, 'live engine step untouched');
});

// ── Results ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.exitCode = 1;
}
