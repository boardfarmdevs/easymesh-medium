'use strict';
const assert = require('node:assert/strict');
const {rfHTML, Follower} = require(require('node:path').resolve(process.argv[2]));
const now = Date.parse('2026-09-15T20:00:00Z');
const node = {id: 'AP', haulTypes: [{name: 'Fronthaul', ssid: 'private_ssid',
  BSSList: [{BSSID: 'BSS', Band: 1}]}]};
const report = {bssid: 'bss', device_id: 'ap', radio_id: 'radio', channel: 36, utilization: 128,
  station_count: 3, observed_at: new Date(now - 500).toISOString(), source: 'native_ap_metrics',
  transport: 'ieee1905-ethernet'};
const observations = {enabled: true, maximum_age_seconds: 5, bss_loads: [report]};
const render = (changes = {}, status = observations) => rfHTML(node, {...status,
  bss_loads: [{...report, ...changes}]}, now);
const html = render();
assert.match(html, /50.2%/);
assert.match(html, /128\/255/);
assert.match(html, /5 GHz · ch 36/);
assert.match(html, />3<\/td>/);
assert.match(html, /0.5 s/);
assert.match(html, /Shared-radio utilization is not additive/);
assert.match(render({frequency_mhz: 5180}, {...observations, published_at: report.observed_at}),
  /Shared RF observations · independent publication/);
assert.match(render({frequency_mhz: 5180}), /5180 MHz/);
assert.match(render({context_state: 'unverified', radio_id: null, channel: null}), /RF context unverified/);
assert.match(render({utilization: 0, station_count: 0}), /0.0%/);
assert.match(render({utilization: 255}), /100.0%/);
for (const changes of [{utilization: null}, {utilization: -1}, {utilization: 256},
  {utilization: '128'}, {source: 'fixture'}, {transport: 'unknown'},
  {observed_at: new Date(now + 100).toISOString()}, {observed_at: 'invalid'},
  {observed_at: new Date(now - 5001).toISOString()}]) {
  assert.doesNotMatch(render(changes), /50.2%/);
}
for (const status of [{...observations, enabled: false}, {...observations, error: '<bad>'}]) {
  assert.doesNotMatch(render({}, status), /50.2%/);
}
assert.doesNotMatch(rfHTML(node, observations, now, false), /50.2%/);
assert.match(render({}, {...observations, error: '<bad>'}), /&lt;bad&gt;/);
assert.doesNotMatch(render({}, {...observations, error: '<bad>'}), /<bad>/);
assert.doesNotMatch(render({device_id: 'other'}), /50.2%/);
assert.match(render({station_count: null}), /<td>—<\/td>/);
assert.match(render({observed_at: new Date(now - 6000).toISOString()}), /6.0 s · stale/);
// An OpenSync pod: one group for all its BSSes, named after whichever came first.
const pod = {id: 'AP', haulTypes: [{name: 'Fronthaul', ssid: 'mesh_backhaul', BSSList: [
  {BSSID: 'BH', Band: 0, ssid: 'mesh_backhaul', haulType: 'Fronthaul'},
  {BSSID: 'BSS', Band: 0, ssid: 'private_ssid', haulType: 'Fronthaul'}]}]};
const podHTML = rfHTML(pod, {...observations, bss_loads: [report]}, now);
assert.match(podHTML, /&quot;private&quot;<small>2.4 GHz/);
assert.doesNotMatch(podHTML, /mesh_backhaul/);
assert.doesNotMatch(render({observed_at: new Date(now - 6000).toISOString()}, {...observations, maximum_age_seconds: 999}), /50.2%/);
assert.equal(rfHTML({id: 'controller'}, observations, now), '');
assert.match(rfHTML({...node, haulTypes: [{ssid: '<img src=x>', BSSList: [{BSSID: 'bss', Band: 1}]}]}, observations, now), /&lt;img src=x&gt;/);
assert.match(rfHTML(node, {...observations, bss_loads: [report, {...report, utilization: 255,
  observed_at: new Date(now - 2000).toISOString()}]}, now), /50.2%/);
const follower = {snapshot: {rf_observations: observations}, fresh(requireFollowing) {
  assert.equal(requireFollowing, false);
  return false;
}};
assert.match(Follower.prototype.rfHTML.call(follower, node), /Room telemetry unavailable/);
const backhaul = {paths: [{device_id: 'ap', role: 'extender_1', state: 'valid',
  observed_at: report.observed_at, path: ['extender_1', '<gateway>'], wireless_hops: 1,
  links: [{role: 'extender_1', parent_role: '<gateway>', frequency_mhz: 5180,
    signal: {state: 'valid', value: -40, unit: 'dBm', observed_at: report.observed_at}}]}]};
const pathHTML = rfHTML(node, {...observations, backhaul}, now);
assert.match(pathHTML, /Native backhaul · inspection only/);
assert.match(pathHTML, /-40 dBm/);
assert.match(pathHTML, /&lt;gateway&gt;/);
assert.doesNotMatch(rfHTML(node, {...observations, backhaul}, now + 6000), /-40 dBm/);
assert.match(rfHTML(node, {...observations, backhaul}, now + 6000), /Path unavailable\/stale/);
assert.doesNotMatch(rfHTML(node, {...observations, backhaul}, now, false), /-40 dBm/);
console.log('PASS: AP RF hover handles raw/percent load, stations, bands, age, missing/stale/invalid reports, isolation and escaping');
