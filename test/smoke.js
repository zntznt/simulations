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
