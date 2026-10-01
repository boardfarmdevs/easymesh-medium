'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2] || path.resolve(__dirname,
  '../../worlds/viewer/index.html'), 'utf8');
const elements = new Map();
const state = vm.createContext({
  world: {roles: {client: 'station'}, duration_ms: 60000},
  liveMode: true, interactiveLiveMode: true, replayMode: false,
  livePlayback: {enabled: true, status: 'paused', time_ms: 0}, liveClock: null,
  playbackBusy: false, tMs: 0, recentEvents: [], applyingWorld: false,
  interaction: {revision: 0, apiEnabled: true, overrides: {}, previewPositions: {}, initialRoles: {}},
  acquireInteractionLease: async () => true,
  update() {}, eventLabel: () => null,
  renderBackhaulPolicy() {},
  $: selector => {
    if (!elements.has(selector)) elements.set(selector, {classList: {toggle() {}}});
    return elements.get(selector);
  },
});
for (const [start, end] of [
  ['  function showPlaybackCheckpoint(', '  async function togglePlay()'],
  ['  async function togglePlay()', "  $('#play').addEventListener('click', togglePlay);"],
  ['  function applyDemoEvent(', '  function runStateFor('],
  ['  function applyInteractionSnapshot(', '  async function refreshInteractionSnapshot()'],
]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), state);

const payload = (revision, time, position) => ({revision,
  playback: {enabled: true, status: 'playing', time_ms: time, checkpoint_ms: null},
  roles: {client: {position, present: true}}, enabled: true});
const deliver = message => state.applyDemoEvent({kind: 'interaction.playback.progress', payload: message}, false);
const check = (time, position) => {
  assert.equal(state.tMs, time);
  assert.deepEqual(Array.from(state.interaction.overrides.client.position), position);
};

async function main() {
  let complete;
  let dispatched;
  const sent = new Promise(resolve => { dispatched = resolve; });
  state.sendControl = () => new Promise(resolve => { complete = resolve; dispatched(); });
  const playing = state.togglePlay();
  await sent;
  deliver(payload(535, 1000, [1.3, 2]));
  complete(payload(534, 0, [1, 2]));
  await playing;
  check(1000, [1.3, 2]);
  assert.equal(state.interaction.revision, 535);

  deliver(payload(534, 0, [1, 2]));
  check(1000, [1.3, 2]);
  state.applyInteractionSnapshot(payload(534, 0, [1, 2]));
  check(1000, [1.3, 2]);

  deliver(payload(535, 2000, [1.3, 2]));
  state.applyPlaybackUpdate(payload(535, 1000, [1.3, 2]));
  check(2000, [1.3, 2]);
  deliver(payload(536, 0, [1, 2]));
  check(0, [1, 2]);
  state.applyInteractionSnapshot(payload(537, 1000, [1.3, 2]));
  check(1000, [1.3, 2]);
  assert.equal(state.interaction.revision, 537);

  state.interaction.leaseToken = 'owned';
  state.interaction.drag = {role: 'client'};
  deliver(payload(538, 2000, [1.6, 2]));
  check(2000, [1.3, 2]);
  state.interaction.drag = null;
  state.interaction.previewPositions.client = [1.9, 2];
  deliver(payload(539, 3000, [1.9, 2]));
  check(3000, [1.9, 2]);
  assert.equal(state.interaction.previewPositions.client, undefined);
  state.interaction.playbackRevision = 540;
  state.livePlayback = null;
  state.applyPlaybackUpdate(payload(539, 3000, [8, 8]));
  check(3000, [1.9, 2]);
  deliver(payload(540, 0, [1, 2]));
  check(0, [1, 2]);
  state.interaction.playbackRevision = -1;
  deliver(payload(1, 0, [1, 2]));
  check(0, [1, 2]);
  assert.equal(state.interaction.revision, 540);
  assert.match(source, /interaction\.playbackRevision = -1;/);
  assert.match(source, /interaction\.playbackRevision = Number\(payload\.revision \|\| 0\);/);
  console.log('PASS: delayed Play replies and snapshots cannot mix old clocks with newer poses; rewinds, drag and world reset remain valid');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
