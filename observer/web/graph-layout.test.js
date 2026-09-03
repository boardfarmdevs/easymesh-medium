'use strict';

const assert = require('node:assert/strict');
const graph = require('./graph-layout.js');

const stations = [];
for (let index = 0; index < 5; index += 1) stations.push({ mac: `42:00:00:00:0${index}:00`, label: index ? `extender-${index}` : 'agent-1', role: index ? 'extender' : 'controller-agent' });
for (let index = 5; index < 25; index += 1) stations.push({ mac: `42:00:00:00:${index.toString(16).padStart(2, '0')}:00`, label: index < 15 ? `sta-${index.toString(16).padStart(2, '0')}` : `iot-${index.toString(16).padStart(2, '0')}`, role: index < 15 ? 'wlan-client' : 'iot-client' });

const positions = graph.layoutStations(stations, stations[0].mac);
assert.equal(positions.size, 25);
for (const station of stations) {
  const position = positions.get(station.mac);
  assert.ok(position.x - position.radius >= 0 && position.x + position.radius <= 1000);
  assert.ok(position.y - position.radius >= 0 && position.y + position.radius <= 560);
  assert.ok(graph.labelFontSize(station.label, position.radius) >= 7);
}

const obstaclePositions = new Map([
  ['a', { x: 100, y: 100, radius: 30 }],
  ['obstacle', { x: 200, y: 100, radius: 30 }],
  ['b', { x: 300, y: 100, radius: 30 }],
]);
const route = graph.edgeRoute(obstaclePositions, { source: 'a', destination: 'b' }, 400, 240);
assert.equal(route.kind, 'curve');
assert.match(route.path, / Q /);
assert.ok(graph.quadraticCollisionFree(route.start, route.control, route.end, obstaclePositions, 'a', 'b', 400, 240));
assert.notDeepEqual(route.start, obstaclePositions.get('a'));
assert.notDeepEqual(route.end, obstaclePositions.get('b'));

const associationSnapshot = {
  stations: [
    { mac: 'agent', role: 'controller-agent' },
    { mac: 'extender', role: 'extender' },
    { mac: 'sta', role: 'wlan-client' },
    { mac: 'iot', role: 'iot-client' },
  ],
  active_links: [
    // Broadcast fan-out is receiver-candidate telemetry, not association.
    { source: 'agent', destination: 'sta', multicast: true, frames: 80, last_seen_usec: 900 },
    { source: 'agent', destination: 'iot', multicast: true, frames: 0, rx_injected: 1, last_seen_usec: 950 },
    // Stale and current unicast paths for sta: freshest path must win.
    { source: 'sta', destination: 'agent', multicast: false, frames: 20, last_seen_usec: 100, last_update_sequence: 2, band: '2.4GHz', channel: 6 },
    { source: 'extender', destination: 'sta', multicast: false, frames: 5, last_seen_usec: 200, last_update_sequence: 3, band: '5GHz', channel: 36 },
    // A downlink observation is normalized client -> infrastructure.
    { source: 'agent', destination: 'iot', multicast: false, frames: 4, last_seen_usec: 300, last_update_sequence: 4, band: '6GHz', channel: 1 },
    // A zero-counter allocation is not an observed path.
    { source: 'iot', destination: 'extender', multicast: false, frames: 0, last_seen_usec: 400 },
  ],
};
const associations = graph.currentAssociations(associationSnapshot);
assert.deepEqual(associations.map((link) => [link.source, link.destination, link.band, link.channel]), [
  ['iot', 'agent', '6GHz', 1],
  ['sta', 'extender', '5GHz', 36],
]);
assert.deepEqual(graph.associationsForSelected(associationSnapshot, 'extender').map((link) => link.source), ['sta']);
assert.deepEqual(graph.associationsForSelected(associationSnapshot, 'iot').map((link) => link.destination), ['agent']);

const authoritativeSnapshot = {
  stations: associationSnapshot.stations,
  associations: [{ station: 'sta', owner: 'extender', frequency_mhz: 5180, band: '5GHz', channel: 36, evidence: 'infrastructure data' }],
  active_links: [{ source: 'extender', destination: 'sta', frequency_mhz: 5180, multicast: true, frames: 500, last_seen_usec: 90, last_snr_db: 35 }],
};
assert.deepEqual(graph.currentAssociations(authoritativeSnapshot).map((link) => [link.source, link.destination, link.authoritative, link.last_snr_db]), [
  ['sta', 'extender', true, 35],
]);
assert.equal(graph.hasObservedTraffic({ frames: 0, attempts: 0 }), false);
assert.equal(graph.hasObservedTraffic({ frames: 0, drops_per: 1 }), true);

const inventoryWithReserve = {
  stations: [
    { mac: 'agent', role: 'controller-agent' },
    { mac: 'sta', role: 'wlan-client' },
    { mac: 'reserve', label: 'Spare-39', role: 'spare' },
  ],
  active_links: [
    { source: 'sta', destination: 'agent', frames: 1 },
    { source: 'sta', destination: 'reserve', frames: 1 },
  ],
};
assert.deepEqual(graph.visibleStations(inventoryWithReserve).map((station) => station.mac),
  ['agent', 'sta']);
assert.deepEqual(graph.currentAssociations(inventoryWithReserve)
  .map((link) => [link.source, link.destination]), [['sta', 'agent']]);
