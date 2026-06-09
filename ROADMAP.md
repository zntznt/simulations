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
- [x] **Queue node (P1).** Single-server FIFO: one unit in service at a time for
      `processTime` steps — serialized throughput + per-item latency, distinct
      from Delay's batch release.
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
  order; only matters when a pool is too scarce to give every output one unit.
- **Capacity-blocked shares aren't re-routed mid-tick** when two connections
  target the *same* full node (rare); resources stay in the source pool and are
  retried next step (never lost).
- **Single time granularity** (integer steps); rates are rounded to integers.
