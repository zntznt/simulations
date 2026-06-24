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
      { name: 'Barter Economy', desc: 'Two towns swap grain for timber through a Trader; watch the colours mix.', load: () => this._demoTradeNetwork() },
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
      const lib = this._getLibrary();
      lib.push({ name, date: new Date().toLocaleString(), json: this._snapshot() });
      this._saveLibrary(lib);
      document.getElementById('lib-name').value = '';
      this._renderLibraryList();
      this._toast(`Saved “${name}” to your Library`);
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
  }

  _getLibrary() {
    try { return JSON.parse(localStorage.getItem('sim_library') || '[]'); } catch { return []; }
  }

  _saveLibrary(lib) {
    try { localStorage.setItem('sim_library', JSON.stringify(lib)); } catch {}
  }

  // ── Components (reusable subgraphs) ──────────────────────────────────────────

  _getComponents() {
    try { return JSON.parse(localStorage.getItem('sim_components') || '[]'); } catch { return []; }
  }

  _saveComponents(list) {
    try { localStorage.setItem('sim_components', JSON.stringify(list)); } catch {}
  }

  _saveComponent() {
    const ids = new Set(this.editor.selection);
    if (!ids.size) { this._toast('Select nodes first, then click Save component.'); return; }
    const name = document.getElementById('comp-name').value.trim() || 'Untitled';
    const nodes = [...ids].map(id => this.diagram.nodes.get(id)).filter(Boolean).map(n => n.toJSON());
    const conns = [...this.diagram.connections.values()]
      .filter(c => ids.has(c.sourceId) && ids.has(c.targetId)).map(c => c.toJSON());
    const list = this._getComponents();
    list.push({ name, date: new Date().toLocaleString(), nodes, conns });
    this._saveComponents(list);
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
        list.splice(i, 1);
        this._saveComponents(list);
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

  async _loadTemplate(t) {
    if (!await this._confirmGuard(`Load "${t.name}"? Your current diagram will be replaced (Ctrl+Z to undo).`, 'Load template')) return;
    const prev = this._snapshot();
    this._clearAll();
    t.load();
    this.diagram.meta.name = t.name;
    this.diagram.meta.description = t.desc;
    this._applyMeta();
    this._commitReplace(prev);
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
      loadBtn.addEventListener('click', async () => {
        if (!await this._confirmGuard(`Load "${entry.name}"? Your current diagram will be replaced (Ctrl+Z to undo).`, 'Load from library')) return;
        const prev = this._snapshot();
        this._clearAll();
        try {
          this.diagram.loadJSON(JSON.parse(entry.json));
          this._applyMeta();
          this.engine.reset();
          this.renderer.balls.clear();
          this.renderer.flowFx.clear();
          this._clearSparklines();
          this.editor._select(null, null);
          this.renderer.render();
          this.renderer.fitView();
        } catch (err) { alert('Failed to load: ' + err.message); }
        this._commitReplace(prev);
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
}

for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppLibrary.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
