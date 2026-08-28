// Reusable property-panel form primitives.
//
// These methods were split out of app.js to keep the App class manageable.
// They are mixed onto App.prototype below, so every call site is unchanged
// (this._x(), window.app._x()). Load order in index.html: after app.js, which
// defines class App; the DOMContentLoaded handler that does `new App()` runs
// only after every sync <script> has executed, so the prototype is complete
// by construction time.

// A node's amount field is the reset baseline before a run and the live count
// during one. Both the builder in app-props.js and the per-step patcher below
// name it, and they have to agree, so the two strings live here.
const AMOUNT_LABEL_AT_REST = 'Starting amount';
const AMOUNT_LABEL_LIVE = 'Amount (live)';

class AppFields {
  // ── Props helpers ─────────────────────────────────────────────────────────

  // A plain section header. When a kbId is given and the article exists, a "?"
  // on the right opens that concept's guide entry — used by the diagram-rail
  // feature panels so help is reachable in context, not just by browsing.
  _title(panel, text, kbId = null) {
    const h = document.createElement('h3');
    h.className = 'props-title';
    h.appendChild(document.createTextNode(text));
    if (kbId && typeof KB_ARTICLES !== 'undefined' && KB_ARTICLES.some(a => a.id === kbId)) {
      const help = document.createElement('button');
      help.className = 'props-help';
      help.type = 'button';
      help.innerHTML = '<i class="fa-solid fa-circle-question" aria-hidden="true"></i>';
      help.setAttribute('aria-label', `Learn about ${text} in the guide`);
      help.title = 'Learn about this in the guide';
      help.addEventListener('click', () => this._openKB(kbId));
      h.appendChild(help);
    }
    panel.appendChild(h);
  }

  // Selection header: a small uppercase kind overline with a type-colored dot,
  // then the element's own name large — "what is it" before "which one". When a
  // kbId is given, a "?" on the overline opens that concept's guide article.
  _titleTyped(panel, kind, text, color, kbId = null) {
    const wrap = document.createElement('div');
    wrap.className = 'props-title-block';
    const over = document.createElement('div');
    over.className = 'props-overline';
    const dot = document.createElement('span');
    dot.className = 'props-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.background = color || 'var(--accent)';
    over.appendChild(dot);
    over.appendChild(document.createTextNode(kind));
    if (kbId && typeof KB_ARTICLES !== 'undefined' && KB_ARTICLES.some(a => a.id === kbId)) {
      const help = document.createElement('button');
      help.className = 'props-help';
      help.type = 'button';
      help.innerHTML = '<i class="fa-solid fa-circle-question" aria-hidden="true"></i>';
      help.setAttribute('aria-label', `What is a ${kind}? Open the guide`);
      help.title = 'Learn about this in the guide';
      help.addEventListener('click', () => this._openKB(kbId));
      over.appendChild(help);
    }
    const h = document.createElement('h3');
    h.className = 'props-title';
    h.textContent = text;
    wrap.appendChild(over);
    wrap.appendChild(h);
    panel.appendChild(wrap);
  }

  // Hero readout card (design 4a): the node's headline number, big and mono on
  // a canvas-dark card, with a context line and the history sparkline below.
  _heroCard(panel, node) {
    const card = document.createElement('div');
    card.className = 'hero-card';

    const label = document.createElement('div');
    label.className = 'hero-card-label';
    label.textContent =
      node.type === NodeType.DRAIN ? 'Consumed' :
      node.type === NodeType.TRADER ? 'Trades' :
      node.type === NodeType.REGISTER ? 'Value' :
      node.type === NodeType.QUEUE ? 'In line' : 'Current';
    card.appendChild(label);

    const val = document.createElement('div');
    val.className = 'hero-card-value';
    val.id = 'props-hero-value';
    val.textContent = String(this._panelValueOf(node));
    card.appendChild(val);

    let subText = '';
    if (node.capacity !== undefined && isFinite(node.capacity)) subText = `of ${node.capacity} capacity`;
    else if (node.type === NodeType.DRAIN || node.type === NodeType.TRADER) subText = 'this run';
    else if (node.type === NodeType.REGISTER && node.formula) subText = `ƒx ${node.formula}`;
    if (subText) {
      const sub = document.createElement('div');
      sub.className = 'hero-card-sub';
      sub.textContent = subText;
      card.appendChild(sub);
    }

    panel.appendChild(card);

    const sl = new Sparkline(card, node.id, this.engine);
    // Inherit the scrub immediately. _updateSparklines pushes _scrubIndex into
    // the sparklines it already knows about, but a card built DURING a scrub
    // (selecting another node to see what it was doing at that step) created
    // one at scrubIndex null, so the hero read the replayed value while the
    // trace right below it plotted the whole run and labelled the end of it.
    // The same card contradicting itself, which is what this was meant to end.
    sl.scrubIndex = this._scrubIndex;
    this._sparklines.set(node.id, sl);
    sl.update();
    return card;
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

  // A labelled section header — names the group of controls that follows so
  // the panel reads as a scannable outline instead of anonymous dividers.
  _section(panel, text) {
    const h = document.createElement('div');
    h.className = 'props-sec';
    h.textContent = text;
    panel.appendChild(h);
  }

  // A labelled checkbox row. onChange(checked).
  _checkRow(panel, label, checked, onChange) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.id = this._uid(); lbl.htmlFor = chk.id;
    chk.checked = !!checked;
    chk.addEventListener('change', () => onChange(chk.checked));
    row.appendChild(lbl);
    row.appendChild(chk);
    panel.appendChild(row);
    return chk;
  }

  // A checkbox that reveals an operator + value comparison, editing obj in place.
  // keys = { enabled, op, val, lead }; extraFn(details) may append additional rows.
  _conditionRow(panel, title, obj, keys, extraFn = null) {
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
    // The visible lead ("stop when value") names the operator, so wire it up as
    // a real label; without it the row announced a bare combobox and a bare
    // spin button, and clicking the text focused nothing.
    op.id = this._uid();
    il.htmlFor = op.id;
    op.setAttribute('aria-label', `${title} operator`);
    const ops = ['>', '>=', '<', '<=', '==', '!='];
    if (keys.val2) ops.push('between');
    for (const o of ops) {
      const e = document.createElement('option');
      e.value = o; e.textContent = o === 'between' ? 'a..b' : o;
      if (o === obj[keys.op]) e.selected = true;
      op.appendChild(e);
    }

    const val = document.createElement('input');
    val.type = 'number';
    val.setAttribute('aria-label', `${title} value`);
    val.value = obj[keys.val];
    val.addEventListener('input', () => { obj[keys.val] = parseFloat(val.value) || 0; this.renderer.render(); });

    // Second bound, shown only for the inclusive range operator.
    let val2 = null;
    if (keys.val2) {
      val2 = document.createElement('input');
      val2.type = 'number';
      val2.setAttribute('aria-label', `${title} upper bound`);
      val2.value = obj[keys.val2] || 0;
      val2.style.display = obj[keys.op] === 'between' ? '' : 'none';
      val2.addEventListener('input', () => { obj[keys.val2] = parseFloat(val2.value) || 0; this.renderer.render(); });
    }

    op.addEventListener('change', () => {
      obj[keys.op] = op.value;
      if (val2) val2.style.display = op.value === 'between' ? '' : 'none';
      this.renderer.render();
    });

    inner.appendChild(il);
    inner.appendChild(op);
    inner.appendChild(val);
    if (val2) inner.appendChild(val2);
    details.appendChild(inner);
    if (extraFn) extraFn(details);
    panel.appendChild(details);
    return chk;
  }

  // Unique id generator for programmatic label↔control association.
  _uid() { return 'fld-' + (App._fieldSeq = (App._fieldSeq || 0) + 1); }

  _field(panel, label, type, value, onChange, placeholder = '') {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = type;
    inp.value = value;
    if (placeholder) inp.placeholder = placeholder;
    if (label) { inp.id = this._uid(); lbl.htmlFor = inp.id; }
    else inp.setAttribute('aria-label', placeholder || 'value');
    inp.addEventListener('input', () => onChange(inp.value));
    row.appendChild(lbl);
    row.appendChild(inp);
    panel.appendChild(row);
    return inp;
  }

  // The identifiers a formula can reference right now: diagram parameters,
  // custom variables, named state connections, and register labels. (Mirrors
  // how the engine builds its variable store.)
  _availableVars() {
    const names = new Set();
    for (const k of Object.keys(this.diagram.params || {})) names.add(k);
    for (const v of (this.diagram.customVars || [])) if (v && v.name) names.add(v.name);
    for (const c of this.diagram.connections.values())
      if (c.type === ConnectionType.STATE && c.variableName) names.add(c.variableName);
    for (const n of this.diagram.nodes.values())
      if (n.type === NodeType.REGISTER && VALID_IDENT.test(n.label || '')) names.add(n.label);
    return [...names].sort();
  }

  // A formula text input with live validity feedback and an inline list of the
  // variable names currently in scope — plus the non-obvious tip that a node's
  // value only reaches a formula via a *named* state connection. (Usability
  // study: this was the #1 power-user blocker.)
  _formulaField(panel, value, onChange, opts = {}) {
    const isBad = v => v.trim() !== '' && !validateFormula(v);
    const inp = this._field(panel, opts.label || 'Formula', 'text', value || '', v => {
      onChange(v);
      inp.classList.toggle('invalid', isBad(v));
    }, opts.placeholder || 'e.g. growth_rate * size');
    inp.classList.toggle('invalid', isBad(value || ''));

    const vars = this._availableVars();
    const hint = document.createElement('p');
    hint.className = 'formula-hint';
    if (vars.length) {
      hint.appendChild(document.createTextNode('In scope: '));
      for (const v of vars) {
        const code = document.createElement('code');
        code.textContent = v;
        hint.appendChild(code);
      }
    } else {
      // No vars yet — make "Parameter" a live link to the rail panel where they
      // live, so the formula→Params connection is discoverable at the moment of
      // need (a usability pass found the rail otherwise easy to miss entirely).
      hint.appendChild(document.createTextNode('No variables yet. '));
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'formula-hint-link';
      link.textContent = 'Add a Parameter';
      link.addEventListener('click', () => this._toggleFeature('params'));
      hint.appendChild(link);
      hint.appendChild(document.createTextNode(', or name a State connection to publish a node’s value.'));
    }
    panel.appendChild(hint);

    if (opts.showTip !== false) {
      const tip = document.createElement('p');
      tip.className = 'formula-hint formula-tip';
      tip.textContent = 'Tip: to use a node’s value, draw a State connection from it and give it a name.';
      panel.appendChild(tip);
    }
    return inp;
  }

  _colorField(panel, label, value, onChange, clearable = false, withTypes = false) {
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.id = this._uid();
    picker.setAttribute('aria-label', label);
    picker.value = value || '#ffa726';
    picker.style.cssText = 'width:36px;height:28px;padding:1px;border-radius:4px;cursor:pointer;border:1px solid var(--border);background:none;';
    picker.addEventListener('input', () => onChange(picker.value));

    // When named resource types exist, offer a dropdown that sets the colour to
    // the chosen type's colour (the raw picker stays available for custom hues).
    if (withTypes && this.diagram.resourceTypes.length) {
      const trow = document.createElement('div');
      trow.className = 'prop-row';
      const tl = document.createElement('label');
      tl.textContent = 'Type';
      const ts = document.createElement('select');
      ts.style.flex = '1';
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = '(custom)';
      ts.appendChild(blank);
      const cur = value ? String(value).toLowerCase() : '';
      for (const t of this.diagram.resourceTypes) {
        const o = document.createElement('option');
        o.value = t.color; o.textContent = t.name || '(unnamed)';
        if (t.color && t.color.toLowerCase() === cur) o.selected = true;
        ts.appendChild(o);
      }
      ts.addEventListener('change', () => {
        if (ts.value) { picker.value = ts.value; onChange(ts.value); }
      });
      trow.appendChild(tl); trow.appendChild(ts);
      panel.appendChild(trow);
    }

    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    row.appendChild(lbl);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:6px;align-items:center;flex:1;';
    wrap.appendChild(picker);

    if (clearable) {
      const clear = document.createElement('button');
      clear.appendChild(this._faIcon('xmark'));
      clear.setAttribute('aria-label', 'Clear filter');
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

  // A row of mode chips (16a): one always active, click to switch. `options`
  // is [value, label] pairs or plain strings.
  _chipRow(panel, options, value, onChange, ariaLabel = 'Mode') {
    const row = document.createElement('div');
    row.className = 'var-chip-group chip-row';
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', ariaLabel);
    for (const opt of options) {
      const [v, t] = Array.isArray(opt) ? opt : [opt, opt.charAt(0).toUpperCase() + opt.slice(1)];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'var-chip' + (v === value ? ' active' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(v === value));
      b.textContent = t;
      // Commit here. A chip is the whole edit: unlike an input it fires no
      // `change` event, so nothing else in the panel picks it up, and the switch
      // never reached the undo stack or autosave. Undo afterwards then reverted
      // the previous genuine edit while silently dropping the mode switch.
      // _commit() is a no-op when the snapshot is unchanged, so this stays safe
      // if a callback ever commits on its own.
      b.addEventListener('click', () => { if (v !== value) { onChange(v); this._commit(); } });
      row.appendChild(b);
    }
    panel.appendChild(row);
    return row;
  }

  _select2(panel, label, options, value, onChange) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const sel = document.createElement('select');
    sel.id = this._uid(); lbl.htmlFor = sel.id;
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

  // Rebuild the properties panel, then put focus somewhere deliberate.
  // _renderProps() tears down #props-content, so a handler triggered from a
  // button inside the panel destroys the very element that had focus and it
  // falls back to <body>: no focus ring, nothing announced, and getting back to
  // the row costs a Tab press for every control that survived. pick() runs
  // after the rebuild and returns the element to land on.
  _renderPropsFocused(pick) {
    this._renderProps();
    let el = null;
    try { el = pick ? pick() : null; } catch { el = null; }
    if (el && typeof el.focus === 'function') el.focus();
  }

  // The panel's own "+ Add" button, the sensible landing spot after a row is
  // removed: it is where the user was working and it always exists.
  _panelAddButton() {
    return document.querySelector('#props-content .var-add-btn');
  }

  // What the properties panel should display for a node right now. While the
  // timeline is scrubbed that is the recorded value at the previewed step, not
  // the live model. The canvas and the timeline both had a scrub-aware read
  // path (Renderer._scrubSnap, Timeline.setScrub); the panel never did, so its
  // hero card went on reporting the end of the run while the node beside it
  // showed the replayed step. Two different numbers for the same node.
  _panelValueOf(node) {
    if (this._scrubIndex != null) {
      const entry = this.engine.history[this._scrubIndex];
      const v = entry && entry.snap ? entry.snap[node.id] : undefined;
      if (v !== undefined) return v;
    }
    return node.displayCount;
  }

  _refreshResourceCount() {
    // A diagram-rail feature (Parameters, Custom variables, Artificial player,
    // Design tests) borrows the properties panel without clearing the node
    // selection, so this used to keep running and write the node's live count
    // into whatever the panel's first number input happened to be. That is the
    // parameter's own value box, which then counted up with the node while the
    // model kept the authored number, and one edit committed the wrong value.
    if (this._activeFeature || this._selectedType !== 'node') return;
    const node = this.diagram.nodes.get(this._selectedId);
    if (!node || node.type === NodeType.SOURCE) return;

    // Big hero readout tracks the live value for every node kind.
    const hero = document.getElementById('props-hero-value');
    if (hero) hero.textContent = String(this._panelValueOf(node));
    // Same exclusions the amount field is built under (app-props.js). A Trader
    // has no amount row, so its first number input is the End/goal value, and
    // the refresh below was overwriting that goal with the trader's count.
    if (node.type === NodeType.REGISTER || node.type === NodeType.DRAIN
      || node.type === NodeType.TRADER) return;

    // With a node owning the panel, the first number input is the Resources field.
    const inp = document.querySelector('#props-content input[type="number"]');
    // Not while scrubbing: the field is editable, and writing a replayed value
    // into it invites the user to commit a past step as the current amount.
    if (inp && document.activeElement !== inp && this._scrubIndex == null) inp.value = node.resources;

    // That field means two different things either side of step 0, and the
    // panel is not rebuilt as the run advances, so its label has to be patched
    // here. Without this the row reads "Starting amount" while showing a
    // mid-run count, which is simply untrue.
    const lbl = inp && inp.closest('.prop-row') && inp.closest('.prop-row').querySelector('label');
    if (lbl && (lbl.textContent === AMOUNT_LABEL_AT_REST || lbl.textContent === AMOUNT_LABEL_LIVE)) {
      lbl.textContent = this.engine.step > 0 ? AMOUNT_LABEL_LIVE : AMOUNT_LABEL_AT_REST;
    }
  }

  _updateSparklines() {
    for (const sl of this._sparklines.values()) {
      sl.scrubIndex = this._scrubIndex;
      sl.update();
    }
  }

  _clearSparklines() { for (const sl of this._sparklines.values()) sl.destroy(); this._sparklines.clear(); }
}

for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppFields.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
