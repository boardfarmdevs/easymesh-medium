'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../../worlds/viewer');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const context = {liveMode: true, replayMode: false, performance: {now: () => 500},
  liveClock: {serverMs: Date.parse('2026-09-07T05:00:00Z'), receivedMs: 500},
  signalMeter: require(path.join(root, 'signal-meter.js'))};
vm.createContext(context);
for (const name of ['signalLevel', 'extenderSignal', 'extenderRfLabel']) {
  vm.runInContext(html.match(new RegExp('  function ' + name + '\\([\\s\\S]*?\\n  \\}'))[0], context);
}
const edge = {signal: {status: 'fresh', rssi_dbm: -67, observed_at: '2026-09-07T04:59:52Z'},
  applied_rf: {snr_db: 24, source: 'wmediumd_verified_applied_rf'}};
assert.equal(context.signalLevel(context.extenderSignal(edge)), context.signalMeter.rssiLevel(-67));
assert.equal(context.extenderRfLabel(edge), 'RF 24 dB');
assert.equal(context.extenderRfLabel({}), 'RF —');
assert.equal(context.extenderRfLabel({applied_rf: {snr_db: 60, source: 'preview'}}), 'RF —');
assert.equal(context.signalLevel(context.extenderSignal({...edge, signal: {...edge.signal, status: 'stale'}})), 0);
context.liveClock.serverMs += 21000;
assert.equal(context.signalLevel(context.extenderSignal(edge)), 0, 'stale measured RSSI must not use applied SNR as fallback');
assert.match(html, /if \(role !== 'gateway'\) \{\s+gauge = makeSignalGauge\(\)/);
assert.match(html, /n.gauge.group.visible = n.ap \|\| present/);
assert.match(html, /n.ap \? actualBackhaulFor\(role\) : null/);
console.log('PASS: extender uplink bars, measured/applied separation, freshness, unknown values and fronthaul independence');
