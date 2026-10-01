'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname,
  '../../worlds/viewer/index.html'), 'utf8');
const helpers = source.slice(source.indexOf('  function heroRole()'), source.indexOf('  function optimizerSubjectRole()'));
const events = source.slice(source.indexOf('  function applyDemoEvent('), source.indexOf('  function runStateFor('));

async function main() {
  const requests = [];
  const context = vm.createContext({
    frameTimings: null,
    world: {duration_ms: 1000, roles: {private: 'station', iot: 'station', gateway: 'fronthaul_ap'}},
    networkState: {hero: {role: 'private'}}, trafficProbeState: null, trafficState: {success: true},
    interactiveLiveMode: true, liveMode: true, liveClock: null, livePlayback: null,
    interaction: {apiEnabled: true, revision: 0}, tMs: 0, recentEvents: [],
    performance: {now: () => 100}, eventLabel: () => null,
    acquireInteractionLease: async () => true,
    sendControl: async (url, method, body) => {
      requests.push({url, method, body});
      return {revision: 1, traffic_probe: {role: body.role, selection: 1}};
    },
    displayRole: role => role, interactionMessage() {}, update() {},
  });
  vm.runInContext(helpers + events, context);
  await context.selectTrafficProbe('iot');
  assert.equal(context.heroRole(), 'iot');
  assert.equal(context.trafficState, null);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{url: '/api/demo/traffic-probe', method: 'POST', body: {role: 'iot'}}]);
  await context.selectTrafficProbe('gateway');
  assert.equal(requests.length, 1);
  context.interactiveLiveMode = false;
  await context.selectTrafficProbe('private');
  assert.equal(requests.length, 1, 'observers do not change the shared probe');
  context.interactiveLiveMode = true;
  context.acquireInteractionLease = async () => false;
  await context.selectTrafficProbe('private');
  assert.equal(context.heroRole(), 'iot');
  const event = (kind, payload) => ({kind, payload, world_time_ms: 0, recorded_at: '2026-09-07T00:00:00Z'});
  context.applyDemoEvent(event('traffic.sample', {success: true, traffic_probe: {role: 'private', selection: 0}}));
  assert.equal(context.trafficState, null, 'late samples from the previous probe are not relabelled');
  context.applyDemoEvent(event('network.snapshot', {hero: {role: 'private'}, traffic_probe: {role: 'private', selection: 0}}));
  assert.equal(context.heroRole(), 'iot', 'late network snapshots do not undo a selection');
  context.applyDemoEvent(event('traffic.sample', {success: null, status: 'offline', traffic_probe: {role: 'iot', selection: 1}}));
  assert.equal(context.trafficState.status, 'offline');
  assert.match(source, /color: 0x00bfd8/);
  assert.match(source, /n\.probeRing\.visible = hero/);
  assert.match(source, /optimizerSubject \? 0xf0ad00/);
  assert.doesNotMatch(source, /operatorToken|request\.headers\.Authorization|prompt\('Operator capability'\)/);
  console.log('PASS: shared client probe selection, read-only/auth boundaries, stale-result isolation and distinct cyan/yellow rings');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
