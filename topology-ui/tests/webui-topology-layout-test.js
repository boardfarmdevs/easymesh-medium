#!/usr/bin/env node

'use strict';

const assert = require('assert').strict;
const path = require('path');
const deepClone = value => JSON.parse(JSON.stringify(value));

if (process.argv.length !== 3) {
  console.error(`Usage: ${path.basename(process.argv[1])} SCRIPT_JS`);
  process.exit(2);
}

global.document = { addEventListener() {}, getElementById() { return null; } };
global.window = { addEventListener() {} };

const Controller = require(path.resolve(process.argv[2]));
const controller = new Controller();
const topology = {
  nodes: [{
    id: 'agent-1',
    haulTypes: [{
      BSSList: [
        { BSSID: '02:00:00:00:00:01', Band: 0, IEEE: '' },
        { BSSID: '02:00:00:00:00:02', Band: 1, IEEE: '' },
        { BSSID: '02:00:00:00:00:03', Band: 3, IEEE: '' },
        { BSSID: '02:00:00:00:00:04', Band: 1, IEEE: '802.11be' }
      ]
    }]
  }, {
    id: 'agent-2',
    haulTypes: []
  }],
  edges: [{
    from: 'agent-1', to: 'agent-2', band: 1, channel: 36,
    upstreamBSSID: '02:00:00:00:00:11', mediaType: 'Wireless LAN'
  }]
};
const original = deepClone(topology);
const before = controller.topologySignature(topology);
const labels = topology.nodes[0].haulTypes[0].BSSList
  .map(bss => controller.topologyBssIEEELabel(bss));

assert.deepEqual(labels, ['802.11ax', '802.11ax', '802.11be', '802.11be']);
assert.deepEqual(topology, original, 'formatting changed the topology API model');
assert.equal(controller.topologySignature(topology), before);

const cohortStations = [
  { staMAC: '02:00:00:00:09:00', ssid: 'private_ssid', band: 1, channel: 36,
    bssid: '02:00:00:00:01:01' },
  { staMAC: '02:00:00:00:0a:00', ssid: 'private_ssid', band: 3, channel: 1,
    bssid: '02:00:00:00:01:02' },
  { staMAC: '02:00:00:00:13:00', ssid: 'iot_ssid', band: 0, channel: 6,
    bssid: '02:00:00:00:01:03' }
];
const cohortHauls = [
  { name: 'Fronthaul', ssid: 'private_ssid' },
  { name: 'Iot', ssid: 'iot_ssid' },
  { name: 'Backhaul', ssid: 'mesh_backhaul' }
];
const geometry = controller.topologyHaulGeometry(cohortHauls, cohortStations);
const privateBubble = geometry.find(item => item.ssid === 'private_ssid');
const iotBubble = geometry.find(item => item.ssid === 'iot_ssid');
assert.ok(privateBubble.radius >= 110 && iotBubble.radius >= 110,
  'client SSID bubbles were not enlarged');
assert.notDeepEqual(privateBubble.offset, iotBubble.offset,
  'private and IoT bubbles share the same center');
assert.ok(Math.hypot(
  privateBubble.offset.x - iotBubble.offset.x,
  privateBubble.offset.y - iotBubble.offset.y
) >= privateBubble.radius + iotBubble.radius + 12,
  'private and IoT bubbles overlap or lack a readable gap');
for (const station of cohortStations) {
  const placement = controller.topologySTAPlacement(
    station, cohortStations, geometry, 'agent-1'
  );
  const bubble = geometry.find(item => item.ssid === station.ssid);
  const distance = Math.hypot(
    placement.to.x - bubble.offset.x,
    placement.to.y - bubble.offset.y
  );
  assert.ok(Math.abs(distance - placement.edgeRadius) < 0.001,
    `${station.staMAC} was not placed on the ${station.ssid} perimeter`);
  assert.ok(distance + placement.iconSize / 2 + 4 <= bubble.radius + 0.001,
    `${station.staMAC} icon extends outside ${station.ssid}`);
}

controller.staPositionCache.set('02:00:00:00:09:00', {
  ownerId: 'agent-1', ssid: 'private_ssid',
  x: privateBubble.offset.x + privateBubble.radius + 120,
  y: privateBubble.offset.y + 75
});
const draggedPlacement = controller.topologySTAPlacement(
  cohortStations[0], cohortStations, geometry, 'agent-1'
);
assert.equal(draggedPlacement.to.x,
  privateBubble.offset.x + privateBubble.radius + 120,
  'manual client X position did not survive a topology redraw');
assert.equal(draggedPlacement.to.y, privateBubble.offset.y + 75,
  'manual client Y position did not survive a topology redraw');
assert.ok(draggedPlacement.to.x > privateBubble.offset.x + privateBubble.radius,
  'manual client position was incorrectly constrained to the SSID bubble');
const reassociatedPlacement = controller.topologySTAPlacement(
  cohortStations[0], cohortStations, geometry, 'agent-2'
);
assert.notEqual(reassociatedPlacement.to.x, draggedPlacement.to.x,
  'manual client position survived an AP owner change');
assert.equal(controller.staPositionCache.has('02:00:00:00:09:00'), false,
  'stale client drag position was not discarded after reassociation');
assert.ok(controller.topologyNodeExtent({
  haulTypes: cohortHauls,
  STAList: cohortStations
}) > 240, 'expanded SSID groups did not increase D3 collision spacing');

for (const ssid of ['private_ssid', 'iot_ssid']) {
  for (const count of [1, 2, 5, 10]) {
    const stations = Array.from({length: count}, (_value, index) => ({
      staMAC: `02:00:00:01:00:${index.toString(16).padStart(2, '0')}`, ssid
    }));
    const hauls = controller.topologyHaulGeometry([{name: 'clients', ssid}], stations);
    const label = controller.topologySSIDLabel(hauls[0]);
    assert.equal(label.text, ssid === 'private_ssid' ? '"private"' : '"iot"');
    assert.equal(label.color, ssid === 'private_ssid' ? '#1e3a8a' : '#374151');
    assert.equal(label.fontSize, 26);
    const halfWidth = ssid === 'private_ssid' ? 55 : 34;
    const corners = [-halfWidth, halfWidth].flatMap(offsetX => [-16, 16].map(offsetY => ({
      x: label.x + offsetX, y: label.y + offsetY
    })));
    for (const station of stations) {
      const placement = controller.topologySTAPlacement(station, stations, hauls, 'label-test');
      const deltaX = placement.to.x - placement.from.x;
      const deltaY = placement.to.y - placement.from.y;
      for (const corner of corners) {
        const progress = Math.max(0, Math.min(1,
          ((corner.x - placement.from.x) * deltaX + (corner.y - placement.from.y) * deltaY) /
          (deltaX * deltaX + deltaY * deltaY)));
        const distance = Math.hypot(
          corner.x - placement.from.x - progress * deltaX,
          corner.y - placement.from.y - progress * deltaY);
        assert.ok(distance > 11, 'quoted SSID title overlaps the client link corridor');
      }
    }
    assert.ok(corners.every(corner => Math.hypot(corner.x, corner.y) < hauls[0].radius - 4),
      'quoted title lacks padding inside its SSID bubble');
  }
}
assert.deepEqual(controller.topologySSIDLabel({
  ssid: 'mesh_backhaul', offset: {x: 140, y: 0}, radius: 80
}), {x: 140, y: 0, text: '"backhaul"', fontSize: 22, color: '#8b1e24'},
  'backhaul is not rendered with the quoted dark-red display alias');

const landscapeNodes = [
  { id: 'controller', name: 'Controller', haulTypes: [], STAList: [] },
  { id: 'agent', name: 'Agent-1', haulTypes: cohortHauls, STAList: cohortStations },
  ...[1, 2, 3, 4].map(index => ({
    id: `extender-${index}`, name: `Extender-${index}`,
    haulTypes: cohortHauls, STAList: cohortStations
  }))
];
const landscapeStarEdges = [
  { from: 'controller', to: 'agent' },
  ...[1, 2, 3, 4].map(index => ({ from: 'agent', to: `extender-${index}` }))
];
const originalStar = deepClone({nodes: landscapeNodes, edges: landscapeStarEdges});
const landscapeStar = controller.topologyLandscapeLayout(
  landscapeNodes, landscapeStarEdges, 1600, 900
);
assert.equal(landscapeStar.size, landscapeNodes.length);
const landscapeController = landscapeStar.get('controller');
assert.ok(landscapeController, 'Controller is missing from the hierarchy');
assert.deepEqual(landscapeStar.get('agent'), {x: 0, y: 0},
  'Agent-1 is not the center of the star');
assert.equal(landscapeController.x, 0,
  'Controller is not adjacent to the centered Agent-1');
assert.ok(landscapeController.y < 0);
for (const [index, node] of landscapeNodes.slice(2).entries()) {
  const position = landscapeStar.get(node.id);
  assert.equal(Math.sign(position.x), index % 2 === 0 ? -1 : 1,
    'extenders do not follow the floor-plan left/right ordering');
  assert.equal(Math.sign(position.y), index < 2 ? -1 : 1,
    'extenders do not surround Agent-1 above and below');
}
for (const [index, node] of landscapeNodes.entries()) {
  for (const peer of landscapeNodes.slice(index + 1)) {
    const position = landscapeStar.get(node.id);
    const other = landscapeStar.get(peer.id);
    assert.ok(Math.hypot(position.x - other.x, position.y - other.y) >=
      controller.topologyNodeExtent(node) + controller.topologyNodeExtent(peer) + 24,
    `${node.name} and ${peer.name} lack clearance for SSID groups and labels`);
  }
}
assert.ok(Math.max(...[...landscapeStar.values()].map(position => Math.abs(position.x))) < 500,
  'star layout leaves excessive horizontal space between mesh nodes');
assert.deepEqual({nodes: landscapeNodes, edges: landscapeStarEdges}, originalStar,
  'star layout changed the controller model');
assert.deepEqual(controller.topologyStarLayout(
  [...landscapeNodes].reverse(),
  [...landscapeStarEdges].reverse().map(edge => ({source: {id: edge.from}, target: {id: edge.to}}))
), landscapeStar, 'star layout depends on discovery order or D3 edge mutation');
const agentRootStar = controller.topologyStarLayout(
  landscapeNodes.slice(1), landscapeStarEdges.slice(1));
assert.deepEqual(agentRootStar.get('agent'), {x: 0, y: 0},
  'star without a separate Controller lost its centered Agent-1');
assert.equal(controller.topologyStarLayout(landscapeNodes, [
  ...landscapeStarEdges.slice(0, -1), {from: 'extender-3', to: 'extender-4'}
]), null, 'a real multihop branch was incorrectly rendered as a star');
const branchEdges = [...landscapeStarEdges.slice(0, -1), {from: 'extender-3', to: 'extender-4'}];
const branchBefore = deepClone(branchEdges);
const branchPositions = controller.topologyLandscapeLayout(landscapeNodes, branchEdges, 1600, 900);
assert.deepEqual(branchPositions, landscapeStar,
  'a fresh branch does not use the compact, centered mesh arrangement');
assert.deepEqual(branchEdges, branchBefore, 'branch layout changed real parent edges');
assert.equal(new Set(landscapeNodes.slice(1).map(node => {
  const position = landscapeStar.get(node.id);
  return `${position.x.toFixed(3)},${position.y.toFixed(3)}`;
})).size, landscapeNodes.length - 1,
'two-level star assigned duplicate satellite positions');

const landscapeChainEdges = landscapeNodes.slice(1).map((node, index) => ({
  from: landscapeNodes[index].id, to: node.id
}));
const landscapeChain = controller.topologyLandscapeLayout(
  landscapeNodes, landscapeChainEdges, 1600, 900
);
const chainPositions = landscapeNodes.map(node => landscapeChain.get(node.id));
assert.equal(new Set(chainPositions.map(position => position.y)).size, 2,
  'multi-hop chain was not folded into two landscape rows');
assert.equal(new Set(chainPositions.map(position => position.x)).size,
  Math.ceil(landscapeNodes.length / 2),
  'multi-hop chain does not use the expected landscape columns');
assert.ok(chainPositions[0].x < chainPositions[1].x &&
  chainPositions[1].x < chainPositions[2].x &&
  chainPositions[3].x > chainPositions[4].x &&
  chainPositions[4].x > chainPositions[5].x,
  'multi-hop chain does not follow the two-row serpentine path');

const directStarEdges = landscapeNodes.slice(1).map(node => ({
  from: 'controller', to: node.id
}));
const directStar = controller.topologyLandscapeLayout(
  landscapeNodes, directStarEdges, 1600, 900
);
const directController = directStar.get('controller');
assert.ok(landscapeNodes.slice(1).every(node =>
  directStar.get(node.id).x > directController.x),
  'direct-star nodes were not placed after the Controller');

const metricsUpdated = new Date().toISOString();
controller.clients = [{
  mac: '02:00:00:00:09:00',
  client_metrics: {
    rssi_dbm: -41,
    rcpi: 138,
    last_updated: metricsUpdated,
    association_uptime_seconds: 10
  }
}];
const liveSignal = controller.topologySignalForSTA({
  staMAC: '02:00:00:00:09:00',
  band: 1
});
assert.equal(liveSignal.available, true);
assert.equal(liveSignal.rssi, -41);
assert.equal(liveSignal.rcpi, 138);
assert.equal(liveSignal.quality, 'strong');
assert.equal(liveSignal.band, '5G');
controller.clients[0].connected_bssid = '02:00:00:00:01:01';
assert.equal(controller.topologySignalForSTA({staMAC: controller.clients[0].mac,
  bssid: '02:00:00:00:02:01', band: 1}).available, false,
  'source-AP metrics must not be painted onto a newly observed target association');
assert.equal(controller.topologySignalForSTA({staMAC: controller.clients[0].mac,
  bssid: '02:00:00:00:01:01', band: 1}).available, true);
assert.equal(controller.topologySignalLevel(liveSignal), 10);
assert.equal(controller.topologySignalLevel({ available: true, rssi: -50 }), 9);
assert.equal(controller.topologySignalLevel({ available: true, rssi: -56 }), 7);
assert.equal(controller.topologySignalLevel({ available: true, rssi: -63 }), 6);
assert.equal(controller.topologySignalLevel({ available: true, rssi: -72 }), 4);
assert.equal(controller.topologySignalLevel({ available: true, rssi: -82 }), 2);
assert.equal(controller.topologySignalLevel({ available: true, rssi: -90 }), 1);
assert.equal(controller.topologySignalLevel({ available: false, rssi: null }), 0);
const meterRight = controller.topologySignalMeterGeometry({
  from: { x: 0, y: 20 }, to: { x: 10, y: 20 }, iconSize: 30
}, 9);
const meterLeft = controller.topologySignalMeterGeometry({
  from: { x: 20, y: 20 }, to: { x: 10, y: 20 }, iconSize: 30
}, 9);
assert.equal(meterRight.side, 1,
  'signal meter was not placed away from a left-side RF line');
assert.equal(meterLeft.side, -1,
  'signal meter was not placed away from a right-side RF line');
assert.ok(meterRight.x > 10 + 15 && meterLeft.x + meterLeft.width < 10 - 15,
  'signal meter overlaps the client icon');
const meterBottom = controller.topologySignalMeterGeometry({
  from: { x: 0, y: 20 }, to: { x: 10, y: 20 }, iconSize: 30
}, 0);
assert.ok(Math.abs((meterBottom.y + meterBottom.height) - 35) < 0.001,
  'signal meter does not span the complete client icon height');

const uptimeOnlyChange = deepClone(controller.clients);
uptimeOnlyChange[0].client_metrics.association_uptime_seconds = 12;
assert.equal(
  controller.topologyClientMetricsSignature(controller.clients),
  controller.topologyClientMetricsSignature(uptimeOnlyChange),
  'association uptime would redraw the topology every two seconds'
);
const signalChange = deepClone(controller.clients);
signalChange[0].client_metrics.rssi_dbm = -72;
assert.notEqual(
  controller.topologyClientMetricsSignature(controller.clients),
  controller.topologyClientMetricsSignature(signalChange),
  'an RSSI change would not redraw the topology'
);

controller.clients = [{
  mac: '02:00:00:00:13:00',
  client_metrics: {
    rssi_dbm: 0,
    rcpi: 100,
    last_updated: metricsUpdated
  }
}];
const rcpiFallback = controller.topologySignalForSTA({
  staMAC: '02:00:00:00:13:00',
  band: 3
});
assert.equal(rcpiFallback.rssi, -60);
assert.equal(rcpiFallback.quality, 'good');
assert.equal(rcpiFallback.band, '6G');

for (const timestamp of [undefined, 'invalid', new Date(Date.now() + 10000).toISOString()]) {
  controller.clients[0].client_metrics.last_updated = timestamp;
  const unavailable = controller.topologySignalForSTA({staMAC: '02:00:00:00:13:00', band: 3});
  assert.equal(unavailable.available, false, 'missing or future telemetry was treated as fresh');
  assert.equal(controller.topologySignalLevel(unavailable), 0);
}

controller.clients[0].client_metrics.last_updated = '2000-01-01T00:00:00Z';
const staleSignal = controller.topologySignalForSTA({
  staMAC: '02:00:00:00:13:00',
  band: 3
});
assert.equal(staleSignal.available, false);
assert.equal(staleSignal.stale, true);
assert.equal(staleSignal.label, 'stale');
const visualizationSource = controller.updateTopologyVisualization.toString();
assert.match(controller.setupEventHandlers.toString(), /observeTopologyViewport/,
  'topology pane resize observation is not installed');
assert.match(controller.observeTopologyViewport.toString(), /ResizeObserver/,
  'topology pane does not use element-level resize observation');
assert.doesNotMatch(controller.resizeTopologyViewport.toString(),
  /updateTopologyVisualization/,
  'resizing the pane would rebuild the graph');
assert.match(controller.resizeTopologyViewport.toString(), /fitTopologyToView/,
  'resizing does not maximize the topology within the new viewport');
assert.match(visualizationSource, /sta-signal-bars/,
  'topology does not render the signal-strength glyph');
assert.match(visualizationSource, /sta-signal-segment/,
  'topology does not render the ten signal-meter segments');
assert.doesNotMatch(visualizationSource, /sta-signal-arc/,
  'topology still renders the old semicircular signal glyph');
assert.doesNotMatch(visualizationSource, /sta-signal-ring/,
  'topology still draws a bubble around client devices');
assert.doesNotMatch(visualizationSource, /sta-signal-label/,
  'topology still renders signal text outside the client hover details');
assert.match(visualizationSource, /Signal:.*signalInfo/,
  'client hover details do not contain the signal strength');
assert.match(visualizationSource, /topologyBandLabel\(d\.band\).*ch/,
  'backhaul labels do not show both band and channel');
assert.match(visualizationSource, /backhaul-uplink-arrowhead/,
  'wireless backhaul links do not show uplink direction');
assert.match(visualizationSource, /Upstream BSSID:.*upstreamBSSID/,
  'backhaul hover details do not identify the exact parent BSSID');
assert.match(visualizationSource, /uplink &rarr;/,
  'backhaul hover details do not name child-to-parent direction');
assert.doesNotMatch(visualizationSource, /sta-channel-label/,
  'client band/channel details clutter the topology instead of remaining hover-only');
assert.match(visualizationSource, /Channel:.*channelInfo/,
  'client hover details do not show the current channel');
assert.match(visualizationSource, /BSSID:.*sta\.bssid/,
  'client hover details do not show the serving BSSID');
assert.match(controller.refreshTopologyData.toString(), /apiCall\('\/clients'\)/,
  'topology refresh does not acquire the live client metrics snapshot');
assert.match(controller.refreshTopologyData.toString(), /refreshTopologySignalVisuals\(\)/,
  'metric polling does not update the signal meter in place');
assert.doesNotMatch(controller.refreshTopologyData.toString(), /updateTopologyVisualization\(\)/,
  'two-second metric polling still rebuilds the entire topology SVG');
assert.match(visualizationSource, /staDragStarted/,
  'topology clients do not install a D3 drag interaction');
assert.match(visualizationSource, /sta-steer-pulse/,
  'topology does not render the post-steer client pulse');
assert.match(visualizationSource, /steeringCues\.draw\(/,
  'topology does not invoke the shared steering-cue renderer');
assert.match(require(path.join(path.dirname(path.resolve(process.argv[2])), 'steering-cues.js')).draw.toString(),
  /sta-steering-trail/, 'the shared renderer omits the fading steering trail');
assert.match(visualizationSource, /sta-steering-intent-path/,
  'topology does not render the pre-steer intent path');
assert.doesNotMatch(visualizationSource, /sta-moving-client|\.delay\(1250\)|moveEffect \? 0 : 1/,
  'topology delays or duplicates the authoritative associated client');
assert.match(visualizationSource, /alphaDecay\(0\.08\)\.stop\(\)/,
  'fixed topology geometry keeps running an unnecessary force timer');
assert.doesNotMatch(visualizationSource,
  /signal\.available \? null : '5 4'/,
  'unknown backhaul signal still changes a physical link to dotted');

controller.topology = {
  nodes: [
    { id: 'agent-1', name: 'Agent-1' },
    { id: 'agent-2', name: 'Extender-1' }
  ],
  steeringEvent: {
    sta_mac: '02:00:00:00:09:00', client_name: 'sta-09',
    target_name: 'Extender-1', phase: 'planned'
  }
};
const intent = controller.topologySteeringIntentForSTA(
  { staMAC: '02:00:00:00:09:00', ssid: 'private_ssid' },
  'agent-1', controller.topology.nodes
);
assert.equal(intent.targetNode.id, 'agent-2');
assert.equal(intent.targetName, 'Extender-1');

const associationSTA = {
  staMAC: '02:00:00:00:09:00', ssid: 'private_ssid'
};
controller.staMoveEffects.clear();
controller.recordTopologyAssociationChanges({
  nodes: [{ id: 'agent-1', name: 'Agent-1', STAList: [associationSTA] }]
}, {
  nodes: [{ id: 'agent-2', name: 'Extender-1', STAList: [associationSTA] }]
});
const moveEffect = controller.topologyMoveEffectForSTA(associationSTA, 'agent-2');
assert.equal(moveEffect.fromOwnerId, 'agent-1');
assert.equal(moveEffect.toOwnerId, 'agent-2');
assert.ok(moveEffect.remainingMs > 0,
  'new association move effect was already expired');

const renderTopology = controller.topologyRenderSnapshot(topology);
renderTopology.nodes[0].x = 123;
renderTopology.nodes[0].fx = 123;
renderTopology.edges[0].source = renderTopology.nodes[0];
renderTopology.edges[0]._midpoint = [10, 20];
assert.deepEqual(topology, original, 'D3 render state changed the topology API model');
assert.equal(controller.topologySignature(topology), before);

const simulation = { nodes: () => renderTopology.nodes };
assert.strictEqual(controller.topologySimulationNodes(simulation), renderTopology.nodes);
assert.deepEqual(controller.topologySimulationNodes(null), []);
assert.match(controller.optimizeTopologyLayout.toString(), /topologySimulationNodes\(simulation\)/,
  'Optimize Layout does not operate on the D3 render-node set');
assert.doesNotMatch(controller.optimizeTopologyLayout.toString(), /topologyLandscapeLayout/,
  'Optimize Layout replaced the operator arrangement with a canonical hierarchy');
assert.deepEqual(topology, original, 'selecting simulation nodes changed the API model');

const originalGetElementById = document.getElementById;
const resizeAttributes = {};
const resizeCenter = { x: null, y: null };
const centerForce = {
  x(value) { resizeCenter.x = value; return this; },
  y(value) { resizeCenter.y = value; return this; }
};
const preservedTransform = { x: 41, y: 23, k: 1.25 };
let resizeRedraws = 0;
document.getElementById = id => id === 'topology-visualization'
  ? { clientWidth: 1600, clientHeight: 900 }
  : null;
controller.zoomTransformCache = preservedTransform;
controller.topologyView = {
  width: 900,
  height: 600,
  svg: {
    attr(name, value) { resizeAttributes[name] = value; return this; }
  }
};
controller.topologySimulation = {
  force(name) { assert.equal(name, 'center'); return centerForce; }
};
controller.updateTopologyVisualization = () => { resizeRedraws += 1; };
assert.equal(controller.resizeTopologyViewport(), true,
  'a real topology pane resize was ignored');
assert.deepEqual(resizeAttributes, { width: 1600, height: 900 });
assert.deepEqual(resizeCenter, { x: 800, y: 450 });
assert.equal(controller.topologyView.width, 1600);
assert.equal(controller.topologyView.height, 900);
assert.strictEqual(controller.zoomTransformCache, preservedTransform,
  'topology resize replaced the current operator pan/zoom');
assert.equal(resizeRedraws, 0, 'topology resize rebuilt the graph');
assert.equal(controller.resizeTopologyViewport(), false,
  'an unchanged pane size performed redundant SVG work');
document.getElementById = originalGetElementById;

let fitted = false;
const layoutEvents = [];
let tickCount = 0;
const layoutNodes = deepClone(landscapeNodes);
const manualPositions = [
  [300, -140], [300, 100], [600, 500], [-100, -300], [-100, 500], [600, -300]
];
layoutNodes.forEach((node, index) => {
  [node.x, node.y] = manualPositions[index];
  node.fx = node.x;
  node.fy = node.y;
});
const beforeOptimize = layoutNodes.map(node => [node.id, node.x, node.y]);
const fakeSimulation = {
  nodes: () => layoutNodes,
  on(name) {
    assert.equal(name, 'tick');
    return () => layoutEvents.push('paint');
  },
  stop() {
    assert.ok(layoutNodes.every(node => node.fx === node.x && node.fy === node.y),
      'Optimize Layout released the operator-fixed nodes');
    return this;
  },
  alpha(value) { assert.equal(value, 1); return this; },
  alphaTarget(value) { assert.equal(value, 0); return this; },
  tick() {
    tickCount += 1;
    layoutNodes.forEach((node, index) => {
      node.x = 300 + index * 400;
      node.y = 200 + index * 250;
    });
    return this;
  }
};
controller.topologySimulation = fakeSimulation;
controller.topology = topology;
controller.nodePositionCache = new Map();
controller.staPositionCache.set('manual-client', {
  ownerId: 'agent-1', ssid: 'private_ssid', x: 100, y: 200
});
const beforeClientPositions = [...controller.staPositionCache.entries()];
controller.topologyLayoutGeneration = 0;
controller.topologyRenderPending = false;
controller.showNotification = () => {};
controller.fitTopologyToView = () => { fitted = true; layoutEvents.push('fit'); };
controller.updateTopologyVisualization = () => { layoutEvents.push('redraw'); };
controller.optimizeTopologyLayout();
assert.equal(controller.nodePositionCache.size, layoutNodes.length);
assert.deepEqual([...controller.staPositionCache.entries()], beforeClientPositions,
  'Optimize Layout discarded manual client positions');
const anchor = layoutNodes.find(node => node.id === 'agent');
assert.deepEqual([anchor.x, anchor.y], [300, 100], 'Optimize Layout moved the Agent-1 anchor');
for (const [id, originalX, originalY] of beforeOptimize) {
  const node = layoutNodes.find(item => item.id === id);
  assert.ok(Math.hypot(node.x - originalX, node.y - originalY) < 200,
    'overlap repair replaced the operator arrangement instead of making local corrections');
  if (!id.startsWith('extender')) continue;
  assert.equal(Math.sign(node.x - anchor.x), Math.sign(originalX - anchor.x));
  assert.equal(Math.sign(node.y - anchor.y), Math.sign(originalY - anchor.y));
}
for (const [index, node] of layoutNodes.entries()) {
  for (const other of layoutNodes.slice(index + 1)) {
    for (const shape of controller.topologyNodeFootprint(node)) {
      for (const peerShape of controller.topologyNodeFootprint(other)) {
        assert.ok(Math.hypot(node.x + shape.x - other.x - peerShape.x, node.y + shape.y - other.y - peerShape.y) >=
          shape.radius + peerShape.radius + 11.99, 'Optimize Layout kept overlapping visible node groups');
      }
    }
  }
}
assert.ok(layoutNodes.every(node => node.fx === node.x && node.fy === node.y),
  'optimized render positions were not fixed and cached');
assert.equal(tickCount, 0, 'Optimize Layout still ran the non-deterministic force solver');
assert.equal(fitted, true, 'optimized graph was not fitted to the viewport');
assert.deepEqual(layoutEvents, ['paint', 'fit'],
  'Optimize Layout did not paint and fit its final state exactly once');
assert.deepEqual(topology, original, 'Optimize Layout changed the API model');
const separated = layoutNodes.map(node => [node.id, node.x, node.y]);
controller.optimizeTopologyLayout();
assert.deepEqual(layoutNodes.map(node => [node.id, node.x, node.y]), separated,
  'repeated Optimize Layout drifts already separated positions');
assert.match(visualizationSource, /topologyLandscapeLayout\(renderTopology.nodes, renderTopology.edges, width, height\)/,
  'fresh non-star graphs still use cramped native coordinates');
assert.match(visualizationSource, /tightenTopologyNodes\(renderTopology.nodes\)/,
  'topology refresh does not repair overlap after a client cohort grows');
assert.doesNotMatch(visualizationSource, /starSignature|arrangeStar/,
  'a parent change discards the operator positions and reorders extenders');

let redraws = 0;
controller.topology = topology;
controller.updateTopologyVisualization = () => { redraws += 1; };
assert.equal(controller.applyTopologyRefresh(deepClone(topology)), false);
assert.equal(redraws, 0, 'an unchanged two-second refresh redrew the graph');

let signalVisualRefreshes = 0;
controller.clients = [{
  mac: '02:00:00:00:09:00',
  client_metrics: { rssi_dbm: -41, last_updated: metricsUpdated }
}];
controller.apiCall = async endpoint => endpoint === '/topology'
  ? deepClone(topology)
  : { clients: [{
    mac: '02:00:00:00:09:00',
    client_metrics: { rssi_dbm: -72, last_updated: metricsUpdated }
  }] };
controller.refreshTopologySignalVisuals = () => {
  signalVisualRefreshes += 1;
  return true;
};
controller.refreshTopologyData().then(() => {
  assert.equal(signalVisualRefreshes, 2,
    'topology and metric responses must refresh independently without rebuilding the SVG');
  assert.equal(redraws, 0,
    'the two-second client-metrics poll rebuilt the topology SVG');
  console.log('PASS: topology layout, exact backhaul parent, live signal, STA dragging and steering cues preserve the API model');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
