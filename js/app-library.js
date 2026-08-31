// Library, components, and starter templates.
//
// These methods were split out of app.js to keep the App class manageable.
// They are mixed onto App.prototype below, so every call site is unchanged
// (this._x(), window.app._x()). Load order in index.html: after app.js, which
// defines class App; the DOMContentLoaded handler that does `new App()` runs
// only after every sync <script> has executed, so the prototype is complete
// by construction time.

class AppLibrary {
  // ── Library (multiple named diagrams) ──────────────────────────────────────

  _initLibrary() {
    // Starter templates live in the Library now (no separate dropdown). Each
    // entry builds a sample diagram via its existing loader.
    this._templates = [
      { name: 'Predator & Prey', desc: 'Two populations lock into a self-sustaining oscillation, a stable limit cycle.', load: () => this._demoEcosystem() },
      { name: 'Epidemic (SIR)', desc: 'The outbreak curve: infections peak as Rₑ falls through 1, then fade.', load: () => this._demoEpidemic() },
      { name: 'Supply Chain', desc: 'A 2:1 smelter and a shipping delay produce pipeline latency, then steady output.', load: () => this._demoSupplyChain() },
      { name: 'Barter Economy', desc: 'Two towns swap grain for timber through a Trader; watch the colors mix.', load: () => this._demoTradeNetwork() },
      { name: 'Service Desk', desc: 'A single-server queue with random arrivals. The line builds and clears.', load: () => this._demoQueue() },
      { name: 'F2P Mobile Economy', desc: 'A sprawling free-to-play live-ops loop: energy→levels→Gold/XP, a sqrt level curve gating Elite content, a probabilistic gacha gate, and a DAU/IAP economy.', load: () => this._demoF2P() },
      { name: 'Civilization Empire', desc: 'A 4X economy in one diagram: logistic population, five yields, building converters, and a Science-gated tech tree (irrigation, drama, banking, university).', load: () => this._demoCiv() },
      { name: 'Megafactory Line', desc: 'A 4-tier auto-factory: ore → smelting → components → widgets. A tiny circuit buffer and a slow assembly station back the line up. Watch the bottleneck.', load: () => this._demoFactory() },
      { name: 'Business Cycle', desc: 'A full circular-flow macroeconomy with households, firms, banks, government and a central bank. Countercyclical stimulus through a policy lag drives a boom-bust cycle.', load: () => this._demoBusinessCycle() },
      { name: 'Food Web', desc: 'A four-trophic ecosystem: producers, grazers, carnivores, an apex predator and a nutrient-recycling loop. Ten species lock into coupled, bounded oscillations.', load: () => this._demoFoodWeb() },
      { name: 'Auction Economy', desc: 'A player-driven MMO economy: gather, refine and craft goods, then watch the auction house prices and stocks oscillate as supply meets price-elastic demand.', load: () => this._demoAuction() },
    ];

    document.getElementById('btn-library').addEventListener('click', () => this._openLibrary());
    document.getElementById('lib-close').addEventListener('click', () => this._hideModal('lib-overlay'));
    document.getElementById('lib-overlay').addEventListener('click', e => {
      if (e.target.id === 'lib-overlay') this._hideModal('lib-overlay');
    });
    this._modalize('lib-overlay');
    document.getElementById('lib-save').addEventListener('click', () => {
      const name = document.getElementById('lib-name').value.trim() || 'Untitled';
      // Capture a small canvas snapshot so the row is recognisable at a glance
      // (15b). Falls back to a blank thumb when rasterizing is unavailable.
      this._captureThumbnail((thumb) => {
        // Fresh read, so a save here does not drop what another tab added.
        const lib = this._getLibrary();
        const entry = { id: this._entryKey(), name, date: new Date().toLocaleString(), json: this._snapshot(), nodes: this.diagram.nodes.size };
        if (thumb) entry.thumb = thumb;
        lib.push(entry);
        if (!this._saveLibrary(lib)) {
          // Thumbnails are the bulkiest part of an entry; retry without one
          // before declaring storage full.
          delete entry.thumb;
          if (!this._saveLibrary(lib)) {
            this._toast(`Could not save "${name}". Browser storage is full or blocked.`);
            return;
          }
        }
        document.getElementById('lib-name').value = '';
        this._renderLibraryList();
        this._toast(`Saved "${name}" to your Library`);
      });
    });
    document.getElementById('comp-save').addEventListener('click', () => this._saveComponent());
    // Enter in either name field commits its save, so the right-click
    // "Save as component…" flow is type-name-then-Enter.
    document.getElementById('comp-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._saveComponent(); }
    });
    document.getElementById('lib-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('lib-save').click(); }
    });

    // Tabs: one focused list per view. Counts update on every open/save.
    for (const key of ['mine', 'components', 'templates']) {
      document.getElementById(`lib-tab-${key}`)
        .addEventListener('click', () => this._setLibraryTab(key));
    }
  }

  _setLibraryTab(key) {
    this._libTab = key;
    for (const k of ['mine', 'components', 'templates']) {
      const active = k === key;
      const tab = document.getElementById(`lib-tab-${k}`);
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      document.getElementById(`lib-pane-${k}`).classList.toggle('hidden', !active);
    }
  }

  _updateLibraryCounts() {
    const set = (k, n) => { document.getElementById(`lib-count-${k}`).textContent = n ? String(n) : ''; };
    set('mine', this._getLibrary().length);
    set('components', this._getComponents().length);
    set('templates', this._templates.length);
  }

  _getLibrary() {
    try { return JSON.parse(localStorage.getItem('sim_library') || '[]'); } catch { return []; }
  }

  // A stable per-entry key so an edit can find its target in a list another tab
  // may have changed since this one was rendered.
  _entryKey() {
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Apply an edit against what storage holds RIGHT NOW, not the array this list
  // was rendered from. Delete, Duplicate and Rename each wrote back the snapshot
  // taken when the list was drawn, so a diagram another tab had saved since was
  // erased along with the edit. Entries are located by id, falling back to a
  // content match for rows saved before ids existed.
  _mutateStore(get, save, entry, index, fn, label) {
    const fresh = get.call(this);
    let i = -1;
    if (entry && entry.id) i = fresh.findIndex(e => e && e.id === entry.id);
    if (i < 0 && entry) {
      i = fresh.findIndex(e => e && e.name === entry.name && e.date === entry.date && e.json === entry.json);
    }
    if (i < 0 && index != null && index >= 0 && index < fresh.length) i = index;
    if (i < 0) {
      this._toast('That entry is no longer there. It may have been changed in another tab.');
      return false;
    }
    fn(fresh, i);
    if (!save.call(this, fresh)) {
      this._toast(`Could not update ${label}. Browser storage is full or blocked.`);
      return false;
    }
    return true;
  }

  // Returns false when the write fails (storage full or blocked) so callers
  // can tell the user instead of toasting a false "Saved".
  _saveLibrary(lib) {
    try { localStorage.setItem('sim_library', JSON.stringify(lib)); return true; } catch { return false; }
  }

  // ── Components (reusable subgraphs) ──────────────────────────────────────────

  _getComponents() {
    try { return JSON.parse(localStorage.getItem('sim_components') || '[]'); } catch { return []; }
  }

  // Same contract as _saveLibrary: false = the write did not stick.
  _saveComponents(list) {
    try { localStorage.setItem('sim_components', JSON.stringify(list)); return true; } catch { return false; }
  }

  _saveComponent() {
    const ids = new Set(this.editor.selection);
    if (!ids.size) { this._toast('Select nodes first, then click Save component.'); return; }
    const name = document.getElementById('comp-name').value.trim() || 'Untitled';
    const nodes = [...ids].map(id => this.diagram.nodes.get(id)).filter(Boolean).map(n => n.toJSON());
    const conns = [...this.diagram.connections.values()]
      .filter(c => ids.has(c.sourceId) && ids.has(c.targetId)).map(c => c.toJSON());
    // Fresh read, so a save here does not drop what another tab added.
    const list = this._getComponents();
    list.push({ id: this._entryKey(), name, date: new Date().toLocaleString(), nodes, conns });
    if (!this._saveComponents(list)) {
      this._toast(`Could not save "${name}". Browser storage is full or blocked.`);
      return;
    }
    document.getElementById('comp-name').value = '';
    this._renderComponentsList();
    this._toast(`Saved "${name}" as a component`);
  }

  _insertComponent(comp) {
    const idMap = new Map();
    const newIds = [];
    for (const nd of comp.nodes) {
      const node = new MNode(nd.type, nd.x + 40, nd.y + 40);
      node.loadJSON({ ...nd, id: node.id, x: nd.x + 40, y: nd.y + 40 });
      this.diagram.addNode(node);
      idMap.set(nd.id, node.id);
      newIds.push(node.id);
    }
    for (const cd of comp.conns) {
      const sId = idMap.get(cd.sourceId), tId = idMap.get(cd.targetId);
      if (!sId || !tId) continue;
      const conn = new MConnection(sId, tId, cd.type);
      conn.loadJSON({ ...cd, id: conn.id, sourceId: sId, targetId: tId });
      this.diagram.addConnection(conn);
    }
    this.renderer.render();
    this.editor._setSelection(newIds, newIds.length === 1 ? newIds[0] : null, 'node');
    this._commit();
    this._hideModal('lib-overlay');
    this._toast(`Inserted "${comp.name}"`);
  }

  _renderComponentsList() {
    const list = this._getComponents();
    const el = document.getElementById('lib-components');
    this._updateLibraryCounts();
    el.innerHTML = '';
    if (!list.length) {
      el.innerHTML = '<p class="mc-empty">No components yet. Select nodes on the canvas, then click Save component.</p>';
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const comp = list[i];
      const row = document.createElement('div');
      row.className = 'lib-row';
      const info = document.createElement('div');
      info.className = 'lib-info';
      const nn = comp.nodes.length, cn = comp.conns.length;
      info.innerHTML = `<b>${this._esc(comp.name)}</b> <span class="lib-date">${this._esc(comp.date)}</span>`
        + `<span class="lib-desc">${nn} node${nn !== 1 ? 's' : ''}, ${cn} connection${cn !== 1 ? 's' : ''}</span>`;
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
      const insertBtn = document.createElement('button');
      insertBtn.textContent = 'Insert';
      insertBtn.className = 'btn btn-primary';
      insertBtn.addEventListener('click', () => this._insertComponent(comp));
      const delBtn = document.createElement('button');
      delBtn.appendChild(this._faIcon('xmark'));
      delBtn.setAttribute('aria-label', 'Delete component');
      delBtn.className = 'btn';
      delBtn.addEventListener('click', () => {
        this._mutateStore(this._getComponents, this._saveComponents, comp, i,
          (l, at) => l.splice(at, 1), 'components');
        this._renderComponentsList();
      });
      btns.appendChild(insertBtn);
      btns.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(btns);
      el.appendChild(row);
    }
  }

  _openLibrary() {
    this._renderTemplates();
    this._renderComponentsList();
    this._renderLibraryList();
    this._updateLibraryCounts();
    // First run (nothing saved yet) opens on Templates; otherwise keep the
    // last-used tab, defaulting to the user's own diagrams.
    this._setLibraryTab(this._libTab || (this._getLibrary().length ? 'mine' : 'templates'));
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

  // Swap the current diagram for a starter template. Shared with _loadDemo so
  // the two cannot drift; each caller adds its own last step.
  _installTemplate(t) {
    const prev = this._snapshot();
    this._clearAll();
    t.load();
    this.diagram.meta.name = t.name;
    this.diagram.meta.description = t.desc;
    this._applyMeta();
    // Reset AFTER the template has built its nodes, not before. _clearAll resets
    // too, but that runs against an empty diagram, so the step-0 baseline it
    // records holds nothing. Leaving it that way meant the first point of every
    // chart was a hole: run a freshly loaded template and the series began at
    // step 1, so the starting amounts never plotted and spike attribution had no
    // "from" value for the first step.
    this.engine.reset();
    this._commitReplace(prev);
    this.renderer.fitView();
  }

  async _loadTemplate(t) {
    if (!await this._confirmGuard(`Load "${t.name}"? Your current diagram will be replaced (Ctrl+Z to undo).`, 'Load template')) return;
    this._installTemplate(t);
    this._hideModal('lib-overlay');
  }

  _renderLibraryList() {
    const lib = this._getLibrary();
    const el = document.getElementById('lib-list');
    this._updateLibraryCounts();
    el.innerHTML = '';
    if (!lib.length) {
      el.innerHTML = '<p class="mc-empty">No saved diagrams yet. Save the current diagram with a name above.</p>';
      return;
    }
    for (let i = 0; i < lib.length; i++) {
      const entry = lib[i];
      const row = document.createElement('div');
      row.className = 'lib-row';

      // Thumbnail (44×30) makes each saved diagram recognisable (15b).
      const thumb = document.createElement('div');
      thumb.className = 'lib-thumb';
      if (entry.thumb) {
        const img = document.createElement('img');
        img.src = entry.thumb; img.alt = '';
        thumb.appendChild(img);
      }
      row.appendChild(thumb);

      const info = document.createElement('div');
      info.className = 'lib-info';
      const sub = entry.nodes != null
        ? `${entry.nodes} node${entry.nodes !== 1 ? 's' : ''} · ${this._esc(entry.date)}`
        : this._esc(entry.date);
      info.innerHTML = `<b>${this._esc(entry.name)}</b><span class="lib-date">${sub}</span>`;
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.className = 'btn';
      loadBtn.addEventListener('click', () => this._loadLibraryEntry(entry));

      // Row overflow: the less-common per-entry actions live behind "…" (15b).
      const moreBtn = document.createElement('button');
      moreBtn.appendChild(this._faIcon('ellipsis'));
      moreBtn.setAttribute('aria-label', `More actions for "${entry.name}"`);
      moreBtn.className = 'btn';
      moreBtn.addEventListener('click', (e) => {
        const r = moreBtn.getBoundingClientRect();
        this._openMenu(r.left, r.bottom + 4, (add, sep) => {
          add('Rename…', 'pen', () => this._renameLibraryEntry(row, entry, i));
          add('Duplicate', 'clone', () => {
            const copy = { ...entry, id: this._entryKey(), name: `${entry.name} copy`, date: new Date().toLocaleString() };
            this._mutateStore(this._getLibrary, this._saveLibrary, entry, i,
              (list, at) => list.splice(at + 1, 0, copy), 'the Library');
            this._renderLibraryList();
          });
          add('Export as JSON', 'download', () => {
            const a = Object.assign(document.createElement('a'), {
              href: URL.createObjectURL(new Blob([entry.json], { type: 'application/json' })),
              download: `${(entry.name || 'diagram').replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'diagram'}.json`,
            });
            a.click();
          });
          sep();
          add('Delete', 'trash-can', () => {
            this._mutateStore(this._getLibrary, this._saveLibrary, entry, i,
              (list, at) => list.splice(at, 1), 'the Library');
            this._renderLibraryList();
          }, { danger: true });
        });
        e.stopPropagation();
      });

      btns.appendChild(loadBtn);
      btns.appendChild(moreBtn);
      row.appendChild(info);
      row.appendChild(btns);
      el.appendChild(row);
    }
  }

  async _loadLibraryEntry(entry) {
    if (!await this._confirmGuard(`Load "${entry.name}"? Your current diagram will be replaced (Ctrl+Z to undo).`, 'Load from library')) return;
    // Parse + validate on a throwaway Diagram BEFORE wiping the current
    // one, so a corrupt entry can't leave a wrecked diagram behind.
    let data;
    try {
      data = JSON.parse(entry.json);
      new Diagram().loadJSON(data);
    } catch (err) {
      this._toast(`Could not load "${entry.name}": ${err.message}. Your current diagram is unchanged.`);
      return;
    }
    const prev = this._snapshot();
    this._clearAll();
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
    this._hideModal('lib-overlay');
  }

  // Rename in place: the row's name swaps for an input; Enter or blur commits,
  // Escape cancels. No native prompt() — matches the app's styled dialogs rule.
  _renameLibraryEntry(row, entry, index) {
    const nameEl = row.querySelector('.lib-info b');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = entry.name;
    input.className = 'wide-input';
    input.style.marginBottom = '0';
    input.setAttribute('aria-label', 'New name');
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== entry.name) {
        this._mutateStore(this._getLibrary, this._saveLibrary, entry, index,
          (list, at) => { list[at].name = name; }, 'the Library');
      }
      this._renderLibraryList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
  }
}

for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppLibrary.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
