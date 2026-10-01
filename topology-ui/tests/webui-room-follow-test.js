'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const source = path.resolve(process.argv[2]);
global.document = {addEventListener() {}, getElementById() { return null; }};
global.window = {addEventListener() {}};
const Controller = require(source);
const {positions, pack} = require(path.join(path.dirname(source), 'room-topology.js'));
const cues = require(path.join(path.dirname(source), 'steering-cues.js'));
const roomProjection = require(path.join(path.dirname(source), 'room-projection.js'));
const roomName = require(path.join(path.dirname(source), 'room-name.js'));
assert.equal(roomName.format('home-five-agent--private-client-room-walk'), 'Home five agent — Private client room walk');
assert.equal(roomName.format('custom_room'), 'Custom room');
assert.equal(roomName.format(''), 'Waiting for room');
const controller = new Controller();
const golden = path.resolve(__dirname, '../../configurator/worlds/golden');
let frames = 0;
for (const file of fs.readdirSync(golden).filter(name => name.endsWith('.world.json'))) {
  const world = JSON.parse(fs.readFileSync(path.join(golden, file)));
  const roles = Object.keys(world.roles).filter(role => world.roles[role] === 'fronthaul_ap');
  const nodes = [{id: 'controller', name: 'Controller'}, ...roles.map((role, index) => ({id: 'device-' + index, name: 'shuffled-' + (5 - index)}))];
  for (const frame of world.generations || []) {
    const snapshot = {nodes: roles.map((role, index) => ({device_id: 'DEVICE-' + index, role, position: frame.positions[role]}))};
    const original = JSON.stringify({nodes, snapshot});
    const layout = positions(nodes, snapshot, () => 80);
    if (!layout.size) continue;
    assert.equal(JSON.stringify({nodes, snapshot}), original);
    assert.equal(layout.size, nodes.length);
    const gateway = roles.indexOf('gateway');
    if (gateway >= 0) assert.deepEqual(layout.get('device-' + gateway), {x: 0, y: 0});
    for (const [index, node] of nodes.entries()) {
      const position = layout.get(node.id);
      assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y), file);
      for (const peer of nodes.slice(index + 1)) {
        const other = layout.get(peer.id);
        const minimum = node.id === 'controller' || peer.id === 'controller' ? 430 : 700;
        assert.ok(Math.hypot(position.x - other.x, position.y - other.y) >= minimum, file + ': overlap');
      }
    }
    const groups = nodes.map(node => ({...node, STAList: [], haulTypes: node.id === 'controller' ? [] :
      ['mesh_backhaul', 'private_ssid', 'iot_ssid'].map(ssid => ({ssid}))}));
    const packed = positions(groups, snapshot, node => controller.topologyNodeExtent(node), undefined,
      node => controller.topologyNodeFootprint(node));
    for (const [index, node] of groups.entries()) {
      const point = packed.get(node.id);
      for (const peer of groups.slice(index + 1)) {
        const other = packed.get(peer.id);
        for (const shape of controller.topologyNodeFootprint(node)) {
          for (const peerShape of controller.topologyNodeFootprint(peer)) {
            assert.ok(Math.hypot(other.x + peerShape.x - point.x - shape.x, other.y + peerShape.y - point.y - shape.y) >=
              shape.radius + peerShape.radius + 12 - 0.001, file + ': packed footprints overlap');
          }
        }
      }
    }
    frames += 1;
  }
}
const nodes = [{id: 'main', name: 'Agent-1'}, {id: 'ext', name: 'Extender-99'}];
const snapshot = {nodes: [{device_id: 'main', role: 'gateway', position: [10, 10]}, {device_id: 'ext', role: 'extender_1', position: [2, 2]}]};
const initialLayout = positions(nodes, snapshot, () => 80);
const further = {nodes: [{...snapshot.nodes[0]}, {...snapshot.nodes[1], position: [0, 0]}]};
const followed = positions(nodes, further, () => 80, initialLayout.projection);
assert.ok(Math.hypot(followed.get('ext').x, followed.get('ext').y) > Math.hypot(initialLayout.get('ext').x, initialLayout.get('ext').y), 'moving away was cancelled by automatic rescaling');
const gatewayMoved = {nodes: [{...snapshot.nodes[0], position: [12, 12]}, snapshot.nodes[1]]};
assert.ok(positions(nodes, gatewayMoved, () => 80, initialLayout.projection).get('main').x < 0, 'gateway was pinned to the old origin');
assert.ok(positions(nodes, snapshot, () => 80).get('ext').x > 0);
snapshot.nodes[1].position = [18, 18];
assert.ok(positions(nodes, snapshot, () => 80).get('ext').x < 0);
assert.ok(positions(nodes, snapshot, () => 80).get('ext').y < 0);
const homePositions = [[10, 7], [2, 2], [18, 2], [2, 12], [18, 12]];
const homeNodes = homePositions.map((position, index) => ({id: 'ap-' + index, name: 'shuffled-' + index}));
const homeSnapshot = {nodes: homeNodes.map((node, index) => ({device_id: node.id, role: index ? 'extender_' + index : 'gateway', position: homePositions[index]}))};
const homeLayout = positions(homeNodes, homeSnapshot, () => 80);
for (const [index, node] of homeNodes.entries()) {
  const expected = roomProjection.floor(homePositions[index], homePositions[0]);
  const actual = homeLayout.get(node.id);
  assert.ok(Math.abs(actual.x - expected.x * homeLayout.projection.scale) < 0.001);
  assert.ok(Math.abs(actual.y - expected.y * homeLayout.projection.scale) < 0.001);
}
assert.ok(homeLayout.get('ap-1').y > 0, 'near extender must be below Agent-1');
assert.ok(homeLayout.get('ap-4').y < 0, 'far extender must be above Agent-1');
assert.ok(homeLayout.get('ap-2').x > 0, 'right extender was mirrored');
assert.ok(homeLayout.get('ap-3').x < 0, 'left extender was mirrored');
const cohorts = ['mesh_backhaul', 'private_ssid', 'iot_ssid'].map(ssid => ({ssid}));
const populated = homeNodes.map(node => ({...node, haulTypes: cohorts, STAList: []}));
const packedLayout = positions(populated, homeSnapshot, node => controller.topologyNodeExtent(node), undefined,
  node => controller.topologyNodeFootprint(node));
const compactRatio = packedLayout.get('ap-1').y / homeLayout.get('ap-1').y;
assert.ok(compactRatio < 0.85, 'room groups retain excessive safety-circle spacing');
let nearestGap = Infinity;
for (const [index, node] of populated.entries()) {
  const point = packedLayout.get(node.id), previous = homeLayout.get(node.id);
  assert.ok(Math.abs(point.x * previous.y - point.y * previous.x) < 0.001, 'compaction changed bearing');
  assert.ok(point.x * previous.x + point.y * previous.y >= 0, 'compaction reversed bearing');
  for (const peer of populated.slice(index + 1)) {
    const other = packedLayout.get(peer.id);
    for (const shape of controller.topologyNodeFootprint(node)) {
      for (const peerShape of controller.topologyNodeFootprint(peer)) {
        const gap = Math.hypot(other.x + peerShape.x - point.x - shape.x, other.y + peerShape.y - point.y - shape.y) - shape.radius - peerShape.radius;
        nearestGap = Math.min(nearestGap, gap);
        assert.ok(gap >= 12 - 0.001, 'packed visible groups overlap');
      }
    }
  }
}
assert.ok(nearestGap < 12.01, 'packing leaves unnecessary space between the limiting groups');
const spread = [{id: 'gateway', x: 0, y: 0}, {id: 'near', x: 480, y: 0},
  {id: 'far', x: 1800, y: 900}, {id: 'left', x: -1500, y: -900}];
const footprint = () => [{x: 0, y: 0, radius: 80}];
const spreadLayout = pack(spread, footprint, 'gateway');
assert.ok(spreadLayout.get('far').x < 500, 'one close pair leaves the distant extender unnecessarily far away');
for (const [index, node] of spread.entries()) {
  const point = spreadLayout.get(node.id);
  assert.ok(Math.abs(point.x * node.y - point.y * node.x) < 0.001, 'radial packing changed bearing');
  for (const peer of spread.slice(index + 1)) {
    const other = spreadLayout.get(peer.id);
    assert.ok(Math.hypot(point.x - other.x, point.y - other.y) >= 172 - 0.001, 'radial packing overlaps nodes');
    for (const axis of ['x', 'y']) {
      assert.ok((point[axis] - other[axis]) * (node[axis] - peer[axis]) >= -0.001, 'packing flipped relative ordering');
    }
  }
}
const repacked = pack(spread.map(node => ({...node, ...spreadLayout.get(node.id)})), footprint, 'gateway');
for (const node of spread) assert.ok(Math.hypot(repacked.get(node.id).x - spreadLayout.get(node.id).x,
  repacked.get(node.id).y - spreadLayout.get(node.id).y) < 0.02, 'packing drifts on repeat');
const manualNodes = populated.map(node => ({...node, ...homeLayout.get(node.id)}));
controller.tightenTopologyNodes(manualNodes);
const tightened = manualNodes.map(node => ({x: node.x, y: node.y}));
controller.tightenTopologyNodes(manualNodes);
for (const [index, node] of manualNodes.entries()) {
  assert.ok(Math.abs(node.x - tightened[index].x) < 0.001);
  assert.ok(Math.abs(node.y - tightened[index].y) < 0.001, 'refresh unpacked manual arrangement');
}
assert.equal(positions([nodes[0]], snapshot, () => 80).has('ext'), false);
snapshot.nodes[1].position = [10, 10];
assert.ok(Math.abs(positions(nodes, snapshot, () => 80).get('ext').x) >= 724);
snapshot.nodes.push({...snapshot.nodes[0]});
assert.equal(positions(nodes, snapshot, () => 80).size, 0);
const station = {staMAC: 'aa:bb', bssid: 'source', ssid: 'private_ssid'};
controller.recordTopologyAssociationChanges({nodes: [{id: 'main', name: 'Agent-1', STAList: [station]}]},
  {nodes: [{id: 'main', name: 'Agent-1', STAList: [{...station, bssid: 'target'}]}]});
const effect = controller.topologyMoveEffectForSTA(station, 'main');
assert.ok(effect, 'same-AP band change was hidden');
assert.ok(controller.topologyMoveEffectForSTA(station, 'main'), 'redraw prematurely removed a cue');
const action = {sta_mac: 'aa:bb', source_bssid: 'source', target_bssid: 'target', method: 'btm-request', requested_at: new Date(effect.changedAt).toISOString()};
assert.equal(cues.style(effect, [action]).method, 'btm');
assert.equal(cues.style(effect, [{...action, method: 'non-btm', evidence: 'operator-report'}]).method, 'non-btm');
for (const changed of [{target_bssid: 'wrong'}, {source_bssid: 'wrong'}, {sta_mac: 'wrong'}, {method: 'non-btm'}, {requested_at: new Date(effect.changedAt - 31000).toISOString()}]) {
  assert.equal(cues.style(effect, [{...action, ...changed}]).method, 'unknown');
}
assert.equal(cues.style(effect, []).method, 'unknown');
controller.staMoveEffects.get('aa:bb').changedAt -= 6100;
assert.equal(controller.topologyMoveEffectForSTA(station, 'main'), null);
console.log(`PASS: ${frames} room frames, identity mapping, separation, movement, no phantom nodes, band moves and evidence-based steering colors`);
