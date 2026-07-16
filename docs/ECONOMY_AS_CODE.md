# Economy as code

The designer's diagrams don't have to live only on the canvas. Three features
turn an economy into a first-class code artifact:

1. **The `.econ` text format** — a readable, diff-friendly projection of the
   diagram JSON that round-trips losslessly with the canvas.
2. **Assertions** — temporal checks the CLI runs against a simulation (and
   against every Monte Carlo trial), with CI-friendly exit codes.
3. **Generated JS modules** — the diagram, the engine, and a small API compiled
   into one dependency-free file you can ship inside a game or tool.

Everything here is implemented in three DOM-free files — `js/dsl.js`,
`js/assertions.js`, `js/codegen.js` — shared verbatim by the browser app,
`cli.js`, and the test suite.

---

## 1. The `.econ` text format

**File → Save as text (.econ)** writes it; **File → Open file** reads it back
(any file that doesn't start with `{`/`[` is treated as `.econ`). On the CLI,
`--to-dsl` and `--to-json` convert in both directions, and any input file
ending in `.econ` is parsed as text.

```econ
economy v1
name: Widget Factory
desc: A tiny two-tier production chain.
seed: 42
param mine_rate = 3
type Wood = #8d6e63

// nodes: <kind> <Name> @ x,y [sugar…] [key=value…]
source Mine @ 80,180 color=Wood
pool Warehouse @ 300,180 = 10 of Wood cap=100 goal >= 90
converter Forge @ 520,180 recipe(2 Wood, 1 #b0bec5) out=#ffa726
register Score @ 520,60 = "warehouse * 2"

// connections: -> moves resources, ~> carries state
Mine -> Warehouse : (mine_rate) every=2 75% if="self < 100"
Warehouse -> Forge : 2d6 color=Wood
Warehouse ~> Score name=warehouse
```

### Ground rules

- One statement per line; blank lines are free; `//` starts a comment (`#` is
  reserved for colors).
- Node references are **labels**: bare when they look like identifiers, quoted
  (`"Gold Mine"`) otherwise. Duplicate labels get `#2`, `#3`, … suffixes in
  declaration order (`Gold`, `Gold#2`).
- Anything not covered by the sugar below round-trips as generic `key=value`
  attributes whose names are the diagram-JSON field names. Only fields that
  differ from that node/connection type's defaults are written, so files stay
  minimal — and new model fields serialize automatically without DSL changes.
- Attribute values: numbers and bare words as-is, strings quoted when needed,
  booleans `true`/`false`, JSON for arrays/objects
  (`waypoints=[{"x":1,"y":2}]`).

### Header directives

| Directive | Meaning |
| --- | --- |
| `economy v1` | format marker (optional on input, always written) |
| `name:` / `desc:` | diagram name/description (rest of line; `\n` escapes in desc) |
| `seed: 42` | run seed (reproducible runs) |
| `timeMode: async` | asynchronous time mode |
| `meta scheme=ocean bgColor=#101318 font="Space Grotesk"` | presentation extras |
| `param rate = 3` | a diagram parameter (repeatable) |
| `type Wood = #8d6e63` | named resource type; the name is usable wherever a color is |
| `var luck = dice(2d6) gaussian` | custom variable; kinds `interval(min,max)`, `array(1,2,3)`, `dice(XdY)`, `math(expr)`; modifiers `gaussian` and `per=play` |
| `player enabled rules=[…]` | artificial-player rules (JSON) |

### Nodes

`<kind> <Name> @ x,y …` where kind is `pool`, `source`, `drain`, `gate`,
`converter`, `register`, `delay`, `queue` or `trader`.

Sugar, all optional:

- `= 50` / `= 50 of Wood` — starting amount (with color/type). On a register:
  `= "formula"` or `= 7` (a fixed value).
- `cap=100` — capacity.
- `goal >= 400` — end condition (any comparison operator).
- `passive` / `interactive` / `starting` — activation mode (default automatic).
- `pull` / `pull=all` — pull flow mode (policy `any` unless `=all`).
- `limited` (source) — finite stock; give the amount with `= 40`.
- `color=Wood` (source) — emitted resource color.
- `recipe(2 Wood, 1 #b0bec5)` (converter) — multi-ingredient recipe;
  `in=2` (single-input amount) and `out=#ffa726` (output color) also available.
- Aliases: `cap→capacity, in→inputAmount, out→outputColor, color→resourceColor,
  mode→gateMode, time→processTime, every→fireEvery, phase→firePhase`.

### Connections

`A -> B` moves resources; `A ~> B` carries state. After the target, an optional
rate clause, then attributes:

- `: 3` — fixed rate; `: 2d6` — dice; `: (gold * 0.1)` — formula;
  `: ~poisson(3, 2)` — distribution (`normal`, `uniform`, `exponential`,
  `poisson` with their two parameters).
- `every=3` — fire interval; `40%` — chance per firing.
- `color=Wood` — color filter (also the converter's per-output mint color).
- `if="self > 5"` / `if="gold >= 2"` / `if="self between 2 8"` — condition on
  the source's value (`self`) or a named variable.
- `name=gold` — state connection's variable name.
- `trigger`, `triggerChance=50`, `triggerEvery=2`, `reverseTrigger`.
- `act=">= 5"` / `act="between 1 99"` — activator on the target.
- `mod="rate 0.1"`, `mod="step 2"`, `mod="pulse 1"`, `mod="delta 2"`, or a
  formula amount: `mod="rate (round(score * 0.1))"`.
- `weight=3` or `weight=(difficulty * 2)` — gate output weight.
- `label="tax"` plus any raw fields (`pathStyle=ortho`, `cpDx=10`, …).

### Annotations

```econ
group "Economy Core" @ 50,50 400x300 color=#7cb342
note @ 620,50 160x80 "Balance this before shipping"
chart "Gold over time" @ 620,160 240x150 type=area tracks=Gold,Score
```

### Round-trip guarantees

`serialize(parse(serialize(x))) === serialize(x)` byte-for-byte, and the parsed
JSON is semantically identical to the original up to node/connection id
renaming and runtime fields (live variable values, thumbnails, timestamps).
`normalizeEconJSON()` in `js/dsl.js` is the canonical comparison form the tests
use. Ids are regenerated deterministically (`n1`, `c1`, …) on parse, so saving
the same economy twice produces identical text — that's what makes diffs clean.

---

## 2. Assertions

```bash
node cli.js economy.econ --steps 300 \
  --assert "always gold < 500" \
  --assert "eventually score >= 100" \
  --assert "at step 25: queue <= 3" \
  --assert "at end: widgets > 50" \
  --assert "widgets > 50"            # bare expression = at end
```

| Quantifier | Passes when |
| --- | --- |
| `always E` | E is true at every step, including step 0 |
| `never E` | E is false at every step |
| `eventually E` | E becomes true at one or more steps |
| `at end: E` | E is true at the final step |
| `at step N: E` | E is true at exactly step N (fails if the run ends sooner) |

The expression language is the same one rates and registers use (math.js
syntax with a plain-JS fallback): comparisons, arithmetic, `and`/`or`,
ternaries, `round/floor/min/max/…`.

**Scope**: every node's label (sanitized to an identifier — `Gold Mine` becomes
`Gold_Mine`, duplicates get `_2`, `_3`, …) holds its chart value (pool contents,
drain total, register value, limited-source stock, trader trades); all diagram
variables (params, custom variables, state-connection names, register labels)
are visible; `step` is the current step.

**Exit codes**: `0` all assertions pass, `2` any fail (`1` stays reserved for
usage/file errors), so a CI job is just the command itself.

**Monte Carlo**: with `--runs N` every trial is checked independently.
`--pass-rate 95` passes the batch when at least 95% of trials satisfy *all*
assertions (default 100). The report shows per-assertion failure counts and the
first failing run. `--assert-file checks.txt` loads one assertion per line
(`//` comments allowed).

---

## 3. Generated JS modules

**File → Export as JS module** in the app, or:

```bash
node cli.js economy.econ --emit economy.module.js
```

The output is one UMD file (~100 KB, no dependencies) containing the model,
the engine, the diagram, and this API:

```js
const { createEconomy } = require('./economy.module.js'); // or window.Economy

const eco = createEconomy({ seed: 42, params: { mine_rate: 3 } });

eco.step();          // advance one step
eco.step(5);         // advance five
eco.run(200);        // advance until a goal ends the run, or 200 steps
eco.t;               // current step
eco.ended;           // did a goal condition end the run?
eco.get('Gold');     // node value by label (falls back to variables)
eco.set('Gold', 10); // set a pool / limited source / register
eco.fire('Buy');     // fire an interactive node (a player action)
eco.values();        // { label: value } for every tracked node
eco.vars();          // the shared variable store
eco.onStep((values, step) => { ... });
eco.reset();         // back to step 0 (re-applies the seed)
```

Notes:

- Formulas evaluate with math.js when a global `math` exists (`global.math =
  require('mathjs')` in Node); otherwise they fall back to the legacy plain-JS
  expression path. Economies without math.js-specific syntax need nothing.
- The RNG (`SimRandom`) is module-level state, exactly like the app: run one
  seeded economy at a time per process for bit-exact reproducibility.
- `createEconomy()` parses a fresh copy of the embedded diagram each call, so
  instances never share mutable state.
- The module also exports `Diagram`, `SimEngine`, `SimRandom` and `NodeType`
  for power users who want to go under the hood.
