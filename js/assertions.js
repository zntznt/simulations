// Economy-as-code: design assertions.
//
// An assertion is a temporal check over a simulation run, written as a
// quantifier plus a formula in the same expression language rates and
// registers use (math.js when loaded, legacy JS fallback otherwise):
//
//   always gold < 500              holds at every step (including step 0)
//   never wood == 0                inverse of always
//   eventually score >= 100        true at one or more steps
//   at end: widgets > 50           true at the final step
//   at step 25: queue <= 3         true at exactly step 25
//   widgets > 50                   bare expression = at end
//
// The colon after a quantifier is optional. Identifiers in scope, later
// entries overriding earlier ones on a name clash:
//   1. every node's label, sanitized to an identifier (spaces and other
//      symbols become _, a leading digit gets a _ prefix; duplicate labels
//      get _2, _3, … in declaration order), valued at the node's chart value
//      (pool contents, drain total, source produced-if-limited, register
//      value, trader trades)
//   2. everything in diagram.variables (params, custom variables, state-
//      connection names, register labels)
//   3. step, the current step number
//
// DOM-free (loaded by the browser, cli.js and test/run.js; must come after
// model.js, which provides evalFormula/validateFormula).

/* exported parseAssertion, AssertionChecker, assertionScope */

function _assertIdent(label, fallback) {
  let s = String(label == null ? '' : label).trim().replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = fallback;
  if (/^[0-9]/.test(s)) s = '_' + s;
  return s;
}

// The identifier scope described above, for one engine at its current step.
function assertionScope(engine) {
  const scope = {};
  const seen = new Map();
  for (const n of engine.diagram.nodes.values()) {
    let key = _assertIdent(n.label, n.type);
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count > 1) key = `${key}_${count}`;
    const v = n.chartValue;
    scope[key] = isFinite(v) ? v : 0;
  }
  for (const [k, v] of Object.entries(engine.diagram.variables || {})) {
    if (typeof v === 'number' && isFinite(v)) scope[k] = v;
  }
  scope.step = engine.step;
  return scope;
}

// Parse one assertion string. Returns { quant, atStep, expr, src }.
// quant: 'always' | 'never' | 'eventually' | 'end' | 'step'.
// Throws on an unknown form or an expression neither evaluator can parse.
function parseAssertion(src) {
  const s = String(src || '').trim();
  if (!s) throw new Error('empty assertion');
  let quant = 'end', atStep = null, expr = s;

  let m;
  if ((m = s.match(/^(always|never|eventually)\s*:?\s+(.+)$/i))) {
    quant = m[1].toLowerCase();
    expr = m[2];
  } else if ((m = s.match(/^at\s+end\s*:?\s*(.+)$/i))) {
    quant = 'end';
    expr = m[1];
  } else if ((m = s.match(/^at\s+step\s+(\d+)\s*:?\s*(.+)$/i))) {
    quant = 'step';
    atStep = parseInt(m[1], 10);
    expr = m[2];
  }
  expr = expr.trim();
  if (!expr) throw new Error(`assertion "${s}" has no expression`);
  if (typeof validateFormula === 'function' && !validateFormula(expr)) {
    throw new Error(`assertion expression does not parse: ${expr}`);
  }
  return { quant, atStep, expr, src: s };
}

// Checks a list of parsed assertions over one run. Call check(engine) at
// step 0 (right after reset) and again after every doStep; call finish(engine)
// when the run ends to get results:
//   [{ src, quant, pass, failStep, detail }]
class AssertionChecker {
  constructor(parsed) {
    this.assertions = parsed;
    this._state = parsed.map(() => ({ failStep: null, met: false, metStep: null, sawStep: false, last: false }));
  }

  check(engine) {
    const scope = assertionScope(engine);
    const step = engine.step;
    for (let i = 0; i < this.assertions.length; i++) {
      const a = this.assertions[i], st = this._state[i];
      // 'step' assertions only evaluate at their step; everything else, every step.
      if (a.quant === 'step' && step !== a.atStep) continue;
      const truthy = evalFormula(a.expr, scope) !== 0;
      if (a.quant === 'always' && !truthy && st.failStep === null) st.failStep = step;
      else if (a.quant === 'never' && truthy && st.failStep === null) st.failStep = step;
      else if (a.quant === 'eventually' && truthy && !st.met) { st.met = true; st.metStep = step; }
      else if (a.quant === 'step') { st.sawStep = true; st.last = truthy; }
      else if (a.quant === 'end') st.last = truthy;
    }
  }

  finish(engine) {
    return this.assertions.map((a, i) => {
      const st = this._state[i];
      let pass, detail = '';
      if (a.quant === 'always' || a.quant === 'never') {
        pass = st.failStep === null;
        if (!pass) detail = `violated at step ${st.failStep}`;
      } else if (a.quant === 'eventually') {
        pass = st.met;
        detail = pass ? `first true at step ${st.metStep}` : `never true in ${engine.step} steps`;
      } else if (a.quant === 'step') {
        if (!st.sawStep) { pass = false; detail = `run ended at step ${engine.step}, before step ${a.atStep}`; }
        else { pass = st.last; if (!pass) detail = `false at step ${a.atStep}`; }
      } else {
        pass = st.last;
        if (!pass) detail = `false at final step ${engine.step}`;
      }
      return { src: a.src, quant: a.quant, pass, failStep: st.failStep, detail };
    });
  }
}
