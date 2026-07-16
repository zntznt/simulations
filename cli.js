#!/usr/bin/env node
// Headless CLI runner — simulate a diagram without a browser.
//
//   node cli.js <diagram.json | economy.econ> [options]
//
// Options:
//   --steps N          steps to simulate (default 200)
//   --runs N           Monte Carlo: run N isolated trials and print summary
//                      stats instead of a single-run trace (default 1)
//   --seed S           seed the RNG — same seed, same results
//   --param name=val   override a diagram parameter (repeatable)
//   --csv              with --runs>1: print raw per-run final values as CSV
//                      (one row per run) instead of the stats table
//
// Economy-as-code:
//   --assert "A"       check an assertion over the run (repeatable), e.g.
//                      "always gold < 500", "eventually score >= 100",
//                      "at step 25: queue <= 3", "widgets > 50" (= at end).
//                      With --runs>1 every trial is checked. Exit code 2 when
//                      assertions fail.
//   --assert-file F    read assertions from a file (one per line, // comments)
//   --check            also run the assertions saved in the diagram itself
//                      (the Checks rail panel in the app; `assert` lines in
//                      .econ files)
//   --pass-rate P      with --runs>1: minimum % of trials where every
//                      assertion holds (default 100)
//   --to-dsl           print the diagram as .econ text and exit
//   --to-json          print the diagram as JSON and exit (parses .econ input)
//   --loops            print the diagram's feedback loops (reinforcing R,
//                      balancing B, resource circulation F, unclear ?) and exit
//   --emit out.js      write a standalone dependency-free JS module of this
//                      economy (createEconomy API) and exit
//
// Input files ending in .econ (or that fail JSON.parse) are parsed as the
// .econ text format. Single run prints CSV to stdout: step,<node>,… per step.
// Exit codes: 0 ok, 1 usage or file error, 2 assertion failure.
//
// Examples:
//   node cli.js examples/economy.json --steps 500 > trace.csv
//   node cli.js economy.econ --runs 1000 --seed 42 --param mine_rate=3
//   node cli.js economy.json --assert "always gold < 500" --assert "at end: score >= 10"
//   node cli.js economy.json --to-dsl > economy.econ
//   node cli.js economy.econ --emit economy.module.js
'use strict';

const fs = require('fs');
const path = require('path');

// Exit quietly when the consumer closes the pipe early (e.g. `| head`).
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e; });

// Same loading trick as test/run.js: the js/ files are plain browser scripts,
// evaluated into one function scope. math.js is optional (formulas fall back
// to the legacy evaluator without it).
try { global.math = require('mathjs'); } catch { /* optional */ }

function loadEngine() {
  const base = path.join(__dirname, 'js');
  const src =
    fs.readFileSync(path.join(base, 'model.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'engine.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'dsl.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'assertions.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'codegen.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'loops.js'), 'utf8') + '\n' +
    'return { NodeType, Diagram, SimEngine, SimRandom, dslSerialize, dslParse,' +
    ' parseAssertion, AssertionChecker, buildEconomyModule, detectLoops };';
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    steps: 200, runs: 1, seed: null, params: {}, csv: false, file: null,
    asserts: [], passRate: 100, emit: null, toDsl: false, toJson: false, check: false, loops: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--steps') opts.steps = parseInt(argv[++i], 10);
    else if (a === '--runs') opts.runs = parseInt(argv[++i], 10);
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--csv') opts.csv = true;
    else if (a === '--assert') opts.asserts.push(argv[++i]);
    else if (a === '--assert-file') {
      const f = argv[++i];
      let text;
      try { text = fs.readFileSync(f, 'utf8'); }
      catch (e) { fail(`Cannot read ${f}: ${e.message}`); }
      for (const line of text.split(/\r?\n/)) {
        const s = line.replace(/\/\/.*$/, '').trim();
        if (s) opts.asserts.push(s);
      }
    }
    else if (a === '--check') opts.check = true;
    else if (a === '--pass-rate') opts.passRate = parseFloat(argv[++i]);
    else if (a === '--emit') opts.emit = argv[++i];
    else if (a === '--to-dsl') opts.toDsl = true;
    else if (a === '--to-json') opts.toJson = true;
    else if (a === '--loops') opts.loops = true;
    else if (a === '--param') {
      const m = String(argv[++i] || '').match(/^([^=]+)=(.+)$/);
      if (!m) fail(`--param expects name=value, got "${argv[i]}"`);
      opts.params[m[1]] = parseFloat(m[2]);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n')
        .filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n') + '\n');
      process.exit(0);
    } else if (!a.startsWith('-') && !opts.file) opts.file = a;
    else fail(`Unknown option: ${a}`);
  }
  if (!opts.file) fail('Usage: node cli.js <diagram.json|economy.econ> [--steps N] [--runs N] [--seed S] [--param k=v] [--assert A] [--to-dsl] [--emit out.js]');
  if (!isFinite(opts.steps) || opts.steps < 1) fail('--steps must be a positive integer');
  if (!isFinite(opts.runs) || opts.runs < 1) fail('--runs must be a positive integer');
  if (!isFinite(opts.passRate) || opts.passRate < 0 || opts.passRate > 100) fail('--pass-rate must be 0..100');
  return opts;
}

function csvCell(s) {
  s = String(s ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const opts = parseArgs(process.argv.slice(2));
const {
  NodeType, Diagram, SimEngine, SimRandom,
  dslSerialize, dslParse, parseAssertion, AssertionChecker, buildEconomyModule, detectLoops,
} = loadEngine();

// ── Load the diagram: JSON, or .econ text ───────────────────────────────────
let raw;
try { raw = fs.readFileSync(opts.file, 'utf8'); }
catch (e) { fail(`Cannot read ${opts.file}: ${e.message}`); }
let json = null;
if (!/\.econ$/i.test(opts.file)) {
  try { json = JSON.parse(raw); } catch { /* fall through to .econ */ }
}
if (json === null) {
  try { json = dslParse(raw); }
  catch (e) { fail(`Cannot parse ${opts.file}: ${e.message}`); }
}
json.params = { ...(json.params || {}), ...opts.params };
if (opts.seed != null) json.seed = String(opts.seed);

// Validate by loading once (throws on structurally broken files).
const diagram = new Diagram();
try { diagram.loadJSON(json); } catch (e) { fail(`Invalid diagram: ${e.message}`); }

// ── Conversion / codegen modes (no simulation) ──────────────────────────────
if (opts.toDsl) {
  process.stdout.write(dslSerialize(diagram.toJSON()));
  process.exit(0);
}
if (opts.toJson) {
  process.stdout.write(JSON.stringify(diagram.toJSON(), null, 2) + '\n');
  process.exit(0);
}
if (opts.loops) {
  const { loops, truncated } = detectLoops(diagram);
  if (!loops.length) process.stdout.write('No feedback loops found.\n');
  for (const l of loops) {
    const chain = [...l.labels, l.labels[0]].join(' -> ');
    const linkStr = l.links.map(x => `${x.sign > 0 ? '+' : (x.sign < 0 ? '-' : '?')}${[...x.kinds].join('/')}`).join(', ');
    process.stdout.write(`${l.type}  ${chain}  [${linkStr}]\n`);
  }
  if (truncated) process.stderr.write('Large graph: some longer loops omitted.\n');
  process.exit(0);
}
if (opts.emit) {
  const base = path.join(__dirname, 'js');
  const mod = buildEconomyModule(diagram.toJSON(),
    fs.readFileSync(path.join(base, 'model.js'), 'utf8'),
    fs.readFileSync(path.join(base, 'engine.js'), 'utf8'),
    { generator: 'cli.js' });
  fs.writeFileSync(opts.emit, mod);
  process.stderr.write(`Wrote ${opts.emit} (${(mod.length / 1024).toFixed(0)} KB)\n`);
  process.exit(0);
}

// ── Assertions ──────────────────────────────────────────────────────────────
// --check prepends the assertions saved in the diagram itself to any given
// with --assert/--assert-file.
const assertSrcs = [...(opts.check ? diagram.assertions || [] : []), ...opts.asserts];
let parsedAsserts = [];
try { parsedAsserts = assertSrcs.map(parseAssertion); }
catch (e) { fail(`Bad assertion: ${e.message}`); }
if (opts.check && !(diagram.assertions || []).length) {
  process.stderr.write('Note: --check given but the diagram has no saved assertions.\n');
}

function reportAssertions(results) {
  let failed = 0;
  for (const r of results) {
    const mark = r.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    process.stderr.write(`assert  ${mark}  ${r.src}${r.detail && !r.pass ? ` (${r.detail})` : ''}\n`);
    if (!r.pass) failed++;
  }
  process.stderr.write(`${results.length} assertion${results.length === 1 ? '' : 's'}: ${results.length - failed} passed, ${failed} failed\n`);
  return failed;
}

const engine = new SimEngine(diagram);
const tracked = [...diagram.nodes.values()].filter(n => n.type !== NodeType.SOURCE || n.limited);

if (opts.runs === 1) {
  // Single run → per-step CSV trace on stdout. reset() seeds SimRandom from
  // diagram.seed (set from --seed above, or carried in the saved file).
  engine.reset();
  const checker = parsedAsserts.length ? new AssertionChecker(parsedAsserts) : null;
  if (checker) checker.check(engine);
  const header = ['step', ...tracked.map(n => csvCell(n.label || n.type))];
  process.stdout.write(header.join(',') + '\n');
  process.stdout.write(['0', ...tracked.map(n => n.chartValue)].join(',') + '\n');
  for (let s = 0; s < opts.steps && !engine.ended; s++) {
    engine.doStep();
    if (checker) checker.check(engine);
    process.stdout.write([engine.step, ...tracked.map(n => n.chartValue)].join(',') + '\n');
  }
  SimRandom.seed(null);
  if (engine.ended) {
    process.stderr.write(`Goal reached: ${engine.ended.label} at step ${engine.ended.step}\n`);
  }
  if (checker) {
    const failed = reportAssertions(checker.finish(engine));
    if (failed > 0) process.exit(2);
  }
} else {
  // Monte Carlo → stats table (or raw per-run CSV with --csv), with
  // assertions checked inside every trial when any were given.
  const checkers = new Map();
  const runResults = [];
  const mcOpts = { seed: opts.seed };
  if (parsedAsserts.length) {
    mcOpts.perStep = (eng, r) => {
      if (!checkers.has(r)) checkers.set(r, new AssertionChecker(parsedAsserts));
      checkers.get(r).check(eng);
    };
    mcOpts.onTrialEnd = (eng, r) => {
      runResults[r] = checkers.get(r).finish(eng);
      checkers.delete(r);
    };
  }
  const res = engine.runMonteCarlo(opts.runs, opts.steps, mcOpts);
  if (opts.csv) {
    const header = ['run', ...res.nodes.map(n => csvCell(n.label || n.type))];
    process.stdout.write(header.join(',') + '\n');
    for (let r = 0; r < res.runs; r++) {
      process.stdout.write([r + 1, ...res.nodes.map(n => n.samples[r] ?? '')].join(',') + '\n');
    }
  } else {
    const pad = (s, w) => String(s).padStart(w);
    process.stdout.write(`${res.runs} runs x ${res.maxSteps} steps`
      + (res.seed ? ` (seed ${res.seed})` : '') + '\n');
    if (res.endStep) {
      process.stdout.write(`Goal reached in ${Math.round(res.endedRate * 100)}% of runs`
        + ` — end step mean ${res.endStep.mean} (min ${res.endStep.min}, max ${res.endStep.max})\n`);
    }
    const w = Math.max(8, ...res.nodes.map(n => (n.label || n.type).length));
    process.stdout.write('\n' + 'node'.padEnd(w) + pad('mean', 10) + pad('min', 8)
      + pad('p10', 8) + pad('p50', 8) + pad('p90', 8) + pad('max', 8) + '\n');
    for (const n of res.nodes) {
      process.stdout.write((n.label || n.type).padEnd(w) + pad(n.mean, 10) + pad(n.min, 8)
        + pad(n.p10, 8) + pad(n.p50, 8) + pad(n.p90, 8) + pad(n.max, 8) + '\n');
    }
  }
  if (parsedAsserts.length) {
    // Per-assertion tally across every run, then the all-assertions pass rate.
    let cleanRuns = 0;
    const failCounts = parsedAsserts.map(() => 0);
    const firstFail = parsedAsserts.map(() => null);
    for (let r = 0; r < runResults.length; r++) {
      const results = runResults[r] || [];
      let clean = true;
      results.forEach((res2, i) => {
        if (!res2.pass) {
          clean = false;
          failCounts[i]++;
          if (!firstFail[i]) firstFail[i] = { run: r + 1, detail: res2.detail };
        }
      });
      if (clean) cleanRuns++;
    }
    for (let i = 0; i < parsedAsserts.length; i++) {
      const fails = failCounts[i];
      const mark = fails === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      const where = fails > 0 ? ` (${fails}/${opts.runs} runs, first: run ${firstFail[i].run}, ${firstFail[i].detail})` : '';
      process.stderr.write(`assert  ${mark}  ${parsedAsserts[i].src}${where}\n`);
    }
    const rate = (cleanRuns / opts.runs) * 100;
    const ok = rate >= opts.passRate;
    process.stderr.write(`${cleanRuns}/${opts.runs} runs passed every assertion (${rate.toFixed(1)}%, required ${opts.passRate}%)\n`);
    if (!ok) process.exit(2);
  }
}
