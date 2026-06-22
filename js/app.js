// UI accent color schemes selectable per simulation (meta.scheme). Each remaps
// the two accent CSS variables; 'default' restores the stylesheet values.
const COLOR_SCHEMES = {
  default: { label: 'Ocean (default)', accent: '#4a9eff', accent2: '#ffa726' },
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
    this._tourReposition = () => this._positionTour(); // stable ref for listeners
    this._tourKey = (e) => { if (e.key === 'Escape') this._endTour(false); };

    // Scenario branching: checkpoints are full sim-state snapshots you can
    // fork from; branches are finished timelines kept as ghost traces in the
    // timeline chart for comparison. Session-only — not saved with the diagram.
    this._checkpoints = [];  // { id, name, step, state }
    this._branches = [];     // { id, name, history, visible }
    this._cpSeq = 0;
    this._branchSeq = 0;
    this.timeline.getBranches = () => this._branches;

    this._bindControls();
    this._initLibrary();
    this._initMenus();
    this._initPalette();
    this._initDiagramRail();

    this.engine.onStep = (step, fired, transfers) => {
      document.getElementById('step-counter').textContent = `Step: ${step}`;

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
    this._toast('This model has randomness — try Analysis ▸ Batch (Monte Carlo) to run it many times and see the spread of outcomes.');
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
        text: 'With the connection selected, find its <b>Rate</b> on the right — that\'s how many resources move each step, your faucet\'s strength. <b>Change it from 1 to 5.</b>',
        enter: () => { this._tour.rateBase = this._rateSnapshot(); },
        done: () => {
          const base = this._tour.rateBase || {};
          for (const c of this.diagram.connections.values()) {
            if (c.type !== ConnectionType.RESOURCE) continue;
            if (base[c.id] !== undefined && base[c.id] !== this._rateKey(c)) return true;
          }
          return false;
        },
      },
      {
        target: '#btn-run',
        text: 'Press <b>Run</b> — watch resources stream from the Source into the Pool at the rate you set, live.',
        done: () => this.engine.running || this.engine.step > this._tour.base.step,
      },
      // ── Hand-off: point at where the real power lives, so a "graduate" doesn't
      //    exit onto a blank canvas with no map. Click-through (info) cards.
      {
        target: '#btn-library',
        info: true,
        text: 'That\'s the loop: <b>place → connect → set a rate → Run</b>. Now the payoff — the <b>Library</b> has ready-made economies (try <b>F2P Mobile Economy</b>) you can open and pull apart.',
      },
      {
        target: '#diagram-rail',
        info: true,
        text: 'This rail holds the model\'s brains: <b>Parameters</b> and <b>Variables</b> to drive formulas, <b>Resource types</b>, and a live <b>monitor</b>. Rates can be formulas, dice, or distributions too — not just fixed numbers.',
      },
      {
        target: '#btn-analysis-menu',
        info: true,
        text: 'Balancing an economy? <b>Analysis → Batch (Monte Carlo)</b> runs your model hundreds of times and shows the spread of outcomes — the fastest way to tune a curve.',
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
    window.removeEventListener('keydown', this._tourKey, true);
    try { localStorage.setItem('sim_seen_tour', '1'); } catch { /* ignore */ }
    if (completed) this._toast('Tour complete — happy building!');
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────────

  _snapshot() { return JSON.stringify(this.diagram.toJSON()); }

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
    const snap = this._snapshot();
    if (snap === prevSnap) { this._lastState = snap; this._updateUndoButtons(); return; }
    if (prevSnap != null) {
      this._undoStack.push(prevSnap);
      if (this._undoStack.length > 100) this._undoStack.shift();
    }
    this._redoStack = [];
    this._lastState = snap;
    this._updateUndoButtons();
    try { localStorage.setItem('sim_autosave', this._lastState); } catch {}
  }

  // Record that the diagram changed (push the previous state onto the stack).
  // No-op when nothing actually changed, so redundant commits (e.g. a control
  // that calls _commit() while its `change` event also bubbles to the panel's
  // delegated commit listener) don't create empty undo steps.
  _commit() {
    let snap = this._snapshot();
    if (snap === this._lastState) return;
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
    try { localStorage.setItem('sim_autosave', this._lastState); } catch {}
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
    badge.textContent = 'Diagram changed — these results may be outdated.';
    results.prepend(badge);
  }

  undo() {
    if (!this._undoStack.length) return;
    this._redoStack.push(this._lastState);
    this._lastState = this._undoStack.pop();
    this._restoreState(this._lastState);
    this._updateUndoButtons();
  }

  redo() {
    if (!this._redoStack.length) return;
    this._undoStack.push(this._lastState);
    this._lastState = this._redoStack.pop();
    this._restoreState(this._lastState);
    this._updateUndoButtons();
  }

  _restoreState(json) {
    this.diagram.loadJSON(JSON.parse(json));
    this._applyMeta();
    this.engine.reset();
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
    range.disabled = play.disabled = !usable;
    live.disabled = this._scrubIndex == null;
    range.max = String(Math.max(0, hist.length - 1));
    if (this._scrubIndex != null) {
      range.value = String(this._scrubIndex);
      label.textContent = `Step ${hist[this._scrubIndex]?.step ?? 0}`;
    } else {
      range.value = range.max;
      label.textContent = usable ? 'Live' : '—';
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
    document.getElementById('step-counter').textContent = `Step: ${entry.step} (replay)`;
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
      document.getElementById('step-counter').textContent = `Step: ${this.engine.step}`;
      this.renderer.render();
      if (this._activeFeature === 'monitor') this._renderProps();
    }
    this._refreshScrubber();
  }

  _syncScrubPlayButton() {
    const play = document.getElementById('tl-play');
    if (!play) return;
    const on = !!this._scrubPlayTimer;
    play.replaceChildren(this._faIcon(on ? 'pause' : 'play'));
    play.title = on ? 'Pause replay' : 'Replay the run';
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
    this.diagram.aiPlayer = { enabled: false, rules: [] };
    this.diagram.meta = Diagram.defaultMeta();
    this._applyMeta();
    this.engine.reset();
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
    }

    // A diagram encoded in the URL hash (#d=…) takes precedence over autosave.
    const shared = this._decodeDiagram();
    if (shared) {
      try {
        this.diagram.loadJSON(shared);
        this._applyMeta();
        this.engine.reset();
        this.renderer.render();
        this.renderer.fitView();
        this._resetHistory();
        this._renderProps();
        return;
      } catch { /* fall through to autosave or demo */ }
    }

    // Autosave found → restore silently so the diagram persists across reloads.
    const saved = localStorage.getItem('sim_autosave');
    if (saved) {
      try {
        this.diagram.loadJSON(JSON.parse(saved));
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
        return;
      } catch { /* corrupted save → fall through to demo */ }
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

  // Load the built-in predator-prey demo on demand (welcome "Explore the demo").
  // Undoable: Ctrl+Z returns to the empty canvas you started from.
  _loadDemo() {
    const t = this._templates[0]; // Predator & Prey
    if (!t) return;
    const prev = this._snapshot();
    this._clearAll();
    t.load();
    this.diagram.meta.name = t.name;
    this.diagram.meta.description = t.desc;
    this._applyMeta();
    this._commitReplace(prev);
    this.renderer.fitView();
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
        m.querySelector('.menu-popup')?.classList.add('hidden');
        m.querySelector('[aria-haspopup]')?.setAttribute('aria-expanded', 'false');
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
          pop.classList.add('hidden');
          btn.setAttribute('aria-expanded', 'false');
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
      });
    });
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
    if (this._modalReturnFocus && this._modalReturnFocus.focus) this._modalReturnFocus.focus();
    this._modalReturnFocus = null;
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
        overlay.removeEventListener('keydown', onKey);
        if (this._modalReturnFocus && this._modalReturnFocus.focus) this._modalReturnFocus.focus();
        this._modalReturnFocus = null;
        resolve(result);
      };

      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onBackdrop = (e) => { if (e.target === overlay) cleanup(false); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); cleanup(false); }
        if (e.key !== 'Tab') return;
        const focusables = [confirmBtn, cancelBtn];
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      };

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onBackdrop);
      overlay.addEventListener('keydown', onKey);

      this._modalReturnFocus = document.activeElement;
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
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), Math.max(3000, msg.length * 60));
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  _bindControls() {
    document.getElementById('btn-step').addEventListener('click', () => {
      this._exitScrub();
      this.engine.doStep();
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
        this.engine.stop();
        this.engine.run();
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
      const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' });
      inp.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            this.diagram.loadJSON(JSON.parse(ev.target.result));
            this._applyMeta();
            this.engine.reset();
            this.renderer.balls.clear();
            this.renderer.flowFx.clear();
            this._clearSparklines();
            this.editor._select(null, null);
            this.renderer.render();
            this.renderer.fitView();
            this._resetHistory();
          } catch (err) { alert('Invalid file: ' + err.message); }
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
      zoomLabel.textContent = `${Math.round(scale * 100)}%`;
      this._minimap.update();
    };
    this.renderer.onViewChange(this.renderer._scale);

    // Commit a property edit as one undo step (fires on blur / enter / toggle).
    document.getElementById('props-content').addEventListener('change', () => this._commit());

    // Keyboard: tool shortcuts (plain) + undo/redo/etc (mod).
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
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
    document.getElementById('mc-sens-run').addEventListener('click', () => this._runSensitivity());

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
