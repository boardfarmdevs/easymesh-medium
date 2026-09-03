'use strict';

(function publish(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WMediumdGraph = api;
}(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  const clientRoles = new Set(['wlan-client', 'iot-client']);

  function isClient(station) {
    return clientRoles.has(station?.role);
  }

  function isVisibleStation(station) {
    return station?.role !== 'spare';
  }

  function visibleStations(snapshot) {
    return (snapshot?.stations || []).filter(isVisibleStation);
  }

  function hasObservedTraffic(link) {
    return Number(link?.frames || 0) > 0
      || Number(link?.attempts || 0) > 0
      || Number(link?.rx_injected || 0) > 0
      || ['drops_offchannel', 'drops_cca', 'drops_interference', 'drops_per', 'drops_no_receiver']
        .some((field) => Number(link?.[field] || 0) > 0);
  }

  function newerLink(candidate, current) {
    if (!current) return true;
    const candidateSeen = Number(candidate.last_seen_usec || 0);
    const currentSeen = Number(current.last_seen_usec || 0);
    if (candidateSeen !== currentSeen) return candidateSeen > currentSeen;
    const candidateSequence = Number(candidate.last_update_sequence || 0);
    const currentSequence = Number(current.last_update_sequence || 0);
    if (candidateSequence !== currentSequence) return candidateSequence > currentSequence;
    return Number(candidate.frames || 0) > Number(current.frames || 0);
  }

  // wmediumd sees raw 802.11 delivery paths, not an association table.  A
  // client's freshest non-multicast exchange with an infrastructure radio is
  // the useful current association observation.  Normalizing both uplink and
  // downlink records prevents multicast receiver candidates from appearing as
  // topology edges and makes the same edge visible from either endpoint.
  function currentAssociations(snapshot) {
    const stations = new Map(visibleStations(snapshot).map((station) => [station.mac, station]));
    if (Array.isArray(snapshot?.associations)) {
      return snapshot.associations.map((association) => {
        const candidates = (snapshot?.active_links || []).filter((link) =>
          Number(link.frequency_mhz || 0) === Number(association.frequency_mhz || 0)
          && ((link.source === association.station && link.destination === association.owner)
            || (link.destination === association.station && link.source === association.owner)));
        const observed = candidates.reduce((current, candidate) => newerLink(candidate, current) ? candidate : current, null);
        return {
          ...(observed || {}),
          source: association.station,
          destination: association.owner,
          frequency_mhz: association.frequency_mhz,
          band: association.band,
          channel: association.channel,
          evidence: association.evidence,
          association: true,
          authoritative: true,
        };
      }).filter((link) => stations.has(link.source) && stations.has(link.destination))
        .sort((left, right) => left.source.localeCompare(right.source));
    }
    const newestByClient = new Map();
    for (const link of snapshot?.active_links || []) {
      if (link.multicast || !hasObservedTraffic(link)) continue;
      const source = stations.get(link.source), destination = stations.get(link.destination);
      let client, infrastructure;
      if (isClient(source) && destination && !isClient(destination)) {
        client = source; infrastructure = destination;
      } else if (source && !isClient(source) && isClient(destination)) {
        client = destination; infrastructure = source;
      } else {
        continue;
      }
      const normalized = { ...link, source: client.mac, destination: infrastructure.mac, association: true };
      if (newerLink(normalized, newestByClient.get(client.mac))) newestByClient.set(client.mac, normalized);
    }
    return [...newestByClient.values()].sort((left, right) => left.source.localeCompare(right.source));
  }

  function associationsForSelected(snapshot, selected) {
    return currentAssociations(snapshot)
      .filter((link) => link.source === selected || link.destination === selected);
  }

  function nodeRadius(station, selected) {
    const base = clientRoles.has(station?.role) ? 29 : 33;
    return base + (station?.mac === selected ? 4 : 0);
  }

  function labelFontSize(label, radius) {
    const characters = Math.max(1, String(label || '').length);
    const fitted = (radius * 1.72) / (characters * 0.62);
    return Math.max(7, Math.min(11, fitted));
  }

  function placeRing(items, radius, centerX, centerY, selected, positions, startAngle = -Math.PI / 2) {
    if (items.length === 1 && radius === 0) {
      const station = items[0];
      positions.set(station.mac, { x: centerX, y: centerY, radius: nodeRadius(station, selected) });
      return;
    }
    items.forEach((station, index) => {
      const angle = startAngle + 2 * Math.PI * index / Math.max(1, items.length);
      positions.set(station.mac, {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
        radius: nodeRadius(station, selected),
      });
    });
  }

  function layoutStations(stations, selected, width = 1000, height = 560) {
    const positions = new Map();
    const infrastructure = stations.filter((station) => !clientRoles.has(station.role));
    const clients = stations.filter((station) => clientRoles.has(station.role));
    const hasIdentityRoles = infrastructure.length > 0 && clients.length > 0;
    if (!hasIdentityRoles) {
      placeRing(stations, Math.min(215, 32 * stations.length), width / 2, height / 2, selected, positions);
      return positions;
    }
    const outerRadius = Math.min(width, height) / 2 - 42;
    placeRing(infrastructure, infrastructure.length === 1 ? 0 : Math.min(112, outerRadius * 0.5), width / 2, height / 2, selected, positions);
    placeRing(clients, outerRadius, width / 2, height / 2, selected, positions, -Math.PI / 2 + Math.PI / Math.max(1, clients.length));
    return positions;
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x, dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
    const projected = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (start.x + projected * dx), point.y - (start.y + projected * dy));
  }

  function obstacles(positions, source, destination) {
    return [...positions.entries()]
      .filter(([mac]) => mac !== source && mac !== destination)
      .map(([, position]) => position);
  }

  function straightCollisionFree(start, end, positions, source, destination, clearance = 7) {
    return obstacles(positions, source, destination)
      .every((position) => distanceToSegment(position, start, end) >= position.radius + clearance);
  }

  function quadraticPoint(start, control, end, time) {
    const remaining = 1 - time;
    return {
      x: remaining * remaining * start.x + 2 * remaining * time * control.x + time * time * end.x,
      y: remaining * remaining * start.y + 2 * remaining * time * control.y + time * time * end.y,
    };
  }

  function quadraticCollisionFree(start, control, end, positions, source, destination, width = 1000, height = 560, clearance = 7) {
    const blocked = obstacles(positions, source, destination);
    for (let step = 1; step < 40; step += 1) {
      const point = quadraticPoint(start, control, end, step / 40);
      if (point.x < 5 || point.x > width - 5 || point.y < 5 || point.y > height - 5) return false;
      if (blocked.some((position) => Math.hypot(point.x - position.x, point.y - position.y) < position.radius + clearance)) return false;
    }
    return true;
  }

  function perimeterPoint(center, target, padding = 3) {
    const dx = target.x - center.x, dy = target.y - center.y;
    const distance = Math.hypot(dx, dy) || 1;
    return {
      x: center.x + dx / distance * (center.radius + padding),
      y: center.y + dy / distance * (center.radius + padding),
    };
  }

  function edgeRoute(positions, link, width = 1000, height = 560) {
    const source = positions.get(link.source), destination = positions.get(link.destination);
    if (!source || !destination) return null;
    const directStart = perimeterPoint(source, destination);
    const directEnd = perimeterPoint(destination, source);
    if (straightCollisionFree(directStart, directEnd, positions, link.source, link.destination)) {
      return { kind: 'line', start: directStart, end: directEnd, path: `M ${directStart.x} ${directStart.y} L ${directEnd.x} ${directEnd.y}` };
    }

    const dx = destination.x - source.x, dy = destination.y - source.y;
    const distance = Math.hypot(dx, dy) || 1;
    const perpendicular = { x: -dy / distance, y: dx / distance };
    const midpoint = { x: (source.x + destination.x) / 2, y: (source.y + destination.y) / 2 };
    const preferredSign = String(link.source) < String(link.destination) ? 1 : -1;
    const offsets = [];
    for (let amount = 40; amount <= 240; amount += 24) offsets.push(amount * preferredSign, -amount * preferredSign);
    for (const offset of offsets) {
      const control = { x: midpoint.x + perpendicular.x * offset, y: midpoint.y + perpendicular.y * offset };
      const start = perimeterPoint(source, control), end = perimeterPoint(destination, control);
      if (!quadraticCollisionFree(start, control, end, positions, link.source, link.destination, width, height)) continue;
      return { kind: 'curve', start, control, end, path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}` };
    }

    // Extremely dense or unidentified layouts can leave no fully clear arc.
    // Retain perimeter clipping and use a deterministic outer curve so the
    // link never disappears beneath either endpoint bubble.
    const offset = 240 * preferredSign;
    const control = { x: midpoint.x + perpendicular.x * offset, y: midpoint.y + perpendicular.y * offset };
    const start = perimeterPoint(source, control), end = perimeterPoint(destination, control);
    return { kind: 'curve', start, control, end, path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}` };
  }

  function edgePath(positions, link, width = 1000, height = 560) {
    return edgeRoute(positions, link, width, height)?.path || '';
  }

  return {
    associationsForSelected,
    currentAssociations,
    edgePath,
    edgeRoute,
    hasObservedTraffic,
    isVisibleStation,
    labelFontSize,
    layoutStations,
    nodeRadius,
    quadraticCollisionFree,
    visibleStations,
  };
}));
