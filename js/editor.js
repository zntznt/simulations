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
    this._snapEnabled = false;
    this._snapSize = 20;
    this.autoRevert = false;     // revert to Select after placing a node
    this.onToolChange = null;    // callback(tool) when the editor changes its own tool
    this._touchMode = null;      // 'single' | 'pinch'
    this._pinch = null;          // last pinch state {dist, cx, cy}
    this._specialDrag = null;    // {type:'note'|'group', id, origX, origY, nodeItems?, startX, startY, moved}
    this._groupPlaceDrag = null; // {x0, y0} while dragging to define a new group
    this._spaceDown = false;     // hold Space to pan from anywhere (Figma-style)
    this._connHandleDrag = null; // {connId, type:'cp'|'bend', startX, startY, origCpDx, origCpDy, origBendPct, srcX, tgtX}

    this._bind();
  }

  setSnap(enabled) { this._snapEnabled = !!enabled; }

  // The canvas cursor reflects the current interaction: grabbing while panning,
  // grab while Space is held (ready to pan), otherwise the tool's own cursor.
  _restoreCursor() {
    this.svg.style.cursor = this._panDrag ? 'grabbing'
      : this._spaceDown ? 'grab'
      : this.tool === 'select' ? 'default' : 'crosshair';
  }

  _snapPt(x, y) {
    if (!this._snapEnabled) return { x, y };
    const s = this._snapSize;
    return { x: Math.round(x / s) * s, y: Math.round(y / s) * s };
  }

  _changed() { if (this.onChange) this.onChange(); }

  // Set the selection (node ids) plus a primary item for the properties panel.
  _setSelection(ids, primaryId, primaryType) {
    this.selection = new Set(ids);
    this.renderer.selectedIds = this.selection;
    const single = this.selection.size === 1 ? [...this.selection][0] : null;
    const nonNodeType = primaryType === 'conn' || primaryType === 'group'
      || primaryType === 'note' || primaryType === 'chart';
    this.renderer.selectedId = nonNodeType ? primaryId : single;
    this.renderer.render();
    if (this.onSelect) {
      const pType = nonNodeType ? primaryType : (this.selection.size ? 'node' : null);
      const pId = nonNodeType ? primaryId : single;
      this.onSelect(pId, pType, this.selection.size);
    }
  }

  setTool(tool) {
    this.tool = tool;
    this._connecting = null;
    this.renderer.clearTemp();
    this._restoreCursor();
  }

  _bind() {
    this.svg.addEventListener('mousedown', e => this._onDown(e));
    this.svg.addEventListener('mousemove', e => this._onMove(e));
    this.svg.addEventListener('mouseup', e => this._onUp(e));
    this.svg.addEventListener('dblclick', e => this._onDbl(e));
    this.svg.addEventListener('contextmenu', e => { e.preventDefault(); this._onRightClick(e); });
    this.svg.addEventListener('wheel', e => this._onWheel(e), { passive: false });

    // Touch (mobile): single-touch maps to mouse gestures; two fingers pinch/pan.
    this.svg.addEventListener('touchstart', e => this._onTouchStart(e), { passive: false });
    this.svg.addEventListener('touchmove', e => this._onTouchMove(e), { passive: false });
    this.svg.addEventListener('touchend', e => this._onTouchEnd(e), { passive: false });

    window.addEventListener('keydown', e => this._onKey(e));
    window.addEventListener('keyup', e => this._onKeyUp(e));
  }

  _onDown(e) {
    // Pan with middle-mouse, Alt+drag, or Space+drag (from anywhere).
    if (e.button === 1 || (e.button === 0 && (e.altKey || this._spaceDown))) {
      this._panDrag = {
        startX: e.clientX, startY: e.clientY,
        panX: this.renderer._panX, panY: this.renderer._panY,
      };
      this._restoreCursor();
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    const pt = this.renderer.svgPoint(e.clientX, e.clientY);

    // Check for connection handle drag (CP or ortho bend) before the normal hit test.
    if (this.tool === 'select') {
      const selId = this.renderer.selectedId;
      if (selId && this.diagram.connections.has(selId)) {
        const hp = this.renderer.getConnHandlePos(selId);
        if (hp) {
          const svgRect = this.svg.getBoundingClientRect();
          const sx = e.clientX - svgRect.left;
          const sy = e.clientY - svgRect.top;
          const shx = hp.x * this.renderer._scale + this.renderer._panX;
          const shy = hp.y * this.renderer._scale + this.renderer._panY;
          if (Math.hypot(sx - shx, sy - shy) <= 14) {
            const conn = this.diagram.connections.get(selId);
            const srcNode = this.diagram.nodes.get(conn.sourceId);
            const tgtNode = this.diagram.nodes.get(conn.targetId);
            const style = conn.pathStyle || 'curve';
            this._connHandleDrag = {
              connId: selId,
              type: style === 'ortho' ? 'bend' : 'cp',
              startX: e.clientX, startY: e.clientY,
              origCpDx: conn.cpDx || 0, origCpDy: conn.cpDy || 0,
              origBendPct: conn.bendPct ?? 0.5,
              srcX: srcNode ? srcNode.x : 0,
              tgtX: tgtNode ? tgtNode.x : 0,
            };
            e.preventDefault();
            return;
          }
        }
      }
    }

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
      } else if (hit && hit.type === 'note') {
        const note = this.diagram.notes.get(hit.id);
        if (note) {
          this._setSelection([], hit.id, 'note');
          this._specialDrag = { type: 'note', id: hit.id, origX: note.x, origY: note.y, startX: e.clientX, startY: e.clientY, moved: false };
        }
      } else if (hit && hit.type === 'chart') {
        const chart = this.diagram.charts.get(hit.id);
        if (chart) {
          this._setSelection([], hit.id, 'chart');
          this._specialDrag = { type: 'chart', id: hit.id, origX: chart.x, origY: chart.y, startX: e.clientX, startY: e.clientY, moved: false };
        }
      } else if (hit && hit.type === 'group') {
        const grp = this.diagram.groups.get(hit.id);
        if (grp) {
          this._setSelection([], hit.id, 'group');
          // Collect nodes inside the group for co-movement.
          const nodeItems = [];
          for (const n of this.diagram.nodes.values()) {
            if (n.x >= grp.x && n.x <= grp.x + grp.w && n.y >= grp.y && n.y <= grp.y + grp.h)
              nodeItems.push({ nodeId: n.id, origX: n.x, origY: n.y });
          }
          this._specialDrag = { type: 'group', id: hit.id, origX: grp.x, origY: grp.y, nodeItems, startX: e.clientX, startY: e.clientY, moved: false };
        }
      } else {
        // Empty canvas: begin a marquee (extends selection when Shift held).
        if (!e.shiftKey) this._setSelection([], null, null);
        this._marquee = { x0: pt.x, y0: pt.y, cur: null, add: e.shiftKey, base: new Set(this.selection) };
      }
    } else if (this.tool === 'place-group') {
      const sn = this._snapPt(pt.x, pt.y);
      this._groupPlaceDrag = { x0: sn.x, y0: sn.y };
    } else if (this.tool === 'place-note') {
      const sn = this._snapPt(pt.x, pt.y);
      const note = this.diagram.addNote(new MNote(sn.x, sn.y));
      this.renderer.render();
      this._select(note.id, 'note');
      this._changed();
      if (this.autoRevert) { this.setTool('select'); if (this.onToolChange) this.onToolChange('select'); }
    } else if (this.tool === 'place-chart') {
      const sn = this._snapPt(pt.x, pt.y);
      const chart = this.diagram.addChart(new MChart(sn.x, sn.y));
      this.renderer.render();
      this._select(chart.id, 'chart');
      this._changed();
      if (this.autoRevert) { this.setTool('select'); if (this.onToolChange) this.onToolChange('select'); }
    } else if (this.tool.startsWith('place-')) {
      const type = this.tool.replace('place-', '');
      const sn = this._snapPt(pt.x, pt.y);
      const node = this.diagram.addNode(new MNode(type, sn.x, sn.y));
      this.renderer.render();
      this._select(node.id, 'node');
      this._changed();
      // Optional: snap back to the Select tool after placing one node.
      if (this.autoRevert) {
        this.setTool('select');
        if (this.onToolChange) this.onToolChange('select');
      }
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
        else if (hit.type === 'conn') this.diagram.removeConnection(hit.id);
        else if (hit.type === 'group') this.diagram.removeGroup(hit.id);
        else if (hit.type === 'note') this.diagram.removeNote(hit.id);
        else if (hit.type === 'chart') this.diagram.removeChart(hit.id);
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

    if (this._connHandleDrag) {
      const s = this.renderer._scale || 1;
      const dx = (e.clientX - this._connHandleDrag.startX) / s;
      const dy = (e.clientY - this._connHandleDrag.startY) / s;
      const conn = this.diagram.connections.get(this._connHandleDrag.connId);
      if (conn) {
        if (this._connHandleDrag.type === 'cp') {
          conn.cpDx = this._connHandleDrag.origCpDx + dx;
          conn.cpDy = this._connHandleDrag.origCpDy + dy;
        } else {
          const { srcX, tgtX } = this._connHandleDrag;
          const totalDx = tgtX - srcX;
          if (Math.abs(totalDx) > 10) {
            const newBx = srcX + this._connHandleDrag.origBendPct * totalDx + dx;
            conn.bendPct = Math.max(0.1, Math.min(0.9, (newBx - srcX) / totalDx));
          }
        }
        this.renderer.render();
      }
      return;
    }

    if (this._specialDrag) {
      const s = this.renderer._scale || 1;
      const dx = (e.clientX - this._specialDrag.startX) / s;
      const dy = (e.clientY - this._specialDrag.startY) / s;
      if (this._specialDrag.type === 'note') {
        const note = this.diagram.notes.get(this._specialDrag.id);
        if (note) {
          const sn = this._snapPt(this._specialDrag.origX + dx, this._specialDrag.origY + dy);
          note.x = sn.x; note.y = sn.y;
        }
      } else if (this._specialDrag.type === 'chart') {
        const chart = this.diagram.charts.get(this._specialDrag.id);
        if (chart) {
          const sn = this._snapPt(this._specialDrag.origX + dx, this._specialDrag.origY + dy);
          chart.x = sn.x; chart.y = sn.y;
        }
      } else if (this._specialDrag.type === 'group') {
        const grp = this.diagram.groups.get(this._specialDrag.id);
        if (grp) {
          const sn = this._snapPt(this._specialDrag.origX + dx, this._specialDrag.origY + dy);
          grp.x = sn.x; grp.y = sn.y;
          for (const it of this._specialDrag.nodeItems) {
            const n = this.diagram.nodes.get(it.nodeId);
            if (n) {
              const nsn = this._snapPt(it.origX + dx, it.origY + dy);
              n.x = nsn.x; n.y = nsn.y;
            }
          }
        }
      }
      this._specialDrag.moved = true;
      this.renderer.render();
      return;
    }

    if (this._groupPlaceDrag) {
      const pt = this.renderer.svgPoint(e.clientX, e.clientY);
      this.renderer.setGroupPreview(this._groupPlaceDrag.x0, this._groupPlaceDrag.y0, pt.x, pt.y);
      return;
    }

    if (this._drag) {
      const s = this.renderer._scale || 1;
      const dx = (e.clientX - this._drag.startX) / s;
      const dy = (e.clientY - this._drag.startY) / s;
      for (const it of this._drag.items) {
        const n = this.diagram.nodes.get(it.nodeId);
        if (n) {
          const sn = this._snapPt(it.origX + dx, it.origY + dy);
          n.x = sn.x; n.y = sn.y;
        }
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
    if (this._panDrag) { this._panDrag = null; this._restoreCursor(); return; }

    if (this._connHandleDrag) {
      this._connHandleDrag = null;
      this._changed();
      return;
    }

    if (this._drag) {
      const moved = this._dragMoved;
      this._drag = null;
      this._dragMoved = false;
      if (moved) this._changed();  // commit the move as one undo step
      return;
    }

    if (this._specialDrag) {
      const moved = this._specialDrag.moved;
      this._specialDrag = null;
      if (moved) this._changed();
      return;
    }

    if (this._groupPlaceDrag) {
      const gd = this._groupPlaceDrag;
      this._groupPlaceDrag = null;
      this.renderer.clearTemp();
      const pt = this.renderer.svgPoint(e.clientX, e.clientY);
      const sn = this._snapPt(pt.x, pt.y);
      const x = Math.min(gd.x0, sn.x), y = Math.min(gd.y0, sn.y);
      const w = Math.abs(sn.x - gd.x0), h = Math.abs(sn.y - gd.y0);
      if (w >= 20 && h >= 20) {
        const grp = this.diagram.addGroup(new MGroup(x, y, w, h));
        this.renderer.render();
        this._select(grp.id, 'group');
        this._changed();
        if (this.autoRevert) { this.setTool('select'); if (this.onToolChange) this.onToolChange('select'); }
      }
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
    const pt = this.renderer.svgPoint(e.clientX, e.clientY);
    const hit = this.renderer.hitTest(pt.x, pt.y);
    if (hit && hit.type === 'node') {
      const node = this.diagram.nodes.get(hit.id);
      if (node && node.activation === ActivationMode.INTERACTIVE) {
        this.engine.fireInteractive(hit.id);
      }
    } else if (hit && hit.type === 'conn') {
      // Double-click a connection to reset its shape to default.
      const conn = this.diagram.connections.get(hit.id);
      if (conn) {
        conn.cpDx = 0; conn.cpDy = 0; conn.bendPct = 0.5;
        this.renderer.render(); this._changed();
      }
    }
  }

  _onRightClick(e) {
    const pt = this.renderer.svgPoint(e.clientX, e.clientY);
    const hit = this.renderer.hitTest(pt.x, pt.y);
    if (hit) {
      if (hit.type === 'node') this.diagram.removeNode(hit.id);
      else if (hit.type === 'conn') this.diagram.removeConnection(hit.id);
      else if (hit.type === 'group') this.diagram.removeGroup(hit.id);
      else if (hit.type === 'note') this.diagram.removeNote(hit.id);
      else if (hit.type === 'chart') this.diagram.removeChart(hit.id);
      this._select(null, null);
      this.renderer.render();
      this._changed();
    }
  }

  _onWheel(e) {
    e.preventDefault();
    // Shift+wheel pans horizontally (handy on a vertical-only mouse wheel);
    // a plain wheel zooms toward the cursor. Pan also via space/middle/alt-drag.
    if (e.shiftKey) {
      const amt = e.deltaY || e.deltaX;
      this.renderer.setPan(this.renderer._panX - amt, this.renderer._panY);
      return;
    }
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.renderer.zoomBy(factor, e.clientX, e.clientY);
  }

  // ── Touch (mobile) ──────────────────────────────────────────────────────────

  // Wrap a Touch into a mouse-event-like object the mouse handlers understand.
  _touchShim(t, e) {
    return {
      button: 0, altKey: false, shiftKey: false,
      clientX: t.clientX, clientY: t.clientY,
      preventDefault: () => { if (e.cancelable) e.preventDefault(); },
    };
  }

  _pinchState(e) {
    const a = e.touches[0], b = e.touches[1];
    return {
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
      cx: (a.clientX + b.clientX) / 2,
      cy: (a.clientY + b.clientY) / 2,
    };
  }

  _onTouchStart(e) {
    if (e.touches.length === 1) {
      this._touchMode = 'single';
      this._onDown(this._touchShim(e.touches[0], e));
    } else if (e.touches.length === 2) {
      // Two fingers: pinch-zoom / pan. Abort every pending single-touch gesture
      // so nothing is left half-applied (node drag, marquee, connect, and the
      // note/chart/group special-drag and group-placement gestures).
      this._touchMode = 'pinch';
      this._drag = null; this._dragMoved = false;
      this._marquee = null; this._connecting = null;
      this._specialDrag = null; this._groupPlaceDrag = null;
      this.renderer.clearTemp(); this.renderer.clearMarquee();
      this._pinch = this._pinchState(e);
    }
    if (e.cancelable) e.preventDefault();
  }

  _onTouchMove(e) {
    if (this._touchMode === 'pinch' && e.touches.length === 2) {
      const cur = this._pinchState(e);
      const prev = this._pinch || cur;
      this.renderer.zoomBy(cur.dist / (prev.dist || 1), prev.cx, prev.cy);
      this.renderer.setPan(this.renderer._panX + (cur.cx - prev.cx),
                           this.renderer._panY + (cur.cy - prev.cy));
      this._pinch = cur;
    } else if (this._touchMode === 'single' && e.touches.length === 1) {
      this._onMove(this._touchShim(e.touches[0], e));
    }
    if (e.cancelable) e.preventDefault();
  }

  _onTouchEnd(e) {
    if (this._touchMode === 'single') {
      const t = e.changedTouches[0];
      if (t) this._onUp(this._touchShim(t, e));
    }
    if (e.touches.length === 0) { this._touchMode = null; this._pinch = null; }
    if (e.cancelable) e.preventDefault();
  }

  _onKey(e) {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || e.target.isContentEditable) return;
    // Hold Space to pan the canvas from anywhere (released in _onKeyUp).
    if (e.code === 'Space') {
      if (!this._spaceDown) { this._spaceDown = true; this._restoreCursor(); }
      e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selection.size) {
        for (const id of this.selection) this.diagram.removeNode(id);
        this._select(null, null);
        this.renderer.render();
        this._changed();
      } else if (this.renderer.selectedId) {
        const id = this.renderer.selectedId;
        let changed = false;
        if (this.diagram.connections.has(id)) { this.diagram.removeConnection(id); changed = true; }
        else if (this.diagram.groups.has(id)) { this.diagram.removeGroup(id); changed = true; }
        else if (this.diagram.notes.has(id)) { this.diagram.removeNote(id); changed = true; }
        else if (this.diagram.charts.has(id)) { this.diagram.removeChart(id); changed = true; }
        if (changed) { this._select(null, null); this.renderer.render(); this._changed(); }
      }
    }
    if (e.key === 'Escape') {
      this._connecting = null;
      this._marquee = null;
      this._groupPlaceDrag = null;
      this.renderer.clearTemp();
      this.renderer.clearMarquee();
      this._select(null, null);
    }
  }

  _onKeyUp(e) {
    if (e.code === 'Space') {
      this._spaceDown = false;
      if (!this._panDrag) this._restoreCursor();
    }
  }

  // Thin wrapper kept for existing callers (place/connect/delete/clear).
  _select(id, type) {
    if (type === 'node') this._setSelection([id], id, 'node');
    else if (type === 'conn') this._setSelection([], id, 'conn');
    else if (type === 'group') this._setSelection([], id, 'group');
    else if (type === 'note') this._setSelection([], id, 'note');
    else if (type === 'chart') this._setSelection([], id, 'chart');
    else this._setSelection([], null, null);
  }
}
