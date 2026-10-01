'use strict';
const assert = require('node:assert/strict');
const {describe, render} = require('../../worlds/viewer/rf-inspector.js');
const now = Date.parse('2026-09-14T12:00:00Z');
const observation = {role: 'gateway', bssid: 'ap', radio_id: 'radio', channel: 36, utilization: 0,
  station_count: 0, observed_at: new Date(now - 100).toISOString(), source: 'native_ap_metrics',
  transport: 'ieee1905-ethernet', epoch: 'provider-1'};
const input = {now, selected: 'gateway', view: 'native',
  optimizer: {rf_observations: {enabled: true, maximum_age_seconds: 5, bss_loads: [observation]}}};
assert.match(describe(input), /Utilization \(0–255\): 0 · received/);
assert.match(describe(input), /Associated stations: 0 · received/);
assert.match(describe(input), /Sample window: unknown/);
const configured = {...input, observations: {...input.optimizer.rf_observations,
  schema: 'easymesh.rf-inspection.v2', policy_enabled: true, counter_guard_enabled: true}};
assert.match(describe(configured), /Native counter guard: configured for load balancing; weak-signal rescue bypasses it/);
assert.match(describe({...configured, observations: {...configured.observations, counter_guard_enabled: false}}),
  /Native counter guard: not enabled; counters remain available for inspection/);
assert.match(describe({...input, now: now + 6000}), /Utilization \(0–255\): — unavailable\/stale/);
for (const changes of [{utilization: null}, {utilization: 256}, {utilization: -1},
  {utilization: true}, {utilization: '0'}, {source: 'fixture'}, {transport: 'unknown'},
  {observed_at: new Date(now + 1000).toISOString()}]) {
  assert.match(describe({...input, observations: {...input.optimizer.rf_observations,
    bss_loads: [{...observation, ...changes}]}}), /Utilization \(0–255\): — unavailable\/stale/);
}
assert.match(describe({...input, observations: {...input.optimizer.rf_observations, error: 'closed'}}),
  /Utilization \(0–255\): — unavailable\/stale/);
assert.doesNotMatch(describe({...input, selected: 'other'}), /BSSID ap/);
const pathInput = {...input, selected: 'extender_1', observations: {backhaul: {paths: [
  {role: 'extender_1', state: 'valid', observed_at: observation.observed_at, path: ['extender_1', 'gateway'],
    wireless_hops: 1, links: [{role: 'extender_1', parent_role: 'gateway', frequency_mhz: 5180,
      signal: {state: 'valid', value: -40, unit: 'dBm', observed_at: observation.observed_at}}]}]}}};
assert.match(describe(pathInput), /Native path: extender_1 → gateway/);
assert.match(describe(pathInput), /Native signal: -40 dBm/);
assert.doesNotMatch(describe({...pathInput, now: now + 6000}), /-40 dBm/);
assert.match(describe({...pathInput, now: now + 6000}), /Native path: — unavailable\/stale/);
assert.match(describe({...input, optimizer: {}, world: {utilization: 255}}), /collector unavailable/);
const received = {...input, selected: 'client', optimizer: {client_decisions: [
  {role: 'client', sta_mac: 'client-mac', current_rcpi: 120,
    metric_observed_at: new Date(now - 100).toISOString(), measurement_source: 'client_nl80211_received_scan'}],
  band_steering: {'client-mac': {
  source: 'client_nl80211_received_scan', available: true, scan_id: 'scan-1',
  observed_at: new Date(now - 100).toISOString(), neighbors: [
    {bssid: 'neighbor-zero', role: 'gateway', frequency_mhz: 5180, rcpi: 120, observed_at: new Date(now - 100).toISOString(),
      advertised_bss_load: {state: 'available', utilization: 0, station_count: 0, admission_capacity: 0}},
    {bssid: 'neighbor-missing', frequency_mhz: 5220, rcpi: 100, observed_at: new Date(now - 100).toISOString(),
      advertised_bss_load: {state: 'unavailable'}},
  ]}}, rf_observations: {enabled: true, maximum_age_seconds: 5, bss_loads: [],
    client_activity: [{sta_mac: 'client-mac', packets_per_second: 20, bytes_per_second: 125000,
      retries_per_second: 1.5, errors_per_second: 0, tx_errors_per_second: 0, rx_errors_per_second: 0, interval_seconds: 1,
      observed_at: new Date(now - 100).toISOString()}]}},
  network: {clients: [{role: 'client', connected_bssid: 'serving'}]}};
assert.match(describe(received), /Advertised BSS Load: 0\/255 · 0 stations · admission 0 ×32 µs/);
assert.match(describe(received), /Advertised BSS Load: unavailable/);
assert.match(describe(received), /Byte activity: 1.000 Mbit\/s/);
assert.match(describe(received), /AP TX retries\/s: 1.500 · received/);
assert.match(describe(received), /AP TX failures\/s: 0.000 · received/);
assert.match(describe(received), /AP RX drops\/s: 0.000 · received/);
assert.match(describe({...received, now: now + 6000}), /Byte activity: — unavailable\/stale/);
assert.match(describe({...received, now: now + 6000}), /AP TX retries\/s: — unavailable\/stale/);
const apReceived = {...received, selected: 'gateway'};
assert.match(describe(apReceived), /LOCAL AP METRICS/);
assert.match(describe(apReceived), /RECEIVED BSS LOAD/);
assert.match(describe(apReceived), /neighbor-zero \(gateway\) · channel 36 · 5180 MHz/);
assert.match(describe(apReceived), /receiver client-mac/);
assert.doesNotMatch(describe(apReceived), /neighbor-missing/);
assert.match(describe(apReceived), /Scan: scan-1 · received 0.1 s ago/);
assert.doesNotMatch(describe({...apReceived, now: now + 2100}), /Advertised BSS Load: 0\/255/);
for (const field of ['source', 'available']) {
  const invalid = JSON.parse(JSON.stringify(apReceived));
  invalid.optimizer.band_steering['client-mac'][field] = field === 'source' ? 'geometry' : false;
  assert.doesNotMatch(describe(invalid), /Advertised BSS Load: 0\/255/);
}
for (const timestamp of [undefined, new Date(now - 3000).toISOString(), new Date(now + 1000).toISOString()]) {
  const invalid = JSON.parse(JSON.stringify(apReceived));
  invalid.optimizer.band_steering['client-mac'].neighbors[0].observed_at = timestamp;
  assert.doesNotMatch(describe(invalid), /Advertised BSS Load: 0\/255/);
}
for (const value of [null, -1, 256, Infinity, NaN, true]) {
  const invalid = JSON.parse(JSON.stringify(apReceived));
  invalid.optimizer.band_steering['client-mac'].neighbors[0].advertised_bss_load.utilization = value;
  assert.doesNotMatch(describe(invalid), /Advertised BSS Load: .*\/255/);
}
const neighboring = JSON.parse(JSON.stringify(apReceived));
neighboring.optimizer.band_steering['client-mac'].serving_bssid = 'neighbor-zero';
assert.match(describe(neighboring), /neighbor-missing · channel 44/);
const noCollector = {...apReceived, optimizer: {...apReceived.optimizer, rf_observations: {enabled: false}}};
assert.match(describe(noCollector), /collector unavailable/);
assert.match(describe(noCollector), /Advertised BSS Load: 0\/255/);
const bounded = JSON.parse(JSON.stringify(apReceived));
bounded.optimizer.band_steering['client-mac'].neighbors = Array.from({length: 30},
  (_, index) => ({...bounded.optimizer.band_steering['client-mac'].neighbors[0], bssid: 'ap-' + index}));
assert.equal((describe(bounded).match(/Advertised BSS Load: 0\/255/g) || []).length, 24);
assert.match(describe(bounded), /24 most recent matching advertisements of 30/);
assert.match(describe({...input, view: 'configured', world: {traffic_experiment: {}}}), /not native measurements/);
const decision = {role: 'client', sta_mac: 'client-mac', reason: 'native_load_no_safe_quieter_target',
  action: 'none', load_evidence: {candidate_assessments: [{bssid: '<ap>', state: 'excluded', reasons: ['same_channel']}]}};
const decisionInput = {...input, selected: 'client', view: 'decision', optimizer: {client_decisions: [decision]}};
assert.match(describe(decisionInput), /<ap>: excluded · same_channel/);
const element = {textContent: ''};
render(element, decisionInput);
assert.match(element.textContent, /<ap>/);
assert.equal(element.innerHTML, undefined);
assert.match(describe({...input, view: 'traffic', traffic: {state: 'completed', history: [
  {state: 'completed', transmitted_packets: 10, received_echo_replies: 0}]}}), /Delivered echo replies: 0/);
assert.match(describe({...input, view: 'traffic', traffic: {state: 'failed', history: [
  {state: 'failed', transmitted_packets: null, received_echo_replies: null}]}}), /Generated: unknown/);
console.log('PASS: RF inspector provenance, zero, freshness, exclusions and traffic accounting');
const independent = {...input, observations: {enabled: true, maximum_age_seconds: 5,
  bss_loads: [{...observation, utilization: 200, frequency_mhz: 5180}]}};
assert.match(describe(independent), /Utilization \(0–255\): 200/);
assert.match(describe(independent), /5180 MHz/);
assert.doesNotMatch(describe({...independent, observations: {enabled: true, error: 'inventory stale', bss_loads: []}}),
  /Utilization \(0–255\): 0/);
assert.match(describe({...input, view: 'properties', catalog: {properties: [
  {id: 'noise', label: 'Independent noise', usage: 'unsupported'}]}}), /Unsupported; no value is invented/);
const udp = {...input, view: 'traffic', world: {golden_sha256: 'current', traffic_experiment: {phases: [{mode: 'udp'}]}},
  traffic: {state: 'off', history: [{world_sha256: 'current', mode: 'udp', state: 'completed', requested_offered_mbps: 8,
    sender: {status: 'complete', bits_per_second: 6000000, seconds: 3},
    receiver: {status: 'complete', goodput_bits_per_second: 5000000, lost_packets: 0, packets: 100, loss_percent: 0, seconds: 3.1}}]}};
assert.match(describe(udp), /BOUNDED UDP/);
assert.match(describe(udp), /Requested: 8 offered Mbps/);
assert.match(describe(udp), /Sender actual: 6.000 Mbps/);
assert.match(describe(udp), /Receiver goodput: 5.000 Mbps/);
assert.match(describe(udp), /Receiver loss: 0 \/ 100 expected datagrams · 0%/);
assert.match(describe(udp), /Native AP load is a separate observation/);
const missing = {...udp, traffic: {history: [{mode: 'udp', state: 'cancelled', requested_offered_mbps: 8}]}};
assert.match(describe(missing), /cancelled/);
assert.match(describe(missing), /Receiver goodput: unknown · missing/);
assert.doesNotMatch(describe(missing), /8.000 Mbps/);
assert.doesNotMatch(describe({...udp, world: {golden_sha256: 'other'}}), /Receiver goodput: 5.000/);
console.log('PASS: UDP offered rate, sender actual, receiver goodput/loss and missing records stay distinct');
