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

    this.engine.onEnd = (ended) => {
      const status = document.getElementById('sim-status');
      if (status) status.textContent = `🏁 ${ended.label} reached ${ended.value} at step ${ended.step}`;
      document.getElementById('btn-run').textContent = '▶ Run';
      this.renderer.render();
    };

    this._loadExample();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _clearAll() {
    this.diagram.nodes.clear();
    this.diagram.connections.clear();
    this.diagram.variables = {};
    this.engine.reset();
    document.getElementById('btn-run').textContent = '▶ Run';
    document.getElementById('sim-status').textContent = '';
    this.renderer.balls.clear();
    this._clearSparklines();
    this._onSelect(null, null);
  }

  // ── Example diagrams ──────────────────────────────────────────────────────

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

    // Register example: reads the Treasury count via a named state variable.
    const reg = this.diagram.addNode(new MNode(NodeType.REGISTER, 620, 460));
    reg.label = 'Total';
    reg.formula = 'treasury * 2';

    const sc = this.diagram.addConnection(new MConnection(pool.id, reg.id, ConnectionType.STATE));
    sc.variableName = 'treasury';
    sc.label = 'treasury';

    this.renderer.render();
  }

  // Loot Farm: showcases dice rolls, chance %, conditional, and formula registers.
  _loadLootExample() {
    const d = this.diagram;

    const src = d.addNode(new MNode(NodeType.SOURCE, 150, 270));
    src.label = 'Enemy Spawn';
    src.resourceColor = '#ef5350';

    const combat = d.addNode(new MNode(NodeType.POOL, 360, 270));
    combat.label = 'Combat';
    combat.capacity = 20;

    const xp = d.addNode(new MNode(NodeType.DRAIN, 360, 110));
    xp.label = 'XP';

    const gold = d.addNode(new MNode(NodeType.POOL, 570, 180));
    gold.label = 'Gold';

    const rareLoot = d.addNode(new MNode(NodeType.POOL, 570, 390));
    rareLoot.label = 'Rare Loot';

    const shop = d.addNode(new MNode(NodeType.DRAIN, 780, 180));
    shop.label = 'Shop';

    const reg = d.addNode(new MNode(NodeType.REGISTER, 780, 390));
    reg.label = 'Wealth';
    reg.formula = 'gold * 10 + rare * 50';
    reg.endEnabled = true;            // stop the run once we're rich enough
    reg.endOperator = '>=';
    reg.endValue = 1000;

    // Enemy Spawn → Combat: 3 enemies per step
    const c1 = d.addConnection(new MConnection(src.id, combat.id));
    c1.rate = 3;

    // Combat → XP: dice 2d4 each step
    const c2 = d.addConnection(new MConnection(combat.id, xp.id));
    c2.rateMode = RateMode.DICE;
    c2.dice = '2d4';
    c2.label = '2d4';

    // Combat → Gold: rate 1, 65% chance
    const c3 = d.addConnection(new MConnection(combat.id, gold.id));
    c3.rate = 1;
    c3.chance = 65;
    c3.label = '65%';

    // Combat → Rare Loot: rate 1, 20% chance
    const c4 = d.addConnection(new MConnection(combat.id, rareLoot.id));
    c4.rate = 1;
    c4.chance = 20;
    c4.label = '20%';

    // Gold → Shop: rate 3, fires only when Gold >= 10
    const c5 = d.addConnection(new MConnection(gold.id, shop.id));
    c5.rate = 3;
    c5.condEnabled = true;
    c5.condOperator = '>=';
    c5.condValue = 10;
    c5.label = '≥10→shop';

    // State: Gold Pool → Register
    const sc1 = d.addConnection(new MConnection(gold.id, reg.id, ConnectionType.STATE));
    sc1.variableName = 'gold';
    sc1.label = 'gold';

    // State: Rare Loot → Register
    const sc2 = d.addConnection(new MConnection(rareLoot.id, reg.id, ConnectionType.STATE));
    sc2.variableName = 'rare';
    sc2.label = 'rare';

    this.renderer.render();
  }

  // Factory Line: showcases triggers, activators, weighted gates, and a goal.
  _loadFactoryExample() {
    const d = this.diagram;

    // Power plant whose output gates the whole line via an activator.
    const power = d.addNode(new MNode(NodeType.SOURCE, 130, 130));
    power.label = 'Power';
    power.resourceColor = '#ffeb3b';
    const grid = d.addNode(new MNode(NodeType.POOL, 130, 300));
    grid.label = 'Grid';
    grid.capacity = 12;
    const pc = d.addConnection(new MConnection(power.id, grid.id));
    pc.rate = 2;

    // Ore line: a source feeds a stockpile that triggers a passive smelter.
    const ore = d.addNode(new MNode(NodeType.SOURCE, 130, 470));
    ore.label = 'Ore Vein';
    ore.resourceColor = '#8d6e63';
    const stock = d.addNode(new MNode(NodeType.POOL, 340, 470));
    stock.label = 'Stockpile';
    const oc = d.addConnection(new MConnection(ore.id, stock.id));
    oc.rate = 3;

    // Smelter is PASSIVE — it only runs when triggered by the Stockpile, and
    // only while the Grid has power (activator).
    const smelter = d.addNode(new MNode(NodeType.CONVERTER, 540, 470));
    smelter.label = 'Smelter';
    smelter.activation = ActivationMode.PASSIVE;
    smelter.inputAmount = 2;
    smelter.outputColor = '#ff7043';
    const feed = d.addConnection(new MConnection(stock.id, smelter.id));
    feed.rate = 3;

    // Trigger: every step the Stockpile fires, pulse the Smelter.
    const trig = d.addConnection(new MConnection(stock.id, smelter.id, ConnectionType.STATE));
    trig.trigger = true;

    // Activator: Smelter only runs while Grid >= 4 power.
    const act = d.addConnection(new MConnection(grid.id, smelter.id, ConnectionType.STATE));
    act.activator = true;
    act.actOperator = '>=';
    act.actValue = 4;

    // Smelter output → a probabilistic gate splitting ingots two ways.
    const gate = d.addNode(new MNode(NodeType.GATE, 750, 470));
    gate.label = 'QC';
    gate.gateMode = 'probabilistic';
    const sg = d.addConnection(new MConnection(smelter.id, gate.id));
    sg.rate = 4;

    const goods = d.addNode(new MNode(NodeType.POOL, 900, 380));
    goods.label = 'Ingots';
    const scrap = d.addNode(new MNode(NodeType.DRAIN, 900, 560));
    scrap.label = 'Scrap';

    const gGood = d.addConnection(new MConnection(gate.id, goods.id));
    gGood.weight = 4;            // 80% pass
    const gScrap = d.addConnection(new MConnection(gate.id, scrap.id));
    gScrap.weight = 1;           // 20% scrap

    // Goal: produce 60 ingots, then halt.
    goods.endEnabled = true;
    goods.endOperator = '>=';
    goods.endValue = 60;

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
      this._clearAll();
      this.renderer.render();
    });

    document.getElementById('btn-examples').addEventListener('change', e => {
      const val = e.target.value;
      e.target.value = '';
      if (!val) return;
      if (!confirm('Load example? Unsaved work will be lost.')) return;
      this._clearAll();
      if (val === 'basic') this._loadExample();
      else if (val === 'loot') this._loadLootExample();
      else if (val === 'factory') this._loadFactoryExample();
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
            this.renderer.balls.clear();
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

    if (node.type !== NodeType.SOURCE && node.type !== NodeType.REGISTER && node.type !== NodeType.DRAIN) {
      this._field(panel, 'Resources', 'number', node.resources, v => {
        node.setCount(Math.max(0, parseInt(v) || 0));
        this.renderer.render();
      });
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
      });
      this._info(panel, 'Consumes this many held resources per conversion, then emits each output connection’s rate in the output color.');
    }

    if (node.type === NodeType.DRAIN) {
      const stat = document.createElement('div');
      stat.className = 'reg-value drain-stat';
      stat.textContent = `${node.drained || 0}`;
      panel.appendChild(stat);
      this._info(panel, 'Total resources consumed (drained) this run.');
    }

    if (node.type === NodeType.DELAY) {
      this._field(panel, 'Delay steps', 'number', node.delay, v => { node.delay = Math.max(1, parseInt(v) || 1); });
    }

    if (node.type === NodeType.GATE) {
      if (node.gateMode === 'random') node.gateMode = 'probabilistic';
      this._select2(panel, 'Gate mode', ['deterministic', 'probabilistic'], node.gateMode,
        v => { node.gateMode = v; });
      this._info(panel, 'Outputs split by each connection\'s Weight — deterministic = proportional share; probabilistic = weighted random per unit.');
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

    this._field(panel, 'Label', 'text', conn.label, v => { conn.label = v; this.renderer.render(); });

    if (isRes) {
      const fromGate = src && src.type === NodeType.GATE;
      const fromConverter = src && src.type === NodeType.CONVERTER;
      const fromDelay = src && src.type === NodeType.DELAY;

      const rateField = () => this._field(panel, 'Rate', 'number', conn.rate, v => {
        const n = parseFloat(v); conn.rate = isFinite(n) ? Math.max(0, n) : 0; this.renderer.render();
      });

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
          }, true);
          this._info(panel, 'Only resources of this color pass. Leave empty for any color.');

          this._sep(panel);

          this._conditionRow(panel, 'Condition', conn,
            { enabled: 'condEnabled', op: 'condOperator', val: 'condValue', lead: 'if source' });
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

      this._sep(panel);

      this._conditionRow(panel, 'Activator (⊢)', conn,
        { enabled: 'activator', op: 'actOperator', val: 'actValue', lead: 'enable target when source' });
      this._info(panel, 'The target node may only fire while the source value satisfies this condition.');
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
  // keys = { enabled, op, val, lead }
  _conditionRow(panel, title, obj, keys) {
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
