'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname,
  '../../worlds/viewer/index.html'), 'utf8');
const orbitSource = source.slice(source.indexOf('  (function bindOrbit()'), source.indexOf('  function resize()'));
const commitSource = source.slice(source.indexOf('  async function commitDraggedRole('), source.indexOf('  async function beginDestinationSelection('));
const permissionSource = source.slice(source.indexOf('  function canInteractWith('), source.indexOf('  function setPositionOverride('));
const commandSource = source.slice(source.indexOf('  function sendControl('), source.indexOf('  function sendMutation('));

function harness({live = false, replay = false, interactive = live} = {}) {
  const handlers = {};
  const writes = [];
  const probes = [];
  let authorizations = 0;
  const context = vm.createContext({
    world: {roles: {client: 'station', gateway: 'fronthaul_ap'}},
    world3d: {}, liveMode: live, interactiveLiveMode: interactive, replayMode: replay,
    playing: true, tMs: 1000, selected: null,
    interaction: {apiEnabled: true, movableRoles: ['client', 'gateway'], presenceRoles: ['client'],
      drag: null, movement: null, previewPositions: {}, overrides: {}},
    renderer: {domElement: {addEventListener: (name, handler) => { handlers[name] = handler; }, setPointerCapture() {}}},
    main: {classList: {add() {}, remove() {}}},
    THREE: {Vector3: class {setFromMatrixColumn() { return this; }}}, camera: {matrix: {}},
    orbit: {theta: 0, phi: 1, r: 10, target: {addScaledVector() { return this; }}},
    hideRoleMenu() {}, showRoleMenu() {}, update() {}, placeCamera() {},
    pickedRole: event => event.role || null,
    floorPoint: event => [event.clientX / 10, event.clientY / 10],
    frameAt: () => ({}), effectivePosition: () => [2, 2],
    pick: event => { context.selected = event.role; },
    setPreviewPosition: (role, point) => { context.interaction.previewPositions[role] = point; },
    setPositionOverride: (role, point) => { context.interaction.overrides[role] = {position: point}; },
    acquireInteractionLease: async () => { authorizations++; return true; },
    sendMutation: async (operation, role, payload) => { writes.push({operation, role, ...payload}); return payload; },
    canSelectTrafficProbe: role => live && interactive && !replay && role === 'client',
    selectTrafficProbe: role => { probes.push(role); },
  });
  vm.runInContext(permissionSource + commitSource + orbitSource, context);
  const pointer = (event, extra = {}) => handlers[event]({button: 0, pointerId: 1,
    clientX: 10, clientY: 10, shiftKey: false, role: 'client', ...extra});
  return {context, writes, probes, pointer, authorizations: () => authorizations};
}

async function main() {
  assert.doesNotMatch(source, /id="(?:cameraMode|interactMode)"|interaction\.mode|setInteractionMode/);
  const probe = harness({live: true});
  await probe.pointer('pointerdown', {ctrlKey: true});
  await probe.pointer('pointermove', {ctrlKey: true, clientX: 30});
  await probe.pointer('pointerup', {ctrlKey: true, clientX: 30});
  assert.deepEqual(probe.probes, ['client']);
  assert.deepEqual(probe.writes, []);
  assert.equal(probe.context.interaction.drag, null);
  await probe.pointer('pointerdown', {ctrlKey: true, role: 'gateway'});
  assert.deepEqual(probe.probes, ['client']);
  const readOnlyProbe = harness({live: true, interactive: false});
  await readOnlyProbe.pointer('pointerdown', {ctrlKey: true});
  assert.deepEqual(readOnlyProbe.probes, []);
  const offline = harness();
  await offline.pointer('pointerdown');
  await offline.pointer('pointermove', {clientX: 30});
  await offline.pointer('pointerup', {clientX: 30});
  assert.deepEqual(Array.from(offline.context.interaction.overrides.client.position), [4, 2]);
  assert.equal(offline.context.playing, true, 'dragging does not pause playback');
  assert.equal(offline.context.tMs, 1000);
  assert.equal(offline.authorizations(), 0);

  const live = harness({live: true});
  await live.pointer('pointerdown');
  await live.pointer('pointermove', {clientX: 12});
  await live.pointer('pointerup');
  assert.equal(live.authorizations(), 0, 'a click does not acquire control or write RF');
  await live.pointer('pointerdown');
  await live.pointer('pointermove', {clientX: 30});
  assert.equal(live.writes.length, 0, 'pointer motion is a preview only');
  await live.pointer('pointerup', {clientX: 30});
  assert.equal(live.writes.length, 1);
  assert.equal(live.writes[0].final, true);
  assert.deepEqual(Array.from(live.writes[0].position), [4, 2]);
  assert.equal(live.context.playing, true);

  const cancelled = harness({live: true});
  await cancelled.pointer('pointerdown');
  await cancelled.pointer('pointermove', {clientX: 30});
  await cancelled.pointer('pointercancel');
  assert.equal(cancelled.context.interaction.previewPositions.client, undefined);
  assert.equal(cancelled.authorizations(), 0);
  await cancelled.pointer('pointerdown', {shiftKey: true});
  await cancelled.pointer('pointermove', {shiftKey: true, clientX: 30});
  await cancelled.pointer('pointerup');
  assert.equal(cancelled.writes.length, 0, 'Shift-drag pans even over a device');

  for (const mode of [{live: true, interactive: false}, {replay: true}]) {
    const observer = harness(mode);
    await observer.pointer('pointerdown');
    await observer.pointer('pointermove', {clientX: 30});
    await observer.pointer('pointerup');
    assert.notEqual(observer.context.orbit.theta, 0);
    assert.equal(observer.writes.length, 0);
    assert.equal(observer.authorizations(), 0);
  }

  const denied = harness({live: true});
  denied.context.acquireInteractionLease = async () => false;
  await denied.pointer('pointerdown');
  await denied.pointer('pointermove', {clientX: 30});
  await denied.pointer('pointerup');
  assert.equal(denied.writes.length, 0);
  assert.equal(denied.context.interaction.previewPositions.client, undefined);
  assert.equal(denied.context.interaction.overrides.client, undefined);

  const changed = harness({live: true});
  let authorize;
  changed.context.acquireInteractionLease = () => new Promise(resolve => { authorize = resolve; });
  await changed.pointer('pointerdown');
  await changed.pointer('pointermove', {clientX: 30});
  const pending = changed.pointer('pointerup');
  changed.context.world = {roles: {client: 'station'}};
  authorize(true);
  await pending;
  assert.equal(changed.writes.length, 0, 'a drag cannot leak into a newly loaded world');

  const requests = [];
  const commands = vm.createContext({
    interactiveLiveMode: true, world: {}, newCommandId: () => 'same-command', interactionMessage() {},
    interaction: {leaseToken: 'capability', clientSequence: 0, revision: 1, acknowledgedSequence: 0, requestChain: Promise.resolve()},
    apiJson: async (url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) throw {code: 'stale_revision'};
      return {revision: 3};
    },
    refreshInteractionSnapshot: async () => { commands.interaction.revision = 2; },
  });
  vm.runInContext(commandSource, commands);
  const accepted = await vm.runInContext("sendControl('/position', 'PUT', {})", commands);
  assert.equal(accepted.revision, 3);
  assert.deepEqual(requests.map(request => request.expected_revision), [1, 2]);
  assert.equal(requests[0].command_id, requests[1].command_id);
  const queued = vm.runInContext("sendControl('/position', 'PUT', {})", commands);
  commands.world = {};
  assert.equal(await queued, null);
  assert.equal(requests.length, 2, 'queued writes cannot leak across a world switch');
  console.log('PASS: unified gestures, play+drag, click/pan/cancel safety, authorization and observer/replay boundaries');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
