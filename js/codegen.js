// Economy-as-code: export a diagram as a standalone JavaScript module.
//
// buildEconomyModule() bundles the model + engine sources (passed in by the
// caller: the app fetches its own script files, cli.js reads them from disk)
// with the diagram JSON and a small runtime API into one dependency-free UMD
// file. The generated module runs in Node (require) and the browser (script
// tag → window.Economy, or any bundler).
//
//   const { createEconomy } = require('./economy.js');
//   const eco = createEconomy({ seed: 42, params: { mine_rate: 3 } });
//   eco.run(200);
//   console.log(eco.get('Gold'), eco.t, eco.ended);
//
// DOM-free (loaded by the browser, cli.js and test/run.js).

/* exported buildEconomyModule */

function buildEconomyModule(json, modelSrc, engineSrc, opts = {}) {
  const globalName = opts.name || 'Economy';
  const econName = (json.meta && json.meta.name) || 'economy';
  const stamp = opts.generator || 'the simulations designer';
  // Double-encode the diagram: the module keeps it as a JSON string and each
  // createEconomy() call parses a fresh deep copy.
  const diagramLiteral = JSON.stringify(JSON.stringify(json));

  return `/*
 * ${econName} — generated economy module
 * Built by ${stamp}. Self-contained: no dependencies, no DOM.
 *
 * Formulas evaluate with math.js when a global \`math\` is present (optional:
 * require('mathjs') and set global.math before loading this file); without it
 * they fall back to a plain JS expression evaluator.
 *
 * The RNG (SimRandom) is shared module state: run one seeded economy at a
 * time per process for bit-exact reproducibility.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.${globalName} = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

${modelSrc}

${engineSrc}

const DIAGRAM_SRC = ${diagramLiteral};

// Runtime handle over one simulation instance.
//   opts.seed    — override the diagram's run seed (same seed, same run)
//   opts.params  — override diagram parameters by name
function createEconomy(opts = {}) {
  const d = new Diagram();
  d.loadJSON(JSON.parse(DIAGRAM_SRC));
  if (opts.seed != null) d.seed = String(opts.seed);
  if (opts.params) d.params = Object.assign({}, d.params, opts.params);
  const e = new SimEngine(d);
  let stepCb = null;
  e.onStep = (s) => { if (stepCb && s > 0) stepCb(api.values(), s); };
  const findNode = (name) => {
    for (const n of d.nodes.values()) if (n.label === name) return n;
    return null;
  };
  const api = {
    engine: e,
    diagram: d,
    get t() { return e.step; },
    get ended() { return !!e.ended; },
    // Put the simulation back at step 0 (and re-apply the seed).
    reset() { e.reset(); return api; },
    // Advance n steps (stops early if a goal ends the run).
    step(n = 1) { for (let i = 0; i < n && !e.ended; i++) e.doStep(); return api; },
    // Advance until a goal is reached or maxSteps elapse.
    run(maxSteps = 1000) { for (let i = 0; i < maxSteps && !e.ended; i++) e.doStep(); return api; },
    // Value by node label (pool contents, drain total, register value, …),
    // falling back to the shared variable store (params, state connections).
    get(name) {
      const n = findNode(name);
      if (n) return n.chartValue;
      return d.variables[name];
    },
    // Set a pool's or limited source's live amount, or a register's value.
    set(name, v) {
      const n = findNode(name);
      if (!n) throw new Error('set(): no node labeled ' + JSON.stringify(name));
      if (n.type === NodeType.REGISTER) { n.value = Number(v) || 0; return api; }
      if (n.type === NodeType.POOL || (n.type === NodeType.SOURCE && n.limited)) {
        n.resources = Math.max(0, Number(v) || 0);
        n.reconcile();
        return api;
      }
      throw new Error('set() supports pools, limited sources and registers');
    },
    // Fire an interactive node by label (a player action).
    fire(name) {
      const n = findNode(name);
      if (!n) throw new Error('fire(): no node labeled ' + JSON.stringify(name));
      return e.fireInteractive(n.id);
    },
    // {label: value} for every tracked node (infinite sources excluded).
    values() {
      const out = {};
      for (const n of d.nodes.values()) {
        if (n.type === NodeType.SOURCE && !n.limited) continue;
        out[n.label] = n.chartValue;
      }
      return out;
    },
    vars() { return Object.assign({}, d.variables); },
    // Subscribe to steps: fn(values, step) after every advance.
    onStep(fn) { stepCb = fn; return api; },
  };
  e.reset();
  return api;
}

return { createEconomy, DIAGRAM_SRC, Diagram, SimEngine, SimRandom, NodeType };
}));
`;
}
