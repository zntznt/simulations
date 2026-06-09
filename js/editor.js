class Editor {
  constructor(svg, diagram, renderer, engine, onSelect) {
    this.svg = svg;
    this.diagram = diagram;
    this.renderer = renderer;
    this.engine = engine;
    this.onSelect = onSelect; // callback(id, type) or (null)

    this.tool = 'select'; // current tool
    this._drag = null;    // {nodeId, startX, startY, origX, origY}
    this._connecting = null; // {sourceId, type}
    this._panDrag = null; // {startX, startY, panX, panY}

    this._bind();
  }

  setTool(tool) {
    this.tool = tool;
    this.svg.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    this._connecting = null;
    this.renderer.clearTemp();
  }

  _bind() {
    this.svg.addEventListener('mousedown', e => this._onDown(e));
    this.svg.addEventListener('mousemove', e => this._onMove(e));
    this.svg.addEventListener('mouseup', e => this._onUp(e));
    this.svg.addEventListener('dblclick', e => this._onDbl(e));
    this.svg.addEventListener('contextmenu', e => { e.preventDefault(); this._onRightClick(e); });
    this.svg.addEventListener('wheel', e => this._onWheel(e), { passive: false });

    window.addEventListener('keydown', e => this._onKey(e));
  }

  _onDown(e) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // Pan
      this._panDrag = {
        startX: e.clientX, startY: e.clientY,
        panX: this.renderer._panX, panY: this.renderer._panY,
      };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    const pt = this.renderer.svgPoint(e.clientX, e.clientY);
    const hit = this.renderer.hitTest(pt.x, pt.y);

    if (this.tool === 'select') {
      if (hit && hit.type === 'node') {
        const node = this.diagram.nodes.get(hit.id);
        // If interactive node during run
        if (this.engine.running && node.activation === ActivationMode.INTERACTIVE) {
          this.engine.fireInteractive(hit.id);
          return;
        }
        this._drag = {
          nodeId: hit.id,
          startX: e.clientX, startY: e.clientY,
          origX: node.x, origY: node.y,
        };
        this._select(hit.id, 'node');
      } else if (hit && hit.type === 'conn') {
        this._select(hit.id, 'conn');
      } else {
        this._select(null, null);
      }
    } else if (this.tool.startsWith('place-')) {
      const type = this.tool.replace('place-', '');
      const node = this.diagram.addNode(new MNode(type, pt.x, pt.y));
      this.renderer.render();
      this._select(node.id, 'node');
    } else if (this.tool === 'connect-resource' || this.tool === 'connect-state') {
      const connType = this.tool === 'connect-state' ? ConnectionType.STATE : ConnectionType.RESOURCE;
      if (!this._connecting) {
        if (hit && hit.type === 'node') {
          this._connecting = { sourceId: hit.id, type: connType };
        }
      } else {
        if (hit && hit.type === 'node' && hit.id !== this._connecting.sourceId) {
          const conn = this.diagram.addConnection(
            new MConnection(this._connecting.sourceId, hit.id, this._connecting.type)
          );
          this._connecting = null;
          this.renderer.clearTemp();
          this.renderer.render();
          this._select(conn.id, 'conn');
        } else if (!hit) {
          this._connecting = null;
          this.renderer.clearTemp();
        }
      }
    } else if (this.tool === 'delete') {
      if (hit) {
        if (hit.type === 'node') this.diagram.removeNode(hit.id);
        else this.diagram.removeConnection(hit.id);
        this._select(null, null);
        this.renderer.render();
      }
    }
  }

  _onMove(e) {
    if (this._panDrag) {
      const dx = e.clientX - this._panDrag.startX;
      const dy = e.clientY - this._panDrag.startY;
      this.renderer.setPan(this._panDrag.panX + dx, this._panDrag.panY + dy);
      return;
    }

    if (this._drag) {
      const node = this.diagram.nodes.get(this._drag.nodeId);
      if (node) {
        node.x = this._drag.origX + (e.clientX - this._drag.startX);
        node.y = this._drag.origY + (e.clientY - this._drag.startY);
        this.renderer.render();
      }
      return;
    }

    if (this._connecting) {
      const pt = this.renderer.svgPoint(e.clientX, e.clientY);
      const src = this.diagram.nodes.get(this._connecting.sourceId);
      if (src) {
        this.renderer.setTempConn(src.x, src.y, pt.x, pt.y, this._connecting.type);
      }
    }
  }

  _onUp(e) {
    if (this._panDrag) { this._panDrag = null; return; }
    this._drag = null;

    // Drag-to-connect: started a connection on a node and released over a
    // different node. (Click-to-click still works via _onDown.)
    if (this._connecting) {
      const pt = this.renderer.svgPoint(e.clientX, e.clientY);
      const hit = this.renderer.hitTest(pt.x, pt.y);
      if (hit && hit.type === 'node' && hit.id !== this._connecting.sourceId) {
        const conn = this.diagram.addConnection(
          new MConnection(this._connecting.sourceId, hit.id, this._connecting.type)
        );
        this._connecting = null;
        this.renderer.clearTemp();
        this.renderer.render();
        this._select(conn.id, 'conn');
      }
    }
  }

  _onDbl(e) {
    // Double-click: for interactive nodes, fire them
    const pt = this.renderer.svgPoint(e.clientX, e.clientY);
    const hit = this.renderer.hitTest(pt.x, pt.y);
    if (hit && hit.type === 'node') {
      const node = this.diagram.nodes.get(hit.id);
      if (node && node.activation === ActivationMode.INTERACTIVE) {
        this.engine.fireInteractive(hit.id);
      }
    }
  }

  _onRightClick(e) {
    const pt = this.renderer.svgPoint(e.clientX, e.clientY);
    const hit = this.renderer.hitTest(pt.x, pt.y);
    if (hit) {
      if (hit.type === 'node') this.diagram.removeNode(hit.id);
      else this.diagram.removeConnection(hit.id);
      this._select(null, null);
      this.renderer.render();
    }
  }

  _onWheel(e) {
    e.preventDefault();
    this.renderer.setPan(
      this.renderer._panX - e.deltaX * 0.5,
      this.renderer._panY - e.deltaY * 0.5,
    );
  }

  _onKey(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.renderer.selectedId) {
      const id = this.renderer.selectedId;
      if (this.diagram.nodes.has(id)) this.diagram.removeNode(id);
      else if (this.diagram.connections.has(id)) this.diagram.removeConnection(id);
      this._select(null, null);
      this.renderer.render();
    }
    if (e.key === 'Escape') {
      this._connecting = null;
      this.renderer.clearTemp();
      this._select(null, null);
    }
  }

  _select(id, type) {
    this.renderer.selectedId = id;
    this.renderer.render();
    if (this.onSelect) this.onSelect(id, type);
  }
}
