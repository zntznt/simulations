#!/usr/bin/env node
// Browser smoke test: loads the real app in headless Chromium, exercises the
// UI (examples, run/step, goal-stop) and fails on any console/page error.
//
// Requires the app to be served (default http://localhost:8080) and Playwright.
// Run:  NODE_PATH=$(npm root -g) node test/smoke.js
'use strict';

const { chromium } = require('playwright');
const URL = process.env.SMOKE_URL || 'http://localhost:8080/';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
  const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

  await page.goto(URL, { waitUntil: 'networkidle' });

  // App booted with the default example.
  const nodeCount = await page.evaluate(() => window.app.diagram.nodes.size);
  if (nodeCount > 0) ok(`default example loaded (${nodeCount} nodes)`); else fail('no nodes on boot');

  // Each example loads cleanly (bypass confirm()).
  await page.evaluate(() => { window.confirm = () => true; });
  for (const ex of ['basic', 'loot', 'factory']) {
    await page.evaluate((v) => {
      const sel = document.getElementById('btn-examples');
      sel.value = v;
      sel.dispatchEvent(new Event('change'));
    }, ex);
    const n = await page.evaluate(() => window.app.diagram.nodes.size);
    if (n > 0) ok(`example "${ex}" loaded (${n} nodes)`); else fail(`example "${ex}" empty`);
  }

  // Factory example is loaded; run it headlessly to completion (goal stop).
  const ended = await page.evaluate(async () => {
    const e = window.app.engine;
    e.reset();
    for (let i = 0; i < 500 && !e.ended; i++) e.doStep();
    return e.ended;
  });
  if (ended && ended.label) ok(`factory reached goal: ${ended.label}=${ended.value} @ step ${ended.step}`);
  else fail('factory goal never reached within 500 steps');

  // Status banner reflects the end state.
  const status = await page.evaluate(() => {
    window.app.engine.onEnd(window.app.engine.ended);
    return document.getElementById('sim-status').textContent;
  });
  if (status.includes('🏁')) ok(`status banner shows goal: "${status}"`); else fail('no goal banner');

  // Selecting a connection renders the new property controls without error.
  const propOk = await page.evaluate(() => {
    const conn = [...window.app.diagram.connections.values()]
      .find(c => c.type === ConnectionType.STATE);
    if (!conn) return 'no state conn';
    window.app._onSelect(conn.id, 'conn');
    return document.getElementById('props-content').textContent.includes('Trigger') ? 'ok' : 'missing trigger UI';
  });
  if (propOk === 'ok') ok('state-connection props show Trigger/Activator controls');
  else fail(`connection props: ${propOk}`);

  // Step the UI a few times via the Step button to exercise rendering/anim path.
  await page.evaluate(() => { window.app.engine.reset(); });
  for (let i = 0; i < 5; i++) await page.click('#btn-step');
  ok('stepped via UI button 5×');

  // Input parsing: 0 must be accepted for rate / chance / capacity.
  const parse = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 200, 200));
    const p = d.addNode(new MNode(NodeType.POOL, 400, 200));
    const c = d.addConnection(new MConnection(s.id, p.id));
    window.app.renderer.render();
    const setField = (label, value) => {
      for (const row of document.querySelectorAll('#props-content .prop-row')) {
        const lbl = row.querySelector('label');
        if (lbl && lbl.textContent.trim() === label) {
          const inp = row.querySelector('input');
          inp.value = value; inp.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
      return false;
    };
    window.app._onSelect(c.id, 'conn');
    const r1 = setField('Rate', '0');
    const r2 = setField('Chance %', '0');
    window.app._onSelect(p.id, 'node');
    const r3 = setField('Capacity', '0');
    return { rate: c.rate, chance: c.chance, cap: p.capacity, found: r1 && r2 && r3 };
  });
  if (parse.found && parse.rate === 0 && parse.chance === 0 && parse.cap === 0)
    ok('property inputs accept 0 for rate / chance / capacity');
  else fail('input parse: ' + JSON.stringify(parse));

  // Editor: place, drag-connect, and right-click delete via synthetic events.
  const editor = await page.evaluate(() => {
    window.app._clearAll();
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const ev = (type, sx, sy, button = 0) => canvas.dispatchEvent(
      new MouseEvent(type, { clientX: r.left + sx, clientY: r.top + sy, button, bubbles: true }));
    const place = (tool, sx, sy) => { window.app.editor.setTool(tool); ev('mousedown', sx, sy); ev('mouseup', sx, sy); };
    place('place-pool', 200, 200);
    place('place-drain', 420, 200);
    const placed = window.app.diagram.nodes.size;
    window.app.editor.setTool('connect-resource');
    ev('mousedown', 200, 200); ev('mousemove', 300, 200); ev('mouseup', 420, 200);
    const conns = window.app.diagram.connections.size;
    window.app.editor.setTool('select');
    canvas.dispatchEvent(new MouseEvent('contextmenu',
      { clientX: r.left + 200, clientY: r.top + 200, bubbles: true }));
    return { placed, conns, after: window.app.diagram.nodes.size };
  });
  if (editor.placed === 2 && editor.conns === 1 && editor.after === 1)
    ok('editor place / drag-connect / right-click-delete work');
  else fail('editor ops: ' + JSON.stringify(editor));

  if (errors.length) {
    console.log(`\n  \x1b[31mConsole/page errors:\x1b[0m`);
    for (const e of errors) console.log('   - ' + e);
    process.exitCode = 1;
  } else {
    ok('no console or page errors');
  }

  await browser.close();
  console.log(process.exitCode ? '\nSMOKE FAILED\n' : '\nSMOKE PASSED\n');
})().catch(e => { console.error(e); process.exit(1); });
