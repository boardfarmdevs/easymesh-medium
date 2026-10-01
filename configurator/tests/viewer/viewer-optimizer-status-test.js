'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const elements = {};
const context = {
  RoomConvergence: require('../../worlds/viewer/room-convergence.js'),
  optimizerState: {}, networkState: {mesh: {nodes: []}}, healthState: {healthy: true}, selected: 'client',
  profilingState: null, actionState: null, verificationState: null,
  interactiveLiveMode: true, interaction: {apiEnabled: true},
  liveMode: true, liveClock: {serverMs: Date.parse('2026-09-07T03:00:00Z'), receivedMs: 0},
  performance: {now: () => 0}, displayRole: role => role, targetRole: () => null,
  $: selector => elements[selector] || (elements[selector] = {}),
};
vm.createContext(context);
for (const name of ['esc', 'phaseClass', 'renderSteeringResume', 'optimizerBadgeClasses', 'optimizerReason', 'renderOptimizerStatus']) {
  vm.runInContext(html.match(new RegExp('  function ' + name + '\\([\\s\\S]*?\\n  \\}'))[0], context);
}
context.optimizerState = {fleet: {converged: true}, evaluated_at: '2026-09-07T02:59:55Z'};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Converged: all clients checked/);
context.optimizerState.fleet = {converged: true, policy: 'received-scan-band-preference-v1', band_measurements_complete: true};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /AP and band policy/);
assert.match(elements['#optimizerStatus'].innerHTML, /fresh client-received scans/);
assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /within .*strongest measured AP/);
context.optimizerState.fleet.band_measurements_complete = false;
context.renderOptimizerStatus();
assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /Converged:/);
context.optimizerState.fleet = {converged: true};
assert.match(context.optimizerReason('no_safe_band_upgrade'), /Current band meets policy/);
assert.match(context.optimizerReason('band_preference_hold_satisfied'), /Preferred band confirmed/);
assert.match(context.optimizerReason('band_waiting_for_new_scan'), /new received scan/);
assert.match(context.optimizerReason('band_measurement_direction_mismatch'), /signal directions differ/);
assert.match(context.optimizerReason('current_band_unknown'), /Blocked: current band is unknown/);
context.optimizerState.progress = {kind: 'optimizer.progress', phase: 'candidate_queries', completed_queries: 2, total_queries: 5, selected_clients: 4, total_clients: 20};
context.renderOptimizerStatus();
assert.match(elements['#optimizerActivityDetails'].textContent, /2 \/ 5 queries completed/);
assert.match(elements['#optimizerStatus'].innerHTML, /Converged:/);
const convergedSummary = elements['#optimizerStatus'].innerHTML;
for (let cycle = 0; cycle < 100; cycle++) {
  for (const phase of ['serving_snapshot', 'candidate_queries', null]) {
    context.optimizerState.progress = phase ? {kind: 'optimizer.progress', phase,
      completed_queries: cycle % 5, total_queries: 5, selected_clients: 20, total_clients: 20} : null;
    context.renderOptimizerStatus();
    assert.equal(elements['#optimizerStatus'].innerHTML, convergedSummary, 'routine collection must not replace the result');
    assert.match(elements['#optimizerActivityDetails'].textContent, phase === 'candidate_queries' ? /Measuring AP alternatives/
      : phase ? /Reading current connections/ : /Background monitoring/);
  }
}
context.optimizerState.progress = {kind: 'optimizer.progress', phase: 'candidate_queries'};
context.optimizerState.status = 'unavailable';
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Paused: measurements unavailable/);
assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /Converged:/);
assert.match(elements['#optimizerActivityDetails'].textContent, /Retrying: measuring AP alternatives/);
delete context.optimizerState.status;
context.optimizerState.progress = {kind: 'optimizer.measurement.waiting', reason: 'movement_active'};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Waiting for device movement/);
context.optimizerState.status = 'unavailable';
context.optimizerState.progress = {kind: 'optimizer.measurement.waiting', reason: 'backhaul_reconciling'};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Settling mesh backhaul before measuring client APs/);
assert.match(html, /BACKHAUL SETTLING/);
assert.ok(html.indexOf("optimizerState.progress.reason === 'backhaul_reconciling'") < html.indexOf("optimizerState.status === 'unavailable'"));
context.optimizerState = {client_decisions: [{role: 'client', reason: 'minimum_dwell_not_met', association_uptime_seconds: 0,
  wait_remaining_seconds: 20, current_rcpi: 76, source_role: 'extender_3'}]};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /1 clients waiting or blocked/);
assert.match(elements['#optimizerClientRows'].innerHTML, /association age 0 s/);
assert.match(elements['#optimizerStatus'].innerHTML, /20 s remaining at evaluation/);
context.optimizerState.client_decisions[0].reason = 'candidate_snapshot_incomplete';
context.renderOptimizerStatus();
assert.match(elements['#optimizerClientRows'].innerHTML, /Reading remaining AP alternatives for this client/);
context.optimizerState = {fleet: {converged: true}, evaluated_at: '2026-09-07T02:58:00Z'};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Last result is old/);
assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /Converged:/);
context.optimizerState.progress = {kind: 'optimizer.progress', phase: 'candidate_queries'};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Last result is old/);
for (const timestamp of ['invalid', '2026-09-07T03:01:00Z', null]) {
  context.optimizerState.evaluated_at = timestamp;
  context.renderOptimizerStatus();
  assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /Converged:/, 'unknown/future/missing age must not imply convergence');
}
context.optimizerState.evaluated_at = '2026-09-07T02:59:55Z';
context.healthState.healthy = false;
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Waiting for lab health recovery/);
context.healthState.topology_nodes = 4;
context.healthState.expected_topology_nodes = 6;
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Only 4 \/ 6 mesh nodes/);
assert.match(elements['#optimizerStatus'].innerHTML, /Missing extenders may have lost backhaul/);
assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /Converged:/);
context.healthState.healthy = true;
context.optimizerState = {evaluated_at: '2026-09-07T02:59:55Z', fleet: {converged: false},
  automatic_actuation: true, maximum_actions: 100, actions_used: 100};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Automatic steering paused: action limit reached/);
assert.match(elements['#optimizerStatus'].innerHTML, /100\/100 requests used/);
context.healthState = {healthy: false, api_active: 11, expected_online_clients: 10};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /11\/10 clients associated \(1 extra\)/);
assert.match(elements['#optimizerStatus'].innerHTML, /100\/100 requests used/);
context.healthState = {healthy: true};
context.optimizerState = {evaluated_at: '2026-09-07T02:59:55Z', fleet: {converged: true}};
for (const field of ['roster_complete', 'measurement_complete', 'converged']) {
  context.optimizerState.fleet = {converged: true, [field]: false};
  context.renderOptimizerStatus();
  assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /Converged:/, 'new incomplete results must take effect immediately');
}
context.optimizerState.fleet = {converged: true};
for (const kind of ['optimizer.environment.changed', 'observation.inconsistent_rf_epoch', 'optimizer.measurement.waiting']) {
  context.optimizerState.progress = {kind, reason: 'rf_snapshot_superseded'};
  context.renderOptimizerStatus();
  assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /Converged:/);
  assert.match(elements['#optimizerStatus'].innerHTML, /Previous decisions are not valid/);
}
assert.match(html, /optimizerState\.client_decisions = \[\]/);
context.optimizerState = {};
context.liveClock = null;
assert.doesNotThrow(() => context.renderOptimizerStatus());
context.optimizerState = {fleet: {converged: true}, evaluated_at: '2026-09-07T02:59:55Z'};
context.renderOptimizerStatus();
assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /Converged:/, 'missing live clock is not evidence of freshness');
context.liveClock = {serverMs: Date.parse('2026-09-07T03:00:00Z'), receivedMs: 0};
context.optimizerState = {evaluated_at: '2026-09-07T02:59:55Z', automatic_actuation: true,
  automatic_actuation_ready: true, actions_used: 0, maximum_actions: 100,
  decision: {reason: 'candidate_gain_too_small'}};
assert.equal(context.optimizerBadgeClasses('stable').phase, 'healthy');
context.optimizerState.decision.reason = 'no_safe_band_upgrade';
assert.equal(context.optimizerBadgeClasses('stable').phase, 'healthy');
context.optimizerState.decision.reason = 'band_waiting_for_new_scan';
assert.equal(context.optimizerBadgeClasses('stable').phase, 'waiting');
context.optimizerState.decision.reason = 'candidate_gain_too_small';
assert.equal(context.optimizerBadgeClasses('stable').mode, 'healthy');
context.optimizerState.progress = {kind: 'optimizer.progress'};
assert.equal(context.optimizerBadgeClasses('stable').mode, 'healthy');
context.optimizerState.decision.reason = 'minimum_dwell_not_met';
assert.equal(context.optimizerBadgeClasses('stable').phase, 'waiting');
context.optimizerState.actions_used = 100;
assert.equal(context.optimizerBadgeClasses('stable').mode, 'waiting');
context.optimizerState.actions_used = 0;
context.optimizerState.automatic_actuation_ready = false;
assert.equal(context.optimizerBadgeClasses('stable').mode, 'waiting');
context.optimizerState.automatic_actuation_ready = true;
context.healthState.healthy = false;
assert.equal(context.optimizerBadgeClasses('stable').mode, 'waiting');
context.healthState.healthy = true;
context.optimizerState.progress = {kind: 'optimizer.environment.changed'};
assert.equal(context.optimizerBadgeClasses('stable').phase, 'unknown');
assert.equal(context.optimizerBadgeClasses('stable').mode, 'unknown');
delete context.optimizerState.progress;
context.optimizerState.evaluated_at = '2026-09-07T02:58:00Z';
assert.equal(context.optimizerBadgeClasses('stable').phase, 'unknown');
assert.equal(context.optimizerBadgeClasses('stable').mode, 'unknown');
context.optimizerState.evaluated_at = 'invalid';
assert.equal(context.optimizerBadgeClasses('stable').mode, 'unknown');
context.optimizerState.evaluated_at = '2026-09-07T02:59:55Z';
context.optimizerState.status = 'unavailable';
assert.equal(context.optimizerBadgeClasses('stable').mode, 'unknown');
delete context.optimizerState.status;
context.optimizerState.automatic_actuation = false;
assert.equal(context.optimizerBadgeClasses('stable').mode, '');
assert.equal(context.optimizerBadgeClasses('steering').phase, 'steering');
assert.equal(context.optimizerBadgeClasses('failed').phase, 'failed');
context.liveClock = null;
assert.equal(context.optimizerBadgeClasses('stable').phase, 'unknown');
assert.match(html, /\.phase\.healthy \{ color: #fff; background: #176b48;/);
assert.match(html, /badges\.phase/);
assert.match(html, /badges\.mode/);
context.networkState = null;
context.storyState = 'Waiting for backhaul';
context.renderRecentEvents = () => {};
context.optimizerState = {status: 'unavailable', progress: {kind: 'optimizer.measurement.waiting', reason: 'backhaul_reconciling'}};
vm.runInContext(html.match(/  function renderLivePanels\([\s\S]*?\n  \}/)[0], context);
context.renderLivePanels();
assert.match(elements['#optimizerMetrics'].innerHTML, /BACKHAUL SETTLING/);
assert.doesNotMatch(elements['#optimizerMetrics'].innerHTML, /MEASUREMENTS UNAVAILABLE/);
context.optimizerState = {fleet: {roster_complete: false, missing_clients: ['missing'], unexpected_clients: ['offline']}};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Available clients continue/);
assert.match(elements['#optimizerStatus'].innerHTML, /1 unexpected\/offline clients still reported/);
context.liveClock = {serverMs: Date.parse('2026-09-07T03:00:00Z'), receivedMs: 0};
context.optimizerState = {evaluated_at: '2026-09-07T02:59:55Z', automatic_actuation: true,
  automatic_actuation_ready: true, maximum_actions: null, actions_used: 350,
  fleet: {converged: true}, steering_safety: {enabled: true, resume_supported: true,
    revision: 1, paused_clients: [], requests_in_window: 2, request_limit: 300, window_seconds: 60}};
context.renderLivePanels();
assert.match(elements['#optimizerMetrics'].innerHTML, /350 · no lifetime cap/);
assert.equal(context.optimizerBadgeClasses('stable').mode, 'healthy');
assert.equal(elements['#resumeSteering'].disabled, true);
context.optimizerState.steering_safety.paused_clients = [{role: 'sta_01'}];
context.renderLivePanels();
assert.match(elements['#optimizerStatus'].innerHTML, /Some clients paused/);
assert.equal(elements['#resumeSteering'].disabled, false);
assert.equal(context.optimizerBadgeClasses('stable').mode, 'waiting');
context.interactiveLiveMode = false;
context.renderSteeringResume();
assert.equal(elements['#resumeSteering'].disabled, true);
context.interactiveLiveMode = true;
context.optimizerState.steering_safety.paused_clients = [];
context.optimizerState.steering_safety.rate_retry_seconds = 20;
context.optimizerState.fleet.converged = false;
context.renderLivePanels();
assert.match(elements['#optimizerStatus'].innerHTML, /Waiting for the rolling request window/);
assert.equal(elements['#resumeSteering'].disabled, true);
context.profilingState = {mode: 'native-observation'};
context.renderOptimizerStatus();
assert.match(elements['#optimizerStatus'].innerHTML, /Native observation · no lab steering/);
assert.doesNotMatch(elements['#optimizerStatus'].innerHTML, /Unassisted BTM profiling/);
assert.match(elements['#optimizerClientRows'].textContent, /No external policy evaluations/);
assert.match(elements['#optimizerActivityDetails'].textContent, /collection is disabled/);
console.log('PASS: steady results across 300 background phases, detailed live progress, immediate failure/staleness/RF invalidation and badge truthfulness');
