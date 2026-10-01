'use strict';
const assert = require('assert').strict;
const path = require('path');
const {describe} = require(path.resolve(__dirname, '../../worlds/viewer/room-convergence.js'));
const timestamp = '2026-09-14T21:00:00Z';
const baseline = {
  mode: 'live', connection: 'running', now: Date.parse(timestamp), environmentEpoch: 8, canPlay: true,
  optimizer: {evaluated_at: timestamp, expected_online_clients: 10, environment_epoch: 8,
    fleet: {converged: true, clients_checked: 10, roster_complete: true, measurement_complete: true}},
  network: {observed_at: timestamp, health: {mesh_devices: 5, clients: 10}},
  health: {observed_at: timestamp, healthy: true, expected_online_clients: 10, api_active: 10,
    expected_topology_nodes: 6, topology_nodes: 6, complete_nodes: 6},
};
const sample = () => JSON.parse(JSON.stringify(baseline));
const unlimited = sample();
Object.assign(unlimited.optimizer, {automatic_actuation: true, maximum_actions: null, actions_used: 350});
assert.equal(describe(unlimited).state, 'ready');
unlimited.optimizer.steering_safety = {paused_clients: [{role: 'sta_01'}]};
assert.equal(describe(unlimited).title, 'CLIENTS PAUSED');
assert.match(describe(unlimited).detail, /Others continue.*Resume steering/);
unlimited.optimizer.steering_safety = {paused_clients: [], rate_retry_seconds: 20, requests_in_window: 300,
  request_limit: 300, window_seconds: 60};
assert.equal(describe(unlimited).state, 'ready');
unlimited.optimizer.fleet.converged = false;
assert.equal(describe(unlimited).title, 'RATE LIMITED');
const {withSafety} = require('../../worlds/viewer/room-convergence.js');
const resumed = {steering_safety: {revision: 3, paused_clients: []}};
assert.equal(withSafety(resumed, {steering_safety: {revision: 2}}).steering_safety, resumed.steering_safety);
assert.equal(withSafety(resumed, {}).steering_safety, resumed.steering_safety);
assert.equal(withSafety(resumed, {steering_safety: {revision: 4}}).steering_safety.revision, 4);
assert.equal(describe(baseline).state, 'ready');
const prpl = sample();
Object.assign(prpl.health, {expected_topology_nodes: 5, expected_mesh_devices: 5, topology_nodes: 5, complete_nodes: 5});
assert.equal(describe(prpl).state, 'ready', 'prpl reports physical mesh nodes without the separate controller icon');
prpl.network.health.mesh_devices = 4;
assert.equal(describe(prpl).state, 'blocked');
assert.match(describe(baseline).summary, /10\/10 checked · 10\/10 online · 6\/6 mesh/);
for (const total of [0, 12, 20, 50, 100]) {
  const input = sample();
  input.optimizer.expected_online_clients = input.optimizer.fleet.clients_checked = total;
  input.health.expected_online_clients = input.health.api_active = input.network.health.clients = total;
  assert.equal(describe(input).state, 'ready');
  assert.match(describe(input).summary, new RegExp(total + '/' + total));
}
for (let cycle = 0; cycle < 100; cycle++) {
  for (const phase of ['serving_snapshot', 'candidate_queries', 'serving_metrics']) {
    const input = sample();
    input.optimizer.progress = {kind: 'optimizer.progress', phase, completed_queries: cycle % 5};
    assert.deepEqual(describe(input), describe(baseline), 'routine reads cannot flash the result');
  }
}
for (const [field, value, state] of [
  ['mode', 'preview', 'unknown'], ['mode', 'replay', 'unknown'], ['connection', 'disconnected', 'unknown'],
  ['connection', 'connecting', 'unknown'], ['connection', 'failed', 'blocked'], ['fault', true, 'blocked'],
  ['nativeObservation', true, 'unknown'], ['moving', true, 'working'], ['loading', true, 'working'],
  ['environmentEpoch', 9, 'working'], ['now', baseline.now + 60001, 'unknown'],
]) assert.equal(describe({...baseline, [field]: value}).state, state, field);
for (const section of ['optimizer', 'network', 'health']) {
  const field = section === 'optimizer' ? 'evaluated_at' : 'observed_at';
  for (const value of [null, 'invalid', '2026-09-14T20:58:00Z', '2026-09-14T21:01:00Z']) {
    const input = sample();
    input[section][field] = value;
    assert.notEqual(describe(input).state, 'ready', section + ' freshness');
  }
  const input = sample();
  input[section] = null;
  assert.notEqual(describe(input).state, 'ready');
}
for (const field of ['converged', 'roster_complete', 'measurement_complete', 'band_measurements_complete']) {
  const input = sample();
  input.optimizer.fleet[field] = false;
  assert.notEqual(describe(input).state, 'ready', field);
}
for (const field of ['converged', 'roster_complete', 'measurement_complete']) {
  const input = sample();
  delete input.optimizer.fleet[field];
  assert.notEqual(describe(input).state, 'ready', field + ' missing');
}
for (const field of ['clients_checked', 'expected_online_clients']) {
  const input = sample();
  if (field === 'clients_checked') input.optimizer.fleet[field] = 9;
  else input.optimizer[field] = 12;
  assert.notEqual(describe(input).state, 'ready');
}
const incomplete = sample();
incomplete.health.topology_nodes = 4;
assert.equal(describe(incomplete).title, 'MESH INCOMPLETE');
incomplete.health.topology_nodes = 6;
incomplete.network.health.mesh_devices = 3;
assert.equal(describe(incomplete).title, 'MESH INCOMPLETE', 'live missing nodes override cached green health');
const changed = sample();
changed.optimizer.progress = {kind: 'optimizer.environment.changed'};
assert.equal(describe(changed).title, 'SETTLING');
changed.optimizer.progress = null;
changed.optimizer.status = 'unavailable';
assert.equal(describe(changed).title, 'METRICS UNAVAILABLE');
const pending = sample();
pending.optimizer.client_decisions = [{reason: 'steer_pending'}];
assert.equal(describe(pending).state, 'working');
const band = sample();
band.optimizer.fleet.policy = 'received-scan-band-preference-v1';
assert.notEqual(describe(band).state, 'ready');
band.optimizer.fleet.band_measurements_complete = true;
assert.equal(describe(band).state, 'ready');
assert.match(describe(band).detail, /policy satisfied/);
assert.match(describe({...baseline, checkpoint: true}).detail, /continue Play/);
assert.match(describe({...baseline, canPlay: false}).detail, /Monitoring continues/);
const exhausted = sample();
Object.assign(exhausted.optimizer, {automatic_actuation: true, actions_used: 100, maximum_actions: 100});
assert.equal(describe(exhausted).state, 'ready', 'a satisfied policy is not invalidated by an unused action budget');
exhausted.optimizer.fleet.converged = false;
assert.equal(describe(exhausted).title, 'STEERING PAUSED');
assert.match(describe(exhausted).detail, /100\/100 requests used/);
const extra = sample();
Object.assign(extra.health, {healthy: false, api_active: 11, model_associated: 15, expected_model_associated: 14});
extra.network.health.clients = 11;
assert.match(describe(extra).summary, /10\/10 checked · 11\/10 online/);
assert.match(describe(extra).detail, /11\/10 clients associated \(1 extra\)/);
assert.match(describe(extra).detail, /Model associations: 15\/14/);
assert.equal(describe(extra).title, 'LAB NOT READY');
Object.assign(extra.optimizer, {automatic_actuation: true, maximum_actions: 100, actions_used: 100});
assert.match(describe(extra).detail, /100\/100 requests used/);
extra.health.api_active = 9;
assert.match(describe(extra).detail, /9\/10 clients associated \(1 missing\)/);
extra.health = {...baseline.health, healthy: false, complete_nodes: 5};
assert.match(describe(extra).detail, /Complete mesh nodes: 5\/6/);
console.log('PASS: continuous convergence, stable reads, current RF, exact room counts, stale/failed/moving states and policy limits');
module.exports = {baseline};
