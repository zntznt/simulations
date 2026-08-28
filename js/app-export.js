// Export (SVG / PNG / CSV) and shareable-URL encoding.
//
// These methods were split out of app.js to keep the App class manageable.
// They are mixed onto App.prototype below, so every call site is unchanged
// (this._x(), window.app._x()). Load order in index.html: after app.js, which
// defines class App; the DOMContentLoaded handler that does `new App()` runs
// only after every sync <script> has executed, so the prototype is complete
// by construction time.

class AppExport {
  // ── Export ────────────────────────────────────────────────────────────────

  // Backs every download in the app: SVG, PNG, CSV, .econ, the standalone
  // module, File > Save, and the three analysis exports. The old ASCII-only
  // class turned every character of a non-Latin name into an underscore and
  // then stripped them, returning a bare ".svg" that the browser renames to
  // "svg.svg", so a Chinese or Japanese diagram lost its name entirely and
  // every export collided on one filename. Accented Latin fared little better
  // ("Economie" losing its leading E). Unicode letters and digits are kept, and
  // an empty stem falls back to "diagram" so the result can never start with a
  // dot: a dotfile also cost .econ its extension, the browser rewriting it to
  // "econ.txt" so it no longer matched the app's own file picker.
  _exportFilename(ext) {
    const raw = this.diagram.meta.name || 'diagram';
    const stem = raw.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return (stem || 'diagram') + '.' + ext;
  }

  // Build a standalone snapshot of the diagram, cloned from the live canvas so
  // exporting never touches what is on screen. The live SVG has no width/
  // height/viewBox (it is sized purely by CSS) and leans on the app stylesheet
  // for fonts and label colors, so serializing it raw yields a file that
  // rasterizes at the 300x150 default and loses its styling. The copy gets
  // explicit dimensions from the content bounds (same extents fitView uses),
  // resolved values in place of CSS custom properties, and only the static
  // layers: no balls, flow badges, temp overlays or selection chrome.
  // Returns { svg, w, h, bg }, or null (after a toast) on an empty canvas.
  _buildExportSVG(pad = 40) {
    const live = document.getElementById('canvas');
    const r = this.renderer;
    const box = r._contentBounds();
    if (!box) { this._toast('Nothing to export yet. Add a node first.'); return null; }
    const x = Math.floor(box.minX - pad), y = Math.floor(box.minY - pad);
    const w = Math.ceil(box.maxX - box.minX) + pad * 2;
    const h = Math.ceil(box.maxY - box.minY) + pad * 2;

    // Render once with the selection cleared so glow filters, reshape handles
    // and resize corners never leak into the file, then restore.
    const sel = r.selectedId, multi = r.selectedIds;
    r.selectedId = null; r.selectedIds = new Set();
    r.render();
    const content = svgEl('g');
    for (const layer of [r.groupLayer, r.connLayer, r.nodeLayer, r.chartLayer, r.noteLayer])
      content.appendChild(layer.cloneNode(true));
    r.selectedId = sel; r.selectedIds = multi;
    r.render();

    const out = svgEl('svg', { width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` });
    const defs = live.querySelector('defs').cloneNode(true);
    // The grid/dot patterns track the live pan/zoom; content exports untransformed.
    for (const p of defs.querySelectorAll('pattern')) p.removeAttribute('patternTransform');
    out.appendChild(defs);
    const bg = r._bgRect.getAttribute('fill') || '#0d0e11';
    out.appendChild(svgEl('rect', { x, y, width: w, height: h, fill: bg }));
    out.appendChild(svgEl('rect', { x, y, width: w, height: h, fill: 'url(#grid)' }));
    out.appendChild(content);

    // Strip the editing affordances that exist regardless of selection.
    for (const el of content.querySelectorAll('.conn-hitbox, .conn-handles, .resize-handles, .chart-hover'))
      el.remove();

    // Resolve the styling the live canvas gets from the app stylesheet: the
    // font token in font-family attributes, plus the handful of class rules
    // (css/style.css) that paint node/connection labels.
    const cs = getComputedStyle(document.documentElement);
    const tok = (name) => cs.getPropertyValue(name).trim();
    const font = tok('--font');
    for (const el of out.querySelectorAll('[font-family]'))
      if (el.getAttribute('font-family').startsWith('var(')) el.setAttribute('font-family', font);
    const mono = tok('--mono');
    const style = svgEl('style');
    style.textContent = [
      '.n-count { fill: #fff; font-size: 13px; font-weight: 700; font-family: monospace; }',
      `.n-label, .n-badge, .grp-label { paint-order: stroke; stroke: ${tok('--bg')}; stroke-width: 3px; stroke-linejoin: round; }`,
      // font-family belongs here, not only in the var() rewrite above: that loop
      // only reaches elements that already carry the attribute, so node labels,
      // badges and connection pills fell back to the browser serif in the file.
      `.n-label { fill: ${tok('--text')}; font-size: 11px; font-family: ${font}; }`,
      `.n-badge { fill: ${tok('--text-dim')}; font-size: 11px; font-family: ${font}; }`,
      `.conn-label { fill: ${tok('--text')}; font-family: ${font}; }`,
      // A converter's recipe caption carries no inline fill or size, so without
      // a rule it took the SVG defaults: black at 16px on the exported #0d0e11
      // background, a contrast ratio of about 1.09 to 1, and overrunning the
      // node's label zone at nearly twice the intended size.
      `.n-caption { fill: ${tok('--text-dim')}; font-size: 9px; font-family: ${mono}; }`,
    ].join('\n');
    out.insertBefore(style, defs);
    return { svg: out, w, h, bg };
  }

  _exportSVG() {
    const built = this._buildExportSVG();
    if (!built) return;
    const data = new XMLSerializer().serializeToString(built.svg);
    const blob = new Blob([data], { type: 'image/svg+xml' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: this._exportFilename('svg'),
    });
    a.click();
  }

  _exportPNG() {
    const built = this._buildExportSVG();
    if (!built) return;
    const { svg, w, h, bg } = built;
    const data = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([data], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      // 2x the diagram's natural size, for crispness on high-DPI screens.
      const canvas = document.createElement('canvas');
      canvas.width = w * 2; canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const a = Object.assign(document.createElement('a'), {
        download: this._exportFilename('png'), href: canvas.toDataURL('image/png'),
      });
      a.click();
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // ── CSV export of the recorded run history ──────────────────────────────────

  _csvCell(s) {
    s = String(s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Build a CSV of every tracked node's value at each recorded step.
  _buildCSV() {
    const ids = [];
    for (const n of this.diagram.nodes.values()) {
      if (n.type === NodeType.SOURCE && !n.limited) continue; // infinite sources aren't tracked
      ids.push(n.id);
    }
    const header = ['step', ...ids.map(id => this._csvCell(this.diagram.nodes.get(id)?.label || id))];
    const lines = [header.join(',')];
    for (const h of this.engine.history) {
      lines.push([h.step, ...ids.map(id => h.snap[id] ?? '')].join(','));
    }
    return lines.join('\n');
  }

  _exportCSV() {
    if (!this.engine.history.length) {
      this._toast('Run the simulation first to record history.');
      return;
    }
    const blob = new Blob([this._buildCSV()], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: this._exportFilename('csv'),
    });
    a.click();
  }

  // ── Economy-as-code exports ─────────────────────────────────────────────────

  // Download the diagram as .econ text (the human-readable, diff-friendly
  // format in js/dsl.js). Same File menu family as Save as JSON.
  _exportEcon() {
    const text = dslSerialize(this.diagram.toJSON());
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
      download: this._exportFilename('econ'),
    });
    a.click();
    this._toast('Exported as .econ text. Open it back via File, Open file.');
  }

  // Bundle model + engine + this diagram into a standalone JS module (see
  // js/codegen.js). The sources are fetched from our own script files, so this
  // needs the app to be served over HTTP (the normal case).
  async _exportModule() {
    let modelSrc, engineSrc;
    try {
      [modelSrc, engineSrc] = await Promise.all([
        fetch('js/model.js').then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }),
        fetch('js/engine.js').then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }),
      ]);
    } catch {
      this._toast('Could not read the engine sources. Serve the app over HTTP to export a module.');
      return;
    }
    const mod = buildEconomyModule(this.diagram.toJSON(), modelSrc, engineSrc, { generator: 'the simulations designer' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([mod], { type: 'text/javascript' })),
      download: this._exportFilename('module.js'),
    });
    a.click();
    this._toast('Exported a standalone JS module with a createEconomy() API.');
  }

  // ── Shareable URL ───────────────────────────────────────────────────────────

  _encodeDiagram() {
    const json = JSON.stringify(this.diagram.toJSON());
    return btoa(unescape(encodeURIComponent(json)));
  }

  // Parse a diagram out of the current URL hash (#d=…), or null if absent/bad.
  _decodeDiagram() {
    const m = location.hash.match(/[#&]d=([^&]+)/);
    if (!m) return null;
    try {
      const json = decodeURIComponent(escape(atob(decodeURIComponent(m[1]))));
      return JSON.parse(json);
    } catch { return null; }
  }

  _shareURL() {
    const enc = this._encodeDiagram();
    const url = location.origin + location.pathname + '#d=' + enc;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        () => this._toast('Share link copied to clipboard'),
        () => prompt('Copy this share link:', url),
      );
    } else {
      prompt('Copy this share link:', url);
    }
    // Deliberately NOT written into the address bar. The link goes to the
    // clipboard (or the prompt fallback above), which is how it reaches anyone.
    // Putting it in the location hash pinned this tab to that snapshot instead:
    // _initDiagram reads #d= ahead of autosave, so every later reload silently
    // reverted to the moment of sharing and the first commit afterwards
    // overwrote the autosave that still held the newer work.
  }
}

for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppExport.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
