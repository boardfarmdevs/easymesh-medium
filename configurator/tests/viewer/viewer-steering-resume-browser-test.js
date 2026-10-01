'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const {chromium} = require('playwright-core');
const source = fs.readFileSync(path.resolve(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const functions = ['esc', 'interactionMessage', 'newCommandId', 'apiJson', 'acquireInteractionLease',
  'sendControl', 'renderSteeringResume', 'resumeSteering'].map(name =>
  source.match(new RegExp('  (?:async )?function ' + name + '\\([\\s\\S]*?\\n  \\}'))[0]).join('\n');

async function main() {
  const browser = await chromium.launch({headless: true,
    ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}),
    args: ['--no-sandbox']});
  try {
    const page = await browser.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    const safety = {enabled: true, resume_supported: true, revision: 7, pause_revision: 2,
      paused_clients: [{role: 'sta_01'}], requests_in_window: 3, total_requests: 350};
    let rejectResume = false;
    await page.route('http://room.test/**', async route => {
      const request = route.request(), routePath = new URL(request.url()).pathname;
      const body = request.postDataJSON();
      requests.push({path: routePath, method: request.method(), body, headers: request.headers()});
      if (routePath === '/') return route.fulfill({contentType: 'text/html',
        body: '<button id="resumeSteering" disabled>Resume steering</button><div id="interactionSummary"></div>'});
      let response;
      if (routePath === '/api/demo/interactions/lease') response = {
        token: 'test-lease', revision: 4, lease_seconds: 30};
      else if (routePath === '/api/demo/optimizer/safety') response = safety;
      else if (routePath === '/api/demo/optimizer/resume') {
        if (rejectResume) return route.fulfill({status: 409, contentType: 'application/json',
          body: JSON.stringify({error: 'steering_safety_changed', message: 'Review the changed pause'})});
        response = {revision: 4, steering_safety: {...safety, revision: 8, pause_revision: 3, paused_clients: []}};
      } else throw new Error('Unexpected control: ' + routePath);
      return route.fulfill({contentType: 'application/json', body: JSON.stringify(response)});
    });
    await page.goto('http://room.test/');
    await page.addScriptTag({path: path.resolve(__dirname, '../../worlds/viewer/room-convergence.js')});
    await page.addScriptTag({content: `
      var interactiveLiveMode = true, world = {name: 'unchanged'};
      var optimizerState = {steering_safety: ${JSON.stringify(safety)}};
      var interaction = {apiEnabled: true, revision: 4, clientSequence: 0, acknowledgedSequence: 0,
        requestChain: Promise.resolve(), leaseToken: null, resumingSteering: false};
      var main = document.body, $ = selector => document.querySelector(selector);
      var update = () => {}, renderLivePanels = () => {};
      ${functions}
      $('#resumeSteering').addEventListener('click', resumeSteering);
      renderSteeringResume();
    `});
    await page.getByRole('button', {name: 'Resume steering'}).click();
    await page.waitForFunction(() => !interaction.resumingSteering && optimizerState.steering_safety.revision === 8);
    assert.equal(await page.locator('#resumeSteering').isDisabled(), true);
    const submitted = requests.find(request => request.path.endsWith('/resume'));
    assert.equal(submitted.method, 'POST');
    assert.equal(submitted.headers['if-match'], '"world-revision-4"');
    assert.equal(submitted.body.expected_pause_revision, 2);
    assert.equal(submitted.body.token, 'test-lease');
    assert.ok(submitted.body.command_id.length >= 8);
    assert.deepEqual(await page.evaluate(() => ({
      world, revision: interaction.revision, total: optimizerState.steering_safety.total_requests,
      window: optimizerState.steering_safety.requests_in_window,
    })), {world: {name: 'unchanged'}, revision: 4, total: 350, window: 3});
    assert.equal(requests.filter(request => request.path.endsWith('/resume')).length, 1);
    rejectResume = true;
    await page.evaluate(status => {
      optimizerState.steering_safety = status;
      renderSteeringResume();
    }, safety);
    await page.locator('#resumeSteering').click();
    await page.waitForFunction(() => !interaction.resumingSteering && document.querySelector('#interactionSummary').textContent.includes('Review'));
    assert.equal(await page.locator('#resumeSteering').isDisabled(), false);
    assert.equal(requests.filter(request => request.path.endsWith('/resume')).length, 2, 'a changed guard is not retried automatically');
    for (const mode of ['preview', 'observer', 'fault']) {
      await page.evaluate(mode => {
        interactiveLiveMode = mode !== 'preview';
        interaction.apiEnabled = mode !== 'observer';
        interaction.fault = mode === 'fault' ? 'fault' : null;
        renderSteeringResume();
      }, mode);
      assert.equal(await page.locator('#resumeSteering').isDisabled(), true);
    }
    assert.equal(requests.filter(request => /world|playback|roles/.test(request.path)).length, 0);
    assert.deepEqual(errors, []);
    console.log('PASS: Resume click, lease/revision fencing, no world/RF/playback writes, unchanged counters, stale guard and read-only controls');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
