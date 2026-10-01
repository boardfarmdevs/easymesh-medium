'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../../worlds/viewer');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const THREE = require(path.join(root, 'vendor/three.min.js'));
const world = JSON.parse(fs.readFileSync(path.join(root, '../golden/home-a-private-client-room-walk.world.json'), 'utf8'));
const generation = world.generations[0];
const meshRoles = Object.keys(world.roles).filter(role => world.roles[role] === 'fronthaul_ap');
const context = {THREE, world, band: '5', COL: {gateway: 0xc0392b, extender: 0xd65f27},
  networkState: {mesh: {available: true, nodes: meshRoles.map(role => ({role}))}},
  interactionModel: require(path.join(root, 'interaction-model.js')),
  isAp: role => world.roles[role] === 'fronthaul_ap',
  effectivePresent: (role, current) => !!current.present[role]};
vm.createContext(context);
for (const name of ['meshPresent', 'predictedMeshFor', 'bestMeshServing', 'appendBackhaulRibbon',
  'appendSimulatedBackhaul', 'makeBackhaulMeshes']) {
  vm.runInContext(html.match(new RegExp('  function ' + name + '\\([\\s\\S]*?\\n  \\}'))[0], context);
}
for (const [band, expected] of [['2.4', 28], ['5', 24], ['6', 21]]) {
  context.band = band;
  const best = context.bestMeshServing(generation, generation.positions);
  assert.equal(Object.keys(best).length, 4);
  assert.ok(Object.values(best).every(peer => peer.role === 'gateway' && peer.snr_db === expected));
}
context.band = '5';
const fronthaulDisabled = {...generation, present: {...generation.present, extender_1: false, extender_2: false}};
assert.equal(Object.keys(context.bestMeshServing(fronthaulDisabled, generation.positions)).length, 4);
const moved = {...generation.positions, gateway: [1, 1], extender_1: [5, 1], extender_2: [8, 1],
  extender_3: [12, 1], extender_4: [18, 1]};
const predicted = context.bestMeshServing(fronthaulDisabled, moved);
assert.equal(predicted.extender_4.role, 'extender_3');
assert.equal(predicted.extender_2.role, 'extender_3', 'strongest peer preview is not a loop-free parent plan');
assert.equal(predicted.extender_3.role, 'extender_2');
context.networkState.mesh.nodes = context.networkState.mesh.nodes.filter(node => node.role !== 'extender_3');
const withoutPeer = context.bestMeshServing(generation, moved);
assert.ok(!withoutPeer.extender_3 && Object.values(withoutPeer).every(peer => peer.role !== 'extender_3'));
context.networkState = null;
assert.equal(Object.keys(context.bestMeshServing(fronthaulDisabled, generation.positions)).length, 2);

for (const parent of ['gateway', 'extender_1']) {
  const points = [], colors = [];
  context.appendSimulatedBackhaul(points, colors, [0, 0], [2, 0], parent);
  assert.equal(points.length, 4 * 18);
  const color = new THREE.Color(parent === 'gateway' ? context.COL.gateway : context.COL.extender);
  for (let index = 0; index < points.length; index += 3) {
    assert.equal(points[index + 1], 0.035);
    assert.deepEqual(colors.slice(index, index + 3), [color.r, color.g, color.b]);
    assert.ok(points[index + 2] > 0.045, 'dashes must not overlap the actual ribbon');
  }
  assert.ok(Math.abs(points[2] - points[5] - 0.026) < 1e-10);
  assert.ok(Math.abs((points[2] + points[5]) / 2 - 0.14) < 1e-10);
  assert.ok(Math.abs(points[6] - 0.32) < 1e-10);
  assert.ok(Math.abs(points[18] - 0.54) < 1e-10);
  assert.ok(Math.max(...points.filter((_value, index) => index % 3 === 0)) <= 2);
}
for (const end of [[1, 2], [NaN, 2], [Infinity, 2]]) {
  const points = [], colors = [];
  context.appendSimulatedBackhaul(points, colors, [1, 2], end, 'gateway');
  assert.deepEqual(points, []);
}
const meshes = context.makeBackhaulMeshes('simulated-backhaul');
assert.equal(meshes.backhaul.name, 'simulated-backhaul-floor-links');
assert.equal(meshes.backhaulOccluded.material.depthFunc, THREE.GreaterDepth);
assert.equal(meshes.backhaulOccluded.material.stencilFunc, THREE.EqualStencilFunc);
assert.match(html, /bestMeshServing\(g, visualPos\)/);
assert.match(html, /setSegments\(world3d.simulatedBackhaulOccluded, simulatedPoints, backhaulOccludedColors\(simulatedColors\)\)/);
assert.doesNotMatch(html, /for \(const item of preview.candidates\) \{\s+links.push/);
assert.doesNotMatch(html, /grab-grey|grabbing-grey|cursor:\s*(?:grab|grabbing|copy)|--drag-hand/);
assert.match(html, /main canvas \{ cursor: default;/);
assert.match(html, /#spatialHud \{[^}]*cursor: default;/);
console.log('PASS: strongest mesh peers, band changes, fronthaul independence, thin offset floor dashes, wall pass and standard arrow cursors');
