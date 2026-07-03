#!/usr/bin/env node
// Browser export test: loads the real app in headless Chromium, loads the
// built-in demo, and triggers the SVG/PNG exports through the real code paths
// (download clicks are intercepted). Asserts the exported SVG is a standalone
// file (width/height/viewBox from the content bounds, no unresolved CSS
// variables) and the PNG rasterizes at the diagram's natural size with actual
// diagram content, not the stretched 300x150 slice the old code produced.
//
// Requires the app to be served (default http://localhost:8080) and Playwright.
// Run:  NODE_PATH=$(npm root -g) node test/export.js
'use strict';

const { chromium } = require('playwright');
const URL_ = process.env.SMOKE_URL || 'http://localhost:8080/';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.addInitScript(() => { try { localStorage.setItem('sim_seen_welcome', '1'); } catch (e) {} });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
  const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

  await page.goto(URL_, { waitUntil: 'networkidle' });

  // Load the demo and intercept the download anchors: keep the blob around and
  // record { download, href } instead of actually clicking.
  await page.evaluate(() => {
    window.app._loadDemo();
    window.__downloads = [];
    window.__blobs = {};
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const u = orig(blob); window.__blobs[u] = blob; return u; };
    HTMLAnchorElement.prototype.click = function () {
      window.__downloads.push({ download: this.download, href: this.href });
    };
  });

  // Expected geometry: content bounds + the 40px export padding, like the code.
  const expect = await page.evaluate(() => {
    const box = window.app.renderer._contentBounds();
    const pad = 40;
    return {
      x: Math.floor(box.minX - pad), y: Math.floor(box.minY - pad),
      w: Math.ceil(box.maxX - box.minX) + pad * 2,
      h: Math.ceil(box.maxY - box.minY) + pad * 2,
      nodes: window.app.diagram.nodes.size,
    };
  });
  if (expect.nodes > 0) ok(`demo loaded (${expect.nodes} nodes, content ${expect.w}x${expect.h})`);
  else fail('demo did not load');

  // ── SVG export ────────────────────────────────────────────────────────────
  const svgRes = await page.evaluate(async () => {
    window.app._exportSVG();
    const dl = window.__downloads.find(d => d.download.endsWith('.svg'));
    if (!dl) return { err: 'no .svg download captured' };
    const text = await window.__blobs[dl.href].text();
    const attr = (n) => (text.match(new RegExp(`<svg[^>]*\\b${n}="([^"]*)"`)) || [])[1];
    return {
      name: dl.download,
      width: attr('width'), height: attr('height'), viewBox: attr('viewBox'),
      hasVarFont: text.includes('var(--font)'), hasVar: text.includes('var('),
      hasHandles: /conn-handles|resize-handle|chart-hover|conn-hitbox/.test(text),
      hasStyle: text.includes('<style>'), hasInter: text.includes('Inter'),
    };
  });
  if (svgRes.err) fail(svgRes.err);
  else {
    const vb = `${expect.x} ${expect.y} ${expect.w} ${expect.h}`;
    if (svgRes.width === String(expect.w) && svgRes.height === String(expect.h) && svgRes.viewBox === vb)
      ok(`SVG sized to content: width=${svgRes.width} height=${svgRes.height} viewBox="${svgRes.viewBox}"`);
    else fail(`SVG size wrong: width=${svgRes.width} height=${svgRes.height} viewBox=${svgRes.viewBox}, expected ${vb}`);
    if (!svgRes.hasVarFont && !svgRes.hasVar) ok('SVG contains no unresolved var(...) references');
    else fail('SVG still contains var(...) references');
    if (svgRes.hasStyle && svgRes.hasInter) ok('SVG embeds label styles with the resolved font stack');
    else fail(`SVG styling missing: style=${svgRes.hasStyle} font=${svgRes.hasInter}`);
    if (!svgRes.hasHandles) ok('SVG carries no editing chrome (handles/hitboxes/hover)');
    else fail('SVG still contains editing chrome');
  }

  // ── PNG export ────────────────────────────────────────────────────────────
  const pngRes = await page.evaluate(async (exp) => {
    window.app._exportPNG();
    let dl, guard = 0;
    while (!(dl = window.__downloads.find(d => d.download.endsWith('.png'))) && guard++ < 200)
      await new Promise(r => setTimeout(r, 25));
    if (!dl) return { err: 'no .png download captured (image never loaded?)' };
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dl.href; });

    // Sample pixels: every node centre area must contain something that is not
    // the canvas background, and a corner of the padding must BE the background.
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const bgRGB = [0x0f, 0x11, 0x17]; // #0f1117
    const isBg = (px) => Math.abs(px[0] - bgRGB[0]) + Math.abs(px[1] - bgRGB[1]) + Math.abs(px[2] - bgRGB[2]) < 24;
    const hasInk = (x, y) => { // any clearly non-background pixel in a 40px box
      const d = ctx.getImageData(Math.max(0, x - 20), Math.max(0, y - 20), 40, 40).data;
      for (let i = 0; i < d.length; i += 4) if (!isBg([d[i], d[i + 1], d[i + 2]])) return true;
      return false;
    };
    let nodesWithInk = 0, nodesTotal = 0;
    for (const n of window.app.diagram.nodes.values()) {
      nodesTotal++;
      if (hasInk((n.x - exp.x) * 2, (n.y - exp.y) * 2)) nodesWithInk++;
    }
    const corner = ctx.getImageData(2, 2, 1, 1).data;
    return {
      w: img.naturalWidth, h: img.naturalHeight,
      nodesWithInk, nodesTotal, cornerIsBg: isBg(corner),
    };
  }, expect);
  if (pngRes.err) fail(pngRes.err);
  else {
    if (pngRes.w === expect.w * 2 && pngRes.h === expect.h * 2)
      ok(`PNG decodes at 2x content size: ${pngRes.w}x${pngRes.h} (content ${expect.w}x${expect.h})`);
    else fail(`PNG size wrong: ${pngRes.w}x${pngRes.h}, expected ${expect.w * 2}x${expect.h * 2}`);
    if (pngRes.nodesWithInk === pngRes.nodesTotal)
      ok(`PNG content check: all ${pngRes.nodesTotal} node positions have non-background pixels`);
    else fail(`PNG content check: only ${pngRes.nodesWithInk}/${pngRes.nodesTotal} node positions drawn`);
    if (pngRes.cornerIsBg) ok('PNG padding corner is the canvas background color');
    else fail('PNG corner is not the canvas background');
  }

  // ── Empty canvas is refused with a toast, not a broken file ──────────────
  const empty = await page.evaluate(() => {
    window.app._clearAll();
    const before = window.__downloads.length;
    window.app._exportSVG();
    return { downloads: window.__downloads.length - before,
      toast: document.getElementById('app-toast').textContent };
  });
  if (empty.downloads === 0 && /Nothing to export/.test(empty.toast))
    ok('empty canvas: export refused with a toast');
  else fail('empty canvas export: ' + JSON.stringify(empty));

  if (errors.length) { fail(`console/page errors:\n    ${errors.join('\n    ')}`); }
  else ok('no console or page errors');

  await browser.close();
  console.log(process.exitCode ? '\nexport test FAILED' : '\nexport test passed');
})().catch(e => { console.error(e); process.exit(1); });
