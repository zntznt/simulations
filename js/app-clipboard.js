// Clipboard (copy / paste / duplicate) and the right-click context menu.
//
// These methods were split out of app.js to keep the App class manageable.
// They are mixed onto App.prototype below, so every call site is unchanged
// (this._x(), window.app._x()). Load order in index.html: after app.js, which
// defines class App; the DOMContentLoaded handler that does `new App()` runs
// only after every sync <script> has executed, so the prototype is complete
// by construction time.

class AppClipboard {
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

  _selectAll() {
    const ids = [...this.diagram.nodes.keys()];
    if (!ids.length) { this._toast('Nothing to select yet. Place a node first.'); return; }
    this.editor._setSelection(ids, ids.length === 1 ? ids[0] : null, 'node');
  }

  // ── Context menu (right-click) ──────────────────────────────────────────────
  // Built on demand from a target descriptor the editor hands over. Replaces the
  // old right-click-to-delete gesture with a discoverable menu, and surfaces the
  // otherwise keyboard-only actions (copy, paste, duplicate, save-as-component).

  _showContextMenu(ctx, x, y) {
    this._hideContextMenu(); // clear any prior instance (and its listeners)
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';

    const add = (label, icon, handler, opts = {}) => {
      const b = document.createElement('button');
      b.className = 'menu-item' + (opts.danger ? ' ctx-danger' : '');
      b.setAttribute('role', 'menuitem');
      b.append(this._faIcon(icon), document.createTextNode(' ' + label));
      if (opts.shortcut) {
        const s = document.createElement('span');
        s.className = 'ctx-shortcut';
        s.textContent = opts.shortcut;
        b.appendChild(s);
      }
      if (opts.disabled) b.disabled = true;
      else b.addEventListener('click', () => { this._hideContextMenu(); handler(); });
      menu.appendChild(b);
    };
    const sep = () => { const d = document.createElement('div'); d.className = 'menu-sep'; d.setAttribute('role', 'separator'); menu.appendChild(d); };
    const hasClip = !!(this._clipboard && this._clipboard.nodes && this._clipboard.nodes.length);

    if (ctx.kind === 'node') {
      const n = ctx.count || 1;
      const noun = n > 1 ? `${n} nodes` : 'node';
      add('Duplicate', 'clone', () => this._duplicate(), { shortcut: 'Ctrl+D' });
      add('Copy', 'copy', () => this._copy(), { shortcut: 'Ctrl+C' });
      add('Save as component…', 'shapes', () => this._saveComponentPrompt());
      sep();
      add(`Delete ${noun}`, 'trash-can', () => this._contextDelete(ctx), { shortcut: 'Del', danger: true });
    } else if (ctx.kind === 'element') {
      const nouns = { conn: 'connection', group: 'group', note: 'note', chart: 'chart' };
      add(`Delete ${nouns[ctx.type] || 'item'}`, 'trash-can', () => this._contextDelete(ctx), { shortcut: 'Del', danger: true });
    } else {
      add('Paste', 'paste', () => this._paste(), { shortcut: 'Ctrl+V', disabled: !hasClip });
      add('Select all', 'object-group', () => this._selectAll(), { shortcut: 'Ctrl+A' });
      sep();
      add('Fit to view', 'expand', () => this.renderer.fitView(), { shortcut: 'Ctrl+0' });
    }

    // When opened by keyboard (Shift+F10 / Menu key), x and y are 0 — centre on the canvas.
    if (!x && !y) {
      const canvas = document.getElementById('canvas');
      if (canvas) { const r = canvas.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
    }
    this._ctxReturnFocus = document.activeElement;
    // Show first so we can measure, then clamp inside the viewport.
    menu.classList.remove('hidden');
    const r = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // Dismiss on any outside interaction or Escape. The mousedown that opened the
    // menu already fired before this listener attaches, so it won't self-close.
    this._ctxDismiss = (e) => {
      if (e && e.type === 'mousedown' && menu.contains(e.target)) return;
      if (e && e.type === 'keydown' && e.key !== 'Escape') return;
      this._hideContextMenu();
    };
    window.addEventListener('mousedown', this._ctxDismiss, true);
    window.addEventListener('wheel', this._ctxDismiss, true);
    window.addEventListener('keydown', this._ctxDismiss, true);

    const first = menu.querySelector('.menu-item:not([disabled])');
    if (first) first.focus();

    // Arrow key navigation within the context menu.
    this._ctxKeyNav = (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const items = [...menu.querySelectorAll('.menu-item:not([disabled])')]
        .filter(i => i.offsetParent !== null);
      if (!items.length) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement);
      let next;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'ArrowDown') next = (idx + 1) % items.length;
      else next = (idx - 1 + items.length) % items.length;
      items[next].focus();
    };
    menu.addEventListener('keydown', this._ctxKeyNav);
  }

  _hideContextMenu() {
    const menu = document.getElementById('ctx-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    if (this._ctxReturnFocus && typeof this._ctxReturnFocus.focus === 'function') {
      this._ctxReturnFocus.focus();
      this._ctxReturnFocus = null;
    }
    if (this._ctxKeyNav) {
      menu.removeEventListener('keydown', this._ctxKeyNav);
      this._ctxKeyNav = null;
    }
    if (this._ctxDismiss) {
      window.removeEventListener('mousedown', this._ctxDismiss, true);
      window.removeEventListener('wheel', this._ctxDismiss, true);
      window.removeEventListener('keydown', this._ctxDismiss, true);
      this._ctxDismiss = null;
    }
  }

  // Delete whatever the context menu was opened on (the editor already settled
  // the selection), committing one undo step.
  _contextDelete(ctx) {
    if (ctx.kind === 'node') {
      if (!this.editor.selection.size) return;
      for (const id of this.editor.selection) this.diagram.removeNode(id);
    } else if (ctx.kind === 'element') {
      if (ctx.type === 'conn') this.diagram.removeConnection(ctx.id);
      else if (ctx.type === 'group') this.diagram.removeGroup(ctx.id);
      else if (ctx.type === 'note') this.diagram.removeNote(ctx.id);
      else if (ctx.type === 'chart') this.diagram.removeChart(ctx.id);
    }
    this.editor._select(null, null);
    this.renderer.render();
    this._commit();
    this._toast('Deleted. Press Ctrl+Z to undo.');
  }

  // "Save as component…" from the context menu: open the Library and drop the
  // cursor in the component name field. The selection is untouched, so the
  // existing Save component flow captures exactly what was right-clicked.
  _saveComponentPrompt() {
    if (!this.editor.selection.size) { this._toast('Select nodes first to save a component.'); return; }
    this._openLibrary();
    const input = document.getElementById('comp-name');
    if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); }
  }
}

for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppClipboard.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
