'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const wrapper = source.slice(source.indexOf('  let updateQueued = false;'), source.indexOf('  function updateFrame()'));
const frames = [];
let submissions = 0;
const context = vm.createContext({URLSearchParams, location: {search: '?profile=1'},
  world3d: true, sceneRenderDirty: true, scene: {}, camera: {}, renderer: {render() { submissions++; }},
  performance: {now: () => 42}, requestAnimationFrame: callback => frames.push(callback)});
vm.runInContext(wrapper + '\nfunction updateFrame() {}', context);
vm.runInContext('receivedNetworkFrame = {sequence: 1, received_at: 10}; update();', context);
assert.equal(frames.length, 1, 'unapplied snapshots are not reported as rendered');
assert.equal(submissions, 0);
frames.shift()();
assert.equal(submissions, 1, 'updated scene is submitted within the same RAF');
assert.equal(context.sceneRenderDirty, false);
assert.equal(frames.length, 1, 'one frame marker per submitted snapshot');
frames.shift()();
assert.equal(vm.runInContext('frameTimings.length', context), 1);
assert.equal(vm.runInContext('frameTimings[0].sequence', context), 1);
assert.equal(vm.runInContext('frameTimings[0].submitted_at', context), 42);
assert.equal(vm.runInContext('frameTimings[0].next_frame_at', context), 42);
const loop = source.slice(source.indexOf('  function loop(now)'), source.indexOf('  resize(); placeCamera(); requestAnimationFrame(loop);'));
Object.assign(context, {world: null, playing: false, liveMode: false, lastTick: 0});
vm.runInContext(loop + '\nloop(100); loop(200);', context);
assert.equal(submissions, 1, 'unchanged frames do not resubmit the scene');
console.log('PASS: frame timing records applied scene versions once, after submission and following RAF');
