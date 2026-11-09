const NodeType = {
  POOL: 'pool',
  SOURCE: 'source',
  DRAIN: 'drain',
  GATE: 'gate',
  CONVERTER: 'converter',
  REGISTER: 'register',
  DELAY: 'delay',
  QUEUE: 'queue',
  TRADER: 'trader',
};

const ConnectionType = {
  RESOURCE: 'resource',
  STATE: 'state',
};

const ActivationMode = {
  AUTOMATIC: 'automatic',
  PASSIVE: 'passive',
  INTERACTIVE: 'interactive',
  STARTING: 'starting',
};

const RateMode = {
  FIXED: 'fixed',
  DICE: 'dice',
  FORMULA: 'formula',
  DISTRIBUTION: 'distribution',
};

// ── Seedable RNG ────────────────────────────────────────────────────────────
// Every stochastic decision in the simulation (dice, distributions, chance %,
// probabilistic gates, custom variables) draws from SimRandom rather than
// Math.random directly, so a run can be made bit-for-bit reproducible by
// seeding. Unseeded it delegates to Math.random (which also keeps tests that
// stub Math.random working).
const SimRandom = {
  _fn: null, // null → delegate to Math.random
  _a: 0,     // mulberry32 state (32-bit), advanced on every seeded draw
  random() { return this._fn ? this._fn() : Math.random(); },
  // Seed with any string/number; null/'' clears back to Math.random.
  seed(s) {
    if (s == null || s === '') { this._fn = null; return; }
    // Hash the seed into a 32-bit state, then mulberry32 — small and fast,
    // with distribution quality more than adequate for game-economy sampling.
    let a = 0;
    const str = String(s);
    for (let i = 0; i < str.length; i++) a = ((a * 31) + str.charCodeAt(i)) >>> 0;
    if (a === 0) a = 0x9e3779b9;
    this.setState(a);
  },
  // Checkpoint support: the internal 32-bit state, so captureState /
  // restoreState can put a seeded stream back at its exact position.
  // null ↔ unseeded (Math.random has no position to save).
  getState() { return this._fn ? this._a : null; },
  setState(state) {
    if (state == null) { this._fn = null; return; }
    this._a = state >>> 0;
    const self = this;
    this._fn = function () {
      let a = self._a | 0; a = (a + 0x6d2b79f5) | 0;
      self._a = a;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },
};

// Grey "uncolored" resource — used when a node holds resources without an
// explicit color (e.g. resources typed directly into the properties panel).
const DEFAULT_COLOR = '#9e9e9e';

const NODE_FILL = {
  pool: '#10233f', source: '#10240f', drain: '#2b0f0f',
  gate: '#23102f', converter: '#2b1a05', register: '#161b21', delay: '#06262a',
  queue: '#141632', trader: '#2d0f1c',
};

const NODE_STROKE = {
  pool: '#4a9eff', source: '#4caf50', drain: '#ef5350',
  gate: '#ba68c8', converter: '#ffa726', register: '#90a4bc', delay: '#26c6da',
  queue: '#7c83ff', trader: '#f06292',
};

const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Safely evaluate a math expression against a set of variables.
//
// Formulas are evaluated with math.js when its bundle is loaded (the normal
// case in the browser, via vendor/math.min.js), which provides a rich, safe
// expression language: `^` power, ternaries (`a > 5 ? 10 : 0`), comparisons,
// round/floor/ceil/abs/min/max/sqrt/log/exp/mod, trig, constants (pi, e),
// random() / randomInt(a,b) / pickRandom([…]), and more.
//
// Older JS-flavoured formulas like `Math.round(x)` keep working through
// _seededMathScope and _repairLegacyOps. Nothing falls back to JS evaluation:
// see evalFormula for why. Expressions math.js cannot handle evaluate to 0.
const _mathCompileCache = new Map();   // expr → compiled math.js code (or null if unparseable)

// Formula randomness routed through SimRandom: these shadow math.js's own
// random()/randomInt()/pickRandom() (which are Math.random-backed) via the
// evaluation scope, so seeded runs stay reproducible when a formula rolls
// randomness. Injected per evaluation — never baked into compiled code —
// because _mathCompileCache is shared across Monte Carlo trials.
function _formulaRandomScope() {
  return {
    // random() → [0,1); random(max) → [0,max); random(min,max) → [min,max)
    random: (min, max) => {
      if (min === undefined) return SimRandom.random();
      if (max === undefined) { max = min; min = 0; }
      return min + SimRandom.random() * (max - min);
    },
    // randomInt(max) → [0,max); randomInt(min,max) → [min,max); integers
    randomInt: (min, max) => {
      if (max === undefined) { max = min; min = 0; }
      return Math.floor(min + SimRandom.random() * (max - min));
    },
    // pickRandom([…]) → one element (math.js matrices unwrap to arrays)
    pickRandom: (arr) => {
      const a = arr && typeof arr.toArray === 'function' ? arr.toArray() : arr;
      if (!Array.isArray(a) || !a.length) return 0;
      return a[Math.floor(SimRandom.random() * a.length)];
    },
  };
}

// The `Math` object legacy formulas reach for, rebuilt as OWN properties:
// math.js refuses to call a method it finds on a prototype, so Object.create
// (Math) would give "No access to method random". `random` draws from SimRandom
// so a seeded run stays reproducible on this path too.
const _MATH_FNS = ['abs', 'ceil', 'floor', 'round', 'trunc', 'sign', 'min', 'max', 'pow',
  'sqrt', 'cbrt', 'exp', 'log', 'log2', 'log10', 'hypot',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2'];
const _MATH_CONSTS = ['PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2'];
function _seededMathScope() {
  const m = { random: () => SimRandom.random() };
  for (const k of _MATH_FNS) if (typeof Math[k] === 'function') m[k] = (...a) => Math[k](...a);
  for (const k of _MATH_CONSTS) if (typeof Math[k] === 'number') m[k] = Math[k];
  return m;
}

// Built once: both only call SimRandom, so they hold no per-formula state, and
// rebuilding their ~30 closures on every evaluation was a measurable share of a
// Monte Carlo batch. Frozen because every formula shares them.
const _FORMULA_RANDOM_SCOPE = Object.freeze(_formulaRandomScope());
const _MATH_SCOPE = Object.freeze(_seededMathScope());

// Legacy JS operators that math.js spells differently. Applied ONLY to an
// expression math.js has already refused to compile, so a well-formed math.js
// expression is never rewritten.
function _repairLegacyOps(expr) {
  return expr
    .replace(/!==/g, ' != ')
    .replace(/===/g, ' == ')
    .replace(/&&/g, ' and ')
    .replace(/\|\|/g, ' or ')
    .replace(/\*\*/g, '^')
    .replace(/!(?=\s*[A-Za-z_(])/g, ' not ');
}

// A diagram is untrusted input, and math.js is a whole language: zeros(20000,20000)
// or 1:1e10 exhaust memory, a recursive f(x)= or combinations(2e9,1e9) hang the tab,
// and createUnit() or import() change the instance every formula shares. So formulas
// may only call these numeric functions, and may not define anything. A blocklist
// can't hold: ranges allocate without naming a function, and assignment aliases names.
// ponytail: flat allowlist, extend it when a real formula needs another function.
const _FORMULA_FUNCTIONS = new Set(`
  abs cbrt ceil cube exp expm1 fix floor gamma hypot log log10 log1p log2 max mean
  median min mod nthRoot pow prod round sign sqrt square std sum variance
  acos acosh asin asinh atan atan2 atanh cos cosh sin sinh tan tanh
  add divide multiply subtract unaryMinus
  and not or xor equal larger largerEq smaller smallerEq unequal
  pickRandom random randomInt
`.trim().split(/\s+/));

function _isForbiddenNode(n) {
  switch (n.type) {
    case 'AssignmentNode':
    case 'FunctionAssignmentNode':
    case 'RangeNode':
      return true;
    case 'FunctionNode':
      if (n.fn.type === 'SymbolNode') return !_FORMULA_FUNCTIONS.has(n.fn.name);
      // Math.round(x) from older formulas resolves to _seededMathScope.
      return !(n.fn.type === 'AccessorNode' && n.fn.object.type === 'SymbolNode' && n.fn.object.name === 'Math');
    default:
      return false;
  }
}

// The parsed formula, or null if it doesn't parse or isn't allowed. A formula in the
// older JS-flavoured syntax gets a second chance after _repairLegacyOps.
function _parseFormula(expr) {
  try {
    let node;
    try { node = math.parse(expr); } catch { node = math.parse(_repairLegacyOps(expr)); }
    return node.filter(_isForbiddenNode).length ? null : node;
  } catch { return null; }
}

function _evalMathJS(expr, vars) {
  if (typeof math === 'undefined' || !math.compile) return undefined;
  let code = _mathCompileCache.get(expr);
  if (code === undefined) {
    try { code = _parseFormula(expr)?.compile() || null; } catch { code = null; }
    if (_mathCompileCache.size > 500) _mathCompileCache.clear();
    _mathCompileCache.set(expr, code);
  }
  if (!code) return undefined;
  const scope = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (VALID_IDENT.test(k) && typeof v === 'number' && isFinite(v)) scope[k] = v;
  }
  // Seeded randomness (scope functions take precedence over math.js built-ins),
  // plus the Math object older formulas were written against.
  Object.assign(scope, _FORMULA_RANDOM_SCOPE);
  scope.Math = _MATH_SCOPE;
  try {
    let r = code.evaluate(scope);
    if (r && typeof r === 'object' && typeof r.toNumber === 'function') r = r.toNumber();
    if (typeof r === 'boolean') r = r ? 1 : 0;
    r = Number(r);
    return isFinite(r) ? r : 0;
  } catch { return undefined; }
}

function evalFormula(expr, vars = {}) {
  if (!expr || typeof expr !== 'string' || !expr.trim()) return 0;
  // math.js only. There used to be a `new Function(expr)` fallback here for
  // formulas math.js could not parse, which made every formula-bearing field a
  // remote code execution sink: a diagram is untrusted input, arriving as a
  // shared #d= link, a downloaded .json or .econ, a library component or a
  // cli.js argument, and reset() evaluates register formulas on load, so simply
  // opening a link ran the author's JavaScript. validateFormula reported such a
  // payload as valid, so nothing warned. Nothing in the app needs it: all 110
  // distinct expressions across the 12 demos and 11 templates compile under
  // math.js, and the JS-flavoured spellings older saved diagrams might use are
  // handled by _seededMathScope and _repairLegacyOps above.
  const viaMath = _evalMathJS(expr.trim(), vars);
  return viaMath === undefined ? 0 : viaMath;
}

// True if evalFormula would run the expression. Used for live input validation.
function validateFormula(expr) {
  if (!expr || typeof expr !== 'string' || !expr.trim()) return false;
  if (typeof math === 'undefined' || !math.parse) return false;
  return _parseFormula(expr.trim()) !== null;
}

// Variables a valid formula reads that `known` does not define. math.js throws
// on an undefined symbol and evalFormula turns that into 0 for the WHOLE
// formula, so `income + Leve` silently yields 0. Function names, math.js
// constants (pi, e) and the legacy Math object are not variables. Returns []
// for an unparseable formula; validateFormula reports those.
function unknownFormulaNames(expr, known) {
  const node = typeof expr === 'string' && expr.trim() ? _parseFormula(expr.trim()) : null;
  if (!node) return [];
  const have = new Set(known);
  const out = new Set();
  node.traverse((n, path, parent) => {
    if (n.type !== 'SymbolNode' || have.has(n.name) || n.name === 'Math') return;
    if (parent && parent.type === 'FunctionNode' && path === 'fn') return;
    // Constants only: a bare `size` resolves to math.size, a function, and
    // the formula still evaluates to 0.
    if (math[n.name] !== undefined && typeof math[n.name] !== 'function') return;
    out.add(n.name);
  });
  return [...out];
}

// Sample from a named statistical distribution. Returns a non-negative integer.
// p1/p2 meaning: normal→mean/stddev, uniform→min/max, exponential→mean, poisson→lambda.
function sampleDist(type, p1 = 1, p2 = 0) {
  // Sanitize params up front so a non-finite input can never yield NaN (which
  // would silently poison a node's resource count downstream).
  if (!isFinite(p1)) p1 = 0;
  if (!isFinite(p2)) p2 = 0;
  const fl0 = n => (isFinite(n) ? Math.max(0, Math.round(n)) : 0);
  switch (type) {
    case 'uniform':
      return fl0((isFinite(p1) ? p1 : 0) + SimRandom.random() * (Math.max(p2, p1) - (isFinite(p1) ? p1 : 0)));
    case 'exponential': {
      const mean = Math.max(0.001, isFinite(p1) ? p1 : 1);
      const r = Math.max(1e-10, SimRandom.random());
      return fl0(-mean * Math.log(r));
    }
    case 'poisson': {
      const lam = Math.max(0, isFinite(p1) ? p1 : 1);
      const L = Math.exp(-lam);
      // exp(-lam) underflows for a mean above about 745. The normal approximation is
      // close at that size, where returning lam would remove the randomness entirely.
      if (!isFinite(L) || L <= 0) return sampleDist('normal', lam, Math.sqrt(lam));
      let k = 0, p = SimRandom.random();
      while (p > L && k < 10000) { p *= SimRandom.random(); k++; }
      return k;
    }
    case 'normal':
    default: {
      const u1 = Math.max(1e-10, SimRandom.random()), u2 = SimRandom.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const mean = isFinite(p1) ? p1 : 1;
      const std = isFinite(p2) && p2 > 0 ? p2 : 1;
      return fl0(mean + z * std);
    }
  }
}

// How many units get an individual random draw. Above this, sample the total in one
// step: the cost stays flat, and seeded runs at or below it keep their exact stream.
const EXACT_SAMPLE_LIMIT = 10000;

// How many of n units land on an outcome of probability p, for n above the exact
// limit: Poisson when the rarer outcome is expected fewer than 30 times, else normal.
function sampleBinomial(n, p) {
  if (p <= 0) return 0;
  if (p >= 1) return n;
  const q = Math.min(p, 1 - p), mean = n * q;
  const k = Math.min(n, mean < 30
    ? sampleDist('poisson', mean)
    : sampleDist('normal', mean, Math.sqrt(mean * (1 - q))));
  return p <= 0.5 ? k : n - k;
}

// Roll XdY dice notation (e.g. "2d6" → 2..12). Plain numbers pass through.
function rollDice(expr) {
  if (expr == null) return 0;
  const s = String(expr).trim().toLowerCase();
  const m = s.match(/^(\d+)\s*d\s*(\d+)$/);
  if (!m) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }
  const count = parseInt(m[1]), sides = parseInt(m[2]);
  if (sides < 1 || !isFinite(count * sides)) return 0;
  // Past the exact limit a loop could freeze the tick, so sample the sum from its
  // normal approximation. Capping the count instead silently returned wrong totals.
  if (count > EXACT_SAMPLE_LIMIT) {
    if (sides === 1) return count;
    const mean = count * (sides + 1) / 2, std = Math.sqrt(count * (sides * sides - 1) / 12);
    return Math.min(count * sides, Math.max(count, sampleDist('normal', mean, std)));
  }
  let sum = 0;
  for (let i = 0; i < count; i++) sum += Math.floor(SimRandom.random() * sides) + 1;
  return sum;
}

// ── Custom variables ──────────────────────────────────────────────────────
// A custom variable produces a value from one of four kinds:
//   interval — any number between min and max (continuous, random)
//   array    — one element of a user-supplied number list (random)
//   dice     — XdY notation (random, existing convention)
//   math     — a formula evaluated over the shared variable store
// For the random kinds, the chosen distribution shapes WHERE in the domain
// values land:
//   uniform  — everywhere equally (for dice: a true roll, each die uniform)
//   gaussian — clustered around the middle of the domain
// `update` ('step' | 'play') controls when the engine re-evaluates it.

// A 0..1 sample from a clamped bell curve (mean 0.5, sd 1/6 → ±3σ spans 0..1).
function _gauss01() {
  const u1 = Math.max(1e-10, SimRandom.random()), u2 = SimRandom.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(1, Math.max(0, 0.5 + z / 6));
}

function sampleCustomVar(rv, vars = {}) {
  if (!rv) return 0;
  const gaussian = rv.dist === 'gaussian';
  const u = gaussian ? _gauss01() : SimRandom.random();
  switch (rv.kind) {
    case 'math':
      return evalFormula(rv.formula, vars);
    case 'array': {
      const vals = (rv.values || []).filter(v => isFinite(v));
      if (!vals.length) return 0;
      // u → index; gaussian clusters picks around the middle of the list.
      return vals[Math.min(vals.length - 1, Math.floor(u * vals.length))];
    }
    case 'dice': {
      const m = String(rv.dice || '').trim().toLowerCase().match(/^(\d+)\s*d\s*(\d+)$/);
      if (!m) return 0;
      if (!gaussian) return rollDice(rv.dice);
      // Gaussian over the dice's range [X, X·Y], rounded.
      const count = parseInt(m[1]), sides = parseInt(m[2]);
      const lo = count, hi = count * Math.max(1, sides);
      return Math.round(lo + u * (hi - lo));
    }
    case 'interval':
    default: {
      const lo = isFinite(rv.min) ? rv.min : 0;
      const hi = isFinite(rv.max) ? rv.max : lo;
      const span = Math.max(0, hi - lo);
      // Continuous; rounded to 4 decimals so readouts stay tidy.
      return Math.round((lo + u * span) * 10000) / 10000;
    }
  }
}

// Dominant (most common) color in a {color: count} map.
function dominantColor(colorMap, fallback = null) {
  let max = 0, best = fallback;
  for (const [c, n] of Object.entries(colorMap || {})) {
    if (n > max) { max = n; best = c; }
  }
  return best;
}

let _idSeq = 0;
function genId(prefix) { return `${prefix}_${++_idSeq}_${Math.random().toString(36).slice(2, 7)}`; }

// Copy loaded fields onto a freshly constructed object, using each default's type as
// the schema. A diagram is untrusted input, and the render and engine code trust these
// types: a numeric note text stopped the whole app from starting. A value that can't
// be used keeps the default. Fields this build doesn't know stay, for newer files.
function _assignFields(target, data) {
  for (const [k, v] of Object.entries(data)) {
    // Inherited names are methods, getters and __proto__, which data must not replace.
    if (v === undefined || (k in target && !Object.hasOwn(target, k))) continue;
    const cur = target[k];
    switch (typeof cur) {
      case 'number': {
        const n = typeof v === 'string' && v.trim() ? Number(v) : v;
        if (typeof n === 'number' && !isNaN(n)) target[k] = n;
        break;
      }
      case 'string':
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') target[k] = String(v);
        break;
      case 'boolean':
        target[k] = !!v;
        break;
      case 'object':
        if (cur === null || (v && typeof v === 'object' && Array.isArray(v) === Array.isArray(cur))) target[k] = v;
        break;
      default:
        target[k] = v;
    }
  }
  return target;
}

// The comparison operators the engine's _evalCond understands. A file carrying
// anything else falls back to the field's default rather than reaching the engine.
const COMPARE_OPS = new Set(['>', '>=', '<', '<=', '==', '!=', 'between']);
function _validOp(op, fallback) { return COMPARE_OPS.has(op) ? op : fallback; }

// A color → count map holding only the numeric counts of `map`.
function _numericCounts(map) {
  return Object.fromEntries(Object.entries(map || {}).filter(([, n]) => typeof n === 'number'));
}

class MNode {
  constructor(type, x, y) {
    this.id = genId('n');
    this.type = type;
    this.x = x;
    this.y = y;
    this.label = type.charAt(0).toUpperCase() + type.slice(1);
    this.activation = ActivationMode.AUTOMATIC;
    // Asynchronous time mode: this automatic node fires every `fireEvery` steps,
    // offset by `firePhase`. Ignored in synchronous (turn-based) time mode.
    this.fireEvery = 1;
    this.firePhase = 0;
    this.resources = 0;
    this.capacity = Infinity;
    this.colorMap = {};       // {colorHex: count}
    this._initialResources = 0;
    this._initialColorMap = {};

    // End / goal condition: when met, the simulation halts (any node type).
    this.endEnabled = false;
    this.endOperator = '>=';
    this.endValue = 0;

    // Flow direction (Pool / Drain): 'push' (drive outgoing) is the default;
    // 'pull' draws resources along incoming connections from pool/source
    // providers. pullPolicy 'any' takes what's available; 'all' is atomic.
    this.flowMode = 'push';
    this.pullPolicy = 'any';

    if (type === NodeType.SOURCE) {
      this.resources = Infinity;
      this._initialResources = Infinity;
      this.resourceColor = '#ffa726';
      this.produced = 0;        // total emitted this run (for state connections)
      this.limited = false;     // when true, holds a finite starting stock
    } else if (type === NodeType.DRAIN) {
      this.drained = 0;         // total consumed this run
    } else if (type === NodeType.REGISTER) {
      this.value = 0;
      this.formula = '';
    } else if (type === NodeType.CONVERTER) {
      this.inputAmount = 1;     // resources consumed per conversion (legacy single-input mode)
      this.outputColor = '#ffa726';
      this.inputRecipe = [];    // [{color, amount}]; non-empty activates multi-ingredient mode
    } else if (type === NodeType.DELAY) {
      this.delay = 2;
      this._queue = [];         // [{amount, color, stepsLeft}]
    } else if (type === NodeType.QUEUE) {
      this.processTime = 2;     // steps to process one unit (per server)
      this.servers = 1;         // parallel servers (units processed concurrently)
      this.maxLine = 0;         // waiting-line cap; arrivals balk when full (0 = off)
      this.patience = 0;        // steps a unit waits before it reneges (0 = infinite)
      this._fifo = [];          // [{amount, color, enq}] waiting, in arrival order
      this._procs = [];         // [{color, stepsLeft}] units currently in service
      // Live run metrics (not serialized; reset each run): throughput, the
      // summed/peak waiting time before service, the peak line length, and the
      // losses — balked (turned away at a full line) and reneged (gave up waiting).
      this.processed = 0;
      this.totalWait = 0;
      this.maxWait = 0;
      this.maxLen = 0;
      this.balked = 0;
      this.reneged = 0;
    } else if (type === NodeType.GATE) {
      this.gateMode = 'deterministic';
    } else if (type === NodeType.TRADER) {
      this.trades = 0;          // completed exchanges this run
    }
  }

  get displayCount() {
    if (this.type === NodeType.SOURCE) return this.limited ? this.resources : '∞';
    if (this.type === NodeType.DRAIN) return this.drained || 0;
    if (this.type === NodeType.TRADER) return this.trades || 0;
    if (this.type === NodeType.REGISTER) {
      if (!isFinite(this.value)) return '∞';
      return +Number(this.value).toFixed(2);
    }
    return this.resources;
  }

  // Numeric value used for history charts.
  get chartValue() {
    if (this.type === NodeType.DRAIN) return this.drained || 0;
    if (this.type === NodeType.REGISTER) return isFinite(this.value) ? this.value : 0;
    if (this.type === NodeType.SOURCE) return this.limited ? this.resources : 0;
    if (this.type === NodeType.TRADER) return this.trades || 0;
    return this.resources;
  }

  // Primary display color (dominant held resource, or source's output color).
  get displayColor() {
    if (this.type === NodeType.SOURCE) return this.resourceColor || '#ffa726';
    if (this.type === NodeType.CONVERTER) return dominantColor(this.colorMap) || this.outputColor;
    return dominantColor(this.colorMap);
  }

  // Set a concrete resource count, keeping colorMap consistent. This is the
  // authoring path (properties panel), so it also becomes the reset baseline.
  setCount(n, color = DEFAULT_COLOR) {
    this.resources = Math.max(0, n);
    this.colorMap = this.resources > 0 ? { [color]: this.resources } : {};
    this._initialResources = this.resources;
    this._initialColorMap = { ...this.colorMap };
  }

  // Ensure colorMap totals equal `resources`. Untracked resources become
  // DEFAULT_COLOR; excess color entries are trimmed.
  reconcile() {
    if (this.resources === Infinity) return;
    let sum = 0;
    for (const v of Object.values(this.colorMap)) sum += v;
    if (sum < this.resources) {
      this.colorMap[DEFAULT_COLOR] = (this.colorMap[DEFAULT_COLOR] || 0) + (this.resources - sum);
    } else if (sum > this.resources) {
      let excess = sum - this.resources;
      for (const k of Object.keys(this.colorMap)) {
        if (excess <= 0) break;
        const take = Math.min(this.colorMap[k], excess);
        this.colorMap[k] -= take; excess -= take;
      }
    }
    for (const k of Object.keys(this.colorMap)) if (this.colorMap[k] <= 0) delete this.colorMap[k];
  }

  addResources(amount, color = DEFAULT_COLOR) {
    if (amount <= 0) return;
    this.resources += amount;
    this.colorMap[color] = (this.colorMap[color] || 0) + amount;
  }

  // Take up to `amount` resources, optionally only of `colorFilter`.
  // Mutates this node immediately. Returns [{amount, color}].
  takeResources(amount, colorFilter = null) {
    this.reconcile();
    const taken = [];
    let rem = amount;

    const takeFrom = (color, avail) => {
      const n = Math.min(rem, avail);
      if (n <= 0) return;
      this.colorMap[color] = (this.colorMap[color] || 0) - n;
      this.resources -= n;
      rem -= n;
      taken.push({ amount: n, color });
    };

    if (colorFilter) {
      takeFrom(colorFilter, this.colorMap[colorFilter] || 0);
    } else {
      for (const [c, cnt] of Object.entries(this.colorMap)) {
        if (rem <= 0) break;
        takeFrom(c, cnt);
      }
    }

    for (const k of Object.keys(this.colorMap)) if (this.colorMap[k] <= 0) delete this.colorMap[k];
    return taken;
  }

  toJSON() {
    const d = {
      id: this.id, type: this.type, x: this.x, y: this.y,
      label: this.label, activation: this.activation,
      fireEvery: this.fireEvery !== 1 ? this.fireEvery : undefined,
      firePhase: this.firePhase ? this.firePhase : undefined,
      resources: (this.type === NodeType.SOURCE && !this.limited) ? 0 : this.resources,
      capacity: this.capacity === Infinity ? null : this.capacity,
      colorMap: Object.keys(this.colorMap).length ? { ...this.colorMap } : undefined,
      endEnabled: this.endEnabled || undefined,
      endOperator: this.endOperator,
      endValue: this.endValue,
      flowMode: this.flowMode !== 'push' ? this.flowMode : undefined,
      pullPolicy: this.pullPolicy,
    };
    // The reset baseline, recorded only once the live count has drifted from it
    // (i.e. the diagram is being written mid-run). At rest the two match and
    // both fields are omitted, so at-rest files are byte-identical to before.
    // Without this, loadJSON derives the baseline from the live count, and any
    // mid-run write — an explicit save, a share link, or just the autosave
    // ticking over — silently became the model's new starting amount.
    // Infinite sources are excluded: JSON cannot carry Infinity, and loadJSON
    // already restores their baseline from the node type.
    // The amount and the colour mix drift independently, so they are tested
    // independently. Gating the map on the amount meant a balanced loop, income
    // and spend at matching rates, never recorded either: the total still read
    // 20 at the moment of the write, the guard was false, and the reload rebased
    // the authored mix to whatever was in transit ({orange:20} coming back as
    // {orange:14, green:6}). Any colour filter or converter recipe keyed on the
    // authored colour then drew from a smaller pool than the model says it has.
    if (isFinite(this._initialResources)) {
      if (this._initialResources !== d.resources) d.initialResources = this._initialResources;
      const base = this._initialColorMap || {};
      const bk = Object.keys(base);
      const sameMap = bk.length === Object.keys(this.colorMap).length
        && bk.every(k => base[k] === this.colorMap[k]);
      if (!sameMap) d.initialColorMap = { ...base };
    }
    if (this.type === NodeType.SOURCE) { d.resourceColor = this.resourceColor; d.limited = this.limited || undefined; }
    if (this.type === NodeType.GATE) d.gateMode = this.gateMode;
    if (this.type === NodeType.REGISTER) { d.value = this.value; d.formula = this.formula; }
    if (this.type === NodeType.CONVERTER) {
      d.inputAmount = this.inputAmount; d.outputColor = this.outputColor;
      if (this.inputRecipe && this.inputRecipe.length) d.inputRecipe = this.inputRecipe.map(i => ({ ...i }));
    }
    if (this.type === NodeType.DELAY) d.delay = this.delay;
    if (this.type === NodeType.QUEUE) {
      d.processTime = this.processTime;
      if (this.servers !== 1) d.servers = this.servers;
      if (this.maxLine) d.maxLine = this.maxLine;
      if (this.patience) d.patience = this.patience;
    }
    return d;
  }

  loadJSON(d) {
    _assignFields(this, d);
    this.endOperator = _validOp(this.endOperator, '>=');
    this.colorMap = _numericCounts(this.colorMap);
    const infiniteSource = this.type === NodeType.SOURCE && !this.limited;
    // A file written mid-run carries its baseline explicitly; in every other
    // case the live count IS the baseline, because the diagram was at rest when
    // it was written. Older files have neither field and keep the old meaning.
    this._initialResources = infiniteSource ? Infinity
      : (typeof d.initialResources === 'number' ? d.initialResources : this.resources);
    this._initialColorMap = _numericCounts(d.initialColorMap || this.colorMap);
    // _assignFields above copied these in as stray public fields; they are
    // read here and nowhere else, so drop them rather than let them ride along.
    delete this.initialResources;
    delete this.initialColorMap;
    if (infiniteSource) { this.resources = Infinity; }
    if (this.type === NodeType.SOURCE) this.produced = 0;
    if (this.type === NodeType.DRAIN) this.drained = 0;
    if (this.type === NodeType.DELAY) this._queue = [];
    if (this.type === NodeType.QUEUE) {
      this._fifo = []; this._procs = [];
      this.processed = 0; this.totalWait = 0; this.maxWait = 0; this.maxLen = 0;
      this.balked = 0; this.reneged = 0;
    }
    if (this.type === NodeType.TRADER) this.trades = 0;
    if (this.type === NodeType.CONVERTER) {
      this.inputRecipe = Array.isArray(d.inputRecipe) ? d.inputRecipe.map(i => ({ ...i })) : [];
    }
    return this;
  }
}

class MConnection {
  constructor(sourceId, targetId, type = ConnectionType.RESOURCE) {
    this.id = genId('c');
    this.sourceId = sourceId;
    this.targetId = targetId;
    this.type = type;
    this.label = '';

    // Rate (resource connections)
    this.rateMode = RateMode.FIXED;
    this.rate = 1;
    this.dice = '1d6';
    this.formula = '';

    // Timing
    this.interval = 1;     // fire every N steps
    this.chance = 100;     // % chance to fire each interval

    // Filters
    this.colorFilter = '';  // only move resources of this color

    // Conditional activation (compares source's count to a threshold)
    this.condEnabled = false;
    this.condOperator = '>';  // '>' | '>=' | '<' | '<=' | '==' | '!=' | 'between'
    this.condValue = 0;
    this.condValue2 = 0;      // upper bound when condOperator === 'between'

    // State connections: variable name written to diagram.variables
    this.variableName = '';

    // Trigger (state connection): fire the target node when the source fires.
    this.trigger = false;
    this.triggerChance = 100;  // % chance the trigger propagates each firing
    this.triggerEvery = 1;     // propagate only every Nth source firing (counter)

    // Activator (state connection): the target node may only fire while the
    // source value satisfies this condition.
    this.activator = false;
    this.actOperator = '>=';
    this.actValue = 0;
    this.actValue2 = 0;        // upper bound when actOperator === 'between'

    // Gate output weight (resource connection out of a Gate): relative share
    // for deterministic splits / weighted chance for probabilistic routing.
    this.weight = 1;
    // Optional: weight as a live formula over diagram variables (overrides
    // `weight` when non-empty), e.g. 'difficulty * 10'. Lets a gate's split
    // shift dynamically with simulation state, mirroring formula rates.
    this.weightFormula = '';

    // Modifier (state connection): adjust the target node's resources without
    // a resource flow. Four modes:
    //   'step'  — each step add a flat `modFactor` (e.g. +2 per step)
    //   'pulse' — when the source FIRES, add a flat `modFactor` (e.g. +1)
    //   'delta' — add `modFactor × (change in sourceValue)` when it changes
    //   'rate'  — each step add `modFactor × sourceValue` (interest / decay)
    this.modifier = false;
    this.modMode = 'rate';
    this.modFactor = 1;
    // Optional: amount/factor as a live formula over diagram variables
    // (overrides modFactor when non-empty), e.g. 'round(gold * 0.1)'.
    this.modFormula = '';

    // Reverse trigger (state): fire the target when the source FAILS to act
    // this step (e.g. pool was empty, limited source ran dry).
    this.reverseTrigger = false;

    // Condition reference (resource connections): 'source' tests source's own
    // value; 'variable' compares a named diagram variable instead.
    this.condRefMode = 'source';
    this.condVariable = '';

    // Distribution rate parameters (when rateMode === RateMode.DISTRIBUTION).
    this.distType = 'normal';   // 'normal' | 'uniform' | 'exponential' | 'poisson'
    this.distParam1 = 5;        // mean (normal/exp/poisson) or min (uniform)
    this.distParam2 = 2;        // std dev (normal) or max (uniform)

    // Visual path style: 'curve' (default) | 'straight' | 'ortho'
    this.pathStyle = 'curve';
    this.cpDx = 0;      // curve: control-point x offset from the auto-midpoint
    this.cpDy = 0;      // curve: control-point y offset from the auto-midpoint
    this.bendPct = 0.5; // ortho: default vertical-segment position when no waypoints
    this.waypoints = []; // ortho: explicit interior corner points [{x,y}, …] once hand-edited

    // Label pill position along the path (0 = source end, 1 = target end).
    this.labelT = 0.5;
  }

  toJSON() {
    return {
      id: this.id, sourceId: this.sourceId, targetId: this.targetId,
      type: this.type, label: this.label,
      rateMode: this.rateMode, rate: this.rate, dice: this.dice, formula: this.formula,
      distType: this.distType, distParam1: this.distParam1, distParam2: this.distParam2,
      interval: this.interval, chance: this.chance,
      colorFilter: this.colorFilter,
      condEnabled: this.condEnabled, condOperator: this.condOperator, condValue: this.condValue,
      condValue2: this.condValue2 || undefined,
      condRefMode: this.condRefMode !== 'source' ? this.condRefMode : undefined,
      condVariable: this.condVariable || undefined,
      variableName: this.variableName,
      trigger: this.trigger || undefined,
      triggerChance: this.triggerChance !== 100 ? this.triggerChance : undefined,
      triggerEvery: this.triggerEvery !== 1 ? this.triggerEvery : undefined,
      reverseTrigger: this.reverseTrigger || undefined,
      activator: this.activator || undefined,
      actOperator: this.actOperator, actValue: this.actValue,
      actValue2: this.actValue2 || undefined,
      weight: this.weight,
      weightFormula: this.weightFormula || undefined,
      modifier: this.modifier || undefined,
      modMode: this.modMode !== 'rate' ? this.modMode : undefined,
      modFactor: this.modFactor,
      modFormula: this.modFormula || undefined,
      pathStyle: this.pathStyle !== 'curve' ? this.pathStyle : undefined,
      cpDx: this.cpDx || undefined,
      cpDy: this.cpDy || undefined,
      bendPct: this.bendPct !== 0.5 ? this.bendPct : undefined,
      labelT: this.labelT !== 0.5 ? this.labelT : undefined,
      waypoints: (this.waypoints && this.waypoints.length) ? this.waypoints : undefined,
    };
  }

  loadJSON(d) {
    _assignFields(this, d);
    if (!Array.isArray(this.waypoints)) this.waypoints = [];
    this.condOperator = _validOp(this.condOperator, '>');
    this.actOperator = _validOp(this.actOperator, '>=');
    return this;
  }
}

class MGroup {
  constructor(x, y, w, h) {
    this.id = genId('grp');
    this.x = x; this.y = y;
    this.w = Math.max(40, w); this.h = Math.max(30, h);
    this.label = 'Group';
    this.color = '#4a9eff';
  }
  toJSON() {
    return { id: this.id, x: this.x, y: this.y, w: this.w, h: this.h, label: this.label, color: this.color };
  }
  loadJSON(d) { return _assignFields(this, d); }
}

class MNote {
  constructor(x, y) {
    this.id = genId('note');
    this.x = x; this.y = y;
    this.w = 160; this.h = 80;
    this.text = '';
    this.color = '#f6e05e';
  }
  toJSON() {
    return { id: this.id, x: this.x, y: this.y, w: this.w, h: this.h, text: this.text, color: this.color };
  }
  loadJSON(d) { return _assignFields(this, d); }
}

// On-canvas chart widget: a live line chart of one or more tracked nodes'
// values over the run, drawn directly into the diagram (distinct from the
// global timeline panel). Series are identified by node id.
class MChart {
  constructor(x, y) {
    this.id = genId('chart');
    this.x = x; this.y = y;
    this.w = 240; this.h = 150;
    this.label = 'Chart';
    this.nodeIds = [];      // tracked node ids, each plotted as a series
    // Visualization style: 'line' | 'area' | 'bars' | 'step'
    this.chartType = 'line';
  }
  toJSON() {
    return {
      id: this.id, x: this.x, y: this.y, w: this.w, h: this.h,
      label: this.label, nodeIds: [...this.nodeIds],
      chartType: this.chartType !== 'line' ? this.chartType : undefined,
    };
  }
  loadJSON(d) {
    _assignFields(this, d);
    this.nodeIds = [...this.nodeIds];
    if (!this.chartType) this.chartType = 'line';
    return this;
  }
}

// ── Components ───────────────────────────────────────────────────────────────
// Fields of node/connection JSON that name diagram variables: formulas hold
// expressions, condVariable a bare name.
const _COMPONENT_FORMULA_FIELDS = ['formula', 'weightFormula', 'modFormula'];
// An identifier in an expression, skipping member names (Math.round).
const _IDENT_RE = /(?<![\w$.])[A-Za-z_$][\w$]*/g;

function _formulaIdents(expr) {
  return [...String(expr || '').matchAll(_IDENT_RE)].map(m => m[0]);
}

// Diagram params (name → value) that a component's nodes/conns JSON uses.
function componentParams(nodes, conns, params) {
  const used = {};
  for (const item of [...nodes, ...conns]) {
    const names = _COMPONENT_FORMULA_FIELDS.flatMap(f => _formulaIdents(item[f]));
    if (item.condVariable) names.push(item.condVariable);
    for (const n of names) if (Object.prototype.hasOwnProperty.call(params, n)) used[n] = params[n];
  }
  return used;
}

function _renameComponentRefs(item, rename) {
  if (!Object.keys(rename).length) return item;
  const swap = n => (Object.prototype.hasOwnProperty.call(rename, n) ? rename[n] : n);
  for (const f of _COMPONENT_FORMULA_FIELDS) {
    if (typeof item[f] === 'string') item[f] = item[f].replace(_IDENT_RE, swap);
  }
  if (item.condVariable) item.condVariable = swap(item.condVariable);
  return item;
}

class Diagram {
  constructor() {
    this.nodes = new Map();
    this.connections = new Map();
    this.groups = new Map();
    this.notes = new Map();
    this.charts = new Map();
    // Named resource types: [{ name, color }]. The color is the underlying key
    // resources are tracked by (colorMap), so this is a human-readable naming
    // layer over the existing color-based engine — no engine changes needed.
    this.resourceTypes = [];
    this.variables = {};  // shared store, refreshed each step from state connections
    this.params = {};     // user-defined constants seeded into variables before each step
    // Custom variables: [{name, kind:'interval'|'array'|'dice'|'math',
    //   min, max, values:[…], dice:'XdY', formula:'…',
    //   dist:'uniform'|'gaussian', update:'step'|'play', value}].
    // Evaluated by the engine (see update), then seeded into `variables`
    // for formulas — state connections override.
    this.customVars = [];
    // Time mode: 'sync' (turn-based — every automatic node fires each step) or
    // 'async' (real-time — each automatic node fires on its own fireEvery rhythm).
    this.timeMode = 'sync';
    // Run seed: when set, every stochastic decision in a live run draws from a
    // seeded RNG, so the run is bit-for-bit reproducible. '' = unseeded (delegates
    // to Math.random). Applied by the engine on reset(); mirrors the CLI --seed.
    this.seed = '';
    // Artificial player: scripted actor that fires interactive nodes during a
    // run, on an interval or when a variable condition holds.
    this.aiPlayer = { enabled: false, rules: [] };
    // Design tests: assertion strings (js/assertions.js grammar) saved with
    // the diagram. Checked in the Checks rail panel and by `cli.js --check`.
    this.assertions = [];
    // Simulation-wide presentation + file metadata (edited in the default
    // properties panel): name/description, canvas background, UI color scheme,
    // display font (Google Fonts), a captured thumbnail, and timestamps.
    this.meta = Diagram.defaultMeta();
  }

  static defaultMeta() {
    return {
      name: '', description: '',
      bgColor: '',        // '' = theme default canvas background
      scheme: 'default',  // UI accent scheme key (see app COLOR_SCHEMES)
      font: '',           // '' = default font stack; else a Google Fonts family
      thumbnail: '',      // small data-URL snapshot of the canvas
      created: Date.now(), modified: Date.now(),
    };
  }

  addNode(n) { this.nodes.set(n.id, n); return n; }

  removeNode(id) {
    this.nodes.delete(id);
    for (const [cid, c] of this.connections)
      if (c.sourceId === id || c.targetId === id) this.connections.delete(cid);
  }

  addConnection(c) { this.connections.set(c.id, c); return c; }
  removeConnection(id) { this.connections.delete(id); }

  // Insert a saved component ({nodes, conns, params?} as JSON) with fresh ids,
  // offset so it does not cover the original. Each param the component uses
  // gets the value from `values` (else its saved default) under its own name,
  // or name_2, name_3... when the diagram already has it, with the copy's
  // formulas renamed to match, so every copy can be tuned on its own.
  // Returns the new node ids.
  insertComponent(comp, values = {}, offset = 40) {
    const rename = {};
    for (const [name, def] of Object.entries(comp.params || {})) {
      let k = 1, to = name;
      while (Object.prototype.hasOwnProperty.call(this.params, to)) to = `${name}_${++k}`;
      const v = Number(values[name] ?? def);
      this.params[to] = isFinite(v) ? v : def;
      if (to !== name) rename[name] = to;
    }
    const idMap = new Map();
    for (const nd of comp.nodes) {
      const node = new MNode(nd.type, nd.x + offset, nd.y + offset);
      node.loadJSON(_renameComponentRefs({ ...nd, id: node.id, x: nd.x + offset, y: nd.y + offset }, rename));
      this.addNode(node);
      idMap.set(nd.id, node.id);
    }
    for (const cd of comp.conns) {
      const sId = idMap.get(cd.sourceId), tId = idMap.get(cd.targetId);
      if (!sId || !tId) continue;
      const conn = new MConnection(sId, tId, cd.type);
      conn.loadJSON(_renameComponentRefs({ ...cd, id: conn.id, sourceId: sId, targetId: tId }, rename));
      this.addConnection(conn);
    }
    return [...idMap.values()];
  }

  addGroup(g) { this.groups.set(g.id, g); return g; }
  removeGroup(id) { this.groups.delete(id); }

  addNote(n) { this.notes.set(n.id, n); return n; }
  removeNote(id) { this.notes.delete(id); }

  addChart(c) { this.charts.set(c.id, c); return c; }
  removeChart(id) { this.charts.delete(id); }

  // Human-readable name of the resource type whose color matches, or null.
  resourceTypeName(color) {
    if (!color) return null;
    const target = String(color).toLowerCase();
    const t = this.resourceTypes.find(rt => rt.color && rt.color.toLowerCase() === target);
    return t ? t.name : null;
  }

  outgoing(nodeId) { return [...this.connections.values()].filter(c => c.sourceId === nodeId); }
  incoming(nodeId) { return [...this.connections.values()].filter(c => c.targetId === nodeId); }

  toJSON() {
    return {
      // Schema version: bump when a field's meaning changes (not when fields
      // are merely added — absent fields default safely in loadJSON).
      version: 1,
      _idSeq,
      nodes: [...this.nodes.values()].map(n => n.toJSON()),
      connections: [...this.connections.values()].map(c => c.toJSON()),
      groups: this.groups.size ? [...this.groups.values()].map(g => g.toJSON()) : undefined,
      notes: this.notes.size ? [...this.notes.values()].map(n => n.toJSON()) : undefined,
      charts: this.charts.size ? [...this.charts.values()].map(c => c.toJSON()) : undefined,
      resourceTypes: this.resourceTypes.length
        ? this.resourceTypes.map(t => ({ name: t.name, color: t.color })) : undefined,
      variables: { ...this.variables },
      params: Object.keys(this.params).length ? { ...this.params } : undefined,
      customVars: this.customVars.length
        ? this.customVars.map(r => ({ ...r, values: Array.isArray(r.values) ? [...r.values] : undefined }))
        : undefined,
      timeMode: this.timeMode !== 'sync' ? this.timeMode : undefined,
      seed: this.seed ? this.seed : undefined,
      aiPlayer: (this.aiPlayer && this.aiPlayer.rules && this.aiPlayer.rules.length)
        ? { enabled: !!this.aiPlayer.enabled, rules: this.aiPlayer.rules.map(r => ({ ...r })) }
        : undefined,
      assertions: this.assertions.length ? [...this.assertions] : undefined,
      meta: { ...this.meta },
    };
  }

  loadJSON(data) {
    // Migration point: files without `version` predate the marker and parse
    // as v1. When v2 lands, transform `data` here before loading.
    const v = data.version || 1;
    if (v > 1) console.warn(`Diagram file is schema v${v}; this build reads v1 — loading best-effort.`);
    this.nodes.clear();
    this.connections.clear();
    this.groups.clear();
    this.notes.clear();
    this.charts.clear();
    _idSeq = Math.max(_idSeq, data._idSeq || 0);
    this.resourceTypes = (data.resourceTypes || []).map(t => ({ name: t.name, color: t.color }));
    this.variables = { ...(data.variables || {}) };
    this.params = { ...(data.params || {}) };
    // `randomVars` is the pre-rename key for what is now `customVars`.
    this.customVars = (data.customVars || data.randomVars || []).map(r => ({ ...r, values: Array.isArray(r.values) ? [...r.values] : [] }));
    this.timeMode = data.timeMode || 'sync';
    this.seed = data.seed || '';
    this.aiPlayer = data.aiPlayer
      ? { enabled: !!data.aiPlayer.enabled, rules: (data.aiPlayer.rules || []).map(r => ({ ...r })) }
      : { enabled: false, rules: [] };
    this.assertions = [...(data.assertions || [])];
    this.meta = { ...Diagram.defaultMeta(), ...(data.meta || {}) };
    for (const nd of data.nodes) {
      // Constructed with plain defaults: loadJSON checks the file's values against them.
      const node = new MNode(nd.type, 0, 0);
      node.loadJSON(nd);
      this.nodes.set(node.id, node);
    }
    for (const cd of data.connections) {
      const conn = new MConnection(cd.sourceId, cd.targetId, cd.type);
      conn.loadJSON(cd);
      this.connections.set(conn.id, conn);
    }
    for (const gd of (data.groups || [])) {
      const g = new MGroup(0, 0, 40, 30);
      g.loadJSON(gd);
      this.groups.set(g.id, g);
    }
    for (const nd of (data.notes || [])) {
      const note = new MNote(0, 0);
      note.loadJSON(nd);
      this.notes.set(note.id, note);
    }
    for (const cd of (data.charts || [])) {
      const chart = new MChart(0, 0);
      chart.loadJSON(cd);
      this.charts.set(chart.id, chart);
    }
  }
}
