const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { localStorage.setItem('sim_seen_welcome', '1'); } catch {} });
  const page = await ctx.newPage();
  await page.goto('http://localhost:8080/');
  await page.waitForFunction(() => window.app && window.app.diagram);
  await page.waitForTimeout(500);

  // (a) empty boot state
  await page.screenshot({ path: '/tmp/screen_a_boot.png', fullPage: false });

  // (b) Open Library modal
  await page.click('#btn-library');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/screen_b_library.png', fullPage: false });
  await page.click('#lib-close');
  await page.waitForTimeout(200);

  // (c) Open File menu
  await page.click('#btn-file-menu');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_c_file_menu.png', fullPage: false });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // (d) Open Help modal
  await page.click('#btn-help');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/screen_d_help.png', fullPage: false });
  await page.click('#help-close');
  await page.waitForTimeout(200);

  // (e) Place a Pool node on the canvas, then select it
  await page.click('[data-tool="place-pool"]');
  await page.waitForTimeout(100);
  const canvas = await page.$('#canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/screen_e_pool_selected.png', fullPage: false });

  // (f) Place a Source node
  await page.click('[data-tool="place-source"]');
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.width/2 - 150, box.y + box.height/2);
  await page.waitForTimeout(400);

  // (g) Right-click context menu on pool
  await page.click('[data-tool="select"]');
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
  await page.waitForTimeout(200);
  await page.mouse.click(box.x + box.width/2, box.y + box.height/2, { button: 'right' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/screen_g_ctx_menu.png', fullPage: false });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // (h) Open Monte Carlo modal
  await page.click('#btn-analysis-menu');
  await page.waitForTimeout(200);
  await page.click('#btn-batch');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/screen_h_monte_carlo.png', fullPage: false });
  await page.click('#mc-close');
  await page.waitForTimeout(200);

  // (i) View menu
  await page.click('#btn-view-menu');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_i_view_menu.png', fullPage: false });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // (j) Click "Time" rail button to show diagram-level props
  await page.click('[data-feature="time"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_j_time_rail.png', fullPage: false });

  // (k) Click "Vars" rail button
  await page.click('[data-feature="vars"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_k_vars_rail.png', fullPage: false });

  // (l) Click "Params" rail button
  await page.click('[data-feature="params"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_l_params_rail.png', fullPage: false });

  // (m) Click "Player" rail button
  await page.click('[data-feature="player"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_m_player_rail.png', fullPage: false });

  // (n) Select source node for props
  await page.click('[data-tool="select"]');
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.width/2 - 150, box.y + box.height/2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_n_source_props.png', fullPage: false });

  // (o) Welcome modal - force show via DOM
  await page.evaluate(() => {
    document.getElementById('welcome-overlay').classList.remove('hidden');
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/screen_o_welcome.png', fullPage: false });
  await page.click('#welcome-close');
  await page.waitForTimeout(200);

  // (p) Guard modal - force show
  await page.evaluate(() => {
    document.getElementById('guard-overlay').classList.remove('hidden');
    document.getElementById('guard-message').textContent = 'You have unsaved changes. Discard them and start a new diagram?';
    document.getElementById('guard-title-text').textContent = 'Start new diagram?';
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_p_guard.png', fullPage: false });
  await page.click('#guard-cancel');
  await page.waitForTimeout(200);

  // (q) Topbar close-up
  await page.screenshot({ path: '/tmp/screen_q_topbar.png', clip: { x: 0, y: 0, width: 1440, height: 52 } });

  // (r) Palette close-up
  await page.screenshot({ path: '/tmp/screen_r_palette.png', clip: { x: 0, y: 48, width: 80, height: 852 } });

  // (s) Right props panel + rail close-up with pool selected
  await page.click('[data-tool="select"]');
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_s_props_panel.png', clip: { x: 1100, y: 48, width: 340, height: 852 } });

  await browser.close();
  console.log('All screenshots captured successfully!');
})();
