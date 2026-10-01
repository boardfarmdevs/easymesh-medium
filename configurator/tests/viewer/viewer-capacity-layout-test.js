'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('../../worlds/viewer/vendor/three.min.js');
const source = fs.readFileSync(path.resolve(__dirname,
  '../../worlds/viewer/index.html'), 'utf8');
const helpers = source.slice(source.indexOf('  function roomCameraRadius('),
  source.indexOf('  function fitWorldCamera('));
const context = vm.createContext({});
vm.runInContext(helpers, context);

for (const size of [{width: 20, height: 14}, {width: 40, height: 40}, {width: 80, height: 10}]) {
  for (const aspect of [0.5, 1, 16 / 9, 2.8]) {
    for (const phi of [0.15, 0.95, 1.45]) {
      const theta = -0.9;
      const radius = context.roomCameraRadius(size, aspect, 40, theta, phi);
      const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, radius * 4);
      camera.position.set(radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi), radius * Math.sin(phi) * Math.cos(theta));
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      const height = 3.5 * Math.max(1, Math.min(2, Math.max(size.width, size.height) / 20));
      for (const offsetX of [-size.width / 2, size.width / 2]) {
        for (const offsetZ of [-size.height / 2, size.height / 2]) {
          for (const offsetY of [0, height]) {
            const projected = new THREE.Vector3(offsetX, offsetY, offsetZ).project(camera);
            assert.ok(Math.abs(projected.x) <= 1 / 1.08 + 1e-9);
            assert.ok(Math.abs(projected.y) <= 1 / 1.08 + 1e-9);
            assert.ok(projected.z > -1 && projected.z < 1);
          }
        }
      }
    }
  }
}

const panel = source.slice(source.indexOf('  function renderLivePanels()'),
  source.indexOf('      const hero =', source.indexOf('  function renderLivePanels()'))) + '\n    }\n  }';
for (const [actual, expected, room, capacity] of [[50, 50, 50, 100], [12, 10, 20, 100], [0, 0, 20, 100], [12, undefined, 12, undefined]]) {
  const elements = new Map();
  const panelContext = vm.createContext({
    liveMode: true, replayMode: false, storyState: '', esc: value => String(value ?? '—'),
    world: {counts: {stations: room}},
    healthState: {expected_online_clients: expected, pool_clients: capacity},
    networkState: {health: {clients: actual, mesh_devices: 5}},
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, {});
      return elements.get(selector);
    },
  });
  vm.runInContext(panel, panelContext);
  panelContext.renderLivePanels();
  assert.ok(elements.get('#labMetrics').innerHTML.includes(`<span>Online clients</span><b>${actual} / ${expected ?? room}</b>`));
  assert.ok(elements.get('#labMetrics').innerHTML.includes(`<span>Client capacity</span><b>${capacity ?? '—'}</b>`));
}

assert.match(source, /if \(!world \|\| !autoFitCamera\) return;/);
assert.match(source, /autoFitCamera = false;/);
assert.doesNotMatch(source, /esc\(api\.clients\) \+ ' \/ 20/);
console.log('PASS: room counts, zero/unknown targets and aspect-aware full-floor camera framing');
