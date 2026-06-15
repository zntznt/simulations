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

// The browser loads math.js from vendor/math.min.js; headlessly we expose the
// npm package as the same `math` global so formulas take the math.js path.
// Tests still pass without it (formulas fall back to the legacy JS evaluator).
try { global.math = require('mathjs'); } catch { /* optional */ }

function loadEngine() {
  const base = path.join(__dirname, '..', 'js');
  const src =
    fs.readFileSync(path.join(base, 'model.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'engine.js'), 'utf8') + '\n' +
    'return { NodeType, ConnectionType, ActivationMode, RateMode, DEFAULT_COLOR,' +
    ' MNode, MConnection, MGroup, MNote, MChart, Diagram, SimEngine, evalFormula, rollDice, dominantColor, sampleDist, sampleCustomVar, validateFormula, SimRandom };';
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

const API = loadEngine();
const {
  NodeType, ConnectionType, ActivationMode, RateMode, DEFAULT_COLOR,
  MNode, MConnection, MGroup, MNote, MChart, Diagram, SimEngine, evalFormula, rollDice, sampleDist, sampleCustomVar, validateFormula, SimRandom,
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

// Async tests are registered here and awaited just before the summary prints
// (the sync `test` harness can't await a promise-returning body).
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }

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

test('formula gate weight drives the deterministic split from a variable', () => {
  const { d, e } = setup();
  d.params = { hard: 3 };
  const g = node(d, NodeType.GATE); g.setCount(8); g.gateMode = 'deterministic';
  const easy = node(d, NodeType.POOL);
  const hard = node(d, NodeType.POOL);
  conn(d, g, easy).weight = 1;             // fixed share
  conn(d, g, hard).weightFormula = 'hard'; // formula share (evaluates to 3)
  steps(e, 1);
  eq(easy.resources, 2, 'fixed weight 1 → 1/4 of 8');
  eq(hard.resources, 6, 'formula weight 3 → 3/4 of 8');
  eq(g.resources, 0, 'gate emptied');
});

test('a formula gate weight of 0 routes nothing (probabilistic)', () => {
  withRandom(0.5, () => {
    const { d, e } = setup();
    d.params = { off: 0 };
    const g = node(d, NodeType.GATE); g.setCount(10); g.gateMode = 'probabilistic';
    const p1 = node(d, NodeType.POOL);
    const p2 = node(d, NodeType.POOL);
    conn(d, g, p1).weight = 1;
    conn(d, g, p2).weightFormula = 'off'; // 0 → never chosen
    steps(e, 1);
    eq(p1.resources, 10, 'all units to the live output');
    eq(p2.resources, 0, 'formula-zero output gets nothing');
  });
});

test('weightFormula round-trips through JSON', () => {
  const { d } = setup();
  const g = node(d, NodeType.GATE);
  const p = node(d, NodeType.POOL);
  conn(d, g, p).weightFormula = 'gold * 0.1';
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  const d2 = new Diagram(); d2.loadJSON(json);
  const c2 = [...d2.connections.values()][0];
  eq(c2.weightFormula, 'gold * 0.1', 'weightFormula preserved');
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

console.log('\nQueue (FIFO + parallel servers)');

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

test('parallel servers multiply queue throughput', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 3; q.servers = 3;
  const dr = node(d, NodeType.DRAIN);
  conn(d, s, q).rate = 3;     // 3 units in per step
  conn(d, q, dr).rate = 1;
  steps(e, 30);
  // 3 servers × (1 unit / 3 steps) ≈ 1 unit/step — roughly 3× a single server's
  // ~9-10 over the same run.
  assert(dr.drained >= 24 && dr.drained <= 30, `~3× single-server throughput (got ${dr.drained})`);
});

test('an uncongested queue reports the minimum one-step wait', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 1; q.servers = 2;
  const dr = node(d, NodeType.DRAIN);
  conn(d, s, q).rate = 1;
  conn(d, q, dr).rate = 1;
  steps(e, 8);
  assert(q.processed >= 5, `units served (got ${q.processed})`);
  eq(q.maxWait, 1, 'no unit waits more than one step when servers keep up');
});

test('queue records waiting time and peak line under congestion', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 2; q.servers = 1;
  const dr = node(d, NodeType.DRAIN);
  conn(d, s, q).rate = 3;     // arrivals outpace the single server
  conn(d, q, dr).rate = 1;
  steps(e, 20);
  assert(q.processed >= 8 && q.processed <= 11, `~20/2 served (got ${q.processed})`);
  assert(q.maxLen >= 10, `the line builds up under congestion (got ${q.maxLen})`);
  assert(q.maxWait > 1, `later units wait many steps (got ${q.maxWait})`);
  assert(q.totalWait / q.processed > 1, 'average wait exceeds the uncongested minimum');
});

test('queue servers round-trip through JSON', () => {
  const { d } = setup();
  const q = node(d, NodeType.QUEUE); q.processTime = 4; q.servers = 3;
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  const d2 = new Diagram(); d2.loadJSON(json);
  const q2 = [...d2.nodes.values()][0];
  eq(q2.servers, 3, 'servers preserved');
  eq(q2.processTime, 4, 'process time preserved');
});

test('a full queue turns away (balks) excess arrivals', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 50; q.servers = 1; q.maxLine = 3;
  conn(d, s, q).rate = 5;     // far more than the line can hold
  steps(e, 6);
  const waiting = (q._fifo || []).reduce((a, it) => a + it.amount, 0);
  assert(waiting <= 3, `waiting line capped at maxLine (got ${waiting})`);
  assert(q.maxLen <= 3, `peak line respects the cap (got ${q.maxLen})`);
  assert(q.balked > 0, `excess arrivals are counted as balked (got ${q.balked})`);
});

test('impatient units renege after waiting past their patience', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 2; q.servers = 1; q.patience = 3;
  const dr = node(d, NodeType.DRAIN);
  conn(d, s, q).rate = 5;     // arrivals pile up behind a slow single server
  conn(d, q, dr).rate = 1;
  steps(e, 15);
  assert(q.reneged > 0, `over-patient units give up and leave (got ${q.reneged})`);
  assert(q.processed > 0, `some units are still served (got ${q.processed})`);
  const waiting = (q._fifo || []).reduce((a, it) => a + it.amount, 0);
  assert(waiting <= 5 * 3, `reneging bounds the line to the patience window (got ${waiting})`);
});

test('queue balking/reneging settings round-trip', () => {
  const { d } = setup();
  const q = node(d, NodeType.QUEUE); q.maxLine = 8; q.patience = 4;
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  const d2 = new Diagram(); d2.loadJSON(json);
  const q2 = [...d2.nodes.values()][0];
  eq(q2.maxLine, 8, 'maxLine preserved');
  eq(q2.patience, 4, 'patience preserved');
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

test('step modifier adds a flat amount every step (pool → pool)', () => {
  const { d, e } = setup();
  // The simplest case: two passive pools, "+2 to the target each step".
  const a = node(d, NodeType.POOL); a.setCount(5); a.activation = ActivationMode.PASSIVE;
  const b = node(d, NodeType.POOL);
  const m = conn(d, a, b, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'step'; m.modFactor = 2;
  steps(e, 3);
  eq(b.resources, 6, '+2 per step, no firing required');
  eq(a.resources, 5, 'source untouched');
});

test('step modifier with a formula evaluates every step', () => {
  const { d, e } = setup();
  d.params.income = 3;
  const a = node(d, NodeType.POOL); a.activation = ActivationMode.PASSIVE;
  const b = node(d, NodeType.POOL);
  const m = conn(d, a, b, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'step'; m.modFormula = 'income * 2';
  steps(e, 2);
  eq(b.resources, 12, '+6 (income×2) per step');
});

test('pulse modifier adds a flat amount when the source fires', () => {
  const { d, e } = setup();
  // Source fires automatically each step; the score pool gets +1 per firing.
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 2;
  const score = node(d, NodeType.POOL);
  const m = conn(d, s, score, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'pulse'; m.modFactor = 1;
  steps(e, 4);
  eq(score.resources, 4, '+1 per source firing over 4 steps');
  eq(p.resources, 8, 'resource flow unaffected');
});

test('pulse modifier stays silent when the source does not fire', () => {
  const { d, e } = setup();
  // Passive pool never fires; its pulse modifier must never run.
  const a = node(d, NodeType.POOL); a.setCount(5); a.activation = ActivationMode.PASSIVE;
  const score = node(d, NodeType.POOL);
  const m = conn(d, a, score, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'pulse'; m.modFactor = 3;
  steps(e, 3);
  eq(score.resources, 0, 'no firings, no pulses');
});

test('pulse modifier applies when an interactive node is CLICKED', () => {
  const { d, e } = setup();
  // A button-style interactive source: clicking it must pulse +1 to score.
  const btn = node(d, NodeType.SOURCE); btn.activation = ActivationMode.INTERACTIVE;
  const p = node(d, NodeType.POOL);
  conn(d, btn, p).rate = 1;
  const score = node(d, NodeType.POOL);
  const m = conn(d, btn, score, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'pulse'; m.modFactor = 1;
  e.reset();
  e.fireInteractive(btn.id);
  e.fireInteractive(btn.id);
  eq(score.resources, 2, '+1 per click');
  eq(p.resources, 2, 'flow also ran per click');
});

test('rate/delta modifiers do NOT run on interactive clicks (per-step only)', () => {
  const { d, e } = setup();
  const btn = node(d, NodeType.SOURCE); btn.activation = ActivationMode.INTERACTIVE;
  const p = node(d, NodeType.POOL);
  conn(d, btn, p).rate = 1;
  const bank = node(d, NodeType.POOL); bank.setCount(100);
  const m = conn(d, bank, bank, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'rate'; m.modFactor = 0.1;
  e.reset();
  e.fireInteractive(btn.id);
  eq(bank.resources, 100, 'interest is per-step, not per-click');
  e.doStep();
  eq(bank.resources, 110, 'interest applied on the tick');
});

test('modifier amount can be a formula over diagram variables', () => {
  const { d, e } = setup();
  d.params.bonus = 4;
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 1;
  const score = node(d, NodeType.POOL);
  const m = conn(d, s, score, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'pulse'; m.modFormula = 'bonus + 1';
  steps(e, 2);
  eq(score.resources, 10, '+5 (bonus+1) per firing over 2 steps');
});

test('formula modifier tracks a published state variable', () => {
  const { d, e } = setup();
  // gold pool grows 2/step and publishes 'gold'; tax pool gains gold*0.5
  // per step (rate-mode formula, factor read live each step).
  const s = node(d, NodeType.SOURCE);
  const gold = node(d, NodeType.POOL);
  conn(d, s, gold).rate = 2;
  const reg = conn(d, gold, gold, ConnectionType.STATE); reg.variableName = 'gold';
  const tax = node(d, NodeType.POOL);
  const m = conn(d, s, tax, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'pulse'; m.modFormula = 'gold * 0.5';
  steps(e, 3);
  // Variables hold last-step committed values: pulses see gold = 0, 2, 4.
  eq(tax.resources, 3, 'round(0)+round(1)+round(2) from the lagged gold value');
});

test('modFormula survives JSON round-trip', () => {
  const { d } = setup();
  const a = node(d, NodeType.POOL);
  const b = node(d, NodeType.POOL);
  const m = conn(d, a, b, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'pulse'; m.modFormula = 'round(gold * 0.1)';
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  const d2 = new Diagram(); d2.loadJSON(json);
  const m2 = [...d2.connections.values()].find(c => c.modifier);
  assert(m2 && m2.modFormula === 'round(gold * 0.1)', 'formula preserved');
});

test('negative pulse modifier subtracts on each source firing', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 1;
  const hp = node(d, NodeType.POOL); hp.setCount(10);
  const m = conn(d, s, hp, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'pulse'; m.modFactor = -2;
  steps(e, 3);
  eq(hp.resources, 4, '10 - 2×3 firings');
});

test('delta modifier mirrors the source\'s change, not its value', () => {
  const { d, e } = setup();
  // A grows by 2/step from a source; B should also grow by 2/step (×1 change),
  // NOT by A's full value every step.
  const s = node(d, NodeType.SOURCE);
  const a = node(d, NodeType.POOL);
  conn(d, s, a).rate = 2;
  const b = node(d, NodeType.POOL);
  const m = conn(d, a, b, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'delta'; m.modFactor = 1;
  steps(e, 3);
  eq(a.resources, 6, 'A grew 2/step');
  eq(b.resources, 6, 'B tracked A\'s change 1:1');
});

test('delta modifier scales the change and sees decreases', () => {
  const { d, e } = setup();
  // A drains by 1/step; B (×-1 of the change) should GROW by 1/step.
  const a = node(d, NodeType.POOL); a.setCount(10);
  const dr = node(d, NodeType.DRAIN);
  conn(d, a, dr).rate = 1;
  const b = node(d, NodeType.POOL);
  const m = conn(d, a, b, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'delta'; m.modFactor = -1;
  steps(e, 4);
  eq(a.resources, 6, 'A drained 1/step');
  eq(b.resources, 4, 'B grew by -1 × (-1 change) per step');
});

test('trigger fires the target only every Nth source firing', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const dr = node(d, NodeType.DRAIN);
  conn(d, a, dr).rate = 1;                          // A fires every step
  const c = node(d, NodeType.SOURCE); c.activation = ActivationMode.PASSIVE;
  const out = node(d, NodeType.POOL);
  conn(d, c, out).rate = 1;
  const t = conn(d, a, c, ConnectionType.STATE);
  t.trigger = true; t.triggerEvery = 3;
  steps(e, 6);
  eq(out.resources, 2, 'triggered on the 3rd and 6th firing only');
});

test('trigger chance 0 never propagates; 100 always does', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const dr = node(d, NodeType.DRAIN);
  conn(d, a, dr).rate = 1;
  const c = node(d, NodeType.SOURCE); c.activation = ActivationMode.PASSIVE;
  const out = node(d, NodeType.POOL);
  conn(d, c, out).rate = 1;
  const t = conn(d, a, c, ConnectionType.STATE);
  t.trigger = true; t.triggerChance = 0;
  steps(e, 3);
  eq(out.resources, 0, '0% chance: never triggers');
  t.triggerChance = 100;
  steps(e, 3);
  eq(out.resources, 3, '100% chance: triggers every firing');
});

test('activator between operator gates by inclusive range', () => {
  const { d, e } = setup();
  const g = node(d, NodeType.POOL); g.setCount(5);
  const a = node(d, NodeType.POOL); a.setCount(10);
  const b = node(d, NodeType.POOL);
  conn(d, a, b).rate = 1;
  const act = conn(d, g, a, ConnectionType.STATE);
  act.activator = true; act.actOperator = 'between'; act.actValue = 3; act.actValue2 = 7;
  steps(e, 1);
  eq(b.resources, 1, 'enabled while g(5) in 3..7');
  g.setCount(8);
  e.doStep();
  eq(b.resources, 1, 'disabled once g(8) leaves the range');
});

test('new connection fields survive JSON round-trip', () => {
  const { d } = setup();
  const a = node(d, NodeType.POOL);
  const b = node(d, NodeType.POOL);
  const t = conn(d, a, b, ConnectionType.STATE);
  t.trigger = true; t.triggerChance = 40; t.triggerEvery = 2;
  const m = conn(d, a, b, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'pulse'; m.modFactor = -2;
  const ac = conn(d, a, b, ConnectionType.STATE);
  ac.activator = true; ac.actOperator = 'between'; ac.actValue = 1; ac.actValue2 = 9;
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  const d2 = new Diagram(); d2.loadJSON(json);
  const conns = [...d2.connections.values()];
  const t2 = conns.find(c => c.trigger);
  assert(t2 && t2.triggerChance === 40 && t2.triggerEvery === 2, 'trigger chance/every preserved');
  const m2 = conns.find(c => c.modifier);
  assert(m2 && m2.modMode === 'pulse' && m2.modFactor === -2, 'pulse modifier preserved');
  const a2 = conns.find(c => c.activator);
  assert(a2 && a2.actOperator === 'between' && a2.actValue === 1 && a2.actValue2 === 9, 'range activator preserved');
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

test('Monte Carlo returns raw samples for distribution charts', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p); c.rate = 1; c.chance = 50;
  const res = e.runMonteCarlo(20, 30);
  const pn = res.nodes.find(x => x.id === p.id);
  eq(pn.samples.length, 20, 'one sample per run');
  assert(pn.samples.every(v => v >= 0 && v <= 30), 'samples within plausible range');
});

test('histogram buckets samples between min and max', () => {
  const h = SimEngine.histogram([0, 1, 1, 2, 2, 2, 10], 5);
  eq(h.lo, 0, 'lo'); eq(h.hi, 10, 'hi');
  eq(h.counts.reduce((a, b) => a + b, 0), 7, 'all samples bucketed');
  eq(h.counts[4], 1, 'max lands in the last bin');
  const flat = SimEngine.histogram([4, 4, 4], 5);
  eq(flat.counts[0], 3, 'identical samples collapse into one bin');
  eq(SimEngine.histogram([], 5).counts.length, 0, 'empty input → empty histogram');
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

// ── Pull mode ────────────────────────────────────────────────────────────────
console.log('\nPull mode');

test('a pull pool draws from a provider pool (no double flow)', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const b = node(d, NodeType.POOL); b.flowMode = 'pull';
  conn(d, a, b).rate = 3;
  steps(e, 1);
  eq(b.resources, 3, 'B pulled exactly its rate (not 6)');
  eq(a.resources, 7, 'provider reduced by the pulled amount');
});

test('a pull drain consumes from an infinite source', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const dr = node(d, NodeType.DRAIN); dr.flowMode = 'pull';
  conn(d, s, dr).rate = 2;
  steps(e, 3);
  eq(dr.drained, 6, 'drain pulled 2 per step');
});

test('pull-all is atomic — nothing moves unless every provider can supply', () => {
  const { d, e } = setup();
  const a1 = node(d, NodeType.POOL); a1.setCount(1);
  const a2 = node(d, NodeType.POOL); a2.setCount(10);
  const b = node(d, NodeType.POOL); b.flowMode = 'pull'; b.pullPolicy = 'all';
  conn(d, a1, b).rate = 3;
  conn(d, a2, b).rate = 3;
  steps(e, 1);
  eq(b.resources, 0, 'A1 cannot supply 3, so pull-all takes nothing');
  eq(a2.resources, 10, 'A2 untouched');
});

test('pull-any takes what is available from each provider', () => {
  const { d, e } = setup();
  const a1 = node(d, NodeType.POOL); a1.setCount(1);
  const a2 = node(d, NodeType.POOL); a2.setCount(10);
  const b = node(d, NodeType.POOL); b.flowMode = 'pull'; b.pullPolicy = 'any';
  conn(d, a1, b).rate = 3;
  conn(d, a2, b).rate = 3;
  steps(e, 1);
  eq(b.resources, 4, 'took 1 from A1 and 3 from A2');
});

test('a pull pool still pushes its own (source-driven) outgoing', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const b = node(d, NodeType.POOL); b.setCount(5); b.flowMode = 'pull';
  const c = node(d, NodeType.POOL);
  conn(d, a, b).rate = 3;   // pulled by B
  conn(d, b, c).rate = 2;   // pushed by B (C is push-mode)
  steps(e, 1);
  eq(c.resources, 2, 'B pushed 2 to C from its starting stock');
  eq(b.resources, 6, 'B = 5 - 2 pushed + 3 pulled');
});

test('pull respects the pulling node capacity', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(100);
  const b = node(d, NodeType.POOL); b.flowMode = 'pull'; b.capacity = 4;
  conn(d, a, b).rate = 10;
  steps(e, 1);
  eq(b.resources, 4, 'capped at capacity');
  eq(a.resources, 96, 'only the accepted amount left the provider');
});

// ── P2: reverse triggers ─────────────────────────────────────────────────────
console.log('\nReverse triggers');

test('reverse trigger fires when a pool is empty (source fails)', () => {
  const { d, e } = setup();
  const empty = node(d, NodeType.POOL);   // starts with 0 resources — always fails
  const sink = node(d, NodeType.POOL);
  // Normal outgoing resource connection (goes nowhere useful, just keeps pool auto)
  const marker = node(d, NodeType.DRAIN);
  conn(d, empty, marker).rate = 1;
  // Passive target fired only on failure of empty
  const alert = node(d, NodeType.POOL); alert.setCount(10);
  alert.activation = ActivationMode.PASSIVE;
  const tgt = node(d, NodeType.DRAIN);
  conn(d, alert, tgt).rate = 1;
  const rc = conn(d, empty, alert, ConnectionType.STATE);
  rc.reverseTrigger = true;
  steps(e, 1);
  eq(tgt.drained, 1, 'passive alert node fired because pool was empty');
});

test('reverse trigger does NOT fire when source successfully acts', () => {
  const { d, e } = setup();
  const pool = node(d, NodeType.POOL); pool.setCount(10);
  const sink = node(d, NodeType.DRAIN);
  conn(d, pool, sink).rate = 1;
  const passive = node(d, NodeType.POOL); passive.setCount(5);
  passive.activation = ActivationMode.PASSIVE;
  const pSink = node(d, NodeType.DRAIN);
  conn(d, passive, pSink).rate = 1;
  const rc = conn(d, pool, passive, ConnectionType.STATE);
  rc.reverseTrigger = true;
  steps(e, 1);
  eq(pSink.drained, 0, 'passive not triggered when source succeeded');
  eq(sink.drained, 1, 'source did fire normally');
});

// ── P2: conditions referencing variables ─────────────────────────────────────
console.log('\nCondition over variable');

test('condition can compare against a named diagram variable', () => {
  const { d, e } = setup();
  // Use diagram.params as the simplest way to put a constant into variables.
  d.params['level'] = 8;
  const src = node(d, NodeType.SOURCE);
  const pool = node(d, NodeType.POOL);
  const rc = conn(d, src, pool); rc.rate = 3;
  rc.condEnabled = true; rc.condRefMode = 'variable'; rc.condVariable = 'level';
  rc.condOperator = '>='; rc.condValue = 5;
  steps(e, 1);
  eq(pool.resources, 3, 'fires when level(8) >= 5');
});

test('condition over variable blocks flow when variable is too low', () => {
  const { d, e } = setup();
  const src = node(d, NodeType.SOURCE);
  const pool = node(d, NodeType.POOL);
  // Variable 'lvl' stays at 0 (no state conn sets it)
  const rc = conn(d, src, pool); rc.rate = 5;
  rc.condEnabled = true; rc.condRefMode = 'variable'; rc.condVariable = 'lvl';
  rc.condOperator = '>='; rc.condValue = 10;
  steps(e, 3);
  eq(pool.resources, 0, 'blocked — lvl not set (defaults to 0 < 10)');
});

// ── P2: diagram params seeded into variables ─────────────────────────────────
console.log('\nDiagram params');

test('diagram.params constants are available in register formulas', () => {
  const { d, e } = setup();
  d.params['rate'] = 7;
  const reg = node(d, NodeType.REGISTER); reg.formula = 'rate * 2';
  steps(e, 1);
  eq(reg.value, 14, 'register reads diagram param');
});

// ── P2: distribution rate mode ───────────────────────────────────────────────
console.log('\nDistribution rates');

test('normal distribution produces non-negative integers near mean', () => {
  let sum = 0;
  for (let i = 0; i < 200; i++) sum += sampleDist('normal', 10, 1);
  const mean = sum / 200;
  assert(mean >= 8 && mean <= 12, `normal(10,1) mean ~10 (got ${mean.toFixed(2)})`);
});

test('uniform distribution stays in [min,max]', () => {
  withRandom(0, () => eq(sampleDist('uniform', 3, 8), 3, 'min at r=0'));
  withRandom(0.9999, () => {
    const v = sampleDist('uniform', 3, 8);
    assert(v >= 3 && v <= 8, `uniform in range (got ${v})`);
  });
});

test('exponential distribution produces non-negative integers', () => {
  for (let i = 0; i < 50; i++) assert(sampleDist('exponential', 2) >= 0, 'non-negative');
});

test('poisson distribution produces non-negative integers', () => {
  let sum = 0;
  for (let i = 0; i < 200; i++) { const v = sampleDist('poisson', 5); assert(v >= 0); sum += v; }
  const mean = sum / 200;
  assert(mean >= 3 && mean <= 7, `poisson(5) mean ~5 (got ${mean.toFixed(2)})`);
});

test('distribution rate mode moves resources stochastically', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p);
  c.rateMode = RateMode.DISTRIBUTION; c.distType = 'normal'; c.distParam1 = 5; c.distParam2 = 1;
  steps(e, 20);
  assert(p.resources > 50 && p.resources < 200, `pool grew stochastically (got ${p.resources})`);
});

// ── P2: gate all-outputs mode ─────────────────────────────────────────────────
console.log('\nGate all-outputs mode');

test('gate "all" fires every output with its weight amount', () => {
  const { d, e } = setup();
  const g = node(d, NodeType.GATE); g.setCount(10); g.gateMode = 'all';
  const p1 = node(d, NodeType.POOL);
  const p2 = node(d, NodeType.POOL);
  const p3 = node(d, NodeType.POOL);
  conn(d, g, p1).weight = 2;
  conn(d, g, p2).weight = 3;
  conn(d, g, p3).weight = 1;
  steps(e, 1);
  eq(p1.resources, 2, 'p1 got its weight (2)');
  eq(p2.resources, 3, 'p2 got its weight (3)');
  eq(p3.resources, 1, 'p3 got its weight (1)');
  eq(g.resources, 4, 'gate has 10-6=4 remaining');
});

test('gate "all" stops when resources exhausted mid-outputs', () => {
  const { d, e } = setup();
  const g = node(d, NodeType.GATE); g.setCount(3); g.gateMode = 'all';
  const p1 = node(d, NodeType.POOL);
  const p2 = node(d, NodeType.POOL);
  conn(d, g, p1).weight = 2;
  conn(d, g, p2).weight = 2;
  steps(e, 1);
  eq(p1.resources + p2.resources, 3, 'total distributed = 3 (all available)');
  eq(g.resources, 0, 'gate emptied');
});

// ── P2: serialization of new fields ──────────────────────────────────────────
console.log('\nP2 serialization');

test('reverse trigger and condRefMode survive JSON round-trip', () => {
  const { d } = setup();
  const a = node(d, NodeType.POOL);
  const b = node(d, NodeType.POOL);
  const rt = conn(d, a, b, ConnectionType.STATE);
  rt.reverseTrigger = true;
  const rc = conn(d, a, b);
  rc.condEnabled = true; rc.condRefMode = 'variable'; rc.condVariable = 'speed';

  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  const conns = [...d2.connections.values()];
  const rt2 = conns.find(c => c.reverseTrigger === true);
  assert(rt2, 'reverseTrigger preserved');
  const rc2 = conns.find(c => c.condRefMode === 'variable');
  assert(rc2 && rc2.condVariable === 'speed', 'condRefMode/condVariable preserved');
});

test('distribution rate fields survive JSON round-trip', () => {
  const { d } = setup();
  const s = node(d, NodeType.SOURCE); const p = node(d, NodeType.POOL);
  const c = conn(d, s, p);
  c.rateMode = RateMode.DISTRIBUTION; c.distType = 'poisson'; c.distParam1 = 3; c.distParam2 = 0;
  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  const c2 = [...d2.connections.values()][0];
  eq(c2.rateMode, RateMode.DISTRIBUTION, 'rateMode preserved');
  eq(c2.distType, 'poisson', 'distType preserved');
  eq(c2.distParam1, 3, 'distParam1 preserved');
});

test('diagram.params survive JSON round-trip', () => {
  const { d } = setup();
  d.params['alpha'] = 0.5; d.params['cap'] = 100;
  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  assert(d2.params['alpha'] === 0.5 && d2.params['cap'] === 100, 'params preserved');
});

// ── P3: time modes ───────────────────────────────────────────────────────────
console.log('\nTime modes');

test('async time mode fires a node on its own interval', () => {
  const { d, e } = setup();
  d.timeMode = 'async';
  const s = node(d, NodeType.SOURCE); s.fireEvery = 2;   // every other step
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 1;
  e.reset();
  e.doStep(); eq(p.resources, 1, 'fires on step 1 (t=0)');
  e.doStep(); eq(p.resources, 1, 'skips step 2');
  e.doStep(); eq(p.resources, 2, 'fires on step 3');
});

test('async firePhase offsets the first firing', () => {
  const { d, e } = setup();
  d.timeMode = 'async';
  const s = node(d, NodeType.SOURCE); s.fireEvery = 2; s.firePhase = 1;
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 1;
  e.reset();
  e.doStep(); eq(p.resources, 0, 'phase delays step 1 (t=-1)');
  e.doStep(); eq(p.resources, 1, 'fires on step 2 (t=0)');
  e.doStep(); eq(p.resources, 1, 'skips step 3');
  e.doStep(); eq(p.resources, 2, 'fires on step 4');
});

test('sync time mode (default) ignores per-node fireEvery', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.fireEvery = 5;   // ignored when sync
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 1;
  steps(e, 3);
  eq(p.resources, 3, 'every step in synchronous mode');
});

// ── P3: artificial player ─────────────────────────────────────────────────────
console.log('\nArtificial player');

test('AI player fires an interactive node on an interval', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(100);
  p.activation = ActivationMode.INTERACTIVE;
  const dr = node(d, NodeType.DRAIN);
  conn(d, p, dr).rate = 1;
  d.aiPlayer = { enabled: true, rules: [{ nodeId: p.id, mode: 'interval', every: 2 }] };
  e.reset();
  e.doStep(); eq(dr.drained, 1, 'AI fired on step 1 (t=0)');
  e.doStep(); eq(dr.drained, 1, 'skipped step 2');
  e.doStep(); eq(dr.drained, 2, 'AI fired on step 3');
});

test('AI player does nothing while disabled', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(100);
  p.activation = ActivationMode.INTERACTIVE;
  const dr = node(d, NodeType.DRAIN);
  conn(d, p, dr).rate = 1;
  d.aiPlayer = { enabled: false, rules: [{ nodeId: p.id, mode: 'interval', every: 1 }] };
  steps(e, 5);
  eq(dr.drained, 0, 'interactive node never fired (AI off, no clicks)');
});

test('AI player fires on a variable condition', () => {
  const { d, e } = setup();
  const src = node(d, NodeType.SOURCE);
  const bank = node(d, NodeType.POOL);
  conn(d, src, bank).rate = 2;                        // bank grows by 2/step
  const sc = conn(d, bank, bank, ConnectionType.STATE); sc.variableName = 'bank';

  const spender = node(d, NodeType.POOL); spender.setCount(100);
  spender.activation = ActivationMode.INTERACTIVE;
  const dr = node(d, NodeType.DRAIN);
  conn(d, spender, dr).rate = 1;
  d.aiPlayer = { enabled: true, rules: [
    { nodeId: spender.id, mode: 'condition', condVar: 'bank', condOp: '>=', condValue: 6 },
  ]};
  e.reset();
  for (let i = 0; i < 3; i++) e.doStep();             // variables lag one step; bank var hits 6 now
  eq(dr.drained, 0, 'not fired while the prior-step bank value was < 6');
  e.doStep();
  eq(dr.drained, 1, 'AI fired once bank >= 6');
});

// ── P3: serialization of new fields ──────────────────────────────────────────
console.log('\nP3 serialization');

test('time mode and per-node async fields survive JSON round-trip', () => {
  const { d } = setup();
  d.timeMode = 'async';
  const s = node(d, NodeType.SOURCE); s.fireEvery = 3; s.firePhase = 2;
  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  eq(d2.timeMode, 'async', 'timeMode preserved');
  const s2 = [...d2.nodes.values()].find(n => n.type === NodeType.SOURCE);
  eq(s2.fireEvery, 3, 'fireEvery preserved');
  eq(s2.firePhase, 2, 'firePhase preserved');
});

test('AI player rules survive JSON round-trip', () => {
  const { d } = setup();
  const p = node(d, NodeType.POOL); p.activation = ActivationMode.INTERACTIVE;
  d.aiPlayer = { enabled: true, rules: [
    { nodeId: p.id, mode: 'interval', every: 4 },
    { nodeId: p.id, mode: 'condition', condVar: 'gold', condOp: '>', condValue: 10 },
  ]};
  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  assert(d2.aiPlayer.enabled === true, 'enabled preserved');
  eq(d2.aiPlayer.rules.length, 2, 'rules preserved');
  eq(d2.aiPlayer.rules[1].condVar, 'gold', 'rule condVar preserved');
  eq(d2.aiPlayer.rules[0].every, 4, 'rule interval preserved');
});

test('default (sync, no AI) diagram omits the new fields from JSON', () => {
  const { d } = setup();
  node(d, NodeType.POOL);
  const json = d.toJSON();
  assert(json.timeMode === undefined, 'sync timeMode omitted');
  assert(json.aiPlayer === undefined, 'empty aiPlayer omitted');
});

// ── P2: groups and sticky notes ───────────────────────────────────────────────
console.log('\nGroups and sticky notes');

test('MGroup serializes and deserializes correctly', () => {
  const g = new MGroup(10, 20, 200, 150);
  g.label = 'Layer A'; g.color = '#ba68c8';
  const json = JSON.parse(JSON.stringify(g.toJSON()));
  eq(json.x, 10, 'x'); eq(json.y, 20, 'y'); eq(json.w, 200, 'w'); eq(json.h, 150, 'h');
  eq(json.label, 'Layer A', 'label'); eq(json.color, '#ba68c8', 'color');
  const g2 = new MGroup(0, 0, 10, 10); g2.loadJSON(json);
  eq(g2.label, 'Layer A', 'label round-trip'); eq(g2.w, 200, 'w round-trip');
});

test('MNote serializes and deserializes correctly', () => {
  const n = new MNote(50, 80);
  n.text = 'Hello\nWorld'; n.color = '#f6e05e'; n.w = 180; n.h = 90;
  const json = JSON.parse(JSON.stringify(n.toJSON()));
  eq(json.x, 50, 'x'); eq(json.y, 80, 'y'); eq(json.text, 'Hello\nWorld', 'text');
  const n2 = new MNote(0, 0); n2.loadJSON(json);
  eq(n2.text, 'Hello\nWorld', 'text round-trip'); eq(n2.w, 180, 'w round-trip');
});

test('Diagram with groups and notes round-trips through JSON', () => {
  const { d } = setup();
  const g = d.addGroup(new MGroup(0, 0, 200, 100)); g.label = 'Section'; g.color = '#4caf50';
  const note = d.addNote(new MNote(50, 50)); note.text = 'annotate'; note.color = '#ff9800';
  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  eq(d2.groups.size, 1, 'groups preserved');
  eq(d2.notes.size, 1, 'notes preserved');
  const g2 = [...d2.groups.values()][0];
  eq(g2.label, 'Section', 'group label'); eq(g2.color, '#4caf50', 'group color');
  const n2 = [...d2.notes.values()][0];
  eq(n2.text, 'annotate', 'note text'); eq(n2.color, '#ff9800', 'note color');
});

test('Diagram without groups/notes omits those fields from JSON', () => {
  const { d } = setup();
  node(d, NodeType.POOL);
  const json = d.toJSON();
  assert(json.groups === undefined, 'groups omitted when empty');
  assert(json.notes === undefined, 'notes omitted when empty');
});

test('removeGroup and removeNote delete entries from the diagram', () => {
  const { d } = setup();
  const g = d.addGroup(new MGroup(0, 0, 100, 80));
  const note = d.addNote(new MNote(10, 10));
  eq(d.groups.size, 1, 'group added'); eq(d.notes.size, 1, 'note added');
  d.removeGroup(g.id); d.removeNote(note.id);
  eq(d.groups.size, 0, 'group removed'); eq(d.notes.size, 0, 'note removed');
});

// ── P2: on-canvas chart elements ──────────────────────────────────────────────
console.log('\nOn-canvas charts');

test('MChart serializes and deserializes correctly', () => {
  const c = new MChart(40, 60);
  c.label = 'Economy'; c.w = 300; c.h = 200; c.nodeIds = ['n_a', 'n_b'];
  const json = JSON.parse(JSON.stringify(c.toJSON()));
  eq(json.x, 40, 'x'); eq(json.label, 'Economy', 'label'); eq(json.w, 300, 'w');
  eq(json.nodeIds.length, 2, 'nodeIds length');
  const c2 = new MChart(0, 0); c2.loadJSON(json);
  eq(c2.label, 'Economy', 'label round-trip');
  eq(c2.nodeIds[1], 'n_b', 'nodeIds round-trip');
});

test('chart type round-trips (default omitted, non-default kept)', () => {
  const c = new MChart(0, 0);
  eq(c.chartType, 'line', 'default type is line');
  const j1 = JSON.parse(JSON.stringify(c.toJSON()));
  eq(j1.chartType, undefined, 'default type omitted from JSON');
  c.chartType = 'bars';
  const j2 = JSON.parse(JSON.stringify(c.toJSON()));
  const c2 = new MChart(0, 0); c2.loadJSON(j2);
  eq(c2.chartType, 'bars', 'non-default type preserved');
  const c3 = new MChart(0, 0); c3.loadJSON(j1);
  eq(c3.chartType, 'line', 'legacy JSON without type defaults to line');
});

test('chart nodeIds is copied, not aliased, on load', () => {
  const c = new MChart(0, 0); c.nodeIds = ['x'];
  const json = c.toJSON();
  const c2 = new MChart(0, 0); c2.loadJSON(json);
  c2.nodeIds.push('y');
  eq(c.nodeIds.length, 1, 'source array unaffected by mutating the loaded copy');
});

test('Diagram with charts round-trips through JSON', () => {
  const { d } = setup();
  const pool = node(d, NodeType.POOL);
  const ch = d.addChart(new MChart(10, 10));
  ch.label = 'Pools'; ch.nodeIds = [pool.id];
  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  eq(d2.charts.size, 1, 'charts preserved');
  const ch2 = [...d2.charts.values()][0];
  eq(ch2.label, 'Pools', 'chart label'); eq(ch2.nodeIds[0], pool.id, 'tracked node id');
});

test('Diagram without charts omits the field from JSON', () => {
  const { d } = setup();
  node(d, NodeType.POOL);
  assert(d.toJSON().charts === undefined, 'charts omitted when empty');
});

test('removeChart deletes the chart from the diagram', () => {
  const { d } = setup();
  const ch = d.addChart(new MChart(0, 0));
  eq(d.charts.size, 1, 'chart added');
  d.removeChart(ch.id);
  eq(d.charts.size, 0, 'chart removed');
});

// ── P2: named resource types ──────────────────────────────────────────────────
console.log('\nNamed resource types');

test('resourceTypeName maps a color to its type name (case-insensitive)', () => {
  const { d } = setup();
  d.resourceTypes = [{ name: 'Gold', color: '#FFD700' }, { name: 'Wood', color: '#8d6e63' }];
  eq(d.resourceTypeName('#ffd700'), 'Gold', 'matches lowercase variant');
  eq(d.resourceTypeName('#8d6e63'), 'Wood', 'matches second type');
  eq(d.resourceTypeName('#123456'), null, 'unknown color → null');
  eq(d.resourceTypeName(''), null, 'empty → null');
});

test('resource types survive JSON round-trip', () => {
  const { d } = setup();
  d.resourceTypes = [{ name: 'Gold', color: '#ffd700' }, { name: 'Mana', color: '#42a5f5' }];
  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  eq(d2.resourceTypes.length, 2, 'count preserved');
  eq(d2.resourceTypes[0].name, 'Gold', 'name preserved');
  eq(d2.resourceTypes[1].color, '#42a5f5', 'color preserved');
  eq(d2.resourceTypeName('#ffd700'), 'Gold', 'lookup still works after load');
});

test('resource types are copied, not aliased, on load', () => {
  const { d } = setup();
  d.resourceTypes = [{ name: 'Gold', color: '#ffd700' }];
  const json = d.toJSON();
  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(json)));
  d2.resourceTypes[0].name = 'Silver';
  eq(d.resourceTypes[0].name, 'Gold', 'source diagram unaffected by mutating the loaded copy');
});

test('default diagram omits resourceTypes from JSON', () => {
  const { d } = setup();
  node(d, NodeType.POOL);
  assert(d.toJSON().resourceTypes === undefined, 'resourceTypes omitted when empty');
});

test('named-type resources still flow as colors through the engine', () => {
  const { d, e } = setup();
  d.resourceTypes = [{ name: 'Gold', color: '#ffd700' }];
  const s = node(d, NodeType.SOURCE); s.resourceColor = '#ffd700';
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 3;
  steps(e, 2);
  eq(p.resources, 6, 'pool accumulated gold');
  eq(p.colorMap['#ffd700'], 6, 'tracked under the type color');
  eq(d.resourceTypeName(Object.keys(p.colorMap)[0]), 'Gold', 'held color resolves to the type name');
});

// ── Sweep fixes: per-tick fire dedup ──────────────────────────────────────────
console.log('\nPer-tick fire dedup');

test('a passive node targeted by two triggers fires only once per step', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const b = node(d, NodeType.POOL); b.setCount(10);
  const c = node(d, NodeType.POOL); c.setCount(50); c.activation = ActivationMode.PASSIVE;
  conn(d, a, node(d, NodeType.DRAIN)).rate = 1;   // give a an outflow so it fires
  conn(d, b, node(d, NodeType.DRAIN)).rate = 1;   // and b
  const dc = node(d, NodeType.DRAIN);
  conn(d, c, dc).rate = 5;
  const t1 = conn(d, a, c, ConnectionType.STATE); t1.trigger = true;
  const t2 = conn(d, b, c, ConnectionType.STATE); t2.trigger = true;
  steps(e, 1);
  eq(dc.drained, 5, 'C activated once (5), not twice (10)');
});

test('a node that is both automatic and triggered fires once', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  conn(d, a, node(d, NodeType.DRAIN)).rate = 1;
  const t = node(d, NodeType.POOL); t.setCount(50);  // automatic
  const dt = node(d, NodeType.DRAIN);
  conn(d, t, dt).rate = 5;
  const tr = conn(d, a, t, ConnectionType.STATE); tr.trigger = true;
  steps(e, 1);
  eq(dt.drained, 5, 'auto+triggered node activates once (5), not twice (10)');
});

test('mutual triggers each fire once and terminate', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(100);
  const b = node(d, NodeType.POOL); b.setCount(100);
  const da = node(d, NodeType.DRAIN); const db = node(d, NodeType.DRAIN);
  conn(d, a, da).rate = 1;
  conn(d, b, db).rate = 1;
  const t1 = conn(d, a, b, ConnectionType.STATE); t1.trigger = true;
  const t2 = conn(d, b, a, ConnectionType.STATE); t2.trigger = true;
  steps(e, 1);
  eq(da.drained, 1, 'A fired once');
  eq(db.drained, 1, 'B fired once');
});

// ── Sweep fixes: non-finite rate sanitization ─────────────────────────────────
console.log('\nNon-finite rate sanitization');

test('sampleDist with a non-finite parameter never returns NaN', () => {
  for (let i = 0; i < 50; i++) {
    const v = sampleDist('uniform', NaN, 5);
    assert(isFinite(v) && v >= 0, `uniform(NaN,5) finite & >=0 (got ${v})`);
  }
  assert(isFinite(sampleDist('normal', NaN, NaN)), 'normal(NaN,NaN) finite');
  assert(isFinite(sampleDist('poisson', Infinity)), 'poisson(Infinity) finite');
});

test('a NaN connection rate moves nothing and never corrupts node state', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p); c.rate = NaN;
  steps(e, 3);
  assert(isFinite(p.resources), 'pool resources stay finite');
  eq(p.resources, 0, 'no resources moved by a NaN rate');
});

// ── Sweep fixes: delay honours a finite capacity ──────────────────────────────
console.log('\nDelay capacity');

test('a delay with a finite capacity does not overfill', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const dl = node(d, NodeType.DELAY); dl.delay = 5; dl.capacity = 3;
  const p = node(d, NodeType.POOL);
  conn(d, s, dl).rate = 10;
  conn(d, dl, p).rate = 99;
  steps(e, 3);
  assert(dl.resources <= 3, `delay never exceeds capacity 3 (got ${dl.resources})`);
  eq(dl.resources, 3, 'delay fills to exactly its capacity');
});

// ── Sweep fixes: modifiers are order-independent (atomic) ──────────────────────
console.log('\nModifier atomicity');

test('mutual modifiers read the step-start values (order-independent)', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(100);
  const b = node(d, NodeType.POOL); b.setCount(100);
  const m1 = conn(d, a, b, ConnectionType.STATE); m1.modifier = true; m1.modFactor = 0.5;
  const m2 = conn(d, b, a, ConnectionType.STATE); m2.modifier = true; m2.modFactor = 0.5;
  steps(e, 1);
  eq(a.resources, 150, 'A grew by 0.5×B(100), not by the post-mutation B');
  eq(b.resources, 150, 'B grew by 0.5×A(100)');
});

test('chained modifiers do not leak a value across nodes in one step', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(100);
  const b = node(d, NodeType.POOL); b.setCount(0);
  const c = node(d, NodeType.POOL); c.setCount(0);
  const m1 = conn(d, a, b, ConnectionType.STATE); m1.modifier = true; m1.modFactor = 1;
  const m2 = conn(d, b, c, ConnectionType.STATE); m2.modifier = true; m2.modFactor = 1;
  steps(e, 1);
  eq(b.resources, 100, 'B received A\'s step-start value');
  eq(c.resources, 0, 'C received B\'s step-start value (0), not the leaked 100');
});

// ── Sweep fixes: pull-all is truly atomic ─────────────────────────────────────
console.log('\nPull-all atomicity');

test('pull-all moves nothing when the puller cannot hold the whole batch', () => {
  const { d, e } = setup();
  const prov1 = node(d, NodeType.POOL); prov1.setCount(10);
  const prov2 = node(d, NodeType.POOL); prov2.setCount(10);
  const pull = node(d, NodeType.POOL); pull.capacity = 3;
  pull.flowMode = 'pull'; pull.pullPolicy = 'all';
  conn(d, prov1, pull).rate = 3;
  conn(d, prov2, pull).rate = 3;     // total want 6 > capacity 3
  steps(e, 1);
  eq(pull.resources, 0, 'nothing pulled (atomic) — capacity too small for the batch');
  eq(prov1.resources, 10, 'provider 1 untouched');
  eq(prov2.resources, 10, 'provider 2 untouched');
});

test('pull-all moves nothing when one provider lacks the filtered colour', () => {
  const { d, e } = setup();
  const provA = node(d, NodeType.POOL); provA.setCount(5, '#aaaaaa');
  const provB = node(d, NodeType.POOL); provB.setCount(5, '#bbbbbb');
  const pull = node(d, NodeType.POOL); pull.flowMode = 'pull'; pull.pullPolicy = 'all';
  const cA = conn(d, provA, pull); cA.rate = 2; cA.colorFilter = '#aaaaaa'; // can supply
  const cB = conn(d, provB, pull); cB.rate = 2; cB.colorFilter = '#cccccc'; // cannot
  steps(e, 1);
  eq(pull.resources, 0, 'nothing pulled — provB cannot supply #cccccc');
  eq(provA.resources, 5, 'provider A untouched (atomic)');
});

// ── Cross-node contention: fair allocation across competing push pools ────────
console.log('\nCross-node push contention');

test('two pools competing for a shared capacity-limited target split fairly', () => {
  // Pool A (5 resources) and Pool B (5 resources) both push into Target (capacity 6).
  // Old behaviour: A fires first, claims all 5; B only gets 1.
  // New behaviour: fair-allocate 6 across A:5 + B:5 → A gets 3, B gets 3.
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(5);
  const b = node(d, NodeType.POOL); b.setCount(5);
  const t = node(d, NodeType.POOL); t.capacity = 6;
  conn(d, a, t).rate = 5;
  conn(d, b, t).rate = 5;
  steps(e, 1);
  eq(t.resources, 6, 'target filled to capacity');
  eq(a.resources + b.resources, 4, 'remaining resources conserved across both pools');
  assert(a.resources >= 2 && a.resources <= 4, `A got a fair share (resources=${a.resources})`);
  assert(b.resources >= 2 && b.resources <= 4, `B got a fair share (resources=${b.resources})`);
});

test('three pools competing for shared capacity get max-min fair shares', () => {
  // Three pools each want 4; target capacity 6.
  // Max-min fair: each pool gets 2 (6 / 3 = 2 each).
  const { d, e } = setup();
  const pools = [
    (() => { const p = node(d, NodeType.POOL); p.setCount(4); return p; })(),
    (() => { const p = node(d, NodeType.POOL); p.setCount(4); return p; })(),
    (() => { const p = node(d, NodeType.POOL); p.setCount(4); return p; })(),
  ];
  const t = node(d, NodeType.POOL); t.capacity = 6;
  for (const p of pools) conn(d, p, t).rate = 4;
  steps(e, 1);
  eq(t.resources, 6, 'target filled to capacity');
  for (const p of pools) {
    assert(p.resources >= 1 && p.resources <= 3, `each pool lost a fair share (remaining=${p.resources})`);
  }
});

test('cross-node push: conservation holds — no resources created or lost', () => {
  // Two pools (total 10) push into target (capacity 6). After step:
  // target + pool remainders must still equal 10.
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(5);
  const b = node(d, NodeType.POOL); b.setCount(5);
  const t = node(d, NodeType.POOL); t.capacity = 6;
  conn(d, a, t).rate = 5;
  conn(d, b, t).rate = 5;
  steps(e, 1);
  eq(a.resources + b.resources + t.resources, 10, 'total conserved');
});

// ── Trader ──────────────────────────────────────────────────────────────────
console.log('\nTrader');

test('trader swaps resources between two pools at the connection rates', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10, '#gold');
  const b = node(d, NodeType.POOL); b.setCount(10, '#wood');
  const t = node(d, NodeType.TRADER);
  conn(d, a, t).rate = 3;  // A pays 3
  conn(d, t, b).rate = 2;  // B pays 2 back
  steps(e, 1);
  eq(a.resources, 9, 'A: 10 - 3 + 2');
  eq(b.resources, 11, 'B: 10 - 2 + 3');
  eq(a.colorMap['#wood'], 2, 'A received wood');
  eq(b.colorMap['#gold'], 3, 'B received gold');
  eq(t.trades, 1, 'one exchange counted');
  eq(t.resources, 0, 'trader holds nothing');
});

test('trade is atomic: nothing moves if one side cannot pay in full', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const b = node(d, NodeType.POOL); b.setCount(1);
  const t = node(d, NodeType.TRADER);
  conn(d, a, t).rate = 3;
  conn(d, t, b).rate = 2;  // B holds only 1 — cannot pay 2
  steps(e, 1);
  eq(a.resources, 10, 'A unchanged');
  eq(b.resources, 1, 'B unchanged');
  eq(t.trades, 0, 'no exchange');
});

test('trade is atomic: nothing moves if a receiver lacks capacity', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const b = node(d, NodeType.POOL); b.setCount(5); b.capacity = 6;  // room for 1, x=3 (pays 2 → room 3 < 3? 6-5+2=3 ≥ 3 OK)
  const c = node(d, NodeType.POOL); c.setCount(5); c.capacity = 5;  // pays 1, receives 3 → 5-5+1=1 < 3: blocked
  const t = node(d, NodeType.TRADER);
  conn(d, a, t).rate = 3;
  conn(d, t, c).rate = 1;
  steps(e, 1);
  eq(a.resources, 10, 'A unchanged (C could not receive)');
  eq(c.resources, 5, 'C unchanged');
  eq(t.trades, 0, 'no exchange');
});

test('a full pool can still swap like-for-like (room credited for what it pays)', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const b = node(d, NodeType.POOL); b.setCount(8, '#wood'); b.capacity = 8; // full, pays 2, receives 2
  const t = node(d, NodeType.TRADER);
  conn(d, a, t).rate = 2;
  conn(d, t, b).rate = 2;
  steps(e, 1);
  eq(b.resources, 8, 'B still full after the swap');
  eq(b.colorMap[DEFAULT_COLOR], 2, 'B now holds 2 of what A paid');
  eq(a.resources, 10, 'A count unchanged by an even swap');
  eq(a.colorMap['#wood'], 2, 'A received wood');
  eq(t.trades, 1, 'exchange happened');
});

test('an unlimited source can be a trade partner (pays freely, accepts nothing)', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.resourceColor = '#gold';
  const b = node(d, NodeType.POOL); b.setCount(10, '#wood');
  const t = node(d, NodeType.TRADER);
  conn(d, s, t).rate = 5;  // source pays 5
  conn(d, t, b).rate = 0;  // B pays nothing back (a gift via trade)
  steps(e, 2);
  eq(b.resources, 20, 'B gained 5/step from the source');
  eq(b.colorMap['#gold'], 10, 'in the source colour');
  eq(s.produced, 10, 'source production tracked');
  eq(t.trades, 2, 'one exchange per step');
});

test('colour filters constrain what each side pays', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL);
  a.addResources(5, '#gold'); a.addResources(5, '#iron');
  a._initialResources = a.resources; a._initialColorMap = { ...a.colorMap };
  const b = node(d, NodeType.POOL); b.setCount(10, '#wood');
  const t = node(d, NodeType.TRADER);
  const cin = conn(d, a, t); cin.rate = 2; cin.colorFilter = '#gold';
  const cout = conn(d, t, b); cout.rate = 3; cout.colorFilter = '#wood';
  steps(e, 1);
  eq(b.colorMap['#gold'], 2, 'B got gold only');
  eq(a.colorMap['#gold'], 3, 'A paid from its gold');
  eq(a.colorMap['#iron'], 5, 'iron untouched');
  eq(a.colorMap['#wood'], 3, 'A received wood');
});

test('pools do not push into a trader on their own (trade routes are trader-driven)', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10);
  const t = node(d, NodeType.TRADER);
  t.activation = ActivationMode.PASSIVE;  // trader never fires
  conn(d, a, t).rate = 3;
  steps(e, 3);
  eq(a.resources, 10, 'A kept its resources');
  eq(t.resources, 0, 'trader holds nothing');
});

test('multiple in/out pairs trade independently in wiring order', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(10, '#gold');
  const b = node(d, NodeType.POOL); b.setCount(10, '#wood');
  const c = node(d, NodeType.POOL); c.setCount(10, '#fish');
  const x = node(d, NodeType.POOL); x.setCount(0);
  const t = node(d, NodeType.TRADER);
  conn(d, a, t).rate = 1;  // pair 1: A pays 1 …
  conn(d, t, b).rate = 2;  //   … B pays 2 back
  conn(d, c, t).rate = 4;  // pair 2: C pays 4 …
  conn(d, t, x).rate = 0;  //   … X pays 0 back
  steps(e, 1);
  eq(a.resources, 11, 'A: 10 - 1 + 2');
  eq(b.resources, 9, 'B: 10 - 2 + 1');
  eq(c.resources, 6, 'C: 10 - 4');
  eq(x.resources, 4, 'X received 4');
  eq(t.trades, 2, 'two exchanges in one step');
});

test('trader conservation: total resources unchanged by any number of trades', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(20);
  const b = node(d, NodeType.POOL); b.setCount(15);
  const t = node(d, NodeType.TRADER);
  conn(d, a, t).rate = 3;
  conn(d, t, b).rate = 2;
  steps(e, 10);
  eq(a.resources + b.resources, 35, 'total conserved');
  assert(t.trades > 0, 'trades happened');
});

// ── Custom variables ─────────────────────────────────────────────────────────
console.log('\nCustom variables');

test('interval uniform sample stays in [min, max]', () => {
  const rv = { name: 'r', kind: 'interval', min: 2, max: 5, dist: 'uniform', update: 'step' };
  for (let i = 0; i < 200; i++) {
    const v = sampleCustomVar(rv);
    assert(v >= 2 && v <= 5, `sample ${v} out of range`);
  }
  withRandom(0, () => eq(sampleCustomVar(rv), 2, 'u=0 → min'));
});

test('interval gaussian sample stays in [min, max] and centres', () => {
  const rv = { name: 'r', kind: 'interval', min: 0, max: 10, dist: 'gaussian', update: 'step' };
  let sum = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const v = sampleCustomVar(rv);
    assert(v >= 0 && v <= 10, `sample ${v} out of range`);
    sum += v;
  }
  const mean = sum / N;
  assert(mean > 4 && mean < 6, `gaussian mean ${mean} should be near 5`);
});

test('array picks only listed values; gaussian favours the middle', () => {
  const rv = { name: 'r', kind: 'array', values: [1, 7, 42], dist: 'uniform', update: 'step' };
  for (let i = 0; i < 100; i++)
    assert([1, 7, 42].includes(sampleCustomVar(rv)), 'picked a listed value');
  rv.dist = 'gaussian';
  const counts = { 1: 0, 7: 0, 42: 0 };
  for (let i = 0; i < 2000; i++) counts[sampleCustomVar(rv)]++;
  assert(counts[7] > counts[1] && counts[7] > counts[42], `middle element most likely: ${JSON.stringify(counts)}`);
});

test('dice uniform follows roll convention; gaussian stays in [X, X*Y]', () => {
  const rv = { name: 'r', kind: 'dice', dice: '2d6', dist: 'uniform', update: 'step' };
  withRandom(0, () => eq(sampleCustomVar(rv), 2, 'all-ones roll'));
  withRandom(0.999, () => eq(sampleCustomVar(rv), 12, 'all-sixes roll'));
  rv.dist = 'gaussian';
  for (let i = 0; i < 200; i++) {
    const v = sampleCustomVar(rv);
    assert(v >= 2 && v <= 12 && v === Math.round(v), `gaussian dice ${v} valid`);
  }
});

test('step-updated random var resamples each step and feeds formulas', () => {
  const { d, e } = setup();
  d.customVars = [{ name: 'flow', kind: 'array', values: [3], dist: 'uniform', update: 'step', value: 0 }];
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p);
  c.rateMode = RateMode.FORMULA; c.formula = 'flow';
  e.reset();
  eq(d.variables.flow, 3, 'sampled at reset');
  e.doStep(); e.doStep();
  eq(p.resources, 6, 'formula read the random var each step');
});

test('play-updated random var holds its value across steps', () => {
  const { d, e } = setup();
  d.customVars = [{ name: 'k', kind: 'interval', min: 0, max: 100, dist: 'uniform', update: 'play', value: 0 }];
  e.reset();
  const first = d.variables.k;
  e.doStep(); e.doStep(); e.doStep();
  eq(d.variables.k, first, 'value unchanged by steps');
});

test('random variables survive JSON round-trip', () => {
  const { d } = setup();
  d.customVars = [
    { name: 'a', kind: 'interval', min: 1, max: 9, dist: 'gaussian', update: 'play', value: 4 },
    { name: 'b', kind: 'array', values: [2, 4, 8], dist: 'uniform', update: 'step', value: 4 },
    { name: 'c', kind: 'dice', dice: '3d4', dist: 'uniform', update: 'step', value: 7 },
  ];
  const d2 = new Diagram(); d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  eq(d2.customVars.length, 3, 'all vars restored');
  eq(d2.customVars[0].dist, 'gaussian', 'dist preserved');
  eq(d2.customVars[0].update, 'play', 'update preserved');
  assert(Array.isArray(d2.customVars[1].values) && d2.customVars[1].values.join() === '2,4,8', 'array values preserved');
  eq(d2.customVars[2].dice, '3d4', 'dice preserved');
});

// ── Math-kind custom variables + math.js formulas ───────────────────────────
console.log('\nMath variables & math.js formulas');

test('math.js syntax works in formulas (power, ternary, functions)', () => {
  assert(typeof math !== 'undefined', 'mathjs should be loaded for these tests (npm install)');
  eq(evalFormula('2 ^ 10'), 1024, 'caret is power, not XOR');
  eq(evalFormula('a > 5 ? 10 : 0', { a: 9 }), 10, 'ternary');
  eq(evalFormula('round(2.6) + max(1, b, 3)', { b: 99 }), 102, 'round/max');
  eq(evalFormula('log(e)'), 1, 'constants');
});

test('legacy JS-syntax formulas still evaluate (fallback path)', () => {
  eq(evalFormula('Math.round(2.6)'), 3, 'Math.round falls back to JS eval');
  eq(evalFormula('Math.min(a, 5)', { a: 3 }), 3, 'Math.min with vars');
});

test('validateFormula accepts both syntaxes, rejects garbage', () => {
  assert(validateFormula('round(x * 2)'), 'math.js syntax valid');
  assert(validateFormula('Math.round(x * 2)'), 'JS syntax valid');
  assert(!validateFormula('2 +* )'), 'garbage rejected');
  assert(!validateFormula(''), 'empty rejected');
});

test('math var computes from params and other custom vars each step', () => {
  const { d, e } = setup();
  d.params = { base: 4 };
  d.customVars = [
    { name: 'roll', kind: 'array', values: [2], dist: 'uniform', update: 'step', value: 0 },
    { name: 'dmg', kind: 'math', formula: 'base + roll * 3', update: 'step', value: 0 },
  ];
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p);
  c.rateMode = RateMode.FORMULA; c.formula = 'dmg';
  e.reset();
  eq(d.variables.dmg, 10, 'math var = base + roll*3 at reset');
  e.doStep(); e.doStep();
  eq(p.resources, 20, 'flow driven by computed var each step');
});

test('play-updated math var freezes its value across steps', () => {
  const { d, e } = setup();
  d.customVars = [
    { name: 'seed', kind: 'interval', min: 0, max: 1000, dist: 'uniform', update: 'step', value: 0 },
    { name: 'snap', kind: 'math', formula: 'seed', update: 'play', value: 0 },
  ];
  e.reset();
  const first = d.variables.snap;
  e.doStep(); e.doStep(); e.doStep();
  eq(d.variables.snap, first, 'play math var holds while seed keeps changing');
});

test('math var formula survives JSON round-trip (and old randomVars key loads)', () => {
  const { d } = setup();
  d.customVars = [{ name: 'm', kind: 'math', formula: 'round(x/2)', update: 'play', value: 0 }];
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  assert(json.customVars && !json.randomVars, 'serialised under customVars');
  const d2 = new Diagram(); d2.loadJSON(json);
  eq(d2.customVars[0].formula, 'round(x/2)', 'formula preserved');
  // Pre-rename saves used the `randomVars` key.
  const d3 = new Diagram();
  d3.loadJSON({ nodes: [], connections: [], randomVars: [{ name: 'old', kind: 'dice', dice: '1d6', dist: 'uniform', update: 'step', value: 3 }] });
  eq(d3.customVars.length, 1, 'legacy randomVars key still loads');
  eq(d3.customVars[0].name, 'old', 'legacy var restored');
});

// ── Seeded RNG & reproducibility ────────────────────────────────────────────
console.log('\nSeeded RNG & reproducibility');

test('SimRandom: same seed yields the same sequence; clears back to Math.random', () => {
  SimRandom.seed('hello');
  const a = [SimRandom.random(), SimRandom.random(), SimRandom.random()];
  SimRandom.seed('hello');
  const b = [SimRandom.random(), SimRandom.random(), SimRandom.random()];
  SimRandom.seed('other');
  const c = SimRandom.random();
  SimRandom.seed(null);
  assert(a.every((v, i) => v === b[i]), 'reseeding replays the sequence');
  assert(a[0] !== c, 'different seed, different stream');
  assert(a.every(v => v >= 0 && v < 1), 'values in [0,1)');
  // Unseeded path delegates to Math.random (so test stubs keep working).
  withRandom(0.42, () => eq(SimRandom.random(), 0.42, 'unseeded uses Math.random'));
});

test('seeded Monte Carlo batches are bit-for-bit reproducible', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p);
  c.rateMode = RateMode.DICE; c.dice = '2d6';
  const r1 = e.runMonteCarlo(20, 10, { seed: 'abc' });
  const r2 = e.runMonteCarlo(20, 10, { seed: 'abc' });
  const r3 = e.runMonteCarlo(20, 10, { seed: 'xyz' });
  const v1 = r1.nodes.find(n => n.id === p.id).samples;
  const v2 = r2.nodes.find(n => n.id === p.id).samples;
  const v3 = r3.nodes.find(n => n.id === p.id).samples;
  assert(v1.every((v, i) => v === v2[i]), 'same seed, identical samples');
  assert(v1.some((v, i) => v !== v3[i]), 'different seed, different samples');
  eq(r1.seed, 'abc', 'seed echoed in the result');
});

test('Monte Carlo accepts a baseJSON override (parameter sweep path)', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p);
  c.rateMode = RateMode.FORMULA; c.formula = 'rate';
  d.params = { rate: 1 };
  const json = d.toJSON();
  json.params = { rate: 5 };
  const res = e.runMonteCarlo(3, 4, { baseJSON: json });
  eq(res.nodes.find(n => n.id === p.id).mean, 20, 'swept param drives the clone');
  eq(d.params.rate, 1, 'live diagram untouched');
});

test('history uses adaptive stride: long runs keep full-range coverage, bounded size', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 1;
  e.reset();
  for (let i = 0; i < 2000; i++) e.doStep();
  assert(e.history.length <= 600, `history bounded (${e.history.length})`);
  assert(e.history.length >= 250, `history not starved (${e.history.length})`);
  const steps = e.history.map(h => h.step);
  assert(steps[0] <= 8, `oldest snapshot near the start (step ${steps[0]})`);
  eq(steps[steps.length - 1], 2000, 'newest snapshot is the last step');
  for (let i = 1; i < steps.length; i++) assert(steps[i] > steps[i - 1], 'steps strictly increasing');
});

test('diagram JSON carries a schema version and loads without one (legacy)', () => {
  const { d } = setup();
  eq(d.toJSON().version, 1, 'version written');
  const d2 = new Diagram();
  d2.loadJSON({ nodes: [], connections: [] }); // pre-version file
  eq(d2.nodes.size, 0, 'legacy file loads');
});

// ── Scenario branching: capture / restore ───────────────────────────────────
console.log('\nScenario branching: capture / restore');

test('captureState/restoreState round-trips mid-run state and resumes correctly', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 3;
  e.reset();
  for (let i = 0; i < 4; i++) e.doStep();
  eq(p.resources, 12, 'pool before capture');
  const snap = e.captureState();

  for (let i = 0; i < 4; i++) e.doStep();
  eq(p.resources, 24, 'pool advanced past checkpoint');
  eq(e.step, 8, 'step advanced');

  e.restoreState(snap);
  eq(e.step, 4, 'step restored');
  eq(d.nodes.get(p.id).resources, 12, 'pool restored');
  eq(e.history.length, 4, 'history truncated to checkpoint');

  // The fork can be advanced again — and a second restore replays it.
  e.doStep();
  eq(e.step, 5, 'fork resumes from checkpoint step');
  eq(d.nodes.get(p.id).resources, 15, 'flow continues from restored state');
  e.restoreState(snap);
  eq(d.nodes.get(p.id).resources, 12, 'snapshot restores repeatedly');
});

test('restoreState preserves the Reset baseline (reset returns to run start, not checkpoint)', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.setCount(50);
  const dr = node(d, NodeType.DRAIN);
  conn(d, p, dr).rate = 5;
  e.reset();
  for (let i = 0; i < 3; i++) e.doStep();
  eq(p.resources, 35, 'pool drained');
  const snap = e.captureState();
  e.doStep();
  e.restoreState(snap);
  eq(d.nodes.get(p.id).resources, 35, 'restored to checkpoint');
  e.reset();
  eq(d.nodes.get(p.id).resources, 50, 'Reset still returns to the true initial state');
});

test('captureState carries in-flight delay queue contents', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const dl = node(d, NodeType.DELAY); dl.delay = 3;
  const p = node(d, NodeType.POOL);
  conn(d, s, dl).rate = 2;
  conn(d, dl, p).rate = 2;
  e.reset();
  e.doStep(); e.doStep(); // batches now in flight inside the delay
  const inFlight = d.nodes.get(dl.id)._queue.length;
  assert(inFlight > 0, 'delay holds in-flight batches');
  const snap = e.captureState();
  for (let i = 0; i < 6; i++) e.doStep();
  e.restoreState(snap);
  eq(d.nodes.get(dl.id)._queue.length, inFlight, 'in-flight batches restored');
  // Releases continue on the original schedule after the fork.
  for (let i = 0; i < 6; i++) e.doStep();
  assert(d.nodes.get(p.id).resources > 0, 'delayed batches still release after restore');
});

test('restoreState restores structure removed after the checkpoint', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 1;
  e.reset();
  e.doStep();
  const snap = e.captureState();
  d.removeNode(p.id);
  eq(d.nodes.size, 1, 'node removed');
  e.restoreState(snap);
  eq(d.nodes.size, 2, 'node restored from checkpoint');
  eq(d.connections.size, 1, 'connection restored from checkpoint');
});

// ── Async engine API (Monte Carlo runner) ────────────────────────────────────

testAsync('runMonteCarloAsync honours shouldCancel — resolves null, no results', async () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 1;
  // A caller that always asks to stop bails on the first chunk.
  const res = await e.runMonteCarloAsync(1000, 1000, { shouldCancel: () => true });
  assert(res === null, `cancelled batch resolves to null (got ${res && typeof res})`);
});

testAsync('runMonteCarloAsync completes normally without a cancel signal', async () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 5;
  const res = await e.runMonteCarloAsync(5, 10);
  const pn = res.nodes.find(x => x.id === p.id);
  eq(pn.mean, 50, 'async batch matches the deterministic mean');
});

// ── Results ─────────────────────────────────────────────────────────────────
(async () => {
  if (asyncTests.length) console.log('\nAsync engine API');
  for (const { name, fn } of asyncTests) {
    try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (err) {
      failed++; failures.push({ name, err });
      console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
})();
