// Runs Monte Carlo batches on Web Workers (js/workers/mc-worker.js), one slice
// of trial indices per worker, so a batch uses every core and never blocks the
// page. Trials are independent (each has its own sub-seed and random stream),
// so merging the slices in trial order gives exactly the in-page result.
// Browser only, and optional: SimEngine.runMonteCarloAsync uses it when it is
// installed, and anything that stops a worker (file://, a load error) falls
// back to the in-page path for that batch.
SimEngine.mcPool = {
  url: 'js/workers/mc-worker.js',
  // ponytail: a fresh set of workers per batch; keep them alive between
  // batches if sweep start-up time ever shows up.
  size: Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2)),
  // Starting the workers costs ~300 ms (each parses math.js), so a batch only
  // goes off-thread when it would take longer than that in-page. The unit is
  // runs × steps × (nodes + connections); ~100k measured at ~0.5 s on the F2P
  // template. ponytail: a rough estimate, formula-heavy models run slower.
  minWork: 100000,

  run(engine, runs, maxSteps, opts = {}) {
    const job = engine._mcSetup(runs, maxSteps, opts);
    const size = (job.base.nodes || []).length + (job.base.connections || []).length;
    if (job.runs * job.maxSteps * size < this.minWork) return engine._mcAsyncLocal(runs, maxSteps, opts);
    const n = Math.min(this.size, job.runs);
    const workers = [];
    const slices = new Array(n).fill(null);
    const done = new Array(n).fill(0);
    return new Promise(resolve => {
      let settled = false, poll = null;
      const settle = v => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        for (const w of workers) w.terminate();
        resolve(typeof v === 'function' ? v() : v);
      };
      const fallback = () => settle(() => engine._mcAsyncLocal(runs, maxSteps, opts));
      poll = setInterval(() => { if (opts.shouldCancel && opts.shouldCancel()) settle(null); }, 50);
      try {
        for (let i = 0; i < n; i++) {
          const w = new Worker(this.url);
          workers.push(w);
          w.onerror = e => { e.preventDefault(); fallback(); };
          w.onmessage = ({ data }) => {
            if (data.error) { fallback(); return; }
            if (data.trials) {
              slices[i] = data.trials;
              if (slices.every(Boolean)) settle(engine._mcSummary(job, slices.flat()));
              return;
            }
            done[i] = data.done;
            if (opts.onProgress) opts.onProgress(done.reduce((a, b) => a + b, 0), job.runs);
          };
          w.postMessage({ job, from: Math.floor(i * job.runs / n), to: Math.floor((i + 1) * job.runs / n) });
        }
      } catch { fallback(); }
    });
  },
};
