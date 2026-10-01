#!/usr/bin/env node

'use strict';

const assert = require('assert').strict;
const path = require('path');

if (process.argv.length !== 3) {
  console.error(`Usage: ${path.basename(process.argv[1])} SCRIPT_JS`);
  process.exit(2);
}

global.document = { addEventListener() {}, getElementById() { return null; } };
global.window = { addEventListener() {} };

const Controller = require(path.resolve(process.argv[2]));
const controller = new Controller();
const observed = secondsAgo => new Date(Date.now() - secondsAgo * 1000).toISOString();

const freshDevice = {
  role: 'Extender-1', backhaul_type: 'Wireless LAN',
  backhaul_signal: {
    status: 'fresh', rcpi: 138, rssi_dbm: -41,
    observed_at: observed(5), source: 'ieee1905-associated-sta-link-metrics'
  }
};
const fresh = controller.deviceBackhaulSignal(freshDevice);
assert.equal(fresh.available, true);
assert.equal(fresh.rcpi, 138);
assert.equal(fresh.rssi, -41);
assert.match(controller.deviceBackhaulSignalDisplay(freshDevice), /-41 dBm \(RCPI 138, [0-9]+s old\)/);

const staleDevice = structuredClone(freshDevice);
staleDevice.backhaul_signal = {
  status: 'stale', rcpi: 100, rssi_dbm: -60, observed_at: observed(30)
};
assert.match(controller.deviceBackhaulSignalDisplay(staleDevice),
  /Stale — last -60 dBm \(RCPI 100, [0-9]+s old\)/);

const unknownDevice = structuredClone(freshDevice);
unknownDevice.backhaul_signal = { status: 'unknown' };
assert.equal(controller.deviceBackhaulSignalDisplay(unknownDevice),
  'Unknown — no fresh link metric');
assert.equal(controller.deviceBackhaulSignalDisplay({
  role: 'Agent-1', backhaul_type: 'Ethernet'
}), 'Local / Ethernet');

assert.match(controller.createDeviceCard.toString(), /deviceBackhaulSignalDisplay/,
  'Mesh Devices card does not use the freshness-aware backhaul signal');
assert.match(controller.startRefreshTimers.toString(), /currentTab === 'devices'/,
  'Mesh Devices does not refresh while visible');

(async () => {
  let listUpdates = 0;
  let badgeUpdates = 0;
  controller.apiCall = async endpoint => {
    assert.equal(endpoint, '/devices');
    return { devices: [freshDevice] };
  };
  controller.updateDevicesList = () => { listUpdates += 1; };
  controller.updateCountBadges = () => { badgeUpdates += 1; };
  await controller.refreshDevices();
  assert.equal(controller.devices.length, 1);
  assert.equal(listUpdates, 1);
  assert.equal(badgeUpdates, 1);
  assert.equal(controller.devicesRefreshInFlight, false);
  console.log('PASS: Mesh Devices reports and refreshes exact fresh, stale and unknown backhaul signal');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
