'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const {baseline} = require('./viewer-room-convergence-test.js');
const root = path.resolve(__dirname, '../../worlds/viewer');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const stylesheet = html.match(/<style>[\s\S]*?<\/style>/)[0] + '<style>' +
  fs.readFileSync(path.join(root, 'room-convergence.css'), 'utf8') + '</style>';
const main = html.slice(html.indexOf('<main id="roomView">'), html.indexOf('  <div id="hint">')) + '</main>';
const compact = html.match(/  <div id="playConvergence"[^\n]+/)[0];

async function run() {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox']});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const viewport of [{width: 1440, height: 900}, {width: 1000, height: 700}, {width: 390, height: 844}]) {
      await page.setViewportSize(viewport);
      await page.setContent('<!doctype html><html><head>' + stylesheet + '</head><body><aside><button id="play">Play</button>' +
        compact + '</aside><div id="roomPanelDivider"></div>' + main + '</body></html>');
      await page.addScriptTag({path: path.join(root, 'room-convergence.js')});
      await page.addScriptTag({path: path.join(root, 'fullscreen-control.js')});
      const result = await page.evaluate(async baseline => {
        const card = document.getElementById('roomConvergence');
        const compact = document.getElementById('playConvergence');
        const draw = state => [card, compact].forEach(element => RoomConvergence.render(element, RoomConvergence.describe(state)));
        draw(baseline);
        let mutations = 0;
        const observer = new MutationObserver(records => { mutations += records.length; });
        observer.observe(card, {subtree: true, childList: true, attributes: true});
        for (let cycle = 0; cycle < 300; cycle++) draw({...baseline, optimizer: {...baseline.optimizer,
          progress: {kind: 'optimizer.progress', phase: 'candidate_queries', completed_queries: cycle % 5}}});
        await Promise.resolve();
        const stableMutations = mutations;
        observer.disconnect();
        const boxes = [];
        for (const changes of [{}, {moving: true}, {connection: 'disconnected'}, {fault: true}, {loading: true}, {mode: 'preview'},
          {health: {...baseline.health, healthy: false, api_active: 11, model_associated: 15, expected_model_associated: 14},
            network: {...baseline.network, health: {...baseline.network.health, clients: 11}},
            optimizer: {...baseline.optimizer, automatic_actuation: true, maximum_actions: 100, actions_used: 100}},
          {optimizer: {...baseline.optimizer, fleet: {...baseline.optimizer.fleet, converged: false},
            automatic_actuation: true, maximum_actions: 100, actions_used: 100}}, {}]) {
          draw({...baseline, ...changes});
          const bounds = card.getBoundingClientRect();
          boxes.push({x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
            fits: bounds.left >= 0 && bounds.right <= innerWidth && card.scrollWidth <= card.clientWidth && card.scrollHeight <= card.clientHeight});
        }
        EasyMeshFullscreen.attach({target: document.getElementById('roomView'),
          button: document.getElementById('roomFullscreen'), status: document.getElementById('fullscreenStatus')});
        return {stableMutations, boxes, title: card.title, compact: compact.textContent, live: card.getAttribute('aria-live')};
      }, baseline);
      assert.equal(result.stableMutations, 0, 'routine sampling must not rewrite or reannounce the badge');
      assert.ok(result.boxes.every(bounds => bounds.fits), JSON.stringify({viewport, boxes: result.boxes}));
      assert.ok(result.boxes.every(bounds => JSON.stringify(bounds) === JSON.stringify(result.boxes[0])), 'no layout jumps between states');
      assert.match(result.compact, /CONVERGED/);
      assert.match(result.title, /not optimal backhaul/);
      assert.equal(result.live, 'polite');
      await page.locator('#roomFullscreen').click();
      await page.waitForFunction(() => document.fullscreenElement?.id === 'roomView');
      assert.equal(await page.locator('#roomConvergence').isVisible(), true);
      await page.locator('#roomFullscreen').click();
      await page.waitForFunction(() => !document.fullscreenElement);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: desktop/mobile, full screen, fixed-size accessible badges and no routine-update flicker');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
