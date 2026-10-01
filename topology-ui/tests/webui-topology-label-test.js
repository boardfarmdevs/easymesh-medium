'use strict';
const assert = require('assert').strict;
const path = require('path');
global.document = {addEventListener() {}, getElementById() {return null;}};
global.window = {addEventListener() {}};
const Controller = require(path.resolve(process.argv[2]));
const controller = new Controller();
const overlap = (first, second) => Math.min(first.x + first.width, second.x + second.width) > Math.max(first.x, second.x)
  && Math.min(first.y + first.height, second.y + second.height) > Math.max(first.y, second.y);

for (const count of [1, 2, 5, 10, 20]) {
  const stations = Array.from({length: count}, (_, index) => ({staMAC: `02:00:00:00:${index.toString(16).padStart(2, '0')}:00`, ssid: 'private_ssid'}));
  const geometry = controller.topologyHaulGeometry([{ssid: 'private_ssid'}], stations);
  const placements = stations.map(station => controller.topologySTAPlacement(station, stations, geometry, 'agent-1'));
  const obstacles = placements.map(placement => ({x: placement.to.x - placement.iconSize / 2,
    y: placement.to.y - placement.iconSize / 2, width: placement.iconSize + 16, height: placement.iconSize}));
  const title = controller.topologySSIDLabel(geometry[0]);
  obstacles.push({x: title.x - 55, y: title.y - 16, width: 110, height: 32});
  for (const placement of placements) {
    const label = controller.topologyClientLabelPosition(placement.to, placement.iconSize, {width: 76, height: 26}, obstacles);
    assert.ok(!obstacles.some(obstacle => overlap(label, obstacle)), `overlapping label in ${count}-client cohort`);
    assert.deepEqual(label, controller.topologyClientLabelPosition(placement.to, placement.iconSize, {width: 76, height: 26}, obstacles));
    obstacles.push(label);
  }
}
const center = {x: 200, y: -80};
const size = {width: 78, height: 26};
const preferred = controller.topologyClientLabelPosition(center, 44, size, []);
const alternative = controller.topologyClientLabelPosition(center, 44, size, [preferred]);
assert.ok(!overlap(preferred, alternative));
assert.deepEqual(center, {x: 200, y: -80});
assert.deepEqual(size, {width: 78, height: 26});
assert.doesNotThrow(() => controller.layoutTopologyLabels());
console.log('PASS: larger client labels avoid icons, SSID titles and each other in 1–20-client cohorts without moving nodes');
