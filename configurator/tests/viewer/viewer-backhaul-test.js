'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const viewerRoot = path.resolve(__dirname, '../../worlds/viewer');
const THREE = require(path.join(viewerRoot, 'vendor/three.min.js'));
const html = fs.readFileSync(path.join(viewerRoot, 'index.html'), 'utf8');
const context = {THREE, COL: {gateway: 0xc0392b, extender: 0xd65f27}};
vm.createContext(context);
vm.runInContext(html.match(/  function makeBackhaulMeshes\([\s\S]*?\n  \}/)[0], context);
vm.runInContext(html.match(/  function backhaulOccludedColors\([\s\S]*?\n  \}/)[0], context);
const meshes = context.makeBackhaulMeshes();
assert.equal(meshes.backhaul.position.y, meshes.backhaulOccluded.position.y);
assert.equal(meshes.backhaul.material.depthWrite, false);
assert.equal(meshes.backhaulOccluded.material.depthFunc, THREE.GreaterDepth);
assert.equal(meshes.backhaulOccluded.material.stencilFunc, THREE.EqualStencilFunc);
assert.equal(meshes.backhaulOccluded.material.stencilRef, 1);
assert.equal(meshes.backhaulOccluded.material.depthWrite, false);
assert.ok(meshes.backhaulOccluded.renderOrder > meshes.backhaul.renderOrder);
assert.ok(Array.from(context.backhaulOccludedColors([0, 0.5, 1])).every(
  (value, index) => Math.abs(value - [0.3, 0.65, 1][index]) < 1e-10));
assert.match(html, /stencilZPass: THREE.ReplaceStencilOp/);
assert.match(html, /setSegments\(world3d.backhaulOccluded, bp, backhaulOccludedColors\(bc\)\)/);
assert.doesNotMatch(html, /!effectivePresent\(edge.parent_role/);
vm.runInContext(html.match(/  function appendBackhaulRibbon\([\s\S]*?\n  \}/)[0], context);
for (const parent of ['gateway', 'extender_1', 'extender_4']) {
  for (const [start, end] of [[[0, 0], [10, 0]], [[2, 3], [2, 9]], [[10, 9], [-2, -3]]]) {
    const points = [], colors = [];
    context.appendBackhaulRibbon(points, colors, start, end, parent);
    assert.equal(points.length, 18);
    assert.equal(colors.length, points.length);
    const expected = new THREE.Color(parent === 'gateway' ? context.COL.gateway : context.COL.extender);
    for (let index = 0; index < points.length; index += 3) {
      assert.equal(points[index + 1], 0.035);
      assert.deepEqual(colors.slice(index, index + 3), [expected.r, expected.g, expected.b]);
    }
    assert.ok(Math.abs(Math.hypot(points[0] - points[3], points[2] - points[5]) - 0.09) < 1e-10);
    assert.ok(Math.abs((points[0] + points[3]) / 2 - start[0]) < 1e-10);
    assert.ok(Math.abs((points[2] + points[5]) / 2 + start[1]) < 1e-10);
    assert.ok(Math.abs((points[6] + points[15]) / 2 - end[0]) < 1e-10);
  }
}
for (const end of [[1, 2], [NaN, 2]]) {
  const points = [], colors = [];
  context.appendBackhaulRibbon(points, colors, [1, 2], end, 'gateway');
  assert.deepEqual(points, []);
  assert.deepEqual(colors, []);
}
assert.match(html, /const backhaul = new THREE.Mesh\(/);
assert.match(html, /appendBackhaulRibbon\(bp, bc, a, b, edge.parent_role\)/);
assert.match(html, /setSegments\(world3d.backhaul, bp, bc\)/);
const overlay = html.match(/  function renderInteractionOverlays\([\s\S]*?(?=\n  function renderInteractionControls)/)[0];
const segments = [];
Object.assign(context, {
  interaction: {hudRole: 'client'}, selected: 'client', AP_H: 2.2, STA_H: 0.9,
  canMoveRole: () => true, effectivePresent: () => true,
  rolePreview: () => ({ap: false, point: [1, 1], strongest: {role: 'best', walls: []}, associated: {role: 'actual', walls: []}}),
  world3d: {walls: [], preview: {}, movePath: {}, destination: {}},
  setSegments: (_object, points, colors) => segments.push({points, colors}),
});
vm.runInContext(overlay, context);
context.renderInteractionOverlays({}, {best: [3, 3], actual: [5, 5]});
assert.equal(segments[0].points.length, 6, 'selection draws only the modeled path, not a duplicate actual association');
const purple = new THREE.Color(0x6f3e8e);
assert.deepEqual(Array.from(segments[0].colors), [purple.r, purple.g, purple.b, purple.r, purple.g, purple.b]);
console.log('PASS: floor-level backhaul ribbons, parent colors, consistent width, coincident endpoints, no duplicate cyan selection link');
