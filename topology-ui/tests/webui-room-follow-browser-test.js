'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2]);
const nodes = [{id: 'controller', name: 'Controller', haulTypes: [], STAList: []},
  ...['gateway', 'extender_1', 'extender_2', 'extender_3', 'extender_4'].map((role, index) => ({
    id: '00:00:00:00:00:0' + index, name: index ? 'Extender-' + (5 - index) : 'Agent-1',
    haulTypes: [{name: 'Fronthaul', ssid: 'private_ssid', BSSList: []}, {name: 'Iot', ssid: 'iot_ssid', BSSList: []}],
    STAList: index === 1 ? [{staMAC: '02:00:00:00:03:00', bssid: 'source', ssid: 'private_ssid', band: 1}] : []
  }))];
const topology = {nodes, edges: nodes.slice(1).map(node => ({from: node === nodes[1] ? 'controller' : nodes[1].id, to: node.id, band: -1}))};
const coordinates = [[10, 7], [2, 2], [18, 2], [2, 12], [18, 12]];
let sequence = 1, worldEpoch = 1, unavailable = false, layoutRequests = 0, slowMetrics = false;
let snapshotMode = 'live';
let roomActions = [];
let mutations = 0;
const errors = [];
async function run() {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport: {width: 1600, height: 1000}});
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) mutations += 1;
      if (url.pathname.startsWith('/api/')) {
        let body = {};
        if (url.pathname.endsWith('/room-layout')) {
          layoutRequests += 1;
          if (unavailable) return route.fulfill({status: 503, json: {error: 'unavailable'}});
          const now = new Date().toISOString();
          body = {schema: 'easymesh.room-layout.v1', live: true, run_id: 'test', world_epoch: worldEpoch,
            world: 'home-five-agent--test-room-' + worldEpoch,
            sequence, state: 'running', observed_at: now, network_observed_at: now, steering_actions: roomActions,
            nodes: nodes.slice(1).map((node, index) => ({device_id: node.id,
              role: index ? 'extender_' + index : 'gateway', position: coordinates[index]}))};
          if (snapshotMode === 'replay') body.live = false;
          if (snapshotMode === 'old') body.world_epoch -= 1;
          if (snapshotMode === 'stale') body.network_observed_at = new Date(Date.now() - 21000).toISOString();
          if (snapshotMode === 'malformed') body.nodes[0].position = [null, 0];
        } else if (url.pathname.endsWith('/topology')) body = topology;
        else if (url.pathname.endsWith('/devices')) body = {devices: []};
        else if (url.pathname.endsWith('/clients')) {
          if (slowMetrics) await new Promise(resolve => setTimeout(resolve, 1500));
          body = {clients: []};
        }
        return route.fulfill({json: body});
      }
      const file = path.resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/static\//, ''));
      if (!file.startsWith(root + '/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({status: 404, body: 'missing'});
      const contentType = ({'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'})[path.extname(file)] || 'application/octet-stream';
      return route.fulfill({path: file, contentType});
    });
    await page.goto('http://room-follow.test/');
    await page.waitForFunction(() => window.EasyMeshController?.refreshIntervals.topology);
    await page.evaluate(() => window.EasyMeshController.showTab('topology'));
    await page.waitForFunction(() => window.EasyMeshController.roomLayout.fresh());
    await page.waitForTimeout(300);
    const paneWidth = await page.locator('#topology-visualization').evaluate(element => element.clientWidth);
    const graphBeforeResize = await page.locator('#topology-visualization svg').elementHandle();
    const divider = await page.locator('#topologyPanelDivider').boundingBox();
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
    await page.mouse.down();
    await page.mouse.move(divider.x - 110, divider.y + divider.height / 2, {steps: 6});
    await page.mouse.up();
    await page.waitForFunction(previous => window.EasyMeshController.topologyView.width > previous + 100, paneWidth);
    assert.equal(await graphBeforeResize.evaluate(element => element.isConnected), true, 'divider rebuilt topology');
    assert.equal(await page.locator('#follow-room-layout').isChecked(), true);
    await page.locator('#topologyPanelDivider').dblclick();
    await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width === 280);
    assert.equal(await page.locator('#room-layout-status, .steering-cue-key').count(), 0);
    assert.equal(await page.locator('#topology > #topologyRoomName').count(), 0);
    assert.equal(await page.locator('#topology .page-header h1 #topologyRoomName').count(), 1);
    const headerHeight = await page.locator('#topology .page-header').evaluate(element => element.getBoundingClientRect().height);
    const nodePosition = id => page.evaluate(nodeId => {
      const node = window.EasyMeshController.topologySimulation.nodes().find(item => item.id === nodeId);
      return {x: node.x, y: node.y};
    }, id);
    const extender = nodes[2].id;
    assert.ok((await nodePosition(extender)).x < 0);
    const svg = await page.locator('#topology-visualization svg').elementHandle();
    const begun = Date.now();
    slowMetrics = true;
    coordinates[1] = [22, 16]; sequence += 1;
    await page.waitForFunction(id => window.EasyMeshController.topologySimulation.nodes().find(node => node.id === id).x > 0, extender);
    const elapsed = Date.now() - begun;
    for (const mode of ['stale', 'replay', 'old', 'malformed']) {
      const kept = await nodePosition(extender);
      snapshotMode = mode;
      await page.waitForFunction(() => !window.EasyMeshController.roomLayout.available);
      assert.match(await page.locator('#follow-room-layout').getAttribute('title'), /unavailable/);
      assert.deepEqual(await nodePosition(extender), kept, mode + ' moved the graph');
      snapshotMode = 'live';
      await page.waitForFunction(() => window.EasyMeshController.roomLayout.fresh());
    }
    assert.ok(elapsed < 1500, 'coordinate update is delayed');
    assert.equal(await svg.evaluate(element => element.isConnected), true, 'pose update rebuilt the SVG');
    assert.ok((await nodePosition(extender)).y < 0);
    slowMetrics = false;
    await page.locator('#follow-room-layout').uncheck();
    const manual = await nodePosition(extender), beforeRequests = layoutRequests;
    coordinates[1] = [-5, 2]; sequence += 1;
    await page.waitForTimeout(650);
    assert.deepEqual(await nodePosition(extender), manual);
    assert.ok(layoutRequests <= beforeRequests + 1);
    worldEpoch += 1;
    await page.waitForFunction(() => document.getElementById('topologyRoomName').textContent.endsWith('Test room 2'));
    assert.equal(await page.locator('#topology .page-header').evaluate(element => element.getBoundingClientRect().height), headerHeight);
    assert.deepEqual(await nodePosition(extender), manual, 'manual name refresh moved nodes');
    await page.locator('#follow-room-layout').check();
    await page.waitForFunction(id => window.EasyMeshController.topologySimulation.nodes().find(node => node.id === id).x < 0, extender);
    const icon = await page.locator('.nodes > .node').filter({hasText: 'Extender-4'}).locator('image').first().boundingBox();
    await page.mouse.move(icon.x + icon.width / 2, icon.y + icon.height / 2);
    await page.mouse.down();
    await page.mouse.move(icon.x + icon.width / 2 + 25, icon.y + icon.height / 2 + 15, {steps: 4});
    await page.mouse.up();
    assert.equal(await page.locator('#follow-room-layout').isChecked(), false, 'mesh dragging did not switch to manual');
    await page.locator('#follow-room-layout').check();
    unavailable = true;
    await page.waitForFunction(() => !window.EasyMeshController.roomLayout.available);
    const retained = await nodePosition(extender);
    await page.waitForTimeout(300);
    assert.deepEqual(await nodePosition(extender), retained);
    unavailable = false; worldEpoch += 1; sequence += 1;
    coordinates[1] = [25, 0];
    await page.waitForFunction(id => window.EasyMeshController.topologySimulation.nodes().find(node => node.id === id).x > 0, extender);
    await page.locator('#topologyFullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'topology');
    assert.equal(await page.locator('#follow-room-layout').isVisible(), true);
    assert.equal(await page.locator('#topologyRoomName').isVisible(), true);
    const compactHeader = await page.evaluate(() => {
      const header = document.querySelector('#topology > .page-header').getBoundingClientRect();
      const title = document.getElementById('topologyRoomName').getBoundingClientRect();
      const graph = document.querySelector('#topology .topology-container').getBoundingClientRect();
      return title.top >= header.top && title.bottom <= header.bottom && graph.top - header.bottom <= 6;
    });
    assert.equal(compactHeader, true, 'room title or explanatory text consumes a separate row');
    await page.evaluate(() => document.exitFullscreen());
    const now = new Date().toISOString();
    const station = nodes[2].STAList.pop();
    nodes[3].STAList.push({...station, bssid: 'target'});
    topology.steeringActions = [];
    await page.waitForSelector('.sta-roam-cue[data-method="unknown"]');
    const originalCue = await page.locator('.sta-roam-cue').elementHandle();
    roomActions = [{sta_mac: station.staMAC, source_bssid: 'source', target_bssid: 'target', method: 'btm-request', requested_at: now}];
    await page.waitForSelector('.sta-roam-cue[data-method="btm"]');
    assert.equal(await originalCue.evaluate(element => element.isConnected), true, 'method evidence rebuilt the SVG or reset the highlight');
    assert.match(await page.locator('.sta-roam-origin-label').textContent(), /Ext-4 →/);
    assert.equal(await page.locator('.sta-node').count(), 1, 'history duplicated the actual client');
    assert.equal(await page.locator('.sta-steer-pulse').getAttribute('stroke'), '#7c3aed');
    const currentOwner = await page.locator('.sta-node').evaluate(element => element.__data__.ownerId);
    assert.equal(currentOwner, nodes[3].id, 'animation delayed the actual association');
    if (process.env.ROOM_FOLLOW_SCREENSHOT) await page.screenshot({path: process.env.ROOM_FOLLOW_SCREENSHOT});
    await page.waitForTimeout(6250);
    assert.equal(await page.locator('.sta-roam-cue').count(), 0, 'finished pulse remained visible');
    nodes[3].STAList[0].bssid = 'next-band';
    topology.steeringActions = [{sta_mac: station.staMAC, source_bssid: 'target', target_bssid: 'next-band', method: 'non-btm', evidence: 'operator-report', requested_at: new Date().toISOString()}];
    await page.waitForSelector('.sta-roam-cue[data-method="non-btm"]');
    assert.equal(await page.locator('.sta-steer-pulse').getAttribute('stroke'), '#be185d');
    const returning = nodes[3].STAList.pop();
    nodes[2].STAList.push({...returning, bssid: 'source'});
    topology.steeringActions = [];
    await page.waitForSelector('.sta-roam-cue[data-method="unknown"]');
    assert.equal(await page.locator('.sta-steer-pulse').getAttribute('stroke'), '#64748b');
    assert.equal(mutations, 0, 'layout or animation sent an actuation request');
    assert.deepEqual(errors, []);
    console.log(`PASS: real WebUI follows in ${elapsed}ms; stable SVG, manual, failure/recovery, world changes, fullscreen, source/BTM cue and finite expiry; no writes`);
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
