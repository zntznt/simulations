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
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
  const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

  await page.goto(URL, { waitUntil: 'networkidle' });

  // App booted with the default example.
  const nodeCount = await page.evaluate(() => window.app.diagram.nodes.size);
  if (nodeCount > 0) ok(`default example loaded (${nodeCount} nodes)`); else fail('no nodes on boot');

  // Each starter template (now in the Library) loads cleanly (bypass confirm()).
  await page.evaluate(() => { window.confirm = () => true; });
  const templateNames = await page.evaluate(() => window.app._templates.map(t => t.name));
  for (const name of templateNames) {
    await page.evaluate((nm) => {
      const t = window.app._templates.find(x => x.name === nm);
      window.app._loadTemplate(t);
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
    const modToggled = toggle('Modifier (Δ)');

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
    document.getElementById('mc-runs').value = '20';
    document.getElementById('mc-steps').value = '10';
    document.getElementById('mc-run').click();
    await new Promise(r => setTimeout(r, 150));
    const rows = document.querySelectorAll('#mc-results table tbody tr').length;
    return { tlShown, cw, mcShown, rows };
  });
  if (analysis.tlShown && analysis.cw > 0 && analysis.mcShown && analysis.rows >= 1)
    ok(`analysis: timeline chart + Monte Carlo (${analysis.rows} result rows)`);
  else fail('analysis: ' + JSON.stringify(analysis));

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

    // State connection: reverse trigger checkbox
    const a = d.addNode(new MNode(NodeType.POOL, 100, 100));
    const b = d.addNode(new MNode(NodeType.POOL, 200, 100));
    const sc = d.addConnection(new MConnection(a.id, b.id, ConnectionType.STATE));
    window.app._onSelect(sc.id, 'conn');
    const hasFailTrigger = [...document.querySelectorAll('#props-content .prop-row label')]
      .some(l => l.textContent.includes('Fail trigger'));

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

  // P2: diagram params panel shows when nothing selected.
  const p2params = await page.evaluate(() => {
    window.app._clearAll();
    window.app.editor._select(null, null);
    const text = document.getElementById('props-content').textContent;
    return { hasParams: text.includes('Parameters') };
  });
  if (p2params.hasParams) ok('P2 params: diagram params panel visible when nothing selected');
  else fail('P2 params: ' + JSON.stringify(p2params));

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
    window.app.editor._select(null, null);                 // diagram panel
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
    const p = window.app.diagram.addNode(new MNode(NodeType.POOL, 200, 200));
    p.activation = ActivationMode.INTERACTIVE;
    window.app.editor._select(null, null);                 // diagram panel
    const hasAI = document.getElementById('props-content').textContent.includes('Artificial Player');
    const ai = window.app.diagram.aiPlayer;
    ai.rules.push({ nodeId: p.id, mode: 'interval', every: 3 });
    ai.enabled = true;
    window.app.editor._select(null, null);                 // re-render with the rule
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

  // P3: auto-revert reverts to Select after placing a node.
  const p3auto = await page.evaluate(() => {
    window.app._clearAll();
    document.getElementById('btn-autoselect').click();     // enable auto-revert
    const enabled = window.app.editor.autoRevert;
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const ev = (t, sx, sy) => canvas.dispatchEvent(
      new MouseEvent(t, { clientX: r.left + sx, clientY: r.top + sy, button: 0, bubbles: true }));
    window.app._activateTool('place-pool');
    ev('mousedown', 250, 250); ev('mouseup', 250, 250);
    const toolAfter = window.app.editor.tool;
    document.getElementById('btn-autoselect').click();     // restore
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
    const iconHidden = [...document.querySelectorAll('.tool-icon svg')]
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
    document.body.classList.remove('embed');
    return { paletteHidden, propsHidden };
  });
  if (p3embed.paletteHidden && p3embed.propsHidden)
    ok('P3 embed: embed mode hides palette and properties panel');
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
    const hasGroupTitle = document.getElementById('props-content').textContent.includes('Container Group');
    window.app._onSelect(note.id, 'note');
    const hasNoteTitle = document.getElementById('props-content').textContent.includes('Sticky Note');

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
    const hasChartPanel = panelText.includes('Chart') && panelText.includes('Tracked nodes') && panelText.includes('Bank');

    // Before a run: a hint is shown, no polylines yet.
    const chartEl = window.app.renderer._chartEls.get(chart.id);
    const linesBefore = chartEl.querySelectorAll('polyline').length;

    // Run a few steps, then the chart should draw a polyline.
    window.app.engine.reset();
    for (let i = 0; i < 6; i++) window.app.engine.doStep();
    window.app.renderer.render();
    const linesAfter = chartEl.querySelectorAll('polyline').length;

    // Serialization round-trip.
    const d2 = new Diagram();
    d2.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
    const chartsOk = d2.charts.size === 1 && [...d2.charts.values()][0].nodeIds[0] === p.id;

    return { hasChartPanel, linesBefore, linesAfter, chartsOk };
  });
  if (p2chart.hasChartPanel && p2chart.linesBefore === 0 && p2chart.linesAfter === 1 && p2chart.chartsOk)
    ok('P2 chart: on-canvas chart tracks a node, plots a line after a run, serializes');
  else fail('P2 chart: ' + JSON.stringify(p2chart));

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
    const d = window.app.diagram;
    d.resourceTypes = [{ name: 'Gold', color: '#ffd700' }, { name: 'Wood', color: '#8d6e63' }];

    // Diagram panel shows the Resource Types editor with the type names.
    window.app.editor._select(null, null);
    const diagText = document.getElementById('props-content').textContent;
    const hasTypesEditor = diagText.includes('Resource Types') && diagText.includes('Gold')
      && diagText.includes('Totals held');

    // A pool holding gold shows the type NAME (not the hex) in its readout.
    const p = d.addNode(new MNode(NodeType.POOL, 200, 200));
    p.setCount(5, '#ffd700');
    window.app._onSelect(p.id, 'node');
    const holdings = document.getElementById('node-holdings');
    const holdingsText = holdings ? holdings.textContent : '';
    const showsGold = holdingsText.includes('Gold') && holdingsText.includes('5');

    // A source's colour field offers a resource-type dropdown.
    const s = d.addNode(new MNode(NodeType.SOURCE, 400, 200));
    window.app._onSelect(s.id, 'node');
    const hasTypeDropdown = [...document.querySelectorAll('#props-content .prop-row label')]
      .some(l => l.textContent.trim() === 'Type');

    // Live totals refresh: diagram panel + a step recomputes the per-type total.
    window.app.editor._select(null, null);
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
