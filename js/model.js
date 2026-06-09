const NodeType = {
  POOL: 'pool',
  SOURCE: 'source',
  DRAIN: 'drain',
  GATE: 'gate',
  CONVERTER: 'converter',
  REGISTER: 'register',
  DELAY: 'delay',
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
};

// Grey "uncolored" resource — used when a node holds resources without an
// explicit color (e.g. resources typed directly into the properties panel).
const DEFAULT_COLOR = '#9e9e9e';

const NODE_FILL = {
  pool: '#1a3a6b', source: '#1a4a2a', drain: '#4a1a1a',
  gate: '#3a1a5a', converter: '#4a2a00', register: '#1a2a38', delay: '#004a4a',
};

const NODE_STROKE = {
  pool: '#4a9eff', source: '#4caf50', drain: '#ef5350',
  gate: '#ba68c8', converter: '#ffa726', register: '#78909c', delay: '#26c6da',
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
    this.resources = 0;
    this.capacity = Infinity;
    this.colorMap = {};       // {colorHex: count}
    this._initialResources = 0;
    this._initialColorMap = {};

    // End / goal condition: when met, the simulation halts (any node type).
    this.endEnabled = false;
    this.endOperator = '>=';
    this.endValue = 0;

    if (type === NodeType.SOURCE) {
      this.resources = Infinity;
      this._initialResources = Infinity;
      this.resourceColor = '#ffa726';
      this.produced = 0;        // total emitted this run (for state connections)
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
    } else if (type === NodeType.GATE) {
      this.gateMode = 'deterministic';
    }
  }

  get displayCount() {
    if (this.type === NodeType.SOURCE) return '∞';
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
    if (this.type === NodeType.SOURCE) return 0;
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
      resources: this.type === NodeType.SOURCE ? 0 : this.resources,
      capacity: this.capacity === Infinity ? null : this.capacity,
      colorMap: Object.keys(this.colorMap).length ? { ...this.colorMap } : undefined,
      endEnabled: this.endEnabled || undefined,
      endOperator: this.endOperator,
      endValue: this.endValue,
    };
    if (this.type === NodeType.SOURCE) d.resourceColor = this.resourceColor;
    if (this.type === NodeType.GATE) d.gateMode = this.gateMode;
    if (this.type === NodeType.REGISTER) { d.value = this.value; d.formula = this.formula; }
    if (this.type === NodeType.CONVERTER) { d.inputAmount = this.inputAmount; d.outputColor = this.outputColor; }
    if (this.type === NodeType.DELAY) d.delay = this.delay;
    return d;
  }

  loadJSON(d) {
    Object.assign(this, d);
    this.capacity = d.capacity == null ? Infinity : d.capacity;
    this.colorMap = { ...(d.colorMap || {}) };
    this._initialResources = this.type === NodeType.SOURCE ? Infinity : this.resources;
    this._initialColorMap = { ...this.colorMap };
    if (this.type === NodeType.SOURCE) { this.resources = Infinity; this.produced = 0; }
    if (this.type === NodeType.DRAIN) this.drained = 0;
    if (this.type === NodeType.DELAY) this._queue = [];
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
  }

  toJSON() {
    return {
      id: this.id, sourceId: this.sourceId, targetId: this.targetId,
      type: this.type, label: this.label,
      rateMode: this.rateMode, rate: this.rate, dice: this.dice, formula: this.formula,
      interval: this.interval, chance: this.chance,
      colorFilter: this.colorFilter,
      condEnabled: this.condEnabled, condOperator: this.condOperator, condValue: this.condValue,
      variableName: this.variableName,
      trigger: this.trigger || undefined,
      activator: this.activator || undefined,
      actOperator: this.actOperator, actValue: this.actValue,
      weight: this.weight,
    };
  }

  loadJSON(d) { Object.assign(this, d); return this; }
}

class Diagram {
  constructor() {
    this.nodes = new Map();
    this.connections = new Map();
    this.variables = {};  // shared store, refreshed each step from state connections
  }

  addNode(n) { this.nodes.set(n.id, n); return n; }

  removeNode(id) {
    this.nodes.delete(id);
    for (const [cid, c] of this.connections)
      if (c.sourceId === id || c.targetId === id) this.connections.delete(cid);
  }

  addConnection(c) { this.connections.set(c.id, c); return c; }
  removeConnection(id) { this.connections.delete(id); }

  outgoing(nodeId) { return [...this.connections.values()].filter(c => c.sourceId === nodeId); }
  incoming(nodeId) { return [...this.connections.values()].filter(c => c.targetId === nodeId); }

  toJSON() {
    return {
      _idSeq,
      nodes: [...this.nodes.values()].map(n => n.toJSON()),
      connections: [...this.connections.values()].map(c => c.toJSON()),
      variables: { ...this.variables },
    };
  }

  loadJSON(data) {
    this.nodes.clear();
    this.connections.clear();
    _idSeq = Math.max(_idSeq, data._idSeq || 0);
    this.variables = { ...(data.variables || {}) };
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
  }
}
