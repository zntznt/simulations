class Editor {
  constructor(svg, diagram, renderer, engine, onSelect, onChange) {
    this.svg = svg;
    this.diagram = diagram;
    this.renderer = renderer;
    this.engine = engine;
    this.onSelect = onSelect; // callback(id, type) or (null)
    this.onChange = onChange; // callback() after a structural edit (for undo)

    this.tool = 'select'; // current tool
    this._drag = null;    // { items:[{nodeId,origX,origY}], startX, startY }
    this._dragMoved = false;
    this._connecting = null; // {sourceId, type}
    this._panDrag = null; // {startX, startY, panX, panY}
    this._marquee = null; // {x0, y0, cur, add, base}
    this.selection = new Set(); // multi-selected node ids

    this._bind();
  }

  _changed() { if (this.onChange) this.onChange(); }

  // Set the selection (node ids) plus a primary item for the properties panel.
  _setSelection(ids, primaryId, primaryType) {
    this.selection = new Set(ids);
    this.renderer.selectedIds = this.selection;
    const single = this.selection.size === 1 ? [...this.selection][0] : null;
    this.renderer.selectedId = primaryType === 'conn' ? primaryId : single;
    this.renderer.render();
    if (this.onSelect) {
      const pType = primaryType === 'conn' ? 'conn' : (this.selection.size ? 'node' : null);
      const pId = primaryType === 'conn' ? primaryId : single;
      this.onSelect(pId, pType, this.selection.size);
    }
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
        if (e.shiftKey) {
          // Toggle this node in/out of the selection (no drag).
          if (this.selection.has(hit.id)) this.selection.delete(hit.id);
          else this.selection.add(hit.id);
          this._setSelection([...this.selection], null, 'node');
          return;
        }
        // Clicking an unselected node selects just it; clicking one already in
        // the selection keeps the group (so you can drag them all).
        if (!this.selection.has(hit.id)) this._setSelection([hit.id], hit.id, 'node');
        this._startGroupDrag(e);
      } else if (hit && hit.type === 'conn') {
        this._setSelection([], hit.id, 'conn');
      } else {
        // Empty canvas: begin a marquee (extends selection when Shift held).
        if (!e.shiftKey) this._setSelection([], null, null);
        this._marquee = { x0: pt.x, y0: pt.y, cur: null, add: e.shiftKey, base: new Set(this.selection) };
      }
    } else if (this.tool.startsWith('place-')) {
      const type = this.tool.replace('place-', '');
      const node = this.diagram.addNode(new MNode(type, pt.x, pt.y));
      this.renderer.render();
      this._select(node.id, 'node');
      this._changed();
    } else if (this.tool === 'connect-resource' || this.tool === 'connect-state') {
      const connType = this.tool === 'connect-state' ? ConnectionType.STATE : ConnectionType.RESOURCE;
      if (!this._connecting) {
        if (hit && hit.type === 'node') {
          this._connecting = { sourceId: hit.id, type: connType };
        }
      } else {
        // State connections may target their own source (e.g. a pool applying
        // interest/decay to itself via a modifier); resource self-loops are not.
        const allowSelf = this._connecting.type === ConnectionType.STATE;
        if (hit && hit.type === 'node' && (hit.id !== this._connecting.sourceId || allowSelf)) {
          const conn = this.diagram.addConnection(
            new MConnection(this._connecting.sourceId, hit.id, this._connecting.type)
          );
          this._connecting = null;
          this.renderer.clearTemp();
          this.renderer.render();
          this._select(conn.id, 'conn');
          this._changed();
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
        this._changed();
      }
    }
  }

  // Begin dragging every currently-selected node as a group.
  _startGroupDrag(e) {
    const items = [];
    for (const id of this.selection) {
      const n = this.diagram.nodes.get(id);
      if (n) items.push({ nodeId: id, origX: n.x, origY: n.y });
    }
    this._drag = { items, startX: e.clientX, startY: e.clientY };
    this._dragMoved = false;
  }

  _onMove(e) {
    if (this._panDrag) {
      const dx = e.clientX - this._panDrag.startX;
      const dy = e.clientY - this._panDrag.startY;
      this.renderer.setPan(this._panDrag.panX + dx, this._panDrag.panY + dy);
      return;
    }

    if (this._drag) {
      const s = this.renderer._scale || 1;
      const dx = (e.clientX - this._drag.startX) / s;
      const dy = (e.clientY - this._drag.startY) / s;
      for (const it of this._drag.items) {
        const n = this.diagram.nodes.get(it.nodeId);
        if (n) { n.x = it.origX + dx; n.y = it.origY + dy; }
      }
      this._dragMoved = true;
      this.renderer.render();
      return;
    }

    if (this._marquee) {
      const pt = this.renderer.svgPoint(e.clientX, e.clientY);
      this._marquee.cur = pt;
      this.renderer.setMarquee(this._marquee.x0, this._marquee.y0, pt.x, pt.y);
      const ids = this.renderer.nodesInRect(this._marquee.x0, this._marquee.y0, pt.x, pt.y);
      const set = this._marquee.add ? new Set([...this._marquee.base, ...ids]) : new Set(ids);
      this.renderer.selectedIds = set; // live preview
      this.renderer.render();
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

    if (this._drag) {
      const moved = this._dragMoved;
      this._drag = null;
      this._dragMoved = false;
      if (moved) this._changed();  // commit the move as one undo step
      return;
    }

    if (this._marquee) {
      const m = this._marquee;
      this._marquee = null;
      this.renderer.clearMarquee();
      const cur = m.cur || { x: m.x0, y: m.y0 };
      const ids = this.renderer.nodesInRect(m.x0, m.y0, cur.x, cur.y);
      const set = m.add ? new Set([...m.base, ...ids]) : new Set(ids);
      this._setSelection([...set], set.size === 1 ? [...set][0] : null, 'node');
      return;
    }

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
        this._changed();
      } else if (!hit) {
        // Drag released on empty canvas: cancel the pending connection so no
        // rubber-band line is left dangling. (Releasing on the source node
        // keeps it armed for click-to-click connecting.)
        this._connecting = null;
        this.renderer.clearTemp();
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
      this._changed();
    }
  }

  _onWheel(e) {
    e.preventDefault();
    // Wheel zooms toward the cursor; pan via middle/alt-drag.
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.renderer.zoomBy(factor, e.clientX, e.clientY);
  }

  _onKey(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selection.size) {
        for (const id of this.selection) this.diagram.removeNode(id);
        this._select(null, null);
        this.renderer.render();
        this._changed();
      } else if (this.renderer.selectedId && this.diagram.connections.has(this.renderer.selectedId)) {
        this.diagram.removeConnection(this.renderer.selectedId);
        this._select(null, null);
        this.renderer.render();
        this._changed();
      }
    }
    if (e.key === 'Escape') {
      this._connecting = null;
      this._marquee = null;
      this.renderer.clearTemp();
      this.renderer.clearMarquee();
      this._select(null, null);
    }
  }

  // Thin wrapper kept for existing callers (place/connect/delete/clear).
  _select(id, type) {
    if (type === 'node') this._setSelection([id], id, 'node');
    else if (type === 'conn') this._setSelection([], id, 'conn');
    else this._setSelection([], null, null);
  }
}
