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
      sel.appendChild(new Option('— no parameters —', ''));
      sel.disabled = true;
      document.getElementById('mc-sweep-run').disabled = true;
      sel.title = 'Define parameters in the Params rail panel to sweep them';
    } else {
      sel.disabled = false;
      document.getElementById('mc-sweep-run').disabled = false;
      for (const n of names) sel.appendChild(new Option(n, n));
      // Seed the range around the parameter's current value.
      const cur = this.diagram.params[names[0]];
      document.getElementById('mc-sweep-from').value = Math.round(cur * 0.5 * 100) / 100;
      document.getElementById('mc-sweep-to').value = Math.round(cur * 1.5 * 100) / 100;
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

  _mcSeed() {
    return document.getElementById('mc-seed').value.trim();
  }

  async _runMonteCarlo() {
    const runs = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-runs').value) || 100));
    const steps = Math.max(1, Math.min(5000, parseInt(document.getElementById('mc-steps').value) || 200));
    const out = document.getElementById('mc-results');
    if (this._mcBusy) return;
    this._mcBusy = true;
    out.innerHTML = '<p class="mc-empty">Running…</p>';

    try {
      const t0 = performance.now();
      const res = await this.engine.runMonteCarloAsync(runs, steps, {
        seed: this._mcSeed() || null,
        onProgress: (done, total) => {
          out.innerHTML = `<p class="mc-empty">Running… ${done} / ${total}</p>`;
        },
      });
      const ms = Math.round(performance.now() - t0);
      this._mcLast = res;

      const mcName = this.diagram.meta.name || 'Untitled';
      let html = `<p class="mc-summary">${res.runs} runs × ${res.maxSteps} steps`
        + ` — <b>${this._esc(mcName)}</b>`
        + (res.seed ? ` — seed <b>${this._esc(res.seed)}</b>` : '')
        + ` <span style="color:var(--text-dim)">(${ms} ms)</span>`;
      if (res.endStep) {
        html += `<br>Goal reached in <b>${Math.round(res.endedRate * 100)}%</b> of runs`
          + ` — end step mean <b>${res.endStep.mean}</b> (min ${res.endStep.min}, max ${res.endStep.max}).`;
      }
      html += '</p>';

      // Deterministic model → every run is identical → no distribution. Say so,
      // rather than leaving the user puzzling over min==max across the board.
      const noSpread = res.nodes.length > 0 && res.nodes.every(n => n.min === n.max);
      if (noSpread) {
        html += '<p class="mc-stale-badge">All runs are identical — this model is '
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
    out.innerHTML = '<p class="mc-empty">Sweeping…</p>';

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
          onProgress: (done, total) => {
            out.innerHTML = `<p class="mc-empty">Sweeping ${name} = ${values[i]}`
              + ` (${i + 1}/${values.length}) — ${done}/${total}</p>`;
          },
        });
        results.push(res);
      }

      let html = `<p class="mc-summary">Sweep <b>${this._esc(name)}</b> ∈ [${values[0]} … ${values[values.length - 1]}]`
        + ` — ${runs} runs × ${steps} steps per value`
        + (seed ? ` — seed <b>${this._esc(seed)}</b>` : '') + '<br>'
        + '<span style="color:var(--text-dim)">Cells show the mean final value across runs.</span></p>';
      html += '<table><thead><tr><th>Node</th>'
        + values.map(v => `<th>${name}=${v}</th>`).join('') + '</tr></thead><tbody>';
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
    const prog = (label) => (done, total) => {
      out.innerHTML = `<p class="mc-empty">Sensitivity — ${this._esc(label)} `
        + `(batch ${batch}/${totalBatches}) — ${done}/${total}</p>`;
    };

    try {
      batch = 1;
      out.innerHTML = '<p class="mc-empty">Sensitivity — baseline…</p>';
      const baseRes = await this.engine.runMonteCarloAsync(runs, steps, {
        baseJSON: base, seed, onProgress: prog('baseline'),
      });
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
          baseJSON: lowJSON, seed, onProgress: prog(`${name} −${pct}%`),
        });

        const highJSON = clone();
        highJSON.params = { ...(highJSON.params || {}), [name]: val * (1 + delta) };
        batch++;
        const highRes = await this.engine.runMonteCarloAsync(runs, steps, {
          baseJSON: highJSON, seed, onProgress: prog(`${name} +${pct}%`),
        });

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

    let html = `<p class="mc-summary">Sensitivity — each parameter perturbed <b>±${pct}%</b>`
      + ` — ${runs} runs × ${steps} steps per batch — seed <b>${esc(seed)}</b><br>`
      + '<span style="color:var(--text-dim)">Cells show <b>elasticity</b>: the % change in a node’s '
      + 'mean final value per 1% change in the parameter. '
      + 'Green = moves the same way, red = moves the opposite way; brighter = stronger.</span></p>';

    if (topName != null && topScore > 0) {
      html += `<p class="sens-top">Most influential parameter: <b>${esc(topName)}</b> `
        + `(mean |elasticity| ${topScore.toFixed(2)}).</p>`;
    } else {
      html += '<p class="mc-stale-badge">No parameter measurably moved any node — the perturbed '
        + 'parameters may be unused, or their effect rounds away at this scale.</p>';
    }

    html += '<div class="sens-legend"><span>opposite</span>'
      + '<span class="sens-grad" role="img" aria-label="red to green elasticity scale"></span>'
      + '<span>same direction</span>'
      + '<span style="margin-left:auto">“—” = baseline ≈ 0 (undefined)</span></div>';

    html += '<table class="sens-table"><thead><tr><th>Node</th>'
      + params.map((name, p) => `<th title="mean |elasticity| ${paramScore[p].toFixed(2)}">${esc(name)}</th>`).join('')
      + '</tr></thead><tbody>';
    for (let i = 0; i < nodes.length; i++) {
      const label = esc(nodes[i].label || nodes[i].type);
      html += `<tr><td title="baseline mean ${baseline[i]}">${label}</td>`;
      for (let p = 0; p < params.length; p++) {
        const e = matrix[p][i];
        if (e == null || !isFinite(e)) {
          html += '<td class="sens-na" title="baseline ≈ 0 — relative sensitivity is undefined">—</td>';
        } else {
          html += `<td class="sens-cell" style="background:${this._sensColor(e)}" `
            + `title="${esc(params[p])} → ${label}: elasticity ${fmt(e)}">${fmt(e)}</td>`;
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    if (skipped && skipped.length) {
      html += `<p class="mc-stale-badge">Skipped (value 0 — can’t scale by a percent): `
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
}

for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AppAnalysis.prototype))) {
  if (k !== 'constructor') Object.defineProperty(App.prototype, k, d);
}
