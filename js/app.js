class App {
  constructor() {
    this.diagram = new Diagram();
    this.engine = new SimEngine(this.diagram);
    this.renderer = new Renderer(document.getElementById('canvas'), this.diagram);
    this.editor = new Editor(
      document.getElementById('canvas'),
      this.diagram, this.renderer, this.engine,
      (id, type) => this._onSelect(id, type),
    );

    this._selectedId = null;
    this._selectedType = null;
    this._sparklines = new Map();

    this._bindControls();

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
      this._refreshResourceCount();
    };

    this._loadExample();
  }

  // ── Example diagram ───────────────────────────────────────────────────────

  _loadExample() {
    const src = this.diagram.addNode(new MNode(NodeType.SOURCE, 200, 300));
    src.label = 'Gold Source';
    src.resourceColor = '#ffd700';

    const pool = this.diagram.addNode(new MNode(NodeType.POOL, 400, 300));
    pool.label = 'Treasury';

    const drain = this.diagram.addNode(new MNode(NodeType.DRAIN, 620, 300));
    drain.label = 'Upkeep';

    const c1 = this.diagram.addConnection(new MConnection(src.id, pool.id));
    c1.rate = 3;

    const c2 = this.diagram.addConnection(new MConnection(pool.id, drain.id));
    c2.rate = 1;

    const gate = this.diagram.addNode(new MNode(NodeType.GATE, 400, 460));
    gate.label = 'Split';

    const pool2 = this.diagram.addNode(new MNode(NodeType.POOL, 280, 580));
    pool2.label = 'Pool A';

    const pool3 = this.diagram.addNode(new MNode(NodeType.POOL, 520, 580));
    pool3.label = 'Pool B';

    const cg = this.diagram.addConnection(new MConnection(pool.id, gate.id));
    cg.rate = 2;
    this.diagram.addConnection(new MConnection(gate.id, pool2.id));
    this.diagram.addConnection(new MConnection(gate.id, pool3.id));

    // Register example
    const reg = this.diagram.addNode(new MNode(NodeType.REGISTER, 620, 460));
    reg.label = 'Total';
    reg.formula = 'treasury + 0';

    const sc = this.diagram.addConnection(new MConnection(pool.id, reg.id, ConnectionType.STATE));
    sc.variableName = 'treasury';
    sc.label = 'treasury';

    this.renderer.render();
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  _bindControls() {
    document.getElementById('btn-step').addEventListener('click', () => this.engine.doStep());

    const runBtn = document.getElementById('btn-run');
    runBtn.addEventListener('click', () => {
      this.engine.run();
      runBtn.textContent = this.engine.running ? '⏸ Pause' : '▶ Run';
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
      this.engine.reset();
      document.getElementById('btn-run').textContent = '▶ Run';
      this.renderer.balls.clear();
      this._clearSparklines();
      this.renderer.render();
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
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.editor.setTool(btn.dataset.tool);
      });
    });

    document.getElementById('btn-new').addEventListener('click', () => {
      if (!confirm('Start a new diagram? Unsaved work will be lost.')) return;
      this.diagram.nodes.clear();
      this.diagram.connections.clear();
      this.diagram.variables = {};
      this.engine.reset();
      this._clearSparklines();
      this._onSelect(null, null);
      this.renderer.render();
    });

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
            this._clearSparklines();
            this._onSelect(null, null);
            this.renderer.render();
          } catch (err) { alert('Invalid file: ' + err.message); }
        };
        reader.readAsText(file);
      };
      inp.click();
    });
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  _onSelect(id, type) {
    this._selectedId = id;
    this._selectedType = type;
    this._renderProps();
  }

  // ── Properties panel ──────────────────────────────────────────────────────

  _renderProps() {
    const panel = document.getElementById('props-content');
    panel.innerHTML = '';
    this._clearSparklines();

    if (!this._selectedId) {
      panel.innerHTML = '<p class="props-empty">Select a node or connection to edit properties.</p>';
      return;
    }

    if (this._selectedType === 'node') {
      const node = this.diagram.nodes.get(this._selectedId);
      if (node) this._nodeProps(panel, node);
    } else if (this._selectedType === 'conn') {
      const conn = this.diagram.connections.get(this._selectedId);
      if (conn) this._connProps(panel, conn);
    }
  }

  _nodeProps(panel, node) {
    this._title(panel, `${node.type.charAt(0).toUpperCase() + node.type.slice(1)} Node`);

    this._field(panel, 'Label', 'text', node.label, v => { node.label = v; this.renderer.render(); });

    // Type-specific fields
    if (node.type === NodeType.SOURCE) {
      this._colorField(panel, 'Resource Color', node.resourceColor || '#ffa726', v => {
        node.resourceColor = v; this.renderer.render();
      });
    }

    if (node.type !== NodeType.SOURCE && node.type !== NodeType.REGISTER) {
      this._field(panel, 'Resources', 'number', node.resources, v => {
        const n = Math.max(0, parseInt(v) || 0);
        node.resources = n;
        node._initialResources = n;
        node.renderer?.render();
        this.renderer.render();
      });
    }

    if (node.type === NodeType.POOL) {
      this._field(panel, 'Capacity', 'text', node.capacity === Infinity ? '' : node.capacity,
        v => { node.capacity = v === '' || v === '∞' ? Infinity : (parseInt(v) || Infinity); },
        '∞ = unlimited');
    }

    if (node.type === NodeType.DELAY) {
      this._field(panel, 'Delay steps', 'number', node.delay, v => { node.delay = Math.max(1, parseInt(v) || 1); });
    }

    if (node.type === NodeType.GATE) {
      this._select2(panel, 'Gate mode', ['deterministic', 'random'], node.gateMode,
        v => { node.gateMode = v; });
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

    this._select2(panel, 'Activation', Object.values(ActivationMode), node.activation,
      v => { node.activation = v; this.renderer.render(); });

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

    this._field(panel, 'Label', 'text', conn.label, v => { conn.label = v; this.renderer.render(); });

    if (isRes) {
      // Rate mode
      this._select2(panel, 'Rate mode', Object.values(RateMode), conn.rateMode, v => {
        conn.rateMode = v;
        this._renderProps(); // re-render props to show/hide relevant fields
      });

      if (conn.rateMode === RateMode.FIXED) {
        this._field(panel, 'Rate', 'number', conn.rate, v => {
          conn.rate = parseFloat(v) || 1; this.renderer.render();
        });
      } else if (conn.rateMode === RateMode.DICE) {
        this._field(panel, 'Dice', 'text', conn.dice, v => {
          conn.dice = v; this.renderer.render();
        }, '1d6, 2d4, 3d10…');
      } else if (conn.rateMode === RateMode.FORMULA) {
        this._field(panel, 'Formula', 'text', conn.formula, v => {
          conn.formula = v; this.renderer.render();
        }, 'e.g. treasury * 0.1');
      }

      this._sep(panel);

      this._field(panel, 'Interval', 'number', conn.interval, v => {
        conn.interval = Math.max(1, parseInt(v) || 1);
      }, 'fire every N steps');

      this._field(panel, 'Chance %', 'number', conn.chance, v => {
        conn.chance = Math.min(100, Math.max(0, parseFloat(v) || 100));
      }, '0–100');

      this._sep(panel);

      this._colorField(panel, 'Color filter', conn.colorFilter || '', v => {
        conn.colorFilter = v;
        this.renderer.render();
      }, true);
      this._info(panel, 'Only resources of this color pass. Leave empty for any color.');

      this._sep(panel);

      // Condition
      const condRow = document.createElement('div');
      condRow.className = 'prop-row';
      const condLabel = document.createElement('label');
      condLabel.textContent = 'Condition';
      const condCheck = document.createElement('input');
      condCheck.type = 'checkbox';
      condCheck.checked = conn.condEnabled;
      condCheck.style.width = 'auto';
      condRow.appendChild(condLabel);
      condRow.appendChild(condCheck);
      panel.appendChild(condRow);

      const condDetails = document.createElement('div');
      condDetails.className = 'cond-details';
      condDetails.style.display = conn.condEnabled ? 'block' : 'none';

      const opSel = document.createElement('select');
      for (const op of ['>', '>=', '<', '<=', '==', '!=']) {
        const o = document.createElement('option');
        o.value = op; o.textContent = op;
        if (op === conn.condOperator) o.selected = true;
        opSel.appendChild(o);
      }
      opSel.addEventListener('change', () => { conn.condOperator = opSel.value; });

      const valInp = document.createElement('input');
      valInp.type = 'number';
      valInp.value = conn.condValue;
      valInp.addEventListener('input', () => { conn.condValue = parseFloat(valInp.value) || 0; });

      const condInner = document.createElement('div');
      condInner.className = 'prop-row';
      const condInnerLbl = document.createElement('label');
      condInnerLbl.textContent = 'if source';
      condInner.appendChild(condInnerLbl);
      condInner.appendChild(opSel);
      condInner.appendChild(valInp);
      condDetails.appendChild(condInner);
      panel.appendChild(condDetails);

      condCheck.addEventListener('change', () => {
        conn.condEnabled = condCheck.checked;
        condDetails.style.display = condCheck.checked ? 'block' : 'none';
      });

    } else {
      // State connection
      this._field(panel, 'Variable name', 'text', conn.variableName || conn.label, v => {
        conn.variableName = v; conn.label = v; this.renderer.render();
      }, 'used in register formulas');
      this._info(panel, 'Each step, this variable is set to the source\'s resource count. Use the variable name in Register formulas or connection rate formulas.');
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

  _colorField(panel, label, value, onChange, clearable = false) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    row.appendChild(lbl);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:6px;align-items:center;flex:1;';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = value || '#ffa726';
    picker.style.cssText = 'width:36px;height:28px;padding:1px;border-radius:4px;cursor:pointer;border:1px solid var(--border);background:none;';
    picker.addEventListener('input', () => onChange(picker.value));
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

    // Update register display
    if (node.type === NodeType.REGISTER) {
      const rv = document.querySelector('#props-content .reg-value');
      if (rv) rv.textContent = `= ${node.displayCount}`;
      return;
    }

    const inputs = document.querySelectorAll('#props-content input[type="number"]');
    const inp = inputs[0];
    if (inp && document.activeElement !== inp) inp.value = node.resources;
  }

  _updateSparklines() { for (const sl of this._sparklines.values()) sl.update(); }

  _clearSparklines() { for (const sl of this._sparklines.values()) sl.destroy(); this._sparklines.clear(); }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
