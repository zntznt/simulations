const NodeType = {
  POOL: 'pool',
  SOURCE: 'source',
  DRAIN: 'drain',
  GATE: 'gate',
  CONVERTER: 'converter',
  REGISTER: 'register',
  DELAY: 'delay',
  QUEUE: 'queue',
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

// Grey "uncolored" resource — used when a node holds resources without an
// explicit color (e.g. resources typed directly into the properties panel).
const DEFAULT_COLOR = '#9e9e9e';

const NODE_FILL = {
  pool: '#1a3a6b', source: '#1a4a2a', drain: '#4a1a1a',
  gate: '#3a1a5a', converter: '#4a2a00', register: '#1a2a38', delay: '#004a4a',
  queue: '#2a2a4a',
};

const NODE_STROKE = {
  pool: '#4a9eff', source: '#4caf50', drain: '#ef5350',
  gate: '#ba68c8', converter: '#ffa726', register: '#78909c', delay: '#26c6da',
  queue: '#7c83ff',
};

const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Safely evaluate a math expression against a set of variables.
// Only variables with valid identifier names and finite numeric values are
// exposed, so one bad variable name can't break every formula.
function evalFormula(expr, vars = {}) {
  if (!expr || typeof expr !== 'string' || !expr.trim()) return 0;
  const keys = [], vals = [];
  for (const [k, v] of Object.entries(vars || {})) {
    if (VALID_IDENT.test(k) && typeof v === 'number' && isFinite(v)) {
      keys.push(k); vals.push(v);
    }
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...keys, `"use strict"; return (${expr.trim()});`);
    const r = Number(fn(...vals));
    return isFinite(r) ? r : 0;
  } catch { return 0; }
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
      return fl0((isFinite(p1) ? p1 : 0) + Math.random() * (Math.max(p2, p1) - (isFinite(p1) ? p1 : 0)));
    case 'exponential': {
      const mean = Math.max(0.001, isFinite(p1) ? p1 : 1);
      const r = Math.max(1e-10, Math.random());
      return fl0(-mean * Math.log(r));
    }
    case 'poisson': {
      const lam = Math.max(0, isFinite(p1) ? p1 : 1);
      const L = Math.exp(-lam);
      if (!isFinite(L) || L <= 0) return Math.round(lam);
      let k = 0, p = Math.random();
      while (p > L && k < 10000) { p *= Math.random(); k++; }
      return k;
    }
    case 'normal':
    default: {
      const u1 = Math.max(1e-10, Math.random()), u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const mean = isFinite(p1) ? p1 : 1;
      const std = isFinite(p2) && p2 > 0 ? p2 : 1;
      return fl0(mean + z * std);
    }
  }
}

// Roll XdY dice notation (e.g. "2d6" → 2..12). Plain numbers pass through.
function rollDice(expr) {
  if (expr == null) return 0;
  const s = String(expr).trim().toLowerCase();
  const m = s.match(/^(\d+)\s*d\s*(\d+)$/);
  if (!m) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }
  const count = parseInt(m[1]), sides = parseInt(m[2]);
  if (sides < 1) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += Math.floor(Math.random() * sides) + 1;
  return sum;
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
      this.inputAmount = 1;     // resources consumed per conversion
      this.outputColor = '#ffa726';
    } else if (type === NodeType.DELAY) {
      this.delay = 2;
      this._queue = [];         // [{amount, color, stepsLeft}]
    } else if (type === NodeType.QUEUE) {
      this.processTime = 2;     // steps to process one unit (single-server FIFO)
      this._fifo = [];          // [{amount, color}] waiting, in arrival order
      this._proc = null;        // {color, stepsLeft} unit currently in service
    } else if (type === NodeType.GATE) {
      this.gateMode = 'deterministic';
    }
  }

  get displayCount() {
    if (this.type === NodeType.SOURCE) return this.limited ? this.resources : '∞';
    if (this.type === NodeType.DRAIN) return this.drained || 0;
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
    if (this.type === NodeType.SOURCE) { d.resourceColor = this.resourceColor; d.limited = this.limited || undefined; }
    if (this.type === NodeType.GATE) d.gateMode = this.gateMode;
    if (this.type === NodeType.REGISTER) { d.value = this.value; d.formula = this.formula; }
    if (this.type === NodeType.CONVERTER) { d.inputAmount = this.inputAmount; d.outputColor = this.outputColor; }
    if (this.type === NodeType.DELAY) d.delay = this.delay;
    if (this.type === NodeType.QUEUE) d.processTime = this.processTime;
    return d;
  }

  loadJSON(d) {
    Object.assign(this, d);
    this.capacity = d.capacity == null ? Infinity : d.capacity;
    this.colorMap = { ...(d.colorMap || {}) };
    const infiniteSource = this.type === NodeType.SOURCE && !this.limited;
    this._initialResources = infiniteSource ? Infinity : this.resources;
    this._initialColorMap = { ...this.colorMap };
    if (infiniteSource) { this.resources = Infinity; }
    if (this.type === NodeType.SOURCE) this.produced = 0;
    if (this.type === NodeType.DRAIN) this.drained = 0;
    if (this.type === NodeType.DELAY) this._queue = [];
    if (this.type === NodeType.QUEUE) { this._fifo = []; this._proc = null; }
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
    this.condOperator = '>';  // '>' | '>=' | '<' | '<=' | '==' | '!='
    this.condValue = 0;

    // State connections: variable name written to diagram.variables
    this.variableName = '';

    // Trigger (state connection): fire the target node when the source fires.
    this.trigger = false;

    // Activator (state connection): the target node may only fire while the
    // source value satisfies this condition.
    this.activator = false;
    this.actOperator = '>=';
    this.actValue = 0;

    // Gate output weight (resource connection out of a Gate): relative share
    // for deterministic splits / weighted chance for probabilistic routing.
    this.weight = 1;

    // Modifier (state connection): each step add `modFactor * sourceValue` to
    // the target node's resources (negative = decay). Enables growth / decay /
    // interest in place, without a resource flow.
    this.modifier = false;
    this.modFactor = 1;

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
    this.bendPct = 0.5; // ortho: where the vertical segment sits (0=near src, 1=near tgt)
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
      condRefMode: this.condRefMode !== 'source' ? this.condRefMode : undefined,
      condVariable: this.condVariable || undefined,
      variableName: this.variableName,
      trigger: this.trigger || undefined,
      reverseTrigger: this.reverseTrigger || undefined,
      activator: this.activator || undefined,
      actOperator: this.actOperator, actValue: this.actValue,
      weight: this.weight,
      modifier: this.modifier || undefined,
      modFactor: this.modFactor,
      pathStyle: this.pathStyle !== 'curve' ? this.pathStyle : undefined,
      cpDx: this.cpDx || undefined,
      cpDy: this.cpDy || undefined,
      bendPct: this.bendPct !== 0.5 ? this.bendPct : undefined,
    };
  }

  loadJSON(d) { Object.assign(this, d); return this; }
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
  loadJSON(d) { Object.assign(this, d); return this; }
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
  loadJSON(d) { Object.assign(this, d); return this; }
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
  }
  toJSON() {
    return {
      id: this.id, x: this.x, y: this.y, w: this.w, h: this.h,
      label: this.label, nodeIds: [...this.nodeIds],
    };
  }
  loadJSON(d) { Object.assign(this, d); this.nodeIds = [...(d.nodeIds || [])]; return this; }
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
    // Time mode: 'sync' (turn-based — every automatic node fires each step) or
    // 'async' (real-time — each automatic node fires on its own fireEvery rhythm).
    this.timeMode = 'sync';
    // Artificial player: scripted actor that fires interactive nodes during a
    // run, on an interval or when a variable condition holds.
    this.aiPlayer = { enabled: false, rules: [] };
  }

  addNode(n) { this.nodes.set(n.id, n); return n; }

  removeNode(id) {
    this.nodes.delete(id);
    for (const [cid, c] of this.connections)
      if (c.sourceId === id || c.targetId === id) this.connections.delete(cid);
  }

  addConnection(c) { this.connections.set(c.id, c); return c; }
  removeConnection(id) { this.connections.delete(id); }

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
      timeMode: this.timeMode !== 'sync' ? this.timeMode : undefined,
      aiPlayer: (this.aiPlayer && this.aiPlayer.rules && this.aiPlayer.rules.length)
        ? { enabled: !!this.aiPlayer.enabled, rules: this.aiPlayer.rules.map(r => ({ ...r })) }
        : undefined,
    };
  }

  loadJSON(data) {
    this.nodes.clear();
    this.connections.clear();
    this.groups.clear();
    this.notes.clear();
    this.charts.clear();
    _idSeq = Math.max(_idSeq, data._idSeq || 0);
    this.resourceTypes = (data.resourceTypes || []).map(t => ({ name: t.name, color: t.color }));
    this.variables = { ...(data.variables || {}) };
    this.params = { ...(data.params || {}) };
    this.timeMode = data.timeMode || 'sync';
    this.aiPlayer = data.aiPlayer
      ? { enabled: !!data.aiPlayer.enabled, rules: (data.aiPlayer.rules || []).map(r => ({ ...r })) }
      : { enabled: false, rules: [] };
    for (const nd of data.nodes) {
      const node = new MNode(nd.type, nd.x, nd.y);
      node.loadJSON(nd);
      this.nodes.set(node.id, node);
    }
    for (const cd of data.connections) {
      const conn = new MConnection(cd.sourceId, cd.targetId, cd.type);
      conn.loadJSON(cd);
      this.connections.set(conn.id, conn);
    }
    for (const gd of (data.groups || [])) {
      const g = new MGroup(gd.x, gd.y, gd.w, gd.h);
      g.loadJSON(gd);
      this.groups.set(g.id, g);
    }
    for (const nd of (data.notes || [])) {
      const note = new MNote(nd.x, nd.y);
      note.loadJSON(nd);
      this.notes.set(note.id, note);
    }
    for (const cd of (data.charts || [])) {
      const chart = new MChart(cd.x, cd.y);
      chart.loadJSON(cd);
      this.charts.set(chart.id, chart);
    }
  }
}
