const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { localStorage.setItem('sim_seen_welcome', '1'); } catch {} });
  const page = await ctx.newPage();
  await page.goto('http://localhost:8080/');
  await page.waitForFunction(() => window.app && window.app.diagram);
  await page.waitForTimeout(500);

  // place a pool
  await page.click('[data-tool="place-pool"]');
  await page.waitForTimeout(100);
  const canvas = await page.$('#canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
  await page.waitForTimeout(400);

  // select tool + select pool -> shows props
  // auto-selected after placement, just take screenshot
  await page.screenshot({ path: '/tmp/screen_s_props_panel.png', clip: { x: 1100, y: 48, width: 340, height: 852 } });

  // Place source node too
  await page.click('[data-tool="place-source"]');
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.width/2 - 200, box.y + box.height/2);
  await page.waitForTimeout(400);

  // Now capture the source node props
  await page.screenshot({ path: '/tmp/screen_t_source_props.png', clip: { x: 1100, y: 48, width: 340, height: 852 } });

  // Go back to select and select pool
  await page.click('[data-tool="select"]');
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_u_pool_props_full.png', fullPage: false });

  // Place a gate node and select it
  await page.click('[data-tool="place-gate"]');
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.width/2 + 200, box.y + box.height/2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/screen_v_gate_props.png', clip: { x: 1100, y: 48, width: 340, height: 852 } });

  // Place a register node
  await page.click('[data-tool="place-register"]');
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.width/2, box.y + box.height/2 + 150);
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/screen_w_register_props.png', clip: { x: 1100, y: 48, width: 340, height: 852 } });

  // Screenshot of diagram rail
  await page.screenshot({ path: '/tmp/screen_x_diagram_rail.png', clip: { x: 1376, y: 48, width: 64, height: 852 } });

  // Screenshot of topbar - zoomed in on file controls area
  await page.screenshot({ path: '/tmp/screen_y_file_controls.png', clip: { x: 1100, y: 0, width: 340, height: 52 } });

  // Connect source to pool with resource connection
  await page.click('[data-tool="connect-resource"]');
  await page.waitForTimeout(100);
  // drag from source area to pool area
  await page.mouse.move(box.x + box.width/2 - 200, box.y + box.height/2);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(400);
  // select the connection
  await page.click('[data-tool="select"]');
  await page.waitForTimeout(100);
  await page.screenshot({ path: '/tmp/screen_z_connected.png', fullPage: false });

  // Click on the connection to select it (midpoint)
  await page.mouse.click(box.x + box.width/2 - 100, box.y + box.height/2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/screen_z2_conn_props.png', clip: { x: 1100, y: 48, width: 340, height: 852 } });

  await browser.close();
  console.log('Done!');
})();
