# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A browser-based, Machinations-style designer for resource economies and game-system
feedback loops, with a discrete-time simulation engine. **Pure vanilla JS, no build
step, no framework** — static files served as-is. The only runtime dependency is the
vendored math.js bundle (`vendor/math.min.js`) powering the formula language.

See `README.md` for the full feature list and `docs/CONCEPTS.md` for the simulation
model (tick order, fair allocation, one-step variable lag).

## Commands

```bash
# Serve the app (required for the smoke test, and recommended over file://).
python3 -m http.server 8080            # → http://localhost:8080/

# Headless unit tests — engine/model only, no browser. Run this for any change
# to js/model.js or js/engine.js.
npm install                            # once, pulls mathjs for the formula tests
node test/run.js                       # (alias: npm test)

# Browser smoke test — drives the real app via Playwright/Chromium and FAILS on
# any console or page error. Run this for any change to the UI layer (app*.js,
# renderer/editor/charts, index.html, css). Needs the server above already up.
NODE_PATH=$(npm root -g) node test/smoke.js     # (alias: npm run smoke)
# SMOKE_URL overrides the default http://localhost:8080/

# Headless CLI — simulate a saved diagram JSON from the terminal.
node cli.js diagram.json --steps 500 > trace.csv
node cli.js diagram.json --runs 1000 --steps 200 --seed 42 --param rate=3
```

**Running a single unit test:** `test/run.js` has no filter/grep flag — every
`test(...)` call runs inline, top to bottom, as the file loads. To iterate on one
test, temporarily comment out the others (there is no `test.only`).

## Architecture

### No build, load order matters

`index.html` loads every script with plain `<script>` tags in dependency order.
There is no bundler and no ES modules — files communicate through globals
(`class Diagram`, `const NodeType`, etc.). Adding a `.js` file means adding a
`<script>` tag in the right position.

### The model/engine layer is DOM-free — keep it that way

`js/model.js` (data classes: `MNode`, `MConnection`, `MGroup`, `MNote`, `MChart`,
`Diagram`, plus pure helpers like `evalFormula`, `rollDice`, `sampleDist`) and
`js/engine.js` (`SimEngine`: tick loop, fair allocation, triggers/activators/
modifiers, variables/registers, Monte Carlo) touch **no DOM**. This is load-bearing:
it lets `test/run.js` load them into a bare `new Function` sandbox, lets `cli.js`
run them under Node, and lets Monte Carlo clone a `Diagram` + `SimEngine` per trial.
Do not reach for `document`/`window` in these two files.

### The App class is split across files via prototype mixins

`App` is one logical class, but it was too large for one file, so it is physically
split. **`js/app.js` declares `class App`** (constructor, lifecycle, history/undo,
scrubbing, onboarding, menus, KB, toast, and the big `_bindControls` wiring). The
rest of its methods live in sibling files, each a throwaway helper class whose
methods are copied onto `App.prototype`:

| File | What lives here |
| --- | --- |
| `js/app-props.js` | Properties panel + diagram-rail feature editors |
| `js/app-demos.js` | Built-in example diagrams (`_demo*`) |
| `js/app-analysis.js` | Monte Carlo, parameter sweeps, sensitivity |
| `js/app-fields.js` | Reusable property-panel form primitives (`_field`, `_section`, …) |
| `js/app-library.js` | Library, components, starter templates |
| `js/app-clipboard.js` | Copy/paste/duplicate + right-click context menu |
| `js/app-export.js` | SVG/PNG/CSV export + shareable-URL encoding |

The mixin pattern at the bottom of each file:

```js
class AppProps { /* methods, plain class-method syntax */ }
for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppProps.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
```

**Invariants when working here:**
- All these methods run on the App instance — they call each other via `this._x()`
  regardless of which file they sit in. There is no per-file state; pick the file by
  topic/cohesion.
- The mixin `<script>` tags **must come after `js/app.js`** in `index.html` (they
  reference `App`). Construction is safe because `new App()` runs inside a
  `DOMContentLoaded` handler at the end of `app.js`, which fires only after every
  synchronous script has executed — so the prototype is fully assembled first.
- Adding a new App method: drop it in the matching mixin file (or core `app.js`).
  Adding a new mixin file: add its `<script>` after `app.js`.

### How it's wired together

`App` owns one `Diagram`, `SimEngine`, `Renderer`, and `Editor`. The engine drives
the app through callbacks set in the constructor — `engine.onStep` (animate balls/
flow badges, update sparklines/timeline/readouts) and `engine.onEnd`. The editor
reports up through `editor.onSelect`, `onChange` (→ `_commit`), `onHint` (→ toast),
`onToolChange`, and `onContextMenu`. When adding interaction, prefer extending these
callback seams over reaching across objects.

### Serialization is the single source of truth

`Diagram.toJSON()` / `loadJSON()` back **everything** persistent: save/load, the
library, autosave, undo/redo snapshots, shareable URLs (base64 in `#d=`), and the
test round-trips. New fields are written **only when they differ from defaults**, so
files stay small and forward-compatible — preserve that pattern when adding fields,
and add a round-trip assertion in `test/run.js`.

### Undo/redo

Every structural mutation funnels through `App._commit()`, which pushes a JSON
snapshot onto `_undoStack` (100 deep). `undo`/`redo` restore via `_restoreState`.
If you add a mutation path, make sure it ends in `_commit()` (or `_commitReplace`
for whole-diagram swaps).

## Conventions

- **CSS design tokens** in `css/style.css` `:root` (`--bg`, `--panel`, `--panel2`,
  `--border`, `--text`, `--text-dim`, `--accent #4a9eff`, `--red`, `--green`,
  `--font`). Style with tokens, not hardcoded hex. Note: `.btn-primary` and the
  running Run button use darker shades (`#1565c0` / `#2e7d32`) rather than raw
  `--accent`/`--green` to meet WCAG AA contrast against white text — match that when
  putting text on a colored fill.
- **Shared App helpers:** `_faIcon(name)` (Font Awesome `<i aria-hidden>`),
  `_toast(msg)`, and `_confirmGuard(message, title)` (Promise-based styled confirm —
  use instead of `confirm()`).
- **localStorage keys:** `sim_library`, `sim_components`, `sim_autosave`,
  `sim_palette_sections`, `sim_seen_welcome`, `sim_seen_tour`.
- Develop on a feature branch and keep the model/engine DOM-free; run the matching
  test (`run.js` for engine changes, `smoke.js` for UI changes) before committing.
