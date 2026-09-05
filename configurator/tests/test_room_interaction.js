'use strict';

const assert = require('assert');
const model = require('../worlds/viewer/interaction-model.js');

const world = {
  roles: {gateway: 'fronthaul_ap', extender_1: 'fronthaul_ap', sta_01: 'station'},
  space: {width_m: 10, height_m: 6},
  propagation: {
    reference_distance_m: 1,
    reference_snr_db_by_band: {'2.4': 54, '5': 50, '6': 47},
    path_loss_exponent: 2,
    minimum_snr_db: -20,
    maximum_snr_db: 60,
  },
  walls: [
    {name: 'partition', start: [5, 0], end: [5, 6], loss_db: 5},
    {name: 'north', start: [0, 5.5], end: [10, 5.5], loss_db: 3},
  ],
};

const generation = {
  positions: {gateway: [1, 2], extender_1: [9, 2], sta_01: [2, 2]},
  present: {gateway: true, extender_1: true, sta_01: true},
  links: [
    {
      link_class: 'fronthaul', source_role: 'gateway', destination_role: 'sta_01',
      distance_m: 1, wall_loss_db: 0,
      snr_db_by_band: {'2.4': 54, '5': 50, '6': 47},
    },
    {
      link_class: 'fronthaul', source_role: 'extender_1', destination_role: 'sta_01',
      distance_m: 7, wall_loss_db: 5,
      snr_db_by_band: {'2.4': 32, '5': 28, '6': 25},
    },
    {
      link_class: 'backhaul', source_role: 'gateway', destination_role: 'extender_1',
      distance_m: 8, wall_loss_db: 5,
      snr_db_by_band: {'2.4': 31, '5': 27, '6': 24},
    },
    {
      link_class: 'backhaul', source_role: 'extender_1', destination_role: 'gateway',
      distance_m: 8, wall_loss_db: 5,
      snr_db_by_band: {'2.4': 31, '5': 27, '6': 24},
    },
  ],
};

assert.deepStrictEqual(model.clampPosition(world, [-3, 8]), [0.15, 5.85]);
assert.strictEqual(model.segmentsCross([1, 2], [9, 2], [5, 0], [5, 6]), true);
assert.strictEqual(model.segmentsCross([1, 2], [4, 2], [5, 0], [5, 6]), false);

const path = model.pathAnalysis(world, [1, 2], [9, 2]);
assert.strictEqual(path.wall_count, 1);
assert.strictEqual(path.wall_loss_db, 5);
assert.deepStrictEqual(path.walls.map((wall) => wall.name), ['partition']);

const nearExtender = model.predictLinks(world, generation, 'sta_01', [8, 2], '5');
assert.strictEqual(nearExtender[0].role, 'extender_1');
assert.strictEqual(nearExtender[0].distance_m, 1);
assert.strictEqual(nearExtender[0].wall_count, 0);
assert.strictEqual(nearExtender[0].snr_db, 50);
assert.strictEqual(nearExtender[1].wall_count, 1);

const movedPositions = Object.assign({}, generation.positions, {extender_1: [3, 2]});
const afterExtenderMove = model.predictLinks(
  world, generation, 'sta_01', generation.positions.sta_01, '5', movedPositions);
assert.strictEqual(afterExtenderMove[0].role, 'extender_1');
assert.strictEqual(afterExtenderMove[0].distance_m, 1);
assert.strictEqual(afterExtenderMove[0].wall_count, 0);

const meshPeers = model.predictMeshLinks(
  world, generation, 'extender_1', movedPositions.extender_1, '5', movedPositions);
assert.strictEqual(meshPeers.length, 1);
assert.strictEqual(meshPeers[0].role, 'gateway');
assert.strictEqual(meshPeers[0].distance_m, 2);
assert.strictEqual(meshPeers[0].wall_count, 0);
assert.strictEqual(meshPeers[0].snr_db, 44);

assert.deepStrictEqual(model.interpolate([1, 1], [5, 3], 0.5), [3, 2]);
assert.strictEqual(model.movementDurationMs([0, 0], [3, 4], 1), 5000);
assert.throws(() => model.movementDurationMs([0, 0], [1, 0], 0), /positive/);

console.log('room interaction model: tests passed');
