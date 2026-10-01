'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const {chromium} = require('playwright-core');
const source = fs.readFileSync(path.resolve(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const styles = source.match(/<style>[\s\S]*?<\/style>/)[0];
const sidebar = source.match(/<aside\b[^>]*>[\s\S]*?<\/aside>/)[0];
const functions = ['esc', 'phaseClass', 'renderSteeringResume', 'optimizerBadgeClasses', 'optimizerReason', 'renderOptimizerStatus',
  'renderLivePanels', 'renderRecentEvents'].map(name => source.match(new RegExp('  function ' + name + '\\([\\s\\S]*?\\n  \\}'))[0]).join('\n');
const keyboard = source.match(/  document\.addEventListener\('keydown', \(event\) =>[^\n]+/)[0];

async function main() {
  const browser = await chromium.launch({headless: true,
    ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}),
    args: ['--no-sandbox']});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const viewport of [{width: 1440, height: 1080}, {width: 600, height: 900}, {width: 1440, height: 650}]) {
      await page.setViewportSize(viewport);
      await page.setContent('<!doctype html><html><head>' + styles + '</head><body class="live-presentation">' +
        sidebar + '<div id="roomPanelDivider"></div><main></main><dialog id="viewerManual"></dialog></body></html>');
      await page.addScriptTag({path: path.resolve(__dirname, '../../worlds/viewer/room-convergence.js')});
      await page.addScriptTag({content: `
        var optimizerState = null, networkState = null, healthState = {healthy: true}, profilingState = null;
        var liveMode = true, replayMode = false, liveClock = {serverMs: Date.now(), receivedMs: performance.now()};
        var selected = 'sta-01', actionState = null, verificationState = null, storyState = 'Layout regression';
        var recentEvents = [], playCalls = 0, interactiveLiveMode = true, interaction = {apiEnabled: true};
        var $ = selector => document.querySelector(selector);
        var displayRole = role => role, targetRole = () => null, togglePlay = () => { playCalls++; };
        ${functions}
        ${keyboard}
      `});
      const result = await page.evaluate(async () => {
        const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const decisions = Array.from({length: 20}, (_, index) => ({role: 'sta-' + String(index + 1).padStart(2, '0'),
          source_role: 'ext-1', target_role: 'ext-4', reason: 'minimum_dwell_not_met',
          current_rcpi: 80, association_uptime_seconds: 0, wait_remaining_seconds: 20}));
        const evaluated = {evaluated_at: new Date().toISOString(), mode: 'act', automatic_actuation: true,
          automatic_actuation_ready: true, maximum_actions: 100, subject_role: 'sta-01',
          decision: {reason: 'candidate_gain_too_small', current_rcpi: 80, target_rcpi: 82},
          candidates: Array.from({length: 4}, (_, index) => ({role: 'ext-' + (index + 1), rcpi: 80 + index})),
          fleet: {clients_checked: 20, clients_evaluated: 20, measurement_complete: true, converged: true}};
        const states = [null, evaluated,
          {...evaluated, maximum_actions: null, actions_used: 350, steering_safety: {
            enabled: true, resume_supported: true, request_limit: 300, requests_in_window: 2, window_seconds: 60,
            paused_clients: [{role: 'sta_01', reason: 'steering_failures_paused'}]}},
          {...evaluated, steering_safety: {enabled: true, request_limit: 300, requests_in_window: 300,
            window_seconds: 60, rate_retry_seconds: 20, paused_clients: []}},
          {...evaluated, progress: {kind: 'optimizer.progress', phase: 'candidate_queries',
            completed_queries: 2, total_queries: 5, selected_clients: 4, total_clients: 20}},
          {...evaluated, progress: {kind: 'optimizer.measurement.waiting', reason: 'backhaul_reconciling'}},
          {status: 'unavailable', automatic_actuation: true, retry_delay_seconds: 20, consecutive_failures: 3,
            message: 'candidate query failed for agent 00:60:2f:da:68:e4: '.repeat(40) + 'END OF ERROR'},
          {...evaluated, fleet: {roster_complete: false, missing_clients: ['missing'], unexpected_clients: ['offline']},
            unavailable_cohort_reason: 'Waiting for fresh candidate evidence. '.repeat(25) + 'END OF STATUS',
            client_decisions: decisions},
          {...evaluated, client_decisions: decisions.slice(0, 1)}, {}, evaluated,
          {...evaluated, decision: {reason: 'no_safe_band_upgrade', current_rcpi: 132},
            fleet: {...evaluated.fleet, policy: 'received-scan-band-preference-v1', band_measurements_complete: true}}];
        const sidebarElement = document.querySelector('aside');
        const samples = [];
        const check = label => {
          const sample = {label, scrollTop: sidebarElement.scrollTop};
          for (const selector of ['#optimizerCard', '#optimizerStatus', '#optimizerActivity', '#optimizerActivityDetails', '#optimizerMetrics', '#optimizerClients', '#eventRibbon', '#world', '#interactionCard']) {
            const element = document.querySelector(selector), bounds = element.getBoundingClientRect();
            sample[selector] = {top: bounds.top, height: bounds.height};
          }
          samples.push(sample);
        };
        for (const expanded of [false, true]) {
          document.querySelector('#optimizerClients').open = expanded;
          document.querySelector('#optimizerActivity').open = expanded;
          optimizerState = evaluated;
          renderLivePanels();
          document.querySelector('#optimizerCard').scrollIntoView({block: 'start'});
          await nextFrame();
          for (let cycle = 0; cycle < 3; cycle++) {
            for (const [index, state] of states.entries()) {
              optimizerState = state;
              verificationState = index % 2 ? {success: true} : null;
              recentEvents = Array.from({length: index}, (_, eventIndex) => ({world_time_ms: 0,
                recorded_at: new Date().toISOString(), label: 'Event ' + eventIndex + ': ' + 'activity '.repeat(index * 3)}));
              renderLivePanels();
              await nextFrame();
              if (state?.fleet?.policy === 'received-scan-band-preference-v1') {
                const statusText = document.querySelector('#optimizerStatus').textContent;
                if (!statusText.includes('AP and band policy') || statusText.includes('strongest measured AP')) throw new Error('band policy is incorrectly described as strongest-signal convergence');
                const badge = document.querySelector('#optimizerMetrics .phase');
                if (badge.textContent !== 'stable' || !badge.classList.contains('healthy')) throw new Error('settled band policy lacks its healthy badge');
              }
              if (document.querySelector('#optimizerActivity').open !== expanded) throw new Error('measurement details disclosure changed without user input');
              check(expanded ? 'expanded' : 'collapsed');
            }
          }
        }
        optimizerState = states.find(state => state?.status === 'unavailable');
        renderLivePanels();
        const metrics = document.querySelector('#optimizerMetrics');
        metrics.scrollTop = metrics.scrollHeight;
        await nextFrame();
        const error = {scrollTop: metrics.scrollTop, endVisible: metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 1,
          fullText: metrics.textContent.endsWith('END OF ERROR')};
        optimizerState = states.find(state => state?.unavailable_cohort_reason);
        renderLivePanels();
        const status = document.querySelector('#optimizerStatus');
        status.scrollTop = status.scrollHeight;
        const clients = document.querySelector('#optimizerClientRows');
        clients.scrollTop = clients.scrollHeight;
        await nextFrame();
        const access = {statusScrolled: status.scrollTop > 0, clientsScrolled: clients.scrollTop > 0,
          lastClient: clients.textContent.includes('sta-20'), error};
        for (const selector of ['#optimizerStatus', '#optimizerActivityDetails', '#optimizerMetrics', '#optimizerClientRows', '#eventRibbon']) {
          const element = document.querySelector(selector);
          access[selector] = {tabIndex: element.tabIndex, name: element.getAttribute('aria-label'),
            overflow: getComputedStyle(element).overflowY, gutter: getComputedStyle(element).scrollbarGutter};
        }
        const earlierHeading = status.textContent;
        optimizerState = evaluated;
        renderLivePanels();
        access.immediateUpdate = earlierHeading !== status.textContent && status.textContent.includes('Converged: all clients checked');
        return {samples, access};
      });
      for (const group of ['collapsed', 'expanded']) {
        const samples = result.samples.filter(sample => sample.label === group);
        for (const sample of samples.slice(1)) {
          assert.equal(sample.scrollTop, samples[0].scrollTop, 'sidebar scroll remains stable: ' + group);
          for (const selector of ['#optimizerCard', '#optimizerStatus', '#optimizerActivity', '#optimizerActivityDetails', '#optimizerMetrics', '#optimizerClients', '#eventRibbon', '#world', '#interactionCard']) {
            assert.deepEqual(sample[selector], samples[0][selector], selector + ' stays fixed during ' + group + ' updates');
          }
        }
      }
      assert.deepEqual(result.access.error, {scrollTop: result.access.error.scrollTop, endVisible: true, fullText: true});
      assert.ok(result.access.error.scrollTop > 0, 'long error remains scrollable, not clipped');
      assert.ok(result.access.statusScrolled && result.access.clientsScrolled && result.access.lastClient);
      assert.ok(result.access.immediateUpdate, 'layout stabilization does not defer telemetry');
      for (const selector of ['#optimizerStatus', '#optimizerActivityDetails', '#optimizerMetrics', '#optimizerClientRows', '#eventRibbon']) {
        const access = result.access[selector];
        assert.equal(access.tabIndex, 0, selector + ' is keyboard focusable');
        assert.ok(access.name, selector + ' has an accessible name');
        assert.equal(access.overflow, 'auto');
        assert.equal(access.gutter, 'stable');
        await page.locator(selector).focus();
        await page.keyboard.press('Space');
      }
      await page.locator('#optimizerClients summary').focus();
      await page.keyboard.press('Space');
      await page.locator('#optimizerActivity summary').focus();
      await page.keyboard.press('Space');
      assert.equal(await page.locator('#optimizerActivity').evaluate(element => element.open), false);
      assert.equal(await page.evaluate(() => playCalls), 0, 'scrolling/expanding details must not play the lab');
      assert.deepEqual(errors, []);
      console.log('PASS: stable sidebar during 60 updates, truthful band status, full details and keyboard access at ' + viewport.width + '×' + viewport.height);
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {console.error(error); process.exitCode = 1;});
