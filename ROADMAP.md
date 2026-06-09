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

- [ ] **Pull-mode nodes (P1).** Machinations' default is *pull* (a node pulls
      along its incoming connections); we are push-only. Add per-node
      push/pull plus the any/all variants (pull-any, pull-all, push-any,
      push-all), which change how partial availability is resolved.
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
- [ ] **Reverse triggers / interrupts (P2).** Fire (or block) a target when the
      source *fails* to act, not just when it succeeds.
- [ ] **Conditions referencing arbitrary nodes (P2).** Connection conditions
      currently compare only the source's value; allow conditions over any
      named variable / node.
- [ ] **Richer randomness (P2).** Beyond `XdY`: explicit probability tables and
      common distributions for rates.
- [ ] **Gate "all-outputs" / explicit per-output % labels (P2).**
- [ ] **Synchronous turn-based vs asynchronous real-time time modes (P3).**
- [ ] **Artificial player (P3).** Scripted/AI actor that fires interactive
      actions on schedules or conditions.

## 🔭 Missing — Editor / UX

- [ ] **Undo / redo (P1).**
- [ ] **Zoom (P1).** Today only panning exists (wheel / alt-drag).
- [ ] **Multi-select, copy / paste, duplicate (P1).**
- [ ] **Keyboard shortcuts for tools** (S/P/etc.) (P2).
- [ ] **Grid snap & alignment guides (P2).**
- [ ] **Grouping / containers, sticky-note annotations (P2).**
- [ ] **Edit node value during play (interactive registers / sliders) (P2).**
- [ ] **Tool reverts to Select after placing a node** (optional toggle) (P3).
- [ ] **Touch / mobile support (P3).**
- [ ] **Accessibility pass** (keyboard nav, ARIA, contrast) (P3).

## 🔭 Missing — Analysis & data

- [x] **Global timeline chart (P1).** Toggleable bottom panel plotting every
      tracked node's value over time, with a legend ("📈 Chart").
- [x] **Monte Carlo / batch runs (P1).** "🎲 Batch" runs N isolated
      simulations for up to M steps and reports per-node distributions
      (mean / min / p10 / p50 / p90 / max) plus goal reach-rate and end-step
      stats — non-destructive to the live diagram.
- [ ] **Chart/graph element placed on the canvas (P2).**
- [ ] **Named resource types** (not just colors) with per-type readouts (P2).
- [ ] **Diagram-level parameters panel** to expose and tweak shared variables
      (P2).
- [ ] **CSV / data export of run history (P3).**

## 🔭 Missing — Persistence & sharing

- [ ] **localStorage autosave / recover last diagram (P2).**
- [ ] **Multiple named diagrams / library (P2).**
- [ ] **PNG / SVG export of the diagram (P2).**
- [ ] **Shareable URL / embed (P3).**

---

## ⚠️ Known limitations & intentional design notes

- **Push-only flow.** All movement is push-based from Sources/Pools; pull
  semantics (above) are not yet modeled.
- **Goals are terminal on Run.** Reaching a goal stops the engine; pressing Run
  clears the goal and resumes (it re-triggers if still satisfied). No
  "resume past goal" mode yet.
- **Place tool stays active** after placing a node (rapid placement). Switch to
  Select to move/edit.
- **Sub-unit fairness remainder** is handed out round-robin in connection
  order; only matters when a pool is too scarce to give every output one unit.
- **Capacity-blocked shares aren't re-routed mid-tick** when two connections
  target the *same* full node (rare); resources stay in the source pool and are
  retried next step (never lost).
- **Single time granularity** (integer steps); rates are rounded to integers.
