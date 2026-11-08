// Monte Carlo worker for js/mc-pool.js: runs trials [from, to) of a batch with
// the same engine code the page uses, and posts back each trial's outcome.
importScripts('../../vendor/math.min.js', '../model.js', '../engine.js');

onmessage = ({ data: { job, from, to } }) => {
  try {
    const eng = new SimEngine(new Diagram());
    const trials = [];
    for (let r = from; r < to; r++) {
      const it = eng._mcTrial(job, r);
      let x = it.next();
      while (!x.done) x = it.next();
      trials.push(x.value);
      postMessage({ done: trials.length });
    }
    postMessage({ trials });
  } catch (e) {
    postMessage({ error: String((e && e.message) || e) });
  }
};
