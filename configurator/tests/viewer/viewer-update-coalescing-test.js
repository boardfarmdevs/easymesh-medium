'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const wrapper = source.slice(source.indexOf('  let updateQueued = false;'), source.indexOf('  function updateFrame()'));
const frames = [];
const context = vm.createContext({requestAnimationFrame: callback => frames.push(callback),
  URLSearchParams, location: {search: ''},
  world3d: false,
  performance: {now: () => 0}, model: 0, rendered: -1});
vm.runInContext(wrapper + '\nfunction updateFrame() { rendered = model; }', context);
for (let event = 1; event <= 100; event++) vm.runInContext('model++; update();', context);
assert.equal(frames.length, 1);
assert.equal(context.rendered, -1);
frames.shift()();
assert.equal(context.rendered, 100, 'all events are reduced before the coalesced render');
vm.runInContext('model++; update();', context);
assert.equal(frames.length, 1);
frames.shift()();
assert.equal(context.rendered, 101);
assert.equal(vm.runInContext('renderStats.updates', context), 2);
console.log('PASS: 100-event burst produces one scene update without dropping state');
