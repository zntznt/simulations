// Monte Carlo, parameter sweeps, and sensitivity analysis.
//
// These methods were split out of app.js to keep the App class manageable.
// They are mixed onto App.prototype below, so every call site is unchanged
// (this._x(), window.app._x()). Load order in index.html: after app.js, which
// defines class App; the DOMContentLoaded handler that does `new App()` runs
// only after every sync <script> has executed, so the prototype is complete
// by construction time.

class AppAnalysis {
  // ── Monte Carlo ─────────────────────────────────────────────────────────────

  _openMonteCarlo() {
    this.engine.stop();
    this._syncRunButton();
    document.getElementById('mc-results').innerHTML =
      '<p class="mc-empty">Choose runs &amp; steps, then press Run.</p>';
    // Sweep needs a named parameter to vary — offer whatever the diagram defines.
    const sel = document.getElementById('mc-sweep-param');
    sel.innerHTML = '';
    const names = Object.keys(this.diagram.params || {});
    if (!names.length) {
      sel.appendChild(new Option('(no parameters)', ''));
      sel.disabled = true;
      document.getElementById('mc-sweep-run').disabled = true;
      sel.title = 'Define parameters in the Params rail panel to sweep them';
    } else {
      sel.disabled = false;
      document.getElementById('mc-sweep-run').disabled = false;
      for (const n of names) sel.appendChild(new Option(n, n));
      this._seedSweepRange(names[0]);
    }
    // Sensitivity needs at least one parameter with a non-zero value (a percent
    // perturbation of 0 is a no-op).
    const sensBtn = document.getElementById('mc-sens-run');
    const hasNonZero = names.some(n => isFinite(this.diagram.params[n]) && this.diagram.params[n] !== 0);
    sensBtn.disabled = !hasNonZero;
    sensBtn.title = hasNonZero
      ? 'Perturb each parameter ±10% and heatmap which parameters move which nodes the most'
      : 'Define a non-zero parameter in the Params rail panel to run a sensitivity analysis';
    this._showModal('mc-overlay');
  }

  // Seed the sweep's from/to around a parameter's current value. This ran once,
  // for the first parameter in the list, and nothing re-ran it when the user
  // picked a different one: sweeping any other parameter silently used the
  // first one's range, which for a rate of 3 against a capacity of 500 meant
  // sweeping 1.5 to 4.5.
  _seedSweepRange(name) {
    const cur = this.diagram.params[name];
    if (!isFinite(cur)) return;
    const round = v => Math.round(v * 100) / 100;
    // A parameter sitting at 0 has no scale to spread around, so offer a small
    // absolute range rather than 0 to 0.
    const from = cur === 0 ? 0 : round(cur * 0.5);
    const to = cur === 0 ? 1 : round(cur * 1.5);
    document.getElementById('mc-sweep-from').value = from;
    document.getElementById('mc-sweep-to').value = to;
  }

  _mcSeed() {
    return document.getElementById('mc-seed').value.trim();
  }

  // Progress with a Cancel button. The button is rendered once; subsequent
  // progress updates only rewrite the text span, so the click handler survives.
  // Sets this._mcCancel, which every runner passes to the engine as shouldCancel.
  _mcBeginProgress(out, label) {
    this._mcCancel = false;
    // Mono status line + slim lime progress bar + a red-outline Cancel. The
    // block is rendered once; updates only touch the text and the bar width,
    // so the click handler survives.
    out.innerHTML = '<div class="mc-progress"><p class="mc-empty">'
      + '<span class="mc-prog-text"></span>'
      + '<button class="btn mc-cancel-btn" id="mc-cancel">Cancel</button></p>'
      + '<div class="mc-progress-bar"><div style="width:0%"></div></div></div>';
    out.querySelector('.mc-prog-text').textContent = label;
    document.getElementById('mc-cancel').addEventListener('click', () => {
      this._mcCancel = true;
      const b = document.getElementById('mc-cancel');
      if (b) { b.disabled = true; b.textContent = 'Cancelling…'; }
    });
    this._mcSetRunning(true);
  }

  _mcSetProgress(out, label, done = null, total = null) {
    const t = out.querySelector('.mc-prog-text');
    if (t) t.textContent = label;
    else out.innerHTML = `<p class="mc-empty">${this._esc(label)}</p>`;
    if (done != null && total > 0) {
      const bar = out.querySelector('.mc-progress-bar > div');
      if (bar) bar.style.width = `${Math.round(done / total * 100)}%`;
    }
  }

  // Disable the three run buttons during a batch (and restore each to its prior
  // state afterwards — sweep/sensitivity may be conditionally disabled).
  _mcSetRunning(on) {
    const ids = ['mc-run', 'mc-sweep-run', 'mc-sens-run'];
    if (on) {
      this._mcPrevDisabled = {};
      for (const id of ids) {
        const b = document.getElementById(id);
        if (b) { this._mcPrevDisabled[id] = b.disabled; b.disabled = true; }
      }
    } else {
      for (const id of ids) {
        const b = document.getElementById(id);
        if (b) b.disabled = this._mcPrevDisabled ? !!this._mcPrevDisabled[id] : false;
      }
    }
  }

  async _runMonteCarlo() {
    const runs = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-runs').value) || 100));
    const steps = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-steps').value) || 200));
    const out = document.getElementById('mc-results');
    if (this._mcBusy) return;
    this._mcBusy = true;
    this._mcBeginProgress(out, 'Running…');

    try {
      const t0 = performance.now();
      const res = await this.engine.runMonteCarloAsync(runs, steps, {
        seed: this._mcSeed() || null,
        shouldCancel: () => this._mcCancel,
        onProgress: (done, total) => this._mcSetProgress(out, `Running… ${done} / ${total}`, done, total),
      });
      if (!res) { out.innerHTML = '<p class="mc-empty">Cancelled.</p>'; return; }
      const ms = Math.round(performance.now() - t0);
      this._mcLast = res;

      const mcName = this.diagram.meta.name || 'Untitled';
      let html = `<p class="mc-summary">${res.runs} runs × ${res.maxSteps} steps`
        + ` for <b>${this._esc(mcName)}</b>`
        + (res.seed ? `, seed <b>${this._esc(res.seed)}</b>` : '')
        + ` <span style="color:var(--text-dim)">(${ms} ms)</span>`;
      if (res.endStep) {
        html += `<br>Goal reached in <b>${Math.round(res.endedRate * 100)}%</b> of runs`
          + `, with an end-step mean of <b>${res.endStep.mean}</b> (min ${res.endStep.min}, max ${res.endStep.max}).`;
      }
      html += '</p>';

      // Deterministic model → every run is identical → no distribution. Say so,
      // rather than leaving the user puzzling over min==max across the board.
      const noSpread = res.nodes.length > 0 && res.nodes.every(n => n.min === n.max);
      if (noSpread) {
        html += '<p class="mc-stale-badge">All runs are identical. This model is '
          + 'deterministic (no randomness). Add a Dice or Distribution rate, a chance %, '
          + 'a probabilistic gate, or a random variable to see a distribution.</p>';
      }

      html += '<table><thead><tr><th>Node</th><th>distribution</th><th>mean</th><th>min</th>'
        + '<th>p10</th><th>p50</th><th>p90</th><th>max</th></tr></thead><tbody>';
      for (const n of res.nodes) {
        // Mini histogram of final values across all runs: where did this node
        // actually land, not just its summary stats.
        const { counts } = SimEngine.histogram(n.samples, 14);
        const peak = Math.max(...counts, 1);
        const bars = counts.map(c => {
          const h = c === 0 ? 0 : Math.max(8, Math.round((c / peak) * 100));
          return `<span class="mc-bar" style="height:${h}%" title="${c} runs"></span>`;
        }).join('');
        const hist = `<div class="mc-hist" role="img" aria-label="distribution of final values">${bars}</div>`;
        html += `<tr><td>${this._esc(n.label || n.type)}</td>`
          + `<td class="mc-hist-cell">${hist}</td>`
          + `<td>${n.mean}</td><td>${n.min}</td><td>${n.p10}</td>`
          + `<td>${n.p50}</td><td>${n.p90}</td><td>${n.max}</td></tr>`;
      }
      html += '</tbody></table>';
      html += '<p class="mc-actions"><button class="btn" id="mc-export-raw">'
        + '<i class="fa-solid fa-download" aria-hidden="true"></i> Export raw results (CSV)</button></p>';
      out.innerHTML = html;
      document.getElementById('mc-export-raw')
        .addEventListener('click', () => this._exportMCRaw());
    } finally {
      this._mcBusy = false;
      this._mcSetRunning(false);
    }
  }

  // One row per run, one column per tracked node's final value — ready for
  // R / pandas / a spreadsheet. The on-screen stats are derived from this.
  _exportMCRaw() {
    const res = this._mcLast;
    if (!res) return;
    const header = ['run', ...res.nodes.map(n => this._csvCell(n.label || n.type))];
    const lines = [header.join(',')];
    for (let r = 0; r < res.runs; r++) {
      lines.push([r + 1, ...res.nodes.map(n => n.samples[r] ?? '')].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: this._exportFilename('mc.csv'),
    });
    a.click();
  }

  // Sweep results as CSV: one column per swept parameter value, one row per
  // node (mean final value), matching the on-screen matrix.
  _exportSweepCSV() {
    const s = this._sweepLast;
    if (!s) return;
    const header = ['node', ...s.values.map(v => this._csvCell(`${s.name}=${v}`))];
    const lines = [header.join(',')];
    for (let n = 0; n < s.results[0].nodes.length; n++) {
      const label = s.results[0].nodes[n].label || s.results[0].nodes[n].type;
      lines.push([this._csvCell(label), ...s.results.map(r => r.nodes[n].mean)].join(','));
    }
    if (s.results.some(r => r.endStep)) {
      lines.push([this._csvCell('Goal reached %'), ...s.results.map(r => Math.round(r.endedRate * 100))].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: this._exportFilename('sweep.csv'),
    });
    a.click();
  }

  // Parameter sweep: run the batch once per value of one diagram parameter
  // (on clones — the live diagram is untouched) and tabulate per-node means
  // so the parameter's effect is visible at a glance.
  async _runSweep() {
    const name = document.getElementById('mc-sweep-param').value;
    if (!name) return;
    const runs = Math.max(1, Math.min(1000, parseInt(document.getElementById('mc-runs').value) || 100));
    const steps = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-steps').value) || 200));
    const from = parseFloat(document.getElementById('mc-sweep-from').value) || 0;
    const to = parseFloat(document.getElementById('mc-sweep-to').value) || 0;
    const count = Math.max(2, Math.min(11, parseInt(document.getElementById('mc-sweep-count').value) || 5));
    const out = document.getElementById('mc-results');
    if (this._mcBusy) return;
    this._mcBusy = true;
    this._mcBeginProgress(out, 'Sweeping…');

    try {
      const values = Array.from({ length: count },
        (_, i) => Math.round((from + (to - from) * (i / (count - 1))) * 10000) / 10000);
      const seed = this._mcSeed() || null;
      const base = this.diagram.toJSON();
      const results = [];
      for (let i = 0; i < values.length; i++) {
        const json = typeof structuredClone === 'function'
          ? structuredClone(base) : JSON.parse(JSON.stringify(base));
        json.params = { ...(json.params || {}), [name]: values[i] };
        const res = await this.engine.runMonteCarloAsync(runs, steps, {
          baseJSON: json,
          // Same sub-seed per value: differences between columns come from the
          // parameter, not from a fresh random stream.
          seed,
          shouldCancel: () => this._mcCancel,
          onProgress: (done, total) => this._mcSetProgress(out,
            `Sweeping ${name} = ${values[i]} (${i + 1}/${values.length}), run ${done}/${total}`,
            i * total + done, values.length * total),
        });
        if (!res) { out.innerHTML = '<p class="mc-empty">Cancelled.</p>'; return; }
        results.push(res);
      }

      let html = `<p class="mc-summary">Sweep <b>${this._esc(name)}</b> ∈ [${values[0]} … ${values[values.length - 1]}]`
        + `, ${runs} runs × ${steps} steps per value`
        + (seed ? `, seed <b>${this._esc(seed)}</b>` : '') + '<br>'
        + '<span style="color:var(--text-dim)">Cells show the mean final value across runs.</span></p>';
      // Escaped: `name` is a parameter name straight out of the loaded diagram,
      // which is untrusted input (a shared #d= link, a downloaded .json/.econ,
      // a library component). Every other interpolation in this function
      // escapes; this one did not, so a parameter named with an <img onerror>
      // ran the diagram author's script in the app's own origin the moment the
      // reader pressed Run sweep.
      html += '<table><thead><tr><th>Node</th>'
        + values.map(v => `<th>${this._esc(name)}=${v}</th>`).join('') + '</tr></thead><tbody>';
      for (let n = 0; n < results[0].nodes.length; n++) {
        html += `<tr><td>${this._esc(results[0].nodes[n].label || results[0].nodes[n].type)}</td>`
          + results.map(r => `<td>${r.nodes[n].mean}</td>`).join('') + '</tr>';
      }
      if (results.some(r => r.endStep)) {
        html += '<tr><td>Goal reached</td>'
          + results.map(r => `<td>${Math.round(r.endedRate * 100)}%</td>`).join('') + '</tr>';
      }
      html += '</tbody></table>';
      html += '<p class="mc-actions"><button class="btn" id="mc-export-sweep">'
        + '<i class="fa-solid fa-download" aria-hidden="true"></i> Export sweep (CSV)</button></p>';
      // Stash for export: param name, the swept values, and per-node means.
      this._sweepLast = { name, values, results };
      out.innerHTML = html;
      document.getElementById('mc-export-sweep')
        .addEventListener('click', () => this._exportSweepCSV());
    } finally {
      this._mcBusy = false;
      this._mcSetRunning(false);
    }
  }

  // ── Sensitivity analysis ─────────────────────────────────────────────────────
  // Perturb every diagram parameter by ±pct% one at a time and measure how much
  // each tracked node's mean outcome responds. The metric per (parameter, node)
  // cell is the central-difference **elasticity** — the % change in the node's
  // mean final value per 1% change in the parameter:
  //
  //     E = ((H − L) / B) / (2·δ)
  //
  // where B is the baseline mean, H/L the mean with the parameter scaled up/down
  // by δ. Elasticity is dimensionless, so values are comparable across the whole
  // grid: which knobs move which outputs, and by how much. Each batch reuses the
  // existing Monte Carlo runner on a clone (the live diagram is untouched), and
  // all batches share one seed (common random numbers) so cell differences come
  // from the parameter, not RNG noise.
  async _runSensitivity() {
    const allParams = Object.entries(this.diagram.params || {});
    // Only parameters with a non-zero value can be scaled by a percentage.
    const params = allParams.filter(([, v]) => isFinite(v) && v !== 0);
    const skipped = allParams.filter(([, v]) => !(isFinite(v) && v !== 0)).map(([k]) => k);
    const out = document.getElementById('mc-results');
    if (!params.length) {
      out.innerHTML = '<p class="mc-empty">No non-zero parameters to perturb. '
        + 'Define a parameter with a non-zero value in the Params rail panel, then try again.</p>';
      return;
    }
    if (this._mcBusy) return;
    this._mcBusy = true;

    const runs = Math.max(1, Math.min(1000, parseInt(document.getElementById('mc-runs').value) || 100));
    const steps = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-steps').value) || 200));
    const pct = Math.max(1, Math.min(50, parseFloat(document.getElementById('mc-sens-pct').value) || 10));
    const delta = pct / 100;
    // Common random numbers: a shared seed across baseline/low/high isolates the
    // parameter's effect from sampling noise. Default to a fixed internal seed.
    const seed = this._mcSeed() || 'sensitivity';
    const base = this.diagram.toJSON();
    const clone = () => (typeof structuredClone === 'function'
      ? structuredClone(base) : JSON.parse(JSON.stringify(base)));
    const totalBatches = 1 + params.length * 2;
    let batch = 0;
    const prog = (label) => (done, total) => this._mcSetProgress(out,
      `Sensitivity: ${label} (batch ${batch}/${totalBatches}), run ${done}/${total}`,
      (batch - 1) * total + done, totalBatches * total);
    const cancelled = () => { out.innerHTML = '<p class="mc-empty">Cancelled.</p>'; };

    try {
      batch = 1;
      this._mcBeginProgress(out, 'Sensitivity: baseline…');
      const baseRes = await this.engine.runMonteCarloAsync(runs, steps, {
        baseJSON: base, seed, shouldCancel: () => this._mcCancel, onProgress: prog('baseline'),
      });
      if (!baseRes) { cancelled(); return; }
      const nodes = baseRes.nodes;                 // [{id,label,type,mean,…}]
      const baseline = nodes.map(n => n.mean);

      // matrix[paramIndex][nodeIndex] = elasticity (null when undefined).
      const matrix = [];
      for (let p = 0; p < params.length; p++) {
        const [name, val] = params[p];

        const lowJSON = clone();
        lowJSON.params = { ...(lowJSON.params || {}), [name]: val * (1 - delta) };
        batch++;
        const lowRes = await this.engine.runMonteCarloAsync(runs, steps, {
          baseJSON: lowJSON, seed, shouldCancel: () => this._mcCancel, onProgress: prog(`${name} −${pct}%`),
        });
        if (!lowRes) { cancelled(); return; }

        const highJSON = clone();
        highJSON.params = { ...(highJSON.params || {}), [name]: val * (1 + delta) };
        batch++;
        const highRes = await this.engine.runMonteCarloAsync(runs, steps, {
          baseJSON: highJSON, seed, shouldCancel: () => this._mcCancel, onProgress: prog(`${name} +${pct}%`),
        });
        if (!highRes) { cancelled(); return; }

        matrix.push(nodes.map((n, i) => {
          const B = baseline[i];
          if (Math.abs(B) < 1e-9) return null;     // relative sensitivity undefined
          const H = highRes.nodes[i].mean, L = lowRes.nodes[i].mean;
          return ((H - L) / B) / (2 * delta);
        }));
      }

      this._sensLast = {
        params: params.map(([k]) => k), nodes, baseline, matrix,
        pct, runs, steps, seed, skipped,
      };
      out.innerHTML = this._renderSensitivity(this._sensLast);
      document.getElementById('mc-export-sens')
        .addEventListener('click', () => this._exportSensitivityCSV());
    } finally {
      this._mcBusy = false;
      this._mcSetRunning(false);
    }
  }

  // Diverging cell colour for an elasticity: green when the node moves with the
  // parameter, red when it moves against; brighter = stronger. Magnitude is
  // clamped at `cap` so a few large values don't wash out the rest of the grid.
  _sensColor(e) {
    if (e == null || !isFinite(e) || e === 0) return 'transparent';
    const cap = 1.5;
    const a = Math.max(0.08, Math.min(1, Math.abs(e) / cap) * 0.82);
    const rgb = e > 0 ? '76,175,80' : '239,83,80';
    return `rgba(${rgb},${a.toFixed(3)})`;
  }

  _renderSensitivity(s) {
    const { params, nodes, baseline, matrix, pct, runs, steps, seed, skipped } = s;
    const esc = v => this._esc(v);
    // Per-parameter influence = mean |elasticity| across nodes; the largest is
    // the most influential knob.
    let topName = null, topScore = -1;
    const paramScore = params.map((name, p) => {
      const vals = matrix[p].filter(v => v != null && isFinite(v)).map(Math.abs);
      const score = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      if (score > topScore) { topScore = score; topName = name; }
      return score;
    });
    const fmt = e => (Math.abs(e) >= 100 ? String(Math.round(e)) : String(Math.round(e * 100) / 100));

    let html = `<p class="mc-summary">Sensitivity: each parameter perturbed <b>±${pct}%</b>`
      + `, ${runs} runs × ${steps} steps per batch, seed <b>${esc(seed)}</b><br>`
      + '<span style="color:var(--text-dim)">Cells show <b>elasticity</b>: the % change in a node’s '
      + 'mean final value per 1% change in the parameter. '
      + 'Green = moves the same way, red = moves the opposite way; brighter = stronger.</span></p>';

    if (topName != null && topScore > 0) {
      html += `<p class="sens-top">Most influential parameter: <b>${esc(topName)}</b> `
        + `(mean |elasticity| ${topScore.toFixed(2)}).</p>`;
    } else {
      html += '<p class="mc-stale-badge">No parameter measurably moved any node. The perturbed '
        + 'parameters may be unused, or their effect rounds away at this scale.</p>';
    }

    html += '<div class="sens-legend"><span>opposite</span>'
      + '<span class="sens-grad" role="img" aria-label="red to green elasticity scale"></span>'
      + '<span>same direction</span>'
      + '<span style="margin-left:auto">“n/a” = baseline ≈ 0 (undefined)</span></div>';

    html += '<table class="sens-table"><thead><tr><th>Node</th>'
      + params.map((name, p) => `<th title="mean |elasticity| ${paramScore[p].toFixed(2)}">${esc(name)}</th>`).join('')
      + '</tr></thead><tbody>';
    for (let i = 0; i < nodes.length; i++) {
      const label = esc(nodes[i].label || nodes[i].type);
      html += `<tr><td title="baseline mean ${baseline[i]}">${label}</td>`;
      for (let p = 0; p < params.length; p++) {
        const e = matrix[p][i];
        if (e == null || !isFinite(e)) {
          html += '<td class="sens-na" title="baseline ≈ 0, so relative sensitivity is undefined">n/a</td>';
        } else {
          html += `<td class="sens-cell" style="background:${this._sensColor(e)}" `
            + `title="${esc(params[p])} → ${label}: elasticity ${fmt(e)}">${fmt(e)}</td>`;
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    if (skipped && skipped.length) {
      html += `<p class="mc-stale-badge">Skipped (value 0, can’t scale by a percent): `
        + `${skipped.map(esc).join(', ')}.</p>`;
    }
    html += '<p class="mc-actions"><button class="btn" id="mc-export-sens">'
      + '<i class="fa-solid fa-download" aria-hidden="true"></i> Export sensitivity (CSV)</button></p>';
    return html;
  }

  // One row per node: baseline mean plus an elasticity column per parameter.
  _exportSensitivityCSV() {
    const s = this._sensLast;
    if (!s) return;
    const header = ['node', 'baseline_mean', ...s.params.map(p => this._csvCell(`elasticity:${p}`))];
    const lines = [header.join(',')];
    for (let i = 0; i < s.nodes.length; i++) {
      const row = [this._csvCell(s.nodes[i].label || s.nodes[i].type), s.baseline[i]];
      for (let p = 0; p < s.params.length; p++) {
        const e = s.matrix[p][i];
        row.push(e == null || !isFinite(e) ? '' : Math.round(e * 10000) / 10000);
      }
      lines.push(row.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: this._exportFilename('sensitivity.csv'),
    });
    a.click();
  }

  // ── Design tests (assertions) ───────────────────────────────────────────────
  // The Checks rail panel: edit the assertions saved with the diagram and check
  // them against a fresh isolated run, or across a Monte Carlo batch, without
  // touching the live canvas state. CLI twin: `node cli.js <file> --check`.

  _designTestsPanel(panel) {
    this._info(panel, 'Design tests are saved with the diagram and checked against a fresh run, so the canvas state is never touched. The command line runs the same checks with node cli.js file --check and exits with code 2 on failure, which makes balance regressions fail CI.');

    const list = this.diagram.assertions;
    list.forEach((src, i) => {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = src;
      inp.placeholder = 'always gold < 500';
      inp.style.cssText = 'flex:1;font-family:var(--mono);font-size:11px;min-width:0;';
      const validate = () => {
        let ok = true;
        try { parseAssertion(inp.value); } catch { ok = false; }
        const flag = !ok && inp.value.trim();
        inp.style.borderColor = flag ? 'var(--red)' : '';
        inp.title = flag ? 'Does not parse. Use a quantifier (always, never, eventually, at end, at step N) plus a formula.' : '';
      };
      validate();
      // Update live while typing; the panel's delegated change listener
      // commits one undo step on blur (same pattern as the Params editor).
      inp.addEventListener('input', () => { list[i] = inp.value; validate(); });
      const del = document.createElement('button');
      del.className = 'btn';
      del.style.cssText = 'padding:2px 8px;flex-shrink:0';
      del.setAttribute('aria-label', 'Delete check');
      del.appendChild(this._faIcon('xmark'));
      del.addEventListener('click', () => {
        list.splice(i, 1);
        this._renderPropsFocused(() => this._panelAddButton());
        this._commit();
      });
      row.appendChild(inp); row.appendChild(del);
      panel.appendChild(row);
    });

    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'props-empty';
      p.textContent = 'No checks yet. Examples: always gold < 500, eventually score >= 100, at step 25: queue <= 3. Node labels (spaces become underscores), variables and step are all usable in the formula.';
      panel.appendChild(p);
    }

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add check';
    addBtn.className = 'btn var-add-btn';
    addBtn.addEventListener('click', () => {
      list.push('');
      // The new check is the last row, and it is empty and waiting for input.
      this._renderPropsFocused(() => {
        const rows = document.querySelectorAll('#props-content .prop-row input[type="text"]');
        return rows[rows.length - 1];
      });
      this._commit();
    });
    panel.appendChild(addBtn);

    this._section(panel, 'Check against a run');
    this._field(panel, 'Steps', 'number', this._checkSteps ?? 200, v => {
      this._checkSteps = Math.max(1, parseInt(v) || 200);
    });
    this._field(panel, 'Monte Carlo runs', 'number', this._checkRuns ?? 100, v => {
      this._checkRuns = Math.max(1, parseInt(v) || 100);
    });

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const onceBtn = document.createElement('button');
    onceBtn.className = 'btn';
    onceBtn.id = 'check-run-once';
    onceBtn.style.flex = '1';
    onceBtn.append(this._faIcon('play'), ' Check once');
    const mcBtn = document.createElement('button');
    mcBtn.className = 'btn';
    mcBtn.id = 'check-run-mc';
    mcBtn.style.flex = '1';
    mcBtn.append(this._faIcon('dice'), ' Check batch');
    btnRow.appendChild(onceBtn); btnRow.appendChild(mcBtn);
    panel.appendChild(btnRow);

    const results = document.createElement('div');
    results.id = 'design-check-results';
    results.style.marginTop = '8px';
    panel.appendChild(results);
    if (this._checkResults) this._renderCheckResults(results, this._checkResults);

    const busy = (on, msg) => {
      onceBtn.disabled = on; mcBtn.disabled = on;
      if (on) results.textContent = msg;
    };
    onceBtn.addEventListener('click', async () => {
      this.engine.stop(); this._syncRunButton();
      busy(true, 'Checking, one run…');
      this._checkResults = await this._runDesignChecks(this._checkSteps ?? 200);
      busy(false);
      this._renderCheckResults(results, this._checkResults);
    });
    mcBtn.addEventListener('click', async () => {
      this.engine.stop(); this._syncRunButton();
      const runs = this._checkRuns ?? 100;
      busy(true, `Checking, ${runs} runs…`);
      this._checkResults = await this._runDesignChecksMC(runs, this._checkSteps ?? 200,
        (done, total) => { results.textContent = `Checking run ${done} / ${total}…`; });
      busy(false);
      this._renderCheckResults(results, this._checkResults);
    });
  }

  // Parse the saved assertion list into checkable + broken entries.
  _parseDesignChecks() {
    const valid = [], invalid = [];
    for (const s of this.diagram.assertions || []) {
      const t = String(s || '').trim();
      if (!t) continue;
      try { valid.push(parseAssertion(t)); }
      catch { invalid.push({ src: t, pass: false, detail: 'does not parse', invalid: true }); }
    }
    return { valid, invalid };
  }

  // Check the saved assertions against one fresh isolated run (the diagram's
  // own seed applies, like the CLI). Resolves to a result object for
  // _renderCheckResults; also used directly by the smoke test.
  async _runDesignChecks(steps = 200) {
    const { valid, invalid } = this._parseDesignChecks();
    const base = this.diagram.toJSON();
    const dg = new Diagram();
    dg.loadJSON(typeof structuredClone === 'function' ? structuredClone(base) : JSON.parse(JSON.stringify(base)));
    const eng = new SimEngine(dg);
    const checker = new AssertionChecker(valid);
    eng.reset();
    checker.check(eng);
    for (let i = 0; i < steps && !eng.ended; i++) { eng.doStep(); checker.check(eng); }
    // Never leak the clone's seeded stream into the live session.
    if (dg.seed) SimRandom.seed(null);
    return { mode: 'single', steps: eng.step, ended: !!eng.ended, results: [...checker.finish(eng), ...invalid] };
  }

  // Check the saved assertions inside every trial of a Monte Carlo batch
  // (seeded from the diagram's run seed when one is set).
  async _runDesignChecksMC(runs = 100, steps = 200, onProgress = null) {
    const { valid, invalid } = this._parseDesignChecks();
    const checkers = new Map();
    const perRun = [];
    await this.engine.runMonteCarloAsync(runs, steps, {
      seed: this.diagram.seed || null,
      perStep: (eng, r) => {
        if (!checkers.has(r)) checkers.set(r, new AssertionChecker(valid));
        checkers.get(r).check(eng);
      },
      onTrialEnd: (eng, r) => { perRun[r] = checkers.get(r).finish(eng); checkers.delete(r); },
      onProgress,
    });
    let cleanRuns = 0;
    const agg = valid.map(a => ({ src: a.src, fails: 0, first: null }));
    for (let r = 0; r < perRun.length; r++) {
      let clean = true;
      (perRun[r] || []).forEach((res, i) => {
        if (!res.pass) {
          clean = false;
          agg[i].fails++;
          if (!agg[i].first) agg[i].first = `run ${r + 1}: ${res.detail}`;
        }
      });
      if (clean) cleanRuns++;
    }
    return { mode: 'mc', runs, steps, cleanRuns, results: agg, invalid };
  }

  // ── Feedback loops panel ────────────────────────────────────────────────────
  // The Loops rail panel: detect every feedback cycle in the causal graph
  // (js/loops.js), classify it, and spotlight it on the canvas on click.

  _loopsPanel(panel) {
    this._info(panel, 'Every feedback cycle in the diagram, found across flows, triggers, activators, modifiers and formula reads. R loops amplify (even count of negative links), B loops stabilize (odd count), F is a pure resource circulation and ? means a link has no clear direction. Click a loop to spotlight it on the canvas.');

    const { loops, truncated } = detectLoops(this.diagram);
    if (!loops.length) {
      const p = document.createElement('p');
      p.className = 'props-empty';
      // A truncated search that found nothing has not shown there is nothing:
      // saying so flatly told users of one long ring that their diagram had no
      // loops at all.
      p.textContent = truncated
        ? 'No feedback loops found within the search limit. This graph is large enough that the search stopped early, so a longer or more tangled loop could still exist. Try splitting the diagram into smaller pieces to check.'
        : 'No feedback loops found. Loops appear when influence returns to where it started, for example a pool feeding a converter whose output flows back, or a register that modifies the pool it reads.';
      panel.appendChild(p);
      return;
    }

    const badgeColors = { R: '#bf360c', B: '#1565c0', F: '#455a64', '?': '#616161' };
    const badgeNames = { R: 'reinforcing (amplifies)', B: 'balancing (stabilizes)', F: 'resource circulation', '?': 'unclear link direction' };
    const signGlyph = s => (s > 0 ? '+' : (s < 0 ? '-' : '?'));

    const count = document.createElement('div');
    count.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:4px;';
    const byType = loops.reduce((m, l) => { m[l.type] = (m[l.type] || 0) + 1; return m; }, {});
    count.textContent = `${loops.length} loop${loops.length === 1 ? '' : 's'}: `
      + ['R', 'B', 'F', '?'].filter(t => byType[t]).map(t => `${byType[t]} ${t}`).join(', ')
      + (truncated ? ' (large graph, some longer loops omitted)' : '');
    panel.appendChild(count);

    loops.forEach((loop, i) => {
      const row = document.createElement('div');
      row.className = 'loop-row';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      const active = this._activeLoopIdx === i;
      row.style.cssText = 'display:flex;align-items:baseline;gap:6px;padding:4px 6px;margin:2px 0;'
        + 'border-radius:6px;cursor:pointer;border:1px solid '
        + (active ? 'var(--accent)' : 'var(--border)') + ';';

      const badge = document.createElement('span');
      badge.textContent = loop.type;
      badge.title = badgeNames[loop.type];
      badge.style.cssText = 'display:inline-block;min-width:16px;text-align:center;padding:1px 5px;'
        + `border-radius:9px;font-size:10px;font-weight:700;color:#fff;flex-shrink:0;background:${badgeColors[loop.type]};`;

      const body = document.createElement('div');
      body.style.cssText = 'min-width:0;';
      const chain = document.createElement('div');
      chain.style.cssText = 'font-size:11px;word-break:break-word;';
      chain.textContent = [...loop.labels, loop.labels[0]].join(' → ');
      const detail = document.createElement('div');
      detail.style.cssText = 'font-size:10px;color:var(--text-dim);font-family:var(--mono);';
      detail.textContent = loop.links.map(l => `${signGlyph(l.sign)} ${l.kinds.join('/')}`).join(', ');
      body.appendChild(chain); body.appendChild(detail);

      row.appendChild(badge); row.appendChild(body);
      const toggle = () => this._spotlightLoop(active ? null : i, loop);
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      panel.appendChild(row);
    });
  }

  // Spotlight loop `i` on the canvas (null clears). Rerenders the panel so
  // the active row is outlined.
  _spotlightLoop(i, loop) {
    this._activeLoopIdx = i == null ? null : i;
    this.renderer.emphasis = i == null ? null : {
      nodes: new Set(loop.nodes),
      conns: new Set(loop.connIds),
    };
    this.renderer.render();
    this._renderProps();
  }

  // ── Spike attribution (why-popover) ─────────────────────────────────────────
  // Clicking a point on the timeline asks "why did this change here": a small
  // popover breaks the step's delta into inflows, outflows and modifiers
  // (js/attribution.js) and spotlights the contributing connections.

  _showWhyPopover(nodeId, index, clientX, clientY) {
    this._closeWhyPopover();
    const data = attributeChange(this.diagram, this.engine.history, nodeId, index);
    if (!data) return;

    const fmt = v => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));
    const signed = v => (v > 0 ? '+' : '') + fmt(v);

    const pop = document.createElement('div');
    pop.id = 'why-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Change breakdown for ${data.label}`);
    pop.style.cssText = 'position:fixed;z-index:1000;max-width:300px;min-width:230px;'
      + 'background:var(--panel);border:1px solid var(--accent);border-radius:10px;'
      + 'padding:10px 12px;font-size:11px;color:var(--text);box-shadow:0 8px 24px rgba(0,0,0,.45);';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:baseline;gap:6px;margin-bottom:2px;';
    const name = document.createElement('b');
    name.textContent = data.label;
    const span = document.createElement('span');
    span.style.cssText = 'color:var(--text-dim);font-size:10px;';
    span.textContent = data.initial ? 'run start'
      : (data.fromStep + 1 === data.toStep ? `step ${data.toStep}` : `steps ${data.fromStep} → ${data.toStep}`);
    head.appendChild(name); head.appendChild(span);
    pop.appendChild(head);

    const deltaLine = document.createElement('div');
    deltaLine.style.cssText = 'font-family:var(--mono);font-size:11px;margin-bottom:6px;';
    deltaLine.textContent = data.initial
      ? `starts at ${fmt(data.to)}`
      : `${fmt(data.from)} → ${fmt(data.to)}  (Δ ${signed(data.delta)})`;
    pop.appendChild(deltaLine);

    const row = (amount, label, dim) => {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;gap:8px;align-items:baseline;margin:2px 0;';
      const a = document.createElement('span');
      a.style.cssText = 'font-family:var(--mono);min-width:44px;text-align:right;flex-shrink:0;'
        + `color:${amount > 0 ? 'var(--green)' : (amount < 0 ? 'var(--red)' : 'var(--text-dim)')};`;
      a.textContent = signed(amount);
      const t = document.createElement('span');
      t.style.cssText = 'word-break:break-word;' + (dim ? 'color:var(--text-dim);' : '');
      t.textContent = label;
      r.appendChild(a); r.appendChild(t);
      pop.appendChild(r);
    };

    if (data.initial) {
      const p = document.createElement('div');
      p.style.cssText = 'color:var(--text-dim);';
      p.textContent = 'This is the run start. Click a later point to see what changed it.';
      pop.appendChild(p);
    } else if (data.register) {
      const p = document.createElement('div');
      p.style.cssText = 'color:var(--text-dim);';
      p.textContent = 'A register recomputes its formula every step, so its change comes from the inputs the formula reads, not from flows.';
      pop.appendChild(p);
    } else if (!data.entries.length && data.delta === 0) {
      const p = document.createElement('div');
      p.style.cssText = 'color:var(--text-dim);';
      p.textContent = 'No change across this span.';
      pop.appendChild(p);
    } else {
      for (const e of data.entries) row(e.amount, `${e.label} (${e.kind})`);
      if (data.residual !== 0) row(data.residual, 'internal changes (conversions, queue losses, clamps)', true);
    }

    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:6px;font-size:10px;color:var(--text-dim);';
    hint.textContent = 'Esc or click away to close';
    pop.appendChild(hint);

    document.body.appendChild(pop);
    const rect = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(clientX + 12, window.innerWidth - rect.width - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(clientY + 12, window.innerHeight - rect.height - 8)) + 'px';

    // Spotlight the node and its contributing connections while open.
    this._whyPrevEmphasis = this.renderer.emphasis;
    const nodes = new Set([nodeId]);
    const conns = new Set();
    for (const e of data.entries) {
      if (!e.connId) continue;
      conns.add(e.connId);
      const c = this.diagram.connections.get(e.connId);
      if (c) { nodes.add(c.sourceId); nodes.add(c.targetId); }
    }
    this.renderer.emphasis = { nodes, conns };
    this.renderer.render();

    const onKey = (e) => { if (e.key === 'Escape') this._closeWhyPopover(); };
    const onDown = (e) => { if (!pop.contains(e.target)) this._closeWhyPopover(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    this._whyPopover = pop;
    this._whyCleanup = () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }

  _closeWhyPopover() {
    if (!this._whyPopover) return;
    this._whyCleanup?.();
    this._whyPopover.remove();
    this._whyPopover = null;
    this._whyCleanup = null;
    this.renderer.emphasis = this._whyPrevEmphasis || null;
    this._whyPrevEmphasis = null;
    this.renderer.render();
  }

  _renderCheckResults(container, data) {
    container.innerHTML = '';
    // Darker fills than the raw tokens so white text keeps WCAG AA contrast
    // (matches .btn-primary / the running Run button convention).
    const chip = (pass, text) => {
      const c = document.createElement('span');
      c.textContent = text;
      c.style.cssText = 'display:inline-block;padding:1px 7px;border-radius:9px;font-size:10px;'
        + `font-weight:700;color:#fff;flex-shrink:0;background:${pass ? '#2e7d32' : '#c62828'};`;
      return c;
    };
    const row = (pass, label, sub) => {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;align-items:baseline;gap:6px;margin:3px 0;';
      r.appendChild(chip(pass, pass ? 'PASS' : 'FAIL'));
      const t = document.createElement('span');
      t.style.cssText = 'font-family:var(--mono);font-size:11px;word-break:break-word;';
      t.textContent = label;
      r.appendChild(t);
      container.appendChild(r);
      if (sub) {
        const s = document.createElement('div');
        s.style.cssText = 'margin:0 0 4px 46px;font-size:10px;color:var(--text-dim);';
        s.textContent = sub;
        container.appendChild(s);
      }
    };
    const head = document.createElement('div');
    head.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:4px;';
    if (data.mode === 'single') {
      head.textContent = `One run, ${data.steps} steps${data.ended ? ' (goal ended the run)' : ''}:`;
      container.appendChild(head);
      if (!data.results.length) { head.textContent = 'No checks to run yet.'; return; }
      for (const r of data.results) row(r.pass, r.src, r.pass ? '' : r.detail);
    } else {
      head.textContent = `${data.cleanRuns} of ${data.runs} runs passed every check (${data.steps} steps each):`;
      container.appendChild(head);
      if (!data.results.length && !data.invalid.length) { head.textContent = 'No checks to run yet.'; return; }
      for (const a of data.results) {
        row(a.fails === 0, a.src, a.fails === 0 ? '' : `failed in ${a.fails}/${data.runs} runs (first: ${a.first})`);
      }
      for (const r of data.invalid) row(false, r.src, r.detail);
    }
  }
}

for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppAnalysis.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
