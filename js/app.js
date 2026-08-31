// UI accent color schemes selectable per simulation (meta.scheme). Each remaps
// the two accent CSS variables; 'default' restores the stylesheet values.
const COLOR_SCHEMES = {
  default: { label: 'Lime (default)', accent: '#b6e94d', accent2: '#ffa726' },
  forest:  { label: 'Forest',          accent: '#66bb6a', accent2: '#ffca28' },
  sunset:  { label: 'Sunset',          accent: '#ff7043', accent2: '#ab47bc' },
  candy:   { label: 'Candy',           accent: '#ec407a', accent2: '#26c6da' },
  royal:   { label: 'Royal',           accent: '#7e57c2', accent2: '#ffd54f' },
  mono:    { label: 'Monochrome',      accent: '#90a4ae', accent2: '#cfd8dc' },
};

// Curated Google Fonts offered as the display font (meta.font). '' keeps the
// built-in stack. Families are fetched from fonts.googleapis.com on demand.
const GOOGLE_FONTS = [
  'Roboto', 'Open Sans', 'Nunito', 'Poppins', 'Space Grotesk',
  'Source Sans 3', 'Lexend', 'Merriweather', 'JetBrains Mono',
];

class App {
  constructor() {
    this.diagram = new Diagram();
    this.engine = new SimEngine(this.diagram);
    this.renderer = new Renderer(document.getElementById('canvas'), this.diagram, this.engine);
    this._minimap = new Minimap(
      document.getElementById('minimap'), document.getElementById('minimap-canvas'),
      this.diagram, this.renderer);
    // Keep the minimap (content + viewport rect) in sync with renders and pans.
    this.renderer.onRender = () => this._minimap.update();
    this.editor = new Editor(
      document.getElementById('canvas'),
      this.diagram, this.renderer, this.engine,
      (id, type, count) => this._onSelect(id, type, count),
      () => this._commit(),
    );
    // Keep the toolbar's active-tool highlight in sync when the editor reverts
    // its own tool (e.g. auto-revert to Select after placing a node).
    this.editor.onToolChange = (tool) => this._syncToolButtons(tool);
    this.editor.onHint = (msg) => this._toast(msg);
    this.editor.onContextMenu = (ctx, x, y) => this._showContextMenu(ctx, x, y);
    // The editor's key handler is on window, so Delete would reach the canvas
    // behind an open dialog. App owns which overlays count as modal.
    this.editor.isKeyboardBlocked = () => this._modalOpen();

    this._selectedId = null;
    this._selectedType = null;
    this._sparklines = new Map();

    // Undo / redo (snapshot stacks of diagram JSON).
    this._undoStack = [];
    this._redoStack = [];
    this._lastState = null;

    this.timeline = new TimelineChart(document.getElementById('timeline-canvas'), document.getElementById('tl-legend'), this.diagram, this.engine);
    this._timelineVisible = false;

    // History scrubbing: when active, _scrubIndex points at an engine.history
    // entry being previewed (non-destructively) on the canvas and chart.
    this._scrubIndex = null;
    this._scrubPlayTimer = null;

    this._activeFeature = null; // which diagram-rail feature occupies the props panel
    this._flowReadout = true;   // transient "+N" flow badges on connections during a run
    this._tour = null;          // { idx, base } while the interactive tour is running
    // Stable ref for the listeners. Scroll fires far more often than the
    // spotlight needs moving and _positionTour measures the target, so coalesce
    // to one placement per frame.
    this._tourReposition = () => {
      if (this._tourRaf) return;
      this._tourRaf = requestAnimationFrame(() => { this._tourRaf = 0; this._positionTour(); });
    };
    this._tourRaf = 0;
    this._tourKey = (e) => { if (e.key === 'Escape') this._endTour(false); };

    // Scenario branching: checkpoints are full sim-state snapshots you can
    // fork from; branches are finished timelines kept as ghost traces in the
    // timeline chart for comparison. Session-only — not saved with the diagram.
    this._checkpoints = [];  // { id, name, step, state }
    this._branches = [];     // { id, name, history, visible }
    this._cpSeq = 0;
    this._branchSeq = 0;
    this.timeline.getBranches = () => this._branches;
    // Spike attribution: clicking a point on the timeline explains the change
    // at that step (breakdown popover + canvas spotlight, app-analysis.js).
    this.timeline.onInspect = (nodeId, index, cx, cy) => this._showWhyPopover(nodeId, index, cx, cy);

    this._bindControls();
    this._watchForeignAutosave();
    this._watchVisibility();
    this._initLibrary();
    this._initMenus();
    this._initPalette();
    this._initDiagramRail();

    this.engine.onStep = (step, fired, transfers) => {
      document.getElementById('step-counter').textContent = `Step ${step}`;

      // Animate balls for each transfer
      const ballDur = Math.max(150, Math.min(1200, 700 / this.engine.speed));
      for (const { connId, color, amount } of transfers) {
        const pathEl = this.renderer.getConnPathEl(connId);
        if (pathEl) this.renderer.balls.spawn(pathEl, amount, color, ballDur);
      }

      // Live flow readout: a transient "+N" badge per connection showing the
      // actual amount that moved this step (the static label only shows the
      // configured rate). Amounts are summed across colours; the badge takes the
      // colour of the largest contributor.
      if (this._flowReadout) {
        const agg = new Map(); // connId -> { amount, color, top }
        for (const { connId, color, amount } of transfers) {
          if (!(amount > 0)) continue;
          const e = agg.get(connId) || { amount: 0, color, top: 0 };
          e.amount += amount;
          if (amount > e.top) { e.top = amount; e.color = color; }
          agg.set(connId, e);
        }
        const flowDur = Math.max(450, Math.min(1400, 900 / this.engine.speed));
        for (const [connId, e] of agg) {
          const pathEl = this.renderer.getConnPathEl(connId);
          if (pathEl) this.renderer.flowFx.flash(pathEl, this._fmtFlow(e.amount), e.color, flowDur);
        }
      }

      // Dash-march the connections that actually carried resources this step.
      this.renderer.setFlowing(transfers.filter(t => t.amount > 0).map(t => t.connId));

      if (fired.length) this.renderer.setFiring(fired);
      // ponytail: a tick with no fires and no transfers changes no node value, so
      // render() would only re-walk the DOM to repaint identical numbers. Skip it.
      // Keep rendering when charts exist — their x-axis still extends at rest.
      else if (transfers.length || this.diagram.charts.size) this.renderer.render();

      this._updateSparklines();
      if (this._timelineVisible) this.timeline.update();
      this._refreshResourceCount();
      this._refreshTypeReadouts();
      // Keep the live "Watch" panel ticking with the run.
      if (this._activeFeature === 'monitor') this._renderProps();
      // Running the sim may complete the tour's final action step.
      this._tourCheck();
    };

    this.engine.onEnd = (ended) => {
      const status = document.getElementById('sim-status');
      if (status) status.replaceChildren(this._faIcon('flag-checkered'),
        document.createTextNode(` ${ended.label} reached ${ended.value} at step ${ended.step}`));
      this._syncRunButton();
      this.renderer.render();
      this._refreshScrubber();
    };

    this._initDiagram();
    this._maybeWelcome();
  }

  // Compact number for flow badges: integers as-is, fractions to 2 sig decimals.
  _fmtFlow(v) {
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    return Number.isInteger(n) ? String(n) : String(+n.toFixed(2));
  }

  // First-run onboarding: a one-time welcome explaining what the app is and the
  // place → connect → Run loop. Skipped in embed mode and when opening a shared
  // link (those users arrived with intent). Dismissing it sets a flag so it
  // never nags again; it stays reachable from Help → "Getting started".
  _maybeWelcome() {
    if (document.body.classList.contains('embed')) return;
    if (/[#&]d=/.test(location.hash)) return;
    let seen = false;
    try { seen = localStorage.getItem('sim_seen_welcome') === '1'; } catch { /* ignore */ }
    if (seen) return;
    // Mark as seen on show, so any dismissal path (button, backdrop, Escape)
    // leaves it dismissed for good.
    try { localStorage.setItem('sim_seen_welcome', '1'); } catch { /* ignore */ }
    this._showModal('welcome-overlay');
  }

  _dismissWelcome() {
    try { localStorage.setItem('sim_seen_welcome', '1'); } catch { /* ignore */ }
    this._hideModal('welcome-overlay');
  }

  // Does the model contain any stochastic element? If so, a single run only
  // shows one sample and Monte Carlo (many runs) is worth surfacing.
  _hasRandomness() {
    for (const c of this.diagram.connections.values()) {
      if (c.rateMode === RateMode.DICE || c.rateMode === RateMode.DISTRIBUTION) return true;
      if (Number(c.chance) < 100) return true;
      if (Number(c.triggerChance) < 100) return true;
    }
    for (const n of this.diagram.nodes.values())
      if (n.type === NodeType.GATE && n.gateMode === 'random') return true;
    for (const v of (this.diagram.customVars || []))
      if (v && v.kind && v.kind !== 'math') return true;
    return false;
  }

  // One-time nudge: the first time a *stochastic* model is run, point at
  // Analysis ▸ Batch (Monte Carlo) — it's otherwise buried in a menu and
  // invisible until you know to look (a usability pass flagged it). Suppressed
  // during the tour (so it doesn't stack on a coach-mark) and in embed mode.
  _maybeMonteCarloHint() {
    if (this._tour) return;
    if (document.body.classList.contains('embed')) return;
    let seen = false;
    try { seen = localStorage.getItem('sim_seen_mc_hint') === '1'; } catch { /* ignore */ }
    if (seen || !this._hasRandomness()) return;
    try { localStorage.setItem('sim_seen_mc_hint', '1'); } catch { /* ignore */ }
    this._toast('This model has randomness. Try Analysis ▸ Batch (Monte Carlo) to run it many times and see the spread of outcomes.');
  }

  // ── Interactive tour ─────────────────────────────────────────────────────────
  // Coach-marks over the real UI that teach the place → connect → Run loop by
  // having the user actually do it. Each step spotlights a control and advances
  // when the corresponding action happens (detected via _commit / onStep), so
  // it's learn-by-doing, not a slideshow. Launchable from the welcome overlay
  // and from Help → "Take the tour"; "Skip tour" ends it at any point.

  _countNodeType(type) {
    let n = 0;
    for (const node of this.diagram.nodes.values()) if (node.type === type) n++;
    return n;
  }

  _countResConns() {
    let n = 0;
    for (const c of this.diagram.connections.values()) if (c.type === ConnectionType.RESOURCE) n++;
    return n;
  }

  // A connection's rate configuration as a comparable key — used by the tour's
  // "set a rate" step to notice an edit as a delta from the moment that step
  // was entered (so replaying on an existing diagram still teaches it).
  _rateKey(c) { return `${c.rateMode}:${c.rate}`; }

  _rateSnapshot() {
    const m = {};
    for (const c of this.diagram.connections.values())
      if (c.type === ConnectionType.RESOURCE) m[c.id] = this._rateKey(c);
    return m;
  }

  // How many "do this" action steps the tour has (excludes the info hand-off
  // cards and the final card) — drives the "Step N of M" counter.
  _actionStepCount() {
    return this._tourSteps().filter(s => !s.final && !s.info).length;
  }

  // Steps are evaluated as deltas from the baseline captured at start, so the
  // tour works whether you begin on an empty canvas or an existing diagram.
  _tourSteps() {
    return [
      {
        target: '[data-tool="place-source"]',
        text: 'Click <b>Source</b>, then click anywhere on the canvas to drop it. A Source <b>produces</b> resources.',
        done: () => this._countNodeType(NodeType.SOURCE) > this._tour.base.source,
      },
      {
        target: '[data-tool="place-pool"]',
        text: 'Now place a <b>Pool</b> to the right of the Source. A Pool <b>stores</b> whatever flows into it.',
        done: () => this._countNodeType(NodeType.POOL) > this._tour.base.pool,
      },
      {
        target: '[data-tool="connect-resource"]',
        text: 'Pick the <b>Resource</b> tool, then <b>drag from the Source to the Pool</b> to connect them.',
        done: () => this._countResConns() > this._tour.base.conns,
      },
      {
        // The connection is auto-selected after the drag, so its Rate field is on
        // screen. Teach the single most important economy knob: the flow rate.
        target: '[data-tour="rate"]',
        text: 'With the connection selected, find its <b>Rate</b> on the right. That\'s how many resources move each step, your faucet\'s strength. <b>Change it from 1 to 5.</b>',
        enter: () => { this._tour.rateBase = this._rateSnapshot(); },
        done: () => {
          const base = this._tour.rateBase || (this._tour.rateBase = {});
          for (const c of this.diagram.connections.values()) {
            if (c.type !== ConnectionType.RESOURCE) continue;
            // Adopt connections drawn after the snapshot rather than ignoring
            // them. Skipping them meant that deleting the connection here and
            // drawing a fresh one left the step permanently unsatisfiable: no
            // edit to the new connection could ever count, and the step has no
            // Next button to escape with.
            if (base[c.id] === undefined) { base[c.id] = this._rateKey(c); continue; }
            if (base[c.id] !== this._rateKey(c)) return true;
          }
          return false;
        },
      },
      {
        target: '#btn-run',
        text: 'Press <b>Run</b> to watch resources stream from the Source into the Pool at the rate you set, live.',
        done: () => this.engine.running || this.engine.step > this._tour.base.step,
      },
      // ── Hand-off: point at where the real power lives, so a "graduate" doesn't
      //    exit onto a blank canvas with no map. Click-through (info) cards.
      {
        target: '#btn-library',
        info: true,
        text: 'That\'s the loop: <b>place → connect → set a rate → Run</b>. Now the payoff. The <b>Library</b> has ready-made economies (try <b>F2P Mobile Economy</b>) you can open and pull apart.',
      },
      {
        target: '#diagram-rail',
        info: true,
        text: 'This rail holds the model\'s brains: <b>Parameters</b> and <b>Variables</b> to drive formulas, <b>Resource types</b>, and a live <b>monitor</b>. Rates can be formulas, dice or distributions too, not just fixed numbers.',
      },
      {
        target: '#btn-analysis-menu',
        info: true,
        text: 'Balancing an economy? <b>Analysis → Batch (Monte Carlo)</b> runs your model hundreds of times and shows the spread of outcomes, the fastest way to tune a curve.',
      },
      {
        target: '#btn-run',
        final: true,
        text: 'You\'re set. Build from scratch, or open a Library model and make it yours. Replay this tour any time from <b>Help</b>.',
      },
    ];
  }

  _startTour() {
    // Clean slate for the Run step's baseline, and close any overlays that would
    // sit on top of the coach-marks.
    this.engine.stop();
    this._syncRunButton();
    this._hideModal('welcome-overlay');
    this._hideModal('help-overlay');

    this._tour = {
      idx: 0,
      entered: -1,
      base: {
        source: this._countNodeType(NodeType.SOURCE),
        pool: this._countNodeType(NodeType.POOL),
        conns: this._countResConns(),
        step: this.engine.step,
      },
    };
    document.getElementById('tour').classList.remove('hidden');
    window.addEventListener('resize', this._tourReposition);
    // Scroll does not bubble, so capture is what catches it from the palette,
    // the properties panel or any other scrollable ancestor. Without this the
    // cut-out stays where the target used to be and highlights the wrong control.
    window.addEventListener('scroll', this._tourReposition, { capture: true, passive: true });
    window.addEventListener('keydown', this._tourKey, true);
    this._enterStep(this._tourSteps()[0]);
    this._renderTourStep();
  }

  _renderTourStep() {
    if (!this._tour) return;
    const steps = this._tourSteps();
    const step = steps[this._tour.idx];
    document.getElementById('tour-count').textContent =
      step.final ? 'All set' : step.info ? 'Next steps' : `Step ${this._tour.idx + 1} of ${this._actionStepCount()}`;
    document.getElementById('tour-text').innerHTML = step.text;
    // Action steps advance on the user doing the thing (no button); info and
    // final cards advance/close on a click.
    const next = document.getElementById('tour-next');
    next.classList.toggle('hidden', !(step.final || step.info));
    next.textContent = step.final ? 'Finish' : 'Next';
    document.getElementById('tour-skip').classList.toggle('hidden', !!step.final);
    // Bring the target into view before measuring it. The palette and the
    // properties panel both scroll, and on a short window a step's control can
    // sit below the fold, which used to leave the card pointing at a cut-out
    // nobody could see. "nearest" scrolls the least amount that works and does
    // nothing when the control is already visible, so a step that needs no
    // scrolling does not twitch.
    const tgt = step.target ? document.querySelector(step.target) : null;
    if (tgt && tgt.scrollIntoView) tgt.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this._positionTour();
  }

  // Place the spotlight cut-out over the current target and the coach card
  // beside it (right → below → left), clamped to the viewport.
  _positionTour() {
    if (!this._tour) return;
    const step = this._tourSteps()[this._tour.idx];
    const spot = document.getElementById('tour-spotlight');
    const coach = document.getElementById('tour-coach');
    const target = step.target ? document.querySelector(step.target) : null;
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = coach.offsetWidth || 290, ch = coach.offsetHeight || 140;

    if (!target) {
      spot.classList.add('off');
      spot.style.cssText += ';width:0;height:0;left:-9999px;top:-9999px;';
      coach.style.left = `${(vw - cw) / 2}px`;
      coach.style.top = `${(vh - ch) / 2}px`;
      return;
    }
    spot.classList.remove('off');
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.style.left = `${r.left - pad}px`;
    spot.style.top = `${r.top - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;

    const gap = 14;
    let left = r.right + gap, top = r.top;          // prefer right
    if (left + cw > vw - 8) {                        // else left
      left = r.left - cw - gap;
      if (left < 8) { left = r.left; top = r.bottom + gap; } // else below
    }
    coach.style.left = `${Math.max(8, Math.min(left, vw - cw - 8))}px`;
    coach.style.top = `${Math.max(8, Math.min(top, vh - ch - 8))}px`;
  }

  // Run a step's one-time enter() hook exactly once on landing — it snapshots a
  // baseline for delta-detected steps, and _tourCheck fires on every edit, so a
  // guard keeps it from re-snapshotting (which would mask the change).
  _enterStep(step) {
    if (!this._tour || this._tour.entered === this._tour.idx) return;
    this._tour.entered = this._tour.idx;
    if (step && step.enter) step.enter();
  }

  // Called after edits/runs: advance past any satisfied action step(s). Info and
  // final cards have no done() so the loop stops there (they advance on click).
  _tourCheck() {
    if (!this._tour) return;
    let steps = this._tourSteps();
    let step = steps[this._tour.idx];
    while (step && !step.final && step.done && step.done()) {
      this._tour.idx++;
      step = steps[this._tour.idx];
    }
    if (this._tour.idx >= steps.length) { this._endTour(true); return; }
    this._enterStep(step);
    this._renderTourStep();
  }

  // The "Next"/"Finish" button: close on the final card, else step forward
  // through the click-through info cards.
  _tourNext() {
    if (!this._tour) return;
    if (this._tourSteps()[this._tour.idx].final) { this._endTour(true); return; }
    this._tour.idx++;
    const steps = this._tourSteps();
    if (this._tour.idx >= steps.length) { this._endTour(true); return; }
    this._enterStep(steps[this._tour.idx]);
    this._renderTourStep();
  }

  _endTour(completed) {
    if (!this._tour) return;
    this._tour = null;
    document.getElementById('tour').classList.add('hidden');
    window.removeEventListener('resize', this._tourReposition);
    window.removeEventListener('scroll', this._tourReposition, { capture: true });
    if (this._tourRaf) { cancelAnimationFrame(this._tourRaf); this._tourRaf = 0; }
    window.removeEventListener('keydown', this._tourKey, true);
    try { localStorage.setItem('sim_seen_tour', '1'); } catch { /* ignore */ }
    if (completed) this._toast('Tour complete. Happy building!');
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────────

  _snapshot() { return JSON.stringify(this.diagram.toJSON()); }

  // True when a parsed payload loads cleanly into a throwaway Diagram. Used to
  // validate untrusted input (files, library entries, autosave, share URLs)
  // BEFORE it touches the real diagram: loadJSON clears everything first, so
  // letting it throw mid-load would leave a wrecked diagram behind for the
  // next autosave to persist.
  _canLoadDiagram(data) {
    try { new Diagram().loadJSON(data); return true; } catch { return false; }
  }

  // Decorative Font Awesome icon element (hidden from the accessibility tree).
  _faIcon(name) {
    const i = document.createElement('i');
    i.className = `fa-solid fa-${name}`;
    i.setAttribute('aria-hidden', 'true');
    return i;
  }

  // Run button reflects engine state: label + a visible "running" treatment.
  _syncRunButton() {
    const b = document.getElementById('btn-run');
    if (!b) return;
    const on = this.engine.running;
    b.replaceChildren(this._faIcon(on ? 'pause' : 'play'),
      document.createTextNode(on ? ' Pause' : ' Run'));
    b.classList.toggle('running', on);
    // Live status readout beside the step chip. Only touch it for the plain
    // Running state so richer messages (goal reached) set elsewhere survive.
    const status = document.getElementById('sim-status');
    if (status) {
      if (on) status.textContent = 'Running';
      else if (status.textContent === 'Running') status.textContent = '';
    }
  }

  // Begin a fresh history baseline (after the initial boot / shared-link load).
  _resetHistory() {
    this._undoStack = [];
    this._redoStack = [];
    this._lastState = this._snapshot();
    this._updateUndoButtons();
  }

  // Make a wholesale diagram replacement (New / Load template / Load library)
  // undoable: the pre-replace diagram (captured before the swap) goes on the
  // undo stack and the freshly loaded one becomes the new baseline. Unlike
  // _resetHistory(), this preserves the ability to Ctrl+Z back to what you had.
  _commitReplace(prevSnap) {
    this._dropScenarioState();
    const snap = this._snapshot();
    if (this._sameSnapshot(snap, prevSnap)) { this._lastState = snap; this._updateUndoButtons(); return; }
    if (prevSnap != null) {
      this._undoStack.push(prevSnap);
      if (this._undoStack.length > 100) this._undoStack.shift();
    }
    this._redoStack = [];
    this._lastState = snap;
    this._updateUndoButtons();
    this._persistAutosave();
  }

  // localStorage is shared by every tab on this origin and sim_autosave is a
  // single slot, so the tab that saves last silently becomes the saved copy and
  // the other tab carries on believing its work is safe. Nothing can merge two
  // diagrams, but the tab that has been superseded can at least be told, once,
  // while its work is still on screen and can be exported. The storage event
  // fires only in the OTHER tabs, so a write never warns the tab that made it.
  // A hidden tab suspends requestAnimationFrame but keeps the setInterval that
  // drives the run, so the animation layers were produced into and never
  // consumed. Drop what is in flight when the tab goes away, and repaint when it
  // comes back so the canvas matches the model rather than a stale frame.
  _watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.renderer.balls.clear();
        this.renderer.flowFx.clear();
      } else {
        this.renderer.render();
      }
    });
  }

  _watchForeignAutosave() {
    window.addEventListener('storage', (e) => {
      if (e.key !== 'sim_autosave' || e.newValue == null) return;
      if (document.body.classList.contains('embed')) return;
      if (this._autosaveTakenOver) return;
      this._autosaveTakenOver = true;
      this._toast('Another tab just saved over this browser\'s autosave. Work in this tab is no longer the saved copy, so use File > Save as JSON to keep it.');
    });
  }

  // Two snapshots describe the same diagram. The module-level id counter rides
  // along in the JSON and loadJSON only ever raises it, so that ids handed out
  // since cannot collide, which means restoring a snapshot never reproduces its
  // own text. Comparing the raw strings therefore reported a change after every
  // undo, and the next commit, even one that changed nothing at all, pushed an
  // undo entry and wiped the redo stack.
  _sameSnapshot(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    try {
      const strip = (j) => { const o = JSON.parse(j); delete o._idSeq; return JSON.stringify(o); };
      return strip(a) === strip(b);
    } catch { return false; }
  }

  // Mirror the current state into the autosave slot. Every path that changes
  // what is on the canvas has to call this: undo and redo moved _lastState
  // without it, so an undo looked repaired on screen and was thrown away on the
  // next reload, taking the mistake it had just undone with it.
  _persistAutosave() {
    // Never in embed mode. The chrome is hidden there but the canvas is still
    // editable, and sim_autosave is same-origin: a visitor who nudged a node in
    // someone's embedded diagram had their own saved work silently replaced by
    // it, and found the embed's diagram waiting for them on their next visit.
    if (document.body.classList.contains('embed')) return;
    try { localStorage.setItem('sim_autosave', this._lastState); } catch { /* blocked storage */ }
  }

  // Record that the diagram changed (push the previous state onto the stack).
  // No-op when nothing actually changed, so redundant commits (e.g. a control
  // that calls _commit() while its `change` event also bubbles to the panel's
  // delegated commit listener) don't create empty undo steps.
  _commit() {
    let snap = this._snapshot();
    if (this._sameSnapshot(snap, this._lastState)) return;
    // A real change happened: bump the file's modified timestamp (it is part
    // of the snapshot, so re-take it after stamping).
    this.diagram.meta.modified = Date.now();
    snap = this._snapshot();
    if (this._lastState != null) {
      this._undoStack.push(this._lastState);
      if (this._undoStack.length > 100) this._undoStack.shift();
    }
    this._redoStack = [];
    this._lastState = snap;
    this._updateUndoButtons();
    this._persistAutosave();
    // Mark any open MC results as potentially stale since the diagram changed.
    this._markMCStale();
    // A structural edit may satisfy the current tour step (placed a node / drew
    // a connection).
    this._tourCheck();
  }

  _markMCStale() {
    const results = document.getElementById('mc-results');
    if (!results || results.querySelector('.mc-empty') || results.querySelector('.mc-stale-badge')) return;
    const badge = document.createElement('p');
    badge.className = 'mc-stale-badge';
    badge.textContent = 'Diagram changed. These results may be outdated.';
    results.prepend(badge);
  }

  undo() {
    this.editor.flushPending();
    if (!this._undoStack.length) return;
    this._redoStack.push(this._lastState);
    this._lastState = this._undoStack.pop();
    this._restoreState(this._lastState);
    this._persistAutosave();
    this._updateUndoButtons();
  }

  redo() {
    this.editor.flushPending();
    if (!this._redoStack.length) return;
    this._undoStack.push(this._lastState);
    this._lastState = this._redoStack.pop();
    this._restoreState(this._lastState);
    this._persistAutosave();
    this._updateUndoButtons();
  }

  _restoreState(json) {
    this.diagram.loadJSON(JSON.parse(json));
    this._applyMeta();
    this.engine.reset();
    // Undo/redo may land mid-replay: leave scrub mode so the renderer stops
    // overriding node values with the dead run's history and the slider syncs.
    this._exitScrub();
    this._syncRunButton();
    document.getElementById('sim-status').textContent = '';
    this.renderer.balls.clear();
    this.renderer.flowFx.clear();
    this._clearSparklines();
    this.editor._select(null, null);
    this.renderer.render();
    if (this._timelineVisible) this.timeline.update();
  }

  _updateUndoButtons() {
    const u = document.getElementById('btn-undo');
    const r = document.getElementById('btn-redo');
    if (u) u.disabled = !this._undoStack.length;
    if (r) r.disabled = !this._redoStack.length;
  }

  // ── History scrubbing ───────────────────────────────────────────────────────
  // Replay a finished run: drag the slider (or hit play) to preview any past
  // step on the canvas and chart without disturbing the engine's live state.

  // Reflect the timeline's comparison window in the header: a span chip plus a
  // Clear button, both shown only while a window is selected.
  _updateCompareUI(sel) {
    const info = document.getElementById('tl-compare-info');
    const clear = document.getElementById('tl-compare-clear');
    if (!info || !clear) return;
    const active = !!sel;
    info.classList.toggle('hidden', !active);
    clear.classList.toggle('hidden', !active);
    if (active) info.textContent = `Comparing steps ${sel.aStep}–${sel.bStep} (Δ${sel.span})`;
  }

  // Sync the scrubber's range/labels/enabled-state to the current history.
  _refreshScrubber() {
    const range = document.getElementById('tl-range');
    const play = document.getElementById('tl-play');
    const live = document.getElementById('tl-live');
    const label = document.getElementById('tl-scrub-label');
    if (!range) return;
    const hist = this.engine.history;
    const usable = hist.length >= 2 && !this.engine.running;
    const scrubbing = this._scrubIndex != null;
    range.disabled = play.disabled = !usable;
    range.max = String(Math.max(0, hist.length - 1));
    // The label is a position readout and the button is the way back to the
    // head of the run. Parking a disabled "Live" button beside a label already
    // reading "Live" just looked like the same control twice, so the button
    // only appears while there is somewhere to come back from.
    live.disabled = !scrubbing;
    live.classList.toggle('hidden', !scrubbing);
    // Turns the position label amber. The rule existed but nothing ever set the
    // class, so the one "you are not live" cue in the drawer never fired.
    document.getElementById('tl-scrub').classList.toggle('scrubbing', scrubbing);
    if (scrubbing) {
      range.value = String(this._scrubIndex);
      label.textContent = `Step ${hist[this._scrubIndex]?.step ?? 0}`;
    } else {
      range.value = range.max;
      label.textContent = 'Live';
    }
  }

  // Preview history entry i on the canvas, chart, and properties panel.
  _scrubTo(i) {
    const hist = this.engine.history;
    if (hist.length < 2) return;
    i = Math.max(0, Math.min(hist.length - 1, i));
    this._scrubIndex = i;
    const entry = hist[i];
    this.renderer.setScrub(entry.snap);
    if (this._timelineVisible) this.timeline.setScrub(entry.step);
    document.getElementById('step-counter').textContent = `Step ${entry.step} (replay)`;
    this._refreshResourceCount();
    this._updateSparklines();
    this._refreshScrubber();
  }

  // Leave scrub mode and restore the live (latest) state.
  _exitScrub() {
    if (this._scrubPlayTimer) { clearInterval(this._scrubPlayTimer); this._scrubPlayTimer = null; }
    const wasScrubbing = this._scrubIndex != null;
    this._scrubIndex = null;
    this.renderer.setScrub(null);
    this.timeline.setScrub(null);
    this._syncScrubPlayButton();
    if (wasScrubbing) {
      document.getElementById('step-counter').textContent = `Step ${this.engine.step}`;
      this.renderer.render();
      this._refreshResourceCount();
      this._updateSparklines();
      if (this._activeFeature === 'monitor') this._renderProps();
    }
    this._refreshScrubber();
  }

  _syncScrubPlayButton() {
    const play = document.getElementById('tl-play');
    if (!play) return;
    const on = !!this._scrubPlayTimer;
    play.replaceChildren(this._faIcon(on ? 'pause' : 'play'));
    // The icon and the tooltip swapped but the accessible name was markup, so
    // the control announced "Replay the run" while it was the Pause button.
    play.title = on ? 'Pause replay' : 'Replay the run';
    play.setAttribute('aria-label', play.title);
  }

  // Auto-advance through history at the current sim speed; stops at the end.
  _toggleScrubPlay() {
    if (this._scrubPlayTimer) {
      clearInterval(this._scrubPlayTimer); this._scrubPlayTimer = null;
      this._syncScrubPlayButton();
      return;
    }
    const hist = this.engine.history;
    if (hist.length < 2) return;
    // Restart from the beginning if we're at (or past) the end.
    if (this._scrubIndex == null || this._scrubIndex >= hist.length - 1) this._scrubTo(0);
    const interval = Math.max(60, 700 / this.engine.speed);
    this._scrubPlayTimer = setInterval(() => {
      const h = this.engine.history;
      const next = (this._scrubIndex ?? 0) + 1;
      if (next >= h.length) { clearInterval(this._scrubPlayTimer); this._scrubPlayTimer = null; this._syncScrubPlayButton(); return; }
      this._scrubTo(next);
    }, interval);
    this._syncScrubPlayButton();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Drop session-only scenario state (checkpoints + ghost branches). They
  // snapshot the current diagram, so any whole-diagram replacement makes them
  // stale: forking an old checkpoint would resurrect the replaced diagram.
  _dropScenarioState() {
    if (!this._checkpoints.length && !this._branches.length) return;
    this._checkpoints = [];
    this._branches = [];
    if (this._timelineVisible) this.timeline.update();
    if (this._activeFeature === 'branches') this._renderProps();
  }

  _clearAll() {
    this.diagram.nodes.clear();
    this.diagram.connections.clear();
    this.diagram.groups.clear();
    this.diagram.notes.clear();
    this.diagram.charts.clear();
    this.diagram.resourceTypes = [];
    this.diagram.variables = {};
    this.diagram.params = {};
    this.diagram.customVars = [];
    this.diagram.timeMode = 'sync';
    this.diagram.seed = '';
    this.diagram.aiPlayer = { enabled: false, rules: [] };
    // Assertions are a serialized Diagram field like the rest, and were the one
    // this missed. They survived File > New, every template load and the
    // restored-session Discard, then went straight into autosave, Save as JSON,
    // the .econ export and the share link, so cli.js --check on that file ran a
    // previous model's tests against nodes that no longer exist.
    this.diagram.assertions = [];
    this.diagram.meta = Diagram.defaultMeta();
    this._applyMeta();
    this._dropScenarioState();
    this.engine.reset();
    // A New/replace while replaying a run must leave scrub mode, or the
    // renderer keeps painting the dead run's values over the fresh diagram.
    this._exitScrub();
    this._syncRunButton();
    document.getElementById('sim-status').textContent = '';
    this.renderer.balls.clear();
    this.renderer.flowFx.clear();
    this._clearSparklines();
    this.timeline.clearSelection();
    this.editor._select(null, null);
    if (this._timelineVisible) this.timeline.update();
  }

  // ── Init / autosave ───────────────────────────────────────────────────────

  _initDiagram() {
    // Embed mode: strip chrome for a clean, shareable view.
    const params = new URLSearchParams(location.search);
    if (params.has('embed') || /(^|[#&])embed\b/.test(location.hash)) {
      document.body.classList.add('embed');
      // Mini topbar tail: the diagram's name and a way back to the full app.
      const tail = document.createElement('span');
      tail.className = 'embed-open';
      const name = document.createElement('span');
      name.id = 'embed-title';
      tail.appendChild(name);
      const link = document.createElement('a');
      // Rebuild the URL without the embed marker, wherever it came from. The
      // marker is accepted in the query (?embed) and in the hash (#embed, or
      // #d=...&embed, which is what the knowledge base documents), but only the
      // query form was ever stripped: for a hash embed the link pointed back at
      // the embed itself, so the one escape hatch an embed offers did nothing.
      link.href = (() => {
        try {
          const u = new URL(location.href);
          u.searchParams.delete('embed');
          u.hash = u.hash
            .replace(/(^#|&)embed\b(=[^&]*)?/g, '$1')
            .replace(/^#&/, '#')
            .replace(/&&+/g, '&')
            .replace(/[#&]$/, '');
          return u.toString();
        } catch {
          return location.href.replace(/([?&])embed(=[^&]*)?/, '$1').replace(/[?&]$/, '');
        }
      })();
      link.target = '_blank'; link.rel = 'noopener';
      link.textContent = 'open in Simulations ↗';
      tail.appendChild(link);
      document.getElementById('topbar').appendChild(tail);
    }

    // A diagram encoded in the URL hash (#d=…) takes precedence over autosave.
    // Validated on a throwaway Diagram first so a corrupt payload can't leave
    // a half-loaded diagram behind before the fallback runs.
    const shared = this._decodeDiagram();
    if (shared && this._canLoadDiagram(shared)) {
      this.diagram.loadJSON(shared);
      this._applyMeta();
      this.engine.reset();
      this.renderer.render();
      this.renderer.fitView();
      this._resetHistory();
      this._renderProps();
      // A share link is a one-time import, not a permanent binding for the tab.
      // Adopt it into autosave (_resetHistory only sets the in-memory baseline,
      // it does not persist) and then drop the hash, so the next reload restores
      // what is actually on screen instead of replaying the sender's snapshot
      // over the top of the reader's own work. Embed mode keeps its hash: there
      // the URL is the document, and an embed must not write over the host
      // page's autosave.
      if (!document.body.classList.contains('embed')) {
        let prior = null;
        try { prior = JSON.parse(localStorage.getItem('sim_autosave') || 'null'); } catch { /* blocked or corrupt */ }
        const priorNodes = prior && Array.isArray(prior.nodes) ? prior.nodes.length : 0;
        if (priorNodes && this._canLoadDiagram(prior)) {
          // There is real work in the saved slot. Ask before the link takes it.
          this._adoptSharedDiagram(prior);
        } else {
          this._persistAutosave();
          try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
        }
      }
      return;
    }

    // Autosave found → restore silently so the diagram persists across reloads.
    // getItem can throw under blocked storage (Safari private mode / embedded
    // iframe); a corrupt save falls through to the empty canvas untouched.
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('sim_autosave') || 'null'); } catch { /* blocked storage or corrupted save */ }
    if (saved && this._canLoadDiagram(saved)) {
      this.diagram.loadJSON(saved);
      this._applyMeta();
      this.engine.reset();
      this.renderer.balls.clear();
      this.renderer.flowFx.clear();
      this._clearSparklines();
      this.editor._select(null, null);
      this.renderer.render();
      this.renderer.fitView();
      this._resetHistory();
      this._renderProps();
      // Recovery banner (16h): say what came back, offer a fresh start. Only
      // when there is real content to recover, and never in embed mode.
      if (this.diagram.nodes.size && !document.body.classList.contains('embed'))
        this._showRecoveryBanner();
      return;
    }

    // No autosave (fresh session): start on an empty canvas so first-time users
    // learn by doing — the welcome overlay and tour guide them through their own
    // first model. The demo is one click away (welcome "Explore the demo" or the
    // Library), and returning users still get their autosaved work above.
    this._applyMeta();
    this.renderer.render();
    this.renderer.resetView();
    this._resetHistory();
    this._renderProps();
  }

  // Amber banner shown after an autosave restore: keep working (dismiss) or
  // discard the recovered diagram and start clean.
  _showRecoveryBanner() {
    const bar = document.createElement('div');
    bar.className = 'recovery-banner';
    bar.setAttribute('role', 'status');
    const icon = this._faIcon('clock-rotate-left');
    const msg = document.createElement('span');
    const name = this.diagram.meta && this.diagram.meta.name;
    msg.textContent = name ? `Restored "${name}" from your last session` : 'Restored your last session';
    const keep = document.createElement('button');
    keep.className = 'btn btn-primary';
    keep.textContent = 'Keep working';
    const discard = document.createElement('button');
    discard.className = 'btn';
    discard.textContent = 'Discard';
    const close = () => bar.remove();
    keep.addEventListener('click', close);
    discard.addEventListener('click', async () => {
      if (!await this._confirmGuard('Discard the restored diagram and start with an empty canvas?', 'Discard restored work')) return;
      close();
      const prev = this._snapshot();
      this._clearAll();
      this._applyMeta();
      this.renderer.render();
      this.renderer.resetView();
      this._commitReplace(prev);
      this._renderProps();
    });
    bar.append(icon, msg, keep, discard);
    document.getElementById('canvas-wrap').appendChild(bar);
    // Quietly fades once the user starts editing anyway.
    setTimeout(() => { if (bar.isConnected) bar.classList.add('fade'); }, 12000);
    setTimeout(() => { if (bar.isConnected) bar.remove(); }, 13000);
  }

  // Load the built-in predator-prey demo on demand (welcome "Explore the demo").
  // Undoable: Ctrl+Z returns to the empty canvas you started from.
  _loadDemo() {
    const t = this._templates[0]; // Predator & Prey
    if (!t) return;
    this._installTemplate(t);
    this._renderProps();
  }

  // ── Dropdown menus (File, …) ────────────────────────────────────────────────

  // Generic toolbar dropdowns: a trigger button (aria-haspopup) toggles its
  // sibling .menu-popup. Each item keeps its own id/handler (wired elsewhere),
  // so choosing one runs that action and then closes the menu. Clicking outside
  // or pressing Escape closes any open menu.
  _initMenus() {
    const menus = [...document.querySelectorAll('.menu')];
    const closeAll = (except = null) => {
      for (const m of menus) {
        if (m === except) continue;
        const pop = m.querySelector('.menu-popup');
        const trigger = m.querySelector('[aria-haspopup]');
        // Hiding a popup that still holds focus resets the browser to <body>,
        // so Tab restarts from the top of the page and a dialog opened from the
        // menu has nothing to restore focus to. Hand it back to the trigger.
        const owned = pop && !pop.classList.contains('hidden') && pop.contains(document.activeElement);
        pop?.classList.add('hidden');
        trigger?.setAttribute('aria-expanded', 'false');
        if (owned && trigger) trigger.focus();
      }
    };
    for (const m of menus) {
      const btn = m.querySelector('[aria-haspopup]');
      const pop = m.querySelector('.menu-popup');
      if (!btn || !pop) continue;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = pop.classList.contains('hidden');
        closeAll(willOpen ? m : null);
        pop.classList.toggle('hidden', !willOpen);
        btn.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) pop.querySelector('.menu-item')?.focus();
      });
      pop.addEventListener('click', (e) => {
        if (e.target.closest('.menu-item')) {
          const owned = pop.contains(document.activeElement);
          pop.classList.add('hidden');
          btn.setAttribute('aria-expanded', 'false');
          if (owned) btn.focus();
        }
      });
      // Arrow keys move through the menu; Home/End jump to the extremes.
      pop.addEventListener('keydown', (e) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const items = [...pop.querySelectorAll('.menu-item')].filter(i => i.offsetParent !== null);
        if (!items.length) return;
        e.preventDefault();
        const idx = items.indexOf(document.activeElement);
        let next;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        else if (e.key === 'ArrowDown') next = (idx + 1) % items.length;
        else next = (idx - 1 + items.length) % items.length;
        items[next].focus();
      });
    }
    document.addEventListener('click', () => closeAll());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  }

  // ── Collapsible palette sections ─────────────────────────────────────────────

  // Each palette section can be collapsed to keep the most-used tools dominant.
  // The expanded/collapsed state is per-section and persisted in localStorage;
  // the HTML default applies for any section the user hasn't touched.
  _initPalette() {
    const KEY = 'sim_palette_sections';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
    document.querySelectorAll('.palette-section').forEach(sec => {
      const header = sec.querySelector('.palette-header');
      const name = sec.dataset.section;
      if (!header || !name) return;
      if (name in saved) header.setAttribute('aria-expanded', String(saved[name]));
      header.addEventListener('click', () => {
        const expanded = header.getAttribute('aria-expanded') !== 'false';
        header.setAttribute('aria-expanded', String(!expanded));
        saved[name] = !expanded;
        try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
        this._syncRailFades();
      });
    });

    // Both vertical rails run taller than the window at ordinary laptop sizes,
    // and their overlay scrollbars give no hint of it: the palette hides five
    // node tools at 1366x768, and the Setup rail hides Loops and Watch as soon
    // as the timeline drawer opens. Drive the CSS edge fades from the live
    // scroll position so a caret is up only while there is more to reach.
    for (const el of this._scrollRails()) {
      el.addEventListener('scroll', () => this._syncRailFades(), { passive: true });
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => this._syncRailFades()).observe(el);
      } else {
        window.addEventListener('resize', () => this._syncRailFades());
      }
    }
    this._syncRailFades();
  }

    // A share link has just been loaded over an existing autosaved diagram. The
  // shared one is already on screen; ask before it takes the saved slot, and put
  // the reader's own diagram back if they decline. Without this, opening a link
  // destroyed the reader's work with no prompt: a reload afterwards brought back
  // the sender's diagram, not theirs, and nothing could undo it (a page load has
  // no undo stack for state from before it).
  async _adoptSharedDiagram(prior) {
    const name = (this.diagram.meta && this.diagram.meta.name || '').trim();
    const keep = await this._confirmGuard(
      `Keep the shared diagram${name ? ` "${name}"` : ''}? It replaces the diagram saved in this browser.`,
      'Shared diagram');
    if (keep) {
      this._persistAutosave();
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
      return;
    }
    // Declined: restore what they had. The hash stays, so the link still works
    // if they change their mind.
    this.diagram.loadJSON(prior);
    this._applyMeta();
    this.engine.reset();
    this.renderer.balls.clear();
    this.renderer.flowFx.clear();
    this._clearSparklines();
    this.editor._select(null, null);
    this.renderer.render();
    this.renderer.fitView();
    this._resetHistory();
    this._renderProps();
    this._toast('Kept your own diagram. The shared one was not saved.');
  }

_scrollRails() {
    return ['palette', 'diagram-rail'].map(id => document.getElementById(id)).filter(Boolean);
  }

  _syncRailFades() {
    for (const el of this._scrollRails()) {
      const room = el.scrollHeight - el.clientHeight;
      el.classList.toggle('can-scroll', room > 1 && el.scrollTop < room - 1);
      el.classList.toggle('scrolled-down', room > 1 && el.scrollTop > 1);
    }
  }

  // ── Tool activation ───────────────────────────────────────────────────────

  _syncToolButtons(tool) {
    document.querySelectorAll('[data-tool]').forEach(b => {
      const on = b.dataset.tool === tool;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  _activateTool(tool) {
    this._syncToolButtons(tool);
    this.editor.setTool(tool);
  }

  // ── Transient toast ─────────────────────────────────────────────────────────

  // ── Modal a11y: dialog semantics, focus trap, Escape, focus restore ───────

  _showModal(overlayId) {
    const overlay = document.getElementById(overlayId);
    this._modalReturnFocus = document.activeElement;
    overlay.classList.remove('hidden');
    const first = overlay.querySelector('input, select, textarea, button:not([disabled])');
    if (first) first.focus();
  }

  _hideModal(overlayId) {
    document.getElementById(overlayId).classList.add('hidden');
    const back = this._modalReturnFocus;
    this._modalReturnFocus = null;
    if (!back || !back.focus) return;
    // A dialog opened from a dropdown stored the menu item as its return
    // target, and that item is hidden the moment the menu closes. Focusing it
    // silently does nothing and the keyboard restarts from <body>, so fall back
    // to the menu's trigger button.
    if (!back.isConnected || back.offsetParent === null) {
      const trigger = back.closest && back.closest('.menu')
        && back.closest('.menu').querySelector('[aria-haspopup]');
      if (trigger) trigger.focus();
      return;
    }
    back.focus();
  }

  // Every overlay that takes the screen, topmost last. Used to keep diagram
  // shortcuts from firing at the canvas behind an open dialog.
  static MODAL_IDS = ['lib-overlay', 'mc-overlay', 'help-overlay', 'kb-overlay',
    'welcome-overlay', 'guard-overlay'];

  _modalOpen() {
    return App.MODAL_IDS.some(id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });
  }

  // Close the topmost dialog. The guard runs its own handler (it has a promise
  // to settle), so it is not closed from here.
  _closeTopModal() {
    for (let i = App.MODAL_IDS.length - 1; i >= 0; i--) {
      const id = App.MODAL_IDS[i];
      if (id === 'guard-overlay') continue;
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) {
        if (id === 'welcome-overlay') this._dismissWelcome(); else this._hideModal(id);
        return true;
      }
    }
    return false;
  }

  // Keyboard behaviour for a modal overlay: Escape closes, Tab cycles within.
  _modalize(overlayId) {
    const overlay = document.getElementById(overlayId);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this._hideModal(overlayId);
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = [...overlay.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    });
  }

  // Promise-based styled confirmation for destructive actions. Resolves true if
  // the user clicks "Discard & continue", false on Cancel or Escape.
  _confirmGuard(message, title = 'Are you sure?') {
    return new Promise((resolve) => {
      document.getElementById('guard-title-text').textContent = title;
      document.getElementById('guard-message').textContent = message;

      const overlay = document.getElementById('guard-overlay');
      const confirmBtn = document.getElementById('guard-confirm');
      const cancelBtn = document.getElementById('guard-cancel');

      const cleanup = (result) => {
        overlay.classList.add('hidden');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey, true);
        // Its own field: the guard often opens over another dialog, and sharing
        // _modalReturnFocus wiped that dialog's restore target.
        if (this._guardReturnFocus && this._guardReturnFocus.focus) this._guardReturnFocus.focus();
        this._guardReturnFocus = null;
        resolve(result);
      };

      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onBackdrop = (e) => { if (e.target === overlay) cleanup(false); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); cleanup(false); }
        if (e.key !== 'Tab') return;
        // DOM order, not visual guesswork: reversed, the trap wrapped off the
        // wrong button and Tab walked straight out of the alertdialog.
        const focusables = [cancelBtn, confirmBtn];
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      };

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onBackdrop);
      // On document, capturing: clicking the dialog's own chrome drops focus to
      // <body>, and an overlay-bound handler would then never see Escape.
      document.addEventListener('keydown', onKey, true);

      this._guardReturnFocus = document.activeElement;
      overlay.classList.remove('hidden');
      cancelBtn.focus();
    });
  }

  // ── Knowledge base / concept guide ─────────────────────────────────────────
  // A searchable, static reference built from KB_ARTICLES (js/kb.js). The left
  // rail lists topics grouped by category; the right pane shows one article.
  // Article ids follow node-<type> / conn-<type>, so the "?" in the properties
  // panel can deep-link a selected element straight to its own entry.
  _initKB() {
    if (typeof KB_ARTICLES === 'undefined') return;   // content failed to load
    this._kbId = null;
    document.getElementById('kb-close').addEventListener('click', () => this._hideModal('kb-overlay'));
    document.getElementById('kb-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'kb-overlay') this._hideModal('kb-overlay');
    });
    this._modalize('kb-overlay');

    const search = document.getElementById('kb-search-input');
    search.addEventListener('input', () => this._renderKBNav(search.value));

    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-kb-article]');
      if (btn && !btn.disabled) this._openKB(btn.dataset.kbArticle);
    });

    document.getElementById('kb-nav').addEventListener('click', (e) => {
      const link = e.target.closest('.kb-link');
      if (link) this._showKBArticle(link.dataset.kbId);
    });
  }

  // Open the guide, optionally at a specific article. Falls back to the first
  // article (or the matching one) when the id is unknown.
  _openKB(articleId = null) {
    if (typeof KB_ARTICLES === 'undefined') return;
    const search = document.getElementById('kb-search-input');
    search.value = '';
    this._renderKBNav('');
    const target = (articleId && KB_ARTICLES.some(a => a.id === articleId))
      ? articleId : KB_ARTICLES[0].id;
    this._showKBArticle(target);
    this._showModal('kb-overlay');
  }

  // (Re)build the topic rail, grouped by category, filtered by the search query
  // (matched against title, keywords, category and body). Empty categories are
  // dropped; no matches shows a hint.
  _renderKBNav(query = '') {
    const nav = document.getElementById('kb-nav');
    nav.innerHTML = '';
    const q = query.trim().toLowerCase();
    const matches = KB_ARTICLES.filter(a => !q
      || `${a.title} ${a.keywords || ''} ${a.category} ${a.body}`.toLowerCase().includes(q));

    if (!matches.length) {
      const p = document.createElement('p');
      p.className = 'kb-noresults';
      p.textContent = 'No topics match your search.';
      nav.appendChild(p);
      return;
    }

    let lastCat = null;
    for (const a of matches) {
      if (a.category !== lastCat) {
        const h = document.createElement('div');
        h.className = 'kb-cat';
        h.textContent = a.category;
        nav.appendChild(h);
        lastCat = a.category;
      }
      const btn = document.createElement('button');
      btn.className = 'kb-link' + (a.id === this._kbId ? ' active' : '');
      btn.dataset.kbId = a.id;
      btn.textContent = a.title;
      nav.appendChild(btn);
    }
  }

  // Render one article into the reading pane and highlight its rail link.
  _showKBArticle(id) {
    const a = KB_ARTICLES.find(x => x.id === id);
    if (!a) return;
    this._kbId = id;
    const pane = document.getElementById('kb-article');
    pane.innerHTML = '';
    const cat = document.createElement('div');
    cat.className = 'kb-cat-label';
    cat.textContent = a.category;
    const h = document.createElement('h2');
    h.textContent = a.title;
    const p = document.createElement('p');
    p.textContent = a.body;
    pane.append(cat, h, p);
    pane.scrollTop = 0;

    for (const link of document.querySelectorAll('#kb-nav .kb-link')) {
      link.classList.toggle('active', link.dataset.kbId === id);
    }
  }

  _toast(msg) {
    let t = document.getElementById('app-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'app-toast';
      t.setAttribute('role', 'status'); // announced politely by screen readers
      document.body.appendChild(t);
    }
    t.textContent = msg;
    // Sit above the timeline panel when it's open so the toast doesn't cover
    // the chart's x-axis; '' falls back to the stylesheet's bottom: 24px.
    const tl = document.getElementById('timeline');
    t.style.bottom = (tl && !tl.classList.contains('hidden')) ? `${tl.offsetHeight + 12}px` : '';
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), Math.max(3000, msg.length * 60));
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  _bindControls() {
    document.getElementById('btn-step').addEventListener('click', () => {
      this._exitScrub();
      this.engine.doStep();
      // Run/Pause and Reset both refresh the scrubber; Step did not, so its
      // range stayed one entry behind the history. While Live the thumb already
      // sits at max, so pressing End or dragging it right emitted no input
      // event and the newest step could not be reached at all.
      this._refreshScrubber();
    });

    const runBtn = document.getElementById('btn-run');
    runBtn.addEventListener('click', () => {
      this._exitScrub();
      const starting = !this.engine.running;
      if (starting) document.getElementById('sim-status').textContent = '';
      this.engine.run();
      this._syncRunButton();
      this._refreshScrubber();
      if (starting && this.engine.running) this._maybeMonteCarloHint();
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
      this._exitScrub();
      this.timeline.clearSelection();
      this.engine.reset();
      this._syncRunButton();
      document.getElementById('sim-status').textContent = '';
      this.renderer.balls.clear();
      this.renderer.flowFx.clear();
      this._clearSparklines();
      // Clearing destroys the selected node's sparkline canvas, and nothing
      // else rebuilds it, so without this the properties panel lost its chart
      // for good: it stayed blank through every later run until you reselected
      // the node. Rebuilding also restores the "Starting amount" label.
      this._renderProps();
      this.renderer.render();
      if (this._timelineVisible) this.timeline.update();
      this._refreshScrubber();
    });

    // History scrubber controls.
    document.getElementById('tl-range').addEventListener('input', (e) => {
      if (this._scrubPlayTimer) { clearInterval(this._scrubPlayTimer); this._scrubPlayTimer = null; this._syncScrubPlayButton(); }
      this._scrubTo(parseInt(e.target.value, 10) || 0);
    });
    document.getElementById('tl-play').addEventListener('click', () => this._toggleScrubPlay());
    document.getElementById('tl-live').addEventListener('click', () => this._exitScrub());

    const speedEl = document.getElementById('sim-speed');
    speedEl.addEventListener('input', () => {
      this.engine.speed = parseFloat(speedEl.value);
      document.getElementById('speed-label').textContent = `${speedEl.value}×`;
      if (this.engine.running) {
        // Restart the tick interval at the new speed. run() resamples 'on
        // play' custom variables (a fresh Run press should), but a speed
        // change mid-run is not a new run: preserve their sampled values.
        const keep = (this.diagram.customVars || [])
          .filter(rv => (rv.update || 'step') === 'play')
          .map(rv => [rv, rv.value]);
        this.engine.stop();
        this.engine.run();
        for (const [rv, val] of keep) {
          rv.value = val;
          if (rv.name && VALID_IDENT.test(rv.name) && isFinite(val)) this.diagram.variables[rv.name] = val;
        }
        this._syncRunButton();
      }
    });

    document.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => this._activateTool(btn.dataset.tool));
    });

    document.getElementById('btn-new').addEventListener('click', async () => {
      if (!await this._confirmGuard('Start a new diagram? Your current diagram will be replaced (Ctrl+Z to undo).', 'New diagram')) return;
      const prev = this._snapshot();
      this._clearAll();
      this.renderer.render();
      this.renderer.resetView();
      this._commitReplace(prev);
    });

    document.getElementById('btn-snap').addEventListener('click', () => {
      const enabled = !this.editor._snapEnabled;
      this.editor.setSnap(enabled);
      const b = document.getElementById('btn-snap');
      b.classList.toggle('active', enabled);
      b.setAttribute('aria-checked', String(enabled));
    });

    const autoBtn = document.getElementById('btn-autoselect');
    // Sync button to editor's initial state (autoRevert starts true)
    autoBtn.classList.toggle('active', this.editor.autoRevert);
    autoBtn.setAttribute('aria-checked', String(this.editor.autoRevert));
    autoBtn.addEventListener('click', () => {
      this.editor.autoRevert = !this.editor.autoRevert;
      autoBtn.classList.toggle('active', this.editor.autoRevert);
      autoBtn.setAttribute('aria-checked', String(this.editor.autoRevert));
    });

    const flowBtn = document.getElementById('btn-flow');
    flowBtn.classList.toggle('active', this._flowReadout);
    flowBtn.setAttribute('aria-checked', String(this._flowReadout));
    flowBtn.addEventListener('click', () => {
      this._flowReadout = !this._flowReadout;
      flowBtn.classList.toggle('active', this._flowReadout);
      flowBtn.setAttribute('aria-checked', String(this._flowReadout));
      if (!this._flowReadout) this.renderer.flowFx.clear();
    });

    const mapBtn = document.getElementById('btn-minimap');
    mapBtn.addEventListener('click', () => {
      const on = !this._minimap.visible;
      this._minimap.setVisible(on);
      mapBtn.classList.toggle('active', on);
      mapBtn.setAttribute('aria-pressed', String(on));
    });

    document.getElementById('btn-export-svg').addEventListener('click', () => this._exportSVG());
    document.getElementById('btn-export-png').addEventListener('click', () => this._exportPNG());
    document.getElementById('btn-export-csv').addEventListener('click', () => this._exportCSV());
    document.getElementById('btn-export-econ').addEventListener('click', () => this._exportEcon());
    document.getElementById('btn-export-module').addEventListener('click', () => this._exportModule());
    document.getElementById('btn-share').addEventListener('click', () => this._shareURL());

    // A11y: hide decorative tool icons from assistive tech (buttons keep text labels).
    document.querySelectorAll('.tool-icon svg').forEach(s => s.setAttribute('aria-hidden', 'true'));

    document.getElementById('btn-save').addEventListener('click', () => {
      const json = JSON.stringify(this.diagram.toJSON(), null, 2);
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([json], { type: 'application/json' })),
        download: this._exportFilename('json'),
      });
      a.click();
    });

    document.getElementById('btn-load').addEventListener('click', () => {
      const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,.econ' });
      inp.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async ev => {
          // Parse + validate on a throwaway Diagram BEFORE touching the current
          // one: loadJSON clears everything first, so a corrupt file would
          // otherwise wreck the diagram (and the next autosave persists that).
          // Files that don't open with { or [ are treated as .econ text.
          let data;
          try {
            const text = String(ev.target.result);
            data = /^\s*[{[]/.test(text) ? JSON.parse(text) : dslParse(text);
            new Diagram().loadJSON(data);
          } catch (err) {
            this._toast(`Invalid file: ${err.message}. Your current diagram is unchanged.`);
            return;
          }
          // Opening a file replaces everything on the canvas, exactly like New,
          // Load template and Load from library. It asked for none of their
          // confirmation and, by resetting the history instead of committing
          // the swap, left no way back: Ctrl+Z did nothing and the work was
          // gone. Ask first, and keep the previous diagram one undo away.
          // The guard only runs once the file has parsed, so a mistyped or
          // cancelled pick never nags.
          if (this.diagram.nodes.size || this.diagram.notes.size) {
            if (!await this._confirmGuard(
              `Open "${file.name}"? Your current diagram will be replaced (Ctrl+Z to undo).`,
              'Open file')) return;
          }
          const prev = this._snapshot();
          this.diagram.loadJSON(data);
          this._applyMeta();
          this.engine.reset();
          this.renderer.balls.clear();
          this.renderer.flowFx.clear();
          this._clearSparklines();
          this.editor._select(null, null);
          this.renderer.render();
          this.renderer.fitView();
          this._commitReplace(prev);
        };
        reader.readAsText(file);
      };
      inp.click();
    });

    // Brush-to-compare: the chart reports a selected [A,B] window; reflect it in
    // the header (span chip + Clear button) and let Clear / Esc dismiss it.
    this.timeline.onSelection = (sel) => this._updateCompareUI(sel);
    document.getElementById('tl-compare-clear')
      .addEventListener('click', () => this.timeline.clearSelection());
    document.getElementById('tl-scale')
      .addEventListener('change', (e) => this.timeline.setScale(e.target.value));

    // Timeline chart toggle
    const tlBtn = document.getElementById('btn-timeline');
    const toggleTimeline = (show) => {
      this._timelineVisible = show;
      document.getElementById('timeline').classList.toggle('hidden', !show);
      tlBtn.classList.toggle('active', show);
      tlBtn.setAttribute('aria-checked', String(show));
      // Surface the timeline state on the (collapsed) Analysis menu button too.
      document.getElementById('btn-analysis-menu')?.classList.toggle('active', show);
      if (show) {
        this.timeline.update(); this._refreshScrubber();
        // One-time nudge toward the compare gesture once there's data to brush.
        let seenTl = false;
        try { seenTl = localStorage.getItem('sim_seen_tl_compare') === '1'; } catch { /* ignore */ }
        if (this.engine.history.length >= 2 && !seenTl) {
          this._toast('Tip: drag across the chart to compare two points in time.');
          try { localStorage.setItem('sim_seen_tl_compare', '1'); } catch { /* ignore */ }
        }
      } else { this._exitScrub(); this.timeline.clearSelection(); }
    };
    tlBtn.addEventListener('click', () => toggleTimeline(!this._timelineVisible));
    document.getElementById('tl-close').addEventListener('click', () => toggleTimeline(false));
    window.addEventListener('resize', () => {
      if (this._timelineVisible) this.timeline.update();
      this._minimap.update();
    });

    // Resize handle — drag up/down to change timeline panel height
    const tlPanel = document.getElementById('timeline');
    document.getElementById('tl-resize').addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = tlPanel.offsetHeight;
      const onMove = (ev) => {
        tlPanel.style.height = Math.max(120, Math.min(600, startH - (ev.clientY - startY))) + 'px';
        if (this._timelineVisible) this.timeline.update();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Undo / redo
    document.getElementById('btn-undo').addEventListener('click', () => this.undo());
    document.getElementById('btn-redo').addEventListener('click', () => this.redo());

    // View: Fit frames all content; zoom cluster steps / resets the zoom and a
    // live readout reflects the current scale.
    document.getElementById('btn-fit').addEventListener('click', () => this.renderer.fitView());
    document.getElementById('btn-zoom-in').addEventListener('click', () => this.renderer.zoomStep(1.2));
    document.getElementById('btn-zoom-out').addEventListener('click', () => this.renderer.zoomStep(1 / 1.2));
    const zoomLabel = document.getElementById('btn-zoom-level');
    zoomLabel.addEventListener('click', () => this.renderer.zoomTo(1));
    this.renderer.onViewChange = (scale) => {
      const pct = Math.round(scale * 100);
      zoomLabel.textContent = `${pct}%`;
      // The visible readout is live but the accessible name was markup, so it
      // announced "100%" at every zoom level.
      zoomLabel.setAttribute('aria-label', `Current zoom ${pct}%. Click to reset to 100%`);
      this._minimap.update();
    };
    this.renderer.onViewChange(this.renderer._scale);

    // Commit a property edit as one undo step (fires on blur / enter / toggle).
    document.getElementById('props-content').addEventListener('change', () => this._commit());

    // Keyboard: tool shortcuts (plain) + undo/redo/etc (mod).
    window.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Clicking a dialog's own chrome (its title, a section heading, the
      // results area) puts focus on <body>, and from there these shortcuts used
      // to reach the diagram behind the dialog: Ctrl+A selected every node,
      // Ctrl+V pasted, S/D/R/T swapped tools, all invisibly. Escape is handled
      // here for the same reason, since _modalize listens on the overlay.
      if (this._modalOpen()) {
        if (e.key === 'Escape' && this._closeTopModal()) e.preventDefault();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod) {
        if (k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
        else if (k === 'y') { e.preventDefault(); this.redo(); }
        else if (k === '0') { e.preventDefault(); this.renderer.fitView(); }
        else if (k === 'c') { this._copy(); }
        else if (k === 'v') { e.preventDefault(); this._paste(); }
        else if (k === 'd') { e.preventDefault(); this._duplicate(); }
        else if (k === 'a') { e.preventDefault(); this._selectAll(); }
      } else {
        // Tool shortcuts: S=select, D=delete, R=resource-connect, T=state-connect
        const toolKeys = { s: 'select', d: 'delete', r: 'connect-resource', t: 'connect-state' };
        if (toolKeys[k]) { e.preventDefault(); this._activateTool(toolKeys[k]); }
        else if (e.key === '?') { e.preventDefault(); this._showModal('help-overlay'); }
        else if (e.key === 'Escape' && this.timeline._sel) { this.timeline.clearSelection(); }
        // Disarm Delete. Its cursor is the same crosshair every tool uses, so
        // an armed Delete tool is easy to forget and the next click on the
        // canvas removes a node. Escape is the obvious way out and did
        // everything except this. Only Delete: cancelling a half-drawn
        // connection should not also put the Resource tool away. Handled here
        // rather than in the editor because clicking a palette button leaves
        // focus on it, and the editor ignores keys aimed at a button.
        else if (e.key === 'Escape' && this.editor.tool === 'delete') {
          this._activateTool('select');
          this._toast('Delete tool off. Select is active.');
        }
      }
    });

    // Monte Carlo batch runs
    document.getElementById('btn-batch').addEventListener('click', () => this._openMonteCarlo());
    const closeMC = () => { this._mcCancel = true; this._hideModal('mc-overlay'); };
    document.getElementById('mc-close').addEventListener('click', closeMC);
    document.getElementById('mc-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'mc-overlay') closeMC();
    });
    this._modalize('mc-overlay');
    document.getElementById('mc-run').addEventListener('click', () => this._runMonteCarlo());
    document.getElementById('mc-sweep-run').addEventListener('click', () => this._runSweep());
    // Re-seed the sweep range when the parameter changes, not just on open.
    document.getElementById('mc-sweep-param')
      .addEventListener('change', (e) => this._seedSweepRange(e.target.value));
    document.getElementById('mc-sens-run').addEventListener('click', () => this._runSensitivity());

    // Touch layout ☰ overflow: the controls the collapsed topbar hides
    // (analysis, zoom, file, help), routed to the same handlers.
    // Touch layout only: the properties sheet covers the tool strip, so it
    // needs a way out that is not "tap bare canvas and hope".
    document.getElementById('props-close').addEventListener('click', () => {
      if (this._activeFeature) this._closeFeature();
      this.editor._select(null, null);
    });

    document.getElementById('btn-mobile-menu').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      e.currentTarget.setAttribute('aria-expanded', 'true');
      this._openMenu(r.right - 210, r.bottom + 6, (add, sep) => {
        add('Reset', 'arrows-rotate', () => document.getElementById('btn-reset').click());
        add('Timeline chart', 'chart-line', () => document.getElementById('btn-timeline').click());
        add('Batch (Monte Carlo)…', 'dice', () => document.getElementById('btn-batch').click());
        sep();
        // This layout hides the Setup rail outright, so its panels (parameters,
        // variables, resource types, design tests, feedback loops and the rest)
        // have no other way in. Built from the rail's own buttons so the two
        // lists cannot drift apart as features are added.
        const meta = this._featureMeta();
        for (const btn of document.querySelectorAll('#diagram-rail .rail-btn')) {
          const name = btn.dataset.feature;
          if (!meta[name]) continue;
          const icon = [...(btn.querySelector('i')?.classList || [])]
            .find(c => c.startsWith('fa-') && c !== 'fa-solid');
          add(meta[name].title, icon ? icon.slice(3) : 'sliders', () => this._toggleFeature(name));
        }
        sep();
        add('Fit to view', 'expand', () => this.renderer.fitView());
        add('Undo', 'rotate-left', () => document.getElementById('btn-undo').click());
        add('Redo', 'rotate-right', () => document.getElementById('btn-redo').click());
        sep();
        add('Library', 'book', () => this._openLibrary());
        add('New diagram', 'file', () => document.getElementById('btn-new').click());
        add('Open file…', 'folder-open', () => document.getElementById('btn-load').click());
        add('Save as JSON', 'download', () => document.getElementById('btn-save').click());
        add('Copy share link', 'link', () => document.getElementById('btn-share').click());
        sep();
        add('Help', 'circle-question', () => this._showModal('help-overlay'));
      });
    });

    // Help / shortcuts overlay (also on the "?" key)
    document.getElementById('btn-help').addEventListener('click', () => this._showModal('help-overlay'));
    document.getElementById('help-close').addEventListener('click', () => this._hideModal('help-overlay'));
    document.getElementById('help-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'help-overlay') this._hideModal('help-overlay');
    });
    this._modalize('help-overlay');
    // Help → "Getting started" reopens the welcome overlay.
    document.getElementById('help-getting-started').addEventListener('click', () => {
      this._hideModal('help-overlay');
      this._showModal('welcome-overlay');
    });
    // Help → "Take the tour" relaunches the interactive walkthrough.
    document.getElementById('help-take-tour').addEventListener('click', () => this._startTour());
    // Help → "Concept guide" opens the searchable knowledge base.
    document.getElementById('help-guide').addEventListener('click', () => {
      this._hideModal('help-overlay');
      this._openKB();
    });
    this._initKB();

    // Welcome / getting-started overlay (first run; reopenable from Help)
    document.getElementById('welcome-close').addEventListener('click', () => this._dismissWelcome());
    document.getElementById('welcome-tour').addEventListener('click', () => {
      this._dismissWelcome();
      this._startTour();
    });
    document.getElementById('welcome-explore').addEventListener('click', () => {
      this._dismissWelcome();
      this._loadDemo();
    });
    document.getElementById('welcome-templates').addEventListener('click', () => {
      this._dismissWelcome();
      this._openLibrary();
    });
    document.getElementById('welcome-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'welcome-overlay') this._dismissWelcome();
    });
    this._modalize('welcome-overlay');

    // Interactive tour controls.
    document.getElementById('tour-skip').addEventListener('click', () => this._endTour(false));
    document.getElementById('tour-next').addEventListener('click', () => this._tourNext());
  }

}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
