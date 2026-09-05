/*
 * Pure geometry and link-budget helpers for the interactive room viewer.
 *
 * Keep this file free of DOM and Three.js dependencies so the browser and the
 * command-line regression test exercise exactly the same calculations.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RoomInteractionModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BANDS = ['2.4', '5', '6'];
  const DEFAULT_PROPAGATION = {
    reference_distance_m: 1,
    reference_snr_db_by_band: {'2.4': 54, '5': 50, '6': 47},
    path_loss_exponent: 2.2,
    minimum_snr_db: -20,
    maximum_snr_db: 60,
  };

  function orientation(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) -
      (b[1] - a[1]) * (c[0] - a[0]);
  }

  function segmentsCross(a, b, c, d) {
    const abC = orientation(a, b, c);
    const abD = orientation(a, b, d);
    const cdA = orientation(c, d, a);
    const cdB = orientation(c, d, b);
    return (abC > 0 && abD < 0 || abD > 0 && abC < 0) &&
      (cdA > 0 && cdB < 0 || cdB > 0 && cdA < 0);
  }

  function roomSize(world) {
    if (world && world.space) {
      return {
        width: Number(world.space.width_m),
        height: Number(world.space.height_m),
      };
    }
    const positions = (world && world.generations || [])
      .flatMap((generation) => Object.values(generation.positions || {}));
    return {
      width: Math.max(20, Math.ceil(Math.max(0, ...positions.map((p) => Number(p[0]))) + 1)),
      height: Math.max(14, Math.ceil(Math.max(0, ...positions.map((p) => Number(p[1]))) + 1)),
    };
  }

  function clampPosition(world, point, margin = 0.15) {
    const size = roomSize(world);
    return [
      Math.max(margin, Math.min(size.width - margin, Number(point[0]))),
      Math.max(margin, Math.min(size.height - margin, Number(point[1]))),
    ];
  }

  function pathAnalysis(world, a, b) {
    const crossed = (world.walls || []).filter((wall) =>
      segmentsCross(a, b, wall.start, wall.end));
    return {
      distance_m: Math.hypot(b[0] - a[0], b[1] - a[1]),
      walls: crossed,
      wall_count: crossed.length,
      wall_loss_db: crossed.reduce((sum, wall) => sum + Number(wall.loss_db || 0), 0),
    };
  }

  function propagation(world) {
    const supplied = world.propagation || {};
    return {
      reference_distance_m: Number(supplied.reference_distance_m || DEFAULT_PROPAGATION.reference_distance_m),
      reference_snr_db_by_band: Object.assign(
        {}, DEFAULT_PROPAGATION.reference_snr_db_by_band,
        supplied.reference_snr_db_by_band || {}),
      path_loss_exponent: Number(supplied.path_loss_exponent || DEFAULT_PROPAGATION.path_loss_exponent),
      minimum_snr_db: Number.isFinite(Number(supplied.minimum_snr_db))
        ? Number(supplied.minimum_snr_db) : DEFAULT_PROPAGATION.minimum_snr_db,
      maximum_snr_db: Number.isFinite(Number(supplied.maximum_snr_db))
        ? Number(supplied.maximum_snr_db) : DEFAULT_PROPAGATION.maximum_snr_db,
    };
  }

  function median(values) {
    if (!values.length) return null;
    const ordered = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  /*
   * Older signed world artifacts do not embed their propagation declaration.
   * Recover the reference SNR from their generated, non-clamped links. This
   * preserves an exact preview for the current golden worlds while allowing a
   * future artifact to carry the propagation object explicitly.
   */
  function inferredReferenceSnr(
    world, generation, role, band, linkClass = 'fronthaul'
  ) {
    const model = propagation(world);
    const values = [];
    for (const link of generation.links || []) {
      if (link.link_class !== linkClass || link.destination_role !== role) continue;
      if (linkClass === 'fronthaul' &&
          (!world.roles || world.roles[link.source_role] === 'station')) continue;
      const snr = Number(link.snr_db_by_band && link.snr_db_by_band[band]);
      if (!Number.isFinite(snr) || snr <= model.minimum_snr_db || snr >= model.maximum_snr_db) continue;
      const distance = Math.max(Number(link.distance_m), model.reference_distance_m);
      const pathLoss = 10 * model.path_loss_exponent *
        Math.log10(distance / model.reference_distance_m);
      values.push(snr + pathLoss + Number(link.wall_loss_db || 0));
    }
    const inferred = median(values);
    return inferred == null ? Number(model.reference_snr_db_by_band[band]) : inferred;
  }

  function predictLinks(world, generation, role, point, band, positions = null) {
    if (!BANDS.includes(String(band))) throw new Error('unsupported band ' + band);
    const model = propagation(world);
    const referenceSnr = inferredReferenceSnr(world, generation, role, String(band));
    const results = [];
    for (const peer of Object.keys(world.roles || {})) {
      if (world.roles[peer] === 'station' || !generation.present[peer]) continue;
      const peerPoint = positions && positions[peer]
        ? positions[peer] : generation.positions[peer];
      if (!peerPoint) continue;
      const path = pathAnalysis(world, peerPoint, point);
      const distance = Math.max(path.distance_m, model.reference_distance_m);
      const pathLoss = 10 * model.path_loss_exponent *
        Math.log10(distance / model.reference_distance_m);
      const raw = Math.round(referenceSnr - pathLoss - path.wall_loss_db);
      results.push({
        role: peer,
        distance_m: path.distance_m,
        wall_count: path.wall_count,
        walls: path.walls,
        wall_loss_db: path.wall_loss_db,
        path_loss_db: pathLoss,
        snr_db: Math.max(model.minimum_snr_db, Math.min(model.maximum_snr_db, raw)),
      });
    }
    return results.sort((a, b) => b.snr_db - a.snr_db || a.role.localeCompare(b.role));
  }

  function predictMeshLinks(world, generation, role, point, band, positions = null) {
    if (!BANDS.includes(String(band))) throw new Error('unsupported band ' + band);
    const model = propagation(world);
    const referenceSnr = inferredReferenceSnr(
      world, generation, role, String(band), 'backhaul');
    const results = [];
    for (const peer of Object.keys(world.roles || {})) {
      if (peer === role || world.roles[peer] === 'station' || !generation.present[peer]) continue;
      const peerPoint = positions && positions[peer]
        ? positions[peer] : generation.positions[peer];
      if (!peerPoint) continue;
      const path = pathAnalysis(world, peerPoint, point);
      const distance = Math.max(path.distance_m, model.reference_distance_m);
      const pathLoss = 10 * model.path_loss_exponent *
        Math.log10(distance / model.reference_distance_m);
      const raw = Math.round(referenceSnr - pathLoss - path.wall_loss_db);
      results.push({
        role: peer,
        distance_m: path.distance_m,
        wall_count: path.wall_count,
        walls: path.walls,
        wall_loss_db: path.wall_loss_db,
        path_loss_db: pathLoss,
        snr_db: Math.max(model.minimum_snr_db, Math.min(model.maximum_snr_db, raw)),
      });
    }
    return results.sort((a, b) => b.snr_db - a.snr_db || a.role.localeCompare(b.role));
  }

  function interpolate(a, b, fraction) {
    const f = Math.max(0, Math.min(1, Number(fraction)));
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  function movementDurationMs(a, b, speedMps) {
    const speed = Number(speedMps);
    if (!(speed > 0)) throw new Error('movement speed must be positive');
    return Math.hypot(b[0] - a[0], b[1] - a[1]) / speed * 1000;
  }

  return {
    BANDS,
    clampPosition,
    interpolate,
    movementDurationMs,
    pathAnalysis,
    predictLinks,
    predictMeshLinks,
    roomSize,
    segmentsCross,
  };
}));
