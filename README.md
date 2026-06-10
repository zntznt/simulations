# Simulations — an economy & game-systems designer

A browser-based, [Machinations](https://machinations.io/)-style tool for modelling
resource economies and game-system feedback loops, then **simulating** them step by
step. Draw nodes and connections on a canvas, press Run, and watch resources flow,
accumulate, convert, and drain — with charts, batch (Monte Carlo) analysis, and
shareable diagrams.

Pure vanilla JavaScript. **No build step, no framework** — just static files and
an SVG canvas. The only dependency is a vendored copy of
[math.js](https://mathjs.org/) powering the formula language.

> **Status — docs in progress.** A major UI/UX overhaul is underway. This README
> documents the parts that are stable regardless of how the interface looks: the
> simulation model, the feature set, the architecture, and how to run and test the
> project. A visual walkthrough, screenshots, and a step-by-step editor tutorial
> will land **after** the UI/UX pass so they don't go stale. See
> [Deferred docs](#deferred-docs).

---

## Quick start

There's nothing to install. Serve the folder and open it:

```bash
# any static server works; here's one that ships with Python
python3 -m http.server 8080
# then open http://localhost:8080/
```

Opening `index.html` directly via `file://` also works for the core editor and
simulation. A few conveniences (clipboard copy of share links, embed routing)
behave best over `http://`, so a local server is recommended.

The app boots with a small example diagram. Use the **Examples** menu to load the
bundled samples, or start from scratch.

---

## What it does

You build a directed graph of **nodes** (pools, sources, drains, gates, converters,
registers, delays, queues) joined by **connections** (resource flows or state
links). A discrete-time engine then advances the model one step at a time:

- Resources move along resource connections at configurable rates (fixed, dice,
  formula, or sampled from a statistical distribution).
- Contended pools split their output **max‑min fairly** and **work‑conservingly**,
  so allocation is order‑independent and never creates or destroys resources.
- State connections publish named variables, drive triggers, gate nodes with
  activators, and apply in‑place growth/decay — enabling feedback loops.
- The whole step **commits atomically**, so results don't depend on node ordering.

You can then analyse the model with live charts, export the run history, run
thousands of Monte‑Carlo trials, and share the whole diagram in a URL.

---

## Feature overview

### Nodes
- **Pool** — accumulates resources (optional capacity).
- **Source** — emits resources; **infinite** by default or a **limited** finite stock that can run dry.
- **Drain** — consumes resources and tallies throughput.
- **Gate** — routes incoming resources across outputs by weight: **deterministic** (proportional), **probabilistic** (weighted random per unit), or **all** (each output gets its full weight).
- **Converter** — consumes N held resources per conversion and emits an output (in its own colour/type).
- **Register** — a computed value from a **formula** over shared variables (chains across registers, resolved to a fixpoint each tick).
- **Delay** — holds a batch of resources for N steps, then releases them together.
- **Queue** — single‑server FIFO: one unit in service at a time for `processTime` steps (a throughput bottleneck with per‑item latency, distinct from Delay).

### Activation modes
`automatic` (fires every step), `passive` (only when triggered), `interactive`
(fired by a click or the artificial player), and `starting` (fires once on step 1).

### Connections
- **Resource connections** — rate modes: **fixed**, **dice** (`XdY`), **formula**
  (over shared variables), and **distribution** (normal / uniform / exponential /
  Poisson). Plus per‑connection **interval** (every N steps), **chance %**,
  **colour/type filter**, and a **condition** that compares the source value — or
  any named variable — against a threshold.
- **State connections** — publish a named **variable**; act as a **trigger** (`✷`,
  fire the target when the source fires), a **fail/reverse trigger** (fire the
  target when the source *fails* to act), an **activator** (`⊢`, the target may
  only fire while a condition holds), or a **modifier** (`Δ`, add `factor × source`
  to the target each step — negative decays; self‑loops enable interest/decay).

### Simulation engine
- Discrete time‑step engine with **atomic, order‑independent commits**.
- **Max‑min fair, work‑conserving** allocation under contention.
- **Capacity reservation** — no overfill, no resource creation/loss; capacity‑blocked shares are retried next step, never lost.
- **Pull mode** — pools/drains can draw along incoming connections from pool/source providers (`any` = partial, `all` = atomic). Each connection is driven by exactly one endpoint, so there's no double flow.
- **Coloured resources** tracked end‑to‑end, with optional **named resource types** layered over the colours (with per‑type readouts).
- **Shared variable store** + register formulas (chaining, fixpoint evaluation).
- **math.js formula language** — every formula (rates, registers, math variables) is evaluated with [math.js](https://mathjs.org/): `^` power, ternaries, comparisons, `round`/`floor`/`ceil`/`abs`/`min`/`max`/`sqrt`/`log`/`exp`/`mod`, trig, constants (`pi`, `e`), `random()`, `randomInt(a,b)`, `pickRandom([…])`, and more. Legacy JavaScript-style expressions (e.g. `Math.round(x)`) still work via a fallback evaluator.
- **Custom variables** — named values usable in any formula. Random kinds: **interval** (any number between min and max), **array** (one of a validated number list), or **dice** (`XdY`), each with a **uniform or gaussian** distribution. Computed kind: **math**, a formula over the other variables. All re-evaluate **every step** or **once per Run press**.
- **Goals / end conditions** on any node halt the run when met.

### Time & agents
- **Time modes** — `sync` (turn‑based: every automatic node fires each step) or `async` (real‑time: each automatic node fires on its own *fire every* / *phase* rhythm).
- **Artificial player** — a scripted actor that fires interactive nodes during a run, on a fixed interval or while a named‑variable condition holds.

### Editor
Place / select / move / delete; click‑ or drag‑to‑connect; pan & zoom (wheel +
fit); undo/redo; marquee multi‑select, shift‑click, copy/paste/duplicate, group
delete; grid snap; optional auto‑revert to the Select tool after placing; touch /
mobile support (single‑touch gestures, two‑finger pinch‑zoom & pan); an
accessibility pass (keyboard tool shortcuts, focus outlines, ARIA roles/labels,
higher‑contrast text); plus **container groups**, **sticky notes**, and **on‑canvas
charts** as annotations (groups, notes, and charts are **drag‑resizable** by their
corner handles).

### Diagram settings rail
A far‑right icon rail holds the **diagram‑wide** settings, each opening in the
properties panel so they're never crammed together: **time mode**,
**parameters**, **custom variables**, **resource types**, the **artificial
player**, and a live **variable watch** that ticks with the simulation. Clicking
a rail icon shows that editor in the panel; selecting a node or connection hands
the panel back to the selection. The left palette stays for tools/nodes and the
top bar for run/zoom/file controls.

### Analysis & data
- **Global timeline chart** — every tracked node's value over time, with a legend.
- **On‑canvas charts** — live line charts placed in the diagram itself, tracking chosen nodes.
- **Monte Carlo / batch runs** — run N isolated simulations for up to M steps and report per‑node distributions (mean / min / p10 / p50 / p90 / max) plus goal reach‑rate and end‑step stats — non‑destructive to the live diagram.
- **CSV export** of the recorded run history.
- **Per‑type readouts** — holdings by type on each node, and live totals across the whole diagram.

### Persistence & sharing
- **localStorage autosave** with a recovery banner on next launch.
- **Diagram library** — save, rename, load, and delete named diagrams.
- **JSON** save/load, and **SVG / PNG** export of the diagram.
- **Shareable URL** — the whole diagram is base64‑encoded in the URL hash (`#d=…`); opening it restores the diagram. `?embed` (or `#embed`) hides the editing chrome for a clean, embeddable view.

For the **why** and **how** behind the model — the tick order, the fair‑allocation
algorithm, the one‑step variable lag, and more — see
**[docs/CONCEPTS.md](docs/CONCEPTS.md)**.

---

## Keyboard shortcuts

> Current bindings; some may change in the upcoming UI/UX pass.

| Key | Action |
| --- | --- |
| `S` | Select tool |
| `D` | Delete tool |
| `R` | Resource‑connection tool |
| `T` | State‑connection tool |
| `Ctrl/⌘ + Z` | Undo |
| `Ctrl/⌘ + Shift + Z` / `Ctrl + Y` | Redo |
| `Ctrl/⌘ + C` / `V` / `D` | Copy / paste / duplicate selection |
| `Ctrl/⌘ + 0` | Fit / reset view |
| `Delete` / `Backspace` | Delete selection |
| `Esc` | Cancel pending connection / clear selection |

---

## Bundled examples

Each is a self-contained systems model with emergent behaviour, shipped with an
explanatory note and an on-canvas chart. Open the **Library** to load one.

- **Predator & Prey** — coupled populations settle into a stable limit cycle (foxes peak just after rabbits). Logistic growth via a register, predation via a formula rate, starvation via a self-modifier.
- **Epidemic (SIR)** — the textbook outbreak curve; infections crest exactly as the effective reproduction number Rₑ falls through 1, and the run halts when the outbreak fades.
- **Supply Chain** — ore smelted 2:1 into ingots and shipped through a 3-step delay; nothing sells until the pipeline fills, then output holds steady. Speed up the mine to create a bottleneck.
- **Barter Economy** — two towns swap grain for timber through a Trader (an atomic 2-for-2 exchange); each storehouse ends up holding both colours.
- **Service Desk** — a single-server queue with random (Poisson) arrivals; the line builds and clears — the M/D/1 queue behind every checkout.

---

## Architecture

Plain `<script>` includes, loaded in dependency order from `index.html`. No modules,
no bundler.

| File | Responsibility |
| --- | --- |
| `js/model.js` | Data classes — `MNode`, `MConnection`, `MGroup`, `MNote`, `MChart`, `Diagram` — plus pure helpers (`evalFormula`, `rollDice`, `sampleDist`, `dominantColor`). No DOM. |
| `js/engine.js` | `SimEngine` — the tick loop, fair allocation, triggers/activators/modifiers, variables & registers, and Monte Carlo. No DOM. |
| `js/renderer.js` | `Renderer` (SVG drawing, hit‑testing, pan/zoom) and `BallSystem` (flow animation). |
| `js/editor.js` | `Editor` — pointer/keyboard/touch input, tools, selection, drag‑to‑connect. |
| `js/charts.js` | `Sparkline` and `TimelineChart` (canvas 2D). |
| `js/app.js` | `App` — wires everything together: toolbar, properties panel, persistence, examples, import/export. |
| `css/style.css` | All styling. |
| `vendor/math.min.js` | Vendored [math.js](https://mathjs.org/) bundle — the formula evaluator. |
| `index.html` | Markup + script includes. |

**Data flow.** `App` owns a `Diagram`, a `SimEngine`, a `Renderer`, and an `Editor`.
The engine mutates the diagram and calls back on each step; the app re‑renders, drives
animations, updates charts, and refreshes the panel. The model layer is intentionally
DOM‑free so it can be unit‑tested headlessly and reused (e.g. Monte Carlo clones a
`Diagram` + `SimEngine` per trial).

**Serialization.** `Diagram.toJSON()` / `loadJSON()` are the single source of truth
for persistence — used by save/load, the library, autosave, undo/redo snapshots,
shareable URLs, and the test round‑trips. New fields are written only when they
differ from defaults, keeping saved files small and forward‑compatible.

---

## Testing

**Headless unit tests** (no browser; loads `model.js` + `engine.js` into a sandbox):

```bash
npm install   # once — pulls mathjs for the formula tests
node test/run.js
```

Covers core flows, fair contention, capacity integrity, registers/formulas,
gating, triggers/activators, end conditions, finite sources, queues, state
modifiers, pull mode, distributions, time modes, the artificial player, and
serialization round‑trips for every model type.

**Browser smoke test** (Playwright + Chromium) — exercises the real app and fails
on any console/page error:

```bash
# in one shell: serve the app
python3 -m http.server 8080
# in another: run the smoke test
NODE_PATH=$(npm root -g) node test/smoke.js
# override the URL with SMOKE_URL if needed
```

Requires `playwright` (and a Chromium build) available on `NODE_PATH`.

---

## Browser support

Modern evergreen browsers (Chrome, Firefox, Safari, Edge). Uses SVG, Canvas 2D,
`localStorage`, the Clipboard API (with a prompt fallback), and standard ES2020+
JavaScript. No transpilation.

---

## Roadmap

All P1, P2, and P3 items in [ROADMAP.md](ROADMAP.md) are implemented. The roadmap
also records intentional design decisions and known limitations.

---

## Deferred docs

Held until after the in‑progress UI/UX overhaul, so they don't immediately go stale:

- **Screenshots / GIFs** of the editor and analysis views.
- **A visual, step‑by‑step usage guide** (placing nodes, wiring connections, reading the panels).
- Any **layout‑specific** reference (exact panel locations, button labels).

The simulation model, file architecture, and APIs documented here and in
`docs/CONCEPTS.md` are independent of the visual design and should remain accurate
across the redesign.
