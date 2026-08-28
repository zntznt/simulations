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
    fs.readFileSync(path.join(base, 'dsl.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'assertions.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'codegen.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'loops.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'attribution.js'), 'utf8') + '\n' +
    'return { NodeType, ConnectionType, ActivationMode, RateMode, DEFAULT_COLOR,' +
    ' MNode, MConnection, MGroup, MNote, MChart, Diagram, SimEngine, evalFormula, rollDice, dominantColor, sampleDist, sampleCustomVar, validateFormula, SimRandom,' +
    ' dslSerialize, dslParse, normalizeEconJSON, parseAssertion, AssertionChecker, assertionScope, buildEconomyModule, detectLoops, attributeChange };';
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

const API = loadEngine();
const {
  NodeType, ConnectionType, ActivationMode, RateMode, DEFAULT_COLOR,
  MNode, MConnection, MGroup, MNote, MChart, Diagram, SimEngine, evalFormula, rollDice, sampleDist, sampleCustomVar, validateFormula, SimRandom,
  dslSerialize, dslParse, normalizeEconJSON, parseAssertion, AssertionChecker, assertionScope, buildEconomyModule, detectLoops, attributeChange,
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

test('a fractional capacity is floored, never overfilled', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL); p.capacity = 5.5;
  conn(d, s, p).rate = 10;
  steps(e, 3);
  eq(p.resources, 5, 'pool fills to floor(capacity) only');
});

// ── Multi-ingredient recipe converter ────────────────────────────────────────
console.log('\nConverter recipes');

test('recipe converter fires only when all ingredients are available', () => {
  const { d, e } = setup();
  const c = node(d, NodeType.CONVERTER);
  c.inputRecipe = [{ color: '#ff0000', amount: 2 }, { color: '#0000ff', amount: 1 }];
  // Pre-load: 4 red, 2 blue → should yield 2 conversions
  c.resources = 6; c.colorMap = { '#ff0000': 4, '#0000ff': 2 };
  c._initialResources = 6; c._initialColorMap = { '#ff0000': 4, '#0000ff': 2 };
  const out = node(d, NodeType.POOL);
  conn(d, c, out).rate = 1;
  steps(e, 1);
  eq(out.resources, 2, 'two conversions when both ingredients available');
  eq(c.colorMap['#ff0000'] || 0, 0, 'red ingredient consumed');
  eq(c.colorMap['#0000ff'] || 0, 0, 'blue ingredient consumed');
});

test('recipe converter does not fire when one ingredient is missing', () => {
  const { d, e } = setup();
  const c = node(d, NodeType.CONVERTER);
  c.inputRecipe = [{ color: '#ff0000', amount: 2 }, { color: '#0000ff', amount: 1 }];
  // Only red available, no blue
  c.resources = 4; c.colorMap = { '#ff0000': 4 };
  c._initialResources = 4; c._initialColorMap = { '#ff0000': 4 };
  const out = node(d, NodeType.POOL);
  conn(d, c, out).rate = 1;
  steps(e, 1);
  eq(out.resources, 0, 'no conversion without blue ingredient');
  eq(c.resources, 4, 'red stays unconsumed');
});

test('recipe converter does not fire when one ingredient is insufficient', () => {
  const { d, e } = setup();
  const c = node(d, NodeType.CONVERTER);
  c.inputRecipe = [{ color: '#ff0000', amount: 3 }, { color: '#0000ff', amount: 1 }];
  // Only 2 red (need 3) but 2 blue
  c.resources = 4; c.colorMap = { '#ff0000': 2, '#0000ff': 2 };
  c._initialResources = 4; c._initialColorMap = { '#ff0000': 2, '#0000ff': 2 };
  const out = node(d, NodeType.POOL);
  conn(d, c, out).rate = 1;
  steps(e, 1);
  eq(out.resources, 0, 'no conversion when red below recipe amount');
});

test('recipe converter partial batches: fires once then stops when ingredients run short', () => {
  const { d, e } = setup();
  const c = node(d, NodeType.CONVERTER);
  c.inputRecipe = [{ color: '#ff0000', amount: 2 }, { color: '#0000ff', amount: 1 }];
  // Exactly one batch: 2 red + 1 blue
  c.resources = 3; c.colorMap = { '#ff0000': 2, '#0000ff': 1 };
  c._initialResources = 3; c._initialColorMap = { '#ff0000': 2, '#0000ff': 1 };
  const out = node(d, NodeType.POOL);
  conn(d, c, out).rate = 1;
  steps(e, 1);
  eq(out.resources, 1, 'one conversion fired');
  eq(c.resources, 0, 'all ingredients consumed');
});

test('recipe converter: per-connection output color via colorFilter', () => {
  const { d, e } = setup();
  const c = node(d, NodeType.CONVERTER);
  c.inputRecipe = [{ color: '#ff0000', amount: 1 }, { color: '#0000ff', amount: 1 }];
  c.resources = 4; c.colorMap = { '#ff0000': 2, '#0000ff': 2 };
  c._initialResources = 4; c._initialColorMap = { '#ff0000': 2, '#0000ff': 2 };
  const out1 = node(d, NodeType.POOL);
  const out2 = node(d, NodeType.POOL);
  const c1 = conn(d, c, out1); c1.rate = 1; c1.colorFilter = '#00ff00';
  const c2 = conn(d, c, out2); c2.rate = 1; c2.colorFilter = '#ffff00';
  steps(e, 1);
  assert(out1.colorMap['#00ff00'] >= 1, 'out1 receives connection mint color green');
  assert(out2.colorMap['#ffff00'] >= 1, 'out2 receives connection mint color yellow');
});

test('legacy converter: colorFilter on outgoing connection overrides outputColor', () => {
  const { d, e } = setup();
  const c = node(d, NodeType.CONVERTER);
  c.setCount(4); c.inputAmount = 2; c.outputColor = '#00ff00';
  const out = node(d, NodeType.POOL);
  const co = conn(d, c, out); co.rate = 1; co.colorFilter = '#ff00ff';
  steps(e, 1);
  assert(out.colorMap['#ff00ff'] >= 1, 'legacy converter respects per-connection override color');
  assert(!out.colorMap['#00ff00'], 'node outputColor not used when connection overrides');
});

test('recipe survives JSON round-trip and is omitted when empty', () => {
  const { d } = setup();
  const c = node(d, NodeType.CONVERTER);
  // Empty recipe omitted from JSON
  const j1 = JSON.parse(JSON.stringify(d.toJSON()));
  const cj1 = j1.nodes.find(n => n.id === c.id);
  assert(cj1.inputRecipe === undefined, 'empty inputRecipe omitted from JSON');

  // Non-empty recipe round-trips
  c.inputRecipe = [{ color: '#ff0000', amount: 3 }, { color: '#00ff00', amount: 1 }];
  const j2 = JSON.parse(JSON.stringify(d.toJSON()));
  const d2 = new Diagram(); d2.loadJSON(j2);
  const c2 = d2.nodes.get(c.id);
  assert(Array.isArray(c2.inputRecipe), 'inputRecipe is an array after round-trip');
  eq(c2.inputRecipe.length, 2, 'recipe length preserved');
  eq(c2.inputRecipe[0].color, '#ff0000', 'first ingredient color preserved');
  eq(c2.inputRecipe[0].amount, 3, 'first ingredient amount preserved');
  eq(c2.inputRecipe[1].color, '#00ff00', 'second ingredient color preserved');
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

test('deterministic gate remainder never lands on a zero-weight output', () => {
  const { d, e } = setup();
  const g = node(d, NodeType.GATE); g.setCount(4); g.gateMode = 'deterministic';
  const p0 = node(d, NodeType.POOL);
  const p1 = node(d, NodeType.POOL);
  const p2 = node(d, NodeType.POOL);
  conn(d, g, p0).weight = 0;
  conn(d, g, p1).weight = 2;
  conn(d, g, p2).weight = 3;
  steps(e, 1);
  eq(p0.resources, 0, 'zero-weight output routes nothing');
  eq(p1.resources + p2.resources, 4, 'all units routed to the weighted outputs');
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

test('delay in-flight resources survive a JSON round-trip and still release', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.setCount(2);
  const dl = node(d, NodeType.DELAY); dl.delay = 3;
  const b = node(d, NodeType.POOL);
  conn(d, a, dl).rate = 2;
  conn(d, dl, b).rate = 2;
  e.reset();
  e.doStep(); // the 2 units are now in flight inside the delay
  eq(d.nodes.get(dl.id).resources, 2, 'delay holds the units');

  // Saving keeps the node's counts but not its _queue; reset() must rebuild
  // the in-flight batch or the units would sit in the node forever.
  const d2 = new Diagram();
  d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  const e2 = new SimEngine(d2);
  e2.reset();
  for (let i = 0; i < 10; i++) e2.doStep();
  eq(d2.nodes.get(b.id).resources, 2, 'units arrive downstream after the round-trip');
  eq(d2.nodes.get(dl.id).resources, 0, 'delay drained');
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

test('a mid-run save keeps the authored colour mix when the total is unchanged', () => {
  // The amount and the colour mix drift independently. Gating the map write on
  // the amount meant a balanced loop (income and spend at matching rates) never
  // recorded either, so the reload rebased the authored mix to whatever was in
  // transit and any colour filter keyed on the authored colour drew from less
  // than the model says it holds.
  const ORANGE = '#ffa726', GREEN = '#4caf50';
  const d = new Diagram();
  const gold = new MNode(NodeType.POOL, 200, 100); gold.label = 'Gold'; gold.setCount(20, ORANGE);
  const mine = new MNode(NodeType.SOURCE, 0, 100); mine.label = 'Mine'; mine.resourceColor = GREEN;
  const spend = new MNode(NodeType.DRAIN, 400, 100); spend.label = 'Spend';
  d.addNode(gold); d.addNode(mine); d.addNode(spend);
  d.addConnection(new MConnection(mine.id, gold.id, ConnectionType.RESOURCE));
  d.addConnection(new MConnection(gold.id, spend.id, ConnectionType.RESOURCE));

  const e = new SimEngine(d); e.reset();
  for (let i = 0; i < 6; i++) e.doStep();
  eq(gold.resources, 20, 'the balanced loop leaves the total untouched');
  assert(gold.colorMap[GREEN] > 0, 'but the mix has drifted');

  const back = new Diagram(); back.loadJSON(d.toJSON());
  const g2 = [...back.nodes.values()].find(n => n.label === 'Gold');
  const e2 = new SimEngine(back); e2.reset();
  eq(g2.colorMap[ORANGE], 20, 'reset after reload restores the authored colour');
  eq(g2.colorMap[GREEN], undefined, 'and holds none of what was in transit');
});

test('an at-rest diagram still writes no baseline fields', () => {
  // The point of the guard: files that never ran stay byte-identical.
  const d = new Diagram();
  const p = new MNode(NodeType.POOL, 0, 0); p.label = 'Gold'; p.setCount(20, '#ffa726');
  const s = new MNode(NodeType.SOURCE, 100, 0); s.label = 'Mine';
  d.addNode(p); d.addNode(s);
  d.addConnection(new MConnection(s.id, p.id, ConnectionType.RESOURCE));
  const before = JSON.stringify(d.toJSON());
  assert(!/initial(Resources|ColorMap)/.test(before), 'no baseline fields at rest');
  const e = new SimEngine(d); e.reset();
  eq(JSON.stringify(d.toJSON()), before, 'reset() alone changes nothing on disk');
});

test('a trader cannot pay out of a delay or a queue', () => {
  // Their contents are mirrored by an internal queue that releases on its own
  // schedule. takeResources would draw the count down and leave that queue
  // intact, handing the same units to the partner and releasing them again:
  // resources created from nothing, every step.
  const qlen = (n) => (n._queue ? n._queue.reduce((s, b) => s + b.amount, 0) : 0)
    + (n._fifo ? n._fifo.reduce((s, b) => s + b.amount, 0) : 0);

  for (const partnerType of [NodeType.DELAY, NodeType.QUEUE, NodeType.POOL]) {
    const d = new Diagram();
    const gold = new MNode(NodeType.POOL, 0, 0); gold.label = 'Gold'; gold.setCount(20);
    const mkt = new MNode(NodeType.TRADER, 200, 0); mkt.label = 'Market';
    const ship = new MNode(partnerType, 400, 0); ship.label = 'Shipping'; ship.setCount(5);
    const spent = new MNode(NodeType.DRAIN, 600, 0); spent.label = 'Spent';
    d.addNode(gold); d.addNode(mkt); d.addNode(ship); d.addNode(spent);
    d.addConnection(new MConnection(gold.id, mkt.id, ConnectionType.RESOURCE));
    d.addConnection(new MConnection(mkt.id, ship.id, ConnectionType.RESOURCE));
    d.addConnection(new MConnection(ship.id, spent.id, ConnectionType.RESOURCE));

    const e = new SimEngine(d); e.reset();
    const conserved = () => gold.resources + ship.resources + (spent.drained || 0);
    const start = conserved();
    for (let i = 0; i < 12; i++) e.doStep();
    eq(conserved(), start, `${partnerType} partner: nothing is created or destroyed`);
    if (partnerType !== NodeType.POOL) {
      eq(qlen(ship), ship.resources, `${partnerType} partner: queue agrees with the count`);
    }
  }
});

test('a Monte Carlo batch leaves a paused seeded run where it found it', () => {
  // Batch Analysis stops the live run but does not reset it, so the run resumes
  // on the shared RNG. Every trial reseeds that RNG and the batch used to clear
  // it back to Math.random, so a paused seeded run silently finished its
  // remaining steps unseeded and unreproducible.
  const build = () => {
    const d = new Diagram();
    d.seed = 'live-42';
    const src = new MNode(NodeType.SOURCE, 0, 0); src.label = 'Mine';
    const pool = new MNode(NodeType.POOL, 200, 0); pool.label = 'Gold';
    d.addNode(src); d.addNode(pool);
    const c = new MConnection(src.id, pool.id, ConnectionType.RESOURCE);
    c.rateMode = RateMode.DICE; c.dice = '2d6';
    d.addConnection(c);
    return { d, pool };
  };

  // Reference: a seeded run of 20 steps, uninterrupted.
  const a = build();
  const ea = new SimEngine(a.d); ea.reset();
  for (let i = 0; i < 20; i++) ea.doStep();
  const want = a.pool.resources;

  for (const batchSeed of ['mc-seed', null]) {
    const b = build();
    const eb = new SimEngine(b.d); eb.reset();
    for (let i = 0; i < 10; i++) eb.doStep();
    eb.runMonteCarlo(5, 8, { seed: batchSeed });
    for (let i = 0; i < 10; i++) eb.doStep();
    eq(b.pool.resources, want,
      `batch seed ${batchSeed}: the paused run resumes on its own seeded stream`);
  }
});

test('detectLoops finds a ring economy longer than ten nodes', () => {
  // The depth limit was 10, so a 12-stage production ring - one loop and
  // nothing else - enumerated no cycles at all and the Loops panel reported
  // "No feedback loops found" for a diagram that is entirely one loop.
  const ring = (n) => {
    const d = new Diagram();
    const ns = [];
    for (let i = 0; i < n; i++) {
      const p = new MNode(NodeType.POOL, i * 60, 0); p.label = 'Stage' + (i + 1);
      p.setCount(5); d.addNode(p); ns.push(p);
    }
    for (let i = 0; i < n; i++) {
      d.addConnection(new MConnection(ns[i].id, ns[(i + 1) % n].id, ConnectionType.RESOURCE));
    }
    return d;
  };
  for (const n of [12, 20, 30]) {
    const { loops, truncated } = detectLoops(ring(n));
    eq(loops.length, 1, `${n}-stage ring: exactly one cycle`);
    eq(loops[0].nodes.length, n, `${n}-stage ring: the whole ring`);
    eq(loops[0].type, 'F', `${n}-stage ring: a pure resource circulation`);
    eq(truncated, false, `${n}-stage ring: search was not cut short`);
  }
  // Past the limit the caller is told the search stopped early rather than
  // being handed a bare empty list.
  const big = detectLoops(ring(40));
  eq(big.loops.length, 0, 'a 40-stage ring is past the depth limit');
  eq(big.truncated, true, 'and reports that the search was truncated');
});

test('a delay or queue releases its authored starting stock without a Reset first', () => {
  // _queue/_fifo were only ever built in reset(), but the app's Run and Step
  // buttons do not reset: they bootstrap at step 0 with saveInitial() alone. So
  // a freshly authored delay held its stock forever, releasing nothing.
  for (const kind of [NodeType.DELAY, NodeType.QUEUE]) {
    const d = new Diagram();
    const belt = new MNode(kind, 0, 0); belt.label = 'Belt';
    belt.delay = 2; belt.processTime = 2; belt.servers = 4;
    belt.setCount(10, '#8d6e63');
    const out = new MNode(NodeType.POOL, 200, 0); out.label = 'Out';
    d.addNode(belt); d.addNode(out);
    const c = new MConnection(belt.id, out.id, ConnectionType.RESOURCE); c.rate = 99;
    d.addConnection(c);

    const e = new SimEngine(d); // deliberately NO reset(), like pressing Run
    for (let i = 0; i < 30; i++) e.doStep();
    eq(out.resources, 10, `${kind}: the starting stock reaches the output`);
    eq(belt.resources, 0, `${kind}: nothing is stranded in the node`);
  }
});

test('setLiveCount moves a delay or queue pipeline, not just the count', () => {
  // The properties panel's Amount field and +/- steppers reach for the model
  // primitives, which write `resources` and leave `_queue`/`_fifo` owing the old
  // amount: the node then releases units it no longer has (created from
  // nothing), or keeps ones nothing will ever release. Same hazard as the
  // trader guard, at the panel's call site.
  const pipeline = (n) => (n._queue || []).reduce((s, b) => s + b.amount, 0)
    + (n._fifo || []).reduce((s, b) => s + b.amount, 0) + (n._procs || []).length;

  for (const kind of [NodeType.DELAY, NodeType.QUEUE]) {
    for (const [nudge, want] of [[-3, 7], [3, 13]]) {
      const d = new Diagram();
      const belt = new MNode(kind, 0, 0); belt.label = 'Belt';
      belt.delay = 4; belt.processTime = 4; belt.servers = 4;
      belt.setCount(10, '#8d6e63');
      const out = new MNode(NodeType.POOL, 200, 0); out.label = 'Out';
      d.addNode(belt); d.addNode(out);
      const c = new MConnection(belt.id, out.id, ConnectionType.RESOURCE); c.rate = 99;
      d.addConnection(c);

      const e = new SimEngine(d); e.reset();
      e.doStep(); e.doStep(); // everything is in transit inside the node
      eq(pipeline(belt), belt.resources, `${kind}: pipeline agrees before the edit`);
      for (let k = 0; k < Math.abs(nudge); k++) {
        e.setLiveCount(belt, belt.resources + Math.sign(nudge), '#8d6e63');
      }
      eq(belt.resources, want, `${kind} ${nudge}: the count follows the edit`);
      eq(pipeline(belt), belt.resources, `${kind} ${nudge}: pipeline follows too`);
      for (let i = 0; i < 60; i++) e.doStep();
      eq(belt.resources + out.resources, want,
        `${kind} ${nudge}: nothing created or stranded over the whole run`);
    }
  }
});

test('.econ round-trip survives a node labelled with a DSL head keyword', () => {
  // dslParse dispatches on tokens[0] before scanning for an arrow, so a node
  // labelled `pool` that is the SOURCE of a connection emitted `pool -> Gold`
  // and was read back as a declaration. Most heads threw on reload; `economy`
  // and `assert` matched their handlers and dropped the connection silently.
  const HEADS = ['economy', 'meta', 'param', 'type', 'var', 'assert', 'player',
    'group', 'note', 'chart', 'pool', 'source', 'drain', 'gate', 'converter',
    'register', 'delay', 'queue', 'trader'];
  for (const kw of HEADS) {
    const d = new Diagram();
    const a = new MNode(NodeType.POOL, 100, 100); a.label = kw;
    const b = new MNode(NodeType.POOL, 400, 100); b.label = 'Gold';
    d.addNode(a); d.addNode(b);
    d.addConnection(new MConnection(a.id, b.id, ConnectionType.RESOURCE));
    const back = new Diagram();
    back.loadJSON(dslParse(dslSerialize(d.toJSON())));
    eq(back.nodes.size, 2, `label "${kw}": both nodes survive`);
    eq(back.connections.size, 1, `label "${kw}": the connection survives`);
  }

  // An ordinary label must still serialize bare, not newly quoted.
  const d = new Diagram();
  const a = new MNode(NodeType.POOL, 0, 0); a.label = 'Gold';
  const b = new MNode(NodeType.POOL, 100, 0); b.label = 'Silver';
  d.addNode(a); d.addNode(b);
  d.addConnection(new MConnection(a.id, b.id, ConnectionType.RESOURCE));
  assert(/(^|\n)Gold -> Silver/.test(dslSerialize(d.toJSON())), 'ordinary labels stay unquoted');
});

test('attribution reports trader swaps between the partners, not through the trader', () => {
  // _fireTrader books what A pays under the INCOMING leg and what B pays under
  // the OUTGOING one, so reading direction off sourceId/targetId called B's
  // payment income, never credited either side with what it received, and gave
  // the trader two rows for resources it never held. Asymmetric rates so the
  // two legs cannot cancel and hide the error.
  const d = new Diagram();
  const A = new MNode(NodeType.POOL, 0, 0);   A.label = 'A'; A.setCount(50);
  const B = new MNode(NodeType.POOL, 400, 0); B.label = 'B'; B.setCount(50);
  const T = new MNode(NodeType.TRADER, 200, 0); T.label = 'Market';
  d.addNode(A); d.addNode(B); d.addNode(T);
  const cin = new MConnection(A.id, T.id, ConnectionType.RESOURCE);  cin.rate = 3;
  const cout = new MConnection(T.id, B.id, ConnectionType.RESOURCE); cout.rate = 1;
  d.addConnection(cin); d.addConnection(cout);

  const e = new SimEngine(d); e.reset();
  for (let i = 0; i < 3; i++) e.doStep();
  const last = e.history.length - 1;

  const ra = attributeChange(d, e.history, A.id, last);
  eq(ra.residual, 0, 'A: every unit accounted for');
  const aOut = ra.entries.find(x => x.kind === 'flow out');
  const aIn = ra.entries.find(x => x.kind === 'flow in');
  eq(aOut.amount, -3, 'A paid 3 out');
  eq(aIn.amount, 1, 'A received 1 back');
  assert(/B/.test(aOut.label) && /B/.test(aIn.label), 'A trades with B, not with the trader');

  const rb = attributeChange(d, e.history, B.id, last);
  eq(rb.residual, 0, 'B: every unit accounted for');
  eq(rb.entries.find(x => x.kind === 'flow out').amount, -1, 'B paid 1 out, not received');
  eq(rb.entries.find(x => x.kind === 'flow in').amount, 3, 'B received 3');

  const rt = attributeChange(d, e.history, T.id, last);
  eq(rt.entries.length, 0, 'the trader holds nothing, so it gets no flow rows');
});

test('.econ round-trip keeps a limited source colored stock', () => {
  // dslSerialize writes the stock as `= N of color`, but the parser skipped the
  // colorMap for sources, so reconcile() refilled it as untyped grey. Any
  // outgoing colorFilter then matched nothing and the run changed completely.
  const ORE = '#8d6e63';
  const build = () => {
    const d = new Diagram();
    const s = new MNode(NodeType.SOURCE, 100, 100); s.label = 'Mine';
    s.limited = true; s.resourceColor = ORE; s.setCount(20, ORE);
    const p = new MNode(NodeType.POOL, 400, 100); p.label = 'Store';
    d.addNode(s); d.addNode(p);
    const c = new MConnection(s.id, p.id, ConnectionType.RESOURCE);
    c.colorFilter = ORE;
    d.addConnection(c);
    return d;
  };
  const back = new Diagram();
  back.loadJSON(dslParse(dslSerialize(build().toJSON())));
  const s2 = [...back.nodes.values()].find(n => n.type === NodeType.SOURCE);
  eq(s2.colorMap[ORE], 20, 'colored stock survives the round-trip');

  const run = (d) => {
    const e = new SimEngine(d); e.reset();
    for (let i = 0; i < 10; i++) e.doStep();
    return [...d.nodes.values()].find(n => n.label === 'Store').resources;
  };
  eq(run(back), run(build()), 'the round-tripped diagram simulates identically');
});

test('.econ round-trip leaves an unlimited source unstocked', () => {
  // The guard that caused the bug above was load-bearing: `limited` can appear
  // later on the line, and an unlimited source has its stock zeroed afterwards.
  // Restoring the colorMap must not give an unlimited source a phantom stock.
  const d = new Diagram();
  const u = new MNode(NodeType.SOURCE, 0, 0); u.label = 'Inf'; u.resourceColor = '#8d6e63';
  d.addNode(u);
  const back = new Diagram();
  back.loadJSON(dslParse(dslSerialize(d.toJSON())));
  const u2 = [...back.nodes.values()][0];
  eq(u2.limited, false, 'still unlimited');
  eq(Object.keys(u2.colorMap).length, 0, 'no stale colorMap');

  // Same for hand-written .econ that gives an unlimited source an amount.
  const hand = new Diagram();
  hand.loadJSON(dslParse('source X @ 0,0 = 20 of "#8d6e63"\n'));
  const h = [...hand.nodes.values()][0];
  eq(Object.keys(h.colorMap).length, 0, 'hand-written unlimited source keeps no stock');
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

// ── Gap tests: queue balk / renege / loss conservation ──────────────────────
// The waiting-line cap (maxLine) and patience (renege) paths were untested.
// They are loss paths, so the key invariant is conservation: every unit that
// arrives is either served, balked, reneged, or still in the system.

test('queue balks arrivals when the waiting line is full', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  // Slow server, tiny line: the line fills and stays full, so most arrivals balk.
  const q = node(d, NodeType.QUEUE); q.processTime = 5; q.servers = 1; q.maxLine = 2;
  const dr = node(d, NodeType.DRAIN);
  conn(d, s, q).rate = 3;     // 3 arrive/step, far more than the line + server absorb
  conn(d, q, dr).rate = 1;
  steps(e, 10);
  assert(q.balked > 0, `arrivals are turned away at the full line (got ${q.balked})`);
  // The line never exceeds its cap.
  assert(q.maxLen <= 2, `waiting line never exceeds maxLine (got ${q.maxLen})`);
});

test('queue balk conserves units: arrived = served + balked + in-system', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 4; q.servers = 1; q.maxLine = 2;
  const dr = node(d, NodeType.DRAIN);
  const inConn = conn(d, s, q); inConn.rate = 3;
  conn(d, q, dr).rate = 1;
  const N = 12;
  steps(e, N);
  // A fixed-rate source emits `rate` every step it fires (N steps).
  const arrived = inConn.rate * N;
  const accounted = dr.drained + q.balked + q.resources;
  eq(accounted, arrived,
    `served(${dr.drained}) + balked(${q.balked}) + in-system(${q.resources}) = arrived(${arrived})`);
});

test('queue reneges units that wait past their patience', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  // One slow server, no line cap, short patience: units that pile up behind the
  // server give up before they ever reach it.
  const q = node(d, NodeType.QUEUE); q.processTime = 6; q.servers = 1; q.patience = 2;
  const dr = node(d, NodeType.DRAIN);
  conn(d, s, q).rate = 3;
  conn(d, q, dr).rate = 1;
  steps(e, 12);
  assert(q.reneged > 0, `impatient units leave the line (got ${q.reneged})`);
});

test('queue with infinite patience never reneges', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 6; q.servers = 1; q.patience = 0;
  const dr = node(d, NodeType.DRAIN);
  conn(d, s, q).rate = 3;
  conn(d, q, dr).rate = 1;
  steps(e, 12);
  eq(q.reneged, 0, 'patience 0 means infinite patience — nobody gives up');
});

test('queue renege conserves units: arrived = served + reneged + in-system', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE); q.processTime = 5; q.servers = 1; q.patience = 3;
  const dr = node(d, NodeType.DRAIN);
  const inConn = conn(d, s, q); inConn.rate = 2;
  conn(d, q, dr).rate = 1;
  const N = 14;
  steps(e, N);
  const arrived = inConn.rate * N;
  const accounted = dr.drained + q.reneged + q.resources;
  eq(accounted, arrived,
    `served(${dr.drained}) + reneged(${q.reneged}) + in-system(${q.resources}) = arrived(${arrived})`);
});

test('queue with both a line cap and patience conserves across all loss paths', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const q = node(d, NodeType.QUEUE);
  q.processTime = 5; q.servers = 1; q.maxLine = 3; q.patience = 4;
  const dr = node(d, NodeType.DRAIN);
  const inConn = conn(d, s, q); inConn.rate = 4;
  conn(d, q, dr).rate = 1;
  const N = 16;
  steps(e, N);
  const arrived = inConn.rate * N;
  const accounted = dr.drained + q.balked + q.reneged + q.resources;
  eq(accounted, arrived,
    `served(${dr.drained}) + balked(${q.balked}) + reneged(${q.reneged}) + in-system(${q.resources}) = arrived(${arrived})`);
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

test('deleting a param or variable takes it out of the shared store', () => {
  const { d, e } = setup();
  d.params['boost'] = 5;
  d.customVars = [{ name: 'jitter', kind: 'array', values: [2], dist: 'uniform', update: 'step', value: 2 }];
  const src = node(d, NodeType.SOURCE);
  const pool = node(d, NodeType.POOL);
  const c = conn(d, src, pool); c.rateMode = RateMode.FORMULA; c.formula = 'boost + jitter';
  steps(e, 3);
  eq(pool.resources, 21, '7 per step while both are defined');

  // The user deletes both mid-run. Variables commit at the end of a tick
  // (CONCEPTS.md "one-step lag"), so the step already in flight still sees the
  // old values and everything after it sees nothing.
  delete d.params['boost'];
  d.customVars = [];
  e.doStep();
  eq('boost' in d.variables, false, 'deleted param dropped from the store');
  eq('jitter' in d.variables, false, 'deleted variable dropped from the store');
  e.doStep(); e.doStep();
  eq(pool.resources, 28, 'flow stops once the lagged step has passed');
});

test('renaming a param does not leave the old name resolvable', () => {
  const { d, e } = setup();
  d.params['rate_a'] = 3;
  const src = node(d, NodeType.SOURCE);
  const pool = node(d, NodeType.POOL);
  const c = conn(d, src, pool); c.rateMode = RateMode.FORMULA; c.formula = 'rate_a';
  steps(e, 1);
  eq(d.variables['rate_a'], 3, 'old name live before the rename');
  d.params = { rate_b: 3 };
  e.doStep();
  eq('rate_a' in d.variables, false, 'old name gone, so a stale formula cannot silently keep working');
  eq(d.variables['rate_b'], 3, 'new name live');
});

test('pruning the store leaves live register labels alone', () => {
  const { d, e } = setup();
  const pool = node(d, NodeType.POOL); pool.label = 'Gold'; pool.setCount(4);
  const reg = node(d, NodeType.REGISTER); reg.label = 'Score'; reg.formula = 'gold * 2';
  conn(d, pool, reg, ConnectionType.STATE).variableName = 'gold';
  steps(e, 2);
  eq(d.variables['Score'], 8, 'register publishes under its own label');
  e.doStep();
  eq(d.variables['Score'], 8, 'and survives the prune on later steps');

  // A register that is removed should still fall out of the store.
  d.removeNode(reg.id);
  e.doStep();
  eq('Score' in d.variables, false, 'deleted register label pruned');
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

// ── Run seed (reproducible live runs) ────────────────────────────────────────
console.log('\nRun seed');

// A stochastic source→pool whose per-step dice rate draws from SimRandom. Return
// the full per-step trace so two runs are compared trajectory-by-trajectory — a
// single final value can collide by chance, a 30-long trace effectively cannot.
function seededTrace(seed, n = 30) {
  const { d, e } = setup();
  d.seed = seed;
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p); c.rateMode = RateMode.DICE; c.dice = '3d6';
  e.reset(); // applies d.seed to SimRandom
  const trace = [];
  for (let i = 0; i < n; i++) { e.doStep(); trace.push(p.resources); }
  return trace.join(',');
}

test('a run seed makes a stochastic run reproducible', () => {
  eq(seededTrace('abc'), seededTrace('abc'), 'same seed → identical trace');
});

test('different seeds produce different traces', () => {
  assert(seededTrace('abc') !== seededTrace('xyz'), 'distinct seeds → distinct traces');
});

// Formula randomness must draw from SimRandom too — math.js's own random
// functions are Math.random-backed and would break seeded reproducibility.
function formulaTrace(seed, n = 10) {
  const { d, e } = setup();
  d.seed = seed;
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p); c.rateMode = RateMode.FORMULA; c.formula = 'randomInt(1,100)';
  e.reset();
  const trace = [];
  for (let i = 0; i < n; i++) { e.doStep(); trace.push(p.resources); }
  SimRandom.seed(null);
  return trace.join(',');
}

test('a randomInt() formula rate is reproducible under the run seed', () => {
  eq(formulaTrace('abc'), formulaTrace('abc'), 'same seed → identical trace');
  assert(formulaTrace('abc') !== formulaTrace('xyz'), 'distinct seeds → distinct traces');
});

test('random()/pickRandom() in formulas draw from the seeded stream too', () => {
  SimRandom.seed('f2');
  const a = [evalFormula('random()'), evalFormula('random(5,10)'), evalFormula('pickRandom([10,20,30])')];
  SimRandom.seed('f2');
  const b = [evalFormula('random()'), evalFormula('random(5,10)'), evalFormula('pickRandom([10,20,30])')];
  SimRandom.seed(null);
  eq(a.join(','), b.join(','), 'same seed → identical formula draws');
  assert(a[1] >= 5 && a[1] < 10, 'random(min,max) stays in range');
  assert([10, 20, 30].includes(a[2]), 'pickRandom returns a list element');
});

test('legacy-fallback formulas (Math.random) are seeded as well', () => {
  // math.js cannot evaluate `Math.*`, so this takes the Function fallback,
  // where the shadowed Math draws from SimRandom.
  SimRandom.seed('legacy');
  const a = [evalFormula('Math.round(Math.random()*1000)'), evalFormula('Math.round(Math.random()*1000)')];
  SimRandom.seed('legacy');
  const b = [evalFormula('Math.round(Math.random()*1000)'), evalFormula('Math.round(Math.random()*1000)')];
  SimRandom.seed(null);
  eq(a.join(','), b.join(','), 'same seed → identical legacy draws');
});

test('an empty seed leaves the RNG on Math.random', () => {
  // With the seed cleared, reset() must restore Math.random so stubs still work.
  SimRandom.seed('leftover');           // simulate a seed left by a prior batch
  let v;
  withRandom(0.5, () => {
    const { d, e } = setup();           // d.seed === '' by default
    const s = node(d, NodeType.SOURCE);
    const p = node(d, NodeType.POOL);
    const c = conn(d, s, p); c.rateMode = RateMode.DICE; c.dice = '1d6';
    steps(e, 1);                        // reset() → SimRandom.seed(null)
    v = p.resources;
  });
  SimRandom.seed(null);
  eq(v, 4, 'floor(0.5*6)+1 = 4 from the stubbed Math.random');
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

test('run seed survives JSON round-trip and is omitted when empty', () => {
  const { d } = setup();
  assert(d.toJSON().seed === undefined, 'empty seed omitted from JSON');
  d.seed = 'level-42';
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  eq(json.seed, 'level-42', 'seed serialized when set');
  const d2 = new Diagram(); d2.loadJSON(json);
  eq(d2.seed, 'level-42', 'seed restored on load');
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
  assert(json.seed === undefined, 'empty seed omitted');
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

test('a huge dice count is capped and returns promptly', () => {
  const t0 = Date.now();
  const v = rollDice('999999999d6');
  assert(Date.now() - t0 < 1000, 'rollDice returns promptly');
  assert(v >= 10000 && v <= 60000, `sum bounded by the 10000-dice cap (got ${v})`);
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

// ── Gap tests: gate inside a feedback loop ──────────────────────────────────
// A gate's output drives an activator back onto its own upstream source, so the
// loop closes THROUGH the gate. This exercises gate routing + activator gating
// + the engine's one-step variable lag together — a combination none of the
// split-mode gate tests cover.

test('gate feedback loop throttles its source once the sink fills (all mode)', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const g = node(d, NodeType.GATE); g.gateMode = 'all';
  const p = node(d, NodeType.POOL);
  conn(d, s, g).rate = 2;
  conn(d, g, p).rate = 2;
  // Activator: source may fire only while pool < 5.
  const act = conn(d, p, s, ConnectionType.STATE);
  act.activator = true; act.actOperator = '<'; act.actValue = 5;
  e.reset();
  for (let i = 0; i < 30; i++) e.doStep();
  // The loop bounds PRODUCTION (the source freezes once the sink crosses the
  // threshold). In-flight units still drain out of the gate afterward, so the
  // pool settles at total production — not at the activator threshold.
  const settled = s.produced;
  assert(settled <= 14, `production is bounded by the feedback loop (got ${settled})`);
  eq(p.resources, settled, 'every produced unit eventually lands in the bounded pool');
  // Run further: nothing changes once the loop has shut the source off.
  for (let i = 0; i < 10; i++) e.doStep();
  eq(s.produced, settled, 'production stays frozen — the loop holds');
});

test('gate feedback respects one-step lag: activator reads the prior step', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const g = node(d, NodeType.GATE); g.gateMode = 'all';
  const p = node(d, NodeType.POOL);
  conn(d, s, g).rate = 2;
  conn(d, g, p).rate = 2;
  const act = conn(d, p, s, ConnectionType.STATE);
  act.activator = true; act.actOperator = '<'; act.actValue = 5;
  e.reset();
  // Step the loop to exactly the point the threshold is crossed. Because the
  // activator reads the previous step's pool value, the source fires one extra
  // time AFTER the sink reaches the threshold — the documented one-step lag.
  for (let i = 0; i < 6; i++) e.doStep();
  eq(p.resources, 5, 'pool reaches the threshold');
  eq(s.produced, 12, 'source produced through the crossing step (lag), not before');
  e.doStep();
  eq(s.produced, 12, 'source is now disabled — no further production');
});

test('gate feedback loop conserves what the source emitted (no leak through the gate)', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const g = node(d, NodeType.GATE); g.gateMode = 'all';
  const p = node(d, NodeType.POOL);
  conn(d, s, g).rate = 2;
  conn(d, g, p).rate = 2;
  const act = conn(d, p, s, ConnectionType.STATE);
  act.activator = true; act.actOperator = '<'; act.actValue = 5;
  e.reset();
  for (let i = 0; i < 12; i++) e.doStep();
  // Everything the source emitted is either sitting in the gate or in the pool —
  // the gate neither created nor destroyed resources in the loop.
  eq(g.resources + p.resources, s.produced,
    `in-gate(${g.resources}) + in-pool(${p.resources}) = produced(${s.produced})`);
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

test('history stays uniformly spaced across decimations (no post-doubling gaps)', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  conn(d, s, p).rate = 1;
  e.reset();
  for (let i = 0; i < 1300; i++) e.doStep();
  const st = e.history.map(h => h.step);
  // After each doubling the retained snapshots must stay on the new stride's
  // grid, so recording continues seamlessly — every gap equals the stride.
  for (let i = 1; i < st.length; i++)
    eq(st[i] - st[i - 1], e._histStride, `uniform spacing at #${i} (${st[i - 1]}→${st[i]})`);
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
  eq(e.history.length, 5, 'history truncated to checkpoint (step-0 baseline + 4 steps)');

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

test('captureState/restoreState replays a seeded run identically (RNG position)', () => {
  const { d, e } = setup();
  d.seed = 'fork';
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL);
  const c = conn(d, s, p);
  c.rateMode = RateMode.DICE; c.dice = '2d6';
  e.reset();
  for (let i = 0; i < 3; i++) e.doStep();
  const snap = e.captureState();
  const t1 = [];
  for (let i = 0; i < 2; i++) { e.doStep(); t1.push(d.nodes.get(p.id).resources); }
  e.restoreState(snap);
  const t2 = [];
  for (let i = 0; i < 2; i++) { e.doStep(); t2.push(d.nodes.get(p.id).resources); }
  SimRandom.seed(null);
  eq(t2.join(','), t1.join(','), 'post-restore trace matches the original branch');
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

// ── Synchronous conditions (tick-start snapshot) ────────────────────────────
console.log('\nSynchronous conditions');

test('activator result does not depend on node insertion order', () => {
  // A pull-mode drain empties P during the fire phase; a source gated by an
  // activator "P >= 5" must see P's tick-start value regardless of whether
  // the drain was inserted before or after it.
  const build = (drainFirst) => {
    const d = new Diagram();
    d.seed = 'sync-a';
    const p = node(d, NodeType.POOL); p.setCount(5);
    let dr, out;
    const mkDrain = () => { dr = node(d, NodeType.DRAIN); dr.flowMode = 'pull'; conn(d, p, dr).rate = 5; };
    const mkSource = () => {
      const s = node(d, NodeType.SOURCE);
      out = node(d, NodeType.POOL);
      conn(d, s, out).rate = 1;
      const a = conn(d, p, s, ConnectionType.STATE);
      a.activator = true; a.actOperator = '>='; a.actValue = 5;
    };
    if (drainFirst) { mkDrain(); mkSource(); } else { mkSource(); mkDrain(); }
    const e = new SimEngine(d);
    e.reset();
    const trace = [];
    for (let i = 0; i < 3; i++) { e.doStep(); trace.push([p.resources, out.resources, dr.drained].join('/')); }
    SimRandom.seed(null);
    return trace.join(' ');
  };
  const first = build(true), second = build(false);
  eq(first, second, 'both insertion orders produce the same trace');
  // Tick-start semantics: on step 1 P started at 5, so the source DOES fire
  // even though the drain empties P within that same tick.
  eq(first, '0/1/5 0/1/5 0/1/5', 'source fired exactly on the step P started at 5');
});

test('trace is invariant under node-array permutation (property test)', () => {
  // A nontrivial seeded diagram (source, pools, conditional gate feed, pull
  // drain, register, activator, trigger). Rebuilding it from the same JSON
  // with the nodes array permuted must yield a byte-identical trace.
  const d = new Diagram();
  d.seed = 'perm';
  const s = node(d, NodeType.SOURCE);
  const a = node(d, NodeType.POOL);
  conn(d, s, a).rate = 2;
  const g = node(d, NodeType.GATE);
  const toGate = conn(d, a, g); toGate.rate = 3;
  toGate.condEnabled = true; toGate.condOperator = '>='; toGate.condValue = 3;
  const b = node(d, NodeType.POOL);
  const c = node(d, NodeType.POOL);
  conn(d, g, b).weight = 2;
  conn(d, g, c).weight = 1;
  const dr = node(d, NodeType.DRAIN); dr.flowMode = 'pull';
  conn(d, b, dr).rate = 2;
  const r = node(d, NodeType.REGISTER); r.formula = 'cv * 2';
  conn(d, c, r, ConnectionType.STATE).variableName = 'cv';
  const s2 = node(d, NodeType.SOURCE);
  const e2 = node(d, NodeType.POOL);
  conn(d, s2, e2).rate = 1;
  const act = conn(d, b, s2, ConnectionType.STATE);
  act.activator = true; act.actOperator = '>='; act.actValue = 2;
  const f = node(d, NodeType.POOL); f.setCount(20); f.activation = ActivationMode.PASSIVE;
  conn(d, f, c).rate = 1;
  conn(d, s2, f, ConnectionType.STATE).trigger = true;

  const json = d.toJSON();
  const runWith = (permute) => {
    const j = JSON.parse(JSON.stringify(json));
    j.nodes = permute(j.nodes);
    const dg = new Diagram(); dg.loadJSON(j);
    const eng = new SimEngine(dg);
    eng.reset();
    const trace = [];
    for (let i = 0; i < 25; i++) {
      eng.doStep();
      trace.push([...dg.nodes.values()].sort((x, y) => x.id.localeCompare(y.id))
        .map(n => `${n.id}=${n.chartValue}`).join(','));
    }
    SimRandom.seed(null);
    return trace.join('\n');
  };
  // Deterministic permutations only (no Math.random in tests).
  const identity = runWith(ns => ns);
  const reversed = runWith(ns => ns.slice().reverse());
  const rotated = runWith(ns => ns.slice(3).concat(ns.slice(0, 3)));
  eq(reversed, identity, 'reversed node order gives an identical trace');
  eq(rotated, identity, 'rotated node order gives an identical trace');
});

test('trigger cascade reads live mid-step state (causal exception)', () => {
  // The drain empties P and triggers T within the same tick. T's activator
  // "P == 0" must see the live, post-pull value (a cascade is a causal
  // reaction inside the step), while an identical automatic node stored
  // after the drain checks the tick-start snapshot and stays put.
  const d = new Diagram();
  d.seed = 'sync-c';
  const p = node(d, NodeType.POOL); p.setCount(5);
  const dr = node(d, NodeType.DRAIN); dr.flowMode = 'pull';
  conn(d, p, dr).rate = 5;
  const t = node(d, NodeType.SOURCE); t.activation = ActivationMode.PASSIVE;
  const out1 = node(d, NodeType.POOL);
  conn(d, t, out1).rate = 1;
  const at = conn(d, p, t, ConnectionType.STATE);
  at.activator = true; at.actOperator = '=='; at.actValue = 0;
  conn(d, dr, t, ConnectionType.STATE).trigger = true;
  const t2 = node(d, NodeType.SOURCE);
  const out2 = node(d, NodeType.POOL);
  conn(d, t2, out2).rate = 1;
  const at2 = conn(d, p, t2, ConnectionType.STATE);
  at2.activator = true; at2.actOperator = '=='; at2.actValue = 0;
  const e = new SimEngine(d);
  e.reset();
  e.doStep();
  SimRandom.seed(null);
  eq(out1.resources, 1, 'cascade-fired node saw live P == 0 and fired');
  eq(out2.resources, 0, 'automatic node saw tick-start P = 5 and did not fire');
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

// ── Economy as code: .econ text format ──────────────────────────────────────
console.log('\nEconomy as code: .econ text format');

// A diagram exercising every serializable feature at once. Used by the
// round-trip tests; extend it whenever a new field is added to the model so
// the DSL keeps covering everything.
function kitchenSink() {
  const d = new Diagram();
  d.meta.name = 'Kitchen Sink';
  d.meta.description = 'Every feature.\nSecond line.';
  d.meta.scheme = 'ocean'; d.meta.bgColor = '#101318'; d.meta.font = 'Space Grotesk';
  d.seed = 'abc';
  d.timeMode = 'async';
  d.params = { mine_rate: 3, tax: 0.25 };
  d.resourceTypes = [{ name: 'Wood', color: '#8d6e63' }, { name: 'Iron Ore', color: '#b0bec5' }];
  d.customVars = [
    { name: 'luck', kind: 'dice', dice: '2d6', dist: 'gaussian', update: 'step', value: 0 },
    { name: 'span', kind: 'interval', min: 1, max: 10, dist: 'uniform', update: 'play', value: 0 },
    { name: 'pick', kind: 'array', values: [1, 2, 3], dist: 'uniform', update: 'step', value: 0 },
    { name: 'calc', kind: 'math', formula: 'gold * 2', dist: 'uniform', update: 'step', value: 0 },
  ];
  d.aiPlayer = { enabled: true, rules: [{ nodeId: 'x', every: 3, condVar: 'gold', condOp: '>', condVal: 5 }] };
  d.assertions = ['always Gold < 1000', 'eventually Score >= 0'];

  const mk = (t, x, y, label) => { const n = new MNode(t, x, y); n.label = label; return d.addNode(n); };
  const pool = mk(NodeType.POOL, 100, 100, 'Gold'); pool.setCount(50, '#ffd54f'); pool.capacity = 500;
  pool.endEnabled = true; pool.endOperator = '>='; pool.endValue = 400;
  const pool2 = mk(NodeType.POOL, 100, 200, 'Gold'); // duplicate label on purpose
  pool2.flowMode = 'pull'; pool2.pullPolicy = 'all'; pool2.activation = 'passive';
  const multi = mk(NodeType.POOL, 100, 300, 'Mixed Bag');
  multi.resources = 30; multi.colorMap = { '#ff0000': 10, '#00ff00': 20 };
  // A node caught mid-run: its live count and colours have drifted from the
  // reset baseline, which is the only state that serializes the baseline back.
  const drifted = mk(NodeType.POOL, 100, 400, 'Drifted');
  drifted.setCount(60, '#ffd54f');
  drifted.resources = 25; drifted.colorMap = { '#ffd54f': 25 };
  const src1 = mk(NodeType.SOURCE, 0, 100, 'Mine'); src1.resourceColor = '#8d6e63';
  const src2 = mk(NodeType.SOURCE, 0, 200, 'Well'); src2.limited = true; src2.resources = 40; src2.fireEvery = 3; src2.firePhase = 1;
  const drain = mk(NodeType.DRAIN, 300, 100, 'Spend');
  const gate = mk(NodeType.GATE, 300, 200, 'Split'); gate.gateMode = 'probabilistic';
  const conv = mk(NodeType.CONVERTER, 300, 300, 'Forge'); conv.inputAmount = 2;
  conv.inputRecipe = [{ color: '#8d6e63', amount: 2 }, { color: '#b0bec5', amount: 1 }];
  const reg = mk(NodeType.REGISTER, 500, 100, 'Score'); reg.formula = 'gold * 2 + luck';
  const reg2 = mk(NodeType.REGISTER, 500, 150, 'Manual'); reg2.value = 7;
  const delay = mk(NodeType.DELAY, 500, 200, 'Ship'); delay.delay = 4;
  const q = mk(NodeType.QUEUE, 500, 300, 'Desk'); q.processTime = 3; q.servers = 2; q.maxLine = 10; q.patience = 5;
  const trader = mk(NodeType.TRADER, 700, 100, 'Swap'); trader.activation = 'interactive';

  const c = (a, b, t) => d.addConnection(new MConnection(a.id, b.id, t));
  const c1 = c(src1, pool); c1.rate = 2; c1.interval = 3; c1.chance = 40;
  c1.condEnabled = true; c1.condOperator = 'between'; c1.condValue = 2; c1.condValue2 = 8;
  const c2 = c(pool, drain); c2.rateMode = RateMode.DICE; c2.dice = '2d6'; c2.colorFilter = '#ffd54f';
  const c3 = c(pool, gate); c3.rateMode = RateMode.FORMULA; c3.formula = 'mine_rate * 2';
  const c4 = c(gate, conv); c4.rateMode = RateMode.DISTRIBUTION; c4.distType = 'poisson'; c4.distParam1 = 3;
  c4.weight = 3; c4.pathStyle = 'ortho'; c4.bendPct = 0.3; c4.waypoints = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  const c5 = c(gate, delay); c5.weightFormula = 'luck * 2'; c5.labelT = 0.25; c5.label = 'lucky path';
  const c6 = c(pool, reg, ConnectionType.STATE); c6.variableName = 'gold';
  const c7 = c(reg, conv, ConnectionType.STATE); c7.activator = true; c7.actOperator = 'between'; c7.actValue = 1; c7.actValue2 = 99;
  const c8 = c(src1, trader, ConnectionType.STATE); c8.trigger = true; c8.triggerChance = 50; c8.triggerEvery = 2;
  const c9 = c(drain, pool2, ConnectionType.STATE); c9.reverseTrigger = true;
  const c10 = c(reg, pool2, ConnectionType.STATE); c10.modifier = true; c10.modMode = 'delta'; c10.modFactor = 2;
  const c11 = c(reg2, multi, ConnectionType.STATE); c11.modifier = true; c11.modFormula = 'round(score * 0.1)';
  const c12 = c(pool2, drain); c12.condEnabled = true; c12.condRefMode = 'variable'; c12.condVariable = 'gold';
  c12.condOperator = '>'; c12.condValue = 5; c12.cpDx = 10; c12.cpDy = -20;

  d.addGroup(Object.assign(new MGroup(50, 50, 400, 300), { label: 'Economy Core', color: '#7cb342' }));
  d.addNote(Object.assign(new MNote(600, 50), { text: 'Note with "quotes" and\nnewline' }));
  const ch = new MChart(700, 300); ch.label = 'Gold over time'; ch.nodeIds = [pool.id, pool2.id]; ch.chartType = 'area';
  d.addChart(ch);
  return d;
}

test('a mid-run save keeps the authored starting amount', () => {
  const d = new Diagram();
  const src = d.addNode(new MNode(NodeType.SOURCE, 0, 0)); src.label = 'Mine';
  const pool = d.addNode(new MNode(NodeType.POOL, 100, 0)); pool.label = 'Gold';
  pool.setCount(80, '#ffd54f');
  d.addConnection(new MConnection(src.id, pool.id, ConnectionType.RESOURCE)).rate = 1;

  // At rest the baseline and the live count agree, so nothing extra is written
  // and existing files keep their exact shape.
  const atRest = d.toJSON().nodes.find(n => n.label === 'Gold');
  eq(atRest.initialResources, undefined, 'no baseline field written at rest');
  eq(atRest.initialColorMap, undefined, 'no baseline colorMap written at rest');

  // Run a few steps, then serialize mid-run, exactly as autosave would.
  const e = new SimEngine(d);
  e.reset();
  for (let i = 0; i < 5; i++) e.doStep();
  assert(pool.resources !== 80, 'the live count actually moved');
  const saved = JSON.parse(JSON.stringify(d.toJSON()));
  const savedPool = saved.nodes.find(n => n.label === 'Gold');
  eq(savedPool.resources, pool.resources, 'live count still serialized as-is');
  eq(savedPool.initialResources, 80, 'authored baseline recorded alongside it');

  // Reload that file and reset: the run must return to the authored 80, not to
  // wherever the run happened to be when it was written.
  const d2 = new Diagram(); d2.loadJSON(saved);
  const pool2 = [...d2.nodes.values()].find(n => n.label === 'Gold');
  eq(pool2.resources, pool.resources, 'reopens showing the mid-run count');
  const e2 = new SimEngine(d2);
  e2.reset();
  eq(pool2.resources, 80, 'Reset returns to the authored starting amount');
  eq(pool2.colorMap['#ffd54f'], 80, 'and to the authored colours');
  eq(pool2.initialResources, undefined, 'no stray public field left on the node');
});

test('a file with no baseline field keeps the old meaning', () => {
  // Every diagram saved before this field existed: the live count IS the
  // baseline, so loading one must not change how it resets.
  const d = new Diagram();
  d.loadJSON({ nodes: [{ id: 'p1', type: 'pool', x: 0, y: 0, label: 'Gold',
    resources: 42, colorMap: { '#ffd54f': 42 }, capacity: null }], connections: [] });
  const p = d.nodes.get('p1');
  eq(p._initialResources, 42, 'baseline derived from the live count as before');
  const e = new SimEngine(d); e.reset();
  eq(p.resources, 42, 'resets to it');
});

test('kitchen-sink diagram round-trips through .econ text', () => {
  const json1 = kitchenSink().toJSON();
  const json2 = dslParse(dslSerialize(json1));
  const a = JSON.stringify(normalizeEconJSON(json1));
  const b = JSON.stringify(normalizeEconJSON(json2));
  eq(b, a, 'normalized JSON identical after text round trip');
});

test('serialize∘parse is a fixpoint on .econ text', () => {
  const t1 = dslSerialize(kitchenSink().toJSON());
  const t2 = dslSerialize(dslParse(t1));
  eq(t2, t1, 'second serialization byte-identical');
});

test('parsed .econ loads into a Diagram and simulates', () => {
  const json = dslParse([
    'name: Terse Mine',
    'param rate = 2',
    'source Mine @ 80,100',
    'pool Gold @ 240,100 goal >= 19',
    'drain Spend @ 400,100',
    'Mine -> Gold : (rate)',
    'Gold -> Spend : 1',
  ].join('\n'));
  const d = new Diagram(); d.loadJSON(json);
  const e = new SimEngine(d);
  e.reset();
  for (let i = 0; i < 50 && !e.ended; i++) e.doStep();
  assert(e.ended, 'goal reached');
  eq(e.ended.step, 18, 'net +1 per step after the first reaches 19 at step 18');
});

test('.econ sugar: recipes, types, colors, conditions, distributions', () => {
  const json = dslParse([
    'type Wood = #8d6e63',
    'source Lumber @ 0,0 color=Wood',
    'pool Store @ 100,0 = 5 of Wood cap=50',
    'converter Mill @ 200,0 recipe(2 Wood, 1 #b0bec5) out=#ffa726',
    'queue Line @ 300,0 time=3 servers=2',
    'Lumber -> Store : ~poisson(3, 2) 40% every=2 if="self < 40"',
    'Store -> Mill : 2d6 color=Wood',
  ].join('\n'));
  const src = json.nodes.find(n => n.label === 'Lumber');
  eq(src.resourceColor, '#8d6e63', 'type name resolved to color');
  const store = json.nodes.find(n => n.label === 'Store');
  eq(store.capacity, 50, 'cap alias');
  eq(store.colorMap['#8d6e63'], 5, 'start amount typed by name');
  const mill = json.nodes.find(n => n.label === 'Mill');
  eq(mill.inputRecipe.length, 2, 'recipe parsed');
  eq(mill.inputRecipe[0].color, '#8d6e63', 'recipe type name resolved');
  eq(mill.outputColor, '#ffa726', 'out alias');
  const line = json.nodes.find(n => n.label === 'Line');
  eq(line.processTime, 3, 'time alias'); eq(line.servers, 2, 'servers kept');
  const c1 = json.connections[0];
  eq(c1.rateMode, 'distribution', 'distribution rate');
  eq(c1.distType, 'poisson', 'dist type'); eq(c1.distParam1, 3, 'dist p1');
  eq(c1.chance, 40, 'percent token'); eq(c1.interval, 2, 'every alias');
  assert(c1.condEnabled, 'if enables condition'); eq(c1.condOperator, '<', 'cond op');
  const c2 = json.connections[1];
  eq(c2.rateMode, 'dice', 'dice rate'); eq(c2.colorFilter, '#8d6e63', 'color filter via type');
});

test('.econ duplicate labels disambiguate with #N and resolve back', () => {
  const d = new Diagram();
  const a = d.addNode(new MNode(NodeType.POOL, 0, 0)); a.label = 'Gold';
  const b = d.addNode(new MNode(NodeType.POOL, 10, 0)); b.label = 'Gold';
  d.addConnection(new MConnection(a.id, b.id));
  const text = dslSerialize(d.toJSON());
  assert(text.includes('Gold#2'), 'second Gold gets a #2 suffix');
  const back = dslParse(text);
  eq(back.connections[0].sourceId, back.nodes[0].id, 'first Gold resolved');
  eq(back.connections[0].targetId, back.nodes[1].id, '#2 resolved to second node');
});

test('.econ assert directive round-trips diagram assertions', () => {
  const json = dslParse([
    'source Mine @ 0,0', 'pool Gold @ 100,0',
    'Mine -> Gold : 2',
    'assert "always Gold < 100"',
    'assert eventually Gold >= 5', // unquoted remainder also accepted
  ].join('\n'));
  eq(json.assertions.length, 2, 'both assert lines parsed');
  eq(json.assertions[0], 'always Gold < 100', 'quoted form');
  eq(json.assertions[1], 'eventually Gold >= 5', 'bare form');
  const d = new Diagram(); d.loadJSON(json);
  eq(d.assertions.length, 2, 'Diagram carries assertions');
  const text = dslSerialize(d.toJSON());
  eq((text.match(/^assert /gm) || []).length, 2, 'serializer writes assert lines');
  eq(JSON.stringify(dslParse(text).assertions), JSON.stringify(json.assertions), 'assertions survive the round trip');
});

test('.econ parse errors carry the line number', () => {
  let threw = null;
  try { dslParse('pool A @ 0,0\n???'); } catch (e) { threw = e; }
  assert(threw, 'throws on garbage');
  eq(threw.line, 2, 'line number attached');
  assert(/line 2/.test(threw.message), 'message names the line');
  threw = null;
  try { dslParse('A -> B : 1'); } catch (e) { threw = e; }
  assert(threw && /unknown node reference/.test(threw.message), 'unknown ref reported');
});

// ── Economy as code: assertions ─────────────────────────────────────────────
console.log('\nEconomy as code: assertions');

function assertRig() {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.label = 'Mine';
  const p = node(d, NodeType.POOL); p.label = 'Gold Pool';
  conn(d, s, p).rate = 2;
  return { d, e, p };
}

function runChecked(e, srcs, steps) {
  const checker = new AssertionChecker(srcs.map(parseAssertion));
  e.reset();
  checker.check(e);
  for (let i = 0; i < steps && !e.ended; i++) { e.doStep(); checker.check(e); }
  return checker.finish(e);
}

test('parseAssertion understands every quantifier form', () => {
  eq(parseAssertion('always x > 1').quant, 'always', 'always');
  eq(parseAssertion('never x > 1').quant, 'never', 'never');
  eq(parseAssertion('eventually x > 1').quant, 'eventually', 'eventually');
  eq(parseAssertion('at end: x > 1').quant, 'end', 'at end');
  eq(parseAssertion('at step 25: x > 1').quant, 'step', 'at step');
  eq(parseAssertion('at step 25: x > 1').atStep, 25, 'step number');
  eq(parseAssertion('x > 1').quant, 'end', 'bare expression defaults to end');
  eq(parseAssertion('always: x > 1').expr, 'x > 1', 'optional colon');
  let threw = false;
  try { parseAssertion('always +++'); } catch { threw = true; }
  assert(threw, 'rejects an unparseable expression');
});

test('always reports the first violating step; never is its inverse', () => {
  const { e } = assertRig();
  const res = runChecked(e, ['always Gold_Pool < 5', 'never Gold_Pool >= 5'], 10);
  assert(!res[0].pass, 'always fails');
  eq(res[0].failStep, 3, 'first violation at step 3 (2/step: 6 >= 5)');
  assert(!res[1].pass, 'never fails at the same step');
  eq(res[1].failStep, 3, 'same step');
});

test('eventually, at end and at step semantics', () => {
  const { e } = assertRig();
  const res = runChecked(e, [
    'eventually Gold_Pool >= 10',
    'at end: Gold_Pool == 20',
    'at step 4: Gold_Pool == 8',
    'at step 99: Gold_Pool > 0',
    'Gold_Pool == 20',
  ], 10);
  assert(res[0].pass, 'eventually met');
  assert(/step 5/.test(res[0].detail), 'reports first-true step');
  assert(res[1].pass, 'at end true');
  assert(res[2].pass, 'at step 4 true');
  assert(!res[3].pass, 'step beyond run length fails');
  assert(/before step 99/.test(res[3].detail), 'explains the short run');
  assert(res[4].pass, 'bare expression checked at end');
});

test('assertion scope: sanitized labels, duplicates, variables, step', () => {
  const { d, e } = setup();
  const a = node(d, NodeType.POOL); a.label = 'My Gold!'; a.setCount(7);
  const b = node(d, NodeType.POOL); b.label = 'My Gold!'; b.setCount(3);
  d.params = { bonus: 5 };
  e.reset();
  const scope = assertionScope(e);
  eq(scope.My_Gold, 7, 'label sanitized to identifier');
  eq(scope.My_Gold_2, 3, 'duplicate label suffixed');
  eq(scope.bonus, 5, 'params visible via variables');
  eq(scope.step, 0, 'step in scope');
});

test('Monte Carlo perStep/onTrialEnd hooks check every trial', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE);
  const p = node(d, NodeType.POOL); p.label = 'P';
  conn(d, s, p).rate = 1;
  const parsed = [parseAssertion('at end: P == 5')];
  const checkers = new Map();
  const results = [];
  e.runMonteCarlo(4, 5, {
    perStep: (eng, r) => {
      if (!checkers.has(r)) checkers.set(r, new AssertionChecker(parsed));
      checkers.get(r).check(eng);
    },
    onTrialEnd: (eng, r) => { results[r] = checkers.get(r).finish(eng); },
  });
  eq(results.length, 4, 'one result set per trial');
  assert(results.every(rs => rs[0].pass), 'assertion holds in every trial');
});

// ── Economy as code: generated module ───────────────────────────────────────
console.log('\nEconomy as code: generated module');

function buildTestModule(diagramJSON) {
  const base = path.join(__dirname, '..', 'js');
  const src = buildEconomyModule(diagramJSON,
    fs.readFileSync(path.join(base, 'model.js'), 'utf8'),
    fs.readFileSync(path.join(base, 'engine.js'), 'utf8'),
    { generator: 'test/run.js' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports;
}

test('generated module simulates the embedded economy', () => {
  const { d } = setup();
  const s = node(d, NodeType.SOURCE); s.label = 'Mine';
  const p = node(d, NodeType.POOL); p.label = 'Gold';
  conn(d, s, p).rate = 2;
  const Economy = buildTestModule(d.toJSON());
  const eco = Economy.createEconomy();
  eco.run(10);
  eq(eco.get('Gold'), 20, 'module run matches the engine');
  eq(eco.t, 10, 'clock advanced');
  eq(eco.values().Gold, 20, 'values() maps labels');
  eco.reset();
  eq(eco.t, 0, 'reset rewinds');
  eq(eco.get('Gold'), 0, 'reset restores the baseline');
});

test('generated module set() keeps a pool\'s resource type', () => {
  // set() wrote `resources` and let reconcile() backfill the difference, which
  // types every added unit DEFAULT_COLOR grey. A colour-filtered connection or
  // a converter recipe then refused the units the host game had just added.
  const WOOD = '#8d6e63';
  const { d } = setup();
  const p = node(d, NodeType.POOL); p.label = 'Warehouse'; p.setCount(10, WOOD);
  const mill = node(d, NodeType.POOL); mill.label = 'Mill';
  const c = conn(d, p, mill); c.rate = 5; c.colorFilter = WOOD;

  const Economy = buildTestModule(d.toJSON());
  const eco = Economy.createEconomy();
  eco.set('Warehouse', 50);
  eq(eco.get('Warehouse'), 50, 'set() applies the amount');
  eco.run(20);
  eq(eco.get('Mill'), 50, 'the colour-filtered flow accepts every unit set() added');
  eq(eco.get('Warehouse'), 0, 'and the warehouse empties');

  // Setting downward must not invent a type either.
  const eco2 = Economy.createEconomy();
  eco2.set('Warehouse', 4);
  eco2.run(20);
  eq(eco2.get('Mill'), 4, 'trimming leaves only typed units behind');
});

test('generated module honors seed and param overrides deterministically', () => {
  const { d } = setup();
  const s = node(d, NodeType.SOURCE); s.label = 'Mine';
  const p = node(d, NodeType.POOL); p.label = 'Gold';
  const c1 = conn(d, s, p); c1.rateMode = RateMode.DICE; c1.dice = '1d6';
  d.params = { level: 1 };
  const Economy = buildTestModule(d.toJSON());
  const runOnce = () => Economy.createEconomy({ seed: 'k', params: { level: 4 } }).run(20).get('Gold');
  const a = runOnce(), b = runOnce();
  eq(a, b, 'same seed, same result');
  const eco = Economy.createEconomy({ params: { level: 4 } });
  eq(eco.diagram.params.level, 4, 'param override applied');
  const other = Economy.createEconomy({ seed: 'different-seed' }).run(20).get('Gold');
  assert(typeof other === 'number', 'other seed still simulates');
});

test('generated module set() and fire() manipulate the live run', () => {
  const { d } = setup();
  const p = node(d, NodeType.POOL); p.label = 'Gold'; p.setCount(5);
  const dr = node(d, NodeType.DRAIN); dr.label = 'Sink';
  const btn = node(d, NodeType.POOL); btn.label = 'Buy'; btn.activation = ActivationMode.INTERACTIVE;
  conn(d, p, dr).rate = 1;
  const Economy = buildTestModule(d.toJSON());
  const eco = Economy.createEconomy();
  eco.set('Gold', 100);
  eq(eco.get('Gold'), 100, 'set() writes a pool');
  let threw = false;
  try { eco.set('Sink', 1); } catch { threw = true; }
  assert(threw, 'set() rejects a drain');
  eco.fire('Buy'); // interactive node fires without throwing
  let steps = 0;
  eco.onStep(() => steps++);
  eco.step(3);
  eq(steps, 3, 'onStep callback saw each step');
});

// ── The why layer: feedback-loop detection ──────────────────────────────────
console.log('\nFeedback loops');

test('modifier self-loop classifies by factor sign (interest R, decay B)', () => {
  const { d } = setup();
  const p = node(d, NodeType.POOL); p.label = 'Bank'; p.setCount(100);
  const grow = conn(d, p, p, ConnectionType.STATE);
  grow.modifier = true; grow.modMode = 'rate'; grow.modFactor = 0.1;
  let r = detectLoops(d);
  eq(r.loops.length, 1, 'one loop');
  eq(r.loops[0].type, 'R', 'positive interest reinforces');
  eq(r.loops[0].labels.join(','), 'Bank', 'self loop names the pool');
  grow.modFactor = -0.1;
  r = detectLoops(d);
  eq(r.loops[0].type, 'B', 'decay balances');
});

test('two-node modifier loop: signs multiply (+,− is balancing)', () => {
  const { d } = setup();
  const prey = node(d, NodeType.POOL); prey.label = 'Prey'; prey.setCount(50);
  const pred = node(d, NodeType.POOL); pred.label = 'Predators'; pred.setCount(5);
  const up = conn(d, prey, pred, ConnectionType.STATE);
  up.modifier = true; up.modFactor = 0.05;       // more prey feeds predators
  const down = conn(d, pred, prey, ConnectionType.STATE);
  down.modifier = true; down.modFactor = -0.2;   // predators eat prey
  const r = detectLoops(d);
  eq(r.loops.length, 1, 'one cycle');
  eq(r.loops[0].type, 'B', 'predator-prey is a balancing loop');
  eq(r.loops[0].nodes.length, 2, 'two nodes in the cycle');
});

test('pure resource cycles are circulations (F), not feedback', () => {
  const { d } = setup();
  const a = node(d, NodeType.POOL); a.label = 'TownA'; a.setCount(10);
  const b = node(d, NodeType.POOL); b.label = 'TownB';
  conn(d, a, b).rate = 1;
  conn(d, b, a).rate = 1;
  const r = detectLoops(d);
  eq(r.loops.length, 1, 'one cycle');
  eq(r.loops[0].type, 'F', 'flow-only cycle is a circulation');
});

test('activator operator sets link sign; register formulas probe numerically', () => {
  const { d } = setup();
  // Pool publishes gold; register doubles it; register activates the drain
  // connection's source pool only while low (a < condition = negative link);
  // drain lowers the pool: a balancing control loop.
  const pool = node(d, NodeType.POOL); pool.label = 'Gold'; pool.setCount(20);
  const reg = node(d, NodeType.REGISTER); reg.label = 'Score'; reg.formula = 'gold * 2';
  const pub = conn(d, pool, reg, ConnectionType.STATE); pub.variableName = 'gold';
  const act = conn(d, reg, pool, ConnectionType.STATE);
  act.activator = true; act.actOperator = '<'; act.actValue = 100;
  const r = detectLoops(d);
  eq(r.loops.length, 1, 'one loop through the register');
  const loop = r.loops[0];
  eq(loop.type, 'B', 'one negative activator link makes it balancing');
  // The formula edge (gold → Score) probed positive; activator negative.
  const signs = loop.links.map(l => l.sign).sort().join(',');
  eq(signs, '-1,1', 'probe found +, operator found −');
});

test('negative-slope rate formulas probe as balancing feedback', () => {
  const { d } = setup();
  const src = node(d, NodeType.SOURCE); src.label = 'Mint';
  const pool = node(d, NodeType.POOL); pool.label = 'Gold'; pool.setCount(0);
  const reg = node(d, NodeType.REGISTER); reg.label = 'Level';
  conn(d, pool, reg, ConnectionType.STATE).variableName = 'gold';
  const flow = conn(d, src, pool);
  flow.rateMode = RateMode.FORMULA; flow.formula = 'max(0, 10 - gold)';
  const r = detectLoops(d);
  // gold → (rate formula, negative slope) → Gold inflow: a balancing loop.
  const b = r.loops.find(l => l.type === 'B');
  assert(b, 'balancing loop found via formula probe');
  assert(b.links.some(l => l.sign === -1), 'formula edge probed negative');
});

test('triggers are positive links; reverse triggers negative', () => {
  const { d } = setup();
  const a = node(d, NodeType.POOL); a.label = 'A'; a.setCount(1);
  const b = node(d, NodeType.POOL); b.label = 'B'; b.setCount(1);
  const t1 = conn(d, a, b, ConnectionType.STATE); t1.trigger = true;
  const t2 = conn(d, b, a, ConnectionType.STATE); t2.reverseTrigger = true;
  const r = detectLoops(d);
  eq(r.loops.length, 1, 'one loop');
  eq(r.loops[0].type, 'B', 'trigger (+) times reverse trigger (−) balances');
});

test('loop enumeration dedupes, caps and reports truncation', () => {
  const { d } = setup();
  // A dense all-to-all state-modifier graph has factorially many cycles.
  const nodes = [];
  for (let i = 0; i < 7; i++) { const n = node(d, NodeType.POOL); n.label = 'N' + i; nodes.push(n); }
  for (const x of nodes) for (const y of nodes) {
    if (x === y) continue;
    const c = conn(d, x, y, ConnectionType.STATE);
    c.modifier = true; c.modFactor = 1;
  }
  const r = detectLoops(d, { maxLoops: 25 });
  eq(r.loops.length, 25, 'capped at maxLoops');
  assert(r.truncated, 'truncation reported');
  const keys = new Set(r.loops.map(l => l.nodes.join('>')));
  eq(keys.size, 25, 'no duplicate cycles');
});

test('cli --loops prints the loop table', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-test-'));
  const f = path.join(dir, 'loop.econ');
  fs.writeFileSync(f, [
    'pool Bank @ 0,0 = 100',
    'Bank ~> Bank mod="rate 0.1"',
  ].join('\n'));
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), f, '--loops'], { encoding: 'utf8' });
  assert(/^R  Bank -> Bank/m.test(out), 'reinforcing self-loop printed');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Phase portrait chart type ───────────────────────────────────────────────
console.log('\nPhase portraits');

test('phase chart type round-trips through JSON and .econ text', () => {
  const d = new Diagram();
  const a = d.addNode(new MNode(NodeType.POOL, 0, 0)); a.label = 'Prey';
  const b = d.addNode(new MNode(NodeType.POOL, 100, 0)); b.label = 'Predators';
  const ch = new MChart(200, 0); ch.label = 'Portrait'; ch.chartType = 'phase';
  ch.nodeIds = [a.id, b.id];
  d.addChart(ch);
  const back = new Diagram(); back.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
  eq([...back.charts.values()][0].chartType, 'phase', 'JSON round trip keeps the type');
  const text = dslSerialize(d.toJSON());
  assert(/type=phase/.test(text), '.econ writes type=phase');
  const parsed = dslParse(text);
  eq(parsed.charts[0].chartType, 'phase', '.econ parse keeps the type');
  eq(parsed.charts[0].nodeIds.length, 2, 'both axes tracked');
});

// ── The why layer: spike attribution ────────────────────────────────────────
console.log('\nSpike attribution');

test('history records a step-0 baseline and per-span flows', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.label = 'Mine';
  const p = node(d, NodeType.POOL); p.label = 'Gold';
  const c = conn(d, s, p); c.rate = 2;
  steps(e, 3);
  eq(e.history[0].step, 0, 'baseline at step 0');
  eq(e.history.length, 4, 'baseline + 3 steps');
  eq(e.history[1].flows.conns[c.id], 2, 'flow recorded on the entry');
  eq(Object.keys(e.history[0].flows.conns).length, 0, 'baseline has no flows');
});

test('attributeChange balances inflow, outflow and delta exactly', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.label = 'Mine';
  const p = node(d, NodeType.POOL); p.label = 'Gold';
  const dr = node(d, NodeType.DRAIN); dr.label = 'Spend';
  const cin = conn(d, s, p); cin.rate = 3;
  const cout = conn(d, p, dr); cout.rate = 1;
  steps(e, 5);
  const a = attributeChange(d, e.history, p.id, 3);
  eq(a.delta, 2, 'net +2 per settled step');
  eq(a.entries.length, 2, 'one inflow, one outflow');
  const inflow = a.entries.find(x => x.kind === 'flow in');
  const outflow = a.entries.find(x => x.kind === 'flow out');
  eq(inflow.amount, 3, 'inflow from Mine');
  eq(inflow.label, 'from Mine', 'inflow labeled by source');
  eq(outflow.amount, -1, 'outflow to Spend');
  eq(a.residual, 0, 'fully accounted');
  // Drain semantics: cumulative intake only, no outflows.
  const ad = attributeChange(d, e.history, dr.id, 3);
  eq(ad.delta, 1, 'drained grows by intake');
  eq(ad.entries.length, 1, 'single inflow entry');
  eq(ad.entries[0].amount, 1, 'intake amount');
});

test('modifier deltas are attributed with applied amounts', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.label = 'Bank'; p.setCount(100);
  const m = conn(d, p, p, ConnectionType.STATE);
  m.modifier = true; m.modMode = 'rate'; m.modFactor = 0.1;
  steps(e, 1);
  const a = attributeChange(d, e.history, p.id, 1);
  eq(a.delta, 10, '10% interest applied');
  eq(a.entries.length, 1, 'one modifier entry');
  eq(a.entries[0].kind, 'modifier', 'kind is modifier');
  eq(a.entries[0].amount, 10, 'applied amount recorded');
  eq(a.residual, 0, 'fully accounted');
});

test('converter consumption lands in the residual, keeping the identity', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.label = 'Mine';
  const cv = node(d, NodeType.CONVERTER); cv.label = 'Forge'; cv.inputAmount = 2;
  const p = node(d, NodeType.POOL); p.label = 'Out';
  conn(d, s, cv).rate = 2;
  conn(d, cv, p).rate = 1;
  steps(e, 4);
  for (let i = 1; i < e.history.length; i++) {
    const a = attributeChange(d, e.history, cv.id, i);
    const sum = a.entries.reduce((x, y) => x + y.amount, 0) + a.residual;
    eq(sum, a.delta, `identity holds at entry ${i}`);
  }
});

test('flows merge through stride decimation: attribution still adds up', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.label = 'Mine';
  const p = node(d, NodeType.POOL); p.label = 'Gold';
  const c = conn(d, s, p); c.rate = 1;
  steps(e, 1500); // stride doubles past 600 entries
  assert(e._histStride > 1, 'stride actually doubled');
  for (let i = 1; i < e.history.length; i++) {
    const a = attributeChange(d, e.history, p.id, i);
    const span = e.history[i].step - e.history[i - 1].step;
    eq(a.delta, span, `delta spans ${span} steps at entry ${i}`);
    eq(a.entries[0].amount, span, 'merged flows cover the whole span');
    eq(a.residual, 0, 'nothing lost in decimation');
  }
});

test('attributeChange handles registers and the run start', () => {
  const { d, e } = setup();
  const p = node(d, NodeType.POOL); p.label = 'Gold'; p.setCount(4);
  const r = node(d, NodeType.REGISTER); r.label = 'Score'; r.formula = 'gold * 2';
  conn(d, p, r, ConnectionType.STATE).variableName = 'gold';
  const s = node(d, NodeType.SOURCE); s.label = 'Mine';
  conn(d, s, p).rate = 1;
  steps(e, 2);
  const a0 = attributeChange(d, e.history, p.id, 0);
  assert(a0.initial, 'index 0 flagged as run start');
  const ar = attributeChange(d, e.history, r.id, 2);
  assert(ar.register, 'register flagged');
  eq(ar.entries.length, 0, 'no flow entries for a register');
  assert(Math.abs(ar.delta - 2) < 1e-9, 'register delta reflects formula inputs');
});

// The steps() helper resets first, so nothing here used to exercise a fresh
// engine. In the app that is the whole first-run path: boot on an empty canvas,
// draw a Source into a Pool, press Run. Only reset() seeded the flow
// accumulator, so the first transfer threw, and with it went _record and
// onStep: the step counter stuck at 0 and every chart stayed empty while the
// node values on the canvas kept climbing.
test('a fresh engine steps without a reset first', () => {
  const { d, e } = setup();
  const s = node(d, NodeType.SOURCE); s.label = 'Mine';
  const p = node(d, NodeType.POOL); p.label = 'Gold';
  conn(d, s, p).rate = 2;
  for (let i = 0; i < 3; i++) e.doStep();   // deliberately no reset()
  eq(e.step, 3, 'stepped three times');
  eq(p.resources, 6, 'resources actually moved');
  eq(e.history.length, 3, 'every step recorded');
  eq(attributeChange(d, e.history, p.id, 2).entries[0].amount, 2, 'flows attributed');
});

test('cli --why prints an attribution table', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-test-'));
  const f = path.join(dir, 'mine.econ');
  fs.writeFileSync(f, [
    'source Mine @ 0,0', 'pool Gold @ 100,0', 'drain Spend @ 200,0',
    'Mine -> Gold : 3', 'Gold -> Spend : 1',
  ].join('\n'));
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (args) => {
    try {
      return execFileSync(process.execPath, [cli, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { return String(err.stderr || ''); }
  };
  // Capture stderr: spawn with stderr piped via a wrapper.
  const { spawnSync } = require('child_process');
  const res = spawnSync(process.execPath, [cli, f, '--steps', '10', '--why', 'Gold@5'], { encoding: 'utf8' });
  assert(/why Gold: step 4 -> 5/.test(res.stderr), 'header names node and span');
  assert(/\+3\s+from Mine \(flow in\)/.test(res.stderr), 'inflow row printed');
  assert(/-1\s+to Spend \(flow out\)/.test(res.stderr), 'outflow row printed');
  const bad = spawnSync(process.execPath, [cli, f, '--steps', '5', '--why', 'Nope'], { encoding: 'utf8' });
  eq(bad.status, 1, 'unknown node fails fast');
  assert(run([f, '--steps', '5']).length > 0, 'plain run unaffected');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Economy as code: CLI end-to-end ─────────────────────────────────────────
console.log('\nEconomy as code: CLI');

test('cli runs .econ input, checks assertions and converts formats', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'econ-test-'));
  const econPath = path.join(dir, 'mine.econ');
  fs.writeFileSync(econPath, [
    'name: CLI Mine',
    'source Mine @ 0,0', 'pool Gold @ 100,0', 'drain Spend @ 200,0',
    'Mine -> Gold : 2', 'Gold -> Spend : 1',
  ].join('\n'));
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (args) => {
    try { return { out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }; }
    catch (e) { return { out: String(e.stdout || ''), err: String(e.stderr || ''), code: e.status }; }
  };
  const ok = run([econPath, '--steps', '10', '--assert', 'always Gold <= 11', '--assert', 'eventually Gold >= 5']);
  eq(ok.code, 0, 'passing assertions exit 0');
  const bad = run([econPath, '--steps', '10', '--assert', 'always Gold < 5']);
  eq(bad.code, 2, 'failing assertion exits 2');
  assert(/violated at step/.test(bad.err), 'failure detail printed');
  const dsl = run([econPath, '--to-dsl']);
  assert(/Mine -> Gold : 2/.test(dsl.out), '--to-dsl emits .econ text');
  const jsonOut = run([econPath, '--to-json']);
  const parsed = JSON.parse(jsonOut.out);
  eq(parsed.nodes.length, 3, '--to-json emits loadable JSON');
  // First step nets +2 (the pool has nothing to drain yet), then +1 per step.
  const mc = run([econPath, '--steps', '10', '--runs', '5', '--seed', '1', '--assert', 'at end: Gold == 11']);
  eq(mc.code, 0, 'Monte Carlo assertions pass across trials');
  const emitPath = path.join(dir, 'eco.module.js');
  const emit = run([econPath, '--emit', emitPath]);
  eq(emit.code, 0, '--emit exits 0');
  const Economy = require(emitPath);
  eq(Economy.createEconomy().run(10).get('Gold'), 11, 'emitted module simulates');

  // --check runs the assertions embedded in the file itself.
  const withChecks = path.join(dir, 'checked.econ');
  fs.writeFileSync(withChecks, [
    'source Mine @ 0,0', 'pool Gold @ 100,0',
    'Mine -> Gold : 2',
    'assert "always Gold <= 20"',
  ].join('\n'));
  eq(run([withChecks, '--steps', '10', '--check']).code, 0, '--check passes embedded suite');
  const failing = run([withChecks, '--steps', '20', '--check']);
  eq(failing.code, 2, '--check fails when the embedded assertion breaks');
  fs.rmSync(dir, { recursive: true, force: true });
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
