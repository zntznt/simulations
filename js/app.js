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
      if (status) status.textContent = `🏁 ${ended.label} reached ${ended.value} at step ${ended.step}`;
      document.getElementById('btn-run').textContent = '▶ Run';
      this.renderer.render();
    };

    this._initDiagram();
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────────

  _snapshot() { return JSON.stringify(this.diagram.toJSON()); }

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
    const snap = this._snapshot();
    if (snap === this._lastState) return;
    if (this._lastState != null) {
      this._undoStack.push(this._lastState);
      if (this._undoStack.length > 100) this._undoStack.shift();
    }
    this._redoStack = [];
    this._lastState = snap;
    this._updateUndoButtons();
    try { localStorage.setItem('sim_autosave', this._lastState); } catch {}
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
    this.engine.reset();
    document.getElementById('btn-run').textContent = '▶ Run';
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
    this.engine.reset();
    document.getElementById('btn-run').textContent = '▶ Run';
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
        this.engine.reset();
        this.renderer.render();
        this.renderer.fitView();
        this._resetHistory();
        return;
      } catch { /* fall through to example */ }
    }

    const saved = localStorage.getItem('sim_autosave');
    this._demoEcosystem();
    this.renderer.fitView();
    this._resetHistory();
    if (saved) {
      const banner = document.createElement('div');
      banner.id = 'autosave-banner';
      banner.innerHTML = '<span>📂 Autosaved diagram found.</span>';
      const restoreBtn = document.createElement('button');
      restoreBtn.textContent = 'Restore';
      restoreBtn.className = 'btn';
      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.className = 'btn';
      banner.appendChild(restoreBtn);
      banner.appendChild(dismissBtn);
      document.body.appendChild(banner);
      restoreBtn.addEventListener('click', () => {
        banner.remove();
        try {
          this.diagram.loadJSON(JSON.parse(saved));
          this.engine.reset();
          this.renderer.balls.clear();
          this._clearSparklines();
          this.editor._select(null, null);
          this.renderer.render();
          this.renderer.fitView();
          this._resetHistory();
        } catch { alert('Failed to restore autosave.'); }
      });
      dismissBtn.addEventListener('click', () => {
        banner.remove();
        try { localStorage.removeItem('sim_autosave'); } catch {}
      });
    }
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
      });
      pop.addEventListener('click', (e) => {
        if (e.target.closest('.menu-item')) {
          pop.classList.add('hidden');
          btn.setAttribute('aria-expanded', 'false');
        }
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
    ];

    document.getElementById('btn-library').addEventListener('click', () => this._openLibrary());
    document.getElementById('lib-close').addEventListener('click', () =>
      document.getElementById('lib-overlay').classList.add('hidden'));
    document.getElementById('lib-overlay').addEventListener('click', e => {
      if (e.target.id === 'lib-overlay') e.currentTarget.classList.add('hidden');
    });
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
    document.getElementById('lib-overlay').classList.remove('hidden');
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
    this._resetHistory();
    this.renderer.fitView();
    document.getElementById('lib-overlay').classList.add('hidden');
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
          this.engine.reset();
          this.renderer.balls.clear();
          this._clearSparklines();
          this.editor._select(null, null);
          this.renderer.render();
          this.renderer.fitView();
        } catch (err) { alert('Failed to load: ' + err.message); }
        this._resetHistory();
        document.getElementById('lib-overlay').classList.add('hidden');
      });
      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
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

  _exportSVG() {
    const svg = document.getElementById('canvas');
    const data = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([data], { type: 'image/svg+xml' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: 'diagram.svg',
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
        download: 'diagram.png', href: canvas.toDataURL('image/png'),
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
      href: URL.createObjectURL(blob), download: 'history.csv',
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

  _toast(msg) {
    let t = document.getElementById('app-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'app-toast';
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

  // ── Controls ──────────────────────────────────────────────────────────────

  _bindControls() {
    document.getElementById('btn-step').addEventListener('click', () => this.engine.doStep());

    const runBtn = document.getElementById('btn-run');
    runBtn.addEventListener('click', () => {
      if (!this.engine.running) document.getElementById('sim-status').textContent = '';
      this.engine.run();
      runBtn.textContent = this.engine.running ? '⏸ Pause' : '▶ Run';
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
      this.engine.reset();
      document.getElementById('btn-run').textContent = '▶ Run';
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
        document.getElementById('btn-run').textContent = '⏸ Pause';
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
        download: 'diagram.json',
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
      }
    });

    // Monte Carlo batch runs
    document.getElementById('btn-batch').addEventListener('click', () => this._openMonteCarlo());
    document.getElementById('mc-close').addEventListener('click', () =>
      document.getElementById('mc-overlay').classList.add('hidden'));
    document.getElementById('mc-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'mc-overlay') e.currentTarget.classList.add('hidden');
    });
    document.getElementById('mc-run').addEventListener('click', () => this._runMonteCarlo());
  }

  // ── Monte Carlo ─────────────────────────────────────────────────────────────

  _openMonteCarlo() {
    this.engine.stop();
    document.getElementById('btn-run').textContent = '▶ Run';
    document.getElementById('mc-results').innerHTML =
      '<p class="mc-empty">Choose runs &amp; steps, then press Run.</p>';
    document.getElementById('mc-overlay').classList.remove('hidden');
  }

  _runMonteCarlo() {
    const runs = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-runs').value) || 100));
    const steps = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-steps').value) || 200));
    const out = document.getElementById('mc-results');
    out.innerHTML = '<p class="mc-empty">Running…</p>';

    // Defer so the "Running…" message paints before the (synchronous) batch.
    setTimeout(() => {
      const t0 = performance.now();
      const res = this.engine.runMonteCarlo(runs, steps);
      const ms = Math.round(performance.now() - t0);

      let html = `<p class="mc-summary">${res.runs} runs × up to ${res.maxSteps} steps `
        + `<span style="color:var(--text-dim)">(${ms} ms)</span>`;
      if (res.endStep) {
        html += `<br>Goal reached in <b>${Math.round(res.endedRate * 100)}%</b> of runs`
          + ` — end step mean <b>${res.endStep.mean}</b> (min ${res.endStep.min}, max ${res.endStep.max}).`;
      }
      html += '</p>';

      html += '<table><thead><tr><th>Node</th><th>mean</th><th>min</th>'
        + '<th>p10</th><th>p50</th><th>p90</th><th>max</th></tr></thead><tbody>';
      for (const n of res.nodes) {
        html += `<tr><td>${this._esc(n.label || n.type)}</td>`
          + `<td>${n.mean}</td><td>${n.min}</td><td>${n.p10}</td>`
          + `<td>${n.p50}</td><td>${n.p90}</td><td>${n.max}</td></tr>`;
      }
      html += '</tbody></table>';
      out.innerHTML = html;
    }, 30);
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

  // Default panel (nothing selected): a short hint pointing at the diagram rail.
  // Diagram-level settings now live in the right-hand rail, so the
  // properties panel is dedicated to the selected node / connection.
  _diagramProps(panel) {
    this._title(panel, 'Diagram');
    this._info(panel, 'Select a node or connection to edit its properties.');
    this._sep(panel);
    const p = document.createElement('p');
    p.className = 'props-empty';
    p.innerHTML = 'Diagram-wide settings — <b>time mode</b>, <b>parameters</b>, '
      + '<b>variables</b>, <b>resource types</b>, the <b>artificial player</b>, and a '
      + 'live <b>variable watch</b> — are on the rail to the right <span aria-hidden="true">→</span>';
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
    document.querySelectorAll('#diagram-rail .rail-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.feature === this._activeFeature));
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
      delBtn.textContent = '×'; delBtn.className = 'btn';
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
      del.innerHTML = '&times;';
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
      del.textContent = '×'; del.className = 'btn';
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
    this._title(panel, 'Container Group');
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
    this._title(panel, 'Sticky Note');
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

    this._title(panel, 'Chart');
    this._info(panel, 'A live line chart drawn on the canvas. Pick nodes below to plot their values over the run.');
    this._field(panel, 'Title', 'text', chart.label, v => { chart.label = v; this.renderer.render(); });
    this._field(panel, 'Width', 'number', chart.w, v => { chart.w = Math.max(120, parseInt(v) || 240); this.renderer.render(); });
    this._field(panel, 'Height', 'number', chart.h, v => { chart.h = Math.max(80, parseInt(v) || 150); this.renderer.render(); });

    this._sep(panel);
    const stitle = document.createElement('div');
    stitle.className = 'chart-label';
    stitle.textContent = 'Tracked nodes';
    panel.appendChild(stitle);

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
      rm.textContent = '×'; rm.className = 'btn';
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
    this._title(panel, `${node.type.charAt(0).toUpperCase() + node.type.slice(1)} Node`);

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
      for (const [label, delta] of [['−', -1], ['+', 1]]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = 'btn';
        b.style.cssText = 'flex:1;padding:2px 0;font-size:14px;';
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
      stat.textContent = `⇄ ${node.trades || 0}`;
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
      const hlabel = document.createElement('div');
      hlabel.className = 'chart-label'; hlabel.style.marginTop = '12px';
      hlabel.textContent = 'Holdings by type';
      panel.appendChild(hlabel);
      const hc = document.createElement('div');
      hc.className = 'type-readout'; hc.id = 'node-holdings';
      panel.appendChild(hc);
      this._fillHoldings(hc, node);
    }

    // End / goal condition (any node with a numeric value)
    if (node.type !== NodeType.SOURCE) {
      this._sep(panel);
      this._conditionRow(panel, 'End / goal', node,
        { enabled: 'endEnabled', op: 'endOperator', val: 'endValue', lead: 'stop when value' });
      this._info(panel, 'Halt the simulation when this node\'s value meets the condition.');
    }

    // Chart
    if (node.type !== NodeType.SOURCE) {
      const sec = document.createElement('div');
      sec.className = 'chart-section';
      sec.innerHTML = '<div class="chart-label">Resource History</div>';
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
    this._title(panel, `${isRes ? 'Resource' : 'State'} Connection`);

    this._info(panel, `${src?.label || '?'} → ${tgt?.label || '?'}`);

    // Path style selector
    const styleRow = document.createElement('div');
    styleRow.className = 'prop-row';
    const styleLbl = document.createElement('label');
    styleLbl.textContent = 'Style';
    styleRow.appendChild(styleLbl);
    const styleGroup = document.createElement('div');
    styleGroup.className = 'conn-style-group';
    for (const { key, icon, tip } of [
      { key: 'straight', icon: '—', tip: 'Straight line' },
      { key: 'curve',    icon: '⌒', tip: 'Curved — drag handle to reshape' },
      { key: 'ortho',   icon: '⌐', tip: 'Right-angle turns — drag any segment; end segments add bends' },
    ]) {
      const btn = document.createElement('button');
      btn.className = 'conn-style-btn' + ((conn.pathStyle || 'curve') === key ? ' active' : '');
      btn.title = tip;
      btn.textContent = icon;
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
          this._sep(panel);

          this._field(panel, 'Interval', 'number', conn.interval, v => {
            conn.interval = Math.max(1, parseInt(v) || 1);
          }, 'fire every N steps');

          this._field(panel, 'Chance %', 'number', conn.chance, v => {
            const n = parseFloat(v);
            conn.chance = Math.min(100, Math.max(0, isFinite(n) ? n : 100));
            this.renderer.render();
          }, '0–100');

          this._sep(panel);

          this._colorField(panel, 'Color filter', conn.colorFilter || '', v => {
            conn.colorFilter = v;
            this.renderer.render();
          }, true, true);
          this._info(panel, 'Only resources of this color pass. Leave empty for any color.');

          this._sep(panel);

          this._conditionRow(panel, 'Condition', conn,
            { enabled: 'condEnabled', op: 'condOperator', val: 'condValue', lead: 'if source' },
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
      // State connection: variable / trigger / activator (independent roles)
      this._field(panel, 'Variable name', 'text', conn.variableName || conn.label, v => {
        conn.variableName = v; conn.label = v; this.renderer.render();
      }, 'used in register formulas');
      this._info(panel, 'Each step this variable is set to the source\'s value (pool count, source produced, drain consumed, or register value). Use it in Register or rate formulas.');

      this._sep(panel);

      this._checkRow(panel, 'Trigger (✷)', conn.trigger, v => {
        conn.trigger = v; this.renderer.render();
      });
      this._info(panel, 'When the source fires, instantly fire the target node (cascades, pulses, on-demand passive nodes).');

      this._checkRow(panel, 'Fail trigger', conn.reverseTrigger, v => {
        conn.reverseTrigger = v; this.renderer.render();
      });
      this._info(panel, 'Fire the target when the source FAILS to produce output (e.g. pool empty, limited source dry). Opposite of trigger.');

      this._sep(panel);

      this._conditionRow(panel, 'Activator (⊢)', conn,
        { enabled: 'activator', op: 'actOperator', val: 'actValue', lead: 'enable target when source' });
      this._info(panel, 'The target node may only fire while the source value satisfies this condition.');

      this._sep(panel);

      this._checkRow(panel, 'Modifier (Δ)', conn.modifier, v => {
        conn.modifier = v; this._renderProps(); this.renderer.render();
      });
      if (conn.modifier) {
        this._field(panel, 'Factor', 'number', conn.modFactor, v => {
          const n = parseFloat(v); conn.modFactor = isFinite(n) ? n : 0; this.renderer.render();
        }, 'Δ = factor × source / step');
      }
      this._info(panel, 'Each step, add factor × source value to the target pool/converter (negative = decay). Self-connections are allowed for interest/decay.');
    }
  }

  // ── Props helpers ─────────────────────────────────────────────────────────

  _title(panel, text) {
    const h = document.createElement('h3');
    h.className = 'props-title';
    h.textContent = text;
    panel.appendChild(h);
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

  // A labelled checkbox row. onChange(checked).
  _checkRow(panel, label, checked, onChange) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const chk = document.createElement('input');
    chk.type = 'checkbox';
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
    for (const o of ['>', '>=', '<', '<=', '==', '!=']) {
      const e = document.createElement('option');
      e.value = o; e.textContent = o;
      if (o === obj[keys.op]) e.selected = true;
      op.appendChild(e);
    }
    op.addEventListener('change', () => { obj[keys.op] = op.value; this.renderer.render(); });

    const val = document.createElement('input');
    val.type = 'number';
    val.value = obj[keys.val];
    val.addEventListener('input', () => { obj[keys.val] = parseFloat(val.value) || 0; this.renderer.render(); });

    inner.appendChild(il);
    inner.appendChild(op);
    inner.appendChild(val);
    details.appendChild(inner);
    if (extraFn) extraFn(details);
    panel.appendChild(details);
    return chk;
  }

  _field(panel, label, type, value, onChange, placeholder = '') {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = type;
    inp.value = value;
    if (placeholder) inp.placeholder = placeholder;
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
      clear.textContent = '✕';
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
