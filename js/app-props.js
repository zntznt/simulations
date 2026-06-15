// Properties panel and the diagram-rail feature editors.
//
// These methods were split out of app.js to keep the App class manageable.
// They are mixed onto App.prototype below, so every call site is unchanged
// (this._x(), window.app._x()). Load order in index.html: after app.js, which
// defines class App; the DOMContentLoaded handler that does `new App()` runs
// only after every sync <script> has executed, so the prototype is complete
// by construction time.

class AppProps {
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
        this._title(panel, meta.title, meta.kb);
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
      time:      { title: 'Time Mode',        kb: 'time-modes',        render: c => this._timeModeEditor(c) },
      params:    { title: 'Parameters',       kb: 'params',            render: c => this._paramsEditor(c) },
      vars:      { title: 'Custom Variables', kb: 'custom-vars',       render: c => this._customVarsEditor(c) },
      resources: { title: 'Resource Types',   kb: 'resource-types',    render: c => this._resourceTypesEditor(c) },
      player:    { title: 'Artificial Player', kb: 'artificial-player', render: c => this._diagramAI(c) },
      branches:  { title: 'Scenario Branches', kb: 'scenarios',         render: c => this._branchesPanel(c) },
      monitor:   { title: 'Live Variables',   kb: 'live-vars',         render: c => this._liveVarsReadout(c) },
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
    this.renderer.flowFx.clear();
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

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add Parameter';
    addBtn.className = 'btn var-add-btn';
    addBtn.addEventListener('click', () => {
      let k = 'param' + (Object.keys(params).length + 1);
      while (params[k] !== undefined) k += '_';
      params[k] = 0;
      this._renderProps();
      this._commit();
    });
    panel.appendChild(addBtn);
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
      del.textContent = 'Delete rule'; del.className = 'btn'; del.style.flex = '1';
      del.addEventListener('click', () => { ai.rules.splice(i, 1); this._renderProps(); this._commit(); });
      delRow.appendChild(del); box.appendChild(delRow);

      panel.appendChild(box);
    });

    const add = document.createElement('button');
    add.textContent = '+ Add rule'; add.className = 'btn var-add-btn';
    add.disabled = !interactives.length;
    add.addEventListener('click', () => {
      ai.rules.push({
        nodeId: interactives[0] ? interactives[0].id : '',
        mode: 'interval', every: 5, condVar: '', condOp: '>=', condValue: 0,
      });
      this._renderProps(); this._commit();
    });
    panel.appendChild(add);
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

    const add = document.createElement('button');
    add.textContent = '+ Add Resource Type'; add.className = 'btn var-add-btn';
    add.addEventListener('click', () => {
      const swatches = ['#ffd700', '#8d6e63', '#4caf50', '#42a5f5', '#ef5350', '#ab47bc', '#ff7043', '#26c6da'];
      types.push({ name: 'Type ' + (types.length + 1), color: swatches[types.length % swatches.length] });
      this._renderProps(); this._commit();
    });
    panel.appendChild(add);

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

  // Live queue metrics (throughput, waiting time, peak line). Refreshed each
  // step from the queue's runtime fields; "—" until the first unit is served.
  _fillQueueMetrics(container, node) {
    const inService = (node._procs || []).length;
    const waiting = (node._fifo || []).reduce((s, it) => s + (it.amount || 0), 0);
    const processed = node.processed || 0;
    const avgWait = processed > 0 ? Math.round((node.totalWait || 0) / processed * 100) / 100 : 0;
    const rows = [
      ['In service', String(inService)],
      ['Waiting in line', String(waiting)],
      ['Processed', String(processed)],
      ['Avg wait', processed > 0 ? `${avgWait} steps` : '—'],
      ['Max wait', processed > 0 ? `${node.maxWait || 0} steps` : '—'],
      ['Peak line', String(node.maxLen || 0)],
    ];
    if (node.maxLine > 0) rows.push(['Balked (line full)', String(node.balked || 0)]);
    if (node.patience > 0) rows.push(['Reneged (gave up)', String(node.reneged || 0)]);
    container.innerHTML = '';
    for (const [label, val] of rows) {
      const row = document.createElement('div');
      row.className = 'queue-stat-row';
      const l = document.createElement('span'); l.className = 'queue-stat-label'; l.textContent = label;
      const v = document.createElement('span'); v.className = 'queue-stat-val'; v.textContent = val;
      row.appendChild(l); row.appendChild(v);
      container.appendChild(row);
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
    const qmEl = document.getElementById('queue-metrics');
    if (qmEl && this._selectedType === 'node') {
      const node = this.diagram.nodes.get(this._selectedId);
      if (node && node.type === NodeType.QUEUE) this._fillQueueMetrics(qmEl, node);
    }
    const totEl = document.getElementById('diagram-totals');
    if (totEl) this._fillTotals(totEl);
  }

  _groupProps(panel, group) {
    this._titleTyped(panel, 'Container group', group.label || '(unnamed)', group.color || '#4a9eff', 'groups-notes');
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
    this._titleTyped(panel, 'Annotation', 'Sticky note', note.color || '#f6e05e', 'groups-notes');
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

    this._titleTyped(panel, 'Canvas widget', chart.label || 'Chart', '#26c6da', 'canvas-charts');
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
    this._titleTyped(panel, `${node.type} node`, node.label || '(unnamed)', typeColor, `node-${node.type}`);

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
        v => { node.processTime = Math.max(1, parseInt(v) || 1); }, 'steps per unit, per server');
      this._field(panel, 'Servers', 'number', node.servers || 1,
        v => { node.servers = Math.max(1, parseInt(v) || 1); this.renderer.render(); }, 'units served at once');
      this._info(panel, 'A single FIFO line feeding one or more servers. Each server takes "Process time" steps per unit, so throughput is servers ÷ process-time. One server is the classic single-lane bottleneck; add servers for parallel lanes that share the one line.');
      this._field(panel, 'Max line', 'number', node.maxLine || 0,
        v => { node.maxLine = Math.max(0, parseInt(v) || 0); this.renderer.render(); }, '0 = unlimited; arrivals balk when full');
      this._field(panel, 'Patience', 'number', node.patience || 0,
        v => { node.patience = Math.max(0, parseInt(v) || 0); }, '0 = infinite; steps before a waiting unit gives up');
      this._info(panel, 'Model lost demand: with a Max line, arrivals that find the line full are turned away (balk); with a Patience, a unit that waits that many steps without a server gives up (renege). Both are counted as losses below. (This drops the units, unlike a Capacity, which makes the source hold them and retry.)');
      const qm = document.createElement('div');
      qm.className = 'type-readout queue-metrics'; qm.id = 'queue-metrics';
      panel.appendChild(qm);
      this._fillQueueMetrics(qm, node);
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

      this._formulaField(panel, node.formula,
        v => { node.formula = v; this.renderer.render(); },
        { showTip: false });

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
      `${src?.label || '?'} → ${tgt?.label || '?'}`, isRes ? '#ffa726' : '#78909c',
      isRes ? 'conn-resource' : 'conn-state');

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

      const rateField = () => {
        const inp = this._field(panel, 'Rate', 'number', conn.rate, v => {
          const n = parseFloat(v); conn.rate = isFinite(n) ? Math.max(0, n) : 0; this.renderer.render();
        });
        inp.setAttribute('data-tour', 'rate'); // lets the onboarding tour spotlight the Rate field
        return inp;
      };

      if (traderSide) {
        this._info(panel, tgt && tgt.type === NodeType.TRADER
          ? 'Trade route (into the trader): the rate is what this partner pays per exchange.'
          : 'Trade route (out of the trader): the rate is what this partner pays back per exchange.');
      }

      if (fromGate) {
        // Gates distribute by weight only; rate/timing/filter don't apply. The
        // weight may be a fixed number or a live formula over diagram variables
        // (so the split can shift with simulation state), mirroring formula rates.
        const useFormula = !!conn.weightFormula || conn._weightWantFormula;
        const srcRow = document.createElement('div');
        srcRow.className = 'prop-row';
        const sl = document.createElement('label'); sl.textContent = 'Weight';
        const ss = document.createElement('select');
        for (const [v, t] of [['fixed', 'Fixed number'], ['formula', 'Formula']]) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          if ((useFormula ? 'formula' : 'fixed') === v) o.selected = true;
          ss.appendChild(o);
        }
        ss.addEventListener('change', () => {
          if (ss.value === 'fixed') { conn.weightFormula = ''; conn._weightWantFormula = false; }
          else conn._weightWantFormula = true; // remember the choice while the formula is still empty
          this._renderProps(); this.renderer.render();
        });
        srcRow.appendChild(sl); srcRow.appendChild(ss);
        panel.appendChild(srcRow);

        if (useFormula) {
          const fRow = document.createElement('div');
          fRow.className = 'prop-row';
          fRow.appendChild(document.createElement('label'));
          const fi = document.createElement('input');
          fi.type = 'text'; fi.value = conn.weightFormula || '';
          fi.placeholder = 'e.g. difficulty * 10';
          fi.addEventListener('input', () => {
            const valid = !fi.value.trim() || validateFormula(fi.value);
            fi.classList.toggle('invalid', !valid);
            if (valid) { conn.weightFormula = fi.value.trim(); this.renderer.render(); }
          });
          fRow.appendChild(fi);
          panel.appendChild(fRow);
        } else {
          this._field(panel, '', 'number', conn.weight, v => {
            const n = parseFloat(v); conn.weight = isFinite(n) ? Math.max(0, n) : 0; this.renderer.render();
          }, 'output share (0 = off)');
        }
        this._info(panel, 'Share of the gate\'s resources routed down this output (deterministic split or weighted chance). A formula is re-evaluated each step, so the split can track variables (e.g. difficulty, gold).');
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
          this._formulaField(panel, conn.formula, v => {
            conn.formula = v; this.renderer.render();
          });
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
}

for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppProps.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
