(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SteeringCues = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const normal = value => String(value || '').toLowerCase();
  const shortName = value => String(value || '').replace(/^Extender[- ]?/i, 'Ext-');
  let maskSequence = 0;
  const layouts = new WeakMap();
  const pendingLayouts = new WeakSet();
  const intersects = (first, second, margin = 0) => first.x < second.x + second.width + margin &&
    first.x + first.width + margin > second.x && first.y < second.y + second.height + margin &&
    first.y + first.height + margin > second.y;
  const contains = (box, point) => point.x >= box.x && point.x <= box.x + box.width &&
    point.y >= box.y && point.y <= box.y + box.height;
  function segmentHitsBox(start, end, box) {
    let lower = 0, upper = 1;
    for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
      const delta = end[axis] - start[axis];
      if (Math.abs(delta) < 0.0001) {
        if (start[axis] < box[axis] || start[axis] > box[axis] + box[size]) return false;
        continue;
      }
      const first = (box[axis] - start[axis]) / delta;
      const last = (box[axis] + box[size] - start[axis]) / delta;
      lower = Math.max(lower, Math.min(first, last));
      upper = Math.min(upper, Math.max(first, last));
      if (lower > upper) return false;
    }
    return true;
  }
  function bounds(boxes, points = []) {
    const left = Math.min(...boxes.map(box => box.x), ...points.map(point => point.x));
    const top = Math.min(...boxes.map(box => box.y), ...points.map(point => point.y));
    const right = Math.max(...boxes.map(box => box.x + box.width), ...points.map(point => point.x));
    const bottom = Math.max(...boxes.map(box => box.y + box.height), ...points.map(point => point.y));
    return {x: left, y: top, width: right - left, height: bottom - top};
  }
  function labelPosition(anchor, size, obstacles, ordinal = 0, frame = bounds(obstacles, [anchor])) {
    const candidates = [];
    for (const distance of [32, 64, 112, 176, 256]) {
      for (const [horizontal, vertical] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        candidates.push({x: anchor.x + horizontal * (distance + size.width / 2) - size.width / 2,
          y: anchor.y + vertical * (distance + size.height / 2) - size.height / 2, ...size});
      }
    }
    const available = candidates.filter(candidate => !obstacles.some(box => intersects(candidate, box, 8)));
    if (available.length) return available[ordinal % Math.min(available.length, 2)];
    const rowCount = Math.max(3, Math.floor(frame.height / (size.height + 12)));
    const firstRow = Math.max(0, Math.min(rowCount - 1, Math.round((anchor.y - frame.y) / (size.height + 12))));
    for (let column = 0; column <= obstacles.length + 1; column++) {
      for (let offset = 0; offset < rowCount; offset++) {
        const row = (firstRow + offset) % rowCount;
        const inset = Math.floor(column / 2) * (size.width + 16) + 16;
        const candidate = {x: column % 2 ? frame.x + frame.width + inset : frame.x - size.width - inset,
          y: frame.y + row * (size.height + 12), ...size};
        if (!obstacles.some(box => intersects(candidate, box, 8))) return candidate;
      }
    }
    const extent = bounds(obstacles, [anchor]);
    return {x: extent.x - size.width - 16, y: anchor.y, ...size};
  }
  function route(start, end, obstacles, previous = [], ordinal = 0) {
    if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return [];
    const blocked = obstacles.filter(box => !contains(box, start) && !contains(box, end));
    const extent = bounds(blocked, [start, end]);
    const lane = 24 + ordinal % 12 * 14;
    const middleX = (start.x + end.x) / 2, middleY = (start.y + end.y) / 2;
    const candidates = [[start, end]];
    const horizontal = [start.y - lane, start.y + lane, end.y - lane, end.y + lane,
      middleY - lane, middleY + lane, extent.y - lane, extent.y + extent.height + lane];
    const vertical = [start.x - lane, start.x + lane, end.x - lane, end.x + lane,
      middleX - lane, middleX + lane, extent.x - lane, extent.x + extent.width + lane];
    for (const level of horizontal) candidates.push([start, {x: start.x, y: level}, {x: end.x, y: level}, end]);
    for (const level of vertical) candidates.push([start, {x: level, y: start.y}, {x: level, y: end.y}, end]);
    for (const level of [extent.y - lane, extent.y + extent.height + lane]) {
      for (const direction of [-1, 1]) candidates.push([start, {x: start.x + direction * lane, y: start.y},
        {x: start.x + direction * lane, y: level}, {x: end.x - direction * lane, y: level},
        {x: end.x - direction * lane, y: end.y}, end]);
    }
    if (Math.hypot(end.x - start.x, end.y - start.y) < 2) {
      candidates.splice(0, candidates.length, [start, {x: start.x + lane, y: start.y},
        {x: start.x + lane, y: start.y - lane}, {x: start.x, y: start.y - lane}, end]);
    }
    const occupied = previous.flatMap(points => points.slice(1).map((point, index) => ({
      x: Math.min(points[index].x, point.x) - 6, y: Math.min(points[index].y, point.y) - 6,
      width: Math.abs(points[index].x - point.x) + 12, height: Math.abs(points[index].y - point.y) + 12
    })));
    let best = [], bestScore = Infinity;
    for (const candidate of candidates) {
      const points = candidate.filter((point, index) => !index ||
        Math.hypot(point.x - candidate[index - 1].x, point.y - candidate[index - 1].y) > 0.01);
      let score = points.length * 12;
      for (let index = 1; index < points.length; index++) {
        const from = points[index - 1], to = points[index];
        score += Math.hypot(to.x - from.x, to.y - from.y);
        score += blocked.filter(box => segmentHitsBox(from, to, box)).length * 1000000;
        score += occupied.filter(box => segmentHitsBox(from, to, box)).length * 180;
      }
      if (score < bestScore) { best = points; bestScore = score; }
    }
    return best;
  }
  function coordinates(data) {
    const {effect, sourceNode, targetNode, staData} = data;
    return {
      start: {x: sourceNode ? (sourceNode.fx ?? sourceNode.x) + (effect.sourceOffsetX || 0) : effect.fromX,
        y: sourceNode ? (sourceNode.fy ?? sourceNode.y) + (effect.sourceOffsetY || 0) : effect.fromY},
      end: {x: (targetNode.fx ?? targetNode.x) + staData.to.x, y: (targetNode.fy ?? targetNode.y) + staData.to.y}
    };
  }
  function style(effect, actions = []) {
    const action = [...actions].reverse().find(item => {
      const age = effect.changedAt - Date.parse(item.requested_at || '');
      return normal(item.sta_mac) === normal(effect.staMAC) && effect.fromBSSID && effect.toBSSID &&
        normal(item.source_bssid) === normal(effect.fromBSSID) && normal(item.target_bssid) === normal(effect.toBSSID) &&
        age >= -1000 && age <= 30000;
    });
    if (action?.method === 'btm-request') return {method: 'btm', color: '#7c3aed', label: 'BTM request'};
    if (action?.method === 'non-btm' && action.evidence === 'operator-report') return {method: 'non-btm', color: '#be185d', label: 'Non-BTM reported'};
    return {method: 'unknown', color: '#64748b', label: 'Method unknown'};
  }

  function draw(group, effect, sourceNode, targetNode, staData, clientName, actions, zoomScale = 1) {
    const appearance = style(effect, actions);
    const cue = group.append('g').datum({effect, sourceNode, targetNode, staData, clientName})
      .attr('class', 'sta-roam-cue').attr('data-method', appearance.method)
      .attr('aria-label', `${clientName}: ${effect.fromOwnerName} to ${effect.toOwnerName}; ${appearance.label}`)
      .attr('opacity', Math.max(0, 1 - effect.ageMs / 6000)).style('pointer-events', 'none');
    cue.append('title').text(`${clientName}: ${effect.fromOwnerName} → ${effect.toOwnerName}. ${appearance.label}. The current association is already displayed; this is only a fading history overlay.`);
    cue.append('animate').attr('attributeName', 'opacity').attr('to', 0)
      .attr('dur', `${effect.remainingMs}ms`).attr('fill', 'freeze');
    cue.append('path').attr('class', 'sta-steering-trail').attr('fill', 'none')
      .attr('stroke', appearance.color).attr('stroke-width', 4).attr('stroke-dasharray', '9 7');
    cue.append('path').attr('class', 'sta-roam-arrow').attr('fill', appearance.color);
    cue.append('circle').attr('class', 'sta-roam-source').attr('r', staData.iconSize / 2 + 5)
      .attr('fill', '#fff').attr('fill-opacity', 0.6).attr('stroke', appearance.color)
      .attr('stroke-width', 3).attr('stroke-dasharray', '4 4');
    const fontSize = Math.min(32, Math.max(18, 12 / zoomScale));
    const label = cue.append('text').attr('class', 'sta-roam-origin-label').attr('font-size', fontSize)
      .attr('font-weight', 700).attr('text-anchor', 'middle').attr('fill', appearance.color)
      .attr('stroke', '#fff').attr('stroke-width', 4).attr('paint-order', 'stroke')
      .text(`${clientName} · ${shortName(effect.fromOwnerName)} → ${shortName(effect.toOwnerName)}`);
    label.append('tspan').attr('class', 'sta-roam-method-label').attr('dy', fontSize + 2).text(appearance.label);
    cue.append('circle').attr('class', 'sta-steer-pulse').attr('r', staData.iconSize / 2 + 7)
      .attr('fill', 'none').attr('stroke', appearance.color).attr('stroke-width', 4);
    position(cue);
    setTimeout(() => {
      cue.remove();
      const element = group.node();
      if (!element?.isConnected || pendingLayouts.has(element)) return;
      pendingLayouts.add(element);
      requestAnimationFrame(() => {
        pendingLayouts.delete(element);
        if (element.isConnected) layout(group);
      });
    }, effect.remainingMs);
    return cue;
  }

  function position(cue) {
    const {effect, sourceNode, targetNode, staData} = cue.datum();
    const {start, end} = coordinates({effect, sourceNode, targetNode, staData});
    const sourceX = start.x, sourceY = start.y, targetX = end.x, targetY = end.y;
    if (![sourceX, sourceY, targetX, targetY].every(Number.isFinite)) { cue.attr('display', 'none'); return; }
    const midX = (sourceX + targetX) / 2, midY = (sourceY + targetY) / 2 - 45;
    cue.select('.sta-steering-trail').attr('d', `M${sourceX},${sourceY} Q${midX},${midY} ${targetX},${targetY}`);
    cue.select('.sta-roam-arrow').attr('d', 'M0,0 L-14,-7 L-14,7 Z')
      .attr('transform', `translate(${targetX},${targetY}) rotate(${Math.atan2(targetY - midY, targetX - midX) * 180 / Math.PI})`);
    cue.select('.sta-roam-source').attr('cx', sourceX).attr('cy', sourceY);
    const label = cue.select('.sta-roam-origin-label');
    label.attr('x', sourceX).attr('y', sourceY - staData.iconSize / 2 - Number(label.attr('font-size')) - 18);
    label.select('.sta-roam-method-label').attr('x', sourceX);
    cue.select('.sta-steer-pulse').attr('cx', targetX).attr('cy', targetY);
  }
  function layout(group) {
    const element = group?.node?.();
    const scene = element?.parentNode;
    const matrix = scene?.getScreenCTM?.();
    if (!matrix || matrix.a <= 0 || matrix.d <= 0) return;
    const cues = group.selectAll('.sta-roam-cue').nodes();
    const intents = group.selectAll('.sta-steering-intent-path').nodes();
    if (!cues.length && !intents.length) return;
    group.raise();
    const boxFor = item => {
      const box = item.getBoundingClientRect();
      return {x: (box.left - matrix.e) / matrix.a - 6, y: (box.top - matrix.f) / matrix.d - 6,
        width: box.width / matrix.a + 12, height: box.height / matrix.d + 12};
    };
    const obstacles = Array.from(scene.querySelectorAll(
      '.node image, .mesh-identity-label, .ssid-label, .sta-icon, .sta-identity-label, .sta-signal-bars, .backhaul-signal-bars, .channel-label'
    ), boxFor).filter(box => box.width > 12 && box.height > 12);
    const records = cues.map(cue => ({element: cue, ...coordinates(cue.__data__),
      key: normal(cue.__data__.effect.staMAC), label: cue.querySelector('.sta-roam-origin-label')}));
    for (const intent of intents) {
      const {sourceNode, targetNode, staData} = intent.__data__;
      const client = Array.from(scene.querySelectorAll('.sta-node')).find(item => item.__data__ === staData);
      records.push({element: intent, key: normal(staData.sta?.staMAC), intent: true,
        start: {x: (sourceNode.fx ?? sourceNode.x) + staData.to.x, y: (sourceNode.fy ?? sourceNode.y) + staData.to.y},
        end: {x: targetNode.fx ?? targetNode.x, y: targetNode.fy ?? targetNode.y},
        label: client?.querySelector('.sta-steer-intent-badge'), sourceNode});
    }
    records.sort((first, second) => first.key.localeCompare(second.key) || Number(first.intent || 0) - Number(second.intent || 0));
    const signature = JSON.stringify([obstacles, records.map(record => [record.key, record.intent,
      record.start, record.end, record.label?.textContent])]);
    const cached = layouts.get(element);
    if (cached?.signature === signature) {
      for (const record of cached.paths) record.element.setAttribute('d', record.path);
      for (const record of cached.attributes) record.element.setAttribute(record.name, record.value);
      return;
    }
    const maskId = cached?.maskId || `sta-cue-clearance-${++maskSequence}`;
    const paths = [];
    const attributes = [];
    const setAttribute = (element, name, value) => {
      element.setAttribute(name, value);
      attributes.push({element, name, value});
    };
    const labelBoxes = [];
    const frame = bounds(obstacles, records.flatMap(record => [record.start, record.end])
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
    for (const [ordinal, record] of records.entries()) {
      if (![record.start.x, record.start.y, record.end.x, record.end.y].every(Number.isFinite)) continue;
      const label = record.label;
      if (label) {
        const box = label.getBBox();
        const placement = labelPosition(record.start, {width: box.width + 12, height: box.height + 12},
          [...obstacles, ...labelBoxes], ordinal, frame);
        if (record.intent) {
          setAttribute(label, 'transform', `translate(${placement.x + 6 - box.x - (record.sourceNode.fx ?? record.sourceNode.x)},${placement.y + 6 - box.y - (record.sourceNode.fy ?? record.sourceNode.y)})`);
        } else {
          const baseline = Number(label.getAttribute('y')) - box.y;
          const center = placement.x + placement.width / 2;
          setAttribute(label, 'x', center);
          setAttribute(label, 'y', placement.y + baseline + 6);
          setAttribute(label.querySelector('.sta-roam-method-label'), 'x', center);
        }
        labelBoxes.push(placement);
      }
    }
    const protectedBoxes = [...obstacles, ...labelBoxes];
    const previous = [];
    for (const [ordinal, record] of records.entries()) {
      const points = route(record.start, record.end, protectedBoxes, previous, ordinal);
      if (!points.length) continue;
      if (record.intent && points.length > 1) {
        const last = points[points.length - 1], before = points[points.length - 2];
        const length = Math.hypot(last.x - before.x, last.y - before.y);
        const offset = Math.min(42, length / 2);
        points[points.length - 1] = {x: last.x - (last.x - before.x) / length * offset,
          y: last.y - (last.y - before.y) / length * offset};
      }
      const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
      const trail = record.intent ? record.element : record.element.querySelector('.sta-steering-trail');
      trail.setAttribute('d', path);
      trail.setAttribute('mask', `url(#${maskId})`);
      trail.setAttribute('stroke-linejoin', 'round');
      trail.setAttribute('stroke-dashoffset', ordinal * 3);
      paths.push({element: trail, path});
      if (!record.intent) {
        const end = points[points.length - 1], before = points[points.length - 2] || record.start;
        const angle = Math.atan2(end.y - before.y, end.x - before.x);
        const radius = record.element.__data__.staData.iconSize / 2 + 9;
        const arrow = record.element.querySelector('.sta-roam-arrow');
        setAttribute(arrow, 'transform', `translate(${end.x - Math.cos(angle) * radius},${end.y - Math.sin(angle) * radius}) rotate(${angle * 180 / Math.PI})`);
        for (const item of record.element.querySelectorAll('.sta-roam-arrow, .sta-roam-source, .sta-steer-pulse')) item.setAttribute('mask', `url(#${maskId})`);
      }
      previous.push(points);
    }
    const extent = bounds(protectedBoxes, previous.flat());
    const canvas = {x: extent.x - 100, y: extent.y - 100, width: extent.width + 200, height: extent.height + 200};
    const definitions = group.selectAll('defs.sta-cue-definitions').data([null]).join('defs').attr('class', 'sta-cue-definitions');
    const mask = definitions.selectAll('mask').data([null]).join('mask').attr('id', maskId)
      .attr('maskUnits', 'userSpaceOnUse').attr('x', canvas.x).attr('y', canvas.y)
      .attr('width', canvas.width).attr('height', canvas.height).style('mask-type', 'luminance');
    mask.selectAll('rect').data([canvas, ...protectedBoxes])
      .join('rect').attr('x', box => box.x).attr('y', box => box.y)
      .attr('width', box => box.width).attr('height', box => box.height)
      .attr('fill', (_box, index) => index ? '#000' : '#fff');
    layouts.set(element, {signature, maskId, paths, attributes, group});
  }
  function refresh(cue, actions) {
    const {effect, clientName} = cue.datum();
    const appearance = style(effect, actions);
    if (cue.attr('data-method') === appearance.method) return;
    cue.attr('data-method', appearance.method)
      .attr('aria-label', `${clientName}: ${effect.fromOwnerName} to ${effect.toOwnerName}; ${appearance.label}`);
    cue.selectAll('.sta-steering-trail, .sta-roam-source, .sta-steer-pulse').attr('stroke', appearance.color);
    cue.select('.sta-roam-arrow').attr('fill', appearance.color);
    cue.select('.sta-roam-origin-label').attr('fill', appearance.color);
    cue.select('.sta-roam-method-label').text(appearance.label);
    cue.select('title').text(`${clientName}: ${effect.fromOwnerName} → ${effect.toOwnerName}. ${appearance.label}. History overlay only.`);
    const group = cue.node()?.parentNode;
    if (layouts.has(group)) layout(layouts.get(group).group);
  }
  return {style, draw, position, refresh, layout, route, labelPosition, segmentHitsBox, intersects};
});
