#!/usr/bin/env node
// Headless CLI runner — simulate a diagram JSON without a browser.
//
//   node cli.js <diagram.json> [options]
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
// Single run prints CSV to stdout: step,<node>,<node>,… one row per step.
// Examples:
//   node cli.js examples/economy.json --steps 500 > trace.csv
//   node cli.js economy.json --runs 1000 --seed 42 --param mine_rate=3
'use strict';

const fs = require('fs');
const path = require('path');

// Exit quietly when the consumer closes the pipe early (e.g. `| head`).
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e; });

// Same loading trick as test/run.js: model.js and engine.js are plain browser
// scripts, evaluated into one function scope. math.js is optional (formulas
// fall back to the legacy evaluator without it).
try { global.math = require('mathjs'); } catch { /* optional */ }

function loadEngine() {
  const base = path.join(__dirname, 'js');
  const src =
    fs.readFileSync(path.join(base, 'model.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(base, 'engine.js'), 'utf8') + '\n' +
    'return { NodeType, Diagram, SimEngine, SimRandom };';
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { steps: 200, runs: 1, seed: null, params: {}, csv: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--steps') opts.steps = parseInt(argv[++i], 10);
    else if (a === '--runs') opts.runs = parseInt(argv[++i], 10);
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--csv') opts.csv = true;
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
  if (!opts.file) fail('Usage: node cli.js <diagram.json> [--steps N] [--runs N] [--seed S] [--param k=v] [--csv]');
  if (!isFinite(opts.steps) || opts.steps < 1) fail('--steps must be a positive integer');
  if (!isFinite(opts.runs) || opts.runs < 1) fail('--runs must be a positive integer');
  return opts;
}

function csvCell(s) {
  s = String(s ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const opts = parseArgs(process.argv.slice(2));
const { NodeType, Diagram, SimEngine, SimRandom } = loadEngine();

let json;
try { json = JSON.parse(fs.readFileSync(opts.file, 'utf8')); }
catch (e) { fail(`Cannot read ${opts.file}: ${e.message}`); }
json.params = { ...(json.params || {}), ...opts.params };

const diagram = new Diagram();
diagram.loadJSON(json);
// --seed overrides any seed saved in the diagram; reset() then applies it as the
// single RNG authority. Without --seed the diagram's own seed (if any) still holds.
if (opts.seed != null) diagram.seed = opts.seed;
const engine = new SimEngine(diagram);
const tracked = [...diagram.nodes.values()].filter(n => n.type !== NodeType.SOURCE || n.limited);

if (opts.runs === 1) {
  // Single run → per-step CSV trace on stdout. reset() seeds SimRandom from
  // diagram.seed (set from --seed above, or carried in the saved file).
  engine.reset();
  const header = ['step', ...tracked.map(n => csvCell(n.label || n.type))];
  process.stdout.write(header.join(',') + '\n');
  process.stdout.write(['0', ...tracked.map(n => n.chartValue)].join(',') + '\n');
  for (let s = 0; s < opts.steps && !engine.ended; s++) {
    engine.doStep();
    process.stdout.write([engine.step, ...tracked.map(n => n.chartValue)].join(',') + '\n');
  }
  SimRandom.seed(null);
  if (engine.ended) {
    process.stderr.write(`Goal reached: ${engine.ended.label} at step ${engine.ended.step}\n`);
  }
} else {
  // Monte Carlo → stats table (or raw per-run CSV with --csv).
  const res = engine.runMonteCarlo(opts.runs, opts.steps, { seed: opts.seed });
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
}
