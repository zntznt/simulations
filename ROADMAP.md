# Simulations — Roadmap & Feature Tracker

A living list of what the engine/editor can do today and what's still missing
relative to [machinations.io](https://machinations.io/). Check items off as they
land. Priorities: **P1** = core parity / high value, **P2** = valuable,
**P3** = nice-to-have.

---

## ✅ Implemented

### Nodes
- [x] Pool, Source (infinite), Drain, Gate, Converter, Register, Delay
- [x] Activation modes: automatic, passive, interactive, starting
- [x] Per-node capacity, end/goal conditions (halt the run when met)

### Connections
- [x] Resource and State connections
- [x] Resource rate: fixed / dice (`XdY`) / formula (shared variables)
- [x] Interval (every N steps), chance %, color filter, source-value condition
- [x] State connections: named variable, **trigger** (`✷`), **activator** (`⊢`)
- [x] Gate distribution: deterministic (weighted) and probabilistic (weighted)

### Simulation
- [x] Discrete time-step engine with atomic, order-independent commits
- [x] Max-min fair, work-conserving resource allocation under contention
- [x] Capacity reservation (no overfill, no resource creation/loss)
- [x] Colored resources tracked through the whole diagram
- [x] Shared variable store + register formulas (with chaining, fixpoint eval)

### Editor / app
- [x] Place / select / move / delete; click- and drag-to-connect; pan
- [x] Properties panel scoped per node/connection type
- [x] Animated resource balls along connections
- [x] Per-node history sparkline
- [x] Save / load JSON, sample diagrams (Basic / Loot Farm / Factory Line)
- [x] Headless unit test suite + Playwright smoke test

---

## 🔭 Missing — Simulation engine

- [x] **Pull-mode nodes (P1).** Pools/drains have a Flow mode (push/pull). A
      pull node draws each incoming connection's rate from its pool/source
      provider; `pullPolicy` any/all controls partial vs atomic pulls. Each
      connection is driven by exactly one endpoint (pull takes precedence), so
      there's no double flow.
- [x] **Finite / limited Source (P1).** Source can hold a finite starting stock
      ("Limited stock" toggle) and run dry.
- [x] **Queue node (P1).** A FIFO line feeding one or more parallel **servers**:
      up to `servers` units in service at once, each taking `processTime` steps,
      so throughput is `servers ÷ processTime` (M/D/1 at one server, M/D/c beyond).
      Per-item latency and a shared waiting line; distinct from Delay's batch
      release. Tracks **live metrics** — throughput, average/longest wait before
      service, and peak line length — shown in the properties panel and refreshed
      each step.
- [x] **Queue balking & reneging (P3).** A queue can model lost demand: a
      `maxLine` turns away arrivals that find the waiting line full (balking),
      and a `patience` makes a unit that waits that many steps without a server
      give up (reneging). Both **drop** the units (counted as `balked` / `reneged`
      losses) — distinct from a `capacity`, which makes the source hold and retry.
- [x] **State-connection modifiers (P1).** A state connection can add
      `factor × sourceValue` to a target pool/converter each step (negative =
      decay); self-connections enable interest/decay in place. _(Connection-rate
      modifiers are already covered by formula rates; edge-targeting a
      connection is still future.)_
- [x] **Reverse triggers / interrupts (P2).** A state connection with "Fail
      trigger" fires its target when the source *fails* to produce output (pool
      stays empty / gate blocked).
- [x] **Conditions referencing arbitrary nodes (P2).** Connection conditions can
      compare against any named diagram variable (`condRefMode = 'variable'`) in
      addition to the source node's value.
- [x] **Richer randomness (P2).** Distribution rate mode: normal, uniform,
      exponential, and Poisson; parameters editable in the properties panel.
- [x] **Gate "all-outputs" / explicit per-output % labels (P2).** New "all"
      gate mode pushes the full weight to every output; probabilistic mode shows
      computed % labels on each outgoing connection.
- [x] **Formula-driven gate weights (P1).** A gate output's weight can be a
      fixed number *or* a formula over the shared variables (params, custom vars,
      published state values), re-evaluated each step — so the split can shift
      with simulation state (difficulty scaling, adaptive routing). Mirrors
      formula rates; the % labels stay live during a run.
- [x] **Synchronous turn-based vs asynchronous real-time time modes (P3).**
      Diagram-level Time mode: `sync` fires every automatic node each step;
      `async` gives each automatic node its own "Fire every" / "Phase" rhythm.
- [x] **Artificial player (P3).** Scripted actor (diagram panel) that fires
      interactive nodes during a run — on a fixed interval or when a named
      variable condition holds.

## 🔭 Missing — Editor / UX

- [x] **Undo / redo (P1).** Snapshot-based, Ctrl+Z / Ctrl+Shift+Z (+ toolbar
      buttons); covers placement, connection, deletion, move, and property edits.
- [x] **Zoom (P1).** Wheel zooms toward the cursor; "⤢ Fit" / Ctrl+0 resets;
      pan via middle/alt-drag.
- [x] **Multi-select, copy / paste, duplicate (P1).** Marquee drag + Shift-click
      to select many nodes, drag them as a group, Ctrl+C/V, Ctrl+D, group delete.
- [x] **Keyboard shortcuts for tools** (P2). `S` = Select, `D` = Delete,
      `R` = Resource connection, `T` = State connection; modifier shortcuts
      (Ctrl+Z/C/V etc.) unchanged.
- [x] **Grid snap (P2).** "⊞ Snap" toolbar toggle; snaps placement and drag to
      a 20 px grid.
- [x] **Grouping / containers, sticky-note annotations (P2).** Drag the Group tool to
      draw a labeled, color-coded container rect (moves with its contained nodes); click
      the Note tool to place a resizable sticky note with text, color, and a properties
      panel textarea. Both are serialized in diagram JSON and undo/redo.
- [x] **Edit node value during play (P2).** +/− steppers in the properties
      panel let you increment/decrement pool/converter/delay/queue resources
      while the simulation is running.
- [x] **Tool reverts to Select after placing a node** (optional toggle) (P3).
      "↩ Auto" toolbar toggle; when on, the tool snaps back to Select after a
      single placement.
- [x] **Touch / mobile support (P3).** Single-touch maps to select/move/connect;
      two-finger pinch-zoom and pan; `touch-action: none` on the canvas.
- [x] **Accessibility pass (P3).** Keyboard tool shortcuts, `:focus-visible`
      outlines, `role`/`aria-label` on the canvas and icon buttons, `aria-pressed`
      on toggles, decorative icons hidden from assistive tech, higher-contrast
      dimmed text.

## 🔭 Missing — Analysis & data

- [x] **Global timeline chart (P1).** Toggleable bottom panel plotting every
      tracked node's value over time, with a legend ("📈 Chart").
- [x] **Monte Carlo / batch runs (P1).** "🎲 Batch" runs N isolated
      simulations for up to M steps and reports per-node distributions
      (mean / min / p10 / p50 / p90 / max) plus goal reach-rate and end-step
      stats — non-destructive to the live diagram.
- [x] **Chart/graph element placed on the canvas (P2).** A "Chart" annotation tool
      drops a live multi-series line chart directly onto the diagram. Pick which nodes
      to plot in the properties panel; each series is color-coded with a live end-value
      readout and the chart redraws every step (distinct from the global timeline panel).
      Movable, resizable, deletable, and serialized in diagram JSON.
- [x] **Named resource types** (not just colors) with per-type readouts (P2). A
      "Resource Types" registry (diagram panel) maps readable names to colors; the
      colour fields on sources, converters, and filters gain a type dropdown. Nodes
      show a live "Holdings by type" readout, and the diagram panel shows live
      per-type totals across the whole model. Tracked under the existing color key,
      so the engine is unchanged; types serialize in diagram JSON.
- [x] **Diagram-level parameters panel (P2).** Shown in the properties panel
      when nothing is selected; add/edit/delete named numeric constants that seed
      into the shared variable store before each step.
- [x] **CSV / data export of run history (P3).** "⬇ CSV" exports every tracked
      node's value at each recorded step as a CSV file.

## 🔭 Missing — Persistence & sharing

- [x] **localStorage autosave / recover last diagram (P2).** Auto-saves on
      every commit; recovery banner offered on next launch.
- [x] **Multiple named diagrams / library (P2).** "📚 Library" modal — save,
      rename, load, and delete named diagrams stored in localStorage.
- [x] **PNG / SVG export of the diagram (P2).** "⬇ SVG" and "⬇ PNG" toolbar
      buttons; PNG renders at 2× DPI for retina quality.
- [x] **Shareable URL / embed (P3).** "🔗 Share" copies a link with the whole
      diagram base64-encoded in the URL hash (`#d=…`); opening it restores the
      diagram. `?embed` (or `#embed`) hides the editing chrome for a clean view.

---

## ✅ Ultrabuff pass — analysis depth & headless power

- [x] **Seeded, reproducible RNG.** A `SimRandom` source (mulberry32) feeds every
      stochastic decision — dice, distributions, chance %, probabilistic gates,
      custom variables. Seed a Monte Carlo batch (or a CLI run) and the same
      seed reproduces the exact same results; unseeded it delegates to
      `Math.random`.
- [x] **Non-blocking Monte Carlo.** Batches run in time-boxed chunks off the
      event loop with a live "Running… N / total" progress readout — 5000 runs
      no longer freeze the UI. Trials clone via `structuredClone` instead of a
      JSON round-trip per run.
- [x] **Parameter sweep.** Vary one diagram parameter across a range from the
      Monte Carlo modal; per-node means and goal reach-rate are tabulated one
      column per value. Sweeps run on clones with a shared sub-seed per value,
      so column differences come from the parameter, not RNG noise.
- [x] **Raw Monte Carlo export.** One CSV row per run, one column per node —
      ready for R / pandas / spreadsheets.
- [x] **Adaptive history stride.** Long runs decimate the recorded history
      (stride doubles when full) instead of silently dropping the oldest steps:
      the timeline always spans the whole run at 300–600 samples. The timeline
      x-axis labels real step numbers.
- [x] **Headless CLI runner (`cli.js`).** Simulate any saved diagram from Node:
      per-step CSV traces, Monte Carlo stats or raw CSV, `--seed`, repeatable
      `--param name=value` overrides.
- [x] **Diagram schema version.** `version: 1` marker in saved JSON plus a
      documented migration point in `loadJSON`.
- [x] **Shortcuts & gestures overlay.** `?` key or the topbar Help button opens
      a reference of every keyboard shortcut and hidden mouse gesture
      (Space-pan, label-pill drag, curve-handle reshape, interactive-node
      firing, …).

## ✅ Scenario branching

- [x] **Checkpoint / fork / compare.** `SimEngine.captureState()` /
      `restoreState()` snapshot the complete simulation state — diagram
      structure, node runtime (resources, in-flight delay/queue contents,
      counters) plus the Reset baselines, the variable store, and the engine
      clock/history/trigger state. A "Branch" rail panel checkpoints the run
      mid-flight and forks back to any checkpoint; the superseded run is kept
      automatically as a **ghost branch** — dashed, faded traces overlaid on
      the timeline chart (same colour = same node across timelines, x-axis in
      real step units), toggleable from the legend chips or the panel.
      Session-only; Reset still returns to the true run start.

## ✅ Sprawling example library

- [x] **Six large, expert-designed demos** added alongside the five concept
      demos, to show the engine at machinations.io scale. Each is ~30-37 nodes,
      spans multiple interacting subsystems, exercises most of the engine at
      once, and is tuned for rich non-degenerate dynamics (verified headlessly
      through the real `_demo*` methods — no NaN/Inf, no dead/pegged values):
      **F2P Mobile Economy** (32), **Civilization Empire** (34), **Megafactory
      Line** (35), **Business Cycle** (31), **Food Web** (29), **Auction
      Economy** (37, all nine node types). Loaded from the Library like any
      template; covered by the smoke suite.

## ✅ Moderated usability pass

A four-participant moderated study (two total beginners, two with basic
knowledge) drove the real app and reported friction. Fixes that shipped from it:

- [x] **First-run welcome overlay** — explains what the app is, the
      place → connect → Run loop, and a plain-language glossary of the building
      blocks; offers "Explore the demo" / "Browse templates". Shown once
      (localStorage `sim_seen_welcome`), skipped for embed/shared links, and
      reopenable from **Help → Getting started**. (Beginners had no
      concept-level onboarding; the empty-canvas hint was unreachable behind the
      always-loaded demo.)
- [x] **Plain-language node tooltips** — every palette node now says what it's
      *for* ("Pool — stores a resource amount", "Source — produces resources", …)
      rather than "Place Pool node".
- [x] **Formula field help + validation** — the rate/register formula input now
      lists the in-scope variable names, shows the non-obvious tip that a node's
      value reaches a formula only via a *named state connection*, and flags
      invalid formulas with a red border (wires up `validateFormula`). This was
      the #1 power-user blocker.
- [x] **Parameter-sweep CSV export** + a **deterministic-model note** in Monte
      Carlo (explains why all percentiles match when there's no randomness).
- [x] **Library-save confirmation toast**, and a **wider connection hit area**
      (24px) so re-selecting a curved connection isn't fiddly.
- [x] **Interactive tour reaches past "draw a pipe."** A second persona pass (an
      ideal user — a game-economy designer — drove the live app) found the tour
      taught the *gesture* but not the *model*: it never showed a **rate**, and
      dropped graduates onto a blank canvas. Added a **"set a rate"** step (it
      spotlights the connection's Rate field and advances when you edit it) so the
      loop is now *place → connect → set a rate → Run*, and replaced the passive
      final card with click-through **hand-off cards** spotlighting the
      **Library**, the **Mechanics rail** (params/vars/types), and
      **Analysis → Batch (Monte Carlo)** — the depth that was previously
      undiscoverable to a new user.

  *Tour — open follow-ups (refine before deciding what else to add):*
  - [ ] **Refine the hand-off cards (P0 #2).** They're a first cut — revisit
        wording, placement, and whether each card should *preview* its
        destination (e.g. flash the Library open) rather than only point at it.
  - [ ] **Tour Part 2 — walk a real economy.** After the basics, offer "See it
        in a real model": load the F2P economy and annotate its formula faucet,
        dice faucet, gacha gate, a register formula, and a chart.
  - [ ] **Branch the welcome by intent** — "Build from scratch" vs. "Tour a
        finished economy", routing to the basics tour or Part 2.
  - [ ] **Usability snags surfaced by the persona pass (not tour-specific):**
        re-selecting a connection is still fiddly despite the 24px hit area; the
        welcome glossary lists 5 node types while the palette shows more
        (Gate/Converter/Register/Delay/Queue/Trader); consider surfacing a
        connection's configured rate at rest, not only the flow badge while
        running.

## ✅ Sensitivity analysis

- [x] **Parameter sensitivity heatmap.** From the Monte Carlo modal, "Run
      sensitivity" perturbs every diagram parameter by ±10% (configurable), one
      at a time, on isolated clones, and reports the **elasticity** of each
      tracked node's mean outcome to each parameter — the % change in the node
      per 1% change in the parameter. Results are a diverging green/red heatmap
      (same vs opposite direction, brighter = stronger) with the most-influential
      parameter called out and a CSV export. All batches share one seed (common
      random numbers) so cells reflect the parameter, not RNG noise; the live
      diagram is never touched.

## 🔮 Council backlog — bigger ideas worth designing

Ideas from a design review ("council of geniuses" pass). The sensitivity
dashboard has since shipped (above); the rest are unstarted.

- **Reusable subgraph components.** Define a module (e.g. a loot-drop pipeline)
  once, instantiate it many times with different parameters via a
  `ComponentRef` node.
- **Run comparison overlay.** Pin a run as baseline; later runs draw over it as
  ghost traces in the timeline.
- **Web-worker / WASM engine.** Move the tick loop off the main thread, then
  (much later) to WASM for 100k-step sweeps.
- **Live collaboration.** CRDT-backed multi-user editing (Yjs/Automerge) over
  the existing JSON model.
- **Guided onboarding.** Interactive tour that builds the first source→pool
  flow with the user; example gallery with live previews.
- **Plugin hooks.** `onNodeFire` / `onTransfer` / `onStepEnd` registration so
  domain experts can add custom node behaviours without forking the engine.
- **Machinations.io importer.** Parse their file format into diagram JSON for
  migration.
- **Animated GIF / embeddable live widget export** for sharing running models.

---

## ⚠️ Known limitations & intentional design notes

- **Flow direction.** Push is the default; pools/drains can opt into pull mode
  (drawing from pool/source providers). Gates/converters/delays/queues always
  push; pull draws only from pool/source providers, so each connection is
  driven exactly once.
- **Goals are terminal on Run.** Reaching a goal stops the engine; pressing Run
  clears the goal and resumes (it re-triggers if still satisfied). No
  "resume past goal" mode yet.
- **Place tool stays active** after placing a node (rapid placement) unless the
  "↩ Auto" toggle is on, which snaps back to Select after one placement.
- **Sub-unit fairness remainder** is handed out round-robin in connection
  order within one pool's outputs; only matters when a pool is too scarce
  to give every output one unit.
- **Capacity-blocked shares aren't re-routed mid-tick** when two connections
  target the *same* full node (rare); resources stay in the source pool and are
  retried next step (never lost).
- **Sub-unit fairness remainder** is handed out round-robin in connection
  order within a single pool's outputs, and round-robin in source-node order
  across competing pushers to the same target; only matters when capacity
  is exhausted and no even split exists.
- **Single time granularity** (integer steps); rates are rounded to integers.
