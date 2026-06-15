#!/usr/bin/env node
// Browser smoke test: loads the real app in headless Chromium, exercises the
// UI (templates, navigation, run/step, goal-stop) and fails on any console/page error.
//
// Requires the app to be served (default http://localhost:8080) and Playwright.
// Run:  NODE_PATH=$(npm root -g) node test/smoke.js
'use strict';

const { chromium } = require('playwright');
const URL = process.env.SMOKE_URL || 'http://localhost:8080/';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // The display-font feature loads stylesheets from Google Fonts; stub the
  // request so the smoke run works offline and stays free of network errors.
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  // Run as a returning user: suppress the first-run welcome overlay (covered by
  // its own dedicated check below). Must be set before the app boots.
  await page.addInitScript(() => { try { localStorage.setItem('sim_seen_welcome', '1'); } catch (e) {} });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
  const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

  await page.goto(URL, { waitUntil: 'networkidle' });

  // Fresh session boots to an empty canvas (learn-by-doing); the demo loads on
  // demand via the welcome's "Explore the demo" (_loadDemo).
  const boot = await page.evaluate(() => {
    const empty = window.app.diagram.nodes.size;
    window.app._loadDemo();
    return { empty, afterDemo: window.app.diagram.nodes.size };
  });
  if (boot.empty === 0) ok('fresh session boots to an empty canvas'); else fail(`expected empty boot, got ${boot.empty} nodes`);
  if (boot.afterDemo > 0) ok(`"Explore the demo" loads the demo (${boot.afterDemo} nodes)`); else fail('demo did not load on demand');

  // Interactive tour: learn-by-doing coach-marks that advance as the user
  // actually places nodes, connects them, and runs — then can be skipped/finished.
  const tour = await page.evaluate(() => {
    const t = window.app;
    t._clearAll(); t._resetHistory();
    t._startTour();
    const count = () => document.getElementById('tour-count').textContent;
    const text = () => document.getElementById('tour-text').textContent;
    const nextShown = () => !document.getElementById('tour-next').classList.contains('hidden');
    const visible = !document.getElementById('tour').classList.contains('hidden');
    const spotOn = !document.getElementById('tour-spotlight').classList.contains('off');
    const s1 = { c: count(), src: /Source/.test(text()) };

    const d = t.diagram;
    const src = d.addNode(new MNode(NodeType.SOURCE, 200, 200)); t._commit();
    const s2 = { c: count(), pool: /Pool/.test(text()) };

    const pool = d.addNode(new MNode(NodeType.POOL, 420, 200)); t._commit();
    const s3 = { c: count(), conn: /Resource/.test(text()) };

    const conn = d.addConnection(new MConnection(src.id, pool.id)); t._commit();
    const s4 = { c: count(), rate: /Rate/.test(text()) };

    // Editing the connection's rate satisfies the new "set a rate" step.
    conn.rate = 5; t._commit();
    const s5 = { c: count(), run: /Run/.test(text()) };

    // Running advances onto the click-through hand-off cards.
    t.engine.doStep();
    const i1 = { c: count(), lib: /Library/.test(text()), next: nextShown() };
    document.getElementById('tour-next').click();
    const i2 = { c: count(), rail: /Parameters/.test(text()) && /Variables/.test(text()) };
    document.getElementById('tour-next').click();
    const i3 = { c: count(), batch: /Monte Carlo/.test(text()) };
    document.getElementById('tour-next').click();
    const sFinal = {
      c: count(),
      finish: nextShown(),
      skipHidden: document.getElementById('tour-skip').classList.contains('hidden'),
    };

    document.getElementById('tour-next').click();
    const ended = t._tour === null && document.getElementById('tour').classList.contains('hidden');
    const flag = localStorage.getItem('sim_seen_tour');
    return { visible, spotOn, s1, s2, s3, s4, s5, i1, i2, i3, sFinal, ended, flag };
  });
  const tourOk = tour.visible && tour.spotOn
    && tour.s1.c === 'Step 1 of 5' && tour.s1.src
    && tour.s2.c === 'Step 2 of 5' && tour.s2.pool
    && tour.s3.c === 'Step 3 of 5' && tour.s3.conn
    && tour.s4.c === 'Step 4 of 5' && tour.s4.rate
    && tour.s5.c === 'Step 5 of 5' && tour.s5.run
    && tour.i1.c === 'Next steps' && tour.i1.lib && tour.i1.next
    && tour.i2.c === 'Next steps' && tour.i2.rail
    && tour.i3.c === 'Next steps' && tour.i3.batch
    && tour.sFinal.c === 'All set' && tour.sFinal.finish && tour.sFinal.skipHidden
    && tour.ended && tour.flag === '1';
  if (tourOk) ok('tour: place→connect→rate→Run, then Library/rail/Batch hand-off cards, then finish');
  else fail('tour: ' + JSON.stringify(tour));

  // Skipping the tour mid-way ends it immediately.
  const tourSkip = await page.evaluate(() => {
    const t = window.app;
    t._clearAll(); t._resetHistory();
    t._startTour();
    const mid = !document.getElementById('tour').classList.contains('hidden');
    document.getElementById('tour-skip').click();
    return { mid, ended: t._tour === null && document.getElementById('tour').classList.contains('hidden') };
  });
  if (tourSkip.mid && tourSkip.ended) ok('tour: "Skip tour" ends it immediately');
  else fail('tour skip: ' + JSON.stringify(tourSkip));

  // Each starter template (now in the Library) loads cleanly (bypass guard modal).
  await page.evaluate(() => { window.app._confirmGuard = () => Promise.resolve(true); });
  const templateNames = await page.evaluate(() => window.app._templates.map(t => t.name));
  for (const name of templateNames) {
    await page.evaluate(async (nm) => {
      const t = window.app._templates.find(x => x.name === nm);
      await window.app._loadTemplate(t);
    }, name);
    const n = await page.evaluate(() => window.app.diagram.nodes.size);
    if (n > 0) ok(`template "${name}" loaded (${n} nodes)`); else fail(`template "${name}" empty`);
  }

  // Navigation: zoom controls step the scale and update the readout; fit-to-content
  // re-frames without error.
  const nav = await page.evaluate(() => {
    const r = window.app.renderer;
    r.zoomTo(1);
    const before = r._scale;
    document.getElementById('btn-zoom-in').click();
    const zoomed = r._scale > before;
    const label = document.getElementById('btn-zoom-level').textContent;
    r.fitView();
    return { zoomed, label, fitScale: r._scale };
  });
  if (nav.zoomed) ok(`zoom-in increases scale (readout "${nav.label}")`); else fail('zoom-in did not change scale');
  if (/^\d+%$/.test(nav.label)) ok('zoom readout shows a percentage'); else fail(`zoom readout malformed: "${nav.label}"`);
  if (nav.fitScale > 0) ok(`fit-to-content set scale ${Math.round(nav.fitScale * 100)}%`); else fail('fitView produced a non-positive scale');

  // Load the goal-bearing demo (Epidemic halts when the outbreak fades) and run
  // it headlessly to completion (goal stop).
  await page.evaluate(() => {
    const t = window.app._templates.find(x => x.name === 'Epidemic (SIR)');
    window.app._loadTemplate(t);
  });
  const ended = await page.evaluate(async () => {
    const e = window.app.engine;
    e.reset();
    for (let i = 0; i < 500 && !e.ended; i++) e.doStep();
    return e.ended;
  });
  if (ended && ended.label) ok(`epidemic reached goal: ${ended.label}=${ended.value} @ step ${ended.step}`);
  else fail('epidemic goal never reached within 500 steps');

  // Status banner reflects the end state.
  const status = await page.evaluate(() => {
    window.app.engine.onEnd(window.app.engine.ended);
    const el = document.getElementById('sim-status');
    return { text: el.textContent, flag: !!el.querySelector('.fa-flag-checkered') };
  });
  if (status.flag && status.text.includes('reached')) ok(`status banner shows goal: "${status.text.trim()}"`); else fail('no goal banner');

  // Selecting a state connection shows the role picker; choosing "Modifies
  // target" reveals the When/Amount controls and defaults to the simple
  // flat-amount-per-step mode.
  const propOk = await page.evaluate(() => {
    const conn = [...window.app.diagram.connections.values()]
      .find(c => c.type === ConnectionType.STATE);
    if (!conn) return 'no state conn';
    conn.modifier = false; conn.trigger = false; conn.reverseTrigger = false; conn.activator = false;
    window.app._onSelect(conn.id, 'conn');
    const panel = document.getElementById('props-content');
    if (!panel.textContent.includes('Triggers target')) return 'missing role chips';
    const modChip = [...panel.querySelectorAll('.var-chip')].find(c => c.textContent === 'Modifies target');
    if (!modChip) return 'no modify chip';
    modChip.click();
    if (!conn.modifier || conn.modMode !== 'step') return `bad default mode: ${conn.modMode}`;
    if (!panel.textContent.includes('Amount')) return 'no amount field';
    return 'ok';
  });
  if (propOk === 'ok') ok('state-connection props: role picker + flat-amount modifier default');
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

  // Editor: place, drag-connect, and the right-click context menu (which
  // replaced the old instant-delete gesture). Right-click opens a menu and
  // nothing is removed until you choose Delete from it.
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
    // Right-click the pool: menu opens, no instant delete.
    canvas.dispatchEvent(new MouseEvent('contextmenu',
      { clientX: r.left + 200, clientY: r.top + 200, bubbles: true }));
    const menu = document.getElementById('ctx-menu');
    const menuOpen = !menu.classList.contains('hidden');
    const items = [...menu.querySelectorAll('.menu-item')].map(b => b.textContent.trim());
    const afterRightClick = window.app.diagram.nodes.size;
    // Choose Delete from the menu: removes the node and its connection.
    const del = [...menu.querySelectorAll('.menu-item')].find(b => /Delete/.test(b.textContent));
    if (del) del.click();
    return { placed, conns, menuOpen, items, afterRightClick,
      afterDelete: window.app.diagram.nodes.size,
      connsAfter: window.app.diagram.connections.size,
      menuClosed: menu.classList.contains('hidden') };
  });
  if (editor.placed === 2 && editor.conns === 1 && editor.menuOpen && editor.afterRightClick === 2
      && editor.items.some(t => /Duplicate/.test(t)) && editor.items.some(t => /Save as component/.test(t))
      && editor.afterDelete === 1 && editor.connsAfter === 0 && editor.menuClosed)
    ok('editor: place / drag-connect / right-click context menu (opens, no instant-delete, Delete acts)');
  else fail('editor ops: ' + JSON.stringify(editor));

  // Regression: an interactive node must stay selectable while the sim runs.
  // Clicking it should fire it AND select it — previously the handler fired and
  // returned early, so an interactive node could never be selected during a run.
  const interSel = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const src = d.addNode(new MNode(NodeType.SOURCE, 250, 250));
    const pool = d.addNode(new MNode(NodeType.POOL, 450, 250));
    src.activation = ActivationMode.INTERACTIVE;
    const c = new MConnection(src.id, pool.id, ConnectionType.RESOURCE); c.rate = 1;
    d.addConnection(c);
    window.app._commit();
    window.app.renderer.render();
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const rd = window.app.renderer;
    const sx = src.x * rd._scale + rd._panX, sy = src.y * rd._scale + rd._panY;
    const ev = (type) => canvas.dispatchEvent(new MouseEvent(type,
      { clientX: r.left + sx, clientY: r.top + sy, button: 0, bubbles: true }));
    window.app.editor.setTool('select');
    window.app.engine.run();
    const before = pool.resources;
    ev('mousedown'); ev('mouseup');
    const selected = !!(window.app.editor.selection && window.app.editor.selection.has(src.id));
    const fired = pool.resources > before;
    window.app.engine.stop();
    return { selected, fired };
  });
  if (interSel.selected && interSel.fired)
    ok('interactive node stays selectable during a run (click fires AND selects)');
  else fail('interactive select-during-run: ' + JSON.stringify(interSel));

  // Regression: dragging an interactive node during a run repositions it without
  // firing — firing happens on click-up only when the pointer barely travels.
  const interDrag = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const src = d.addNode(new MNode(NodeType.SOURCE, 250, 250));
    const pool = d.addNode(new MNode(NodeType.POOL, 450, 250));
    src.activation = ActivationMode.INTERACTIVE;
    const c = new MConnection(src.id, pool.id, ConnectionType.RESOURCE); c.rate = 1;
    d.addConnection(c);
    window.app._commit();
    window.app.renderer.render();
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const rd = window.app.renderer;
    const sx = src.x * rd._scale + rd._panX, sy = src.y * rd._scale + rd._panY;
    const ev = (type, ox = 0, oy = 0) => canvas.dispatchEvent(new MouseEvent(type,
      { clientX: r.left + sx + ox, clientY: r.top + sy + oy, button: 0, bubbles: true }));
    window.app.editor.setTool('select');
    window.app.engine.run();
    const before = pool.resources, x0 = src.x;
    ev('mousedown'); ev('mousemove', 70, 50); ev('mouseup', 70, 50);
    const movedNode = src.x !== x0;
    const fired = pool.resources > before;
    window.app.engine.stop();
    return { movedNode, fired };
  });
  if (interDrag.movedNode && !interDrag.fired)
    ok('dragging an interactive node during a run repositions it without firing');
  else fail('interactive drag-no-fire: ' + JSON.stringify(interDrag));

  // Context menu: empty-canvas variant (Paste disabled with an empty clipboard,
  // Select all present) and "Save as component…" opening the Library focused.
  const ctxMenu = await page.evaluate(() => {
    window.app._clearAll();
    window.app._clipboard = null;
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const menu = document.getElementById('ctx-menu');
    // Right-click empty canvas.
    canvas.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 600, clientY: r.top + 360, bubbles: true }));
    const canvasItems = [...menu.querySelectorAll('.menu-item')].map(b => ({ t: b.textContent.trim(), disabled: b.disabled }));
    const pasteDisabled = canvasItems.some(i => /Paste/.test(i.t) && i.disabled);
    const hasSelectAll = canvasItems.some(i => /Select all/.test(i.t));
    window.app._hideContextMenu();
    // Place + select a node, right-click it, then click "Save as component…".
    const n = window.app.diagram.addNode(new MNode(NodeType.POOL, 300, 300));
    window.app.renderer.render();
    window.app.editor._setSelection([n.id], n.id, 'node');
    const rd = window.app.renderer;
    const sx = 300 * rd._scale + rd._panX, sy = 300 * rd._scale + rd._panY;
    canvas.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + sx, clientY: r.top + sy, bubbles: true }));
    const saveItem = [...menu.querySelectorAll('.menu-item')].find(b => /Save as component/.test(b.textContent));
    const sawSave = !!saveItem;
    if (saveItem) saveItem.click();
    const libOpen = !document.getElementById('lib-overlay').classList.contains('hidden');
    const focused = !!document.activeElement && document.activeElement.id === 'comp-name';
    window.app._hideModal('lib-overlay');
    return { pasteDisabled, hasSelectAll, sawSave, libOpen, focused };
  });
  if (ctxMenu.pasteDisabled && ctxMenu.hasSelectAll && ctxMenu.sawSave && ctxMenu.libOpen && ctxMenu.focused)
    ok('context menu: canvas paste-state + select-all, and "Save as component" opens the Library focused');
  else fail('context menu: ' + JSON.stringify(ctxMenu));

  // P1 panels: queue node + process time, source limited stock, state modifier.
  const p1 = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const hasLabel = (t) => [...document.querySelectorAll('#props-content .prop-row label')]
      .some(l => l.textContent.trim() === t);
    const toggle = (t) => {
      for (const row of document.querySelectorAll('#props-content .prop-row')) {
        const lbl = row.querySelector('label');
        if (lbl && lbl.textContent.trim() === t) {
          const c = row.querySelector('input[type=checkbox]');
          c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    };
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const ev = (t, sx, sy) => canvas.dispatchEvent(
      new MouseEvent(t, { clientX: r.left + sx, clientY: r.top + sy, button: 0, bubbles: true }));
    window.app.editor.setTool('place-queue'); ev('mousedown', 250, 250); ev('mouseup', 250, 250);
    const q = [...d.nodes.values()].find(n => n.type === NodeType.QUEUE);
    window.app._onSelect(q.id, 'node');
    const hasPT = hasLabel('Process time');

    const s = d.addNode(new MNode(NodeType.SOURCE, 450, 250));
    window.app._onSelect(s.id, 'node');
    const limitedToggled = toggle('Limited stock');
    const hasStock = hasLabel('Stock');

    const a = d.addNode(new MNode(NodeType.POOL, 600, 400));
    const sc = d.addConnection(new MConnection(a.id, a.id, ConnectionType.STATE));
    window.app._onSelect(sc.id, 'conn');
    const modChip = [...document.querySelectorAll('#props-content .var-chip')]
      .find(c => c.textContent === 'Modifies target');
    const modToggled = !!modChip;
    if (modChip) modChip.click();

    return { hasQueue: !!q, hasPT, limited: s.limited, hasStock, modToggled, modifier: sc.modifier };
  });
  if (p1.hasQueue && p1.hasPT && p1.limited && p1.hasStock && p1.modToggled && p1.modifier)
    ok('P1 panels: queue+process-time, source limited+stock, state modifier');
  else fail('P1 panels: ' + JSON.stringify(p1));

  // Analysis: timeline chart toggle + Monte Carlo modal.
  const analysis = await page.evaluate(async () => {
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 200, 200));
    const p = d.addNode(new MNode(NodeType.POOL, 400, 200));
    d.addConnection(new MConnection(s.id, p.id)).rate = 3;
    window.app.renderer.render();

    document.getElementById('btn-timeline').click();
    const tlShown = !document.getElementById('timeline').classList.contains('hidden');
    window.app.engine.reset();
    for (let i = 0; i < 6; i++) window.app.engine.doStep();
    const cw = document.getElementById('timeline-canvas').width;

    document.getElementById('btn-batch').click();
    const mcShown = !document.getElementById('mc-overlay').classList.contains('hidden');
    // Sectioned layout: a shared settings band + one titled section per analysis.
    const settings = !!document.querySelector('.mc-settings');
    const sections = document.querySelectorAll('#mc-modal .mc-section').length;
    const titles = [...document.querySelectorAll('.mc-section-title')].map(t => t.textContent);
    document.getElementById('mc-runs').value = '20';
    document.getElementById('mc-steps').value = '10';
    document.getElementById('mc-run').click();
    await new Promise(r => setTimeout(r, 150));
    const rows = document.querySelectorAll('#mc-results table tbody tr').length;
    const hists = document.querySelectorAll('#mc-results .mc-hist').length;
    const histBars = document.querySelectorAll('#mc-results .mc-bar').length;
    return { tlShown, cw, mcShown, settings, sections, titles, rows, hists, histBars };
  });
  if (analysis.tlShown && analysis.cw > 0 && analysis.mcShown && analysis.rows >= 1
      && analysis.hists === analysis.rows && analysis.histBars > 0
      && analysis.settings && analysis.sections === 3
      && analysis.titles.join('|') === 'Batch run|Parameter sweep|Sensitivity')
    ok(`analysis: timeline + sectioned Monte Carlo (${analysis.rows} rows, distribution histograms)`);
  else fail('analysis: ' + JSON.stringify(analysis));

  // Cancel a long batch: the progress line shows a Cancel button, run buttons
  // disable during the run, the engine resolves to null, and the buttons restore.
  const cancel = await page.evaluate(async () => {
    document.getElementById('btn-batch').click();
    document.getElementById('mc-runs').value = '5000';
    document.getElementById('mc-steps').value = '2000';
    document.getElementById('mc-run').click();
    // Wait for the progress UI to mount.
    let guard = 0;
    while (!document.getElementById('mc-cancel') && guard++ < 200) await new Promise(r => setTimeout(r, 10));
    const cancelShown = !!document.getElementById('mc-cancel');
    const disabledDuring = ['mc-run', 'mc-sweep-run', 'mc-sens-run']
      .every(id => document.getElementById(id).disabled);
    document.getElementById('mc-cancel').click();
    guard = 0;
    while (!/Cancelled/.test(document.getElementById('mc-results').textContent) && guard++ < 200)
      await new Promise(r => setTimeout(r, 10));
    const cancelled = /Cancelled/.test(document.getElementById('mc-results').textContent);
    const reenabled = !document.getElementById('mc-run').disabled;
    document.getElementById('mc-close').click();
    return { cancelShown, disabledDuring, cancelled, reenabled };
  });
  if (cancel.cancelShown && cancel.disabledDuring && cancel.cancelled && cancel.reenabled)
    ok('analysis: long batch shows Cancel, disables run buttons, and stops cleanly');
  else fail('analysis cancel: ' + JSON.stringify(cancel));

  // Ultrabuff: seeded MC reproducibility, raw export button, parameter sweep,
  // help overlay.
  const ultra = await page.evaluate(async () => {
    const r = {};
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 200, 200));
    const p = d.addNode(new MNode(NodeType.POOL, 400, 200));
    const c = d.addConnection(new MConnection(s.id, p.id));
    c.rateMode = RateMode.DICE; c.dice = '2d6';
    d.params = { lvl: 4 };
    window.app.renderer.render();

    const waitFor = async (sel, ms = 3000) => {
      const t0 = Date.now();
      while (!document.querySelector(sel)) {
        if (Date.now() - t0 > ms) return false;
        await new Promise(res => setTimeout(res, 30));
      }
      return true;
    };

    // Seeded MC, twice — identical means; raw export button present.
    document.getElementById('btn-batch').click();
    r.sweepOptions = document.getElementById('mc-sweep-param').options.length;
    document.getElementById('mc-runs').value = '15';
    document.getElementById('mc-steps').value = '8';
    document.getElementById('mc-seed').value = 'smoke';
    document.getElementById('mc-run').click();
    await waitFor('#mc-results table');
    r.exportBtn = !!document.getElementById('mc-export-raw');
    r.seedShown = document.querySelector('#mc-results .mc-summary').textContent.includes('smoke');
    const mean1 = document.querySelector('#mc-results tbody tr td:nth-child(3)').textContent;
    document.getElementById('mc-run').click();
    await new Promise(res => setTimeout(res, 50));
    await waitFor('#mc-results table');
    const mean2 = document.querySelector('#mc-results tbody tr td:nth-child(3)').textContent;
    r.reproducible = mean1 === mean2;

    // Parameter sweep over `lvl`.
    document.getElementById('mc-sweep-from').value = '1';
    document.getElementById('mc-sweep-to').value = '3';
    document.getElementById('mc-sweep-count').value = '3';
    document.getElementById('mc-sweep-run').click();
    await new Promise(res => setTimeout(res, 50));
    await waitFor('#mc-results table');
    const head = document.querySelector('#mc-results thead');
    r.sweepCols = head ? head.querySelectorAll('th').length : 0; // node + 3 values
    document.getElementById('mc-close').click();

    // Help overlay: button and "?" key both open it.
    document.getElementById('btn-help').click();
    r.helpOpens = !document.getElementById('help-overlay').classList.contains('hidden');
    document.getElementById('help-close').click();
    r.helpCloses = document.getElementById('help-overlay').classList.contains('hidden');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    r.helpKey = !document.getElementById('help-overlay').classList.contains('hidden');
    document.getElementById('help-close').click();
    return r;
  });
  if (ultra.sweepOptions === 1 && ultra.exportBtn && ultra.seedShown && ultra.reproducible
      && ultra.sweepCols === 4 && ultra.helpOpens && ultra.helpCloses && ultra.helpKey)
    ok('ultrabuff: seeded MC + raw export + parameter sweep + help overlay');
  else fail('ultrabuff: ' + JSON.stringify(ultra));

  // Sensitivity analysis: perturb a parameter that drives a pool (rate = `lvl`),
  // expect an elasticity heatmap with ~1.0 for the pool (output scales 1:1 with
  // the rate parameter).
  const sens = await page.evaluate(async () => {
    const r = {};
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 200, 200));
    const p = d.addNode(new MNode(NodeType.POOL, 400, 200));
    const c = d.addConnection(new MConnection(s.id, p.id));
    c.rateMode = RateMode.FORMULA; c.formula = 'lvl';   // pool gains `lvl` per step
    d.params = { lvl: 10 };
    window.app.renderer.render();

    const waitFor = async (sel, ms = 3000) => {
      const t0 = Date.now();
      while (!document.querySelector(sel)) {
        if (Date.now() - t0 > ms) return false;
        await new Promise(res => setTimeout(res, 30));
      }
      return true;
    };

    document.getElementById('btn-batch').click();
    r.sensEnabled = !document.getElementById('mc-sens-run').disabled;
    document.getElementById('mc-runs').value = '2';
    document.getElementById('mc-steps').value = '10';
    document.getElementById('mc-sens-pct').value = '10';
    document.getElementById('mc-sens-run').click();
    r.tableShown = await waitFor('#mc-results table.sens-table');

    const head = document.querySelector('#mc-results table.sens-table thead');
    r.cols = head ? head.querySelectorAll('th').length : 0;   // Node + lvl = 2
    const cell = document.querySelector('#mc-results table.sens-table tbody tr td:nth-child(2)');
    r.elasticity = cell ? parseFloat(cell.textContent) : null;
    r.exportBtn = !!document.getElementById('mc-export-sens');
    r.topShown = (document.querySelector('#mc-results .sens-top')?.textContent || '').includes('lvl');
    document.getElementById('mc-close').click();
    return r;
  });
  if (sens.sensEnabled && sens.tableShown && sens.cols === 2 && sens.exportBtn && sens.topShown
      && sens.elasticity != null && Math.abs(sens.elasticity - 1) < 0.01)
    ok(`sensitivity: elasticity heatmap (pool→lvl elasticity ${sens.elasticity})`);
  else fail('sensitivity: ' + JSON.stringify(sens));

  // Scenario branching: checkpoint mid-run, fork back (keeps the old run as a
  // ghost branch, auto-opens the timeline), legend gains a branch chip.
  const branching = await page.evaluate(async () => {
    const r = {};
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 200, 200));
    const p = d.addNode(new MNode(NodeType.POOL, 400, 200));
    d.addConnection(new MConnection(s.id, p.id)).rate = 2;
    window.app.renderer.render();
    window.app.engine.reset();
    for (let i = 0; i < 5; i++) window.app.engine.doStep();

    // Open the Branches rail panel and checkpoint step 5.
    document.querySelector('#diagram-rail .rail-btn[data-feature="branches"]').click();
    const cpBtn = [...document.querySelectorAll('#props-content .branch-action-btn')]
      .find(b => b.textContent.includes('Checkpoint'));
    r.cpBtnLabelsStep = cpBtn.textContent.includes('step 5');
    cpBtn.click();
    r.checkpoints = window.app._checkpoints.length;

    // Run past the checkpoint, then fork back.
    for (let i = 0; i < 5; i++) window.app.engine.doStep();
    const poolAt10 = d.nodes.get(p.id).resources;
    document.querySelector('#props-content .branch-row button[aria-label^="Fork"]').click();
    r.stepRestored = window.app.engine.step === 5;
    r.poolRestored = d.nodes.get(p.id).resources === poolAt10 - 10;
    r.branchKept = window.app._branches.length === 1;
    r.timelineOpened = !document.getElementById('timeline').classList.contains('hidden');
    r.branchChip = !!document.querySelector('#tl-legend .tl-branch-chip');

    // The fork can run forward again from step 5.
    window.app.engine.doStep();
    r.forkAdvances = window.app.engine.step === 6;

    // Branch visibility toggles from the legend chip.
    document.querySelector('#tl-legend .tl-branch-chip').click();
    r.chipToggles = window.app._branches[0].visible === false;
    document.getElementById('btn-timeline').click(); // close the timeline again
    return r;
  });
  if (branching.cpBtnLabelsStep && branching.checkpoints === 1 && branching.stepRestored
      && branching.poolRestored && branching.branchKept && branching.timelineOpened
      && branching.branchChip && branching.forkAdvances && branching.chipToggles)
    ok('scenario branching: checkpoint + fork + ghost branch + timeline chip');
  else fail('scenario branching: ' + JSON.stringify(branching));

  // UI pass: chart visualization types render, run button reflects engine
  // state, and node properties read as labelled sections.
  const uiPass = await page.evaluate(async () => {
    const r = {};
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 150, 150));
    const p = d.addNode(new MNode(NodeType.POOL, 350, 150));
    d.addConnection(new MConnection(s.id, p.id)).rate = 2;
    const ch = d.addChart(new MChart(150, 260));
    ch.nodeIds = [p.id];
    window.app.engine.reset();
    for (let i = 0; i < 5; i++) window.app.engine.doStep();
    window.app.renderer.render();
    // Each chart type draws its own geometry without errors.
    const plotEl = () => document.querySelector(`[data-id="${ch.id}"] .chart-plot`);
    ch.chartType = 'bars'; window.app.renderer.render();
    r.bars = plotEl().querySelectorAll('rect').length >= 4;
    ch.chartType = 'area'; window.app.renderer.render();
    r.area = !!plotEl().querySelector('polygon');
    ch.chartType = 'step'; window.app.renderer.render();
    r.step = [...plotEl().querySelectorAll('path')].some(el => (el.getAttribute('d') || '').includes('H'));
    // Type picker chips render in the chart panel and switch the type.
    window.app._onSelect(ch.id, 'chart');
    const chip = [...document.querySelectorAll('#props-content .chart-type-chips .var-chip')]
      .find(c => c.textContent.includes('Line'));
    r.chips = !!chip;
    if (chip) { chip.click(); r.chipSwitch = ch.chartType === 'line'; }
    // Run button shows the running state.
    document.getElementById('btn-run').click();
    r.running = document.getElementById('btn-run').classList.contains('running')
      && document.getElementById('btn-run').textContent.includes('Pause');
    document.getElementById('btn-run').click();
    r.stopped = !document.getElementById('btn-run').classList.contains('running');
    // Node panel reads as labelled sections.
    window.app._onSelect(p.id, 'node');
    const secs = [...document.querySelectorAll('#props-content .props-sec')].map(el => el.textContent);
    r.sections = secs.includes('Behavior') && secs.includes('Goal') && secs.includes('History');
    r.typedTitle = !!document.querySelector('#props-content .props-overline');
    return r;
  });
  if (Object.values(uiPass).every(Boolean))
    ok('UI pass: chart types + type chips + run state + sectioned panels');
  else fail('UI pass: ' + JSON.stringify(uiPass));

  // Editor 3a: zoom + undo/redo.
  const ed = await page.evaluate(() => {
    document.getElementById('mc-overlay').classList.add('hidden');
    window.app._clearAll(); window.app._resetHistory();
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const ev = (t, sx, sy) => canvas.dispatchEvent(
      new MouseEvent(t, { clientX: r.left + sx, clientY: r.top + sy, button: 0, bubbles: true }));

    // Zoom in, then confirm a node placed at world (200,200) is still hit there.
    const beforeScale = window.app.renderer._scale;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: r.left + 300, clientY: r.top + 300, bubbles: true }));
    const zoomed = window.app.renderer._scale > beforeScale;

    window.app.renderer.resetView();
    const place = (tool, sx, sy) => { window.app.editor.setTool(tool); ev('mousedown', sx, sy); ev('mouseup', sx, sy); };
    place('place-pool', 200, 200);
    const afterPlace = window.app.diagram.nodes.size;
    window.app.undo();
    const afterUndo = window.app.diagram.nodes.size;
    window.app.redo();
    const afterRedo = window.app.diagram.nodes.size;
    return { zoomed, afterPlace, afterUndo, afterRedo };
  });
  if (ed.zoomed && ed.afterPlace === 1 && ed.afterUndo === 0 && ed.afterRedo === 1)
    ok('editor: wheel-zoom + undo/redo of a placement');
  else fail('editor 3a: ' + JSON.stringify(ed));

  // Editor 3a': double-click a node to rename it inline; Enter commits.
  const inlineLabel = await page.evaluate(() => {
    window.app._clearAll(); window.app._resetHistory();
    window.app.renderer.resetView();
    const d = window.app.diagram;
    const n = d.addNode(new MNode(NodeType.POOL, 200, 200)); n.label = 'Old';
    window.app.renderer.render();
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const rr = window.app.renderer;
    const sx = r.left + rr._panX + n.x * rr._scale;
    const sy = r.top + rr._panY + n.y * rr._scale;
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: sx, clientY: sy, bubbles: true }));

    const input = document.querySelector('.node-label-edit');
    const opened = !!input && input.value === 'Old';
    if (!input) return { opened, renamed: false, closed: true };
    input.value = 'Treasury';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const renamed = d.nodes.get(n.id).label === 'Treasury';
    const closed = !document.querySelector('.node-label-edit');
    return { opened, renamed, closed };
  });
  if (inlineLabel.opened && inlineLabel.renamed && inlineLabel.closed)
    ok('editor: double-click node opens inline label editor, Enter commits the rename');
  else fail('editor inline label: ' + JSON.stringify(inlineLabel));

  // A mistaken New / Load template is undoable: the pre-replace diagram comes
  // back on Ctrl+Z, and redo re-applies the replacement.
  const replaceUndo = await page.evaluate(() => {
    window.app._clearAll(); window.app._resetHistory();
    const d = window.app.diagram;
    d.addNode(new MNode(NodeType.POOL, 200, 200));
    d.addNode(new MNode(NodeType.SOURCE, 400, 200));
    const before = d.nodes.size; // 2

    // Simulate the New action's body (guard bypassed).
    const prev = window.app._snapshot();
    window.app._clearAll();
    window.app._commitReplace(prev);
    const afterNew = window.app.diagram.nodes.size; // 0

    window.app.undo();
    const afterUndo = window.app.diagram.nodes.size; // back to 2
    window.app.redo();
    const afterRedo = window.app.diagram.nodes.size; // 0 again
    return { before, afterNew, afterUndo, afterRedo };
  });
  if (replaceUndo.before === 2 && replaceUndo.afterNew === 0 && replaceUndo.afterUndo === 2 && replaceUndo.afterRedo === 0)
    ok('editor: New / Load is undoable (Ctrl+Z restores the previous diagram)');
  else fail('replace undo: ' + JSON.stringify(replaceUndo));

  // Editor 3b: marquee multi-select + copy/paste + group delete.
  const ms = await page.evaluate(() => {
    window.app._clearAll(); window.app._resetHistory();
    const d = window.app.diagram;
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const ev = (t, sx, sy, opts = {}) => canvas.dispatchEvent(
      new MouseEvent(t, { clientX: r.left + sx, clientY: r.top + sy, button: 0, bubbles: true, ...opts }));
    // Three pools in a row, plus an internal connection between two of them.
    const a = d.addNode(new MNode(NodeType.POOL, 150, 150)); a.label = 'A';
    const b = d.addNode(new MNode(NodeType.POOL, 250, 150)); b.label = 'B';
    const c = d.addNode(new MNode(NodeType.POOL, 350, 150)); c.label = 'C';
    d.addConnection(new MConnection(a.id, b.id));
    window.app.renderer.render();

    // Marquee around A and B (not C).
    window.app.editor.setTool('select');
    ev('mousedown', 110, 110); ev('mousemove', 300, 200); ev('mouseup', 300, 200);
    const selCount = window.app.editor.selection.size;
    const panelMulti = document.getElementById('props-content').textContent.includes('nodes selected');

    // Copy + paste: should add 2 nodes and 1 internal connection.
    const nodesBefore = d.nodes.size, connsBefore = d.connections.size;
    window.app._copy(); window.app._paste();
    const addedNodes = d.nodes.size - nodesBefore;
    const addedConns = d.connections.size - connsBefore;
    const pastedSel = window.app.editor.selection.size;

    // Delete the (pasted) selection.
    window.app.editor._onKey({ key: 'Delete', target: { tagName: 'BODY' } });
    const afterDelete = d.nodes.size;
    return { selCount, panelMulti, addedNodes, addedConns, pastedSel, afterDelete, nodesBefore };
  });
  if (ms.selCount === 2 && ms.panelMulti && ms.addedNodes === 2 && ms.addedConns === 1 && ms.pastedSel === 2 && ms.afterDelete === ms.nodesBefore)
    ok('editor: marquee multi-select + copy/paste + group delete');
  else fail('editor 3b: ' + JSON.stringify(ms));

  // Pull mode: Flow control toggles and reveals the pull policy.
  const pull = await page.evaluate(() => {
    window.app._clearAll();
    const p = window.app.diagram.addNode(new MNode(NodeType.POOL, 300, 300));
    window.app.renderer.render();
    window.app._onSelect(p.id, 'node');
    const hasLabel = (t) => [...document.querySelectorAll('#props-content .prop-row label')]
      .some(l => l.textContent.trim() === t);
    const hasFlow = hasLabel('Flow');
    for (const row of document.querySelectorAll('#props-content .prop-row')) {
      const lbl = row.querySelector('label');
      if (lbl && lbl.textContent.trim() === 'Flow') {
        const sel = row.querySelector('select'); sel.value = 'pull';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return { hasFlow, mode: p.flowMode, hasPolicy: hasLabel('Pull policy') };
  });
  if (pull.hasFlow && pull.mode === 'pull' && pull.hasPolicy)
    ok('pull mode: Flow control toggles push/pull and reveals pull policy');
  else fail('pull mode: ' + JSON.stringify(pull));

  // P2: gate "all" mode, reverse trigger, distribution rate mode.
  const p2eng = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const hasLabel = (t) => [...document.querySelectorAll('#props-content .prop-row label')]
      .some(l => l.textContent.trim() === t);

    // Gate mode should include 'all' option
    const g = d.addNode(new MNode(NodeType.GATE, 300, 300));
    window.app._onSelect(g.id, 'node');
    const modeOpts = [...document.querySelectorAll('#props-content select option')]
      .map(o => o.value);
    const hasAll = modeOpts.includes('all');

    // State connection: trigger role exposes the fire/fail "On" select
    const a = d.addNode(new MNode(NodeType.POOL, 100, 100));
    const b = d.addNode(new MNode(NodeType.POOL, 200, 100));
    const sc = d.addConnection(new MConnection(a.id, b.id, ConnectionType.STATE));
    window.app._onSelect(sc.id, 'conn');
    const trigChip = [...document.querySelectorAll('#props-content .var-chip')]
      .find(c => c.textContent === 'Triggers target');
    if (trigChip) trigChip.click();
    const hasFailTrigger = [...document.querySelectorAll('#props-content select option')]
      .some(o => o.textContent.includes('fails to act'));

    // Resource connection: distribution rate mode exists
    const rc = d.addConnection(new MConnection(a.id, b.id));
    window.app._onSelect(rc.id, 'conn');
    // Change rate mode to distribution
    for (const row of document.querySelectorAll('#props-content .prop-row')) {
      const lbl = row.querySelector('label');
      if (lbl && lbl.textContent.trim() === 'Rate mode') {
        const sel = row.querySelector('select'); sel.value = 'distribution';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const hasDist = hasLabel('Distribution');

    return { hasAll, hasFailTrigger, hasDist };
  });
  if (p2eng.hasAll && p2eng.hasFailTrigger && p2eng.hasDist)
    ok('P2 engine UI: gate all-mode, reverse trigger, distribution rate');
  else fail('P2 engine UI: ' + JSON.stringify(p2eng));

  // P1: a gate output's Weight offers a Fixed/Formula switch; a formula is
  // stored on the connection and survives a JSON round-trip.
  const gw = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const g = d.addNode(new MNode(NodeType.GATE, 100, 100));
    const p = d.addNode(new MNode(NodeType.POOL, 300, 100));
    const c = d.addConnection(new MConnection(g.id, p.id));
    window.app.renderer.render();
    window.app._onSelect(c.id, 'conn');

    const weightRow = [...document.querySelectorAll('#props-content .prop-row')]
      .find(r => r.querySelector('label') && r.querySelector('label').textContent.trim() === 'Weight');
    const hasFormulaOpt = !!weightRow && [...weightRow.querySelectorAll('select option')]
      .some(o => o.value === 'formula');
    if (weightRow) {
      const sel = weightRow.querySelector('select');
      sel.value = 'formula';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const fInput = [...document.querySelectorAll('#props-content .prop-row input[type=text]')]
      .find(i => i.placeholder && i.placeholder.includes('difficulty'));
    if (fInput) {
      fInput.value = 'gold * 2';
      fInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const d2 = new Diagram();
    d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
    const c2 = [...d2.connections.values()][0];
    return { hasFormulaOpt, stored: c.weightFormula, restored: c2.weightFormula };
  });
  if (gw.hasFormulaOpt && gw.stored === 'gold * 2' && gw.restored === 'gold * 2')
    ok('P1 gate UI: weight accepts a formula and round-trips');
  else fail('P1 gate UI: ' + JSON.stringify(gw));

  // Queue: a Servers field exists; multiple servers serialize; the live metrics
  // readout reports throughput after a short run.
  const queueUI = await page.evaluate(async () => {
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 80, 200));
    const q = d.addNode(new MNode(NodeType.QUEUE, 260, 200));
    q.processTime = 1;
    const dr = d.addNode(new MNode(NodeType.DRAIN, 440, 200));
    d.addConnection(new MConnection(s.id, q.id)).rate = 2;
    d.addConnection(new MConnection(q.id, dr.id)).rate = 1;
    window.app.renderer.render();
    window.app._onSelect(q.id, 'node');

    const serversRow = [...document.querySelectorAll('#props-content .prop-row')]
      .find(r => r.querySelector('label') && r.querySelector('label').textContent.trim() === 'Servers');
    const hasServers = !!serversRow;
    if (serversRow) {
      const inp = serversRow.querySelector('input');
      inp.value = '2';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Run a handful of steps, then read the live metrics readout.
    window.app.engine.reset();
    for (let i = 0; i < 8; i++) window.app.engine.doStep();
    window.app._refreshTypeReadouts();
    const metricsText = (document.getElementById('queue-metrics') || {}).textContent || '';
    const hasMetrics = metricsText.includes('Processed') && metricsText.includes('Avg wait');

    const json = JSON.parse(JSON.stringify(d.toJSON()));
    const cj = json.nodes.find(n => n.id === q.id);
    return { hasServers, servers: q.servers, hasMetrics, processed: q.processed, savedServers: cj && cj.servers };
  });
  if (queueUI.hasServers && queueUI.servers === 2 && queueUI.hasMetrics
    && queueUI.processed > 0 && queueUI.savedServers === 2)
    ok('P1 queue UI: Servers field + live metrics readout + serialization');
  else fail('P1 queue UI: ' + JSON.stringify(queueUI));

  // Queue balking/reneging: Max line + Patience fields exist; under congestion
  // the metrics readout reports balked and reneged losses; both serialize.
  const queueLoss = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 80, 200));
    const q = d.addNode(new MNode(NodeType.QUEUE, 260, 200));
    q.processTime = 2; q.maxLine = 3; q.patience = 3;
    const dr = d.addNode(new MNode(NodeType.DRAIN, 440, 200));
    d.addConnection(new MConnection(s.id, q.id)).rate = 5; // overload the line
    d.addConnection(new MConnection(q.id, dr.id)).rate = 1;
    window.app.renderer.render();
    window.app._onSelect(q.id, 'node');

    const hasLabel = t => [...document.querySelectorAll('#props-content .prop-row label')]
      .some(l => l.textContent.trim() === t);
    const hasMaxLine = hasLabel('Max line');
    const hasPatience = hasLabel('Patience');

    window.app.engine.reset();
    for (let i = 0; i < 12; i++) window.app.engine.doStep();
    window.app._refreshTypeReadouts();
    const text = (document.getElementById('queue-metrics') || {}).textContent || '';
    const showsLosses = text.includes('Balked') && text.includes('Reneged');

    const json = JSON.parse(JSON.stringify(d.toJSON()));
    const cj = json.nodes.find(n => n.id === q.id);
    return {
      hasMaxLine, hasPatience, showsLosses,
      balked: q.balked, reneged: q.reneged,
      savedMaxLine: cj && cj.maxLine, savedPatience: cj && cj.patience,
    };
  });
  if (queueLoss.hasMaxLine && queueLoss.hasPatience && queueLoss.showsLosses
    && queueLoss.balked > 0 && queueLoss.reneged > 0
    && queueLoss.savedMaxLine === 3 && queueLoss.savedPatience === 3)
    ok('P1 queue UI: balking + reneging fields, loss metrics, serialization');
  else fail('P1 queue loss UI: ' + JSON.stringify(queueLoss));

  // Accessibility: dialog semantics + focus trap + Escape on modals, label
  // association in the props panel, aria-pressed toggles, status live region,
  // and arrow-key nudging of a selected node.
  const a11y = await page.evaluate(() => {
    const r = {};
    // Modal: dialog role, focus moves in, Escape closes and restores focus.
    document.getElementById('btn-library').focus();
    window.app._openLibrary();
    const modal = document.getElementById('lib-modal');
    r.dialogRole = modal.getAttribute('role') === 'dialog' && modal.getAttribute('aria-modal') === 'true';
    r.focusIn = document.getElementById('lib-overlay').contains(document.activeElement);
    document.getElementById('lib-overlay').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    r.escClosed = document.getElementById('lib-overlay').classList.contains('hidden');
    r.focusRestored = document.activeElement === document.getElementById('btn-library');
    // Props panel: a labelled field is programmatically associated.
    window.app._clearAll();
    const d = window.app.diagram;
    const p = d.addNode(new MNode(NodeType.POOL, 200, 200));
    window.app._onSelect(p.id, 'node');
    const row = [...document.querySelectorAll('#props-content .prop-row')]
      .find(rw => rw.querySelector('label')?.htmlFor);
    r.labelFor = !!row && row.querySelector('label').htmlFor === row.querySelector('input, select')?.id;
    // Toggle semantics.
    r.toolPressed = document.querySelector('[data-tool="select"]').hasAttribute('aria-pressed');
    r.railPressed = document.querySelector('#diagram-rail .rail-btn').hasAttribute('aria-pressed');
    r.statusLive = document.getElementById('sim-status').getAttribute('role') === 'status';
    // Arrow-key nudge moves the selected node.
    window.app.editor._select(p.id, 'node');
    const x0 = p.x;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    r.nudge = p.x > x0;
    return r;
  });
  if (Object.values(a11y).every(Boolean)) ok('a11y: dialogs + labels + toggles + live status + arrow nudge');
  else fail('a11y: ' + JSON.stringify(a11y));

  // Diagram rail: each feature button renders its editor into the props panel;
  // the active button highlights, clicking it again returns to the default view.
  const rail = await page.evaluate(() => {
    window.app._clearAll();
    window.app.editor._select(null, null);
    const titled = !!document.querySelector('#diagram-rail .rail-title'); // header names the rail
    const open = (f) => document.querySelector(`#diagram-rail .rail-btn[data-feature="${f}"]`).click();
    const content = () => document.getElementById('props-content').textContent;
    open('params');
    const paramsShown = window.app._activeFeature === 'params'
      && content().includes('Parameters') && content().includes('constants');
    const active = document.querySelector('#diagram-rail .rail-btn[data-feature="params"]').classList.contains('active');
    open('vars'); // switch features
    const switched = window.app._activeFeature === 'vars' && content().includes('Custom Variables');
    open('vars'); // toggle off
    const closed = window.app._activeFeature === null
      && !document.querySelector('#diagram-rail .rail-btn.active');
    return { titled, paramsShown, active, switched, closed };
  });
  if (rail.titled && rail.paramsShown && rail.active && rail.switched && rail.closed)
    ok('diagram rail: header present; feature panels open / switch / highlight / toggle off');
  else fail('diagram rail: ' + JSON.stringify(rail));

  // Discoverability: (a) an empty formula field links to the Params panel, and
  // (b) running a stochastic model nudges toward Monte Carlo, once.
  const discover = await page.evaluate(() => {
    const t = window.app;
    t._clearAll(); t._resetHistory(); t._closeFeature();
    try { localStorage.removeItem('sim_seen_mc_hint'); } catch {}

    // (a) Select a connection, switch its rate to Formula → the "no variables
    // yet" hint exposes a link that opens the Params rail panel.
    const d = t.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 200, 200));
    const p = d.addNode(new MNode(NodeType.POOL, 420, 200));
    const c = d.addConnection(new MConnection(s.id, p.id));
    c.rateMode = RateMode.FORMULA; t._commit();
    t._onSelect(c.id, 'conn');
    const link = document.querySelector('#props-content .formula-hint-link');
    const linkPresent = !!link;
    if (link) link.click();
    const openedParams = t._activeFeature === 'params';

    // (b) A stochastic model: the first run (via the real Run button, which is
    // what wires the nudge) fires the MC hint and persists the flag; a later
    // run does not re-toast.
    t._closeFeature();
    const c2 = [...d.connections.values()][0];
    c2.rateMode = RateMode.DICE; c2.dice = '1d6'; t._commit();
    const hasRandom = t._hasRandomness();
    const runBtn = document.getElementById('btn-run');
    const toast = () => { const el = document.getElementById('app-toast'); return el && el.classList.contains('show') ? el.textContent : ''; };
    if (t.engine.running) runBtn.click();          // ensure stopped
    runBtn.click();                                 // start → should nudge
    const firstToast = toast();
    const flag = localStorage.getItem('sim_seen_mc_hint');
    const el = document.getElementById('app-toast'); if (el) el.classList.remove('show');
    runBtn.click();                                 // pause
    runBtn.click();                                 // start again → must NOT re-toast
    const secondToast = toast();
    if (t.engine.running) runBtn.click();           // leave stopped
    t.engine.reset();
    return {
      linkPresent, openedParams, hasRandom,
      nudged: /Monte Carlo/.test(firstToast), flag, reNudged: /Monte Carlo/.test(secondToast),
    };
  });
  if (discover.linkPresent && discover.openedParams && discover.hasRandom
    && discover.nudged && discover.flag === '1' && !discover.reNudged)
    ok('discoverability: formula→Params link opens the rail; first stochastic run nudges to Monte Carlo (once)');
  else fail('discoverability: ' + JSON.stringify(discover));

  // Simulation panel (nothing selected): name/description edit, color scheme
  // remaps accents, background paints the canvas, font select injects a
  // Google Fonts link, file metadata shows, and everything round-trips JSON.
  const simMeta = await page.evaluate(() => {
    window.app._clearAll();
    window.app._closeFeature();
    window.app.editor._select(null, null);
    const panel = document.getElementById('props-content');
    const titled = panel.textContent.includes('Simulation');
    const nameInput = panel.querySelector('input[placeholder="Untitled simulation"]');
    if (!nameInput) return { error: 'no name input' };
    nameInput.value = 'Gold Rush';
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    const titleSync = document.title.startsWith('Gold Rush');
    const desc = panel.querySelector('textarea');
    desc.value = 'A mining economy.';
    desc.dispatchEvent(new Event('change', { bubbles: true }));
    // Scheme: pick 'forest' and check the accent var flipped.
    const selects = [...panel.querySelectorAll('select')];
    const schemeSel = selects[0], fontSel = selects[1];
    schemeSel.value = 'forest';
    schemeSel.dispatchEvent(new Event('change', { bubbles: true }));
    const accentChanged = document.documentElement.style.getPropertyValue('--accent') === '#66bb6a';
    // Background color paints the canvas bg rect.
    window.app.diagram.meta.bgColor = '#fdf6e3';
    window.app.renderer.setBackground('#fdf6e3');
    const bgApplied = window.app.renderer._bgRect.getAttribute('fill') === '#fdf6e3';
    // Font: choose one, expect the gfont link + --font var.
    fontSel.value = 'Space Grotesk';
    fontSel.dispatchEvent(new Event('change', { bubbles: true }));
    const link = document.getElementById('gfont-link');
    const fontApplied = !!link && link.href.includes('Space+Grotesk')
      && document.documentElement.style.getPropertyValue('--font').includes('Space Grotesk');
    // Metadata block renders.
    window.app._renderProps();
    const metaShown = panel.textContent.includes('Created') && panel.textContent.includes('Modified')
      && panel.textContent.includes('KB');
    // Round-trip.
    const d2 = JSON.parse(JSON.stringify(window.app.diagram.toJSON()));
    const rt = d2.meta && d2.meta.name === 'Gold Rush' && d2.meta.description === 'A mining economy.'
      && d2.meta.scheme === 'forest' && d2.meta.bgColor === '#fdf6e3' && d2.meta.font === 'Space Grotesk';
    // Restore defaults so later checks see the stock theme.
    window.app.diagram.meta = Diagram.defaultMeta();
    window.app._applyMeta();
    window.app._renderProps();
    return { titled, titleSync, accentChanged, bgApplied, fontApplied, metaShown, rt };
  });
  if (simMeta.titled && simMeta.titleSync && simMeta.accentChanged && simMeta.bgApplied
      && simMeta.fontApplied && simMeta.metaShown && simMeta.rt)
    ok('simulation panel: name/desc + scheme + background + font + metadata + round-trip');
  else fail('simulation panel: ' + JSON.stringify(simMeta));

  // Custom variables: add one via the panel, check the array input validates,
  // and verify a step-updated var feeds a formula during a run.
  const rvars = await page.evaluate(() => {
    window.app._clearAll();
    window.app._closeFeature();
    document.querySelector('#diagram-rail .rail-btn[data-feature="vars"]').click();
    const panel = document.getElementById('props-content');
    const addBtn = [...panel.querySelectorAll('button')].find(b => b.textContent.includes('Add Variable'));
    if (!addBtn) return { error: 'no add button' };
    addBtn.click();
    const rv = window.app.diagram.customVars[0];
    if (!rv) return { error: 'no var created' };
    // Switch to array kind and exercise validation through the real input.
    rv.kind = 'array';
    window.app._renderProps();
    const card = panel.querySelector('.var-card');
    const arrInput = card.querySelector('input[placeholder*="1, 2"]');
    const type = (v) => { arrInput.value = v; arrInput.dispatchEvent(new Event('input', { bubbles: true })); };
    type('1, 2, banana');
    const invalidFlagged = arrInput.classList.contains('invalid');
    const notCommitted = rv.values.join() !== '1,2,NaN';
    type('5, 5, 5');
    const validAccepted = !arrInput.classList.contains('invalid') && rv.values.join() === '5,5,5';
    // Engine: the var should drive a formula rate.
    const { app } = window;
    const s = app.diagram.addNode(new MNode(NodeType.SOURCE, 100, 100));
    const p = app.diagram.addNode(new MNode(NodeType.POOL, 300, 100));
    const c = app.diagram.addConnection(new MConnection(s.id, p.id));
    c.rateMode = RateMode.FORMULA; c.formula = rv.name;
    app.engine.reset();
    app.engine.doStep(); app.engine.doStep();
    return { invalidFlagged, notCommitted, validAccepted, pooled: p.resources };
  });
  if (rvars.invalidFlagged && rvars.notCommitted && rvars.validAccepted && rvars.pooled === 10)
    ok('custom vars: panel add + array validation + formula-driven flow');
  else fail('custom vars: ' + JSON.stringify(rvars));

  // Math-kind custom variable: math.js loaded, formula input validates, and a
  // computed var (math.js syntax) drives a flow each step.
  const mvars = await page.evaluate(() => {
    const hasMathjs = typeof math !== 'undefined' && !!math.compile;
    window.app._clearAll();
    window.app._closeFeature();
    document.querySelector('#diagram-rail .rail-btn[data-feature="vars"]').click();
    const panel = document.getElementById('props-content');
    [...panel.querySelectorAll('button')].find(b => b.textContent.includes('Add Variable')).click();
    const rv = window.app.diagram.customVars[0];
    rv.kind = 'math';
    window.app._renderProps();
    const card = panel.querySelector('.var-card');
    const fInput = card.querySelector('input[placeholder*="round"]');
    if (!fInput) return { error: 'no formula input' };
    const type = (v) => { fInput.value = v; fInput.dispatchEvent(new Event('input', { bubbles: true })); };
    type('2 +* )');
    const invalidFlagged = fInput.classList.contains('invalid');
    type('min(2 ^ 3, 100)');
    const validAccepted = !fInput.classList.contains('invalid');
    const distHidden = card.querySelectorAll('.var-chip-group').length === 1; // update only (no dist for math)
    const { app } = window;
    const s = app.diagram.addNode(new MNode(NodeType.SOURCE, 100, 100));
    const p = app.diagram.addNode(new MNode(NodeType.POOL, 300, 100));
    const c = app.diagram.addConnection(new MConnection(s.id, p.id));
    c.rateMode = RateMode.FORMULA; c.formula = rv.name;
    app.engine.reset();
    app.engine.doStep();
    return { hasMathjs, invalidFlagged, validAccepted, distHidden, pooled: p.resources };
  });
  if (mvars.hasMathjs && mvars.invalidFlagged && mvars.validAccepted && mvars.distHidden && mvars.pooled === 8)
    ok('math vars: math.js loaded + formula validation + computed flow (2^3 = 8/step)');
  else fail('math vars: ' + JSON.stringify(mvars));

  // P2: keyboard tool shortcuts activate tools.
  const p2keys = await page.evaluate(() => {
    window.app.editor.setTool('select');
    const keyEvt = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    keyEvt('d');
    const tool1 = window.app.editor.tool;
    keyEvt('s');
    const tool2 = window.app.editor.tool;
    keyEvt('r');
    const tool3 = window.app.editor.tool;
    keyEvt('t');
    const tool4 = window.app.editor.tool;
    return { tool1, tool2, tool3, tool4 };
  });
  if (p2keys.tool1 === 'delete' && p2keys.tool2 === 'select' && p2keys.tool3 === 'connect-resource' && p2keys.tool4 === 'connect-state')
    ok('P2 keyboard: S/D/R/T tool shortcuts work');
  else fail('P2 keyboard: ' + JSON.stringify(p2keys));

  // P2: snap toggle + library modal present.
  const p2ui = await page.evaluate(() => {
    const snapBtn = document.getElementById('btn-snap');
    const libBtn = document.getElementById('btn-library');
    const svgBtn = document.getElementById('btn-export-svg');
    const pngBtn = document.getElementById('btn-export-png');
    const libModal = document.getElementById('lib-overlay');
    return { snap: !!snapBtn, lib: !!libBtn, svg: !!svgBtn, png: !!pngBtn, modal: !!libModal };
  });
  if (p2ui.snap && p2ui.lib && p2ui.svg && p2ui.png && p2ui.modal)
    ok('P2 UI: snap button, library button, export SVG/PNG, library modal present');
  else fail('P2 UI: ' + JSON.stringify(p2ui));

  // P3: time-mode selector + per-node async fields.
  const p3time = await page.evaluate(() => {
    window.app._clearAll();
    window.app._closeFeature();
    document.querySelector('#diagram-rail .rail-btn[data-feature="time"]').click();  // time panel
    const diagText = document.getElementById('props-content').textContent;
    const hasTimeMode = diagText.includes('Time mode');

    window.app.diagram.timeMode = 'async';
    const s = window.app.diagram.addNode(new MNode(NodeType.SOURCE, 200, 200));
    window.app._onSelect(s.id, 'node');
    const hasFireEvery = [...document.querySelectorAll('#props-content .prop-row label')]
      .some(l => l.textContent.trim() === 'Fire every');
    window.app.diagram.timeMode = 'sync';
    return { hasTimeMode, hasFireEvery };
  });
  if (p3time.hasTimeMode && p3time.hasFireEvery)
    ok('P3 time modes: diagram time-mode selector + per-node async fields');
  else fail('P3 time modes: ' + JSON.stringify(p3time));

  // P3: artificial-player panel present and accepts a rule.
  const p3ai = await page.evaluate(() => {
    window.app._clearAll();
    window.app._closeFeature();
    const p = window.app.diagram.addNode(new MNode(NodeType.POOL, 200, 200));
    p.activation = ActivationMode.INTERACTIVE;
    document.querySelector('#diagram-rail .rail-btn[data-feature="player"]').click();
    const hasAI = document.getElementById('props-content').textContent.includes('Artificial Player');
    const ai = window.app.diagram.aiPlayer;
    ai.rules.push({ nodeId: p.id, mode: 'interval', every: 3 });
    ai.enabled = true;
    window.app._renderProps();                            // re-render with the rule
    const ruleBoxes = document.querySelectorAll('#props-content .ai-rule').length;
    return { hasAI, ruleBoxes };
  });
  if (p3ai.hasAI && p3ai.ruleBoxes === 1)
    ok('P3 artificial player: panel renders and shows a rule');
  else fail('P3 artificial player: ' + JSON.stringify(p3ai));

  // P3: CSV export builds a header + one row per recorded step.
  const p3csv = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 200, 200));
    const p = d.addNode(new MNode(NodeType.POOL, 400, 200)); p.label = 'Bank';
    d.addConnection(new MConnection(s.id, p.id)).rate = 2;
    window.app.engine.reset();
    for (let i = 0; i < 4; i++) window.app.engine.doStep();
    const csv = window.app._buildCSV();
    const lines = csv.trim().split('\n');
    return { header: lines[0], rows: lines.length, hasBank: lines[0].includes('Bank') };
  });
  if (p3csv.header.startsWith('step') && p3csv.hasBank && p3csv.rows === 5)
    ok(`P3 CSV: history export (header + ${p3csv.rows - 1} rows)`);
  else fail('P3 CSV: ' + JSON.stringify(p3csv));

  // P3: shareable URL encode/decode round-trips the diagram.
  const p3share = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    d.addNode(new MNode(NodeType.POOL, 100, 100));
    d.addNode(new MNode(NodeType.DRAIN, 300, 100));
    const enc = window.app._encodeDiagram();
    location.hash = '#d=' + enc;
    const decoded = window.app._decodeDiagram();
    location.hash = '';
    return { encLen: enc.length, nodes: decoded ? decoded.nodes.length : -1 };
  });
  if (p3share.encLen > 0 && p3share.nodes === 2)
    ok('P3 share: diagram encodes to a URL hash and decodes back');
  else fail('P3 share: ' + JSON.stringify(p3share));

  // P3: auto-revert reverts to Select after placing a node (on by default).
  const p3auto = await page.evaluate(() => {
    window.app._clearAll();
    const enabled = window.app.editor.autoRevert; // true by default
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const ev = (t, sx, sy) => canvas.dispatchEvent(
      new MouseEvent(t, { clientX: r.left + sx, clientY: r.top + sy, button: 0, bubbles: true }));
    window.app._activateTool('place-pool');
    ev('mousedown', 250, 250); ev('mouseup', 250, 250);
    const toolAfter = window.app.editor.tool;
    return { enabled, toolAfter, placed: window.app.diagram.nodes.size };
  });
  if (p3auto.enabled && p3auto.toolAfter === 'select' && p3auto.placed === 1)
    ok('P3 auto-revert: tool returns to Select after placing a node');
  else fail('P3 auto-revert: ' + JSON.stringify(p3auto));

  // P3: touch handlers wired + accessibility attributes present.
  const p3a11y = await page.evaluate(() => {
    const ed = window.app.editor;
    const hasTouch = typeof ed._onTouchStart === 'function'
      && typeof ed._onTouchMove === 'function' && typeof ed._onTouchEnd === 'function';
    const canvas = document.getElementById('canvas');
    const canvasRole = canvas.getAttribute('role') === 'application' && !!canvas.getAttribute('aria-label');
    const undoLabel = document.getElementById('btn-undo').getAttribute('aria-label') === 'Undo';
    const iconHidden = [...document.querySelectorAll('.tool-icon svg, .tool-icon .fa-solid')]
      .every(s => s.getAttribute('aria-hidden') === 'true');
    return { hasTouch, canvasRole, undoLabel, iconHidden };
  });
  if (p3a11y.hasTouch && p3a11y.canvasRole && p3a11y.undoLabel && p3a11y.iconHidden)
    ok('P3 touch + a11y: touch handlers, canvas role, aria-labels, hidden icons');
  else fail('P3 touch + a11y: ' + JSON.stringify(p3a11y));

  // P3: embed mode hides the editing chrome.
  const p3embed = await page.evaluate(() => {
    document.body.classList.add('embed');
    const paletteHidden = getComputedStyle(document.getElementById('palette')).display === 'none';
    const propsHidden = getComputedStyle(document.getElementById('props-panel')).display === 'none';
    const railHidden = getComputedStyle(document.getElementById('diagram-rail')).display === 'none';
    document.body.classList.remove('embed');
    return { paletteHidden, propsHidden, railHidden };
  });
  if (p3embed.paletteHidden && p3embed.propsHidden && p3embed.railHidden)
    ok('P3 embed: embed mode hides palette, properties panel, and diagram rail');
  else fail('P3 embed: ' + JSON.stringify(p3embed));

  // P2: groups and sticky notes create, render, select, and serialize.
  const p2annotate = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const g = d.addGroup(new MGroup(50, 50, 220, 160));
    g.label = 'Test Group'; g.color = '#ba68c8';
    const note = d.addNote(new MNote(300, 80));
    note.text = 'Hello note'; note.color = '#f6e05e';
    window.app.renderer.render();

    window.app._onSelect(g.id, 'group');
    const hasGroupTitle = document.getElementById('props-content').textContent.includes('Container group');
    window.app._onSelect(note.id, 'note');
    const hasNoteTitle = document.getElementById('props-content').textContent.includes('Sticky note');

    const json = JSON.parse(JSON.stringify(d.toJSON()));
    const d2 = new Diagram();
    d2.loadJSON(json);
    const groupsOk = d2.groups.size === 1 && [...d2.groups.values()][0].label === 'Test Group';
    const notesOk = d2.notes.size === 1 && [...d2.notes.values()][0].text === 'Hello note';
    return { hasGroupTitle, hasNoteTitle, groupsOk, notesOk };
  });
  if (p2annotate.hasGroupTitle && p2annotate.hasNoteTitle && p2annotate.groupsOk && p2annotate.notesOk)
    ok('P2 annotate: groups + sticky notes create, render, show props, serialize');
  else fail('P2 annotate: ' + JSON.stringify(p2annotate));

  // P2: on-canvas chart element tracks a node, plots after a run, serializes.
  const p2chart = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 150, 150));
    const p = d.addNode(new MNode(NodeType.POOL, 380, 150)); p.label = 'Bank';
    d.addConnection(new MConnection(s.id, p.id)).rate = 2;

    const chart = d.addChart(new MChart(150, 300));
    chart.label = 'Bank over time';
    chart.nodeIds = [p.id];
    window.app.renderer.render();

    // Props panel shows the chart editor with the tracked node.
    window.app._onSelect(chart.id, 'chart');
    const panelText = document.getElementById('props-content').textContent;
    const hasChartPanel = panelText.includes('Canvas widget') && panelText.includes('Tracked nodes') && panelText.includes('Bank');

    // Before a run: a hint is shown, no polylines yet.
    const chartEl = window.app.renderer._chartEls.get(chart.id);
    const linesBefore = chartEl.querySelectorAll('polyline').length;

    // Run a few steps, then the chart should draw a polyline.
    window.app.engine.reset();
    for (let i = 0; i < 6; i++) window.app.engine.doStep();
    window.app.renderer.render();
    const linesAfter = chartEl.querySelectorAll('polyline').length;

    // Hover readout: pointing at a step draws a crosshair, a dot per series, and
    // a tooltip box with "Step N" plus the tracked node's value.
    const r = window.app.renderer;
    r._chartHover = { id: chart.id, idx: 3 };
    r._drawChartHover(chartEl);
    const hov = chartEl.querySelector('.chart-hover');
    const hoverHasCrosshair = hov.querySelectorAll('line').length === 1;
    const hoverHasDot = hov.querySelectorAll('circle').length === 1;
    const hoverText = [...hov.querySelectorAll('text')].map(t => t.textContent).join(' | ');
    const hoverShowsStepAndValue = /Step \d/.test(hoverText) && /Bank:/.test(hoverText);
    // Leaving clears the overlay.
    chartEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    const hoverCleared = hov.childElementCount === 0;

    // Serialization round-trip.
    const d2 = new Diagram();
    d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
    const chartsOk = d2.charts.size === 1 && [...d2.charts.values()][0].nodeIds[0] === p.id;

    return { hasChartPanel, linesBefore, linesAfter, chartsOk,
             hoverHasCrosshair, hoverHasDot, hoverShowsStepAndValue, hoverCleared };
  });
  if (p2chart.hasChartPanel && p2chart.linesBefore === 0 && p2chart.linesAfter === 1 && p2chart.chartsOk)
    ok('P2 chart: on-canvas chart tracks a node, plots a line after a run, serializes');
  else fail('P2 chart: ' + JSON.stringify(p2chart));
  if (p2chart.hoverHasCrosshair && p2chart.hoverHasDot && p2chart.hoverShowsStepAndValue && p2chart.hoverCleared)
    ok('P2 chart: hover draws crosshair + per-series value readout, clears on leave');
  else fail('P2 chart hover: ' + JSON.stringify(p2chart));

  // Bar charts lay each step in its own slot, so hover hit-testing must be
  // slot-based (floor), not the edge-to-edge index used by line/area. Pointing
  // inside slot 2 should select index 2, and the crosshair lands at slot centre.
  const barHover = await page.evaluate(() => {
    const chart = [...window.app.diagram.charts.values()][0];
    chart.chartType = 'bars';
    window.app.renderer.render();
    const el = window.app.renderer._chartEls.get(chart.id);
    const ctx = el._chartCtx;
    const slot = ctx.plotW / ctx.n;
    // A cursor a little past the start of slot 2 must resolve to index 2 (a
    // round-to-nearest mapping would wrongly pick 1 here).
    const probeX = ctx.x0 + slot * 2 + slot * 0.15;
    const idx = window.app.renderer._chartIndexAtX(ctx, probeX);
    const cx = window.app.renderer._chartXAtIndex(ctx, 2);
    const slotCentre = ctx.x0 + 2.5 * slot;
    return { n: ctx.n, idx, crosshairAtSlotCentre: Math.abs(cx - slotCentre) < 0.5 };
  });
  if (barHover.idx === 2 && barHover.crosshairAtSlotCentre)
    ok('P2 chart: bar-chart hover snaps to the correct slot (slot-based, not edge-spaced)');
  else fail('P2 chart bar hover: ' + JSON.stringify(barHover));

  // Live flow readout: a step that moves resources flashes a "+N" badge on the
  // connection; the Flow toggle suppresses and clears it.
  const flow = await page.evaluate(() => {
    window.app._clearAll(); window.app._resetHistory();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 150, 150));
    const p = d.addNode(new MNode(NodeType.POOL, 380, 150));
    const c = d.addConnection(new MConnection(s.id, p.id)); c.rate = 2;
    window.app.renderer.render();
    const btnExists = !!document.getElementById('btn-flow');

    window.app._flowReadout = true;
    window.app.engine.reset();
    window.app.engine.doStep();
    const layer = window.app.renderer.flowLayer;
    const badgeCount = layer.childElementCount;
    const txt = [...layer.querySelectorAll('text')].map(t => t.textContent).join(',');

    // Toggle off clears existing badges and suppresses future ones.
    window.app._flowReadout = false;
    window.app.renderer.flowFx.clear();
    window.app.engine.doStep();
    const afterOff = window.app.renderer.flowLayer.childElementCount;
    return { btnExists, badgeCount, txt, afterOff };
  });
  if (flow.btnExists && flow.badgeCount >= 1 && /2/.test(flow.txt) && flow.afterOff === 0)
    ok('flow readout: step flashes a flow badge on the connection; toggle suppresses it');
  else fail('flow readout: ' + JSON.stringify(flow));

  // History scrubbing: after a run, the slider previews past node values on the
  // canvas non-destructively, and "Live" restores the latest state.
  const scrub = await page.evaluate(() => {
    window.app._clearAll(); window.app._resetHistory();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 150, 150));
    const p = d.addNode(new MNode(NodeType.POOL, 380, 150)); p.label = 'Bank';
    const c = d.addConnection(new MConnection(s.id, p.id)); c.rate = 2;
    window.app.renderer.render();
    window.app.engine.reset();
    for (let i = 0; i < 5; i++) window.app.engine.doStep();
    const liveVal = p.resources; // 10

    window.app._refreshScrubber();
    const range = document.getElementById('tl-range');
    const enabled = !range.disabled;

    // Preview an early step.
    window.app._scrubTo(1);
    const countOf = () => window.app.renderer._nodeEls.get(p.id).querySelector('.n-count').textContent;
    const shownAtScrub = String(countOf());
    const histVal1 = String(window.app.engine.history[1].snap[p.id]);
    const scrubbingClass = document.getElementById('canvas').classList.contains('scrubbing');
    const liveUntouched = p.resources === liveVal; // engine state not mutated

    // Exit scrub → live value returns and the cue clears.
    window.app._exitScrub();
    const shownLive = String(countOf());
    const exited = window.app._scrubIndex === null
      && !document.getElementById('canvas').classList.contains('scrubbing');

    return { liveVal, enabled, shownAtScrub, histVal1, scrubbingClass, liveUntouched, shownLive, exited };
  });
  if (scrub.enabled && scrub.shownAtScrub === scrub.histVal1 && scrub.shownAtScrub !== String(scrub.liveVal)
      && scrub.scrubbingClass && scrub.liveUntouched && scrub.exited && scrub.shownLive === String(scrub.liveVal))
    ok('scrub: slider previews past node values non-destructively; Live restores the latest state');
  else fail('scrub: ' + JSON.stringify(scrub));

  // Timeline compare: drag a window [A,B] on the chart → a selection is recorded,
  // the header shows the span + Clear, and Clear (and a plain click) dismiss it.
  await page.evaluate(() => {
    window.app._clearAll(); window.app._resetHistory();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 150, 150));
    const p = d.addNode(new MNode(NodeType.POOL, 380, 150)); p.label = 'Bank';
    d.addConnection(new MConnection(s.id, p.id)).rate = 2;
    window.app.renderer.render();
    window.app.engine.reset();
    for (let i = 0; i < 20; i++) window.app.engine.doStep();
    if (!window.app._timelineVisible) document.getElementById('btn-timeline').click();
    window.app.timeline.update();
  });
  const tlBox = await page.locator('#timeline-canvas').boundingBox();
  const ty = tlBox.y + tlBox.height * 0.5;
  await page.mouse.move(tlBox.x + tlBox.width * 0.25, ty);
  await page.mouse.down();
  await page.mouse.move(tlBox.x + tlBox.width * 0.45, ty, { steps: 6 });
  await page.mouse.move(tlBox.x + tlBox.width * 0.70, ty, { steps: 6 });
  await page.mouse.up();
  const compare = await page.evaluate(() => {
    const sel = window.app.timeline._sel;
    const info = document.getElementById('tl-compare-info');
    const clearBtn = document.getElementById('tl-compare-clear');
    const selected = !!sel && sel.bStep > sel.aStep;
    // offsetParent === null means actually not rendered (catches a missing
    // display:none, not just a toggled class).
    const headerShown = info.offsetParent !== null && clearBtn.offsetParent !== null
      && /Comparing steps/.test(info.textContent);
    clearBtn.click();
    const clearedByButton = window.app.timeline._sel === null
      && info.offsetParent === null && clearBtn.offsetParent === null;
    return { selected, headerShown, clearedByButton };
  });
  if (compare.selected && compare.headerShown && compare.clearedByButton)
    ok('timeline compare: drag selects a window with an A→B readout; header + Clear dismiss it');
  else fail('timeline compare: ' + JSON.stringify(compare));

  // Y-axis scale modes switch via the header select and re-render the chart.
  const scale = await page.evaluate(() => {
    const sel = document.getElementById('tl-scale');
    const set = (v) => { sel.value = v; sel.dispatchEvent(new Event('change')); return window.app.timeline._scale; };
    const log = set('log');
    const norm = set('norm');
    const lin = set('linear');
    return { log, norm, lin, w: document.getElementById('timeline-canvas').width };
  });
  if (scale.log === 'log' && scale.norm === 'norm' && scale.lin === 'linear' && scale.w > 0)
    ok('timeline scale: Linear / Log / Normalized modes switch and re-render');
  else fail('timeline scale: ' + JSON.stringify(scale));

  // Minimap: toggles on, maps world→minimap coords, and clicking it re-centres
  // the main view (the viewport follows the click).
  const minimap = await page.evaluate(() => {
    window.app._clearAll(); window.app._resetHistory();
    const d = window.app.diagram;
    // Spread nodes out so there's something to navigate.
    d.addNode(new MNode(NodeType.POOL, 100, 100));
    d.addNode(new MNode(NodeType.POOL, 1600, 1200));
    window.app.renderer.render();
    window.app.renderer.zoomTo(1);

    document.getElementById('btn-minimap').click();
    const mm = window.app._minimap;
    const shown = mm.visible && !document.getElementById('minimap').classList.contains('hidden');
    const hasMapping = !!mm._mm;

    // Click the centre of the minimap → main view should re-centre near the
    // content centre (~world (850,650)).
    const cv = document.getElementById('minimap-canvas');
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const vp = window.app.renderer._viewportWorld();
    const cx = (vp.x0 + vp.x1) / 2, cy = (vp.y0 + vp.y1) / 2;
    const recentred = Math.abs(cx - 850) < 250 && Math.abs(cy - 650) < 250;

    // Toggle off hides it.
    document.getElementById('btn-minimap').click();
    const hiddenAfter = !mm.visible && document.getElementById('minimap').classList.contains('hidden');
    return { shown, hasMapping, recentred, hiddenAfter };
  });
  if (minimap.shown && minimap.hasMapping && minimap.recentred && minimap.hiddenAfter)
    ok('minimap: toggles, renders an overview, and click re-centres the main view');
  else fail('minimap: ' + JSON.stringify(minimap));

  // Hit-test order matches visual stacking: an annotation painted over a node
  // is selected (not the node hidden beneath it), and a bare node is still hit.
  const hitOrder = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const n = d.addNode(new MNode(NodeType.POOL, 300, 300));
    const note = d.addNote(new MNote(250, 270));   // 160×80 → covers (300,300)
    const chart = d.addChart(new MChart(500, 470)); // away from the node
    window.app.renderer.render();
    const overNode = window.app.renderer.hitTest(300, 300);   // note is on top here
    const onChart = window.app.renderer.hitTest(560, 520);    // chart only
    d.removeNote(note.id);
    window.app.renderer.render();
    const bareNode = window.app.renderer.hitTest(300, 300);   // now just the node
    return {
      overNote: overNode && overNode.type === 'note' && overNode.id === note.id,
      onChart: onChart && onChart.type === 'chart' && onChart.id === chart.id,
      bareNode: bareNode && bareNode.type === 'node' && bareNode.id === n.id,
    };
  });
  if (hitOrder.overNote && hitOrder.onChart && hitOrder.bareNode)
    ok('hit-test honours visual stacking (annotation over node wins; bare node still selectable)');
  else fail('hit-test order: ' + JSON.stringify(hitOrder));

  // P2: named resource types — editor, type pickers, per-type readouts.
  const p2types = await page.evaluate(() => {
    window.app._clearAll();
    window.app._closeFeature();
    const d = window.app.diagram;
    d.resourceTypes = [{ name: 'Gold', color: '#ffd700' }, { name: 'Wood', color: '#8d6e63' }];

    // The resources panel shows the Resource Types editor with the type names.
    document.querySelector('#diagram-rail .rail-btn[data-feature="resources"]').click();
    const diagText = document.getElementById('props-content').textContent;
    const hasTypesEditor = diagText.includes('Resource Types') && diagText.includes('Gold')
      && diagText.includes('Totals held');

    // A pool holding gold shows the type NAME (not the hex) in its readout.
    const p = d.addNode(new MNode(NodeType.POOL, 200, 200));
    p.setCount(5, '#ffd700');
    window.app._onSelect(p.id, 'node');     // selecting clears the resources panel
    const holdings = document.getElementById('node-holdings');
    const holdingsText = holdings ? holdings.textContent : '';
    const showsGold = holdingsText.includes('Gold') && holdingsText.includes('5');

    // A source's colour field offers a resource-type dropdown.
    const s = d.addNode(new MNode(NodeType.SOURCE, 400, 200));
    window.app._onSelect(s.id, 'node');
    const hasTypeDropdown = [...document.querySelectorAll('#props-content .prop-row label')]
      .some(l => l.textContent.trim() === 'Type');

    // Live totals refresh: reopen the resources panel + a step recomputes the total.
    document.querySelector('#diagram-rail .rail-btn[data-feature="resources"]').click();
    window.app._refreshTypeReadouts();
    const totalsText = document.getElementById('diagram-totals').textContent;
    const totalsOk = totalsText.includes('Gold') && totalsText.includes('5') && totalsText.includes('Wood');

    // Serialization round-trip + name lookup.
    const d2 = new Diagram();
    d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
    const typesOk = d2.resourceTypes.length === 2 && d2.resourceTypeName('#ffd700') === 'Gold';

    return { hasTypesEditor, showsGold, hasTypeDropdown, totalsOk, typesOk };
  });
  if (p2types.hasTypesEditor && p2types.showsGold && p2types.hasTypeDropdown && p2types.totalsOk && p2types.typesOk)
    ok('P2 resource types: editor, type pickers, per-type holdings + live totals, serialize');
  else fail('P2 resource types: ' + JSON.stringify(p2types));

  // UX pass: formula field shows in-scope variables + validity; formula help
  // exists for a formula-rate connection.
  const formulaHelp = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    d.params = { growth_rate: 0.1 };
    const s = d.addNode(new MNode(NodeType.SOURCE, 200, 200));
    const p = d.addNode(new MNode(NodeType.POOL, 400, 200)); p.setCount(10);
    const c = d.addConnection(new MConnection(s.id, p.id));
    c.rateMode = RateMode.FORMULA; c.formula = 'growth_rate * 2';
    window.app.renderer.render();
    window.app._onSelect(c.id, 'conn');
    const hint = document.querySelector('#props-content .formula-hint');
    const codes = [...document.querySelectorAll('#props-content .formula-hint code')].map(e => e.textContent);
    const tip = !!document.querySelector('#props-content .formula-tip');
    // Now make it invalid and confirm the field flags it.
    const inp = [...document.querySelectorAll('#props-content input')].find(i => i.value === 'growth_rate * 2');
    let invalidFlagged = false;
    if (inp) {
      inp.value = 'growth_rate * '; inp.dispatchEvent(new Event('input', { bubbles: true }));
      invalidFlagged = inp.classList.contains('invalid');
    }
    return { hasHint: !!hint, listsParam: codes.includes('growth_rate'), tip, invalidFlagged };
  });
  if (formulaHelp.hasHint && formulaHelp.listsParam && formulaHelp.tip && formulaHelp.invalidFlagged)
    ok('UX: formula field lists in-scope variables + state-connection tip + invalid-formula flagging');
  else fail('UX formula help: ' + JSON.stringify(formulaHelp));

  // Knowledge base: the concept guide loads content, opens to a deep-linked
  // article, filters via search, switches articles from the rail, and the
  // properties "?" deep-links a selected node to its own entry.
  const kb = await page.evaluate(() => {
    const out = {};
    out.loaded = typeof KB_ARTICLES !== 'undefined' && KB_ARTICLES.length > 0;

    // Open deep-linked to the Pool article.
    window.app._openKB('node-pool');
    out.overlayOpen = !document.getElementById('kb-overlay').classList.contains('hidden');
    out.articleIsPool = /Pool/.test(document.querySelector('#kb-article h2')?.textContent || '')
      && /container/.test(document.getElementById('kb-article').textContent);
    out.navHasItems = document.querySelectorAll('#kb-nav .kb-link').length === KB_ARTICLES.length;
    out.activeIsPool = document.querySelector('#kb-nav .kb-link.active')?.dataset.kbId === 'node-pool';

    // Search filters the rail down to matching topics.
    const search = document.getElementById('kb-search-input');
    search.value = 'converter';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const links = [...document.querySelectorAll('#kb-nav .kb-link')];
    out.searchNarrowed = links.length > 0 && links.length < KB_ARTICLES.length
      && links.some(l => l.dataset.kbId === 'node-converter');

    // A no-match query shows the hint.
    search.value = 'zzzznotathing';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    out.noResults = !!document.querySelector('#kb-nav .kb-noresults')
      && document.querySelectorAll('#kb-nav .kb-link').length === 0;

    // Clear search, then switch articles by clicking a rail link.
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#kb-nav .kb-link[data-kb-id="node-gate"]').click();
    out.switched = /Gate/.test(document.querySelector('#kb-article h2')?.textContent || '')
      && document.querySelector('#kb-nav .kb-link.active')?.dataset.kbId === 'node-gate';

    window.app._hideModal('kb-overlay');
    out.closed = document.getElementById('kb-overlay').classList.contains('hidden');

    // Properties "?" deep-link: select a converter node, click the help button.
    window.app._clearAll();
    const n = window.app.diagram.addNode(new MNode(NodeType.CONVERTER, 300, 300));
    window.app.renderer.render();
    window.app.editor._select(n.id, 'node');
    window.app._renderProps();
    const helpBtn = document.querySelector('#props-content .props-help');
    out.propsHelpPresent = !!helpBtn;
    helpBtn?.click();
    out.propsDeepLink = !document.getElementById('kb-overlay').classList.contains('hidden')
      && /Converter/.test(document.querySelector('#kb-article h2')?.textContent || '');
    window.app._hideModal('kb-overlay');
    return out;
  });
  if (kb.loaded && kb.overlayOpen && kb.articleIsPool && kb.navHasItems && kb.activeIsPool
      && kb.searchNarrowed && kb.noResults && kb.switched && kb.closed
      && kb.propsHelpPresent && kb.propsDeepLink)
    ok('knowledge base: guide opens, deep-links, searches, switches articles, and props "?" links a node to its entry');
  else fail('knowledge base: ' + JSON.stringify(kb));

  // Reusable components: save a 2-node selection as a component, insert it,
  // verify node count increases by 2, then undo restores the previous count.
  const comp = await page.evaluate(() => {
    window.app._clearAll();
    const d = window.app.diagram;
    const s = d.addNode(new MNode(NodeType.SOURCE, 100, 200));
    const p = d.addNode(new MNode(NodeType.POOL, 300, 200));
    d.addConnection(new MConnection(s.id, p.id));
    window.app.renderer.render();
    window.app._commit(); // snapshot the 2-node baseline so undo can return here
    // Select both nodes
    window.app.editor._setSelection([s.id, p.id], null, 'node');
    const before = d.nodes.size;
    // Open library and save selection as component
    window.app._openLibrary();
    document.getElementById('comp-name').value = 'TestComp';
    document.getElementById('comp-save').click();
    // Verify component was saved
    const saved = window.app._getComponents();
    const compEntry = saved.find(e => e.name === 'TestComp');
    // Insert the component
    if (compEntry) window.app._insertComponent(compEntry);
    const after = d.nodes.size;
    // Undo should remove the 2 inserted nodes
    window.app.undo();
    const afterUndo = d.nodes.size;
    return { before, after, afterUndo, savedCount: saved.length, compNodes: compEntry?.nodes.length ?? -1, compConns: compEntry?.conns.length ?? -1 };
  });
  if (comp.before === 2 && comp.after === 4 && comp.afterUndo === 2
      && comp.compNodes === 2 && comp.compConns === 1)
    ok(`components: save selection (${comp.compNodes} nodes, ${comp.compConns} conn), insert adds 2 nodes, undo reverts`);
  else fail('components: ' + JSON.stringify(comp));

  // UX pass: first-run welcome overlay shows for a brand-new user, dismisses,
  // and sets the seen flag (use a fresh context with no suppression).
  const welcome = await (async () => {
    const ctx = await browser.newContext();
    const wp = await ctx.newPage();
    await wp.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await wp.goto(URL, { waitUntil: 'networkidle' });
    const shown = await wp.evaluate(() => !document.getElementById('welcome-overlay').classList.contains('hidden'));
    // The building-blocks glossary should cover every palette node type, not a
    // subset (an undercount was a credibility ding in the usability pass).
    const glossaryComplete = await wp.evaluate(() => {
      const dts = [...document.querySelectorAll('#welcome-modal dl dt')].map(d => d.textContent.trim());
      const need = ['Pool', 'Source', 'Drain', 'Gate', 'Converter', 'Register', 'Delay', 'Queue', 'Trader'];
      return need.every(n => dts.includes(n));
    });
    await wp.click('#welcome-explore');
    const hidden = await wp.evaluate(() => document.getElementById('welcome-overlay').classList.contains('hidden'));
    const flag = await wp.evaluate(() => localStorage.getItem('sim_seen_welcome'));
    await ctx.close();
    return { shown, glossaryComplete, hidden, flag };
  })();
  if (welcome.shown && welcome.glossaryComplete && welcome.hidden && welcome.flag === '1')
    ok('UX: first-run welcome overlay shows (full node glossary), dismisses, and persists the seen flag');
  else fail('UX welcome: ' + JSON.stringify(welcome));

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
