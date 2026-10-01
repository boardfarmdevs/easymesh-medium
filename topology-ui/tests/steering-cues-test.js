'use strict';
const assert = require('assert/strict');
const path = require('path');
const cues = require(path.resolve(process.argv[2]));
const obstacle = {x: 140, y: -45, width: 120, height: 90};
const start = {x: 0, y: 0}, end = {x: 400, y: 0};
assert.equal(cues.segmentHitsBox(start, end, obstacle), true);
assert.equal(cues.segmentHitsBox({x: 0, y: -60}, {x: 400, y: -60}, obstacle), false);
assert.equal(cues.segmentHitsBox({x: 0, y: -100}, {x: 400, y: 100}, obstacle), true);
assert.equal(cues.segmentHitsBox({x: 0, y: 0}, {x: 0, y: 100}, obstacle), false);
const routed = cues.route(start, end, [obstacle]);
assert.ok(routed.length > 2);
assert.deepEqual(routed[0], start);
assert.deepEqual(routed.at(-1), end);
for (let index = 1; index < routed.length; index++) {
  assert.equal(cues.segmentHitsBox(routed[index - 1], routed[index], obstacle), false);
}
const occupied = [obstacle, {x: -30, y: -30, width: 60, height: 60}];
for (let ordinal = 0; ordinal < 100; ordinal++) {
  const label = cues.labelPosition(start, {width: 240, height: 54}, occupied, ordinal);
  assert.ok(occupied.every(box => !cues.intersects(label, box, 4)), 'label overlaps an entity or another label');
  occupied.push(label);
}
const paths = [];
for (let ordinal = 0; ordinal < 12; ordinal++) {
  const points = cues.route({x: 0, y: ordinal * 6}, {x: 400, y: 70 - ordinal * 6}, [obstacle], paths, ordinal);
  paths.push(points);
  for (let index = 1; index < points.length; index++) {
    assert.equal(cues.segmentHitsBox(points[index - 1], points[index], obstacle), false);
  }
}
assert.equal(new Set(paths.map(points => JSON.stringify(points))).size, 12);
assert.ok(cues.route(start, start, []).length >= 4, 'same-position band steer needs a visible loop');
assert.deepEqual(cues.route({x: NaN, y: 0}, end, []), []);
const effect = {staMAC: 'aa:bb', fromBSSID: 'old', toBSSID: 'new', changedAt: Date.now()};
const action = {sta_mac: 'aa:bb', source_bssid: 'old', target_bssid: 'new', method: 'btm-request', requested_at: new Date(effect.changedAt).toISOString()};
assert.equal(cues.style(effect, [action]).color, '#7c3aed');
assert.equal(cues.style(effect, [action]).label, 'BTM request');
assert.equal(cues.style(effect, []).method, 'unknown');
const timers = [], frames = [];
const originalTimeout = global.setTimeout, originalFrame = global.requestAnimationFrame;
class Selection {
  constructor(element = {}) { this.element = element; this.attributes = {}; }
  append() { return new Selection(); }
  datum(value) { if (!arguments.length) return this.data; this.data = value; return this; }
  attr(name, value) { if (arguments.length === 1) return this.attributes[name]; this.attributes[name] = value; return this; }
  style() { return this; }
  text() { return this; }
  select() { return new Selection(); }
  node() { return this.element; }
  remove() { this.removed = true; }
}
function expiryGroup() {
  const element = {isConnected: true, layoutReads: 0};
  element.parentNode = {getScreenCTM() { element.layoutReads++; return null; }};
  return new Selection(element);
}
function drawExpiry(group, remainingMs = 6000) {
  return cues.draw(group, {...effect, ageMs: 6000 - remainingMs, remainingMs}, start, end,
    {to: {x: 0, y: 0}, iconSize: 30}, 'station', [], 1);
}
try {
  global.setTimeout = (callback, delay) => timers.push({callback, delay});
  global.requestAnimationFrame = callback => frames.push(callback);
  const group = expiryGroup(), otherGroup = expiryGroup();
  const batch = Array.from({length: 24}, () => drawExpiry(new Selection(group.node())));
  const otherCue = drawExpiry(otherGroup, 1800);
  assert.deepEqual(timers.map(timer => timer.delay), [...Array(24).fill(6000), 1800]);
  assert.ok(batch.every(cue => !cue.removed));
  for (const timer of timers.splice(0)) timer.callback();
  assert.ok(batch.every(cue => cue.removed), 'every due cue must be removed before layout');
  assert.ok(otherCue.removed);
  assert.equal(group.node().layoutReads, 0, 'expiry must not synchronously relayout the scene');
  assert.equal(otherGroup.node().layoutReads, 0);
  assert.equal(frames.length, 2, 'coalesce expiry by group element, not selection wrapper');
  for (const callback of frames.splice(0)) callback();
  assert.equal(group.node().layoutReads, 1);
  assert.equal(otherGroup.node().layoutReads, 1, 'independent groups must both be laid out');
  drawExpiry(group);
  timers.shift().callback();
  assert.equal(frames.length, 1, 'later expiries must schedule a fresh layout');
  group.node().isConnected = false;
  frames.shift()();
  assert.equal(group.node().layoutReads, 1, 'skip groups detached before the queued frame');
  const detachedCue = drawExpiry(group);
  timers.shift().callback();
  assert.ok(detachedCue.removed);
  assert.equal(frames.length, 0, 'detached groups must not schedule layout');
  group.node().isConnected = true;
  drawExpiry(group);
  timers.shift().callback();
  assert.equal(frames.length, 1, 'skipped layouts must not leave the group pending');
  frames.shift()();
  assert.equal(group.node().layoutReads, 2);
} finally {
  global.setTimeout = originalTimeout;
  if (originalFrame === undefined) delete global.requestAnimationFrame;
  else global.requestAnimationFrame = originalFrame;
}
console.log('PASS: unchanged expiry deadlines, immediate removal, batched per-group layout and detached groups');
console.log('PASS: obstacle-free routes, separated simultaneous paths, 100 collision-free labels, band loops and purple BTM cues');
