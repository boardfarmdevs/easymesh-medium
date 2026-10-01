(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./room-projection.js') : root.RoomProjection);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoomTopology = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (roomProjection) {
  'use strict';
  const identity = value => String(value || '').toLowerCase();
  const validPosition = value => Array.isArray(value) && value.length === 2 &&
    value.every(coordinate => Number.isFinite(coordinate) && Math.abs(coordinate) <= 100000);

  function compact(nodes, footprintFor, anchorId) {
    const anchor = nodes.find(node => String(node.id) === String(anchorId)) || nodes[0];
    const result = new Map();
    if (!anchor) return result;
    const footprints = new Map(nodes.map(node => [String(node.id), footprintFor(node)]));
    let scale = 0;
    for (const [index, left] of nodes.entries()) {
      for (const right of nodes.slice(index + 1)) {
        const deltaX = right.x - left.x, deltaY = right.y - left.y;
        const squaredDistance = deltaX * deltaX + deltaY * deltaY;
        if (squaredDistance < 0.01) { scale = 1; continue; }
        for (const leftShape of footprints.get(String(left.id))) {
          for (const rightShape of footprints.get(String(right.id))) {
            const offsetX = rightShape.x - leftShape.x, offsetY = rightShape.y - leftShape.y;
            const minimum = leftShape.radius + rightShape.radius + 12;
            const dot = deltaX * offsetX + deltaY * offsetY;
            const discriminant = dot * dot - squaredDistance * (offsetX * offsetX + offsetY * offsetY - minimum * minimum);
            if (discriminant < 0) continue;
            scale = Math.max(scale, (-dot + Math.sqrt(discriminant)) / squaredDistance);
          }
        }
      }
    }
    scale = Math.max(0.001, scale);
    if (Math.abs(scale - 1) < 1e-9) scale = 1;
    for (const node of nodes) result.set(String(node.id), scale === 1 ? {x: node.x, y: node.y} : {
      x: anchor.x + (node.x - anchor.x) * scale,
      y: anchor.y + (node.y - anchor.y) * scale
    });
    return result;
  }

  function pack(nodes, footprintFor, anchorId) {
    const result = compact(nodes, footprintFor, anchorId);
    const mesh = nodes.map(node => ({id: String(node.id), ...result.get(String(node.id)),
      shapes: footprintFor(node)}));
    const anchor = mesh.find(node => node.id === String(anchorId)) || mesh[0];
    if (!anchor) return result;
    const ordered = mesh.filter(node => node !== anchor).sort((left, right) =>
      Math.hypot(left.x - anchor.x, left.y - anchor.y) - Math.hypot(right.x - anchor.x, right.y - anchor.y) ||
      left.id.localeCompare(right.id));
    for (let pass = 0; pass < 24; pass++) {
      let moved = false;
      for (const node of ordered) {
        const delta = {x: anchor.x - node.x, y: anchor.y - node.y};
        const distanceSquared = delta.x * delta.x + delta.y * delta.y;
        if (distanceSquared < 0.01) continue;
        let fraction = 1;
        for (const peer of mesh) {
          if (node === peer) continue;
          for (const axis of ['x', 'y']) {
            if ((node[axis] - peer[axis]) * delta[axis] < 0) {
              fraction = Math.min(fraction, (peer[axis] - node[axis]) / delta[axis]);
            }
          }
          for (const shape of node.shapes) {
            for (const other of peer.shapes) {
              const relativeX = node.x + shape.x - peer.x - other.x;
              const relativeY = node.y + shape.y - peer.y - other.y;
              const minimum = shape.radius + other.radius + 12;
              const dot = relativeX * delta.x + relativeY * delta.y;
              const clearance = Math.max(0, relativeX * relativeX + relativeY * relativeY - minimum * minimum);
              const discriminant = dot * dot - distanceSquared * clearance;
              if (dot < 0 && discriminant >= 0) {
                fraction = Math.min(fraction, Math.max(0, (-dot - Math.sqrt(discriminant)) / distanceSquared));
              }
            }
          }
        }
        if (fraction * Math.sqrt(distanceSquared) < 0.01) continue;
        node.x += delta.x * fraction * 0.999;
        node.y += delta.y * fraction * 0.999;
        moved = true;
      }
      if (!moved) break;
    }
    for (const node of mesh) result.set(node.id, {x: node.x, y: node.y});
    return result;
  }

  function positions(nodes, snapshot, extentFor, projection, footprintFor) {
    const byId = new Map();
    for (const entry of snapshot.nodes || []) {
      if (!entry.device_id || !validPosition(entry.position)) continue;
      const key = identity(entry.device_id);
      if (byId.has(key)) return new Map();
      byId.set(key, entry);
    }
    const controller = nodes.find(node => /^controller$/i.test(node.name || ''));
    const mesh = nodes.filter(node => node !== controller && byId.has(identity(node.id)))
      .map(node => ({id: String(node.id), source: byId.get(identity(node.id)),
        radius: Math.max(350, extentFor(node)), node})).sort((left, right) => left.id.localeCompare(right.id));
    if (!mesh.length) return new Map();
    const gateway = mesh.find(node => node.source.role === 'gateway') || mesh[0];
    const distances = mesh.flatMap((node, index) => mesh.slice(index + 1).map(peer => {
      const delta = roomProjection.floor(node.source.position, peer.source.position);
      return Math.hypot(delta.x, delta.y);
    }))
      .filter(distance => distance > 0.01).sort((left, right) => left - right);
    const typical = distances[Math.floor(distances.length / 2)] || 4;
    const scale = (2 * Math.max(...mesh.map(node => node.radius)) + 48) /
      Math.max(distances[0] || 4, typical / 3, 0.5);
    const frame = projection || {scale, origin: gateway.source.position.slice()};
    for (const node of mesh) {
      const point = roomProjection.floor(node.source.position, frame.origin);
      node.x = point.x * frame.scale;
      node.y = point.y * frame.scale;
    }
    for (let pass = 0; pass < 80; pass += 1) {
      let moved = false;
      for (const [index, left] of mesh.entries()) {
        for (const right of mesh.slice(index + 1)) {
          const deltaX = right.x - left.x, deltaY = right.y - left.y;
          const distance = Math.hypot(deltaX, deltaY);
          const minimum = left.radius + right.radius + 24;
          if (distance >= minimum - 0.01) continue;
          const directionX = distance > 0.01 ? deltaX / distance : 1;
          const directionY = distance > 0.01 ? deltaY / distance : 0;
          const correction = minimum - distance + 0.02;
          const share = left === gateway ? 0 : right === gateway ? 1 : 0.5;
          left.x -= directionX * correction * share;
          left.y -= directionY * correction * share;
          right.x += directionX * correction * (1 - share);
          right.y += directionY * correction * (1 - share);
          moved = true;
        }
      }
      if (!moved) break;
    }
    if (footprintFor) {
      const packed = pack(mesh, entry => footprintFor(entry.node), gateway.id);
      for (const node of mesh) Object.assign(node, packed.get(node.id));
    }
    const result = new Map(mesh.map(node => [node.id, {x: node.x, y: node.y}]));
    result.projection = frame;
    if (controller && gateway.source.role === 'gateway') {
      const radius = Math.max(80, extentFor(controller));
      let placement;
      for (let ring = 0; ring < 8 && !placement; ring += 1) {
        const distance = (footprintFor ? 80 : gateway.radius) + radius + 24 + ring * radius;
        for (let step = 0; step < 16; step += 1) {
          const angle = -Math.PI / 2 + step * Math.PI / 8;
          const candidate = {x: gateway.x + Math.cos(angle) * distance, y: gateway.y + Math.sin(angle) * distance};
          const clear = mesh.every(node => footprintFor
            ? footprintFor(node.node).every(shape => Math.hypot(node.x + shape.x - candidate.x, node.y + shape.y - candidate.y) >= shape.radius + radius + 12)
            : Math.hypot(node.x - candidate.x, node.y - candidate.y) >= node.radius + radius + 24);
          if (clear) {
            placement = candidate;
            break;
          }
        }
      }
      if (placement) result.set(String(controller.id), placement);
    }
    let outsideX = Math.max(...mesh.map(node => node.x + node.radius)) + 450;
    for (const node of nodes) {
      if (result.has(String(node.id))) continue;
      const radius = Math.max(350, extentFor(node));
      result.set(String(node.id), {x: outsideX + radius, y: 0});
      outsideX += 2 * radius + 32;
    }
    return result;
  }

  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

  function rfHTML(node, observations = {}, now = Date.now(), available = true) {
    const expected = new Map();
    // Backhaul BSSes are left out one by one: an OpenSync pod lists all of its BSSes in one
    // group, whose SSID is whichever BSS came first (mesh_backhaul, at times).
    for (const haul of node.haulTypes || []) {
      if (/backhaul/i.test(haul.name || '')) continue;
      for (const bss of haul.BSSList || []) {
        const ssid = bss.ssid || haul.ssid;
        if (ssid === 'mesh_backhaul' || /backhaul/i.test(bss.haulType || '')) continue;
        expected.set(identity(bss.BSSID), {bssid: bss.BSSID, ssid, band: bss.Band});
      }
    }
    const reports = new Map();
    for (const row of observations.bss_loads || []) {
      if (identity(row.device_id) !== identity(node.id) || !row.bssid) continue;
      const key = identity(row.bssid), previous = reports.get(key);
      if (!previous || Date.parse(row.observed_at) > Date.parse(previous.observed_at)) reports.set(key, row);
      if (!expected.has(key)) expected.set(key, {bssid: row.bssid, ssid: 'BSS'});
    }
    const backhaul = observations.backhaul?.paths?.find(row => identity(row.device_id) === identity(node.id));
    const pathAge = (now - Date.parse(backhaul?.observed_at)) / 1000;
    const pathFresh = available && backhaul?.state === 'valid' && Number.isFinite(pathAge) && pathAge >= 0 && pathAge <= 5;
    const pathValue = record => {
      const age = (now - Date.parse(record?.observed_at)) / 1000;
      return pathFresh && record?.state === 'valid' && Number.isFinite(record.value) && age >= 0 && age <= 5
        ? escapeHTML(record.value + ' ' + record.unit) : '— unavailable';
    };
    const pathHTML = !backhaul ? '' : '<section class="topology-rf"><b>Native backhaul · inspection only</b><small>' +
      (pathFresh ? escapeHTML(backhaul.path.join(' → ')) + ' · ' + backhaul.wireless_hops + ' wireless hops' : 'Path unavailable/stale') + '</small>' +
      (pathFresh ? (backhaul.links || []).map(link => '<small>' + escapeHTML(link.role + ' → ' + link.parent_role) +
        ' · ' + escapeHTML(link.frequency_mhz ?? 'unknown') + ' MHz · signal ' + pathValue(link.signal) +
        ' · utilization ' + pathValue(link.utilization) + ' · traffic ' + pathValue(link.traffic) + '</small>').join('') : '') +
      '<small>Same-frequency hops may contend; load is not additive. No capacity inferred.</small></section>';
    if (!expected.size) return pathHTML;
    const ageLimit = Number.isFinite(observations.maximum_age_seconds) && observations.maximum_age_seconds > 0
      ? Math.min(5, observations.maximum_age_seconds) : 5;
    const bands = {0: '2.4 GHz', 1: '5 GHz', 3: '6 GHz'};
    const entries = [...expected.entries()].sort((left, right) =>
      (Number(left[1].band ?? 99) - Number(right[1].band ?? 99)) || left[0].localeCompare(right[0]));
    const rows = entries.slice(0, 12).map(([key, bss]) => {
      const row = reports.get(key);
      const age = row ? (now - Date.parse(row.observed_at)) / 1000 : NaN;
      const fresh = available && observations.enabled === true && !observations.error &&
        row?.source === 'native_ap_metrics' &&
        ['ieee1905-ethernet', 'prpl-1905-broker', 'prpl-local-broker'].includes(row.transport) &&
        Number.isFinite(age) && age >= 0 && age <= ageLimit;
      const utilization = fresh && Number.isInteger(row.utilization) && row.utilization >= 0 && row.utilization <= 255
        ? row.utilization : null;
      const stations = fresh && Number.isInteger(row.station_count) && row.station_count >= 0 && row.station_count <= 65535
        ? row.station_count : null;
      const percent = utilization === null ? null : (utilization * 100 / 255).toFixed(1);
      const name = bss.ssid === 'private_ssid' ? '"private"' : bss.ssid === 'iot_ssid' ? '"iot"' : bss.ssid;
      const channel = (Number.isInteger(row?.channel) && row.channel > 0 ? ' · ch ' + row.channel : '') +
        (Number.isInteger(row?.frequency_mhz) ? ' · ' + row.frequency_mhz + ' MHz' : '') +
        (row?.context_state === 'unverified' ? ' · RF context unverified' : '');
      const label = escapeHTML(name) + '<small>' + escapeHTML(bands[bss.band] || 'Radio') + channel + '</small>';
      const meter = percent === null ? '<span class="rf-unavailable">— unavailable</span>' :
        '<b>' + percent + '%</b><small>' + utilization + '/255</small>' +
        '<span class="rf-utilization"><span style="width:' + percent + '%"></span></span>';
      const ageText = Number.isFinite(age) && age >= 0 ? age.toFixed(1) + ' s' + (fresh ? '' : ' · stale') : 'unknown';
      return '<tr><td title="' + escapeHTML(bss.bssid + (row?.radio_id ? ' · radio ' + row.radio_id : '')) +
        '">' + label + '</td><td>' + meter + '</td><td>' + (stations ?? '—') +
        '</td><td>' + ageText + '</td></tr>';
    }).join('');
    const status = !available ? 'Room telemetry unavailable; values hidden.' : observations.error
      ? 'Collection unavailable: ' + observations.error : observations.enabled !== true
      ? 'Native AP metrics collector unavailable.' : 'Native AP metrics · report receipt age.';
    const publication = observations.published_at ? '<small>Shared RF observations · independent publication. ' +
      (observations.policy_enabled ? 'Load policy enabled; decision evidence is separate.' : 'Inspection only; load policy disabled.') + '</small>' : '';
    return pathHTML + '<section class="topology-rf"><b>AP-reported BSS load</b>' + publication + '<table>' +
      '<thead><tr><th>BSS / radio</th><th>Channel use</th><th>STAs</th><th>Age</th></tr></thead><tbody>' +
      rows + '</tbody></table><small>' + escapeHTML(status) + '</small>' +
      '<small>Shared-radio utilization is not additive. Not a beacon capture or physical capacity.</small>' +
      (entries.length > 12 ? '<small>Showing 12 of ' + entries.length + ' BSSs.</small>' : '') + '</section>';
  }

  class Follower {
    constructor(controller) {
      this.controller = controller;
      this.enabled = true;
      this.snapshot = null;
      this.received = 0;
      this.available = false;
      this.nextRequest = 0;
      this.applied = '';
      try { this.enabled = localStorage.getItem('easymesh.follow-room') !== 'false'; } catch (_) {}
      this.toggle = document.getElementById('follow-room-layout');
      this.name = document.getElementById('topologyRoomName');
      if (this.toggle) {
        this.toggle.checked = this.enabled;
        this.toggle.addEventListener('change', () => this.setEnabled(this.toggle.checked));
      }
      this.timer = setInterval(() => this.refresh(), 250);
      this.visibility = () => {
        if (document.hidden) this.request?.abort();
        else { this.nextRequest = 0; this.refresh(); }
      };
      document.addEventListener('visibilitychange', this.visibility);
      this.message(this.enabled ? 'Waiting for room coordinates' : 'Manual layout');
    }

    message(text) {
      if (this.toggle && this.toggle.title !== text) this.toggle.title = text;
    }

    roomName(current) {
      if (!this.name) return;
      const text = 'Room: ' + RoomName.format(this.snapshot?.world) +
        (!current && this.snapshot ? ' (last observed)' : '');
      if (this.name.textContent !== text) this.name.textContent = text;
      this.name.title = this.snapshot?.world || '';
    }

    setEnabled(enabled) {
      this.enabled = !!enabled;
      if (this.toggle) this.toggle.checked = this.enabled;
      try { localStorage.setItem('easymesh.follow-room', String(this.enabled)); } catch (_) {}
      this.request?.abort();
      this.applied = '';
      this.nextRequest = this.enabled ? 0 : performance.now() + 1750;
      this.message(this.enabled ? 'Waiting for room coordinates' : 'Manual layout · positions retained');
      if (this.enabled) this.refresh();
    }

    fresh(requireFollowing = true) {
      if (requireFollowing && !this.enabled || !this.available || !this.snapshot) return false;
      const elapsed = performance.now() - this.received;
      const age = Date.parse(this.snapshot.observed_at) - Date.parse(this.snapshot.network_observed_at);
      return elapsed < (this.enabled ? 2000 : 3500) && Number.isFinite(age) && age >= 0 && age + elapsed < 20000;
    }

    async refresh() {
      if (document.hidden || this.controller.currentTab !== 'topology') return;
      this.controller.topologyRFHover?.();
      if (!this.fresh(false)) { this.message('Room unavailable · positions retained'); this.roomName(false); }
      if (this.request || performance.now() < this.nextRequest) return;
      const request = new AbortController();
      this.request = request;
      const deadline = setTimeout(() => request.abort(), 1500);
      try {
        const response = await fetch(this.controller.apiBase + '/room-layout', {signal: request.signal, cache: 'no-store'});
        if (!response.ok) throw new Error('Room unavailable');
        const snapshot = await response.json();
        if (request.signal.aborted) return;
        if (snapshot.schema !== 'easymesh.room-layout.v1' || snapshot.live !== true ||
            snapshot.state !== 'running' || !Array.isArray(snapshot.nodes) || !snapshot.nodes.length ||
            snapshot.nodes.length > 32 || typeof snapshot.run_id !== 'string' || !snapshot.run_id ||
            snapshot.nodes.some(entry => typeof entry.device_id !== 'string' || !entry.device_id ||
              typeof entry.role !== 'string' || !validPosition(entry.position)) ||
            new Set(snapshot.nodes.map(entry => identity(entry.device_id))).size !== snapshot.nodes.length ||
            !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 ||
            !Number.isSafeInteger(snapshot.world_epoch) || snapshot.world_epoch < 0) throw new Error('Room not live');
        if (this.snapshot?.run_id === snapshot.run_id && (snapshot.world_epoch < this.snapshot.world_epoch ||
            snapshot.sequence < this.snapshot.sequence)) throw new Error('Old room snapshot');
        this.snapshot = snapshot;
        this.received = performance.now();
        this.available = true;
        if (!this.fresh(false)) throw new Error('Stale room mapping');
        this.apply();
        this.roomName(true);
        this.controller.refreshRoomSteeringCues?.();
        this.message(this.enabled ? 'Following room positions · default room camera orientation' : 'Manual layout · positions retained');
        if (!this.enabled) this.nextRequest = performance.now() + 1750;
      } catch (error) {
        this.available = false;
        this.nextRequest = performance.now() + 1750;
        this.message('Room unavailable · positions retained');
        this.roomName(false);
      } finally {
        this.controller.topologyRFHover?.();
        clearTimeout(deadline);
        if (this.request === request) this.request = null;
      }
    }

    rfHTML(node) {
      return rfHTML(node, this.snapshot?.rf_observations, Date.now(), this.fresh(false));
    }

    prepare(nodes) {
      if (!this.fresh()) return false;
      const world = JSON.stringify([this.snapshot.run_id, this.snapshot.world_epoch]);
      if (world !== this.projectionWorld) { this.projection = null; this.projectionWorld = world; }
      const layout = positions(nodes, this.snapshot, node => this.controller.topologyNodeExtent(node), this.projection,
        node => this.controller.topologyNodeFootprint(node));
      if (!layout.size) return false;
      this.projection = layout.projection;
      for (const node of nodes) {
        const position = layout.get(String(node.id));
        if (!position) continue;
        node.x = node.fx = position.x;
        node.y = node.fy = position.y;
        node.vx = node.vy = 0;
        this.controller.nodePositionCache.set(String(node.id), position);
      }
      return true;
    }

    apply() {
      const controller = this.controller;
      const nodes = controller.topologySimulation?.nodes();
      if (!this.fresh() || !nodes?.length || controller.topologyInteractionDepth > 0 || controller.topologyLayoutInProgress) return;
      const signature = JSON.stringify([this.snapshot.run_id, this.snapshot.world_epoch,
        this.snapshot.nodes, nodes.map(node => [node.id, controller.topologyNodeFootprint(node)])]);
      if (this.applied === signature) return;
      if (!this.prepare(nodes)) return;
      this.applied = signature;
      controller.topologySimulation.stop();
      controller.topologySimulation.on('tick')?.();
      controller.layoutTopologyLabels();
      controller.fitTopologyToView();
    }

    close() {
      clearInterval(this.timer);
      this.request?.abort();
      document.removeEventListener('visibilitychange', this.visibility);
    }
  }
  return {positions, compact, pack, Follower, rfHTML};
});
