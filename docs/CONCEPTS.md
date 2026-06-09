# Concepts — how the simulation model works

This is the durable reference for the **model and engine** — the parts that don't
change when the UI is redesigned. If you want the feature list and how to run the
project, start with the [README](../README.md).

Everything here is implemented in two DOM‑free files: `js/model.js` (data) and
`js/engine.js` (behaviour). They're loaded into a sandbox by `test/run.js`, so every
rule below is exercised by the unit suite.

---

## 1. The big picture

A **diagram** is a directed graph of **nodes** connected by **connections**, plus a
shared **variable store**. A **discrete‑time engine** advances the model one
**step** (tick) at a time. Each tick:

1. Decides which nodes fire this step.
2. Lets each firing node propose resource movements and trigger others.
3. Resolves contention fairly and respects capacity.
4. **Commits all movements atomically.**
5. Applies in‑place modifiers, then refreshes variables and registers.

Because the commit is atomic and allocation is order‑independent, the result of a
step does **not** depend on the order nodes happen to be stored in.

---

## 2. Nodes

Every node has a position, label, **activation mode**, optional **capacity**, and an
optional **end/goal condition**. Resource‑holding nodes track a `colorMap`
(`{ color: count }`) so resources keep their identity as they move.

| Type | Role | Key fields |
| --- | --- | --- |
| **Pool** | Accumulates resources. | `capacity`, `flowMode`, `pullPolicy` |
| **Source** | Emits resources. Infinite by default; toggle **Limited** for a finite stock that runs dry. | `resourceColor`, `limited`, `produced` |
| **Drain** | Consumes resources; tallies `drained`. | `flowMode`, `pullPolicy` |
| **Gate** | Routes incoming resources across outputs by weight. | `gateMode` (`deterministic` / `probabilistic` / `all`) |
| **Converter** | Consumes `inputAmount` held resources per conversion, emits an output. | `inputAmount`, `outputColor`, `capacity` |
| **Register** | Computed value from a formula over variables. | `formula`, `value` |
| **Delay** | Holds a batch for `delay` steps, then releases it together. | `delay` |
| **Queue** | Single‑server FIFO: one unit in service at a time for `processTime` steps. | `processTime` |

**Display vs. chart value.** A node's `chartValue` (used by history, charts, and
goals) is its resource count for pools/converters/queues/delays, `drained` for
drains, `value` for registers, and the remaining stock for a limited source (0 for
an infinite one).

---

## 3. Activation modes

| Mode | Fires when… |
| --- | --- |
| `automatic` | Every step (subject to the time mode — see §8). |
| `passive` | Only when **triggered** by a state connection. |
| `interactive` | When clicked, or fired by the **artificial player**. |
| `starting` | Once, on step 1. |

A node can additionally be **gated by activators** (§5): even an automatic node
won't fire while an incoming activator's condition is false.

---

## 4. Resource connections

Resource connections move resources from source to target. Their **rate** is
evaluated each time they fire:

| Rate mode | Meaning |
| --- | --- |
| **fixed** | A constant number. |
| **dice** | `XdY` notation, e.g. `2d6` → 2–12. |
| **formula** | A JavaScript‑style expression over the shared variables, e.g. `treasury * 0.1`. Invalid names/expressions safely evaluate to 0. |
| **distribution** | A sample from `normal` (mean, std), `uniform` (min, max), `exponential` (mean), or `poisson` (λ). Always a non‑negative integer. |

Additional per‑connection controls:

- **Interval** — only fire every N steps.
- **Chance %** — fire with probability `chance/100` each time.
- **Colour / type filter** — only move resources of a given colour (type).
- **Condition** — compare the **source value** *or* a **named variable** against a
  threshold with `> >= < <= == !=`; skip the connection when false.

Rates are rounded to integers; the engine works in whole resources.

---

## 5. State connections

State connections carry **information**, not resources. One connection can play any
combination of these roles:

- **Variable** — each step, publish the source's value under a name into the shared
  store (pool count, source `produced`, drain `drained`, or register `value`). Use
  it in register or rate formulas.
- **Trigger (`✷`)** — when the source fires, immediately fire the target. Drives
  cascades and on‑demand passive nodes. The cascade is loop‑guarded (bounded at
  5000 fire events per tick) so cycles can't hang the engine.
- **Fail / reverse trigger** — fire the target when the source **fails** to act this
  step (e.g. an empty pool, a dry limited source). The opposite of a trigger.
- **Activator (`⊢`)** — the target may only fire while the source value satisfies a
  condition.
- **Modifier (`Δ`)** — each step, add `factor × sourceValue` to the target's
  resources (negative = decay). Targets pools and converters, respects their
  capacity, and reads the **committed, post‑flow** state. Self‑connections are
  allowed, which gives interest/decay in place.

---

## 6. Flow direction: push vs. pull

By default flow is **push**: a firing source/pool/gate/converter/delay/queue drives
its outgoing connections.

Pools and drains can instead be set to **pull**. A pull node draws each incoming
connection's rate from its provider (a pool's stock or a source). `pullPolicy`
controls partial vs. atomic:

- **any** — take whatever each provider can supply.
- **all** — move nothing unless **every** provider can supply its full rate.

Each connection is driven by exactly one endpoint — **pull takes precedence** — so a
connection is never double‑counted.

---

## 7. The tick, in order

From `SimEngine._tick()`:

1. **Seed the fire queue.** Automatic nodes (subject to the time mode) and, on step
   1, starting nodes. Triggers cascade as nodes fire (loop‑guarded).
2. **Fire each node.** Pull nodes draw first; then gates/converters/sources/pools
   propose outgoing movements. Proposals are accumulated into a per‑tick context —
   nothing is committed yet.
3. **Reverse triggers.** Automatic nodes that *didn't* fire pulse their fail‑trigger
   targets.
4. **Artificial player.** Scheduled/conditional interactive nodes fire as if clicked
   (still within this tick).
5. **Advance delays and queues.** Matured delay batches and finished queue units are
   released (respecting target capacity).
6. **Commit atomically** (`_applyCtx`). All accumulated movements apply at once.
7. **Apply modifiers**, then **refresh variables** and **evaluate registers**.

### Fair allocation under contention

When several outgoing connections compete for one pool's resources, the engine uses
**max‑min fair** integer allocation: every active connection gets its first unit
before any gets a second, and so on. This is order‑independent, so a greedy
high‑rate connection can't starve a small or probabilistic one. The sub‑unit
remainder (when a pool is too scarce to give everyone one unit) is handed out
round‑robin in connection order.

### Capacity & conservation

Targets reserve capacity as they accept resources within a tick, so two connections
can't jointly overfill the same node. Allocation is **work‑conserving**: if a target
is full, the share it can't take is offered to other outputs rather than wasted. A
share that still can't be placed stays in the source and is retried next step — it's
**never lost**. A closed resource cycle conserves its total exactly.

---

## 8. Variables & registers

The shared store is rebuilt each tick: first seeded from the diagram's **parameters**
(user‑defined constants), then overwritten by every state connection's published
**variable**, then by every **register** value (published under the register's label
if it's a valid identifier).

Registers are evaluated to a **fixpoint** (bounded by the register count) so a
register that references another register's label resolves correctly in a single
tick, regardless of creation order.

**One‑step lag.** Variables are committed at the *end* of a tick, so a connection
condition or rate formula reads the value from the **previous** step. This is by
design and is consistent across the model (the unit tests encode it explicitly).

---

## 9. Time modes

- **Synchronous (`sync`)** — turn‑based. Every automatic node fires once per step.
- **Asynchronous (`async`)** — real‑time feel. Each automatic node fires on its own
  rhythm: every `fireEvery` steps, offset by `firePhase`. Starting nodes still fire
  once on step 1.

---

## 10. The artificial player

A scripted actor that fires **interactive** nodes during a run, as if a player were
clicking them. Each rule targets a node and fires either:

- **on an interval** — every N steps, or
- **on a condition** — while a named variable satisfies a comparison.

Because variables lag by one step (§8), a condition rule reacts to the previous
step's value. Rules fire inside the normal tick, so their flows still commit
atomically with everything else.

---

## 11. Coloured resources & named types

Resources carry a **colour** end‑to‑end (`colorMap`). Sources emit their
`resourceColor`; converters emit their `outputColor`; gates and pools preserve the
colours they move; filters can restrict a connection to one colour.

**Named resource types** are a thin naming layer on top: a diagram‑level registry of
`{ name, color }`. The colour stays the underlying tracking key, so the engine is
unchanged — types just let the UI show readable names ("Gold", "Wood") and per‑type
holdings/totals. `Diagram.resourceTypeName(color)` resolves a colour to its type
name (case‑insensitive).

---

## 12. Goals / end conditions

Any node can carry an end/goal condition (`operator`, `value`) compared against its
`chartValue`. When met, the engine records the terminal state and stops. Pressing
Run again clears the goal and resumes (it re‑triggers if the condition still holds) —
there's no "resume past goal" mode.

---

## 13. Monte Carlo (batch analysis)

`runMonteCarlo(runs, maxSteps)` clones the diagram into an isolated `Diagram` +
`SimEngine` per trial (fresh RNG), runs each up to `maxSteps` (or until its goal),
and summarises every tracked node's final value as **mean / min / p10 / p50 / p90 /
max**, plus the **goal reach‑rate** and **end‑step** statistics. It never touches the
live diagram.

---

## 14. Known limitations & intentional choices

- **Integer granularity.** One time granularity (integer steps); rates round to
  integers.
- **Goals are terminal on Run.** Reaching a goal stops the engine; Run clears and
  resumes.
- **Place tool stays active** after placing (for rapid placement) unless auto‑revert
  is on.
- **Sub‑unit remainder** is handed out round‑robin in connection order; only matters
  when a pool can't give every output one unit.
- **Capacity‑blocked shares aren't re‑routed mid‑tick** when two connections target
  the *same* full node (rare); the resources stay in the source and retry next step
  (never lost).
- **Edge‑targeting a connection** (a state link modifying another connection) isn't
  supported; connection‑rate modulation is done with formula rates instead.

These mirror the notes in [ROADMAP.md](../ROADMAP.md).
