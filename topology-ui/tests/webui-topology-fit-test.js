'use strict';
const assert = require('assert').strict;
const path = require('path');
global.document = {addEventListener() {}, getElementById() {return null;}};
global.window = {addEventListener() {}};
global.d3 = {zoomIdentity: {translate(offsetX, offsetY) {
  return {scale(zoomScale) {return {x: offsetX, y: offsetY, k: zoomScale};}};
}}};
const Controller = require(path.resolve(process.argv[2]));
const controller = new Controller();
const transforms = [];
let bounds = {x: -100, y: -50, width: 300, height: 120};
controller.topologyView = {width: 1600, height: 900, group: {node: () => ({getBBox: () => bounds})},
  svg: {call(_operation, transform) {transforms.push(transform);}}, zoom: {transform() {}}};
for (const [width, height, boxWidth, boxHeight] of [[1600, 900, 300, 120], [400, 300, 10000, 4000], [2400, 1600, 100, 90]]) {
  Object.assign(controller.topologyView, {width, height});
  bounds = {x: -100, y: -50, width: boxWidth, height: boxHeight};
  controller.fitTopologyToView();
  const transform = transforms.at(-1);
  assert.equal(transform.k, Math.min((width - 12) / boxWidth, (height - 12) / boxHeight));
  const left = bounds.x * transform.k + transform.x;
  const top = bounds.y * transform.k + transform.y;
  assert.ok(left >= 6 - 1e-8 && top >= 6 - 1e-8);
  assert.ok(Math.min(left, top) <= 6 + 1e-8, 'fit leaves more than a six-pixel limiting margin');
  assert.ok(bounds.width * transform.k + left <= width - 6 + 1e-8);
  assert.ok(bounds.height * transform.k + top <= height - 6 + 1e-8);
}
const count = transforms.length;
controller.topologyInteractionDepth = 1;
controller.fitTopologyToView();
assert.equal(transforms.length, count);
assert.equal(controller.topologyFitPending, true);
controller.topologyInteractionDepth = 0;
controller.fitTopologyToView();
assert.equal(controller.topologyFitPending, false);
bounds.width = NaN;
controller.fitTopologyToView();
assert.equal(transforms.length, count + 1);
assert.match(controller.updateTopologyVisualization.toString(), /simulation.on\('tick'\)\(\);\s+this.layoutTopologyLabels\(\);\s+this.fitTopologyToView\(\);/);
console.log('PASS: uncapped largest uniform fit, six-pixel border, resize/drag hooks and pointer deferral');
