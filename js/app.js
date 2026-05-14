class App {
  constructor() {
    this.diagram = new Diagram();
    this.engine = new SimEngine(this.diagram);
    this.renderer = new Renderer(document.getElementById('canvas'), this.diagram);
    this.editor = new Editor(
      document.getElementById('canvas'),
      this.diagram,
      this.renderer,
      this.engine,
      (id, type) => this._onSelect(id, type),
    );

    this._selectedId = null;
    this._selectedType = null;
    this._sparklines = new Map(); // nodeId -> Sparkline

    this._bindControls();

    this.engine.onStep = (step, fired) => {
      document.getElementById('step-counter').textContent = `Step: ${step}`;
      if (fired && fired.length) this.renderer.setFiring(fired);
      else this.renderer.render();
      this._updateSparklines();
      this._refreshPropsCount();
    };

    this._loadExample();
  }

  _loadExample() {
    // Simple Source → Pool → Drain demo
    const src = this.diagram.addNode(new MNode(NodeType.SOURCE, 200, 300));
    src.label = 'Gold Source';

    const pool = this.diagram.addNode(new MNode(NodeType.POOL, 400, 300));
    pool.label = 'Treasury';
    pool.resources = 0;
    pool._initialResources = 0;

    const drain = this.diagram.addNode(new MNode(NodeType.DRAIN, 600, 300));
    drain.label = 'Upkeep';

    const c1 = this.diagram.addConnection(new MConnection(src.id, pool.id, ConnectionType.RESOURCE));
    c1.rate = 3;

    const c2 = this.diagram.addConnection(new MConnection(pool.id, drain.id, ConnectionType.RESOURCE));
    c2.rate = 1;

    // A gate example
    const gate = this.diagram.addNode(new MNode(NodeType.GATE, 400, 460));
    gate.label = 'Split';
    const pool2 = this.diagram.addNode(new MNode(NodeType.POOL, 280, 580));
    pool2.label = 'Pool A';
    const pool3 = this.diagram.addNode(new MNode(NodeType.POOL, 520, 580));
    pool3.label = 'Pool B';

    const cg = this.diagram.addConnection(new MConnection(pool.id, gate.id, ConnectionType.RESOURCE));
    cg.rate = 2;
    this.diagram.addConnection(new MConnection(gate.id, pool2.id, ConnectionType.RESOURCE));
    this.diagram.addConnection(new MConnection(gate.id, pool3.id, ConnectionType.RESOURCE));

    this.renderer.render();
  }

  _bindControls() {
    // Sim controls
    document.getElementById('btn-step').addEventListener('click', () => {
      this.engine.doStep();
    });
    document.getElementById('btn-run').addEventListener('click', () => {
      this.engine.run();
      document.getElementById('btn-run').textContent = this.engine.running ? '⏸ Pause' : '▶ Run';
    });
    document.getElementById('btn-reset').addEventListener('click', () => {
      this.engine.reset();
      document.getElementById('btn-run').textContent = '▶ Run';
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

    // Toolbar palette
    document.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.editor.setTool(btn.dataset.tool);
      });
    });

    // File controls
    document.getElementById('btn-new').addEventListener('click', () => {
      if (!confirm('Start a new diagram? Unsaved work will be lost.')) return;
      this.diagram.nodes.clear();
      this.diagram.connections.clear();
      this.engine.reset();
      this._clearSparklines();
      this._onSelect(null, null);
      this.renderer.render();
    });

    document.getElementById('btn-save').addEventListener('click', () => {
      const json = JSON.stringify(this.diagram.toJSON(), null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'diagram.json';
      a.click();
    });

    document.getElementById('btn-load').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json';
      inp.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            const data = JSON.parse(ev.target.result);
            this.diagram.loadJSON(data);
            this.engine.reset();
            this._clearSparklines();
            this._onSelect(null, null);
            this.renderer.render();
          } catch (err) {
            alert('Invalid diagram file: ' + err.message);
          }
        };
        reader.readAsText(file);
      };
      inp.click();
    });
  }

  _onSelect(id, type) {
    this._selectedId = id;
    this._selectedType = type;
    this._renderProps();
  }

  _renderProps() {
    const panel = document.getElementById('props-content');
    panel.innerHTML = '';
    this._clearSparklines();

    if (!this._selectedId) {
      panel.innerHTML = '<p class="props-empty">Select a node or connection to edit its properties.</p>';
      return;
    }

    if (this._selectedType === 'node') {
      const node = this.diagram.nodes.get(this._selectedId);
      if (!node) return;
      this._renderNodeProps(panel, node);
    } else if (this._selectedType === 'conn') {
      const conn = this.diagram.connections.get(this._selectedId);
      if (!conn) return;
      this._renderConnProps(panel, conn);
    }
  }

  _renderNodeProps(panel, node) {
    const h = document.createElement('h3');
    h.className = 'props-title';
    h.textContent = `${node.type.charAt(0).toUpperCase() + node.type.slice(1)} Node`;
    panel.appendChild(h);

    this._field(panel, 'Label', 'text', node.label, v => {
      node.label = v; this.renderer.render();
    });

    if (node.type !== NodeType.SOURCE) {
      this._field(panel, 'Resources', 'number', node.resources, v => {
        node.resources = parseInt(v) || 0;
        node._initialResources = node.resources;
        this.renderer.render();
      });
    }

    if (node.type === NodeType.POOL) {
      this._field(panel, 'Capacity', 'text', node.capacity === Infinity ? '' : node.capacity,
        v => {
          node.capacity = v === '' || v === '∞' ? Infinity : (parseInt(v) || Infinity);
          this.renderer.render();
        }, '∞ = unlimited');
    }

    if (node.type === NodeType.DELAY) {
      this._field(panel, 'Delay (steps)', 'number', node.delay, v => {
        node.delay = Math.max(1, parseInt(v) || 1);
      });
    }

    if (node.type === NodeType.GATE) {
      const sel = this._select2(panel, 'Gate Mode', ['deterministic', 'random'], node.gateMode, v => {
        node.gateMode = v;
      });
    }

    if (node.type === NodeType.REGISTER) {
      this._field(panel, 'Value', 'number', node.value, v => {
        node.value = parseFloat(v) || 0;
        this.renderer.render();
      });
    }

    this._select2(panel, 'Activation', Object.values(ActivationMode), node.activation, v => {
      node.activation = v;
      this.renderer.render();
    });

    // Sparkline chart
    if (node.type !== NodeType.SOURCE) {
      const chartSection = document.createElement('div');
      chartSection.className = 'chart-section';
      const chartLabel = document.createElement('div');
      chartLabel.className = 'chart-label';
      chartLabel.textContent = 'Resource History';
      chartSection.appendChild(chartLabel);
      panel.appendChild(chartSection);

      const sl = new Sparkline(chartSection, node.id, this.engine);
      this._sparklines.set(node.id, sl);
      sl.update();
    }
  }

  _renderConnProps(panel, conn) {
    const src = this.diagram.nodes.get(conn.sourceId);
    const tgt = this.diagram.nodes.get(conn.targetId);
    const h = document.createElement('h3');
    h.className = 'props-title';
    h.textContent = `${conn.type === ConnectionType.RESOURCE ? 'Resource' : 'State'} Connection`;
    panel.appendChild(h);

    const info = document.createElement('p');
    info.className = 'props-info';
    info.textContent = `${src?.label || '?'} → ${tgt?.label || '?'}`;
    panel.appendChild(info);

    this._field(panel, 'Rate', 'number', conn.rate, v => {
      conn.rate = parseFloat(v) || 1;
      this.renderer.render();
    });

    this._field(panel, 'Label', 'text', conn.label, v => {
      conn.label = v; this.renderer.render();
    });
  }

  _field(parent, label, type, value, onChange, placeholder = '') {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = type;
    inp.value = value;
    if (placeholder) inp.placeholder = placeholder;
    inp.addEventListener('change', () => onChange(inp.value));
    inp.addEventListener('input', () => onChange(inp.value));
    row.appendChild(lbl);
    row.appendChild(inp);
    parent.appendChild(row);
    return inp;
  }

  _select2(parent, label, options, value, onChange) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const sel = document.createElement('select');
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
      if (opt === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    row.appendChild(lbl);
    row.appendChild(sel);
    parent.appendChild(row);
    return sel;
  }

  _refreshPropsCount() {
    if (this._selectedType !== 'node') return;
    const node = this.diagram.nodes.get(this._selectedId);
    if (!node || node.type === NodeType.SOURCE) return;
    const inputs = document.querySelectorAll('#props-content input[type="number"]');
    const inp = inputs[0]; // first number input = resources
    if (inp && document.activeElement !== inp) inp.value = node.resources;
  }

  _updateSparklines() {
    for (const sl of this._sparklines.values()) sl.update();
  }

  _clearSparklines() {
    for (const sl of this._sparklines.values()) sl.destroy();
    this._sparklines.clear();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
