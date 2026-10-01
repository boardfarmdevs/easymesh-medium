'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const helper = source.slice(source.indexOf('  function updateSegmentAttribute('), source.indexOf('  function deviceRole('));
let allocations = 0;
let bounds = 0;
let distances = 0;
const attributes = {};
const object = {geometry: {
  getAttribute: name => attributes[name], setAttribute: (name, value) => {attributes[name] = value;},
  computeBoundingSphere: () => {bounds++;},
}, computeLineDistances: () => {distances++;}};
const context = vm.createContext({THREE: {Float32BufferAttribute: class {
  constructor(values) {this.array = new Float32Array(values); allocations++;}
}}});
vm.runInContext(helper, context);
const points = [0.1, 0.2, 0.3, 4, 5, 6];
const colors = [1, 0, 0, 1, 0, 0];
context.setSegments(object, points, colors);
for (let frame = 0; frame < 100; frame++) context.setSegments(object, points, colors);
assert.equal(allocations, 2);
assert.equal(bounds, 1);
assert.equal(distances, 1);
context.setSegments(object, points, [0, 1, 0, 0, 1, 0]);
assert.equal(bounds, 1, 'color updates must not rebuild geometry');
assert.equal(attributes.color.needsUpdate, true);
context.setSegments(object, [0.2, ...points.slice(1)], colors);
assert.equal(allocations, 2);
assert.equal(bounds, 2);
assert.equal(distances, 2);
context.setSegments(object, [], []);
assert.equal(attributes.position.array.length, 0);
console.log('PASS: stable RF links reuse GPU buffers; geometry changes still update bounds and dashes');
