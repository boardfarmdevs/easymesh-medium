#!/usr/bin/env node

'use strict';

const assert = require('assert').strict;
const path = require('path');
const fs = require('fs');

if (process.argv.length !== 3) {
  console.error(`Usage: ${path.basename(process.argv[1])} SCRIPT_JS`);
  process.exit(2);
}

global.document = { addEventListener() {}, getElementById() { return null; } };
global.window = { addEventListener() {} };

const Controller = require(path.resolve(process.argv[2]));
const signalMeter = require(path.join(path.dirname(path.resolve(process.argv[2])), 'signal-meter.js'));
const controller = new Controller();
const visualizationSource = controller.updateTopologyVisualization.toString();
assert.doesNotMatch(visualizationSource, /drawTopologySignalLegend/);
assert.doesNotMatch(fs.readFileSync(path.join(path.dirname(path.resolve(process.argv[2])), 'index.html'), 'utf8'),
  /signal-meter-legend|Signal bars fill bottom to top/);
const now = Date.now();
const observed = secondsAgo => new Date(now - secondsAgo * 1000).toISOString();

const freshEdge = {
  from: 'agent-1', to: 'extender-1', band: 1, channel: 36,
  upstreamBSSID: '02:00:00:00:00:11',
  signal: {
    status: 'fresh', rcpi: 138, rssi_dbm: -41,
    observed_at: observed(5), source: 'ieee1905-associated-sta-link-metrics'
  }
};
const fresh = controller.topologyBackhaulSignal(freshEdge);
assert.equal(fresh.status, 'fresh');
assert.equal(fresh.available, true);
assert.equal(fresh.rssi, -41);
assert.equal(fresh.rcpi, 138);
assert.match(controller.topologyBackhaulLinkLabel(freshEdge), /5G · ch 36 · -41 dBm/);
assert.match(controller.topologyBackhaulSignalHTML(freshEdge), /RCPI 138/);

const weakest = controller.topologyBackhaulSignal({
  ...freshEdge,
  signal: { status: 'fresh', rcpi: 0, rssi_dbm: -110, observed_at: observed(5) }
});
assert.equal(weakest.status, 'fresh', 'timestamped RCPI 0 was mistaken for absence');
assert.equal(weakest.rssi, -110);

const legacy = controller.topologyBackhaulSignal({
  ...freshEdge, signal: undefined,
  rcpi: 138, rssi: -41, signalObservedAt: observed(5)
});
assert.equal(legacy.status, 'fresh', 'legacy flat API telemetry lost freshness classification');

const future = controller.topologyBackhaulSignal({
  ...freshEdge,
  signal: {
    status: 'fresh', rcpi: 138, rssi_dbm: -41,
    observed_at: new Date(now + 6000).toISOString()
  }
});
assert.equal(future.status, 'unknown', 'future timestamp was presented as a current signal');

const staleEdge = {
  ...freshEdge,
  signal: { status: 'stale', rcpi: 100, rssi_dbm: -60, observed_at: observed(30) }
};
const stale = controller.topologyBackhaulSignal(staleEdge);
assert.equal(stale.status, 'stale');
assert.equal(stale.available, false);
assert.equal(stale.rssi, -60);
assert.match(controller.topologyBackhaulSignalHTML(staleEdge), /stale — last -60 dBm/);
assert.match(controller.topologyBackhaulLinkLabel(staleEdge), /· stale$/);

const unknownEdge = { ...freshEdge, signal: { status: 'unknown' } };
const unknown = controller.topologyBackhaulSignal(unknownEdge);
assert.equal(unknown.status, 'unknown');
assert.equal(unknown.rssi, null);
assert.equal(unknown.rcpi, null);
assert.match(controller.topologyBackhaulSignalHTML(unknownEdge), /unknown/);
assert.match(controller.topologyBackhaulLinkLabel(unknownEdge), /signal \?$/);

const unresolvedWireless = {
  ...unknownEdge, band: -1, channel: 0, mediaType: 'IEEE 802.11'
};
assert.equal(controller.topologyIsWirelessBackhaul(unresolvedWireless), true,
  'wireless extender disappeared while radio inventory was incomplete');
assert.match(controller.topologyBackhaulLinkLabel(unresolvedWireless), /\?G · ch \? · signal \?/);
assert.equal(controller.topologyIsWirelessBackhaul({
  ...unresolvedWireless, mediaType: 'Ethernet'
}), false, 'Ethernet backhaul was presented as radio signal telemetry');

function renderMeter(edge) {
  const segments = Array.from({length: 10}, () => ({}));
  const attributes = {};
  const selection = {
    attr(name, value) { attributes[name] = value; return this; },
    select() { return {text(value) { attributes.title = value; }}; },
    selectAll(selector) {
      assert.equal(selector, 'rect.backhaul-signal-segment');
      return {
        attr(name, value) {
          segments.forEach((segment, index) => {
            segment[name] = typeof value === 'function' ? value(index) : value;
          });
          return this;
        }
      };
    }
  };
  controller.updateTopologyBackhaulMeter(selection, edge);
  return {segments, attributes};
}

const meterEdge = {...freshEdge, source: {name: 'Agent-1', x: 0}, target: {x: 300}};
const originalMeterEdge = structuredClone(meterEdge);
const strongMeter = renderMeter(meterEdge);
assert.deepEqual(strongMeter.segments.map(segment => segment.fill),
  Array.from({length: 10}, (_value, index) => signalMeter.segmentColor(index, 10)));
assert.ok(strongMeter.segments.every(segment => segment.x > 15),
  'extender meter was placed on the side facing its parent link');
assert.match(strongMeter.attributes['aria-label'], /Uplink to Agent-1: -41 dBm/);
assert.equal(strongMeter.attributes['data-signal-status'], 'fresh');
assert.deepEqual(meterEdge, originalMeterEdge, 'meter rendering mutated the controller signal');
assert.ok(renderMeter({...meterEdge, target: {x: -300}}).segments.every(segment => segment.x < -20));
assert.equal(renderMeter({...freshEdge, signal: {
  status: 'fresh', rcpi: 60, rssi_dbm: -80, observed_at: observed(1)
}}).segments.filter(segment => segment.fill !== signalMeter.colors.grey).length, 3,
  'weak uplink did not use the shared ten-level signal scale');
for (const edge of [staleEdge, unknownEdge]) {
  const meter = renderMeter(edge);
  assert.ok(meter.segments.every(segment => segment.fill === signalMeter.colors.grey),
    'stale or unknown uplink was presented as a current strong signal');
  assert.match(meter.attributes['aria-label'], /stale|unknown/);
}

const restoredMeter = renderMeter({...meterEdge, signal: {
  status: 'fresh', rcpi: 86, rssi_dbm: -67, observed_at: observed(1)
}});
assert.deepEqual(restoredMeter.segments.map(segment => segment.fill), [
  ...Array(3).fill(signalMeter.colors.red), ...Array(2).fill(signalMeter.colors.yellow),
  ...Array(5).fill(signalMeter.colors.grey),
]);

const topology = {
  nodes: [{ id: 'agent-1' }, { id: 'extender-1' }],
  edges: [freshEdge]
};
const changedMetric = structuredClone(topology);
changedMetric.edges[0].signal.rcpi = 100;
changedMetric.edges[0].signal.rssi_dbm = -60;
changedMetric.edges[0].signal.observed_at = observed(2);
assert.equal(controller.topologySignature(topology), controller.topologySignature(changedMetric),
  'backhaul telemetry was treated as a topology/layout change');
assert.notEqual(controller.topologyBackhaulSignalSignature(topology),
  controller.topologyBackhaulSignalSignature(changedMetric),
  'backhaul metric change was not detected');

let redraws = 0;
let signalRefreshes = 0;
controller.topology = structuredClone(topology);
controller.updateTopologyVisualization = () => { redraws += 1; };
controller.refreshTopologyBackhaulSignalVisuals = () => {
  signalRefreshes += 1;
  return true;
};
assert.equal(controller.applyTopologyRefresh(changedMetric), false);
assert.equal(redraws, 0, 'metric-only refresh rebuilt the D3 topology');
assert.equal(signalRefreshes, 1, 'metric-only refresh did not update edge signal in place');
assert.equal(controller.topology.edges[0].signal.rcpi, 100,
  'latest API signal snapshot was not retained');

assert.equal(controller.applyTopologyRefresh(structuredClone(changedMetric)), false);
assert.equal(signalRefreshes, 2,
  'unchanged wire telemetry did not refresh its locally advancing age');

const structuralChange = structuredClone(changedMetric);
structuralChange.edges[0].channel = 44;
assert.equal(controller.applyTopologyRefresh(structuralChange), true);
assert.equal(redraws, 1, 'a real backhaul topology change did not redraw');

assert.match(visualizationSource, /topologyBackhaulSignalHTML/,
  'extender and edge hovers do not use explicit freshness semantics');
assert.match(visualizationSource, /topologyBackhaulLinkLabel/,
  'backhaul labels do not display each extender signal state');
assert.match(visualizationSource, /filter\(d => self\.topologyIsWirelessBackhaul\(d\)\)/,
  'wireless extenders without resolved radio inventory do not receive a signal label');

console.log('PASS: extender backhaul signal reports fresh, stale and unknown without relayout');
