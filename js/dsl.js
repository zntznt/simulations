// Economy-as-code: the .econ text format.
//
// A human-readable, diff-friendly projection of the diagram JSON. dslSerialize
// turns Diagram.toJSON() output into text; dslParse turns text back into JSON
// ready for Diagram.loadJSON(). Round-trip fidelity is an invariant guarded by
// test/run.js: serialize→parse→serialize must be a fixpoint, and the parsed
// JSON must be semantically identical to the original up to id renaming and
// runtime fields (see normalizeEconJSON).
//
// DOM-free on purpose (same contract as model.js/engine.js): this file is
// loaded by the browser, by cli.js and by test/run.js. It references the
// model globals (MNode, MConnection, NodeType, …), so it must load after
// model.js in every context.
//
// ── Format overview ─────────────────────────────────────────────────────────
//
//   economy v1                      // header (optional but always emitted)
//   name: Widget Factory            // diagram meta, rest-of-line
//   desc: One line with \n escapes
//   seed: 42
//   timeMode: async
//   meta scheme=ocean bgColor=#101318
//   param mine_rate = 3
//   type Wood = #8d6e63             // named resource types
//   var luck = dice(2d6) gaussian   // custom variables
//   var boost = math(gold * 0.1) per=play
//   player enabled rules=[{...}]    // artificial player (rules as JSON)
//
//   pool Gold @ 240,180 = 50 of #ffd54f cap=500 goal >= 400
//   source Mine @ 80,180 color=Wood
//   converter Forge @ 400,180 recipe(2 Wood, 1 #b0bec5) out=#ffa726
//   register Score @ 560,60 = "gold * 2"
//
//   Mine -> Gold : 2 every=3 40% if="self < 100"
//   Gold -> Forge : (mine_rate * 2) color=Wood
//   Gold ~> Score name=gold
//   Forge ~> Mine trigger triggerChance=50
//
//   group "Economy" @ 60,40 520x300 color=#4a9eff
//   note @ 620,40 160x80 "Balance me"
//   chart "Gold over time" @ 620,160 240x150 type=area tracks=Gold,Score
//
// Lines are independent; `//` starts a comment (never `#`, which is a color).
// Node references are labels, quoted when not bare identifiers, with `#N`
// suffixes disambiguating duplicate labels in declaration order. Everything
// not covered by sugar round-trips as generic key=value attributes, diffed
// against the model constructors' defaults so only non-default fields appear.

/* exported dslSerialize, dslParse, normalizeEconJSON */

const ECON_NODE_KINDS = ['pool', 'source', 'drain', 'gate', 'converter', 'register', 'delay', 'queue', 'trader'];

// Attribute aliases: short DSL names for common JSON fields, per line kind.
const ECON_NODE_ALIAS = {
  cap: 'capacity', in: 'inputAmount', out: 'outputColor', color: 'resourceColor',
  mode: 'gateMode', time: 'processTime', every: 'fireEvery', phase: 'firePhase',
};
const ECON_CONN_ALIAS = {
  every: 'interval', color: 'colorFilter', name: 'variableName',
};
const ECON_ACTIVATIONS = ['automatic', 'passive', 'interactive', 'starting'];

// ── Small text helpers ──────────────────────────────────────────────────────

function _econIsBare(s) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s); }

function _econQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
}

function _econName(s) { return _econIsBare(s) ? s : _econQuote(s); }

function _econUnescape(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
}

// Format a number exactly (String round-trips JS doubles).
function _econNum(n) { return String(n); }

// ── Tokenizer ───────────────────────────────────────────────────────────────
// Split a line into whitespace-separated tokens, except inside double quotes,
// parentheses, brackets or braces (so `recipe(2 Wood, 1 Stone)`, `(gold * 2)`
// and rules=[{"a":"hi there"}] each stay one token). Also strips `//` comments
// at depth 0 outside quotes.

function _econTokens(line, lineNo) {
  const tokens = [];
  let cur = '', depth = 0, inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      cur += ch;
      if (ch === '\\') { cur += line[++i] ?? ''; continue; }
      if (ch === '"') inQ = false;
      continue;
    }
    if (ch === '"') { inQ = true; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; continue; }
    if (depth === 0 && ch === '/' && line[i + 1] === '/' && (cur === '' || /\s/.test(line[i - 1] || ' '))) break;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (inQ || depth !== 0) throw _econErr(`unbalanced quotes or brackets`, lineNo);
  if (cur) tokens.push(cur);
  return tokens;
}

function _econErr(msg, lineNo) {
  const e = new Error(`.econ line ${lineNo}: ${msg}`);
  e.line = lineNo;
  return e;
}

// ── Attribute value encoding ────────────────────────────────────────────────

function _econAttrValue(v) {
  if (typeof v === 'number') return _econNum(v);
  if (typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s) || !/^[^\s"=]+$/.test(s) || s === '' ||
      s === 'true' || s === 'false' || s === 'null' || /^[[{(]/.test(s)) return _econQuote(s);
  return s;
}

function _econParseValue(raw, lineNo) {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) throw _econErr(`bad string ${raw}`, lineNo);
    return _econUnescape(raw.slice(1, -1));
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try { return JSON.parse(raw); }
    catch (e) { throw _econErr(`bad JSON value: ${e.message}`, lineNo); }
  }
  const n = Number(raw);
  if (raw !== '' && isFinite(n) && /^[-+.\d]/.test(raw)) return n;
  return raw; // bare word (color hex, identifier, …)
}

// ── Serializer ──────────────────────────────────────────────────────────────

// Assign every node a unique, human-readable reference name derived from its
// label, disambiguating duplicates with #2, #3, … in declaration order.
function _econRefNames(nodes) {
  const used = new Map(); // base label → count
  const refs = new Map(); // node id → ref string
  for (const n of nodes) {
    const base = n.label != null ? String(n.label) : '';
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    refs.set(n.id, _econName(base) + (count > 1 ? '#' + count : ''));
  }
  return refs;
}

// Non-default fields of `obj` vs a freshly constructed default, as attr text.
// `skip` holds keys already covered by sugar or structure. Uses JSON-level
// comparison so objects/arrays compare by value. Booleans are emitted as
// key=true/false (never bare flags) so the parser needs no per-key knowledge.
function _econExtraAttrs(obj, defaults, skip, alias) {
  const rev = {};
  for (const [short, full] of Object.entries(alias || {})) rev[full] = short;
  const out = [];
  for (const key of Object.keys(obj)) {
    if (skip.has(key)) continue;
    const v = obj[key];
    if (v === undefined) continue;
    if (JSON.stringify(v) === JSON.stringify(defaults[key])) continue;
    out.push(`${rev[key] || key}=${_econAttrValue(v)}`);
  }
  return out;
}

// Preferred color spelling: a declared resource-type name when one matches,
// else the raw hex.
function _econColorRef(color, types) {
  if (!color) return color;
  const t = (types || []).find(t => t.color && t.color.toLowerCase() === String(color).toLowerCase());
  return t && t.name ? _econName(t.name) : color;
}

function dslSerialize(json) {
  const out = [];
  const types = json.resourceTypes || [];
  const meta = json.meta || {};
  out.push('economy v1');
  if (meta.name) out.push(`name: ${meta.name}`);
  if (meta.description) out.push(`desc: ${meta.description.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
  if (json.seed) out.push(`seed: ${json.seed}`);
  if (json.timeMode && json.timeMode !== 'sync') out.push(`timeMode: ${json.timeMode}`);
  {
    const extras = [];
    if (meta.scheme && meta.scheme !== 'default') extras.push(`scheme=${_econAttrValue(meta.scheme)}`);
    if (meta.bgColor) extras.push(`bgColor=${_econAttrValue(meta.bgColor)}`);
    if (meta.font) extras.push(`font=${_econAttrValue(meta.font)}`);
    if (extras.length) out.push(`meta ${extras.join(' ')}`);
  }
  for (const [k, v] of Object.entries(json.params || {})) out.push(`param ${k} = ${_econNum(v)}`);
  for (const t of types) out.push(`type ${_econName(t.name || '')} = ${t.color}`);
  for (const rv of json.customVars || []) {
    let kind;
    if (rv.kind === 'math') kind = `math(${rv.formula || ''})`;
    else if (rv.kind === 'dice') kind = `dice(${rv.dice || '1d6'})`;
    else if (rv.kind === 'array') kind = `array(${(rv.values || []).join(', ')})`;
    else kind = `interval(${_econNum(rv.min ?? 0)}, ${_econNum(rv.max ?? 0)})`;
    const parts = [`var ${_econName(rv.name || '')} = ${kind}`];
    if (rv.dist === 'gaussian') parts.push('gaussian');
    if ((rv.update || 'step') !== 'step') parts.push(`per=${rv.update}`);
    out.push(parts.join(' '));
  }
  if (json.aiPlayer && (json.aiPlayer.rules || []).length) {
    const parts = ['player'];
    if (json.aiPlayer.enabled) parts.push('enabled');
    parts.push(`rules=${JSON.stringify(json.aiPlayer.rules)}`);
    out.push(parts.join(' '));
  }

  const nodes = json.nodes || [];
  const refs = _econRefNames(nodes);
  if (nodes.length) out.push('');

  for (const n of nodes) {
    const def = new MNode(n.type, 0, 0).toJSON();
    const skip = new Set(['id', 'type', 'x', 'y', 'label']);
    const parts = [n.type, refs.get(n.id), `@ ${_econNum(n.x)},${_econNum(n.y)}`];

    // Start amount: `= N [of color]` when the colorMap is empty or a single
    // entry matching the count; multi-color maps fall through to a generic attr.
    const cm = n.colorMap || {};
    const cmKeys = Object.keys(cm);
    const single = cmKeys.length === 1 && cm[cmKeys[0]] === n.resources;
    if (n.type === 'register') {
      if (n.formula) { parts.push(`= ${_econQuote(n.formula)}`); skip.add('formula'); }
      else if (n.value) { parts.push(`= ${_econNum(n.value)}`); skip.add('value'); }
    } else if (n.resources > 0 && isFinite(n.resources) && (cmKeys.length === 0 || single)) {
      let sugar = `= ${_econNum(n.resources)}`;
      if (single && cmKeys[0] !== DEFAULT_COLOR) sugar += ` of ${_econColorRef(cmKeys[0], types)}`;
      parts.push(sugar);
      skip.add('resources'); skip.add('colorMap');
    }

    if (n.capacity != null && isFinite(n.capacity)) { parts.push(`cap=${_econNum(n.capacity)}`); skip.add('capacity'); }
    if (n.endEnabled) {
      parts.push(`goal ${n.endOperator || '>='} ${_econNum(n.endValue || 0)}`);
      skip.add('endEnabled'); skip.add('endOperator'); skip.add('endValue');
    }
    if (n.activation && n.activation !== 'automatic') { parts.push(n.activation); skip.add('activation'); }
    if (n.flowMode === 'pull') {
      parts.push(n.pullPolicy === 'all' ? 'pull=all' : 'pull');
      skip.add('flowMode'); skip.add('pullPolicy');
    }
    if (n.type === 'source') {
      if (n.limited) { parts.push('limited'); skip.add('limited'); }
      if (n.resourceColor && n.resourceColor !== def.resourceColor) {
        parts.push(`color=${_econColorRef(n.resourceColor, types)}`); skip.add('resourceColor');
      }
    }
    if (n.type === 'converter' && Array.isArray(n.inputRecipe) && n.inputRecipe.length) {
      const items = n.inputRecipe.map(i => `${_econNum(i.amount ?? 1)} ${_econColorRef(i.color, types)}`);
      parts.push(`recipe(${items.join(', ')})`);
      skip.add('inputRecipe');
      if (n.inputAmount !== def.inputAmount) { parts.push(`in=${_econNum(n.inputAmount)}`); skip.add('inputAmount'); }
      if (n.outputColor !== def.outputColor) { parts.push(`out=${_econColorRef(n.outputColor, types)}`); skip.add('outputColor'); }
    } else if (n.type === 'converter') {
      if (n.inputAmount !== def.inputAmount) { parts.push(`in=${_econNum(n.inputAmount)}`); skip.add('inputAmount'); }
      if (n.outputColor !== def.outputColor) { parts.push(`out=${_econColorRef(n.outputColor, types)}`); skip.add('outputColor'); }
      skip.add('inputRecipe');
    }
    // Everything else (gateMode, delay, queue fields, fireEvery, …) rides the
    // generic default-diff below, with short alias names where defined.
    parts.push(..._econExtraAttrs(n, def, skip, ECON_NODE_ALIAS));
    out.push(parts.join(' '));
  }

  for (const g of json.groups || []) {
    const parts = ['group', _econQuote(g.label ?? ''), `@ ${_econNum(g.x)},${_econNum(g.y)}`, `${_econNum(g.w)}x${_econNum(g.h)}`];
    if (g.color && g.color !== '#4a9eff') parts.push(`color=${g.color}`);
    out.push(parts.join(' '));
  }
  for (const nt of json.notes || []) {
    const parts = ['note', `@ ${_econNum(nt.x)},${_econNum(nt.y)}`, `${_econNum(nt.w)}x${_econNum(nt.h)}`];
    if (nt.color && nt.color !== '#f6e05e') parts.push(`color=${nt.color}`);
    parts.push(_econQuote(nt.text ?? ''));
    out.push(parts.join(' '));
  }
  for (const ch of json.charts || []) {
    const parts = ['chart', _econQuote(ch.label ?? ''), `@ ${_econNum(ch.x)},${_econNum(ch.y)}`, `${_econNum(ch.w)}x${_econNum(ch.h)}`];
    if (ch.chartType && ch.chartType !== 'line') parts.push(`type=${ch.chartType}`);
    const tracked = (ch.nodeIds || []).map(id => refs.get(id)).filter(Boolean);
    if (tracked.length) parts.push(`tracks=${tracked.join(',')}`);
    out.push(parts.join(' '));
  }

  const conns = json.connections || [];
  if (conns.length) out.push('');
  for (const c of conns) {
    const def = new MConnection('', '', c.type).toJSON();
    const skip = new Set(['id', 'sourceId', 'targetId', 'type']);
    const arrow = c.type === 'state' ? '~>' : '->';
    const from = refs.get(c.sourceId), to = refs.get(c.targetId);
    if (!from || !to) continue; // dangling connection: not representable, drop
    const parts = [from, arrow, to];

    if (c.type !== 'state') {
      // Rate sugar covers the active mode; inactive-mode fields that differ
      // from defaults still round-trip via generic attrs below.
      const mode = c.rateMode || 'fixed';
      if (mode === 'fixed' && c.rate !== 1) { parts.push(`: ${_econNum(c.rate)}`); skip.add('rate'); skip.add('rateMode'); }
      else if (mode === 'fixed') { skip.add('rateMode'); }
      else if (mode === 'dice') { parts.push(`: ${c.dice || '1d6'}`); skip.add('dice'); skip.add('rateMode'); }
      else if (mode === 'formula' && c.formula) { parts.push(`: (${c.formula})`); skip.add('formula'); skip.add('rateMode'); }
      else if (mode === 'distribution') {
        parts.push(`: ~${c.distType || 'normal'}(${_econNum(c.distParam1 ?? 5)}, ${_econNum(c.distParam2 ?? 2)})`);
        skip.add('distType'); skip.add('distParam1'); skip.add('distParam2'); skip.add('rateMode');
      }
    }
    if (c.interval && c.interval !== 1) { parts.push(`every=${_econNum(c.interval)}`); skip.add('interval'); }
    if (c.chance !== undefined && c.chance !== 100) { parts.push(`${_econNum(c.chance)}%`); skip.add('chance'); }
    if (c.colorFilter) { parts.push(`color=${_econColorRef(c.colorFilter, types)}`); skip.add('colorFilter'); }
    if (c.condEnabled) {
      const ref = (c.condRefMode === 'variable' && c.condVariable) ? c.condVariable : 'self';
      const tail = c.condOperator === 'between' ? `${_econNum(c.condValue)} ${_econNum(c.condValue2 || 0)}` : _econNum(c.condValue);
      parts.push(`if=${_econQuote(`${ref} ${c.condOperator} ${tail}`)}`);
      for (const k of ['condEnabled', 'condOperator', 'condValue', 'condValue2', 'condRefMode', 'condVariable']) skip.add(k);
    }
    if (c.variableName) { parts.push(`name=${_econAttrValue(c.variableName)}`); skip.add('variableName'); }
    if (c.trigger) { parts.push('trigger'); skip.add('trigger'); }
    if (c.reverseTrigger) { parts.push('reverseTrigger'); skip.add('reverseTrigger'); }
    if (c.activator) {
      const tail = c.actOperator === 'between' ? `${_econNum(c.actValue)} ${_econNum(c.actValue2 || 0)}` : _econNum(c.actValue);
      parts.push(`act=${_econQuote(`${c.actOperator} ${tail}`)}`);
      for (const k of ['activator', 'actOperator', 'actValue', 'actValue2']) skip.add(k);
    }
    if (c.modifier) {
      const mode = c.modMode || 'rate';
      const amount = c.modFormula ? `(${c.modFormula})` : _econNum(c.modFactor ?? 1);
      parts.push(`mod=${_econQuote(`${mode} ${amount}`)}`);
      for (const k of ['modifier', 'modMode', 'modFactor', 'modFormula']) skip.add(k);
    }
    if (c.weightFormula) { parts.push(`weight=(${c.weightFormula})`); skip.add('weightFormula'); skip.add('weight'); }
    else if (c.weight !== undefined && c.weight !== 1) { parts.push(`weight=${_econNum(c.weight)}`); skip.add('weight'); }
    if (c.label) { parts.push(`label=${_econAttrValue(c.label)}`); skip.add('label'); }
    parts.push(..._econExtraAttrs(c, def, skip, ECON_CONN_ALIAS));
    out.push(parts.join(' '));
  }
  return out.join('\n') + '\n';
}

// ── Parser ──────────────────────────────────────────────────────────────────

// Read a name token: `Gold`, `"Gold Mine"`, optionally with a `#N` suffix.
// Returns { name, ord } where ord is the 1-based duplicate index.
function _econReadRef(token, lineNo) {
  let name, rest;
  if (token.startsWith('"')) {
    const end = _econFindCloseQuote(token, lineNo);
    name = _econUnescape(token.slice(1, end));
    rest = token.slice(end + 1);
  } else {
    const m = token.match(/^([^#]*)(#\d+)?$/);
    name = m ? m[1] : token;
    rest = m && m[2] ? m[2] : '';
  }
  let ord = 1;
  if (rest) {
    const m = rest.match(/^#(\d+)$/);
    if (!m) throw _econErr(`bad reference suffix in ${token}`, lineNo);
    ord = parseInt(m[1], 10);
  }
  return { name, ord };
}

function _econFindCloseQuote(token, lineNo) {
  for (let i = 1; i < token.length; i++) {
    if (token[i] === '\\') { i++; continue; }
    if (token[i] === '"') return i;
  }
  throw _econErr(`unterminated string ${token}`, lineNo);
}

// Split `key=value` (value may be quoted / JSON / parenthesized). Returns
// null when the token has no top-level `=`.
function _econSplitAttr(token) {
  if (token.startsWith('"')) return null;
  const i = token.indexOf('=');
  if (i <= 0) return null;
  const key = token.slice(0, i);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return { key, raw: token.slice(i + 1) };
}

// Split a comma-separated list at depth 0 (for recipe items, tracks, arrays).
function _econSplitList(s) {
  const parts = [];
  let cur = '', depth = 0, inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) { cur += ch; if (ch === '\\') { cur += s[++i] ?? ''; } else if (ch === '"') inQ = false; continue; }
    if (ch === '"') { inQ = true; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function dslParse(text) {
  const json = {
    version: 1,
    nodes: [], connections: [], groups: undefined, notes: undefined, charts: undefined,
    resourceTypes: undefined, variables: {}, params: undefined, customVars: undefined,
    timeMode: undefined, seed: undefined, aiPlayer: undefined,
    meta: { name: '', description: '', bgColor: '', scheme: 'default', font: '', thumbnail: '', created: 0, modified: 0 },
  };
  const types = [];       // {name, color}
  const params = {};
  const customVars = [];
  const groups = [], notes = [], charts = [];
  const nodeRefs = new Map();   // "name ord" → node json
  const nodeOrder = [];
  const pendingConns = [];      // resolved after all nodes are known
  const pendingCharts = [];

  const colorOf = (tok, lineNo) => {
    // A color reference: raw value (hex or anything else), or a declared
    // resource-type name (bare or quoted).
    const v = tok.startsWith('"') ? _econUnescape(tok.slice(1, -1)) : tok;
    const t = types.find(t => t.name === v);
    return t ? t.color : v;
  };

  const lines = String(text).split(/\r?\n/);
  let sawAny = false;

  for (let li = 0; li < lines.length; li++) {
    const lineNo = li + 1;
    const rawLine = lines[li];
    // Rest-of-line directives are handled before tokenizing (their payload is
    // free text, not tokens).
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const dm = trimmed.match(/^(name|desc|seed|timeMode)\s*:\s*(.*)$/);
    if (dm) {
      const v = dm[2].trim();
      if (dm[1] === 'name') json.meta.name = v;
      else if (dm[1] === 'desc') json.meta.description = _econUnescape(v);
      else if (dm[1] === 'seed') json.seed = v;
      else if (dm[1] === 'timeMode') json.timeMode = v;
      sawAny = true;
      continue;
    }

    const tokens = _econTokens(trimmed, lineNo);
    if (!tokens.length) continue;
    const head = tokens[0];
    sawAny = true;

    if (head === 'economy') continue; // version header; v1 is the only version

    if (head === 'meta') {
      for (const t of tokens.slice(1)) {
        const a = _econSplitAttr(t);
        if (!a) throw _econErr(`meta expects key=value, got ${t}`, lineNo);
        json.meta[a.key] = _econParseValue(a.raw, lineNo);
      }
      continue;
    }

    if (head === 'param') {
      // param name = value
      const m = tokens.slice(1).join(' ').match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.+)$/);
      if (!m) throw _econErr(`param expects name = number`, lineNo);
      const v = Number(m[2]);
      if (!isFinite(v)) throw _econErr(`param ${m[1]} is not a number: ${m[2]}`, lineNo);
      params[m[1]] = v;
      continue;
    }

    if (head === 'type') {
      const m = tokens.slice(1).join(' ').match(/^(.+?)\s*=\s*(\S+)$/);
      if (!m) throw _econErr(`type expects Name = #color`, lineNo);
      const name = m[1].startsWith('"') ? _econUnescape(m[1].slice(1, -1)) : m[1];
      types.push({ name, color: m[2] });
      continue;
    }

    if (head === 'var') {
      const joined = tokens.slice(1).join(' ');
      const m = joined.match(/^(.+?)\s*=\s*(interval|array|dice|math)\((.*)\)\s*(.*)$/);
      if (!m) throw _econErr(`var expects name = kind(args)`, lineNo);
      const name = m[1].startsWith('"') ? _econUnescape(m[1].slice(1, -1)) : m[1];
      const rv = { name, kind: m[2] === 'interval' ? 'interval' : m[2], dist: 'uniform', update: 'step' };
      if (m[2] === 'math') rv.formula = m[3].trim();
      else if (m[2] === 'dice') rv.dice = m[3].trim();
      else if (m[2] === 'array') rv.values = _econSplitList(m[3]).map(Number).filter(isFinite);
      else {
        const args = _econSplitList(m[3]).map(Number);
        rv.min = isFinite(args[0]) ? args[0] : 0;
        rv.max = isFinite(args[1]) ? args[1] : 0;
      }
      for (const t of (m[4] ? _econTokens(m[4], lineNo) : [])) {
        if (t === 'gaussian') rv.dist = 'gaussian';
        else if (t === 'uniform') rv.dist = 'uniform';
        else {
          const a = _econSplitAttr(t);
          if (!a) throw _econErr(`unknown var modifier ${t}`, lineNo);
          rv[a.key === 'per' ? 'update' : a.key] = _econParseValue(a.raw, lineNo);
        }
      }
      customVars.push(rv);
      continue;
    }

    if (head === 'player') {
      const p = { enabled: false, rules: [] };
      for (const t of tokens.slice(1)) {
        if (t === 'enabled') { p.enabled = true; continue; }
        const a = _econSplitAttr(t);
        if (!a) throw _econErr(`player expects key=value or enabled, got ${t}`, lineNo);
        p[a.key] = _econParseValue(a.raw, lineNo);
      }
      json.aiPlayer = p;
      continue;
    }

    if (head === 'group' || head === 'note' || head === 'chart') {
      let i = 1;
      const el = { kind: head, label: '', x: 0, y: 0, w: head === 'note' ? 160 : (head === 'chart' ? 240 : 200), h: head === 'note' ? 80 : (head === 'chart' ? 150 : 140) };
      if (head !== 'note' && tokens[i] && tokens[i].startsWith('"')) { el.label = _econUnescape(tokens[i].slice(1, -1)); i++; }
      const rest = [];
      for (; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '@') { const p = (tokens[++i] || '').split(','); el.x = Number(p[0]); el.y = Number(p[1]); continue; }
        const sz = t.match(/^(-?[\d.]+)x(-?[\d.]+)$/);
        if (sz) { el.w = Number(sz[1]); el.h = Number(sz[2]); continue; }
        rest.push(t);
      }
      for (const t of rest) {
        if (t.startsWith('"') && head === 'note') { el.text = _econUnescape(t.slice(1, -1)); continue; }
        const a = _econSplitAttr(t);
        if (!a) throw _econErr(`unexpected token ${t}`, lineNo);
        if (head === 'chart' && a.key === 'tracks') { el.tracks = _econSplitList(a.raw); continue; }
        if (head === 'chart' && a.key === 'type') { el.chartType = String(_econParseValue(a.raw, lineNo)); continue; }
        el[a.key] = _econParseValue(a.raw, lineNo);
      }
      if (head === 'group') groups.push(el);
      else if (head === 'note') notes.push(el);
      else { charts.push(el); pendingCharts.push({ el, lineNo }); }
      continue;
    }

    if (ECON_NODE_KINDS.includes(head)) {
      const nd = _econParseNodeLine(head, tokens, lineNo, colorOf);
      const key = nd.label + ' ' + nd._ord;
      if (nodeRefs.has(key)) throw _econErr(`duplicate node reference ${nd.label}#${nd._ord}`, lineNo);
      nodeRefs.set(key, nd);
      nodeOrder.push(nd);
      continue;
    }

    // Connection line: <ref> -> <ref> … or <ref> ~> <ref> …
    const arrowIdx = tokens.findIndex(t => t === '->' || t === '~>');
    if (arrowIdx > 0) {
      pendingConns.push({ tokens, arrowIdx, lineNo });
      continue;
    }
    throw _econErr(`unrecognized line: ${trimmed.slice(0, 60)}`, lineNo);
  }

  if (!sawAny) throw new Error('.econ: empty document');

  // Assign deterministic ids and build the resolver.
  const resolve = (refTok, lineNo) => {
    const { name, ord } = _econReadRef(refTok, lineNo);
    const nd = nodeRefs.get(name + ' ' + ord);
    if (!nd) throw _econErr(`unknown node reference ${refTok}`, lineNo);
    return nd.id;
  };
  nodeOrder.forEach((nd, i) => { nd.id = 'n' + (i + 1); delete nd._ord; });

  let connSeq = 0;
  for (const { tokens, arrowIdx, lineNo } of pendingConns) {
    if (arrowIdx !== 1) throw _econErr(`expected <ref> ${tokens[arrowIdx]} <ref>`, lineNo);
    const cd = _econParseConnLine(tokens, arrowIdx, lineNo, resolve, colorOf);
    cd.id = 'c' + (++connSeq);
    // Canonicalize through the model class so default-suppressed fields come
    // out exactly as the app itself would save them.
    json.connections.push(new MConnection(cd.sourceId, cd.targetId, cd.type).loadJSON(cd).toJSON());
  }

  json.nodes = nodeOrder.map(nd => new MNode(nd.type, nd.x, nd.y).loadJSON(nd).toJSON());
  if (groups.length) json.groups = groups.map((g, i) => ({ id: 'g' + (i + 1), x: g.x, y: g.y, w: g.w, h: g.h, label: g.label || 'Group', color: g.color || '#4a9eff' }));
  if (notes.length) json.notes = notes.map((n, i) => ({ id: 't' + (i + 1), x: n.x, y: n.y, w: n.w, h: n.h, text: n.text || '', color: n.color || '#f6e05e' }));
  if (charts.length) {
    json.charts = charts.map((c, i) => {
      const d = { id: 'ch' + (i + 1), x: c.x, y: c.y, w: c.w, h: c.h, label: c.label || 'Chart', nodeIds: [] };
      if (c.chartType && c.chartType !== 'line') d.chartType = c.chartType;
      return d;
    });
    for (let i = 0; i < pendingCharts.length; i++) {
      const { el, lineNo } = pendingCharts[i];
      const d = json.charts[charts.indexOf(el)];
      d.nodeIds = (el.tracks || []).map(r => resolve(r, lineNo));
    }
  }
  if (types.length) json.resourceTypes = types;
  if (Object.keys(params).length) json.params = params;
  if (customVars.length) json.customVars = customVars;
  // Round through JSON text so the result carries no undefined-valued keys —
  // the same shape a saved file would have after JSON.parse.
  return JSON.parse(JSON.stringify(json));
}

function _econParseNodeLine(kind, tokens, lineNo, colorOf) {
  const nd = new MNode(kind, 0, 0).toJSON();
  nd.id = ''; // assigned after all nodes parse
  let i = 1;
  if (i >= tokens.length) throw _econErr(`${kind} needs a name`, lineNo);
  const ref = _econReadRef(tokens[i++], lineNo);
  nd.label = ref.name;
  nd._ord = ref.ord;

  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '@') {
      const p = (tokens[++i] || '').split(',');
      nd.x = Number(p[0]); nd.y = Number(p[1]);
      if (!isFinite(nd.x) || !isFinite(nd.y)) throw _econErr(`bad position after @`, lineNo);
      i++;
      continue;
    }
    if (t === '=') {
      const v = tokens[++i];
      if (v === undefined) throw _econErr(`= needs a value`, lineNo);
      if (kind === 'register') {
        if (v.startsWith('"')) nd.formula = _econUnescape(v.slice(1, -1));
        else nd.value = Number(v);
      } else {
        const amount = Number(v);
        if (!isFinite(amount)) throw _econErr(`bad start amount ${v}`, lineNo);
        nd.resources = amount;
        let color = kind === 'source' ? null : DEFAULT_COLOR;
        if (tokens[i + 1] === 'of') { color = colorOf(tokens[i + 2] || '', lineNo); i += 2; }
        if (kind !== 'source' && amount > 0) nd.colorMap = { [color]: amount };
      }
      i++;
      continue;
    }
    if (t === 'goal') {
      nd.endEnabled = true;
      nd.endOperator = tokens[++i] || '>=';
      nd.endValue = Number(tokens[++i] || 0);
      i++;
      continue;
    }
    if (t.startsWith('recipe(') && kind === 'converter') {
      const inner = t.slice('recipe('.length, -1);
      nd.inputRecipe = _econSplitList(inner).map(item => {
        const m = item.match(/^([\d.]+)\s+(.+)$/);
        if (!m) throw _econErr(`recipe item "${item}" expects: amount color`, lineNo);
        return { color: colorOf(m[2].trim(), lineNo), amount: Number(m[1]) };
      });
      i++;
      continue;
    }
    if (ECON_ACTIVATIONS.includes(t)) { nd.activation = t; i++; continue; }
    if (t === 'pull') { nd.flowMode = 'pull'; i++; continue; }
    if (t === 'limited' && kind === 'source') { nd.limited = true; i++; continue; }
    const a = _econSplitAttr(t);
    if (!a) throw _econErr(`unexpected token ${t}`, lineNo);
    if (a.key === 'pull') { nd.flowMode = 'pull'; nd.pullPolicy = String(_econParseValue(a.raw, lineNo)); i++; continue; }
    const key = ECON_NODE_ALIAS[a.key] || a.key;
    let val = _econParseValue(a.raw, lineNo);
    if (key === 'resourceColor' || key === 'outputColor') val = colorOf(a.raw, lineNo);
    nd[key] = val;
    i++;
  }
  // Sources keep their stock in `resources` only when limited; the JSON shape
  // mirrors MNode.toJSON (resources 0 for unlimited).
  if (kind === 'source' && !nd.limited) nd.resources = 0;
  return nd;
}

function _econParseConnLine(tokens, arrowIdx, lineNo, resolve, colorOf) {
  const type = tokens[arrowIdx] === '~>' ? 'state' : 'resource';
  const cd = new MConnection('', '', type).toJSON();
  cd.sourceId = resolve(tokens[0], lineNo);
  cd.targetId = resolve(tokens[arrowIdx + 1], lineNo);

  let i = arrowIdx + 2;
  // Rate clause: `: <number | XdY | (formula) | ~dist(p1[,p2])>`
  if (tokens[i] === ':') {
    const r = tokens[++i];
    if (r === undefined) throw _econErr(`rate expected after :`, lineNo);
    if (/^\d+\s*d\s*\d+$/i.test(r)) { cd.rateMode = 'dice'; cd.dice = r.toLowerCase(); }
    else if (r.startsWith('(') && r.endsWith(')')) { cd.rateMode = 'formula'; cd.formula = r.slice(1, -1).trim(); }
    else if (r.startsWith('~')) {
      const m = r.match(/^~([a-z]+)\((.*)\)$/i);
      if (!m) throw _econErr(`bad distribution rate ${r}`, lineNo);
      cd.rateMode = 'distribution';
      cd.distType = m[1].toLowerCase();
      const args = _econSplitList(m[2]).map(Number);
      if (isFinite(args[0])) cd.distParam1 = args[0];
      if (isFinite(args[1])) cd.distParam2 = args[1];
    } else {
      const n = Number(r);
      if (!isFinite(n)) throw _econErr(`bad rate ${r}`, lineNo);
      cd.rateMode = 'fixed'; cd.rate = n;
    }
    i++;
  }

  for (; i < tokens.length; i++) {
    const t = tokens[i];
    const pct = t.match(/^([\d.]+)%$/);
    if (pct) { cd.chance = Number(pct[1]); continue; }
    if (t === 'trigger') { cd.trigger = true; continue; }
    if (t === 'reverseTrigger') { cd.reverseTrigger = true; continue; }
    const a = _econSplitAttr(t);
    if (!a) throw _econErr(`unexpected token ${t}`, lineNo);
    const raw = a.raw;
    if (a.key === 'if') {
      const s = String(_econParseValue(raw, lineNo));
      const m = s.match(/^(\S+)\s+(\S+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?$/);
      if (!m) throw _econErr(`if expects "<self|var> <op> <n> [n2]"`, lineNo);
      cd.condEnabled = true;
      cd.condOperator = m[2];
      cd.condValue = Number(m[3]);
      if (m[4] !== undefined) cd.condValue2 = Number(m[4]);
      if (m[1] !== 'self') { cd.condRefMode = 'variable'; cd.condVariable = m[1]; }
      continue;
    }
    if (a.key === 'act') {
      const s = String(_econParseValue(raw, lineNo));
      const m = s.match(/^(\S+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?$/);
      if (!m) throw _econErr(`act expects "<op> <n> [n2]"`, lineNo);
      cd.activator = true;
      cd.actOperator = m[1];
      cd.actValue = Number(m[2]);
      if (m[3] !== undefined) cd.actValue2 = Number(m[3]);
      continue;
    }
    if (a.key === 'mod') {
      const s = String(_econParseValue(raw, lineNo));
      const m = s.match(/^(step|pulse|delta|rate)\s+(.+)$/);
      if (!m) throw _econErr(`mod expects "<step|pulse|delta|rate> <amount|(formula)>"`, lineNo);
      cd.modifier = true;
      cd.modMode = m[1];
      const amt = m[2].trim();
      if (amt.startsWith('(') && amt.endsWith(')')) cd.modFormula = amt.slice(1, -1).trim();
      else {
        const n = Number(amt);
        if (!isFinite(n)) throw _econErr(`bad mod amount ${amt}`, lineNo);
        cd.modFactor = n;
      }
      continue;
    }
    if (a.key === 'weight' && raw.startsWith('(') && raw.endsWith(')')) {
      cd.weightFormula = raw.slice(1, -1).trim();
      continue;
    }
    if (a.key === 'color') { cd.colorFilter = colorOf(raw, lineNo); continue; }
    const key = ECON_CONN_ALIAS[a.key] || a.key;
    cd[key] = _econParseValue(raw, lineNo);
  }
  return cd;
}

// ── Normalization ───────────────────────────────────────────────────────────
// Canonical form for comparing two diagram JSONs "as economies": runtime and
// cosmetic-noise fields are dropped and every id is renamed to its positional
// form, so JSON saved from the app compares equal to the same economy parsed
// back from .econ text. Used by the round-trip tests and handy for diffing.

function normalizeEconJSON(json) {
  const src = JSON.parse(JSON.stringify(json));
  const idMap = new Map();
  (src.nodes || []).forEach((n, i) => idMap.set(n.id, 'n' + (i + 1)));
  (src.connections || []).forEach((c, i) => idMap.set(c.id, 'c' + (i + 1)));
  (src.groups || []).forEach((g, i) => idMap.set(g.id, 'g' + (i + 1)));
  (src.notes || []).forEach((n, i) => idMap.set(n.id, 't' + (i + 1)));
  (src.charts || []).forEach((c, i) => idMap.set(c.id, 'ch' + (i + 1)));
  const mapId = id => idMap.get(id) || id;

  const out = {
    version: 1,
    nodes: (src.nodes || []).map(n => {
      const d = { ...n, id: mapId(n.id) };
      for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
      // A held amount with no color breakdown is runtime-equivalent to the
      // same amount in the default color (reconcile() assigns it on first
      // touch); canonicalize so both spellings compare equal.
      if (d.resources > 0 && isFinite(d.resources)
        && (!d.colorMap || JSON.stringify(d.colorMap) === JSON.stringify({ [DEFAULT_COLOR]: d.resources }))) {
        d.colorMap = { [DEFAULT_COLOR]: d.resources };
      }
      return d;
    }),
    connections: (src.connections || []).map(c => {
      const d = { ...c, id: mapId(c.id), sourceId: mapId(c.sourceId), targetId: mapId(c.targetId) };
      for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
      return d;
    }),
  };
  if ((src.groups || []).length) out.groups = src.groups.map(g => ({ ...g, id: mapId(g.id) }));
  if ((src.notes || []).length) out.notes = src.notes.map(n => ({ ...n, id: mapId(n.id) }));
  if ((src.charts || []).length) out.charts = src.charts.map(c => ({ ...c, id: mapId(c.id), nodeIds: (c.nodeIds || []).map(mapId) }));
  if ((src.resourceTypes || []).length) out.resourceTypes = src.resourceTypes;
  if (src.params && Object.keys(src.params).length) out.params = src.params;
  if ((src.customVars || []).length) out.customVars = src.customVars.map(rv => { const d = { ...rv }; delete d.value; return d; });
  if (src.timeMode && src.timeMode !== 'sync') out.timeMode = src.timeMode;
  if (src.seed) out.seed = String(src.seed);
  if (src.aiPlayer && (src.aiPlayer.rules || []).length) out.aiPlayer = src.aiPlayer;
  const m = src.meta || {};
  const meta = {};
  if (m.name) meta.name = m.name;
  if (m.description) meta.description = m.description;
  if (m.bgColor) meta.bgColor = m.bgColor;
  if (m.scheme && m.scheme !== 'default') meta.scheme = m.scheme;
  if (m.font) meta.font = m.font;
  if (Object.keys(meta).length) out.meta = meta;
  // Canonical key order everywhere, so comparisons are order-insensitive
  // (arrays keep their order; it is semantic).
  return _econSortKeys(out);
}

function _econSortKeys(v) {
  if (Array.isArray(v)) return v.map(_econSortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = _econSortKeys(v[k]);
    return out;
  }
  return v;
}
