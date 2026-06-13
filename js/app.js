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

    this._selectedId = null;
    this._selectedType = null;
    this._sparklines = new Map();

    // Undo / redo (snapshot stacks of diagram JSON).
    this._undoStack = [];
    this._redoStack = [];
    this._lastState = null;

    this.timeline = new TimelineChart(document.getElementById('timeline-canvas'), document.getElementById('tl-legend'), this.diagram, this.engine);
    this._timelineVisible = false;

    this._activeFeature = null; // which diagram-rail feature occupies the props panel

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

      if (fired.length) this.renderer.setFiring(fired);
      else this.renderer.render();

      this._updateSparklines();
      if (this._timelineVisible) this.timeline.update();
      this._refreshResourceCount();
      this._refreshTypeReadouts();
      // Keep the live "Watch" panel ticking with the run.
      if (this._activeFeature === 'monitor') this._renderProps();
    };

    this.engine.onEnd = (ended) => {
      const status = document.getElementById('sim-status');
      if (status) status.replaceChildren(this._faIcon('flag-checkered'),
        document.createTextNode(` ${ended.label} reached ${ended.value} at step ${ended.step}`));
      this._syncRunButton();
      this.renderer.render();
    };

    this._initDiagram();
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

  // Begin a fresh history baseline (after load / new / example).
  _resetHistory() {
    this._undoStack = [];
    this._redoStack = [];
    this._lastState = this._snapshot();
    this._updateUndoButtons();
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
    this._clearSparklines();
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
        this._clearSparklines();
        this.editor._select(null, null);
        this.renderer.render();
        this.renderer.fitView();
        this._resetHistory();
        this._renderProps();
        return;
      } catch { /* corrupted save → fall through to demo */ }
    }

    // No autosave (fresh session): show the default example.
    this._demoEcosystem();
    this._applyMeta();
    this.renderer.fitView();
    this._resetHistory();
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

  // ── Library (multiple named diagrams) ──────────────────────────────────────

  _initLibrary() {
    // Starter templates live in the Library now (no separate dropdown). Each
    // entry builds a sample diagram via its existing loader.
    this._templates = [
      { name: 'Predator & Prey', desc: 'Two populations lock into a self-sustaining oscillation — a stable limit cycle.', load: () => this._demoEcosystem() },
      { name: 'Epidemic (SIR)', desc: 'The outbreak curve: infections peak as Rₑ falls through 1, then fade.', load: () => this._demoEpidemic() },
      { name: 'Supply Chain', desc: 'A 2:1 smelter and a shipping delay — pipeline latency, then steady output.', load: () => this._demoSupplyChain() },
      { name: 'Barter Economy', desc: 'Two towns swap grain for timber through a Trader; watch the colours mix.', load: () => this._demoTradeNetwork() },
      { name: 'Service Desk', desc: 'A single-server queue with random arrivals — the line builds and clears.', load: () => this._demoQueue() },
      { name: 'F2P Mobile Economy', desc: 'A sprawling free-to-play live-ops loop: energy→levels→Gold/XP, a sqrt level curve gating Elite content, a probabilistic gacha gate, and a DAU/IAP economy.', load: () => this._demoF2P() },
      { name: 'Civilization Empire', desc: 'A 4X economy in one diagram: logistic population, five yields, building converters, and a Science-gated tech tree (irrigation, drama, banking, university).', load: () => this._demoCiv() },
      { name: 'Megafactory Line', desc: 'A 4-tier auto-factory: ore → smelting → components → widgets. A tiny circuit buffer + slow assembly station back the line up — watch the bottleneck.', load: () => this._demoFactory() },
      { name: 'Business Cycle', desc: 'A full circular-flow macroeconomy — households, firms, banks, government and a central bank. Countercyclical stimulus through a policy lag drives a boom-bust cycle.', load: () => this._demoBusinessCycle() },
      { name: 'Food Web', desc: 'A four-trophic ecosystem: producers, grazers, carnivores, an apex predator and a nutrient-recycling loop. Ten species lock into coupled, bounded oscillations.', load: () => this._demoFoodWeb() },
    ];

    document.getElementById('btn-library').addEventListener('click', () => this._openLibrary());
    document.getElementById('lib-close').addEventListener('click', () => this._hideModal('lib-overlay'));
    document.getElementById('lib-overlay').addEventListener('click', e => {
      if (e.target.id === 'lib-overlay') this._hideModal('lib-overlay');
    });
    this._modalize('lib-overlay');
    document.getElementById('lib-save').addEventListener('click', () => {
      const name = document.getElementById('lib-name').value.trim() || 'Untitled';
      const lib = this._getLibrary();
      lib.push({ name, date: new Date().toLocaleString(), json: this._snapshot() });
      this._saveLibrary(lib);
      document.getElementById('lib-name').value = '';
      this._renderLibraryList();
    });
  }

  _getLibrary() {
    try { return JSON.parse(localStorage.getItem('sim_library') || '[]'); } catch { return []; }
  }

  _saveLibrary(lib) {
    try { localStorage.setItem('sim_library', JSON.stringify(lib)); } catch {}
  }

  _openLibrary() {
    this._renderTemplates();
    this._renderLibraryList();
    this._showModal('lib-overlay');
  }

  _renderTemplates() {
    const el = document.getElementById('lib-templates');
    el.innerHTML = '';
    for (const t of this._templates) {
      const row = document.createElement('div');
      row.className = 'lib-row';
      const info = document.createElement('div');
      info.className = 'lib-info';
      info.innerHTML = `<b>${this._esc(t.name)}</b><span class="lib-desc">${this._esc(t.desc)}</span>`;
      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.className = 'btn';
      loadBtn.addEventListener('click', () => this._loadTemplate(t));
      row.appendChild(info);
      row.appendChild(loadBtn);
      el.appendChild(row);
    }
  }

  _loadTemplate(t) {
    if (!confirm(`Load "${t.name}"? Unsaved work will be lost.`)) return;
    this._clearAll();
    t.load();
    this.diagram.meta.name = t.name;
    this.diagram.meta.description = t.desc;
    this._applyMeta();
    this._resetHistory();
    this.renderer.fitView();
    this._hideModal('lib-overlay');
  }

  _renderLibraryList() {
    const lib = this._getLibrary();
    const el = document.getElementById('lib-list');
    el.innerHTML = '';
    if (!lib.length) {
      el.innerHTML = '<p class="mc-empty">No saved diagrams yet. Save the current diagram with a name above.</p>';
      return;
    }
    for (let i = 0; i < lib.length; i++) {
      const entry = lib[i];
      const row = document.createElement('div');
      row.className = 'lib-row';
      const info = document.createElement('div');
      info.className = 'lib-info';
      info.innerHTML = `<b>${this._esc(entry.name)}</b> <span class="lib-date">${this._esc(entry.date)}</span>`;
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.className = 'btn';
      loadBtn.addEventListener('click', () => {
        if (!confirm(`Load "${entry.name}"? Unsaved work will be lost.`)) return;
        this._clearAll();
        try {
          this.diagram.loadJSON(JSON.parse(entry.json));
          this._applyMeta();
          this.engine.reset();
          this.renderer.balls.clear();
          this._clearSparklines();
          this.editor._select(null, null);
          this.renderer.render();
          this.renderer.fitView();
        } catch (err) { alert('Failed to load: ' + err.message); }
        this._resetHistory();
        this._hideModal('lib-overlay');
      });
      const delBtn = document.createElement('button');
      delBtn.appendChild(this._faIcon('xmark'));
      delBtn.setAttribute('aria-label', 'Delete saved diagram');
      delBtn.className = 'btn';
      delBtn.addEventListener('click', () => {
        lib.splice(i, 1);
        this._saveLibrary(lib);
        this._renderLibraryList();
      });
      btns.appendChild(loadBtn);
      btns.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(btns);
      el.appendChild(row);
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

  // ── Export ────────────────────────────────────────────────────────────────

  _exportFilename(ext) {
    const raw = this.diagram.meta.name || 'diagram';
    return raw.replace(/[^a-z0-9_\-]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') + '.' + ext;
  }

  _exportSVG() {
    const svg = document.getElementById('canvas');
    const data = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([data], { type: 'image/svg+xml' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: this._exportFilename('svg'),
    });
    a.click();
  }

  _exportPNG() {
    const svg = document.getElementById('canvas');
    const w = svg.clientWidth, h = svg.clientHeight;
    const data = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([data], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * 2; canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      ctx.fillStyle = '#0f1117';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const a = Object.assign(document.createElement('a'), {
        download: this._exportFilename('png'), href: canvas.toDataURL('image/png'),
      });
      a.click();
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // ── CSV export of the recorded run history ──────────────────────────────────

  _csvCell(s) {
    s = String(s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Build a CSV of every tracked node's value at each recorded step.
  _buildCSV() {
    const ids = [];
    for (const n of this.diagram.nodes.values()) {
      if (n.type === NodeType.SOURCE && !n.limited) continue; // infinite sources aren't tracked
      ids.push(n.id);
    }
    const header = ['step', ...ids.map(id => this._csvCell(this.diagram.nodes.get(id)?.label || id))];
    const lines = [header.join(',')];
    for (const h of this.engine.history) {
      lines.push([h.step, ...ids.map(id => h.snap[id] ?? '')].join(','));
    }
    return lines.join('\n');
  }

  _exportCSV() {
    if (!this.engine.history.length) {
      this._toast('Run the simulation first to record history.');
      return;
    }
    const blob = new Blob([this._buildCSV()], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: this._exportFilename('csv'),
    });
    a.click();
  }

  // ── Shareable URL ───────────────────────────────────────────────────────────

  _encodeDiagram() {
    const json = JSON.stringify(this.diagram.toJSON());
    return btoa(unescape(encodeURIComponent(json)));
  }

  // Parse a diagram out of the current URL hash (#d=…), or null if absent/bad.
  _decodeDiagram() {
    const m = location.hash.match(/[#&]d=([^&]+)/);
    if (!m) return null;
    try {
      const json = decodeURIComponent(escape(atob(decodeURIComponent(m[1]))));
      return JSON.parse(json);
    } catch { return null; }
  }

  _shareURL() {
    const enc = this._encodeDiagram();
    const url = location.origin + location.pathname + '#d=' + enc;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        () => this._toast('Share link copied to clipboard'),
        () => prompt('Copy this share link:', url),
      );
    } else {
      prompt('Copy this share link:', url);
    }
    try { history.replaceState(null, '', '#d=' + enc); } catch { /* ignore */ }
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
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ── Example diagrams ──────────────────────────────────────────────────────
  //
  // Each demo is a self-contained systems model that produces genuinely
  // emergent behaviour — not just a wiring sampler. They lean on the engine's
  // formula rates, modifiers, registers, delays, queues, traders and coloured
  // resources, and each ships with a titled group, an explanatory note and an
  // on-canvas chart so it reads at a glance. Verified headlessly against the
  // engine before shipping; see the parameters on each for the tuned values.

  // Small builder helpers shared by the demos below.
  _demo() {
    const d = this.diagram;
    return {
      d,
      node: (type, x, y, label, f) => {
        const n = d.addNode(new MNode(type, x, y));
        if (label != null) n.label = label;
        if (f) f(n);
        return n;
      },
      res: (s, t, f) => { const c = d.addConnection(new MConnection(s.id, t.id)); if (f) f(c); return c; },
      st: (s, t, f) => { const c = d.addConnection(new MConnection(s.id, t.id, ConnectionType.STATE)); if (f) f(c); return c; },
      group: (x, y, w, h, label, color) => { const g = d.addGroup(new MGroup(x, y, w, h)); g.label = label; if (color) g.color = color; return g; },
      note: (x, y, w, h, text) => { const n = d.addNote(new MNote(x, y)); n.w = w; n.h = h; n.text = text; return n; },
      chart: (x, y, w, h, label, ids) => { const c = d.addChart(new MChart(x, y)); c.w = w; c.h = h; c.label = label; c.nodeIds = ids; return c; },
    };
  }

  // 1 — PREDATOR & PREY: two coupled populations settle into a stable limit
  // cycle. Rabbits breed logistically; foxes eat rabbits and starve without
  // them. Tunable via the breedRate / carrying / hunt parameters.
  _demoEcosystem() {
    const b = this._demo();
    b.d.params = { breedRate: 0.45, carrying: 200, hunt: 0.008 };
    b.group(250, 70, 700, 590, 'Predator–Prey Ecosystem', '#7cb342');

    const births = b.node(NodeType.REGISTER, 470, 165, 'births',
      n => { n.formula = 'Math.round(breedRate * prey * (1 - prey/carrying))'; });
    const rabbits = b.node(NodeType.POOL, 380, 340, 'Rabbits',
      n => { n.setCount(80, '#7cb342'); n.capacity = 500; });
    const foxes = b.node(NodeType.POOL, 760, 340, 'Foxes', n => n.setCount(20, '#ef5350'));

    b.st(rabbits, births, c => { c.variableName = 'prey'; c.label = 'prey'; });
    b.st(births, rabbits, c => { c.modifier = true; c.modFactor = 1; c.label = 'breed'; });
    b.st(foxes, rabbits, c => { c.variableName = 'pred'; c.label = 'pred'; });
    b.res(rabbits, foxes, c => { c.rateMode = RateMode.FORMULA; c.formula = 'hunt * prey * pred'; c.label = 'hunt'; });
    b.st(foxes, foxes, c => { c.modifier = true; c.modFactor = -0.28; c.label = 'starve'; });

    b.chart(370, 470, 470, 170, 'Populations', [rabbits.id, foxes.id]);
    b.note(980, 165, 250, 250,
      'Foxes eat rabbits; rabbits breed (slowing as they crowd their range); ' +
      'foxes starve without food.\n\nNo target was set — yet the two populations ' +
      'lock into a self-sustaining oscillation, foxes peaking just after rabbits. ' +
      'Press Run and watch the cycle.');
    this.renderer.render();
  }

  // 2 — EPIDEMIC (SIR): the textbook outbreak curve. Infections peak exactly as
  // the effective reproduction number Rₑ falls through 1 (herd immunity); the
  // run halts when the outbreak fades.
  _demoEpidemic() {
    const b = this._demo();
    b.d.params = { beta: 0.6, gamma: 0.18, N: 600 };
    b.group(240, 70, 840, 540, 'Epidemic — SIR Model', '#ef5350');

    const reff = b.node(NodeType.REGISTER, 640, 165, 'Reff',
      n => { n.formula = '(beta/gamma) * S / N'; });
    const sus = b.node(NodeType.POOL, 380, 340, 'Susceptible', n => n.setCount(590, '#42a5f5'));
    const inf = b.node(NodeType.POOL, 640, 340, 'Infected', n => {
      n.setCount(10, '#ef5350');
      n.endEnabled = true; n.endOperator = '<='; n.endValue = 3;   // outbreak fades → halt
    });
    const rec = b.node(NodeType.POOL, 900, 340, 'Recovered', n => n.setCount(0, '#66bb6a'));

    b.res(sus, inf, c => { c.rateMode = RateMode.FORMULA; c.formula = 'beta * S * I / N'; c.label = 'infect'; });
    b.res(inf, rec, c => { c.rateMode = RateMode.FORMULA; c.formula = 'gamma * I'; c.label = 'recover'; });
    b.st(sus, reff, c => { c.variableName = 'S'; c.label = 'S'; });
    b.st(inf, sus, c => { c.variableName = 'I'; c.label = 'I'; });

    b.chart(380, 470, 520, 150, 'S / I / R', [sus.id, inf.id, rec.id]);
    b.note(1110, 165, 250, 270,
      'Each infected person infects susceptibles at rate β·S·I/N and recovers at ' +
      'rate γ·I.\n\nWatch infections crest the instant Rₑ drops below 1 — the herd-' +
      'immunity threshold. A slice of the population is never infected. ' +
      'Open the Timeline to trace all three curves.');
    this.renderer.render();
  }

  // 3 — SUPPLY CHAIN: a production pipeline. Ore is smelted 2:1 into ingots,
  // shipped through a 3-step delay, then sold. The first sale lands only after
  // the pipeline fills — visible latency, then steady throughput.
  _demoSupplyChain() {
    const b = this._demo();
    b.d.resourceTypes = [{ name: 'Ore', color: '#90a4ae' }, { name: 'Ingot', color: '#ffa726' }];
    b.group(170, 200, 1010, 220, 'Factory Supply Chain', '#ffa726');

    const mine = b.node(NodeType.SOURCE, 250, 310, 'Mine', n => { n.resourceColor = '#90a4ae'; });
    const ore = b.node(NodeType.POOL, 430, 310, 'Ore', n => { n.capacity = 12; });
    const smelter = b.node(NodeType.CONVERTER, 610, 310, 'Smelter',
      n => { n.inputAmount = 2; n.outputColor = '#ffa726'; });
    const ingots = b.node(NodeType.POOL, 790, 310, 'Ingots');
    const shipping = b.node(NodeType.DELAY, 960, 310, 'Shipping', n => { n.delay = 3; });
    const market = b.node(NodeType.DRAIN, 1120, 310, 'Market');

    b.res(mine, ore, c => { c.rate = 2; });
    b.res(ore, smelter, c => { c.rate = 2; c.label = '2 ore'; });
    b.res(smelter, ingots, c => { c.rate = 1; c.label = '1 ingot'; });
    b.res(ingots, shipping, c => { c.rate = 1; });
    b.res(shipping, market, c => { c.rate = 1; });

    b.chart(250, 470, 560, 180, 'Ore · Ingots · Sold', [ore.id, ingots.id, market.id]);
    b.note(880, 470, 300, 180,
      'The Smelter converts 2 ore → 1 ingot; Shipping is a 3-step delay before ' +
      'the Market buys.\n\nNothing sells until the pipeline fills — then output ' +
      'holds steady at 1/step. Speed up the Mine and the Ore buffer (cap 12) ' +
      'backs up: a bottleneck.');
    this.renderer.render();
  }

  // 4 — BARTER ECONOMY: two towns each make one good and swap for the other
  // through a Trader (an atomic 2-grain ⇄ 2-timber exchange). Each storehouse
  // ends up holding BOTH colours — the barter made visible.
  _demoTradeNetwork() {
    const b = this._demo();
    b.d.resourceTypes = [{ name: 'Grain', color: '#fdd835' }, { name: 'Timber', color: '#8d6e63' }];
    b.group(220, 120, 770, 540, 'Barter Economy', '#8d6e63');

    const farm = b.node(NodeType.SOURCE, 300, 250, 'Farmland', n => { n.resourceColor = '#fdd835'; });
    const granary = b.node(NodeType.POOL, 510, 250, 'Granary', n => { n.capacity = 20; n.setCount(10, '#fdd835'); });
    const builders = b.node(NodeType.DRAIN, 770, 250, 'Builders');
    const forest = b.node(NodeType.SOURCE, 300, 530, 'Forest', n => { n.resourceColor = '#8d6e63'; });
    const yard = b.node(NodeType.POOL, 510, 530, 'Lumberyard', n => { n.capacity = 20; n.setCount(10, '#8d6e63'); });
    const sawmill = b.node(NodeType.DRAIN, 770, 530, 'Sawmill');
    const market = b.node(NodeType.TRADER, 640, 390, 'Market');

    b.res(farm, granary, c => { c.rate = 3; });
    b.res(forest, yard, c => { c.rate = 3; });
    // Trader: Granary pays 2 grain → Lumberyard pays 2 timber back.
    b.res(granary, market, c => { c.rate = 2; c.colorFilter = '#fdd835'; c.label = '2 grain'; });
    b.res(market, yard, c => { c.rate = 2; c.colorFilter = '#8d6e63'; c.label = '2 timber'; });
    // Each town consumes the good it imported.
    b.res(granary, builders, c => { c.rate = 2; c.colorFilter = '#8d6e63'; c.label = 'timber'; });
    b.res(yard, sawmill, c => { c.rate = 2; c.colorFilter = '#fdd835'; c.label = 'grain'; });

    b.note(1030, 250, 250, 280,
      'The Granary makes grain, the Lumberyard makes timber — but each needs the ' +
      "other.\n\nThe Market is a Trader: it swaps 2 grain for 2 timber atomically " +
      '(all-or-nothing). Imported goods are then consumed. Select a storehouse — ' +
      'it now holds BOTH colours, proof the barter flowed.');
    this.renderer.render();
  }

  // 5 — SERVICE DESK: a single-server queue with random (Poisson) arrivals.
  // When arrivals outpace the one server the line grows; when they ease it
  // clears — the M/D/1 queue behind every checkout and call centre.
  _demoQueue() {
    const b = this._demo();
    b.group(260, 180, 600, 230, 'Single-Server Queue', '#7c83ff');

    const arrivals = b.node(NodeType.SOURCE, 360, 290, 'Arrivals', n => { n.resourceColor = '#7c83ff'; });
    const desk = b.node(NodeType.QUEUE, 560, 290, 'Service Desk', n => { n.processTime = 2; });
    const served = b.node(NodeType.DRAIN, 760, 290, 'Served');

    b.res(arrivals, desk, c => {
      c.rateMode = RateMode.DISTRIBUTION; c.distType = 'poisson'; c.distParam1 = 0.35; c.label = 'Poisson';
    });
    b.res(desk, served, c => { c.rate = 1; });

    b.chart(330, 470, 480, 160, 'Waiting · Served', [desk.id, served.id]);
    b.note(900, 250, 270, 220,
      'Customers arrive at random (Poisson, ~0.35/step); one server takes 2 steps ' +
      'each.\n\nThe line breathes — building when arrivals cluster, draining when ' +
      'they thin. Run it again for a different trace, or open Batch Analysis to ' +
      'see the distribution of queue lengths across many runs.');
    this.renderer.render();
  }

  // 6 — F2P MOBILE GAME ECONOMY: a full free-to-play live-ops loop. Energy
  // regenerates and is spent to clear levels (minting Gold + XP); a sqrt level
  // curve gates Elite content via an activator; a probabilistic gacha gate
  // splits loot boxes into rarity tiers; DAU is a birth-death process feeding
  // an IAP gem faucet. Faucets and sinks self-balance into clean limit cycles.
  _demoF2P() {
    const b = this._demo();
    b.d.params = {
      regenRate: 5,        // energy regenerated per step
      goldPerWin: 16,      // soft currency minted per level cleared
      xpPerWin: 11,        // xp minted per level cleared
      payerRate: 6,        // payers per 1000 DAU per step (IAP conversion)
      installRate: 70,     // gross new installs per acquisition pulse
      churnRate: 0.028,    // fraction of DAU that churns each step
    };

    // Resource palette — one distinct colour per economy type.
    const C_ENERGY='#42a5f5', C_GOLD='#fdd835', C_GEM='#ab47bc', C_XP='#26c6da';
    const C_COMMON='#90a4ae', C_RARE='#29b6f6', C_EPIC='#ba68c8', C_LEG='#ffa726';
    const C_WIN='#66bb6a', C_GEAR='#7e57c2', C_PLAYER='#26a69a', C_PASS='#ec407a';
    b.d.resourceTypes = [
      {name:'Energy',color:C_ENERGY},{name:'Gold',color:C_GOLD},{name:'Gems',color:C_GEM},
      {name:'XP',color:C_XP},{name:'Common',color:C_COMMON},{name:'Rare',color:C_RARE},
      {name:'Epic',color:C_EPIC},{name:'Legendary',color:C_LEG},{name:'Players',color:C_PLAYER},
    ];

    // ── GROUPS ────────────────────────────────────────────────────────────────
    b.group(60,   60, 900, 480, 'Core Gameplay Loop',        '#42a5f5');
    b.group(60,  580, 900, 420, 'Gacha / Loot Boxes',        '#ab47bc');
    b.group(1000, 60, 860, 480, 'Progression & Content',     '#26c6da');
    b.group(1000,580, 860, 420, 'Economy · Retention · IAP', '#fdd835');

    // ── CORE GAMEPLAY LOOP ──────────────────────────────────────────────────────
    // Energy regenerates over time and is spent to clear levels. Watch-an-ad gives a
    // stochastic energy refill (dice + chance) on top of passive regen.
    const regen  = b.node(NodeType.SOURCE,    110, 170, 'Stamina Regen', n=>{ n.resourceColor=C_ENERGY; });
    const adWatch= b.node(NodeType.SOURCE,    110, 320, 'Watch Ad',      n=>{ n.resourceColor=C_ENERGY; });
    const energy = b.node(NodeType.POOL,      330, 170, 'Energy', n=>{ n.setCount(40, C_ENERGY); n.capacity=40; });
    const play   = b.node(NodeType.CONVERTER, 540, 170, 'Play Level', n=>{ n.inputAmount=6; n.outputColor=C_WIN; });
    const wins   = b.node(NodeType.POOL,      760, 170, 'Levels Cleared', n=>{ n.capacity=999999; });

    b.res(regen,  energy, c=>{ c.rateMode=RateMode.FORMULA; c.formula='regenRate'; c.label='+regen'; });
    b.res(adWatch,energy, c=>{ c.rateMode=RateMode.DICE; c.dice='1d6'; c.chance=40; c.label='ad 1d6 @40%'; });
    b.res(energy, play,   c=>{ c.rate=6; c.label='6 energy'; });
    b.res(play,   wins,   c=>{ c.rate=1; c.label='clear'; });

    // Faucets: each cleared level mints Gold + XP (delta modifiers off the win count).
    const gold = b.node(NodeType.POOL, 330, 360, 'Gold', n=>{ n.setCount(80, C_GOLD); n.capacity=999999; });
    const xp   = b.node(NodeType.POOL, 760, 360, 'XP',   n=>{ n.setCount(0,  C_XP);   n.capacity=999999; });
    b.st(wins, gold, c=>{ c.modifier=true; c.modMode='delta'; c.modFormula='goldPerWin'; c.label='+gold/win'; });
    b.st(wins, xp,   c=>{ c.modifier=true; c.modMode='delta'; c.modFormula='xpPerWin';   c.label='+xp/win'; });

    // Win-streak register (informational): each win adds, drives nothing harmful.
    const streak = b.node(NodeType.REGISTER, 560, 360, 'streak', n=>{ n.formula='min(20, floor(winCount/3))'; });
    b.st(wins, streak, c=>{ c.variableName='winCount'; c.label='winCount'; });

    // ── PROGRESSION & CONTENT ───────────────────────────────────────────────────
    // XP → Level on a rising sqrt curve. Level gates Elite content via an activator.
    const level = b.node(NodeType.REGISTER, 1080, 160, 'level', n=>{ n.formula='floor( sqrt(xpTotal / 60) ) + 1'; });
    b.st(xp, level, c=>{ c.variableName='xpTotal'; c.label='xpTotal'; });

    // Account power: derived from rarity holdings + gear (the strength meta-metric).
    const power = b.node(NodeType.REGISTER, 1320, 160, 'power',
      n=>{ n.formula='cCommon + cRare*4 + cEpic*16 + cLeg*64 + gearTiers*40 + eliteHeld*8'; });

    // Elite content unlocks at level >= 4: energy spills into an Elite reserve, a
    // gated Elite converter mints high-tier loot.
    const eliteEnergy = b.node(NodeType.POOL,      1080, 320, 'Elite Energy', n=>{ n.setCount(0,C_ENERGY); n.capacity=60; });
    const eliteRun    = b.node(NodeType.CONVERTER, 1320, 320, 'Elite Stage',  n=>{ n.inputAmount=8; n.outputColor=C_LEG; });
    const eliteLoot   = b.node(NodeType.POOL,      1560, 320, 'Elite Loot',   n=>{ n.capacity=999999; });
    b.res(energy, eliteEnergy, c=>{ c.rate=3; c.condEnabled=true; c.condRefMode='variable'; c.condVariable='level'; c.condOperator='>='; c.condValue=4; c.label='if Lv>=4'; });
    b.res(eliteEnergy, eliteRun, c=>{ c.rate=8; c.label='8 energy'; });
    b.res(eliteRun,    eliteLoot,c=>{ c.rate=2; c.label='elite loot'; });
    b.st(level, eliteRun, c=>{ c.activator=true; c.actOperator='>='; c.actValue=4; c.label='Lv>=4'; });
    b.st(eliteLoot, power, c=>{ c.variableName='eliteHeld'; c.label='eliteHeld'; });

    // Battle Pass: every win contributes XP to a pass tier (capped register).
    const passXP  = b.node(NodeType.POOL,      1080, 460, 'Pass XP', n=>{ n.setCount(0,C_PASS); n.capacity=999999; });
    const passTier= b.node(NodeType.REGISTER,  1320, 460, 'passTier', n=>{ n.formula='min(30, floor(passPts/40))'; });
    b.st(wins, passXP, c=>{ c.modifier=true; c.modMode='delta'; c.modFactor=10; c.label='+10/win'; });
    b.st(passXP, passTier, c=>{ c.variableName='passPts'; c.label='passPts'; });

    // ── GACHA / LOOT BOXES ──────────────────────────────────────────────────────
    // Gems buy pull tickets; a box-open DELAY then a probabilistic GATE split each
    // box into rarity tiers (70/22/7/1%).
    const gems     = b.node(NodeType.POOL,  110, 690, 'Gems', n=>{ n.setCount(50, C_GEM); n.capacity=9999; });
    const pullBuf  = b.node(NodeType.POOL,  300, 690, 'Pull Tickets', n=>{ n.setCount(0, C_COMMON); n.capacity=400; });
    const openBox  = b.node(NodeType.DELAY, 480, 690, 'Open Box', n=>{ n.delay=2; });
    const pullGate = b.node(NodeType.GATE,  650, 690, 'Rarity Roll', n=>{ n.gateMode='probabilistic'; });
    b.res(gems,    pullBuf, c=>{ c.rate=2; c.label='spend gems'; });
    b.res(pullBuf, openBox, c=>{ c.rate=2; c.label='open'; });
    b.res(openBox, pullGate,c=>{ c.rate=4; c.label='roll'; });

    const common = b.node(NodeType.POOL, 820, 610, 'Common',    n=>{ n.capacity=999999; });
    const rare   = b.node(NodeType.POOL, 820, 690, 'Rare',      n=>{ n.capacity=999999; });
    const epic   = b.node(NodeType.POOL, 820, 770, 'Epic',      n=>{ n.capacity=999999; });
    const legend = b.node(NodeType.POOL, 820, 900, 'Legendary', n=>{ n.setCount(0,C_LEG); n.capacity=999999; });
    b.res(pullGate, common, c=>{ c.weight=70; c.label='70%'; });
    b.res(pullGate, rare,   c=>{ c.weight=22; c.label='22%'; });
    b.res(pullGate, epic,   c=>{ c.weight=7;  c.label='7%'; });
    b.res(pullGate, legend, c=>{ c.weight=1;  c.label='1%'; });

    // Publish rarity holdings to the power register.
    b.st(common, power, c=>{ c.variableName='cCommon'; c.label='cCommon'; });
    b.st(rare,   power, c=>{ c.variableName='cRare';   c.label='cRare'; });
    b.st(epic,   power, c=>{ c.variableName='cEpic';   c.label='cEpic'; });
    b.st(legend, power, c=>{ c.variableName='cLeg';    c.label='cLeg'; });

    // Dust sink: duplicate Commons get salvaged (a drain) once a stockpile builds.
    const dust = b.node(NodeType.DRAIN, 560, 900, 'Salvage Dust');
    b.res(common, dust, c=>{ c.rate=2; c.condEnabled=true; c.condOperator='>'; c.condValue=40; c.label='if Common>40'; });

    // ── ECONOMY · RETENTION · IAP ────────────────────────────────────────────────
    // Gold sink: a crafting converter spends gold into Gear Tiers (account power).
    const craft = b.node(NodeType.CONVERTER, 1060, 690, 'Crafting', n=>{ n.inputAmount=24; n.outputColor=C_GEAR; });
    const gear  = b.node(NodeType.POOL,      1260, 690, 'Gear Tiers', n=>{ n.setCount(0,C_GEAR); n.capacity=999; });
    b.res(gold,  craft, c=>{ c.rate=24; c.condEnabled=true; c.condOperator='>='; c.condValue=120; c.label='if gold>=120'; });
    b.res(craft, gear,  c=>{ c.rate=1; c.label='+gear'; });
    b.st(gear, power, c=>{ c.variableName='gearTiers'; c.label='gearTiers'; });

    // Active players (DAU) as a birth–death process: new installs pulse in (scaled
    // by content depth = level), churn drains a fraction each step → it stabilises.
    const installs = b.node(NodeType.SOURCE, 1060, 840, 'New Installs', n=>{ n.resourceColor=C_PLAYER; });
    const dau      = b.node(NodeType.POOL,   1280, 840, 'Active Players', n=>{ n.setCount(700,C_PLAYER); n.capacity=8000; });
    const churn    = b.node(NodeType.DRAIN,  1500, 840, 'Churned');
    b.res(installs, dau, c=>{ c.rateMode=RateMode.FORMULA; c.formula='round(installRate * (1 + level/6))'; c.interval=3; c.label='installs'; });
    b.res(dau, churn, c=>{ c.flowMode='push'; c.rateMode=RateMode.FORMULA; c.formula='round(dauVal * churnRate)'; c.label='churn'; });
    b.st(dau, dau, c=>{ c.variableName='dauVal'; c.label='dauVal'; });

    // IAP: a small % of DAU convert and pay → buy Gems (faucet scaled by DAU).
    const iap = b.node(NodeType.SOURCE, 1560, 690, 'IAP Shop', n=>{ n.resourceColor=C_GEM; });
    b.res(iap, gems, c=>{ c.rateMode=RateMode.FORMULA; c.formula='round(dauVal * payerRate / 1000)'; c.label='IAP gems'; });

    // Whale sink: high spenders burn surplus gems on cosmetics (a self-regulating
    // formula drain), keeping gems cycling around a setpoint instead of exploding.
    const skins = b.node(NodeType.DRAIN, 110, 840, 'Cosmetic Skins');
    b.res(gems, skins, c=>{ c.rateMode=RateMode.FORMULA; c.formula='round((gemBal-30) * 0.5)'; c.condEnabled=true; c.condRefMode='variable'; c.condVariable='gemBal'; c.condOperator='>'; c.condValue=30; c.label='whale spend'; });
    b.st(gems, skins, c=>{ c.variableName='gemBal'; c.label='gemBal'; });

    // Daily login retention pulse: returning players top up gems.
    const login = b.node(NodeType.SOURCE, 300, 840, 'Daily Login', n=>{ n.resourceColor=C_GEM; });
    b.res(login, gems,  c=>{ c.rate=10; c.interval=7; c.label='login +10 gems'; });

    // ── CHARTS & NOTES ──────────────────────────────────────────────────────────
    b.chart(110, 420, 420, 110, 'Energy · Gold · XP', [energy.id, gold.id, xp.id]);
    b.chart(560, 610, 240, 100, 'Rarity drops', [common.id, rare.id, epic.id, legend.id]);
    b.chart(1620, 60, 220, 200, 'Power · DAU · Level', [power.id, dau.id, level.id]);
    b.chart(1480, 460, 360, 70, 'Gems · Gear', [gems.id, gear.id]);

    b.note(560, 80, 380, 75,
      'A full free-to-play live-ops economy. Energy regenerates (plus stochastic ' +
      'Watch-Ad refills) and is spent to clear levels, minting Gold and XP.');
    b.note(1080, 80, 470, 60,
      'XP raises Level on a rising sqrt curve; Level >= 4 unlocks the Elite Stage ' +
      '(activator). Power aggregates rarity + gear + elite holdings.');
    b.note(110, 920, 420, 60,
      'Gems buy pulls; the box-open Delay + probabilistic Rarity Gate split each box ' +
      '70/22/7/1%. Surplus Commons salvage to Dust; gems also fund cosmetics.');
    b.note(1080, 920, 470, 60,
      'DAU is a birth-death process: installs pulse in (scaled by Level), churn ' +
      'drains a fraction each step. A % of DAU pays IAP, faucetting Gems.');
    this.renderer.render();
  }

  // 7 — CIVILIZATION EMPIRE: a 4X economy in one diagram. Food sets a carrying
  // capacity; Population grows logistically toward it (throttled by Happiness).
  // Production builds Granaries/Libraries/Markets/Theaters; accumulated Science
  // trips four tech activators in sequence (irrigation, drama, banking,
  // university), each compounding a yield. Theaters stay locked until Drama.
  _demoCiv() {
    const b = this._demo();
    // ───────────────────────── COLOURS & RESOURCE TYPES ─────────────────────────
    const C = { food:'#7cb342', prod:'#ff8a3d', gold:'#fdd835', sci:'#42a5f5', cult:'#ab47bc', pop:'#e0e0e0' };
    b.d.resourceTypes = [
      { name:'Food', color:C.food }, { name:'Production', color:C.prod },
      { name:'Gold', color:C.gold }, { name:'Science', color:C.sci },
      { name:'Culture', color:C.cult }, { name:'Citizens', color:C.pop },
    ];
    // Tunable empire constants (edit live in the Parameters panel).
    b.d.params = {
      growthK: 0.12,      // logistic birth coefficient
      famine: 0.18,       // starvation decay coefficient
      foodPerPop: 2,      // food each citizen eats / step
      techFarm: 110,      // Science to unlock Irrigation
      techDramaT: 320,    // Science to unlock Drama (enables Theaters)
      techBank: 1200,     // Science to unlock Banking
      techUni: 3500,      // Science to unlock University
      happyBase: 14,      // baseline happiness
    };

    // ───────────────────────── GROUPS ─────────────────────────
    b.group(120,  60, 760, 250, 'Population & Food',  '#7cb342');
    b.group(120, 340, 760, 360, 'Yields & Buildings', '#ff8a3d');
    b.group(920,  60, 540, 320, 'Tech Tree',          '#42a5f5');
    b.group(920, 410, 540, 300, 'Treasury & Culture', '#fdd835');

    // ───────────────────────── POPULATION (logistic) ─────────────────────────
    // Food surplus sets the carrying capacity the land can feed.
    const carry = b.node(NodeType.REGISTER, 470, 120, 'capacity',
      n => { n.formula = 'max(4, round(foodStock / foodPerPop) + 4)'; });
    // Logistic births — grow toward capacity, gated off when happiness <= 0.
    const births = b.node(NodeType.REGISTER, 660, 120, 'births',
      n => { n.formula = 'happy > 0 ? round(growthK * pop * (1 - pop/capacity)) : 0'; });
    // Famine deaths when the granary store is empty.
    const deaths = b.node(NodeType.REGISTER, 660, 215, 'deaths',
      n => { n.formula = 'foodStock <= 0 ? max(1, round(famine * pop)) : 0'; });

    const population = b.node(NodeType.POOL, 300, 170, 'Population',
      n => { n.setCount(6, C.pop); n.capacity = 400; });
    const foodStore = b.node(NodeType.POOL, 300, 250, 'Granary Store',
      n => { n.setCount(10, C.food); n.capacity = 300; });

    b.st(population, carry,  c => { c.variableName = 'pop'; });
    b.st(foodStore,  carry,  c => { c.variableName = 'foodStock'; });
    b.st(births, population, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor =  1; c.label = 'Δ grow'; });
    b.st(deaths, population, c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -1; c.label = 'Δ famine'; });

    // ───────────────────────── FOOD ECONOMY ─────────────────────────
    const farmland = b.node(NodeType.SOURCE, 150, 200, 'Farmland', n => { n.resourceColor = C.food; });
    // Harvest scales with workers; Irrigation tech adds a big multiplier.
    const foodYield = b.node(NodeType.REGISTER, 150, 285, 'foodYield',
      n => { n.formula = 'round(pop * 1.4) + irrigation * round(pop * 0.8) + 4'; });
    b.res(farmland, foodStore, c => { c.rateMode = RateMode.FORMULA; c.formula = 'foodYield'; c.label = 'harvest'; });
    const eat = b.node(NodeType.DRAIN, 470, 250, 'Consumption');
    b.res(foodStore, eat, c => { c.rateMode = RateMode.FORMULA; c.formula = 'round(pop * foodPerPop)'; c.label = 'eat'; });

    // ───────────────────────── PRODUCTION (hammers) ─────────────────────────
    const workshop = b.node(NodeType.SOURCE, 150, 400, 'Workshops', n => { n.resourceColor = C.prod; });
    const prodYield = b.node(NodeType.REGISTER, 150, 485, 'prodYield', n => { n.formula = 'round(pop * 1.0) + 2'; });
    const hammers = b.node(NodeType.POOL, 320, 430, 'Production', n => { n.setCount(0, C.prod); n.capacity = 60; });
    b.res(workshop, hammers, c => { c.rateMode = RateMode.FORMULA; c.formula = 'prodYield'; c.label = 'hammers'; });

    // BUILDINGS — converters that turn Production into building levels. Each hammer
    // feed is GATED by a condition on its level variable so it stops pushing once
    // the line is maxed (no useless pile-up in the converter).
    const buildGranary = b.node(NodeType.CONVERTER, 500, 400, 'Build Granary', n => { n.inputAmount = 14; n.outputColor = C.food; });
    const granaryLvl   = b.node(NodeType.POOL,      660, 400, 'Granaries',     n => { n.setCount(0, C.food); n.capacity = 5; });
    b.res(hammers, buildGranary, c => { c.rate = 4; c.label = '4 hammers'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'granaries'; c.condOperator = '<'; c.condValue = 5; });
    b.res(buildGranary, granaryLvl, c => { c.rate = 1; });

    const buildLibrary = b.node(NodeType.CONVERTER, 500, 470, 'Build Library', n => { n.inputAmount = 18; n.outputColor = C.sci; });
    const libraryLvl   = b.node(NodeType.POOL,      660, 470, 'Libraries',     n => { n.setCount(0, C.sci); n.capacity = 5; });
    b.res(hammers, buildLibrary, c => { c.rate = 3; c.label = '3 hammers'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'libraries'; c.condOperator = '<'; c.condValue = 5; });
    b.res(buildLibrary, libraryLvl, c => { c.rate = 1; });

    const buildMarket = b.node(NodeType.CONVERTER, 500, 540, 'Build Market', n => { n.inputAmount = 16; n.outputColor = C.gold; });
    const marketLvl   = b.node(NodeType.POOL,      660, 540, 'Markets',      n => { n.setCount(0, C.gold); n.capacity = 5; });
    b.res(hammers, buildMarket, c => { c.rate = 3; c.label = '3 hammers'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'markets'; c.condOperator = '<'; c.condValue = 5; });
    b.res(buildMarket, marketLvl, c => { c.rate = 1; });

    // Theaters: gated TWICE — a level cap condition AND a Drama-tech activator.
    const buildTheater = b.node(NodeType.CONVERTER, 500, 610, 'Build Theater', n => { n.inputAmount = 20; n.outputColor = C.cult; });
    const theaterLvl   = b.node(NodeType.POOL,      660, 610, 'Theaters',      n => { n.setCount(0, C.cult); n.capacity = 5; });
    b.res(hammers, buildTheater, c => { c.rate = 2; c.label = '2 hammers'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'theaters'; c.condOperator = '<'; c.condValue = 5; });
    b.res(buildTheater, theaterLvl, c => { c.rate = 1; });

    // Publish building levels for the yield formulas.
    b.st(granaryLvl, foodYield, c => { c.variableName = 'granaries'; });
    b.st(libraryLvl, foodYield, c => { c.variableName = 'libraries'; });
    b.st(marketLvl,  foodYield, c => { c.variableName = 'markets'; });
    b.st(theaterLvl, foodYield, c => { c.variableName = 'theaters'; });

    // ───────────────────────── SCIENCE & TECH TREE ─────────────────────────
    const sciSource = b.node(NodeType.SOURCE, 980, 110, 'Scholars', n => { n.resourceColor = C.sci; });
    // Science output rises with population & libraries; University tech adds a big bonus.
    const sciRate = b.node(NodeType.REGISTER, 980, 195, 'science_rate',
      n => { n.formula = 'round(pop * 0.6) + libraries * 3 + university * round(pop*0.5) + 1'; });
    const research = b.node(NodeType.POOL, 1150, 150, 'Research', n => { n.setCount(0, C.sci); n.capacity = 100000; });
    b.res(sciSource, research, c => { c.rateMode = RateMode.FORMULA; c.formula = 'science_rate'; c.label = 'science'; });
    b.st(research, sciRate, c => { c.variableName = 'sciTotal'; });

    // Four techs flip from 0->1 as accumulated Research crosses each threshold.
    const techIrrigation = b.node(NodeType.REGISTER, 1320, 100, 'irrigation', n => { n.formula = 'sciTotal >= techFarm ? 1 : 0'; });
    const techDrama      = b.node(NodeType.REGISTER, 1320, 175, 'drama',      n => { n.formula = 'sciTotal >= techDramaT ? 1 : 0'; });
    const techBanking    = b.node(NodeType.REGISTER, 1320, 250, 'banking',    n => { n.formula = 'sciTotal >= techBank ? 1 : 0'; });
    const techUniversity = b.node(NodeType.REGISTER, 1320, 325, 'university', n => { n.formula = 'sciTotal >= techUni ? 1 : 0'; });

    // ───────────────────────── GOLD & TREASURY ─────────────────────────
    const mint = b.node(NodeType.SOURCE, 980, 460, 'Trade', n => { n.resourceColor = C.gold; });
    // Income from population & markets; Banking tech compounds market income.
    const goldRate = b.node(NodeType.REGISTER, 980, 545, 'goldRate',
      n => { n.formula = 'round(pop * 0.5) + markets * 4 + banking * markets * 3 + 2'; });
    const treasury = b.node(NodeType.POOL, 1150, 490, 'Treasury', n => { n.setCount(20, C.gold); n.capacity = 600; });
    b.res(mint, treasury, c => { c.rateMode = RateMode.FORMULA; c.formula = 'goldRate'; c.label = 'income'; });
    const upkeep = b.node(NodeType.DRAIN, 1320, 490, 'Upkeep');
    b.res(treasury, upkeep, c => { c.rateMode = RateMode.FORMULA; c.formula = 'round(pop * 0.3) + granaries + libraries + markets + theaters'; c.label = 'upkeep'; });
    b.st(treasury, goldRate, c => { c.variableName = 'gold'; });

    // ───────────────────────── CULTURE & HAPPINESS ─────────────────────────
    const cultSource = b.node(NodeType.SOURCE, 980, 620, 'Artisans', n => { n.resourceColor = C.cult; });
    const cultRate = b.node(NodeType.REGISTER, 980, 685, 'cultRate', n => { n.formula = 'theaters * 3 + round(pop*0.2) + 1'; });
    const culture = b.node(NodeType.POOL, 1150, 640, 'Culture', n => { n.setCount(0, C.cult); n.capacity = 100000; });
    b.res(cultSource, culture, c => { c.rateMode = RateMode.FORMULA; c.formula = 'cultRate'; c.label = 'culture'; });

    // Happiness: base + theaters + food surplus − crowding. Throttles births.
    const happiness = b.node(NodeType.REGISTER, 470, 215, 'happy',
      n => { n.formula = 'happyBase + theaters*3 + (foodStock > pop ? 4 : 0) - round(pop * 0.18)'; });

    // TECH ACTIVATOR: amphitheaters cannot be built until Drama is researched.
    b.st(techDrama, buildTheater, c => { c.activator = true; c.actOperator = '>='; c.actValue = 1; c.label = '⊢ drama'; });

    // ───────────────────────── CHARTS & NOTES ─────────────────────────
    b.chart(150, 470, 320, 200, 'Empire — Population · Food · Culture', [population.id, foodStore.id, culture.id]);
    b.chart(920, 730, 540, 175, 'Tech unlocks (0->1): Irrigation · Drama · Banking · University',
      [techIrrigation.id, techDrama.id, techBanking.id, techUniversity.id]);
    b.note(120, 720, 480, 120,
      'A turn-based empire as one living economy. Food sets the carrying capacity; ' +
      'Population grows LOGISTICALLY toward it and stalls when Happiness runs out. ' +
      'Production builds Granaries, Libraries, Markets and Theaters — each boosting a yield.');
    b.note(620, 720, 280, 120,
      'Research accumulates and trips four TECH ACTIVATORS in sequence. Irrigation ' +
      'lifts farms; Drama unlocks Theaters; Banking compounds gold; University ' +
      'multiplies science. Watch the S-curve and the tech steps in the charts.');
    this.renderer.render();
  }

  // 8 — MEGAFACTORY LINE: a 4-tier automated factory (raw extraction →
  // smelting → components → final assembly/shipping). Iron & copper mines are
  // finite; coal fuels smelters via an activator. A deliberate bottleneck (a
  // tiny Circuit buffer drained by a slow Assembly queue) pins at capacity and
  // backs the line up — gears & wire pile to their caps while widgets starve.
  _demoFactory() {
    const b = this._demo();
    // 4 tiers, left to right: raw extraction -> smelting -> components -> final
    // assembly/shipping. Iron & copper ore are FINITE (mines deplete). Coal fuels
    // the smelters through an activator. A deliberate BOTTLENECK (tiny Circuit
    // buffer drained by a slow Assembly queue) pins at capacity and backs the line
    // up: gears & wire pile up upstream while the widget line stays starved.
    const C = {
      ironOre:'#90a4ae', copperOre:'#bf6a3a', coal:'#37474f',
      ironPlate:'#cfd8dc', copperPlate:'#ff8a65',
      gear:'#8d6e63', wire:'#fdd835', circuit:'#66bb6a',
      steel:'#78909c', frame:'#5c6bc0', widget:'#42a5f5', scrap:'#ef5350',
    };
    b.d.resourceTypes = [
      { name:'Iron Ore', color:C.ironOre }, { name:'Copper Ore', color:C.copperOre },
      { name:'Coal', color:C.coal }, { name:'Iron Plate', color:C.ironPlate },
      { name:'Copper Plate', color:C.copperPlate }, { name:'Gear', color:C.gear },
      { name:'Wire', color:C.wire }, { name:'Circuit', color:C.circuit },
      { name:'Steel Beam', color:C.steel }, { name:'Frame', color:C.frame },
      { name:'Widget', color:C.widget }, { name:'Scrap', color:C.scrap },
    ];
    b.d.params = { ironYield:9, copperYield:4 };

    // ───── Tier bands ─────
    b.group(80, 60, 520, 740, 'Tier 0 · Raw Extraction', '#78909c');
    b.group(620, 60, 560, 740, 'Tier 1 · Smelting', '#ffa726');
    b.group(1200, 60, 540, 740, 'Tier 2 · Component Assembly', '#66bb6a');
    b.group(1760, 60, 900, 740, 'Tier 3 · Final Assembly & Shipping', '#42a5f5');

    // ===================== TIER 0 — RAW EXTRACTION =====================
    // Finite iron & copper mines + an infinite coal seam feeding ore buffers.
    const ironMine = b.node(NodeType.SOURCE, 150, 170, 'Iron Mine', n=>{ n.resourceColor=C.ironOre; n.limited=true; n.setCount(1400, C.ironOre); });
    const copperMine = b.node(NodeType.SOURCE, 150, 400, 'Copper Mine', n=>{ n.resourceColor=C.copperOre; n.limited=true; n.setCount(800, C.copperOre); });
    const coalSeam = b.node(NodeType.SOURCE, 150, 640, 'Coal Seam', n=>{ n.resourceColor=C.coal; });

    const ironOreBuf = b.node(NodeType.POOL, 380, 170, 'Iron Ore', n=>{ n.capacity=30; n.setCount(10, C.ironOre); });
    const copperOreBuf = b.node(NodeType.POOL, 380, 400, 'Copper Ore', n=>{ n.capacity=24; n.setCount(10, C.copperOre); });
    const coalBuf = b.node(NodeType.POOL, 380, 640, 'Coal Stock', n=>{ n.capacity=40; n.setCount(20, C.coal); });

    b.res(ironMine, ironOreBuf, c=>{ c.rateMode=RateMode.FORMULA; c.formula='ironYield'; c.label='extract'; });
    b.res(copperMine, copperOreBuf, c=>{ c.rateMode=RateMode.FORMULA; c.formula='copperYield'; c.label='extract'; });
    b.res(coalSeam, coalBuf, c=>{ c.rate=3; c.label='dig'; });

    // ===================== TIER 1 — SMELTING =====================
    // 2 ore -> 1 plate. Smelters fire only while the burner holds fuel (activator).
    // Belt DELAYS (conveyor transit) sit between smelter and plate buffer.
    const burner = b.node(NodeType.POOL, 700, 640, 'Burner Fuel', n=>{ n.capacity=14; n.setCount(6, C.coal); });
    b.res(coalBuf, burner, c=>{ c.rate=2; c.label='stoke'; });
    // Steady fuel burn each step (the furnaces consume coal as they run).
    b.st(burner, burner, c=>{ c.modifier=true; c.modMode='step'; c.modFactor=-1; c.label='burn'; });

    // Converters carry a small working buffer (capacity) so a blocked output
    // backs pressure UP the line instead of letting the machine hoard input.
    const ironSmelter = b.node(NodeType.CONVERTER, 720, 170, 'Iron Smelter', n=>{ n.inputAmount=2; n.outputColor=C.ironPlate; n.capacity=8; });
    const copperSmelter = b.node(NodeType.CONVERTER, 720, 400, 'Copper Smelter', n=>{ n.inputAmount=2; n.outputColor=C.copperPlate; n.capacity=8; });
    b.res(ironOreBuf, ironSmelter, c=>{ c.rate=8; c.label='2 ore'; });
    b.res(copperOreBuf, copperSmelter, c=>{ c.rate=3; c.label='2 ore'; });
    // Activator: a smelter only runs while fuel is present.
    b.st(burner, ironSmelter, c=>{ c.activator=true; c.actOperator='>'; c.actValue=0; c.label='fuel?'; });
    b.st(burner, copperSmelter, c=>{ c.activator=true; c.actOperator='>'; c.actValue=0; c.label='fuel?'; });

    // Belts are capacity-bounded too, so a full plate buffer backs pressure onto
    // the smelter rather than letting the belt hoard an unbounded backlog.
    const ironBelt = b.node(NodeType.DELAY, 920, 170, 'Iron Belt', n=>{ n.delay=3; n.capacity=12; });
    const copperBelt = b.node(NodeType.DELAY, 920, 400, 'Copper Belt', n=>{ n.delay=3; n.capacity=12; });
    b.res(ironSmelter, ironBelt, c=>{ c.rate=4; c.label='plate'; });
    b.res(copperSmelter, copperBelt, c=>{ c.rate=2; c.label='plate'; });

    const ironPlateBuf = b.node(NodeType.POOL, 1080, 170, 'Iron Plates', n=>{ n.capacity=28; });
    const copperPlateBuf = b.node(NodeType.POOL, 1080, 400, 'Copper Plates', n=>{ n.capacity=24; });
    b.res(ironBelt, ironPlateBuf, c=>{ c.rate=7; });
    b.res(copperBelt, copperPlateBuf, c=>{ c.rate=4; });

    // ===================== TIER 2 — COMPONENT ASSEMBLY =====================
    // Gears (2 iron plate -> 1 gear) and Wire (1 copper plate -> 1 wire).
    const gearPress = b.node(NodeType.CONVERTER, 1260, 170, 'Gear Press', n=>{ n.inputAmount=2; n.outputColor=C.gear; n.capacity=8; });
    const wireDrawer = b.node(NodeType.CONVERTER, 1260, 400, 'Wire Drawer', n=>{ n.inputAmount=1; n.outputColor=C.wire; n.capacity=8; });
    b.res(ironPlateBuf, gearPress, c=>{ c.rate=4; c.label='2 plate'; });
    b.res(copperPlateBuf, wireDrawer, c=>{ c.rate=3; c.label='plate'; });

    const gearBuf = b.node(NodeType.POOL, 1440, 170, 'Gears', n=>{ n.capacity=22; });
    const wireBuf = b.node(NodeType.POOL, 1440, 400, 'Wire', n=>{ n.capacity=22; });
    b.res(gearPress, gearBuf, c=>{ c.rate=2; });
    b.res(wireDrawer, wireBuf, c=>{ c.rate=3; });

    // Circuit Lab: a multi-ingredient recipe — gears + wire pushed into one
    // converter (inputAmount=3 held resources per circuit).
    const circuitLab = b.node(NodeType.CONVERTER, 1620, 290, 'Circuit Lab', n=>{ n.inputAmount=3; n.outputColor=C.circuit; n.capacity=9; });
    b.res(gearBuf, circuitLab, c=>{ c.rate=2; c.label='gear'; });
    b.res(wireBuf, circuitLab, c=>{ c.rate=3; c.label='wire'; });

    // ── Parallel STEEL sub-line (structural frames) ──
    // Iron plates also feed a steel furnace (2 plate -> 1 beam); beams weld into
    // frames. This contends with the gear press for the iron plate buffer — fair
    // allocation splits the plates between the two recipes.
    const steelFurnace = b.node(NodeType.CONVERTER, 1260, 620, 'Steel Furnace', n=>{ n.inputAmount=2; n.outputColor=C.steel; n.capacity=8; });
    b.res(ironPlateBuf, steelFurnace, c=>{ c.rate=3; c.label='2 plate'; });
    const steelBuf = b.node(NodeType.POOL, 1440, 620, 'Steel Beams', n=>{ n.capacity=18; });
    b.res(steelFurnace, steelBuf, c=>{ c.rate=2; });
    // Frame Welder is intentionally slow (draws beams at rate 1) so Steel Beams
    // backs up toward its cap — a second, milder back-pressure point.
    const frameWelder = b.node(NodeType.CONVERTER, 1620, 620, 'Frame Welder', n=>{ n.inputAmount=2; n.outputColor=C.frame; n.capacity=8; });
    b.res(steelBuf, frameWelder, c=>{ c.rate=1; c.label='beam'; });

    // Maintenance depot: gears are ALSO consumed (in a small share) to keep the
    // machines running — a competing draw on the gear buffer, drained on demand
    // (PULL, all-or-nothing every few steps).
    const maint = b.node(NodeType.POOL, 1620, 70, 'Spare Parts', n=>{ n.capacity=16; n.flowMode='pull'; n.pullPolicy='all'; });
    b.res(gearBuf, maint, c=>{ c.rate=1; c.interval=3; c.label='upkeep'; });
    const repairs = b.node(NodeType.DRAIN, 1760, 70, 'Repairs');
    b.res(maint, repairs, c=>{ c.rate=1; c.interval=4; c.label='use'; });

    // ===================== TIER 3 — FINAL ASSEMBLY & SHIPPING =====================
    // *** BOTTLENECK: a tiny Circuit buffer (cap 6) drained by a SLOW serial
    // Assembly queue (1 unit / 3 steps). The circuit buffer pins at 6 while the
    // Circuit Lab idles and gears/wire pile up upstream. ***
    const circuitBuf = b.node(NodeType.POOL, 1820, 290, 'Circuits', n=>{ n.capacity=6; n.setCount(0, C.circuit); });
    b.res(circuitLab, circuitBuf, c=>{ c.rate=2; c.label='circuit'; });

    // Capacity 4 on the queue means its intake stalls once it is holding 4
    // units — so the slow service rate (1 / 3 steps) propagates back and pins
    // the Circuits buffer at its cap of 6.
    const assemblyQ = b.node(NodeType.QUEUE, 1820, 480, 'Assembly Station', n=>{ n.processTime=3; n.capacity=4; });
    b.res(circuitBuf, assemblyQ, c=>{ c.rate=2; c.label='feed'; });

    // Packer: 1 assembled circuit -> 1 widget.
    const packer = b.node(NodeType.CONVERTER, 2000, 480, 'Widget Packer', n=>{ n.inputAmount=1; n.outputColor=C.widget; n.capacity=6; });
    b.res(assemblyQ, packer, c=>{ c.rate=1; });

    const widgetBuf = b.node(NodeType.POOL, 2000, 290, 'Widgets', n=>{ n.capacity=40; n.setCount(0, C.widget); });
    b.res(packer, widgetBuf, c=>{ c.rate=1; });

    // Frames buffer (output of the steel sub-line).
    const frameBuf = b.node(NodeType.POOL, 2000, 620, 'Frames', n=>{ n.capacity=24; });
    b.res(frameWelder, frameBuf, c=>{ c.rate=1; });

    // WAREHOUSE — a PULL pool that draws finished widgets + frames on demand
    // (flowMode=pull). It requests up to its incoming rates and takes what is
    // available, decoupling production from dispatch.
    const warehouse = b.node(NodeType.POOL, 2180, 460, 'Warehouse', n=>{ n.capacity=30; n.flowMode='pull'; n.pullPolicy='any'; });
    b.res(widgetBuf, warehouse, c=>{ c.rate=2; c.label='draw'; });
    b.res(frameBuf, warehouse, c=>{ c.rate=2; c.label='draw'; });

    // QC GATE splitter — probabilistic ~90% pass / ~10% scrap, fed from warehouse.
    const qcGate = b.node(NodeType.GATE, 2360, 170, 'QC Sorter', n=>{ n.gateMode='probabilistic'; });
    b.res(warehouse, qcGate, c=>{ c.rate=3; });
    const shipping = b.node(NodeType.DRAIN, 2520, 120, 'Shipping');
    const scrapBin = b.node(NodeType.DRAIN, 2520, 250, 'Scrap Bin');
    b.res(qcGate, shipping, c=>{ c.weight=9; c.label='pass'; });
    b.res(qcGate, scrapBin, c=>{ c.weight=1; c.label='scrap'; });

    // Registers: throughput (shipped tally) and a yield % efficiency metric.
    const throughput = b.node(NodeType.REGISTER, 2520, 380, 'throughput', n=>{ n.formula='shipped'; });
    b.st(shipping, throughput, c=>{ c.variableName='shipped'; c.label='shipped'; });
    b.st(scrapBin, throughput, c=>{ c.variableName='scrapped'; c.label='scrapped'; });
    const yieldPct = b.node(NodeType.REGISTER, 2520, 500, 'yieldPct', n=>{ n.formula='round(100 * shipped / max(1, shipped + scrapped))'; });
    // wipRegister — total work-in-progress held across the component buffers
    // (a one-step-lagged live readout of how clogged the mid-line is).
    const wip = b.node(NodeType.REGISTER, 2520, 620, 'wip', n=>{ n.formula='gearsHeld + wireHeld + circHeld'; });
    b.st(gearBuf, wip, c=>{ c.variableName='gearsHeld'; c.label='gears'; });
    b.st(wireBuf, wip, c=>{ c.variableName='wireHeld'; c.label='wire'; });
    b.st(circuitBuf, wip, c=>{ c.variableName='circHeld'; c.label='circ'; });

    // ───── Charts + notes ─────
    b.chart(120, 880, 640, 150, 'Back-pressure: Gears · Wire · Circuits(6) · Steel Beams', [gearBuf.id, wireBuf.id, circuitBuf.id, steelBuf.id]);
    b.chart(1640, 880, 640, 150, 'Output: Shipped · Scrap · Throughput · WIP', [shipping.id, scrapBin.id, throughput.id, wip.id]);
    b.note(800, 880, 400, 150,
      'BOTTLENECK: the Circuits buffer holds only 6 and is drained by the slow Assembly '+
      'Station (1 unit / 3 steps). Circuits pin at 6 while the Circuit Lab idles and '+
      'Gears / Wire swell to their caps — classic back-pressure. The Steel Beams buffer '+
      'is a milder second one (the Frame Welder is slow). '+
      'FIX: raise the Circuits cap and/or lower the station processTime.');
    b.note(1230, 880, 380, 150,
      'Iron & Copper mines are FINITE — they deplete over a long run. Coal fuels the '+
      'smelters via an activator (no fuel -> no smelting). The Warehouse PULLS finished '+
      'widgets & frames on demand; Spare Parts is a competing pull on gears. The QC '+
      'Sorter is a probabilistic ~90/10 pass/scrap gate; yieldPct tracks the pass rate.');
    this.renderer.render();
  }

  // 9 — BUSINESS CYCLE: a full circular-flow macroeconomy. Household income
  // splits (gate) into consumption / saving / taxes; firms pay wages back —
  // a closed money loop the engine conserves. Banks lend (accelerator),
  // government spends, and a central bank injects countercyclical stimulus
  // through a 6-step policy lag. The lag makes output overshoot, an inflation
  // tax cools it, and "animal spirits" Poisson shocks sustain a boom-bust cycle.
  _demoBusinessCycle() {
    const b = this._demo();
    b.d.params = {
      mpc: 0.60, savRate: 0.22, taxRate: 0.18,   // marginal propensities (sum ~1)
      wageShare: 0.66,            // labour share of firm revenue
      loanRatio: 0.28,            // base fraction of deposits lent each step
      accel: 1.6,                 // accelerator: extra lending when output is below target
      gTarget: 175,               // central-bank output target (potential GDP)
      govProp: 0.55,              // fraction of the treasury spent each step
      cbGain: 3.0, cbCap: 120,    // monetary stimulus = gain*gap, hard-capped
      inflThresh: 1020, inflCap: 120, inflGain: 0.6,  // inflation tax (overheating leak)
      exportBase: 12, importProp: 0.06,               // foreign sector
    };
    b.d.resourceTypes = [
      { name: 'Cash', color: '#43a047' }, { name: 'Deposits', color: '#1e88e5' },
      { name: 'Credit', color: '#8e24aa' }, { name: 'Tax', color: '#fb8c00' },
      { name: 'Capital', color: '#26a69a' }, { name: 'Bonds', color: '#ec407a' },
    ];

    // ── Groups ──
    b.group(120, 110, 980, 600, 'Real Economy — Circular Flow', '#43a047');
    b.group(120, 760, 1360, 320, 'Banking & Credit', '#1e88e5');
    b.group(1140, 110, 800, 600, 'Government & Central Bank', '#fb8c00');
    b.group(1520, 760, 420, 320, 'Foreign Sector', '#26a69a');

    // ── Registers (dashboard row) ──
    const gdp        = b.node(NodeType.REGISTER, 300, 200, 'gdp',       n => { n.formula = 'cons + inv + gov + nx'; });
    const moneySupply= b.node(NodeType.REGISTER, 540, 200, 'money',     n => { n.formula = 'hh + fm + dep + tre + wf + ln + gm + iv + stm + go + res'; });
    const employment = b.node(NodeType.REGISTER, 780, 200, 'employ',    n => { n.formula = 'min(100, round(gdp / 2.2))'; });
    const confidence = b.node(NodeType.REGISTER, 1020, 200, 'confidence', n => { n.formula = 'max(0, min(100, 50 - gap * 0.25))'; });
    const gdpGap     = b.node(NodeType.REGISTER, 1240, 200, 'gap',      n => { n.formula = 'gTarget - gdp'; });
    const inflation  = b.node(NodeType.REGISTER, 1480, 200, 'inflation',n => { n.formula = 'max(0, (money - inflThresh) * inflGain)'; });
    const policyRate = b.node(NodeType.REGISTER, 1720, 200, 'rate',     n => { n.formula = 'max(0, 1 + inflation * 0.05 - gap * 0.02)'; });

    // ── HOUSEHOLDS / FIRMS (circular flow) ──
    const households = b.node(NodeType.POOL, 280, 380, 'Households',   n => { n.setCount(240, '#43a047'); n.capacity = 1e7; });
    const incomeSplit= b.node(NodeType.GATE, 520, 380, 'Income Split', n => { n.gateMode = 'deterministic'; });
    const goodsMkt   = b.node(NodeType.POOL, 760, 380, 'Goods Market', n => { n.setCount(0, '#43a047');   n.capacity = 1e7; });
    const production = b.node(NodeType.CONVERTER, 760, 560, 'Production', n => { n.inputAmount = 1; n.outputColor = '#43a047'; });
    const firms      = b.node(NodeType.POOL, 980, 380, 'Firms',        n => { n.setCount(160, '#43a047'); n.capacity = 1e7; });
    const wagePool   = b.node(NodeType.POOL, 520, 560, 'Wage Fund',    n => { n.setCount(0, '#43a047');   n.capacity = 1e7; });
    const capital    = b.node(NodeType.POOL, 980, 560, 'Capital Stock',n => { n.setCount(50, '#26a69a');  n.capacity = 1e7; });
    const cpiDrain   = b.node(NodeType.DRAIN, 280, 560, 'Inflation Tax');

    // ── BANKING ──
    const deposits   = b.node(NodeType.POOL, 280, 880, 'Deposits',       n => { n.setCount(90, '#1e88e5'); n.capacity = 1e7; });
    const reserves   = b.node(NodeType.POOL, 520, 880, 'Bank Reserves',  n => { n.setCount(30, '#1e88e5'); n.capacity = 1e7; });
    const loans      = b.node(NodeType.POOL, 760, 880, 'Loans',          n => { n.setCount(0, '#8e24aa');  n.capacity = 1e7; });
    const invLag     = b.node(NodeType.DELAY, 1000, 880, 'Investment Lag', n => { n.delay = 3; });
    const investment = b.node(NodeType.POOL, 1240, 880, 'Investment',    n => { n.setCount(0, '#8e24aa');  n.capacity = 1e7; });

    // ── GOVERNMENT / CENTRAL BANK ──
    const treasury   = b.node(NodeType.POOL, 1240, 380, 'Treasury',      n => { n.setCount(60, '#fb8c00'); n.capacity = 1e7; });
    const govSpend   = b.node(NodeType.POOL, 1480, 380, 'Govt Purchases',n => { n.setCount(0, '#fb8c00');  n.capacity = 1e7; });
    const bonds      = b.node(NodeType.POOL, 1720, 380, 'Bond Market',   n => { n.setCount(0, '#ec407a');  n.capacity = 1e7; });
    const centralBank= b.node(NodeType.SOURCE, 1240, 560, 'Central Bank',n => { n.resourceColor = '#43a047'; });
    const policyLag  = b.node(NodeType.DELAY, 1480, 560, 'Policy Lag',   n => { n.delay = 6; });
    const stimulus   = b.node(NodeType.POOL, 1720, 560, 'Stimulus',      n => { n.setCount(0, '#43a047');  n.capacity = 1e7; });

    // ── FOREIGN SECTOR ──
    const rowSrc     = b.node(NodeType.SOURCE, 1600, 840, 'Rest of World', n => { n.resourceColor = '#43a047'; });
    const exportsP   = b.node(NodeType.POOL, 1600, 980, 'Exports',  n => { n.setCount(0, '#43a047'); n.capacity = 1e7; });
    const importsD   = b.node(NodeType.DRAIN, 1820, 980, 'Imports');
    const nx         = b.node(NodeType.REGISTER, 1820, 840, 'nx', n => { n.formula = 'exportBase - round(importProp * hh)'; });
    const spirits    = b.node(NodeType.SOURCE, 1340, 720, 'Animal Spirits', n => { n.resourceColor = '#8e24aa'; });

    // ── CIRCULAR FLOW: income -> C/S/T; production -> revenue -> wages -> income ──
    b.res(households, incomeSplit, c => { c.rateMode = RateMode.FORMULA; c.formula = '(mpc + savRate + taxRate) * hh'; c.label = 'income'; });
    b.res(incomeSplit, goodsMkt,  c => { c.weight = 60; c.label = 'consume (C)'; });
    b.res(incomeSplit, deposits,  c => { c.weight = 22; c.label = 'save (S)'; });
    b.res(incomeSplit, treasury,  c => { c.weight = 18; c.label = 'tax (T)'; });
    b.res(goodsMkt, production,    c => { c.rate = 1e7; c.label = 'demand'; });
    b.res(production, firms,       c => { c.rate = 1;   c.label = 'output'; });   // 1:1 conversion (conserves money)
    b.res(firms, wagePool,        c => { c.rateMode = RateMode.FORMULA; c.formula = 'wageShare * fm'; c.label = 'wages'; });
    b.res(wagePool, households,    c => { c.rate = 1e7; c.label = 'pay'; });

    // ── BANKING: deposits -> loans (accelerator) -> investment lag -> firms; capital builds & depreciates ──
    b.res(deposits, reserves, c => { c.rateMode = RateMode.FORMULA; c.formula = '0.10 * dep'; c.label = 'reserve req'; });
    b.res(reserves, deposits, c => { c.rate = 4; c.label = 'reflow'; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'gap'; c.condOperator = '<'; c.condValue = 0; });
    b.res(deposits, loans,    c => { c.rateMode = RateMode.FORMULA; c.formula = 'loanRatio * dep + accel * max(0, gap)'; c.label = 'lend'; });
    b.res(loans, invLag,      c => { c.rate = 1e7; c.label = 'fund'; });
    b.res(invLag, investment, c => { c.rate = 1e7; c.label = 'release'; });
    b.res(investment, firms,  c => { c.rateMode = RateMode.FORMULA; c.formula = '0.7 * iv'; c.label = 'invest (I)'; });
    b.res(investment, capital,c => { c.rate = 1e7; c.label = 'capex'; });
    b.st(deposits, deposits,  c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = 0.02; c.label = 'interest'; });
    b.st(capital, capital,    c => { c.modifier = true; c.modMode = 'rate'; c.modFactor = -0.06; c.label = 'depreciation'; });

    // ── GOVERNMENT: spend purchases; deficit-finance via bonds when gap>0 ──
    b.res(treasury, govSpend, c => { c.rateMode = RateMode.FORMULA; c.formula = 'govProp * tre'; c.label = 'budget'; });
    b.res(govSpend, firms,    c => { c.rate = 1e7; c.label = 'spend (G)'; });
    b.res(reserves, bonds,    c => { c.rateMode = RateMode.FORMULA; c.formula = 'gap > 0 ? round(gap * 0.06) : 0'; c.label = 'bond sale'; });
    b.res(bonds, treasury,    c => { c.rate = 1e7; c.label = 'finance'; });

    // ── CENTRAL BANK: countercyclical money creation, capped, through a policy lag (overshoot -> cycle) ──
    b.res(centralBank, policyLag, c => { c.rateMode = RateMode.FORMULA; c.formula = 'min(cbCap, max(0, gap * cbGain))'; c.label = 'QE'; });
    b.res(policyLag, stimulus,    c => { c.rate = 1e7; c.label = 'arrive'; });
    b.res(stimulus, households,   c => { c.rate = 1e7; c.label = 'transfer'; });
    b.st(gdpGap, centralBank, c => { c.activator = true; c.actOperator = '>'; c.actValue = 0; });   // policy fires only while below target

    // ── ANIMAL SPIRITS: random (Poisson) investment-confidence bursts, likelier in slumps — sustains the cycle ──
    b.res(spirits, loans, c => { c.rateMode = RateMode.DISTRIBUTION; c.distType = 'poisson'; c.distParam1 = 6; c.label = 'optimism';
      c.chance = 35; c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'confidence'; c.condOperator = '<'; c.condValue = 45; });

    // ── INFLATION TAX: drains household cash when the money supply overheats ──
    b.res(households, cpiDrain, c => { c.rateMode = RateMode.FORMULA; c.formula = 'min(inflCap, inflation)'; c.label = 'erosion';
      c.condEnabled = true; c.condRefMode = 'variable'; c.condVariable = 'inflation'; c.condOperator = '>'; c.condValue = 0; });

    // ── FOREIGN SECTOR: exports add demand, imports leak ──
    b.res(rowSrc, exportsP, c => { c.rateMode = RateMode.FORMULA; c.formula = 'max(0, exportBase)'; c.label = 'X'; });
    b.res(exportsP, firms,  c => { c.rate = 1e7; c.label = 'sell abroad'; });
    b.res(households, importsD, c => { c.rateMode = RateMode.FORMULA; c.formula = 'round(importProp * hh)'; c.label = 'M'; });

    // ── STATE PUBLICATIONS (for registers / formula rates) ──
    b.st(households, gdp, c => { c.variableName = 'hh'; });
    b.st(firms, moneySupply, c => { c.variableName = 'fm'; });
    b.st(deposits, gdp, c => { c.variableName = 'dep'; });
    b.st(reserves, moneySupply, c => { c.variableName = 'res'; });
    b.st(treasury, gdp, c => { c.variableName = 'tre'; });
    b.st(wagePool, moneySupply, c => { c.variableName = 'wf'; });
    b.st(loans, moneySupply, c => { c.variableName = 'ln'; });
    b.st(goodsMkt, gdp, c => { c.variableName = 'cons'; });
    b.st(goodsMkt, moneySupply, c => { c.variableName = 'gm'; });
    b.st(investment, gdp, c => { c.variableName = 'inv'; });
    b.st(investment, moneySupply, c => { c.variableName = 'iv'; });
    b.st(govSpend, gdp, c => { c.variableName = 'gov'; });
    b.st(govSpend, moneySupply, c => { c.variableName = 'go'; });
    b.st(stimulus, moneySupply, c => { c.variableName = 'stm'; });
    b.st(nx, gdp, c => { c.variableName = 'nx'; });

    // ── CHARTS & NOTES ──
    b.chart(1140, 790, 360, 270, 'GDP · Money · Employment', [gdp.id, moneySupply.id, employment.id]);
    b.note(140, 130, 300, 150,
      'CIRCULAR FLOW. Household income splits at the gate into Consumption (C -> firms), ' +
      'Saving (S -> banks) and Taxes (T -> treasury). Firms pay Wages back to households — ' +
      'a closed loop that conserves money exactly.');
    b.note(1560, 130, 350, 150,
      'BUSINESS CYCLE. When GDP dips below target the Central Bank injects money (QE) ' +
      'through a 6-step Policy Lag, while banks lend more (accelerator). The lag makes ' +
      'output OVERSHOOT, then an inflation tax cools it — a self-sustaining cycle.');
    this.renderer.render();
  }
  // ── Controls ──────────────────────────────────────────────────────────────

  _bindControls() {
    document.getElementById('btn-step').addEventListener('click', () => this.engine.doStep());

    const runBtn = document.getElementById('btn-run');
    runBtn.addEventListener('click', () => {
      if (!this.engine.running) document.getElementById('sim-status').textContent = '';
      this.engine.run();
      this._syncRunButton();
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
      this.engine.reset();
      this._syncRunButton();
      document.getElementById('sim-status').textContent = '';
      this.renderer.balls.clear();
      this._clearSparklines();
      this.renderer.render();
      if (this._timelineVisible) this.timeline.update();
    });

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

    document.getElementById('btn-new').addEventListener('click', () => {
      if (!confirm('Start a new diagram? Unsaved work will be lost.')) return;
      this._clearAll();
      this.renderer.render();
      this.renderer.resetView();
      this._resetHistory();
    });

    document.getElementById('btn-snap').addEventListener('click', () => {
      const enabled = !this.editor._snapEnabled;
      this.editor.setSnap(enabled);
      const b = document.getElementById('btn-snap');
      b.classList.toggle('active', enabled);
      b.setAttribute('aria-pressed', String(enabled));
    });

    const autoBtn = document.getElementById('btn-autoselect');
    // Sync button to editor's initial state (autoRevert starts true)
    autoBtn.classList.toggle('active', this.editor.autoRevert);
    autoBtn.setAttribute('aria-pressed', String(this.editor.autoRevert));
    autoBtn.addEventListener('click', () => {
      this.editor.autoRevert = !this.editor.autoRevert;
      autoBtn.classList.toggle('active', this.editor.autoRevert);
      autoBtn.setAttribute('aria-pressed', String(this.editor.autoRevert));
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

    // Timeline chart toggle
    const tlBtn = document.getElementById('btn-timeline');
    const toggleTimeline = (show) => {
      this._timelineVisible = show;
      document.getElementById('timeline').classList.toggle('hidden', !show);
      tlBtn.classList.toggle('active', show);
      tlBtn.setAttribute('aria-checked', String(show));
      // Surface the timeline state on the (collapsed) Analysis menu button too.
      document.getElementById('btn-analysis-menu')?.classList.toggle('active', show);
      if (show) this.timeline.update();
    };
    tlBtn.addEventListener('click', () => toggleTimeline(!this._timelineVisible));
    document.getElementById('tl-close').addEventListener('click', () => toggleTimeline(false));
    window.addEventListener('resize', () => { if (this._timelineVisible) this.timeline.update(); });

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
    this.renderer.onViewChange = (scale) => { zoomLabel.textContent = `${Math.round(scale * 100)}%`; };
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
      } else {
        // Tool shortcuts: S=select, D=delete, R=resource-connect, T=state-connect
        const toolKeys = { s: 'select', d: 'delete', r: 'connect-resource', t: 'connect-state' };
        if (toolKeys[k]) { e.preventDefault(); this._activateTool(toolKeys[k]); }
        else if (e.key === '?') { e.preventDefault(); this._showModal('help-overlay'); }
      }
    });

    // Monte Carlo batch runs
    document.getElementById('btn-batch').addEventListener('click', () => this._openMonteCarlo());
    document.getElementById('mc-close').addEventListener('click', () => this._hideModal('mc-overlay'));
    document.getElementById('mc-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'mc-overlay') this._hideModal('mc-overlay');
    });
    this._modalize('mc-overlay');
    document.getElementById('mc-run').addEventListener('click', () => this._runMonteCarlo());
    document.getElementById('mc-sweep-run').addEventListener('click', () => this._runSweep());

    // Help / shortcuts overlay (also on the "?" key)
    document.getElementById('btn-help').addEventListener('click', () => this._showModal('help-overlay'));
    document.getElementById('help-close').addEventListener('click', () => this._hideModal('help-overlay'));
    document.getElementById('help-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'help-overlay') this._hideModal('help-overlay');
    });
    this._modalize('help-overlay');
  }

  // ── Monte Carlo ─────────────────────────────────────────────────────────────

  _openMonteCarlo() {
    this.engine.stop();
    this._syncRunButton();
    document.getElementById('mc-results').innerHTML =
      '<p class="mc-empty">Choose runs &amp; steps, then press Run.</p>';
    // Sweep needs a named parameter to vary — offer whatever the diagram defines.
    const sel = document.getElementById('mc-sweep-param');
    sel.innerHTML = '';
    const names = Object.keys(this.diagram.params || {});
    if (!names.length) {
      sel.appendChild(new Option('— no parameters —', ''));
      sel.disabled = true;
      document.getElementById('mc-sweep-run').disabled = true;
      sel.title = 'Define parameters in the Params rail panel to sweep them';
    } else {
      sel.disabled = false;
      document.getElementById('mc-sweep-run').disabled = false;
      for (const n of names) sel.appendChild(new Option(n, n));
      // Seed the range around the parameter's current value.
      const cur = this.diagram.params[names[0]];
      document.getElementById('mc-sweep-from').value = Math.round(cur * 0.5 * 100) / 100;
      document.getElementById('mc-sweep-to').value = Math.round(cur * 1.5 * 100) / 100;
    }
    this._showModal('mc-overlay');
  }

  _mcSeed() {
    return document.getElementById('mc-seed').value.trim();
  }

  async _runMonteCarlo() {
    const runs = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-runs').value) || 100));
    const steps = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-steps').value) || 200));
    const out = document.getElementById('mc-results');
    if (this._mcBusy) return;
    this._mcBusy = true;
    out.innerHTML = '<p class="mc-empty">Running…</p>';

    try {
      const t0 = performance.now();
      const res = await this.engine.runMonteCarloAsync(runs, steps, {
        seed: this._mcSeed() || null,
        onProgress: (done, total) => {
          out.innerHTML = `<p class="mc-empty">Running… ${done} / ${total}</p>`;
        },
      });
      const ms = Math.round(performance.now() - t0);
      this._mcLast = res;

      const mcName = this.diagram.meta.name || 'Untitled';
      let html = `<p class="mc-summary">${res.runs} runs × ${res.maxSteps} steps`
        + ` — <b>${this._esc(mcName)}</b>`
        + (res.seed ? ` — seed <b>${this._esc(res.seed)}</b>` : '')
        + ` <span style="color:var(--text-dim)">(${ms} ms)</span>`;
      if (res.endStep) {
        html += `<br>Goal reached in <b>${Math.round(res.endedRate * 100)}%</b> of runs`
          + ` — end step mean <b>${res.endStep.mean}</b> (min ${res.endStep.min}, max ${res.endStep.max}).`;
      }
      html += '</p>';

      html += '<table><thead><tr><th>Node</th><th>distribution</th><th>mean</th><th>min</th>'
        + '<th>p10</th><th>p50</th><th>p90</th><th>max</th></tr></thead><tbody>';
      for (const n of res.nodes) {
        // Mini histogram of final values across all runs: where did this node
        // actually land, not just its summary stats.
        const { counts } = SimEngine.histogram(n.samples, 14);
        const peak = Math.max(...counts, 1);
        const bars = counts.map(c => {
          const h = c === 0 ? 0 : Math.max(8, Math.round((c / peak) * 100));
          return `<span class="mc-bar" style="height:${h}%" title="${c} runs"></span>`;
        }).join('');
        const hist = `<div class="mc-hist" role="img" aria-label="distribution of final values">${bars}</div>`;
        html += `<tr><td>${this._esc(n.label || n.type)}</td>`
          + `<td class="mc-hist-cell">${hist}</td>`
          + `<td>${n.mean}</td><td>${n.min}</td><td>${n.p10}</td>`
          + `<td>${n.p50}</td><td>${n.p90}</td><td>${n.max}</td></tr>`;
      }
      html += '</tbody></table>';
      html += '<p class="mc-actions"><button class="btn" id="mc-export-raw">'
        + '<i class="fa-solid fa-download" aria-hidden="true"></i> Export raw results (CSV)</button></p>';
      out.innerHTML = html;
      document.getElementById('mc-export-raw')
        .addEventListener('click', () => this._exportMCRaw());
    } finally {
      this._mcBusy = false;
    }
  }

  // One row per run, one column per tracked node's final value — ready for
  // R / pandas / a spreadsheet. The on-screen stats are derived from this.
  _exportMCRaw() {
    const res = this._mcLast;
    if (!res) return;
    const header = ['run', ...res.nodes.map(n => this._csvCell(n.label || n.type))];
    const lines = [header.join(',')];
    for (let r = 0; r < res.runs; r++) {
      lines.push([r + 1, ...res.nodes.map(n => n.samples[r] ?? '')].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: this._exportFilename('mc.csv'),
    });
    a.click();
  }

  // Parameter sweep: run the batch once per value of one diagram parameter
  // (on clones — the live diagram is untouched) and tabulate per-node means
  // so the parameter's effect is visible at a glance.
  async _runSweep() {
    const name = document.getElementById('mc-sweep-param').value;
    if (!name) return;
    const runs = Math.max(1, Math.min(1000, parseInt(document.getElementById('mc-runs').value) || 100));
    const steps = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-steps').value) || 200));
    const from = parseFloat(document.getElementById('mc-sweep-from').value) || 0;
    const to = parseFloat(document.getElementById('mc-sweep-to').value) || 0;
    const count = Math.max(2, Math.min(11, parseInt(document.getElementById('mc-sweep-count').value) || 5));
    const out = document.getElementById('mc-results');
    if (this._mcBusy) return;
    this._mcBusy = true;
    out.innerHTML = '<p class="mc-empty">Sweeping…</p>';

    try {
      const values = Array.from({ length: count },
        (_, i) => Math.round((from + (to - from) * (i / (count - 1))) * 10000) / 10000);
      const seed = this._mcSeed() || null;
      const base = this.diagram.toJSON();
      const results = [];
      for (let i = 0; i < values.length; i++) {
        const json = typeof structuredClone === 'function'
          ? structuredClone(base) : JSON.parse(JSON.stringify(base));
        json.params = { ...(json.params || {}), [name]: values[i] };
        const res = await this.engine.runMonteCarloAsync(runs, steps, {
          baseJSON: json,
          // Same sub-seed per value: differences between columns come from the
          // parameter, not from a fresh random stream.
          seed,
          onProgress: (done, total) => {
            out.innerHTML = `<p class="mc-empty">Sweeping ${name} = ${values[i]}`
              + ` (${i + 1}/${values.length}) — ${done}/${total}</p>`;
          },
        });
        results.push(res);
      }

      let html = `<p class="mc-summary">Sweep <b>${this._esc(name)}</b> ∈ [${values[0]} … ${values[values.length - 1]}]`
        + ` — ${runs} runs × ${steps} steps per value`
        + (seed ? ` — seed <b>${this._esc(seed)}</b>` : '') + '<br>'
        + '<span style="color:var(--text-dim)">Cells show the mean final value across runs.</span></p>';
      html += '<table><thead><tr><th>Node</th>'
        + values.map(v => `<th>${name}=${v}</th>`).join('') + '</tr></thead><tbody>';
      for (let n = 0; n < results[0].nodes.length; n++) {
        html += `<tr><td>${this._esc(results[0].nodes[n].label || results[0].nodes[n].type)}</td>`
          + results.map(r => `<td>${r.nodes[n].mean}</td>`).join('') + '</tr>';
      }
      if (results.some(r => r.endStep)) {
        html += '<tr><td>Goal reached</td>'
          + results.map(r => `<td>${Math.round(r.endedRate * 100)}%</td>`).join('') + '</tr>';
      }
      html += '</tbody></table>';
      out.innerHTML = html;
    } finally {
      this._mcBusy = false;
    }
  }

  _esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ── Clipboard (copy / paste / duplicate of the node selection) ──────────────

  _copy() {
    const ids = new Set(this.editor.selection);
    if (!ids.size) return;
    const nodes = [...ids].map(id => this.diagram.nodes.get(id)).filter(Boolean).map(n => n.toJSON());
    const conns = [...this.diagram.connections.values()]
      .filter(c => ids.has(c.sourceId) && ids.has(c.targetId)).map(c => c.toJSON());
    this._clipboard = { nodes, conns };
  }

  _paste() {
    const cb = this._clipboard;
    if (!cb || !cb.nodes.length) return;
    const idMap = new Map();
    const newIds = [];
    for (const nd of cb.nodes) {
      const node = new MNode(nd.type, nd.x + 24, nd.y + 24);
      node.loadJSON({ ...nd, id: node.id, x: nd.x + 24, y: nd.y + 24 });
      this.diagram.addNode(node);
      idMap.set(nd.id, node.id);
      newIds.push(node.id);
    }
    for (const cd of cb.conns) {
      const sId = idMap.get(cd.sourceId), tId = idMap.get(cd.targetId);
      const conn = new MConnection(sId, tId, cd.type);
      conn.loadJSON({ ...cd, id: conn.id, sourceId: sId, targetId: tId });
      this.diagram.addConnection(conn);
    }
    // Shift the clipboard so a repeated paste lands further out.
    for (const nd of cb.nodes) { nd.x += 24; nd.y += 24; }
    this.renderer.render();
    this.editor._setSelection(newIds, newIds.length === 1 ? newIds[0] : null, 'node');
    this._commit();
  }

  _duplicate() { this._copy(); this._paste(); }

  // ── Selection ─────────────────────────────────────────────────────────────

  _onSelect(id, type, count = 1) {
    this._selectedId = id;
    this._selectedType = type;
    this._selCount = count;
    // Selecting something hands the panel back to the selection view (clicking
    // empty canvas keeps whatever diagram feature is open).
    if (id && this._activeFeature) { this._activeFeature = null; this._syncRailButtons(); }
    this._renderProps();
  }

  // ── Properties panel ──────────────────────────────────────────────────────

  _renderProps() {
    const panel = document.getElementById('props-content');
    panel.innerHTML = '';
    this._clearSparklines();

    // A diagram-rail feature takes over the panel when active, replacing the
    // selection view until it's toggled off (or a node/connection is selected).
    if (this._activeFeature) {
      const meta = this._featureMeta()[this._activeFeature];
      if (meta) {
        this._title(panel, meta.title);
        meta.render(panel);
        return;
      }
    }

    if (this._selCount > 1) {
      panel.innerHTML = `<p class="props-empty"><b>${this._selCount} nodes selected.</b><br>`
        + 'Drag to move them together. Ctrl+C / Ctrl+V to copy, Ctrl+D to duplicate, Del to delete.</p>';
      return;
    }

    if (!this._selectedId) {
      this._diagramProps(panel);
      return;
    }

    if (this._selectedType === 'node') {
      const node = this.diagram.nodes.get(this._selectedId);
      if (node) this._nodeProps(panel, node);
    } else if (this._selectedType === 'conn') {
      const conn = this.diagram.connections.get(this._selectedId);
      if (conn) this._connProps(panel, conn);
    } else if (this._selectedType === 'group') {
      const group = this.diagram.groups.get(this._selectedId);
      if (group) this._groupProps(panel, group);
    } else if (this._selectedType === 'note') {
      const note = this.diagram.notes.get(this._selectedId);
      if (note) this._noteProps(panel, note);
    } else if (this._selectedType === 'chart') {
      const chart = this.diagram.charts.get(this._selectedId);
      if (chart) this._chartProps(panel, chart);
    }
  }

  // ── Simulation meta (default panel + presentation) ─────────────────────────

  // Apply the simulation's presentation meta to the live UI: canvas
  // background, accent color scheme, display font (lazy-loaded from Google
  // Fonts), and the document title.
  _applyMeta() {
    const meta = this.diagram.meta || (this.diagram.meta = Diagram.defaultMeta());
    this.renderer.setBackground(meta.bgColor);

    const rootStyle = document.documentElement.style;
    const scheme = COLOR_SCHEMES[meta.scheme];
    if (scheme && meta.scheme !== 'default') {
      rootStyle.setProperty('--accent', scheme.accent);
      rootStyle.setProperty('--accent2', scheme.accent2);
    } else {
      rootStyle.removeProperty('--accent');
      rootStyle.removeProperty('--accent2');
    }

    // Display font: inject (or retarget) a single Google Fonts stylesheet
    // link, then point the --font stack at the family. '' restores the
    // built-in stack. If the fetch fails (offline), the fallbacks apply.
    let link = document.getElementById('gfont-link');
    if (meta.font) {
      const href = 'https://fonts.googleapis.com/css2?family='
        + encodeURIComponent(meta.font).replace(/%20/g, '+')
        + ':wght@400;600;700&display=swap';
      if (!link) {
        link = document.createElement('link');
        link.id = 'gfont-link';
        link.rel = 'stylesheet';
        document.head.appendChild(link);
      }
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
      rootStyle.setProperty('--font', `'${meta.font}', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`);
    } else {
      if (link) link.remove();
      rootStyle.removeProperty('--font');
    }

    document.title = meta.name ? `${meta.name} — Simulations` : 'Simulations — Economy Designer';
  }

  // Rasterize the live SVG canvas into a small data-URL thumbnail. Async:
  // calls cb('') if the browser can't rasterize (e.g. tainted canvas).
  _captureThumbnail(cb) {
    try {
      const svg = this.renderer.svg;
      const w = svg.clientWidth || 800, h = svg.clientHeight || 600;
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', w);
      clone.setAttribute('height', h);
      const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const tw = 320, th = Math.max(1, Math.round(tw * h / w));
        const c = document.createElement('canvas');
        c.width = tw; c.height = th;
        c.getContext('2d').drawImage(img, 0, 0, tw, th);
        URL.revokeObjectURL(url);
        let dataUrl = '';
        try { dataUrl = c.toDataURL('image/jpeg', 0.78); } catch {}
        cb(dataUrl);
      };
      img.onerror = () => { URL.revokeObjectURL(url); cb(''); };
      img.src = url;
    } catch { cb(''); }
  }

  // Default panel (nothing selected): simulation-wide settings — name and
  // description, captured thumbnail, appearance (color scheme / canvas
  // background / display font), and file metadata. Per-element properties
  // take the panel over on selection; mechanics live in the right-hand rail.
  _diagramProps(panel) {
    const meta = this.diagram.meta;
    this._title(panel, 'Simulation');

    const field = (labelText) => {
      const l = document.createElement('div');
      l.className = 'field-label';
      l.textContent = labelText;
      panel.appendChild(l);
    };

    // ── Identity ────────────────────────────────────────────────────────────
    field('Name');
    const name = document.createElement('input');
    name.type = 'text'; name.className = 'wide-input';
    name.value = meta.name; name.placeholder = 'Untitled simulation';
    name.addEventListener('change', () => {
      meta.name = name.value.trim();
      this._applyMeta(); this._commit();
    });
    panel.appendChild(name);

    field('Description');
    const desc = document.createElement('textarea');
    desc.className = 'wide-input sim-desc';
    desc.rows = 3; desc.value = meta.description;
    desc.placeholder = 'What does this simulation model?';
    desc.addEventListener('change', () => { meta.description = desc.value.trim(); this._commit(); });
    panel.appendChild(desc);

    // ── Thumbnail ───────────────────────────────────────────────────────────
    this._sep(panel);
    field('Thumbnail');
    const thumbBox = document.createElement('div');
    thumbBox.className = 'sim-thumb';
    if (meta.thumbnail) {
      const img = document.createElement('img');
      img.src = meta.thumbnail; img.alt = 'Diagram thumbnail';
      thumbBox.appendChild(img);
    } else {
      thumbBox.classList.add('empty');
      thumbBox.textContent = 'No thumbnail yet';
    }
    panel.appendChild(thumbBox);
    const thumbRow = document.createElement('div');
    thumbRow.className = 'sim-thumb-actions';
    const capBtn = document.createElement('button');
    capBtn.className = 'btn';
    capBtn.appendChild(this._faIcon('camera'));
    capBtn.appendChild(document.createTextNode(' Capture from canvas'));
    capBtn.addEventListener('click', () => {
      capBtn.disabled = true;
      this._captureThumbnail(url => {
        capBtn.disabled = false;
        if (!url) { alert('Could not capture the canvas in this browser.'); return; }
        meta.thumbnail = url;
        this._commit(); this._renderProps();
      });
    });
    thumbRow.appendChild(capBtn);
    if (meta.thumbnail) {
      const clr = document.createElement('button');
      clr.className = 'btn'; clr.textContent = 'Remove';
      clr.addEventListener('click', () => { meta.thumbnail = ''; this._commit(); this._renderProps(); });
      thumbRow.appendChild(clr);
    }
    panel.appendChild(thumbRow);

    // ── Appearance ──────────────────────────────────────────────────────────
    this._sep(panel);
    field('Color scheme');
    const schemeSel = document.createElement('select');
    schemeSel.className = 'wide-input';
    for (const [key, s] of Object.entries(COLOR_SCHEMES)) {
      const o = document.createElement('option');
      o.value = key; o.textContent = s.label;
      if ((meta.scheme || 'default') === key) o.selected = true;
      schemeSel.appendChild(o);
    }
    schemeSel.addEventListener('change', () => {
      meta.scheme = schemeSel.value;
      this._applyMeta(); this._commit();
    });
    panel.appendChild(schemeSel);

    field('Canvas background');
    const bgRow = document.createElement('div');
    bgRow.className = 'sim-bg-row';
    const bg = document.createElement('input');
    bg.type = 'color'; bg.value = meta.bgColor || '#0f1117';
    bg.addEventListener('input', () => {
      meta.bgColor = bg.value;
      this.renderer.setBackground(meta.bgColor);
    });
    bg.addEventListener('change', () => this._commit());
    const bgReset = document.createElement('button');
    bgReset.className = 'btn'; bgReset.textContent = 'Reset';
    bgReset.addEventListener('click', () => {
      meta.bgColor = '';
      bg.value = '#0f1117';
      this.renderer.setBackground('');
      this._commit();
    });
    bgRow.appendChild(bg); bgRow.appendChild(bgReset);
    panel.appendChild(bgRow);

    field('Display font');
    const fontSel = document.createElement('select');
    fontSel.className = 'wide-input';
    const defOpt = document.createElement('option');
    defOpt.value = ''; defOpt.textContent = 'Inter (default)';
    fontSel.appendChild(defOpt);
    for (const f of GOOGLE_FONTS) {
      const o = document.createElement('option');
      o.value = f; o.textContent = f;
      if (meta.font === f) o.selected = true;
      fontSel.appendChild(o);
    }
    fontSel.addEventListener('change', () => {
      meta.font = fontSel.value;
      this._applyMeta(); this._commit();
    });
    panel.appendChild(fontSel);

    // ── File metadata ───────────────────────────────────────────────────────
    this._sep(panel);
    field('File');
    const metaList = document.createElement('div');
    metaList.className = 'sim-meta';
    const fmtDate = ts => ts ? new Date(ts).toLocaleString() : '—';
    const sizeKB = (JSON.stringify(this.diagram.toJSON()).length / 1024).toFixed(1);
    const rows = [
      ['Created', fmtDate(meta.created)],
      ['Modified', fmtDate(meta.modified)],
      ['Nodes', String(this.diagram.nodes.size)],
      ['Connections', String(this.diagram.connections.size)],
      ['Size', `${sizeKB} KB`],
    ];
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.className = 'sim-meta-row';
      r.innerHTML = `<span>${k}</span><b></b>`;
      r.querySelector('b').textContent = v;
      metaList.appendChild(r);
    }
    panel.appendChild(metaList);

    this._sep(panel);
    const p = document.createElement('p');
    p.className = 'props-empty';
    p.innerHTML = 'Mechanics — <b>time mode</b>, <b>parameters</b>, <b>variables</b>, '
      + '<b>resource types</b>, the <b>artificial player</b>, and a live '
      + '<b>variable watch</b> — are on the rail to the right <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
    panel.appendChild(p);
  }

  // ── Diagram rail + settings panel ────────────────────────────────────────
  // Metadata for each rail feature: a title and the editor that renders it into
  // a container. Editors are reused as-is; the rail supplies the title.
  _featureMeta() {
    return {
      time:      { title: 'Time Mode',        render: c => this._timeModeEditor(c) },
      params:    { title: 'Parameters',       render: c => this._paramsEditor(c) },
      vars:      { title: 'Custom Variables', render: c => this._customVarsEditor(c) },
      resources: { title: 'Resource Types',   render: c => this._resourceTypesEditor(c) },
      player:    { title: 'Artificial Player', render: c => this._diagramAI(c) },
      branches:  { title: 'Scenario Branches', render: c => this._branchesPanel(c) },
      monitor:   { title: 'Live Variables',   render: c => this._liveVarsReadout(c) },
    };
  }

  _initDiagramRail() {
    const rail = document.getElementById('diagram-rail');
    if (rail) {
      rail.querySelectorAll('.rail-btn').forEach(btn => {
        btn.addEventListener('click', () => this._toggleFeature(btn.dataset.feature));
      });
    }
    // Seed toggle-state semantics for assistive tech.
    this._syncRailButtons();
    this._syncToolButtons(this.editor.tool);
  }

  // Toggle a diagram feature into the properties panel (clicking the active
  // one again returns to the selection / hint view).
  _toggleFeature(name) {
    this._activeFeature = (this._activeFeature === name) ? null : name;
    this._syncRailButtons();
    this._renderProps();
  }

  _closeFeature() {
    this._activeFeature = null;
    this._syncRailButtons();
    this._renderProps();
  }

  _syncRailButtons() {
    document.querySelectorAll('#diagram-rail .rail-btn').forEach(b => {
      const on = b.dataset.feature === this._activeFeature;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  // Time mode (synchronous turn-based vs asynchronous per-node rhythm).
  _timeModeEditor(panel) {
    const tm = this.diagram.timeMode || 'sync';
    this._select2(panel, 'Time mode', ['sync', 'async'], tm, v => {
      this.diagram.timeMode = v; this._renderProps(); this._commit();
    });
    this._info(panel, tm === 'async'
      ? 'Asynchronous: each automatic node fires on its own "Fire every" rhythm (set per node).'
      : 'Synchronous (turn-based): every automatic node fires once per step.');
  }

  // ── Scenario branching panel ──────────────────────────────────────────────

  _branchesPanel(panel) {
    this._info(panel, 'Checkpoint the simulation mid-run, fork back to it with tweaks, and '
      + 'compare timelines as dashed ghost traces in the timeline chart. Kept for this '
      + 'session only — not saved with the diagram.');

    const cpBtn = document.createElement('button');
    cpBtn.className = 'btn branch-action-btn';
    cpBtn.append(this._faIcon('flag'), ` Checkpoint now — step ${this.engine.step}`);
    cpBtn.addEventListener('click', () => this._addCheckpoint());
    panel.appendChild(cpBtn);

    // Checkpoints: fork restores the full sim state (the current run is kept
    // as a ghost branch first, so nothing is lost).
    const cpSec = document.createElement('div');
    cpSec.className = 'props-sec'; cpSec.textContent = 'Checkpoints';
    panel.appendChild(cpSec);
    if (!this._checkpoints.length) {
      const p = document.createElement('p');
      p.className = 'props-info';
      p.textContent = 'None yet. Run the simulation, pause where it gets interesting, and checkpoint.';
      panel.appendChild(p);
    }
    for (const cp of this._checkpoints) {
      const row = document.createElement('div');
      row.className = 'branch-row';

      const name = document.createElement('input');
      name.type = 'text'; name.value = cp.name; name.className = 'branch-name';
      name.setAttribute('aria-label', 'Checkpoint name');
      name.addEventListener('blur', () => { cp.name = name.value.trim() || cp.name; name.value = cp.name; });

      const step = document.createElement('span');
      step.className = 'branch-step'; step.textContent = `step ${cp.step}`;

      const fork = document.createElement('button');
      fork.className = 'btn branch-mini-btn';
      fork.title = 'Fork: return the simulation to this checkpoint (current run is kept as a branch)';
      fork.setAttribute('aria-label', `Fork from ${cp.name}`);
      fork.appendChild(this._faIcon('code-branch'));
      fork.addEventListener('click', () => this._forkFrom(cp));

      const del = document.createElement('button');
      del.className = 'btn branch-mini-btn';
      del.title = 'Delete checkpoint';
      del.setAttribute('aria-label', `Delete checkpoint ${cp.name}`);
      del.appendChild(this._faIcon('xmark'));
      del.addEventListener('click', () => {
        this._checkpoints = this._checkpoints.filter(c => c !== cp);
        this._renderProps();
      });

      row.append(name, step, fork, del);
      panel.appendChild(row);
    }

    // Branches: saved timelines overlaid on the timeline chart.
    const brSec = document.createElement('div');
    brSec.className = 'props-sec'; brSec.textContent = 'Branches (ghost traces)';
    panel.appendChild(brSec);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn branch-action-btn';
    saveBtn.append(this._faIcon('camera'), ' Save current run as branch');
    saveBtn.addEventListener('click', () => {
      const br = this._saveBranch();
      if (br) { this._toast(`Saved "${br.name}"`); this._renderProps(); }
    });
    panel.appendChild(saveBtn);

    if (!this._branches.length) {
      const p = document.createElement('p');
      p.className = 'props-info';
      p.textContent = 'Forking saves the current run here automatically.';
      panel.appendChild(p);
    }
    for (const br of this._branches) {
      const row = document.createElement('div');
      row.className = 'branch-row';

      const name = document.createElement('input');
      name.type = 'text'; name.value = br.name; name.className = 'branch-name';
      name.setAttribute('aria-label', 'Branch name');
      name.addEventListener('blur', () => {
        br.name = name.value.trim() || br.name; name.value = br.name;
        if (this._timelineVisible) this.timeline.update();
      });

      const steps = document.createElement('span');
      steps.className = 'branch-step';
      steps.textContent = `→ step ${br.history[br.history.length - 1].step}`;

      const eye = document.createElement('button');
      eye.className = 'btn branch-mini-btn';
      eye.title = br.visible ? 'Hide in timeline' : 'Show in timeline';
      eye.setAttribute('aria-label', `${br.visible ? 'Hide' : 'Show'} branch ${br.name}`);
      eye.setAttribute('aria-pressed', String(br.visible));
      eye.appendChild(this._faIcon(br.visible ? 'eye' : 'eye-slash'));
      eye.addEventListener('click', () => {
        br.visible = !br.visible;
        if (this._timelineVisible) this.timeline.update();
        this._renderProps();
      });

      const del = document.createElement('button');
      del.className = 'btn branch-mini-btn';
      del.title = 'Delete branch';
      del.setAttribute('aria-label', `Delete branch ${br.name}`);
      del.appendChild(this._faIcon('xmark'));
      del.addEventListener('click', () => {
        this._branches = this._branches.filter(b => b !== br);
        if (this._timelineVisible) this.timeline.update();
        this._renderProps();
      });

      row.append(name, steps, eye, del);
      panel.appendChild(row);
    }
  }

  _addCheckpoint() {
    const cp = {
      id: 'cp' + (++this._cpSeq),
      name: `Checkpoint ${this._cpSeq}`,
      step: this.engine.step,
      state: this.engine.captureState(),
    };
    this._checkpoints.push(cp);
    this._toast(`Checkpointed step ${cp.step}`);
    this._renderProps();
  }

  _saveBranch(name) {
    if (this.engine.history.length < 2) {
      this._toast('Run the simulation first — nothing to save yet.');
      return null;
    }
    const br = {
      id: 'br' + (++this._branchSeq),
      name: name || `Branch ${this._branchSeq}`,
      history: structuredClone(this.engine.history),
      visible: true,
    };
    this._branches.push(br);
    if (this._timelineVisible) this.timeline.update();
    return br;
  }

  // Fork: keep the current run as a ghost branch, then put the simulation
  // back exactly as it was at the checkpoint. Tweak anything and press Run —
  // the new timeline plots over the ghosts.
  _forkFrom(cp) {
    this.engine.stop();
    this._syncRunButton();
    let kept = null;
    if (this.engine.history.length >= 2
        && this.engine.history[this.engine.history.length - 1].step > cp.step) {
      kept = this._saveBranch();
    }
    this.engine.restoreState(cp.state);
    document.getElementById('step-counter').textContent = `Step: ${this.engine.step}`;
    document.getElementById('sim-status').textContent = '';
    this.renderer.balls.clear();
    this._clearSparklines();
    this.renderer.render();
    this._commit();
    // The timeline is where the comparison lives — make sure it's on screen.
    if (kept && !this._timelineVisible) document.getElementById('btn-timeline').click();
    if (this._timelineVisible) this.timeline.update();
    this._toast(kept
      ? `Forked from "${cp.name}" — previous run kept as "${kept.name}"`
      : `Back at "${cp.name}" (step ${cp.step})`);
    this._renderProps();
  }

  // Named constants available to all formulas.
  _paramsEditor(panel) {
    this._info(panel, 'Named constants available to all formulas (e.g. growth_rate * pool).');
    const params = this.diagram.params;
    for (const [key] of Object.entries(params)) {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const ki = document.createElement('input');
      ki.type = 'text'; ki.value = key; ki.placeholder = 'name';
      ki.style.flex = '1';
      ki.addEventListener('blur', () => {
        const nk = ki.value.trim();
        if (!nk || nk === key) { ki.value = key; return; }
        if (!VALID_IDENT.test(nk)) { ki.value = key; return; }
        params[nk] = params[key];
        delete params[key];
        this._renderProps();
        this._commit();
      });
      const vi = document.createElement('input');
      vi.type = 'number'; vi.value = params[key]; vi.style.flex = '1';
      // Update live as you type, but commit one undo step on blur (the panel's
      // delegated `change` listener) rather than per keystroke.
      vi.addEventListener('input', () => {
        const n = parseFloat(vi.value);
        if (isFinite(n)) params[key] = n;
      });
      const delBtn = document.createElement('button');
      delBtn.appendChild(this._faIcon('xmark'));
      delBtn.setAttribute('aria-label', 'Delete parameter');
      delBtn.className = 'btn';
      delBtn.style.cssText = 'padding:2px 8px;flex-shrink:0';
      delBtn.addEventListener('click', () => { delete params[key]; this._renderProps(); this._commit(); });
      row.appendChild(ki); row.appendChild(vi); row.appendChild(delBtn);
      panel.appendChild(row);
    }

    const addRow = document.createElement('div');
    addRow.className = 'prop-row';
    addRow.appendChild(document.createElement('label'));
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add Parameter';
    addBtn.className = 'btn';
    addBtn.style.flex = '1';
    addBtn.addEventListener('click', () => {
      let k = 'param' + (Object.keys(params).length + 1);
      while (params[k] !== undefined) k += '_';
      params[k] = 0;
      this._renderProps();
      this._commit();
    });
    addRow.appendChild(addBtn);
    panel.appendChild(addRow);
  }

  // Live variables readout (populated during a simulation run).
  _liveVarsReadout(panel) {
    this._info(panel, 'Every named value in the shared store — parameters, state-connection variables, custom variables, and register outputs — updated as the simulation runs.');
    const vars = Object.entries(this.diagram.variables);
    if (!vars.length) {
      const p = document.createElement('p');
      p.className = 'props-empty';
      p.textContent = 'No variables yet. Run the simulation (or define parameters / variables) to see values here.';
      panel.appendChild(p);
      return;
    }
    for (const [k, v] of vars) {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const kl = document.createElement('label'); kl.textContent = k;
      const vl = document.createElement('span');
      vl.style.cssText = 'color:var(--accent);font-family:monospace;font-size:12px;';
      vl.textContent = typeof v === 'number' ? (+v.toFixed(3)) : v;
      row.appendChild(kl); row.appendChild(vl);
      panel.appendChild(row);
    }
  }

  // Artificial-player editor (shown in the diagram panel). Lets you script
  // interactive nodes to fire on an interval or a variable condition.
  _diagramAI(panel) {
    const ai = this.diagram.aiPlayer || (this.diagram.aiPlayer = { enabled: false, rules: [] });
    this._checkRow(panel, 'Enabled', ai.enabled, v => { ai.enabled = v; this._commit(); });
    this._info(panel, 'Scripted actor: fires interactive nodes automatically during a run — every N steps, or when a variable condition holds.');

    const interactives = [...this.diagram.nodes.values()]
      .filter(n => n.activation === ActivationMode.INTERACTIVE);
    if (!interactives.length) {
      this._info(panel, 'Tip: set a node\'s Activation to "interactive" to make it scriptable.');
    }

    ai.rules.forEach((rule, i) => {
      const box = document.createElement('div');
      box.className = 'ai-rule';

      // Target node (dropdown of interactive nodes).
      const nodeRow = document.createElement('div'); nodeRow.className = 'prop-row';
      const nl = document.createElement('label'); nl.textContent = 'Node';
      const ns = document.createElement('select');
      for (const n of interactives) {
        const o = document.createElement('option');
        o.value = n.id; o.textContent = n.label || n.type;
        if (n.id === rule.nodeId) o.selected = true;
        ns.appendChild(o);
      }
      if (!rule.nodeId && interactives[0]) rule.nodeId = interactives[0].id;
      ns.addEventListener('change', () => { rule.nodeId = ns.value; this._commit(); });
      nodeRow.appendChild(nl); nodeRow.appendChild(ns); box.appendChild(nodeRow);

      // Firing mode.
      const modeRow = document.createElement('div'); modeRow.className = 'prop-row';
      const ml = document.createElement('label'); ml.textContent = 'When';
      const ms = document.createElement('select');
      for (const [v, t] of [['interval', 'Every N steps'], ['condition', 'Condition']]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if (v === (rule.mode || 'interval')) o.selected = true;
        ms.appendChild(o);
      }
      ms.addEventListener('change', () => { rule.mode = ms.value; this._renderProps(); this._commit(); });
      modeRow.appendChild(ml); modeRow.appendChild(ms); box.appendChild(modeRow);

      if ((rule.mode || 'interval') === 'condition') {
        this._field(box, 'Variable', 'text', rule.condVar || '', v => { rule.condVar = v; }, 'variable name');
        const opRow = document.createElement('div'); opRow.className = 'prop-row';
        const ol = document.createElement('label'); ol.textContent = 'Op';
        const op = document.createElement('select');
        for (const o of ['>', '>=', '<', '<=', '==', '!=']) {
          const e = document.createElement('option');
          e.value = o; e.textContent = o;
          if (o === (rule.condOp || '>=')) e.selected = true;
          op.appendChild(e);
        }
        op.addEventListener('change', () => { rule.condOp = op.value; this._commit(); });
        const val = document.createElement('input');
        val.type = 'number'; val.value = rule.condValue ?? 0; val.style.width = '70px'; val.style.flex = 'none';
        val.addEventListener('input', () => { rule.condValue = parseFloat(val.value) || 0; });
        opRow.appendChild(ol); opRow.appendChild(op); opRow.appendChild(val); box.appendChild(opRow);
      } else {
        this._field(box, 'Every', 'number', rule.every || 1,
          v => { rule.every = Math.max(1, parseInt(v) || 1); }, 'steps');
      }

      const delRow = document.createElement('div'); delRow.className = 'prop-row';
      delRow.appendChild(document.createElement('label'));
      const del = document.createElement('button');
      del.textContent = 'Remove rule'; del.className = 'btn'; del.style.flex = '1';
      del.addEventListener('click', () => { ai.rules.splice(i, 1); this._renderProps(); this._commit(); });
      delRow.appendChild(del); box.appendChild(delRow);

      panel.appendChild(box);
    });

    const addRow = document.createElement('div'); addRow.className = 'prop-row';
    addRow.appendChild(document.createElement('label'));
    const add = document.createElement('button');
    add.textContent = '+ Add rule'; add.className = 'btn'; add.style.flex = '1';
    add.disabled = !interactives.length;
    add.addEventListener('click', () => {
      ai.rules.push({
        nodeId: interactives[0] ? interactives[0].id : '',
        mode: 'interval', every: 5, condVar: '', condOp: '>=', condValue: 0,
      });
      this._renderProps(); this._commit();
    });
    addRow.appendChild(add); panel.appendChild(addRow);
  }

  // Custom variables editor (diagram panel). Four kinds:
  //   interval — any number between min and max (random)
  //   array    — one of a comma-separated list of numbers (random)
  //   dice     — XdY notation (random)
  //   math     — a math.js formula over the shared variables
  // The random kinds pick a distribution (uniform / gaussian); all pick an
  // update rhythm ('step' = fresh value every step, 'play' = per Run press).
  _customVarsEditor(panel) {
    this._info(panel, 'Named values usable in any formula — random (interval, array, dice) or computed (math). Re-evaluated every step, or once each time Run is pressed.');

    const vars = this.diagram.customVars;
    const KINDS = ['interval', 'array', 'dice', 'math'];
    const KIND_LABELS = { interval: 'Interval', array: 'Array', dice: 'Dice', math: 'Math ƒ' };
    const fmtVal = v => isFinite(v) ? (Number.isInteger(v) ? String(v) : parseFloat(v.toFixed(4)).toString()) : '—';

    const mkChipGroup = (choices, current, onChange) => {
      const grp = document.createElement('div');
      grp.className = 'var-chip-group';
      for (const [v, label] of choices) {
        const chip = document.createElement('button');
        chip.className = 'var-chip' + (v === current ? ' active' : '');
        chip.textContent = label;
        chip.addEventListener('click', () => {
          grp.querySelectorAll('.var-chip').forEach(c => c.classList.toggle('active', c === chip));
          onChange(v);
        });
        grp.appendChild(chip);
      }
      return grp;
    };

    vars.forEach((rv, i) => {
      const card = document.createElement('div');
      card.className = 'var-card';

      // Value readout element created early so resample() can reference it.
      const valOut = document.createElement('div');
      valOut.className = 'var-value-display';
      valOut.textContent = fmtVal(rv.value);
      const resample = () => { rv.value = sampleCustomVar(rv, this.diagram.variables); valOut.textContent = fmtVal(rv.value); };

      // ── Header: name + delete ────────────────────────────────────────────
      const header = document.createElement('div');
      header.className = 'var-card-header';

      const name = document.createElement('input');
      name.type = 'text'; name.value = rv.name; name.placeholder = 'variable name';
      name.className = 'var-name-input';
      name.addEventListener('blur', () => {
        const nk = name.value.trim();
        if (!nk || !VALID_IDENT.test(nk)) { name.value = rv.name; return; }
        if (nk !== rv.name) { rv.name = nk; this._commit(); }
      });

      const del = document.createElement('button');
      del.className = 'btn var-delete-btn'; del.title = 'Remove variable';
      del.setAttribute('aria-label', 'Remove variable');
      del.appendChild(this._faIcon('xmark'));
      del.addEventListener('click', () => { vars.splice(i, 1); this._renderProps(); this._commit(); });

      header.appendChild(name); header.appendChild(del);
      card.appendChild(header);

      // ── Kind tabs ────────────────────────────────────────────────────────
      const tabs = document.createElement('div');
      tabs.className = 'var-kind-tabs';
      for (const k of KINDS) {
        const tab = document.createElement('button');
        tab.className = 'var-kind-tab' + (rv.kind === k ? ' active' : '');
        tab.textContent = KIND_LABELS[k];
        tab.addEventListener('click', () => {
          if (rv.kind === k) return;
          rv.kind = k;
          rv.value = sampleCustomVar(rv, this.diagram.variables);
          this._renderProps(); this._commit();
        });
        tabs.appendChild(tab);
      }
      card.appendChild(tabs);

      // ── Body: kind-specific input ────────────────────────────────────────
      const body = document.createElement('div');
      body.className = 'var-body';

      if (rv.kind === 'math') {
        const lbl = document.createElement('div');
        lbl.className = 'var-field-label'; lbl.textContent = 'Formula';
        const f = document.createElement('input');
        f.type = 'text'; f.className = 'var-wide-input';
        f.value = rv.formula || '';
        f.placeholder = 'e.g. round(gold * 0.1) + max(2, level)';
        f.addEventListener('input', () => {
          const valid = !f.value.trim() || validateFormula(f.value);
          f.classList.toggle('invalid', !valid);
          if (valid) { rv.formula = f.value.trim(); resample(); }
        });
        body.appendChild(lbl); body.appendChild(f);
      } else if (rv.kind === 'array') {
        const lbl = document.createElement('div');
        lbl.className = 'var-field-label'; lbl.textContent = 'Values (comma-separated)';
        const arr = document.createElement('input');
        arr.type = 'text'; arr.className = 'var-wide-input';
        arr.value = (rv.values || []).join(', ');
        arr.placeholder = 'e.g. 1, 2, 5, 10';
        arr.addEventListener('input', () => {
          const tokens = arr.value.split(',').map(t => t.trim());
          const nums = tokens.map(parseFloat);
          const valid = tokens.length > 0 && tokens.every(t => t !== '') && nums.every(isFinite);
          arr.classList.toggle('invalid', !valid);
          if (valid) { rv.values = nums; resample(); }
        });
        body.appendChild(lbl); body.appendChild(arr);
      } else if (rv.kind === 'dice') {
        const lbl = document.createElement('div');
        lbl.className = 'var-field-label'; lbl.textContent = 'Dice notation';
        const dice = document.createElement('input');
        dice.type = 'text'; dice.className = 'var-wide-input';
        dice.value = rv.dice || '2d6';
        dice.placeholder = 'e.g. 2d6 or 3d10';
        dice.addEventListener('input', () => {
          const valid = /^\d+\s*d\s*\d+$/i.test(dice.value.trim());
          dice.classList.toggle('invalid', !valid);
          if (valid) { rv.dice = dice.value.trim(); resample(); }
        });
        body.appendChild(lbl); body.appendChild(dice);
      } else {
        const lbl = document.createElement('div');
        lbl.className = 'var-field-label'; lbl.textContent = 'Range';
        const row = document.createElement('div');
        row.className = 'var-range-row';
        const minEl = document.createElement('input');
        minEl.type = 'number'; minEl.value = rv.min ?? 0; minEl.className = 'var-range-num'; minEl.placeholder = 'min';
        const sep = document.createElement('span');
        sep.textContent = '→'; sep.className = 'var-range-sep';
        const maxEl = document.createElement('input');
        maxEl.type = 'number'; maxEl.value = rv.max ?? 10; maxEl.className = 'var-range-num'; maxEl.placeholder = 'max';
        const upd = () => {
          const lo = parseFloat(minEl.value), hi = parseFloat(maxEl.value);
          const valid = isFinite(lo) && isFinite(hi) && hi >= lo;
          minEl.classList.toggle('invalid', !valid);
          maxEl.classList.toggle('invalid', !valid);
          if (valid) { rv.min = lo; rv.max = hi; resample(); }
        };
        minEl.addEventListener('input', upd); maxEl.addEventListener('input', upd);
        row.appendChild(minEl); row.appendChild(sep); row.appendChild(maxEl);
        body.appendChild(lbl); body.appendChild(row);
      }
      card.appendChild(body);

      // ── Footer: dist chips + update chips + value display ────────────────
      const footer = document.createElement('div');
      footer.className = 'var-footer';

      if (rv.kind !== 'math') {
        const distGrp = mkChipGroup(
          [['uniform', 'uniform'], ['gaussian', 'gaussian']],
          rv.dist || 'uniform',
          v => { rv.dist = v; resample(); }
        );
        footer.appendChild(distGrp);
      }

      const updateGrp = mkChipGroup(
        [['step', 'per step'], ['play', 'on play']],
        rv.update || 'step',
        v => { rv.update = v; this._commit(); }
      );
      footer.appendChild(updateGrp);
      footer.appendChild(valOut);

      card.appendChild(footer);
      panel.appendChild(card);
    });

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add Variable';
    addBtn.className = 'btn var-add-btn';
    addBtn.addEventListener('click', () => {
      let k = 'var' + (vars.length + 1);
      while (vars.some(v => v.name === k)) k += '_';
      const rv = { name: k, kind: 'interval', min: 0, max: 10, values: [1, 2, 3], dice: '2d6', formula: '', dist: 'uniform', update: 'step', value: 0 };
      rv.value = sampleCustomVar(rv, this.diagram.variables);
      vars.push(rv);
      this._renderProps();
      this._commit();
    });
    panel.appendChild(addBtn);
  }

  // Named resource types editor + live per-type totals (diagram panel).
  _resourceTypesEditor(panel) {
    this._info(panel, 'Give resources readable names. Each type maps a name to a color, which the engine uses to track it. Pick a type from the colour fields on sources, converters, and filters.');

    const types = this.diagram.resourceTypes;
    types.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const ni = document.createElement('input');
      ni.type = 'text'; ni.value = t.name; ni.placeholder = 'name'; ni.style.flex = '1';
      ni.addEventListener('input', () => { t.name = ni.value; this.renderer.render(); });
      ni.addEventListener('change', () => this._commit());
      const ci = document.createElement('input');
      ci.type = 'color'; ci.value = t.color || '#ffa726';
      ci.style.cssText = 'width:36px;height:28px;padding:1px;border-radius:4px;cursor:pointer;border:1px solid var(--border);background:none;flex:0 0 auto;';
      ci.addEventListener('input', () => { t.color = ci.value; this.renderer.render(); });
      ci.addEventListener('change', () => this._commit());
      const del = document.createElement('button');
      del.appendChild(this._faIcon('xmark'));
      del.setAttribute('aria-label', 'Delete resource type');
      del.className = 'btn';
      del.style.cssText = 'padding:2px 8px;flex-shrink:0;';
      del.addEventListener('click', () => { types.splice(i, 1); this._renderProps(); this._commit(); });
      row.appendChild(ni); row.appendChild(ci); row.appendChild(del);
      panel.appendChild(row);
    });

    const addRow = document.createElement('div');
    addRow.className = 'prop-row';
    addRow.appendChild(document.createElement('label'));
    const add = document.createElement('button');
    add.textContent = '+ Add Resource Type'; add.className = 'btn'; add.style.flex = '1';
    add.addEventListener('click', () => {
      const swatches = ['#ffd700', '#8d6e63', '#4caf50', '#42a5f5', '#ef5350', '#ab47bc', '#ff7043', '#26c6da'];
      types.push({ name: 'Type ' + (types.length + 1), color: swatches[types.length % swatches.length] });
      this._renderProps(); this._commit();
    });
    addRow.appendChild(add);
    panel.appendChild(addRow);

    // Live per-type totals across the diagram.
    const tl = document.createElement('div');
    tl.className = 'chart-label'; tl.style.marginTop = '10px';
    tl.textContent = 'Totals held (live)';
    panel.appendChild(tl);
    const tot = document.createElement('div');
    tot.className = 'type-readout'; tot.id = 'diagram-totals';
    panel.appendChild(tot);
    this._fillTotals(tot);
  }

  // One swatch + name + count row inside a per-type readout container.
  _typeRow(container, color, name, count) {
    const row = document.createElement('div');
    row.className = 'type-row';
    const sw = document.createElement('span');
    sw.className = 'type-swatch';
    sw.style.background = color || 'transparent';
    const nm = document.createElement('span');
    nm.className = 'type-name';
    nm.textContent = name;
    const ct = document.createElement('span');
    ct.className = 'type-count';
    ct.textContent = String(count);
    row.appendChild(sw); row.appendChild(nm); row.appendChild(ct);
    container.appendChild(row);
  }

  // Per-type holdings for a single node (its colorMap, named where possible).
  _fillHoldings(container, node) {
    container.innerHTML = '';
    if (node.type === NodeType.SOURCE && !node.limited) {
      const color = node.resourceColor || DEFAULT_COLOR;
      this._typeRow(container, color, this.diagram.resourceTypeName(color) || color, '∞');
      return;
    }
    const entries = Object.entries(node.colorMap || {}).filter(([, c]) => c > 0);
    if (!entries.length) { container.innerHTML = '<p class="props-info">Empty.</p>'; return; }
    for (const [color, count] of entries) {
      this._typeRow(container, color, this.diagram.resourceTypeName(color) || color, count);
    }
  }

  // Diagram-wide totals per resource type (defined types first, then any
  // untyped colors actually present). Infinite sources are not counted.
  _fillTotals(container) {
    container.innerHTML = '';
    const totals = {};
    for (const n of this.diagram.nodes.values()) {
      if (n.type === NodeType.SOURCE && !n.limited) continue;
      for (const [c, cnt] of Object.entries(n.colorMap || {})) totals[c] = (totals[c] || 0) + cnt;
    }
    const shown = new Set();
    for (const t of this.diagram.resourceTypes) {
      const key = (t.color || '').toLowerCase();
      this._typeRow(container, t.color, t.name || '(unnamed)', totals[t.color] || 0);
      shown.add(key);
    }
    for (const [color, cnt] of Object.entries(totals)) {
      if (shown.has(color.toLowerCase())) continue;
      this._typeRow(container, color, this.diagram.resourceTypeName(color) || color, cnt);
    }
    if (!container.childElementCount) container.innerHTML = '<p class="props-info">No resources held yet.</p>';
  }

  // Re-fill whichever per-type readout is currently on screen (called each step).
  _refreshTypeReadouts() {
    const nodeEl = document.getElementById('node-holdings');
    if (nodeEl && this._selectedType === 'node') {
      const node = this.diagram.nodes.get(this._selectedId);
      if (node) this._fillHoldings(nodeEl, node);
    }
    const totEl = document.getElementById('diagram-totals');
    if (totEl) this._fillTotals(totEl);
  }

  _groupProps(panel, group) {
    this._titleTyped(panel, 'Container group', group.label || '(unnamed)', group.color || '#4a9eff');
    this._info(panel, 'Drag inside to move with its contained nodes. Drag the border to resize by editing Width / Height below.');
    this._field(panel, 'Label', 'text', group.label, v => { group.label = v; this.renderer.render(); });
    this._colorField(panel, 'Color', group.color || '#4a9eff', v => { group.color = v; this.renderer.render(); });
    this._field(panel, 'Width', 'number', group.w, v => { group.w = Math.max(40, parseInt(v) || 100); this.renderer.render(); });
    this._field(panel, 'Height', 'number', group.h, v => { group.h = Math.max(30, parseInt(v) || 80); this.renderer.render(); });
    this._sep(panel);
    const delRow = document.createElement('div');
    delRow.className = 'prop-row';
    delRow.appendChild(document.createElement('label'));
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete group'; delBtn.className = 'btn btn-danger'; delBtn.style.flex = '1';
    delBtn.addEventListener('click', () => {
      this.diagram.removeGroup(group.id);
      this.editor._select(null, null);
      this.renderer.render();
      this._commit();
    });
    delRow.appendChild(delBtn);
    panel.appendChild(delRow);
  }

  _noteProps(panel, note) {
    this._titleTyped(panel, 'Annotation', 'Sticky note', note.color || '#f6e05e');
    const row = document.createElement('div');
    row.className = 'prop-row'; row.style.alignItems = 'flex-start';
    const lbl = document.createElement('label'); lbl.textContent = 'Text';
    const ta = document.createElement('textarea');
    ta.className = 'note-textarea'; ta.value = note.text || '';
    ta.addEventListener('input', () => { note.text = ta.value; this.renderer.render(); });
    row.appendChild(lbl); row.appendChild(ta);
    panel.appendChild(row);
    this._colorField(panel, 'Color', note.color || '#f6e05e', v => { note.color = v; this.renderer.render(); });
    this._field(panel, 'Width', 'number', note.w, v => { note.w = Math.max(40, parseInt(v) || 100); this.renderer.render(); });
    this._field(panel, 'Height', 'number', note.h, v => { note.h = Math.max(30, parseInt(v) || 60); this.renderer.render(); });
    this._sep(panel);
    const delRow = document.createElement('div');
    delRow.className = 'prop-row';
    delRow.appendChild(document.createElement('label'));
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete note'; delBtn.className = 'btn btn-danger'; delBtn.style.flex = '1';
    delBtn.addEventListener('click', () => {
      this.diagram.removeNote(note.id);
      this.editor._select(null, null);
      this.renderer.render();
      this._commit();
    });
    delRow.appendChild(delBtn);
    panel.appendChild(delRow);
  }

  _chartProps(panel, chart) {
    const palette = (typeof CHART_PALETTE !== 'undefined') ? CHART_PALETTE
      : ['#4a9eff', '#4caf50', '#ef5350', '#ffa726', '#ba68c8', '#26c6da', '#ffeb3b', '#7c83ff', '#ff7043', '#9ccc65'];

    this._titleTyped(panel, 'Canvas widget', chart.label || 'Chart', '#26c6da');
    this._info(panel, 'A live chart drawn on the canvas. Pick nodes below to plot their values over the run.');
    this._field(panel, 'Title', 'text', chart.label, v => { chart.label = v; this.renderer.render(); });

    // Visualization style picker.
    this._section(panel, 'Style');
    const typeChips = document.createElement('div');
    typeChips.className = 'var-chip-group chart-type-chips';
    for (const [key, icon, label] of [
      ['line', 'chart-line', 'Line'], ['area', 'chart-area', 'Area'], ['bars', 'chart-column', 'Bars'], ['step', 'stairs', 'Step'],
    ]) {
      const chip = document.createElement('button');
      chip.className = 'var-chip' + ((chart.chartType || 'line') === key ? ' active' : '');
      chip.innerHTML = `<i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${label}`;
      chip.addEventListener('click', () => {
        chart.chartType = key;
        this._renderProps(); this.renderer.render(); this._commit();
      });
      typeChips.appendChild(chip);
    }
    panel.appendChild(typeChips);

    this._field(panel, 'Width', 'number', chart.w, v => { chart.w = Math.max(120, parseInt(v) || 240); this.renderer.render(); });
    this._field(panel, 'Height', 'number', chart.h, v => { chart.h = Math.max(80, parseInt(v) || 150); this.renderer.render(); });

    this._section(panel, 'Tracked nodes');

    // Existing series, each with its plot color and a remove button.
    chart.nodeIds = (chart.nodeIds || []).filter(id => this.diagram.nodes.has(id));
    if (!chart.nodeIds.length) this._info(panel, 'No nodes tracked yet. Add one below.');
    chart.nodeIds.forEach((id, idx) => {
      const node = this.diagram.nodes.get(id);
      const row = document.createElement('div');
      row.className = 'prop-row';
      const sw = document.createElement('span');
      sw.style.cssText = `flex:0 0 12px;width:12px;height:12px;border-radius:2px;background:${palette[idx % palette.length]};`;
      const name = document.createElement('span');
      name.style.cssText = 'flex:1;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      name.textContent = node.label || node.type;
      const rm = document.createElement('button');
      rm.appendChild(this._faIcon('xmark'));
      rm.setAttribute('aria-label', 'Stop tracking node');
      rm.className = 'btn';
      rm.style.cssText = 'padding:2px 8px;flex-shrink:0;';
      rm.addEventListener('click', () => {
        chart.nodeIds = chart.nodeIds.filter(x => x !== id);
        this._renderProps(); this.renderer.render(); this._commit();
      });
      row.appendChild(sw); row.appendChild(name); row.appendChild(rm);
      panel.appendChild(row);
    });

    // Add-series dropdown: chartable nodes (anything except infinite sources)
    // not already tracked.
    const available = [...this.diagram.nodes.values()]
      .filter(n => !(n.type === NodeType.SOURCE && !n.limited))
      .filter(n => !chart.nodeIds.includes(n.id));
    const addRow = document.createElement('div');
    addRow.className = 'prop-row';
    const sel = document.createElement('select');
    sel.style.flex = '1';
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = available.length ? 'Add node…' : 'No nodes available';
    sel.appendChild(ph);
    for (const n of available) {
      const o = document.createElement('option');
      o.value = n.id; o.textContent = n.label || n.type;
      sel.appendChild(o);
    }
    sel.disabled = !available.length;
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      chart.nodeIds.push(sel.value);
      this._renderProps(); this.renderer.render(); this._commit();
    });
    addRow.appendChild(sel);
    panel.appendChild(addRow);

    this._sep(panel);
    const delRow = document.createElement('div');
    delRow.className = 'prop-row';
    delRow.appendChild(document.createElement('label'));
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete chart'; delBtn.className = 'btn btn-danger'; delBtn.style.flex = '1';
    delBtn.addEventListener('click', () => {
      this.diagram.removeChart(chart.id);
      this.editor._select(null, null);
      this.renderer.render();
      this._commit();
    });
    delRow.appendChild(delBtn);
    panel.appendChild(delRow);
  }

  _nodeProps(panel, node) {
    const typeColor = (typeof NODE_STROKE !== 'undefined' && NODE_STROKE[node.type]) || 'var(--accent)';
    this._titleTyped(panel, `${node.type} node`, node.label || '(unnamed)', typeColor);

    this._field(panel, 'Label', 'text', node.label, v => { node.label = v; this.renderer.render(); });

    // Type-specific fields
    if (node.type === NodeType.SOURCE) {
      this._colorField(panel, 'Resource Color', node.resourceColor || '#ffa726', v => {
        node.resourceColor = v; this.renderer.render();
      }, false, true);
      this._checkRow(panel, 'Limited stock', node.limited, v => {
        node.limited = v;
        if (v) {
          const stock = isFinite(node.resources) ? node.resources : 10;
          node.setCount(stock, node.resourceColor || DEFAULT_COLOR);
        } else {
          node.resources = Infinity; node.colorMap = {};
          node._initialResources = Infinity; node._initialColorMap = {};
        }
        this._renderProps(); this.renderer.render();
      });
      if (node.limited) {
        this._field(panel, 'Stock', 'number', isFinite(node.resources) ? node.resources : 0, v => {
          node.setCount(Math.max(0, parseInt(v) || 0), node.resourceColor || DEFAULT_COLOR);
          this.renderer.render();
        });
        this._info(panel, 'Finite starting stock — the source runs dry when depleted.');
      }
    }

    if (node.type !== NodeType.SOURCE && node.type !== NodeType.REGISTER
      && node.type !== NodeType.DRAIN && node.type !== NodeType.TRADER) {
      this._field(panel, 'Resources', 'number', node.resources, v => {
        node.setCount(Math.max(0, parseInt(v) || 0));
        this.renderer.render();
      });
      // Quick +/- steppers for adjusting resources during play
      const stepRow = document.createElement('div');
      stepRow.className = 'prop-row';
      stepRow.appendChild(document.createElement('label'));
      const stepBtns = document.createElement('div');
      stepBtns.style.cssText = 'display:flex;gap:4px;flex:1;';
      for (const [icon, aria, delta] of [['minus', 'Remove one resource', -1], ['plus', 'Add one resource', 1]]) {
        const b = document.createElement('button');
        b.appendChild(this._faIcon(icon));
        b.setAttribute('aria-label', aria);
        b.className = 'btn';
        b.style.cssText = 'flex:1;padding:2px 0;font-size:12px;';
        b.addEventListener('click', () => {
          if (delta < 0 && node.resources <= 0) return;
          if (delta > 0 && node.capacity !== Infinity && node.resources >= node.capacity) return;
          if (delta < 0) node.takeResources(1);
          else node.addResources(1);
          this.renderer.render();
          this._refreshResourceCount();
        });
        stepBtns.appendChild(b);
      }
      stepRow.appendChild(stepBtns);
      panel.appendChild(stepRow);
    }

    if (node.type === NodeType.POOL || node.type === NodeType.CONVERTER) {
      this._field(panel, 'Capacity', 'text', node.capacity === Infinity ? '' : node.capacity,
        v => {
          if (v === '' || v === '∞') { node.capacity = Infinity; }
          else { const n = parseInt(v, 10); node.capacity = isFinite(n) && n >= 0 ? n : Infinity; }
          this.renderer.render();
        },
        '∞ = unlimited');
    }

    if (node.type === NodeType.CONVERTER) {
      this._field(panel, 'Input / conversion', 'number', node.inputAmount,
        v => { node.inputAmount = Math.max(1, parseInt(v) || 1); });
      this._colorField(panel, 'Output color', node.outputColor || '#ffa726', v => {
        node.outputColor = v; this.renderer.render();
      }, false, true);
      this._info(panel, 'Consumes this many held resources per conversion, then emits each output connection’s rate in the output color.');
    }

    if (node.type === NodeType.DRAIN) {
      const stat = document.createElement('div');
      stat.className = 'reg-value drain-stat';
      stat.textContent = `${node.drained || 0}`;
      panel.appendChild(stat);
      this._info(panel, 'Total resources consumed (drained) this run.');
    }

    if (node.type === NodeType.TRADER) {
      const stat = document.createElement('div');
      stat.className = 'reg-value';
      stat.replaceChildren(this._faIcon('right-left'),
        document.createTextNode(` ${node.trades || 0}`));
      panel.appendChild(stat);
      this._info(panel, 'Completed exchanges this run. Wire A → Trader → B: '
        + 'when the trader fires, A pays the incoming connection\'s rate to B and B pays '
        + 'the outgoing connection\'s rate back to A — all or nothing. Extra in/out pairs '
        + 'trade in wiring order.');
    }

    if (node.type === NodeType.DELAY) {
      this._field(panel, 'Delay steps', 'number', node.delay, v => { node.delay = Math.max(1, parseInt(v) || 1); });
    }

    if (node.type === NodeType.QUEUE) {
      this._field(panel, 'Process time', 'number', node.processTime,
        v => { node.processTime = Math.max(1, parseInt(v) || 1); });
      this._info(panel, 'Steps to process one unit. Units are served one at a time (FIFO) — a throughput bottleneck of one per process-time, with per-item latency.');
    }

    if (node.type === NodeType.GATE) {
      if (node.gateMode === 'random') node.gateMode = 'probabilistic';
      this._select2(panel, 'Gate mode', ['deterministic', 'probabilistic', 'all'], node.gateMode,
        v => { node.gateMode = v; });
      this._info(panel, 'Outputs split by each connection\'s Weight — deterministic = proportional share; probabilistic = weighted random per unit; all = each output gets its full weight per firing.');
    }

    if (node.type === NodeType.REGISTER) {
      const valRow = document.createElement('div');
      valRow.className = 'reg-value';
      valRow.textContent = `= ${node.displayCount}`;
      panel.appendChild(valRow);

      this._field(panel, 'Formula', 'text', node.formula,
        v => { node.formula = v; this.renderer.render(); },
        'e.g. treasury * 2');

      this._info(panel, 'State connections feeding this register become variables. Set the connection\'s variable name (label) to use in the formula.');
    }

    this._section(panel, 'Behavior');

    if (node.type === NodeType.POOL || node.type === NodeType.DRAIN) {
      this._select2(panel, 'Flow', ['push', 'pull'], node.flowMode, v => {
        node.flowMode = v; this._renderProps(); this.renderer.render();
      });
      if (node.flowMode === 'pull') {
        this._select2(panel, 'Pull policy', ['any', 'all'], node.pullPolicy,
          v => { node.pullPolicy = v; });
        this._info(panel, 'Pull draws resources along incoming connections from pool/source providers. "all" only pulls when every provider can supply its full rate.');
      }
    }

    this._select2(panel, 'Activation', Object.values(ActivationMode), node.activation,
      v => { node.activation = v; this._renderProps(); this.renderer.render(); });

    // Asynchronous time mode: per-node firing rhythm (only for automatic nodes).
    if (this.diagram.timeMode === 'async' && node.activation === ActivationMode.AUTOMATIC) {
      this._field(panel, 'Fire every', 'number', node.fireEvery || 1,
        v => { node.fireEvery = Math.max(1, parseInt(v) || 1); }, 'steps between firings');
      this._field(panel, 'Phase', 'number', node.firePhase || 0,
        v => { node.firePhase = Math.max(0, parseInt(v) || 0); }, 'start offset (steps)');
      this._info(panel, 'This automatic node fires every "Fire every" steps, offset by "Phase".');
    }

    // Per-type holdings readout (nodes that carry colored resources).
    if (node.type !== NodeType.REGISTER && node.type !== NodeType.DRAIN
      && node.type !== NodeType.TRADER) {
      this._section(panel, 'Holdings by type');
      const hc = document.createElement('div');
      hc.className = 'type-readout'; hc.id = 'node-holdings';
      panel.appendChild(hc);
      this._fillHoldings(hc, node);
    }

    // End / goal condition (any node with a numeric value)
    if (node.type !== NodeType.SOURCE) {
      this._section(panel, 'Goal');
      this._conditionRow(panel, 'End / goal', node,
        { enabled: 'endEnabled', op: 'endOperator', val: 'endValue', lead: 'stop when value' });
      this._info(panel, 'Halt the simulation when this node\'s value meets the condition.');
    }

    // Chart
    if (node.type !== NodeType.SOURCE) {
      this._section(panel, 'History');
      const sec = document.createElement('div');
      sec.className = 'chart-section';
      panel.appendChild(sec);
      const sl = new Sparkline(sec, node.id, this.engine);
      this._sparklines.set(node.id, sl);
      sl.update();
    }
  }

  _connProps(panel, conn) {
    const src = this.diagram.nodes.get(conn.sourceId);
    const tgt = this.diagram.nodes.get(conn.targetId);
    const isRes = conn.type === ConnectionType.RESOURCE;
    this._titleTyped(panel, `${isRes ? 'Resource' : 'State'} connection`,
      `${src?.label || '?'} → ${tgt?.label || '?'}`, isRes ? '#ffa726' : '#78909c');

    this._section(panel, 'Appearance');

    // Path style selector
    const styleRow = document.createElement('div');
    styleRow.className = 'prop-row';
    const styleLbl = document.createElement('label');
    styleLbl.textContent = 'Style';
    styleRow.appendChild(styleLbl);
    const styleGroup = document.createElement('div');
    styleGroup.className = 'conn-style-group';
    for (const { key, icon, tip } of [
      { key: 'straight', icon: 'minus', tip: 'Straight line' },
      { key: 'curve',    icon: 'bezier-curve', tip: 'Curved — drag handle to reshape' },
      { key: 'ortho',   icon: 'turn-up', tip: 'Right-angle turns — drag any segment; end segments add bends' },
    ]) {
      const btn = document.createElement('button');
      btn.className = 'conn-style-btn' + ((conn.pathStyle || 'curve') === key ? ' active' : '');
      btn.title = tip;
      btn.setAttribute('aria-label', tip);
      btn.appendChild(this._faIcon(icon));
      btn.addEventListener('click', () => {
        conn.pathStyle = key;
        conn.cpDx = 0; conn.cpDy = 0; conn.bendPct = 0.5; conn.waypoints = [];
        this.renderer.render();
        this._renderProps();
      });
      styleGroup.appendChild(btn);
    }
    styleRow.appendChild(styleGroup);
    panel.appendChild(styleRow);

    const ps = conn.pathStyle || 'curve';
    if (ps === 'ortho') this._info(panel, 'Drag any segment to reshape; dragging an end segment adds a bend. Double-click the line to reset.');
    else if (ps === 'curve') this._info(panel, 'Drag the handle on the line to reshape. Double-click the line to reset.');

    this._field(panel, 'Label', 'text', conn.label, v => { conn.label = v; this.renderer.render(); });

    if (isRes) {
      const fromGate = src && src.type === NodeType.GATE;
      const fromConverter = src && src.type === NodeType.CONVERTER;
      const fromDelay = src && src.type === NodeType.DELAY;
      const traderSide = (src && src.type === NodeType.TRADER) || (tgt && tgt.type === NodeType.TRADER);

      const rateField = () => this._field(panel, 'Rate', 'number', conn.rate, v => {
        const n = parseFloat(v); conn.rate = isFinite(n) ? Math.max(0, n) : 0; this.renderer.render();
      });

      if (traderSide) {
        this._info(panel, tgt && tgt.type === NodeType.TRADER
          ? 'Trade route (into the trader): the rate is what this partner pays per exchange.'
          : 'Trade route (out of the trader): the rate is what this partner pays back per exchange.');
      }

      if (fromGate) {
        // Gates distribute by weight only; rate/timing/filter don't apply.
        this._field(panel, 'Weight', 'number', conn.weight, v => {
          const n = parseFloat(v); conn.weight = isFinite(n) ? Math.max(0, n) : 0; this.renderer.render();
        }, 'output share (0 = off)');
        this._info(panel, 'Share of the gate\'s resources routed down this output (deterministic split or weighted chance).');
      } else if (fromDelay) {
        // Delays release matured resources, split across outputs by rate.
        rateField();
        this._info(panel, 'When resources mature, each output\'s rate is its share among the delay\'s outputs.');
      } else {
        // Source / Pool / Converter: rate (fixed / dice / formula).
        this._section(panel, 'Rate');
        this._select2(panel, 'Rate mode', Object.values(RateMode), conn.rateMode, v => {
          conn.rateMode = v;
          this._renderProps(); // re-render to show the matching rate field
        });

        if (conn.rateMode === RateMode.FIXED) {
          rateField();
        } else if (conn.rateMode === RateMode.DICE) {
          this._field(panel, 'Dice', 'text', conn.dice, v => {
            conn.dice = v; this.renderer.render();
          }, '1d6, 2d4, 3d10…');
        } else if (conn.rateMode === RateMode.FORMULA) {
          this._field(panel, 'Formula', 'text', conn.formula, v => {
            conn.formula = v; this.renderer.render();
          }, 'e.g. treasury * 0.1');
        } else if (conn.rateMode === RateMode.DISTRIBUTION) {
          const dt = conn.distType || 'normal';
          this._select2(panel, 'Distribution', ['normal', 'uniform', 'exponential', 'poisson'], dt, v => {
            conn.distType = v; this._renderProps();
          });
          const p1Label = dt === 'uniform' ? 'Min' : (dt === 'exponential' ? 'Mean' : (dt === 'poisson' ? 'Lambda' : 'Mean'));
          this._field(panel, p1Label, 'number', conn.distParam1 ?? 5, v => {
            conn.distParam1 = parseFloat(v) || 0;
          }, dt === 'uniform' ? 'lower bound' : 'expected value');
          if (dt === 'normal' || dt === 'uniform') {
            const p2Label = dt === 'uniform' ? 'Max' : 'Std Dev';
            this._field(panel, p2Label, 'number', conn.distParam2 ?? 2, v => {
              conn.distParam2 = parseFloat(v) || 0;
            }, dt === 'uniform' ? 'upper bound' : 'spread');
          }
          this._info(panel, { normal: 'Normal: rounded Gaussian (mean ± std dev)', uniform: 'Uniform: integer in [min, max]', exponential: 'Exponential: inter-arrival times (mean)', poisson: 'Poisson: event count per step (λ)' }[dt] || '');
        }

        if (fromConverter) {
          this._info(panel, 'Amount emitted per conversion, in the converter\'s output color.');
        } else {
          // Only Source / Pool outputs honor timing, color filter, condition.
          this._section(panel, 'Timing');

          this._field(panel, 'Interval', 'number', conn.interval, v => {
            conn.interval = Math.max(1, parseInt(v) || 1);
          }, 'fire every N steps');

          this._field(panel, 'Chance %', 'number', conn.chance, v => {
            const n = parseFloat(v);
            conn.chance = Math.min(100, Math.max(0, isFinite(n) ? n : 100));
            this.renderer.render();
          }, '0–100');

          this._section(panel, 'Filter');

          this._colorField(panel, 'Color filter', conn.colorFilter || '', v => {
            conn.colorFilter = v;
            this.renderer.render();
          }, true, true);
          this._info(panel, 'Only resources of this color pass. Leave empty for any color.');

          this._section(panel, 'Condition');

          this._conditionRow(panel, 'Condition', conn,
            { enabled: 'condEnabled', op: 'condOperator', val: 'condValue', val2: 'condValue2', lead: 'if source' },
            (details) => {
              // Compare against: source value OR a named diagram variable
              const refRow = document.createElement('div');
              refRow.className = 'prop-row';
              const rl = document.createElement('label'); rl.textContent = 'Compare';
              const rs = document.createElement('select');
              for (const [v, t] of [['source', 'Source value'], ['variable', 'Variable']]) {
                const o = document.createElement('option');
                o.value = v; o.textContent = t;
                if (v === (conn.condRefMode || 'source')) o.selected = true;
                rs.appendChild(o);
              }
              const varRow = document.createElement('div');
              varRow.className = 'prop-row';
              varRow.style.display = (conn.condRefMode || 'source') === 'variable' ? '' : 'none';
              const vl = document.createElement('label'); vl.textContent = 'Variable';
              const vi = document.createElement('input');
              vi.type = 'text'; vi.value = conn.condVariable || '';
              vi.placeholder = 'variable name';
              vi.addEventListener('input', () => { conn.condVariable = vi.value; });
              varRow.appendChild(vl); varRow.appendChild(vi);
              rs.addEventListener('change', () => {
                conn.condRefMode = rs.value;
                varRow.style.display = rs.value === 'variable' ? '' : 'none';
              });
              refRow.appendChild(rl); refRow.appendChild(rs);
              details.appendChild(refRow);
              details.appendChild(varRow);
            });
        }
      }

    } else {
      // State connection: one primary role, picked up front so the panel only
      // shows the controls that matter. (Model flags stay independent, so old
      // diagrams with combined roles still run; the panel surfaces the first.)
      const role = conn.modifier ? 'modify'
        : (conn.trigger || conn.reverseTrigger) ? 'trigger'
        : conn.activator ? 'activate' : 'variable';

      this._section(panel, 'Role');
      const roleLbl = document.createElement('div');
      roleLbl.className = 'field-label';
      roleLbl.textContent = 'This connection…';
      panel.appendChild(roleLbl);

      const chips = document.createElement('div');
      chips.className = 'var-chip-group role-chips';
      for (const [key, label] of [
        ['variable', 'Sets a variable'],
        ['modify',   'Modifies target'],
        ['trigger',  'Triggers target'],
        ['activate', 'Activates target'],
      ]) {
        const chip = document.createElement('button');
        chip.className = 'var-chip' + (role === key ? ' active' : '');
        chip.textContent = label;
        chip.addEventListener('click', () => {
          if (key === role) return;
          // First time the modifier is enabled, default to the simplest mode:
          // a flat amount every step.
          if (key === 'modify' && !conn.modifier && (conn.modMode || 'rate') === 'rate') conn.modMode = 'step';
          conn.modifier = key === 'modify';
          conn.activator = key === 'activate';
          if (key === 'trigger') { if (!conn.trigger && !conn.reverseTrigger) conn.trigger = true; }
          else { conn.trigger = false; conn.reverseTrigger = false; }
          this._renderProps(); this.renderer.render();
        });
        chips.appendChild(chip);
      }
      panel.appendChild(chips);
      this._sep(panel);

      if (role === 'variable') {
        this._field(panel, 'Variable name', 'text', conn.variableName || conn.label, v => {
          conn.variableName = v; conn.label = v; this._renderProps(); this.renderer.render();
        }, 'used in formulas');
        if (!conn.variableName) {
          const warn = document.createElement('p');
          warn.className = 'prop-inline-warn';
          warn.textContent = 'Give this connection a name so its value can be referenced in formulas.';
          panel.appendChild(warn);
        }
        this._info(panel, 'Each step this variable is set to the source\'s value (pool count, source produced, drain consumed, or register value). Use it in Register or rate formulas, or in modifier formulas on other connections.');

      } else if (role === 'modify') {
        const mode = conn.modMode || 'rate';
        const modeRow = document.createElement('div');
        modeRow.className = 'prop-row';
        const ml = document.createElement('label'); ml.textContent = 'When';
        const ms = document.createElement('select');
        for (const [v, t] of [
          ['step',  'Every step — flat amount'],
          ['pulse', 'When source fires — flat amount'],
          ['delta', 'When source changes — × the change'],
          ['rate',  'Every step — × source value'],
        ]) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          if (v === mode) o.selected = true;
          ms.appendChild(o);
        }
        ms.addEventListener('change', () => { conn.modMode = ms.value; this._renderProps(); this.renderer.render(); });
        modeRow.appendChild(ml); modeRow.appendChild(ms);
        panel.appendChild(modeRow);

        // Amount source: a fixed number, or a live formula over diagram
        // variables (params, custom vars, published state values).
        const flat = mode === 'step' || mode === 'pulse';
        const useFormula = !!conn.modFormula || conn._modWantFormula;
        const srcRow = document.createElement('div');
        srcRow.className = 'prop-row';
        const sl = document.createElement('label');
        sl.textContent = flat ? 'Amount' : 'Factor';
        const ss = document.createElement('select');
        for (const [v, t] of [['fixed', 'Fixed number'], ['formula', 'Formula']]) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          if ((useFormula ? 'formula' : 'fixed') === v) o.selected = true;
          ss.appendChild(o);
        }
        ss.addEventListener('change', () => {
          if (ss.value === 'fixed') { conn.modFormula = ''; conn._modWantFormula = false; }
          else conn._modWantFormula = true; // remember the choice while the formula is still empty
          this._renderProps(); this.renderer.render();
        });
        srcRow.appendChild(sl); srcRow.appendChild(ss);
        panel.appendChild(srcRow);

        if (useFormula) {
          const fRow = document.createElement('div');
          fRow.className = 'prop-row';
          fRow.appendChild(document.createElement('label'));
          const fi = document.createElement('input');
          fi.type = 'text'; fi.value = conn.modFormula || '';
          fi.placeholder = 'e.g. round(gold * 0.1)';
          fi.addEventListener('input', () => {
            const valid = !fi.value.trim() || validateFormula(fi.value);
            fi.classList.toggle('invalid', !valid);
            if (valid) { conn.modFormula = fi.value.trim(); this.renderer.render(); }
          });
          fRow.appendChild(fi);
          panel.appendChild(fRow);
        } else {
          this._field(panel, '', 'number', conn.modFactor, v => {
            const n = parseFloat(v); conn.modFactor = isFinite(n) ? n : 0; this.renderer.render();
          }, {
            step:  'e.g. 2 = +2 every step',
            pulse: 'e.g. 1 = +1 per firing',
            delta: 'Δtarget = factor × Δsource',
            rate:  'Δ = factor × source / step',
          }[mode]);
        }

        this._info(panel, {
          step:  'Each step, add this amount to the target pool/converter (negative subtracts). Use a formula to compute it from variables, e.g. round(gold * 0.05).',
          pulse: 'Each time the source node fires, add this amount to the target pool/converter (negative subtracts). The easy "+1 when the source triggers".',
          delta: 'When the source value changes, add factor × the change to the target (Machinations-style label modifier).',
          rate:  'Each step, add factor × source value to the target (negative = decay). Self-connections are allowed for interest/decay.',
        }[mode]);

      } else if (role === 'trigger') {
        const onRow = document.createElement('div');
        onRow.className = 'prop-row';
        const ol = document.createElement('label'); ol.textContent = 'On';
        const os = document.createElement('select');
        for (const [v, t] of [['fire', 'Source fires'], ['fail', 'Source fails to act']]) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          if ((conn.reverseTrigger && !conn.trigger ? 'fail' : 'fire') === v) o.selected = true;
          os.appendChild(o);
        }
        os.addEventListener('change', () => {
          conn.trigger = os.value === 'fire';
          conn.reverseTrigger = os.value === 'fail';
          this.renderer.render();
        });
        onRow.appendChild(ol); onRow.appendChild(os);
        panel.appendChild(onRow);

        this._field(panel, 'Chance %', 'number', conn.triggerChance ?? 100, v => {
          const n = parseFloat(v);
          conn.triggerChance = Math.min(100, Math.max(0, isFinite(n) ? n : 100));
          this.renderer.render();
        }, '0–100');
        this._field(panel, 'Every Nth', 'number', conn.triggerEvery ?? 1, v => {
          conn.triggerEvery = Math.max(1, parseInt(v) || 1);
          this.renderer.render();
        }, 'fire target every Nth source firing');
        this._info(panel, '"Source fires": instantly fire the target node when the source fires (cascades, on-demand passive nodes). "Source fails": fire the target when the source could NOT act (pool empty, limited source dry).');

      } else {
        // Activate
        this._conditionRow(panel, 'Condition', conn,
          { enabled: 'activator', op: 'actOperator', val: 'actValue', val2: 'actValue2', lead: 'enable target when source' });
        this._info(panel, 'The target node may only fire while the source value satisfies this condition. The a..b operator is an inclusive range.');
      }
    }
  }

  // ── Props helpers ─────────────────────────────────────────────────────────

  _title(panel, text) {
    const h = document.createElement('h3');
    h.className = 'props-title';
    h.textContent = text;
    panel.appendChild(h);
  }

  // Selection header: a small uppercase kind overline with a type-colored dot,
  // then the element's own name large — "what is it" before "which one".
  _titleTyped(panel, kind, text, color) {
    const wrap = document.createElement('div');
    wrap.className = 'props-title-block';
    const over = document.createElement('div');
    over.className = 'props-overline';
    const dot = document.createElement('span');
    dot.className = 'props-dot';
    dot.style.background = color || 'var(--accent)';
    over.appendChild(dot);
    over.appendChild(document.createTextNode(kind));
    const h = document.createElement('h3');
    h.className = 'props-title';
    h.textContent = text;
    wrap.appendChild(over);
    wrap.appendChild(h);
    panel.appendChild(wrap);
  }

  _info(panel, text) {
    const p = document.createElement('p');
    p.className = 'props-info';
    p.textContent = text;
    panel.appendChild(p);
  }

  _sep(panel) {
    const hr = document.createElement('div');
    hr.className = 'props-sep';
    panel.appendChild(hr);
  }

  // A labelled section header — names the group of controls that follows so
  // the panel reads as a scannable outline instead of anonymous dividers.
  _section(panel, text) {
    const h = document.createElement('div');
    h.className = 'props-sec';
    h.textContent = text;
    panel.appendChild(h);
  }

  // A labelled checkbox row. onChange(checked).
  _checkRow(panel, label, checked, onChange) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.id = this._uid(); lbl.htmlFor = chk.id;
    chk.checked = !!checked;
    chk.addEventListener('change', () => onChange(chk.checked));
    row.appendChild(lbl);
    row.appendChild(chk);
    panel.appendChild(row);
    return chk;
  }

  // A checkbox that reveals an operator + value comparison, editing obj in place.
  // keys = { enabled, op, val, lead }; extraFn(details) may append additional rows.
  _conditionRow(panel, title, obj, keys, extraFn = null) {
    const chk = this._checkRow(panel, title, obj[keys.enabled], v => {
      obj[keys.enabled] = v;
      details.style.display = v ? 'block' : 'none';
      this.renderer.render();
    });

    const details = document.createElement('div');
    details.className = 'cond-details';
    details.style.display = obj[keys.enabled] ? 'block' : 'none';

    const inner = document.createElement('div');
    inner.className = 'prop-row';
    const il = document.createElement('label');
    il.textContent = keys.lead || 'when';

    const op = document.createElement('select');
    const ops = ['>', '>=', '<', '<=', '==', '!='];
    if (keys.val2) ops.push('between');
    for (const o of ops) {
      const e = document.createElement('option');
      e.value = o; e.textContent = o === 'between' ? 'a..b' : o;
      if (o === obj[keys.op]) e.selected = true;
      op.appendChild(e);
    }

    const val = document.createElement('input');
    val.type = 'number';
    val.value = obj[keys.val];
    val.addEventListener('input', () => { obj[keys.val] = parseFloat(val.value) || 0; this.renderer.render(); });

    // Second bound, shown only for the inclusive range operator.
    let val2 = null;
    if (keys.val2) {
      val2 = document.createElement('input');
      val2.type = 'number';
      val2.value = obj[keys.val2] || 0;
      val2.style.display = obj[keys.op] === 'between' ? '' : 'none';
      val2.addEventListener('input', () => { obj[keys.val2] = parseFloat(val2.value) || 0; this.renderer.render(); });
    }

    op.addEventListener('change', () => {
      obj[keys.op] = op.value;
      if (val2) val2.style.display = op.value === 'between' ? '' : 'none';
      this.renderer.render();
    });

    inner.appendChild(il);
    inner.appendChild(op);
    inner.appendChild(val);
    if (val2) inner.appendChild(val2);
    details.appendChild(inner);
    if (extraFn) extraFn(details);
    panel.appendChild(details);
    return chk;
  }

  // Unique id generator for programmatic label↔control association.
  _uid() { return 'fld-' + (App._fieldSeq = (App._fieldSeq || 0) + 1); }

  _field(panel, label, type, value, onChange, placeholder = '') {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = type;
    inp.value = value;
    if (placeholder) inp.placeholder = placeholder;
    if (label) { inp.id = this._uid(); lbl.htmlFor = inp.id; }
    else inp.setAttribute('aria-label', placeholder || 'value');
    inp.addEventListener('input', () => onChange(inp.value));
    row.appendChild(lbl);
    row.appendChild(inp);
    panel.appendChild(row);
    return inp;
  }

  _colorField(panel, label, value, onChange, clearable = false, withTypes = false) {
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = value || '#ffa726';
    picker.style.cssText = 'width:36px;height:28px;padding:1px;border-radius:4px;cursor:pointer;border:1px solid var(--border);background:none;';
    picker.addEventListener('input', () => onChange(picker.value));

    // When named resource types exist, offer a dropdown that sets the colour to
    // the chosen type's colour (the raw picker stays available for custom hues).
    if (withTypes && this.diagram.resourceTypes.length) {
      const trow = document.createElement('div');
      trow.className = 'prop-row';
      const tl = document.createElement('label');
      tl.textContent = 'Type';
      const ts = document.createElement('select');
      ts.style.flex = '1';
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = '— custom —';
      ts.appendChild(blank);
      const cur = value ? String(value).toLowerCase() : '';
      for (const t of this.diagram.resourceTypes) {
        const o = document.createElement('option');
        o.value = t.color; o.textContent = t.name || '(unnamed)';
        if (t.color && t.color.toLowerCase() === cur) o.selected = true;
        ts.appendChild(o);
      }
      ts.addEventListener('change', () => {
        if (ts.value) { picker.value = ts.value; onChange(ts.value); }
      });
      trow.appendChild(tl); trow.appendChild(ts);
      panel.appendChild(trow);
    }

    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    row.appendChild(lbl);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:6px;align-items:center;flex:1;';
    wrap.appendChild(picker);

    if (clearable) {
      const clear = document.createElement('button');
      clear.appendChild(this._faIcon('xmark'));
      clear.setAttribute('aria-label', 'Clear filter');
      clear.className = 'btn';
      clear.style.cssText = 'padding:2px 8px;font-size:11px;';
      clear.title = 'Clear filter (accept any color)';
      clear.addEventListener('click', () => { picker.value = '#ffffff'; onChange(''); });
      wrap.appendChild(clear);
    }

    row.appendChild(wrap);
    panel.appendChild(row);
    return picker;
  }

  _select2(panel, label, options, value, onChange) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const sel = document.createElement('select');
    sel.id = this._uid(); lbl.htmlFor = sel.id;
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
      if (opt === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    row.appendChild(lbl);
    row.appendChild(sel);
    panel.appendChild(row);
    return sel;
  }

  // ── Live update helpers ───────────────────────────────────────────────────

  _refreshResourceCount() {
    if (this._selectedType !== 'node') return;
    const node = this.diagram.nodes.get(this._selectedId);
    if (!node || node.type === NodeType.SOURCE) return;

    if (node.type === NodeType.REGISTER) {
      const rv = document.querySelector('#props-content .reg-value');
      if (rv) rv.textContent = `= ${node.displayCount}`;
      return;
    }

    if (node.type === NodeType.DRAIN) {
      const el = document.querySelector('#props-content .drain-stat');
      if (el) el.textContent = `${node.drained || 0}`;
      return;
    }

    // First number input is always the Resources field.
    const inp = document.querySelector('#props-content input[type="number"]');
    if (inp && document.activeElement !== inp) inp.value = node.resources;
  }

  _updateSparklines() { for (const sl of this._sparklines.values()) sl.update(); }

  _clearSparklines() { for (const sl of this._sparklines.values()) sl.destroy(); this._sparklines.clear(); }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
