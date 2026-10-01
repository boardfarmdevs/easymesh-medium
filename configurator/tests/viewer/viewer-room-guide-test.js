'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../../worlds');
const guide = require(path.join(root, 'viewer/room-guide.js'));
const html = fs.readFileSync(path.join(root, 'viewer/index.html'), 'utf8');
const catalog = Array.from(vm.runInNewContext(html.match(/const GOLDEN = (\[[\s\S]*?\]);/)[1]));
const installed = fs.readdirSync(path.join(root, 'golden'))
  .filter(filename => filename.endsWith('.world.json')).map(filename => filename.slice(0, -11));
assert.deepEqual(Object.keys(guide.entries).sort(), installed.sort());
assert.deepEqual(Object.keys(guide.entries).sort(), catalog.sort());
for (const [id, entry] of Object.entries(guide.entries)) {
  const world = JSON.parse(fs.readFileSync(path.join(root, 'golden', id + '.world.json')));
  assert.equal(entry.seconds * 1000, world.duration_ms, id + ' duration');
  assert.equal(entry.clients, world.counts.stations, id + ' clients');
  assert.equal(entry.backhaul || 'fixed', world.backhaul_rf || 'fixed', id + ' backhaul policy');
  assert.deepEqual(entry.pauses.map(seconds => seconds * 1000), world.pause_at_ms || [], id + ' pauses');
  for (const key of ['rf', 'optimizer', 'watch', 'limits']) {
    assert.ok(entry[key].length >= 100, id + ' has detailed ' + key);
    assert.ok(guide.tooltip(id).includes(entry[key]));
  }
}
for (const id of ['', 'custom-world', '__proto__', 'constructor', null]) {
  assert.equal(guide.describe(id).title, 'Custom or unlisted room');
  assert.match(guide.tooltip(id), /No room-specific optimizer result/);
}
assert.match(guide.shared.rf, /−91 dBm/);
assert.match(guide.shared.rf, /synthesized/);
assert.match(guide.shared.limits, /external lab optimizer/);
assert.match(guide.shared.limits, /not recorded PASS/);
assert.match(guide.shared.limits, /do not inject a controlled load test/);
assert.match(html, /RoomGuide\.mount\(document, sel, requestedMode\)/);
assert.match(guide.backhaulDescription('modeled').title, /native parent selection/);
assert.match(guide.backhaulDescription('adaptive-rdk').title, /lab-assisted/);
assert.match(guide.backhaulDescription('fixed-startup-mesh').detail, /protected/);
assert.match(guide.backhaulDescription('modeled', true).detail, /no native parents/);
assert.match(guide.backhaulDescription(null).title, /awaiting/);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'viewer/room-guide.js'), 'utf8'), /fetch\(|XMLHttpRequest|EventSource|innerHTML|sendControl/);
console.log('PASS: every bundled room has RF, optimizer, evidence and limits; counts/timing match golden plans; unknown rooms fail safe');
