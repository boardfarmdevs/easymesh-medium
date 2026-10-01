'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../../worlds');
const model = require(path.join(root, 'viewer/interaction-model.js'));
const world = JSON.parse(fs.readFileSync(path.join(root, 'golden/large-room-perimeter-counter-roam.world.json')));
const source = fs.readFileSync(path.join(root, 'viewer/index.html'), 'utf8');

assert.deepEqual(model.roomSize(world), {width: 40, height: 40});
assert.equal(model.nextPlaybackPause(world, 0, 50000), 14000);
assert.equal(model.nextPlaybackPause(world, 14000, 40000), 28000);
assert.equal(model.nextPlaybackPause(world, 28000, 42000), 42000);
assert.equal(model.nextPlaybackPause(world, 42000, 60000), null);
assert.equal(model.nextPlaybackPause({duration_ms: 60000}, 0, 60000), null);

const loopSource = source.slice(source.indexOf('  function loop(now)'), source.indexOf('  resize(); placeCamera(); requestAnimationFrame(loop);'));
const elements = new Map();
const context = vm.createContext({
  frameTimings: null,
  sceneRenderDirty: false, updateQueued: false,
  world, tMs: 13000, lastTick: 0, speed: 4, playing: true, liveMode: false,
  replayMode: false, world3d: false, lastSignalRefresh: 0, interactionModel: model,
  requestAnimationFrame() {}, advanceMovement: () => false, update() {},
  applyReplayUntil() {}, showPlaybackCheckpoint: value => { context.checkpoint = value; },
  $: selector => { if (!elements.has(selector)) elements.set(selector, {}); return elements.get(selector); },
});
vm.runInContext(loopSource, context);
vm.runInContext('loop(1000)', context);
assert.equal(context.tMs, 14000, '4x preview stops exactly at the first checkpoint');
assert.equal(context.playing, false);
assert.equal(context.checkpoint, 14000);
vm.runInContext('playing = true; loop(2000)', context);
assert.equal(context.tMs, 18000, 'resume does not stop at the same checkpoint again');
assert.equal(context.playing, true);
vm.runInContext('replayMode = true; tMs = 27000; loop(3000)', context);
assert.equal(context.tMs, 31000, 'replay follows recorded events, not newly imposed checkpoint stops');
assert.equal(context.playing, true);
vm.runInContext('liveMode = true; tMs = 13000; loop(4000)', context);
assert.equal(context.tMs, 13000, 'live playback remains server-owned');

const messageSource = source.slice(source.indexOf('  function showPlaybackCheckpoint('), source.indexOf('  async function togglePlay()'));
Object.assign(context, {interactiveLiveMode: true, playbackBusy: false, interaction: {apiEnabled: true}});
vm.runInContext(messageSource, context);
vm.runInContext('replayMode = false; applyPlaybackSnapshot({enabled: true, status: "paused", time_ms: 14000, checkpoint_ms: 14000})', context);
assert.equal(elements.get('#playbackCheckpoint').hidden, false);
assert.match(elements.get('#playbackCheckpoint').textContent, /verified roaming/);
assert.equal(elements.get('#play').textContent, 'Play');
vm.runInContext('applyPlaybackSnapshot({enabled: true, status: "playing", time_ms: 14000, checkpoint_ms: null})', context);
assert.equal(elements.get('#playbackCheckpoint').hidden, true);
console.log('PASS: perimeter preview bounds, exact checkpoints, resume, replay and server-owned playback');
