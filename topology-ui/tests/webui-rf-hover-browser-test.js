'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium, selectors} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const url = process.argv[2];
const output = process.argv[3];
const expectedRows = 6;

(async () => {
  await selectors.register('rf-device', () => ({
    queryAll: (root, identity) => [...root.querySelectorAll('.nodes .node > image')]
      .filter(image => String(image.__data__?.id).toLowerCase() === identity.toLowerCase()),
    query: (root, identity) => [...root.querySelectorAll('.nodes .node > image')]
      .find(image => String(image.__data__?.id).toLowerCase() === identity.toLowerCase()) || null,
  }));
  const browser = await chromium.launch({headless: true,
    ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}),
    args: ['--no-sandbox']});
  const page = await browser.newPage({viewport: {width: 1500, height: 1100}});
  const errors = [], mutations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method())) mutations.push(request.url());
  });
  try {
    await page.goto(url, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => window.EasyMeshController?.refreshIntervals.topology);
    await page.evaluate(() => window.EasyMeshController.showTab('topology'));
    await page.waitForFunction(() => window.EasyMeshController?.roomLayout?.snapshot?.rf_observations?.bss_loads?.length >= 30,
      null, {timeout: 120000});
    await page.waitForFunction(() => document.querySelectorAll('.nodes .node > image').length >= 5);
    const snapshot = await page.evaluate(() => window.EasyMeshController.roomLayout.snapshot);
    assert.equal(snapshot.rf_observations.enabled, true);
    assert.equal(snapshot.rf_observations.policy_enabled, false);
    assert.equal(snapshot.rf_observations.error, '');
    const results = [];
    for (const node of snapshot.nodes) {
      const icon = page.locator('rf-device=' + node.device_id);
      await icon.hover();
      await page.waitForFunction(() => /[0-9]+[.][0-9]+%/.test(document.querySelector('#custom-tooltip')?.textContent || ''));
      const text = await page.locator('#custom-tooltip').innerText();
      assert.match(text, /AP-reported BSS load/);
      if (node.role.startsWith('pod_')) {
        // An OpenSync pod (EMOSA adapter) serves 2.4 GHz only: its rows are its own BSSes.
        const own = snapshot.rf_observations.bss_loads.filter(load => load.device_id === node.device_id);
        assert.ok(own.length > 0 && own.every(load => load.band === 0));
        assert.match(text, /2.4 GHz/);
        assert.doesNotMatch(text, /5 GHz|6 GHz/);
        assert.ok(await page.locator('#custom-tooltip tbody tr').count() >= own.length);
      } else {
        assert.match(text, /2.4 GHz/);
        assert.match(text, /5 GHz/);
        assert.match(text, /6 GHz/);
        assert.ok(await page.locator('#custom-tooltip tbody tr').count() >= expectedRows);
      }
      results.push({role: node.role, device_id: node.device_id, text});
    }
    await page.locator('#follow-room-layout').uncheck();
    const selectedIcon = page.locator('rf-device=' + snapshot.nodes[0].device_id);
    const deadline = Date.now() + 30000;
    let previousBounds = null, stableSince = Date.now(), settled = false;
    while (Date.now() < deadline) {
      const bounds = await selectedIcon.boundingBox();
      if (!bounds || !previousBounds || Object.keys(bounds).some(key => Math.abs(bounds[key] - previousBounds[key]) > 0.5)) {
        stableSince = Date.now();
      }
      previousBounds = bounds;
      if (bounds && Date.now() - stableSince >= 2500) { settled = true; break; }
      await page.waitForTimeout(100);
    }
    assert.ok(settled, 'AP icon did not settle after switching to manual layout');
    await selectedIcon.hover();
    await page.waitForFunction(() => /[0-9]+[.][0-9]+%/.test(document.querySelector('#custom-tooltip')?.textContent || ''));
    await page.waitForTimeout(2200);
    assert.match(await page.locator('#custom-tooltip').innerText(), /[0-9]+\.[0-9]+%/);
    if (output) await page.screenshot({path: output + '.png'});
    await page.route('**/api/v1/room-layout', async route => {
      const response = await route.fetch();
      const body = await response.json();
      for (const row of body.rf_observations.bss_loads) row.observed_at = new Date(Date.now() - 60000).toISOString();
      await route.fulfill({response, json: body});
    });
    await page.waitForFunction(() => {
      const rows = window.EasyMeshController.roomLayout.snapshot?.rf_observations?.bss_loads || [];
      const text = document.querySelector('#custom-tooltip')?.textContent || '';
      return rows.length > 0 && rows.every(row => Date.now() - Date.parse(row.observed_at) >= 60000) &&
        /stale/.test(text) && !/[0-9]+[.][0-9]+%/.test(text);
    }, null, {timeout: 15000});
    assert.doesNotMatch(await page.locator('#custom-tooltip').innerText(), /[0-9]+\.[0-9]+%/);
    await page.unroute('**/api/v1/room-layout');
    await page.route('**/api/v1/room-layout', route => route.fulfill({status: 503, json: {error: 'fixture'}}));
    await page.waitForFunction(() => /Room telemetry unavailable/.test(document.querySelector('#custom-tooltip')?.textContent || ''), null, {timeout: 15000});
    assert.doesNotMatch(await page.locator('#custom-tooltip').innerText(), /[0-9]+\.[0-9]+%/);
    await page.unroute('**/api/v1/room-layout');
    await page.locator('#follow-room-layout').check();
    assert.deepEqual(errors, []);
    assert.deepEqual(mutations, []);
    const result = {passed: true, url, nodes: results, cases: ['live load, stations and three bands',
      'stationary hover refresh', 'manual layout', 'stale telemetry hidden', 'unavailable telemetry hidden', 'GET-only']};
    if (output) fs.writeFileSync(output + '.json', JSON.stringify(result, null, 2) + '\n');
    console.log('PASS: live AP RF hover, passive collection, stationary updates and unavailable/stale handling: ' + url);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
