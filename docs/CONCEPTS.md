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
| **Queue** | FIFO line feeding `servers` parallel servers; each unit takes `processTime` steps, so throughput is `servers ÷ processTime`. Optional `maxLine` (balk) and `patience` (renege) model lost demand. Tracks live metrics (throughput, waiting time, peak line, balked/reneged losses). | `processTime`, `servers`, `maxLine`, `patience` |
| **Trader** | Atomic exchange between two partners: `A → T → B` means A pays the in‑rate to B and B pays the out‑rate back to A — all or nothing. Extra in/out pairs trade in wiring order. | `trades` |

**Display vs. chart value.** A node's `chartValue` (used by history, charts, and
goals) is its resource count for pools/converters/queues/delays, `drained` for
drains, `value` for registers, the remaining stock for a limited source (0 for
an infinite one), and the completed-exchange count for a trader.

**Starting amount.** A resource‑holding node's starting stock is simply what it holds
when the run begins — you set it on the node (a pool can start holding 50, say). There
is no separate "initial value" field: whatever a node holds at step 0 *is* its starting
amount, and `reset()` restores every node to it. Resource counts never go below 0 (§14).

**Trader details.** The trader never holds resources — its connections are trade
routes that only the trader itself drives when it fires (pools won't push into
one). A trade executes only if both sides can pay their full rate *and* receive
what the other pays (capacity is credited with what a node pays away, so a full
pool can still swap like‑for‑like). Each connection's colour filter constrains
what that side pays; resources keep their colours as they change hands. An
unlimited source may be a partner (it pays freely but accepts nothing back, so
the return rate must be 0).

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
| **formula** | A [math.js](https://mathjs.org/) expression over the shared variables, e.g. `treasury * 0.1`, `round(gold ^ 1.5)`, `a > 5 ? 10 : 0`, `randomInt(1, 7)`. Expressions math.js can't evaluate fall back to the legacy JavaScript‑style evaluator, so old diagrams keep working. Invalid names/expressions safely evaluate to 0. |
| **distribution** | A sample from `normal` (mean, std), `uniform` (min, max), `exponential` (mean), or `poisson` (λ). Always a non‑negative integer. |

Additional per‑connection controls:

- **Interval** — only fire every N steps.
- **Chance %** — fire with probability `chance/100` each time.
- **Colour / type filter** — only move resources of a given colour (type).
- **Condition** — compare the **source value** *or* a **named variable** against a
  threshold with `> >= < <= == !=`; skip the connection when false.

A resource connection **out of a gate** carries a **weight** (its share of the
split) instead of a rate. A weight can be a fixed number *or* a **formula** over
the shared variables — re‑evaluated each step, just like a formula rate — so the
split itself can shift as the run unfolds (e.g. send more flow down the hard
branch as `difficulty` climbs). An invalid or negative formula weight routes
nothing down that output.

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
- **Modifier (`Δ`)** — adjusts the target's resources **in place** each step (no
  resource flows), in one of four **modes**:

  | Mode | Effect each step |
  | --- | --- |
  | `rate` *(default)* | add `factor × sourceValue`. `factor` is a *fraction*, so `0.05` means **+5%** — this is interest/growth; a negative factor decays. |
  | `step` | add a flat `factor` every step. |
  | `pulse` | add a flat `factor` only on steps when the source **fired**. |
  | `delta` | add `factor × (change in sourceValue since last step)`. |

  The amount can be a **formula** (over the shared variables) instead of a constant.
  Modifiers target only **pools and converters**, respect capacity, never push a
  target below 0, and read the **committed, post‑flow** state. The per‑step delta is
  **rounded to an integer** (§14), so a tiny percentage of a small pool can round to 0
  and appear "stuck" — scale the numbers up if a slow drift isn't moving.
  Self‑connections are allowed: a node modifying itself is how you do in‑place
  interest, decay, or a homemade **clock** (`step` mode, `+1` per step).

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

**Computing vs. accumulating.** A register is **recomputed from its formula every
tick** — it holds an *instantaneous* value, not a running total, and cannot read its
own previous result. To **accumulate or compound** a value over time (a cumulative
total, an inflation index, a savings balance), use a **pool with a self‑modifier**
instead: the pool carries the value forward and the self‑modifier grows or decays it
each step. Rule of thumb: *a register computes, a pool remembers.*

**There is no built‑in time variable.** A formula can't read the current step number
directly. When you need time — a countdown, an age, a seasonal cycle — build a
**clock**: a pool with a `step`‑mode self‑modifier of `+1`, published as a variable
(say `t`). Any formula can then use `t`; for example a seasonal multiplier
`1 + 0.5 * sin(2 * pi * t / 52)` rises and falls on a 52‑step year.

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

- **Integer granularity & non‑negative values.** Time advances in whole steps;
  connection rates *and* modifier deltas round to integers, and resource counts never
  fall below 0. There is no concept of debt or a negative balance: model a loss by
  **draining** resources out or applying a **negative‑`factor` modifier** (which stops
  at 0), not a negative quantity. Random draws on a *rate* are non‑negative too, so
  model downside with a drain or a negative modifier rather than a negative rate.
- **Goals are terminal on Run.** Reaching a goal stops the engine; Run clears and
  resumes.
- **Place tool stays active** after placing (for rapid placement) unless auto‑revert
  is on.
- **Sub‑unit remainder** is handed out round‑robin in connection order; only matters
  when a pool can't give every output one unit.
- **Capacity‑blocked shares aren't re‑routed mid‑tick** when two connections target
  the *same* full node (rare); the resources stay in the source and retry next step
  (never lost).
- **Sub‑unit remainder across competing pushers** is handed out round‑robin in
  source‑node order; only observable when several source pools push into the same
  capacity‑limited target and available room is not evenly divisible among them.
  Conservation always holds — nothing is created or lost.
- **Edge‑targeting a connection** (a state link modifying another connection) isn't
  supported; connection‑rate modulation is done with formula rates instead.

These mirror the notes in [ROADMAP.md](../ROADMAP.md).

---

## 15. Worked example: a feedback loop

The pieces above combine into feedback loops, which is where the model gets its life.
Here is the smallest complete one — a population that grows fast when small and levels
off near a carrying capacity (logistic growth, the classic *negative* feedback loop).

**Build it:** *(to draw a self‑loop, click the same node twice with the state tool.)*

1. Add a **Pool** named `Rabbits` and set its **Starting amount** to `10` (§2).
2. Draw a **state connection from `Rabbits` back to `Rabbits`**, role **Variable**,
   name `r`. This publishes the population count as `r` so formulas can read it (§5, §8).
3. Draw a **second state connection from `Rabbits` to itself**, role **Modifier**,
   mode `step`, with a **formula** amount: `round(0.3 * r * (1 - r / 100))`.

That formula *is* the loop. When `r` is small, `(1 - r / 100)` is near 1, so the pool
grows quickly. As `r` climbs toward 100, the term shrinks toward 0 and growth stops —
the population regulates itself. Cross 100 and the term goes negative, nudging it back
down. There's your negative feedback.

**Run it** and the count traces an S‑curve: a slow start, a fast middle, a plateau
near 100. Two model rules from above are visible here — the **one‑step lag** (the
modifier reads the previous step's `r`, §8) and **integer rounding** (the increment is
whole rabbits, so growth stalls cleanly at the cap rather than wobbling on fractions,
§14).

**Make it a predator‑prey loop** by adding a second pool, `Foxes`, publishing its
count as `f`, then: a modifier on `Rabbits` of `round(-0.01 * r * f)` (foxes eat
rabbits) and a modifier on `Foxes` of `round(0.005 * r * f - 0.1 * f)` (foxes grow by
eating, starve otherwise). Two coupled loops with a lag produce the boom‑and‑bust
oscillation of a real ecosystem.
