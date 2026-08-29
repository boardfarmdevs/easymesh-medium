'use strict';

const state = { snapshot: null, selected: null, controls: { enabled: false, csrf_token: '', undo: {} } };
const $ = (id) => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';

function shortMac(mac) {
  const fields = String(mac || '').split(':');
  return fields.length === 6 ? `radio-${fields.slice(-2).join('')}` : mac;
}
function stationIdentity(mac) { return (state.snapshot?.stations || []).find((station) => station.mac === mac); }
function displayName(mac) { return stationIdentity(mac)?.label || shortMac(mac); }
function radioChannels(mac) {
  const seen = new Set();
  return (state.snapshot?.radio_frequencies || [])
    .filter((radio) => radio.radio === mac && Number(radio.frames || 0) > 0)
    .sort((left, right) => Number(left.frequency_mhz) - Number(right.frequency_mhz))
    .filter((radio) => { const key = `${radio.band}:${radio.channel}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map((radio) => `${radio.band} ch ${radio.channel}`);
}

function number(value) { return Number(value || 0).toLocaleString(); }
function rate(value) { return Number(value || 0) < 10 ? Number(value || 0).toFixed(1) : Math.round(Number(value || 0)).toLocaleString(); }
function bytes(value) {
  let current = Number(value || 0), index = 0;
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  while (current >= 1024 && index < units.length - 1) { current /= 1024; index += 1; }
  return `${current < 10 && index ? current.toFixed(1) : Math.round(current)} ${units[index]}`;
}
function frameType(value) { return ['management', 'control', 'data', 'other'][Number(value)] || `type-${value}`; }
function totalDrops(item) { return Number(item.drops_offchannel || 0) + Number(item.drops_cca || 0) + Number(item.drops_interference || 0) + Number(item.drops_per || 0) + Number(item.drops_no_receiver || 0); }

function setConnection(text, kind) {
  const item = $('connection'); item.textContent = text; item.className = `badge ${kind}`;
}

function render(snapshot) {
  state.snapshot = snapshot;
  const daemon = snapshot.daemon;
  const metrics = snapshot.packet_metrics || { available: false, rates: {} };
  const summary = metrics.summary || {};
  const rates = metrics.rates || {};
  $('frames-rate').textContent = metrics.available ? rate(rates.frames_per_second) : 'unavailable';
  $('bytes-rate').textContent = metrics.available ? bytes(rates.bytes_per_second) : 'unavailable';
  $('active-count').textContent = metrics.available ? number(snapshot.active_links.filter(WMediumdGraph.hasObservedTraffic).length) : 'unavailable';
  $('delivery-count').textContent = metrics.available ? `${number(summary.rx_injected)} / ${number(summary.tx_no_ack)}` : 'unavailable';
  $('retry-count').textContent = metrics.available ? `${number(summary.retries)} / ${number(totalDrops(summary))}` : 'unavailable';
  $('queue-count').textContent = metrics.available ? `${number(summary.queue_depth)} / ${number(summary.queue_depth_max)}` : 'unavailable';
  $('captured').textContent = `Snapshot ${snapshot.sequence}, generation ${daemon.generation}, captured ${new Date(snapshot.captured_at).toLocaleString()}`;
  $('telemetry-notice').hidden = metrics.available;
  renderHealth(snapshot.health || {});
  renderCapabilities(daemon.capabilities);
  renderIdentityInventory(snapshot.identity_inventory || {});
  renderArtifacts(snapshot.artifacts);
  renderSourceSelect(snapshot.stations);
  renderGraph(); renderTelemetry(summary); renderActiveLinks(); renderRadios(); renderVIFs(); renderEvents(); renderTable(); renderControls();
}

function renderHealth(health) {
  const badge = $('health-badge'); const stateName = health.state || 'unavailable';
  badge.textContent = `health · ${stateName}`;
  badge.className = `badge ${stateName === 'ok' ? 'live' : stateName === 'unavailable' ? 'waiting' : 'error'}`;
  const list = $('health-summary'); list.replaceChildren();
  const values = [
    ['State', stateName], ['Reasons', (health.reasons || []).join('; ') || '—'],
    ['Telemetry sequence', `${number(health.telemetry_sequence_from)} → ${number(health.telemetry_sequence_to)}`],
    ['Event history', health.event_history_gap ? 'GAP DETECTED' : `${number(health.oldest_event_sequence)} → ${number(health.latest_event_sequence)}`]
  ];
  renderDefinitionList(list, values);
}

function renderTelemetry(summary) {
  const list = $('telemetry-summary'); list.replaceChildren();
  if (!state.snapshot?.packet_metrics?.available) { renderDefinitionList(list, [['Availability', state.snapshot?.packet_metrics?.reason || 'unavailable']]); return; }
  const drops = totalDrops(summary);
  renderDefinitionList(list, [
    ['Frames / bytes', `${number(summary.frames_seen)} / ${bytes(summary.bytes_seen)}`],
    ['Mgmt / control / data', `${number(summary.management_frames)} / ${number(summary.control_frames)} / ${number(summary.data_frames)}`],
    ['EAPOL / multicast', `${number(summary.eapol_frames)} / ${number(summary.multicast_frames)}`],
    ['Multicast candidates', number(summary.multicast_candidates)],
    ['Attempts / retries', `${number(summary.tx_attempts)} / ${number(summary.retries)}`],
    ['Acked / no-ack / injected', `${number(summary.tx_acked)} / ${number(summary.tx_no_ack)} / ${number(summary.rx_injected)}`],
    ['Drops total', number(drops)],
    ['Off-channel / CCA / interference', `${number(summary.drops_offchannel)} / ${number(summary.drops_cca)} / ${number(summary.drops_interference)}`],
    ['PER / no receiver', `${number(summary.drops_per)} / ${number(summary.drops_no_receiver)}`],
    ['Netlink EINVAL / other', `${number(summary.netlink_clone_einval)} / ${number(summary.netlink_other_errors)}`],
    ['Link evictions / event overruns', `${number(summary.active_link_evictions)} / ${number(summary.event_overruns)}`],
    ['Queue delay last / max', `${number(summary.queue_delay_usec_last)} / ${number(summary.queue_delay_usec_max)} µs`]
  ]);
}

function renderDefinitionList(list, values) {
  for (const [name, content] of values) { const dt = document.createElement('dt'); dt.textContent = name; const dd = document.createElement('dd'); dd.textContent = content; list.append(dt, dd); }
}

function renderCapabilities(capabilities) {
  const list = $('capabilities'); list.replaceChildren();
  for (const capability of capabilities) { const item = document.createElement('li'); item.textContent = capability; list.appendChild(item); }
}

function renderArtifacts(artifacts) {
  const list = $('artifacts'); list.replaceChildren();
  for (const [name, artifact] of Object.entries(artifacts || {})) {
    const term = document.createElement('dt'); term.textContent = name.replaceAll('_', ' ');
    const value = document.createElement('dd'); value.textContent = artifact.available ? `${artifact.sha256}  ${artifact.path}${artifact.resolved_path ? ` → ${artifact.resolved_path}` : ''}` : `unavailable: ${artifact.error || 'unknown'}`;
    list.append(term, value);
  }
}

function renderIdentityInventory(inventory) {
  const list = $('identity-status'); list.replaceChildren();
  renderDefinitionList(list, inventory.available ? [
    ['Status', 'loaded'], ['Path', inventory.path], ['Generated', new Date(inventory.generated_at).toLocaleString()],
    ['Entries / matched', `${number(inventory.entries)} / ${number(inventory.matched)}`]
  ] : [['Status', 'optional inventory unavailable'], ['Path', inventory.path || 'not configured'], ['Reason', inventory.error || 'unknown']]);
}

function fillStationSelect(select, stations, previous) {
  select.replaceChildren();
  for (const station of stations) { const option = document.createElement('option'); option.value = station.mac; option.textContent = `${station.label || shortMac(station.mac)}${station.role ? ` · ${station.role}` : ''} · ${station.mac}`; select.appendChild(option); }
  select.value = stations.some((station) => station.mac === previous) ? previous : stations[0]?.mac || '';
  return select.value;
}

function renderSourceSelect(stations) {
  state.selected = fillStationSelect($('source-select'), stations, state.selected);
  const previousSource = $('control-source').value, previousDestination = $('control-destination').value;
  fillStationSelect($('control-source'), stations, previousSource || state.selected);
  fillStationSelect($('control-destination'), stations, previousDestination || stations.find((item) => item.mac !== state.selected)?.mac);
}

function snrClass(value) { return value >= 40 ? 'strong' : value >= 20 ? 'medium' : 'weak'; }

function renderGraph() {
  const svg = $('graph'); svg.replaceChildren(); const snapshot = state.snapshot;
  if (!snapshot || snapshot.stations.length === 0) return;
  const width = 1000, height = 560;
  const positions = WMediumdGraph.layoutStations(snapshot.stations, state.selected, width, height);
  const mode = $('graph-mode').value;
  const selected = stationIdentity(state.selected);
  if (mode === 'association') {
    const associations = WMediumdGraph.associationsForSelected(snapshot, state.selected);
    for (const link of associations) {
      drawEdge(svg, positions, link, 'association', `${displayName(link.source)} ↔ ${displayName(link.destination)} · ${link.band} ch ${link.channel} · SNR ${link.last_snr_db} dB`, `${link.band} · ch ${link.channel}`);
    }
    if (associations.length === 0) {
      $('graph-summary').textContent = `${displayName(state.selected)}: no current client association has been observed in non-multicast traffic.`;
    } else if (selected && ['wlan-client', 'iot-client'].includes(selected.role)) {
      const link = associations[0];
      $('graph-summary').textContent = `${displayName(link.source)} ↔ ${displayName(link.destination)} · ${link.band} ch ${link.channel} · ${link.frequency_mhz} MHz · SNR ${link.last_snr_db} dB.`;
    } else {
      const channels = [...new Set(associations.map((link) => `${link.band} ch ${link.channel}`))].join(', ');
      $('graph-summary').textContent = `${displayName(state.selected)}: ${associations.length} currently associated client(s) · ${channels}.`;
    }
  } else if (mode === 'active') {
    const links = snapshot.active_links.filter((item) => item.source === state.selected && WMediumdGraph.hasObservedTraffic(item));
    for (const link of links) drawEdge(svg, positions, link, link.multicast ? 'multicast' : snrClass(link.last_snr_db), `${link.band} ch ${link.channel} · ${link.frames} frames · SNR ${link.last_snr_db} dB · ${totalDrops(link)} drops`);
    $('graph-summary').textContent = `${displayName(state.selected)}: ${links.length} raw packet path(s). Multicast fan-out is medium delivery telemetry, not Wi-Fi association.`;
  } else {
    for (const link of snapshot.pair_links.filter((item) => item.source === state.selected)) drawEdge(svg, positions, link, snrClass(link.snr_db), `${link.snr_db} dB configured pair state`);
    for (const link of snapshot.frequency_overrides.filter((item) => item.source === state.selected)) drawEdge(svg, positions, link, 'override', `${link.snr_db} dB override at ${link.frequency_mhz} MHz (${link.band} ch ${link.channel})`);
    $('graph-summary').textContent = `${displayName(state.selected)}: configured potential RF paths, not current Wi-Fi associations.`;
  }
  const vifsByRadio = new Map();
  for (const vif of snapshot.vifs) { if (!vifsByRadio.has(vif.radio)) vifsByRadio.set(vif.radio, []); vifsByRadio.get(vif.radio).push(vif); }
  for (const station of snapshot.stations) {
    const position = positions.get(station.mac); const group = document.createElementNS(svgNS, 'g'); group.setAttribute('class', `graph-node${station.mac === state.selected ? ' selected' : ''}`); group.setAttribute('transform', `translate(${position.x},${position.y})`);
    group.addEventListener('click', () => { state.selected = station.mac; $('source-select').value = station.mac; renderGraph(); renderTable(); });
    const circle = document.createElementNS(svgNS, 'circle'); circle.setAttribute('r', position.radius);
    const title = document.createElementNS(svgNS, 'title'); const owned = vifsByRadio.get(station.mac) || []; const channels = radioChannels(station.mac); title.textContent = `${station.label || shortMac(station.mac)}\n${station.mac}${station.role ? `\nrole: ${station.role}` : ''}${station.owner ? `\nowner: ${station.owner}` : ''}${station.interface ? `\ninterface: ${station.interface}` : ''}${channels.length ? `\nband/channel: ${channels.join(', ')}` : ''}\n${owned.length} observed VIF mapping(s), not associations${owned.length ? `: ${owned.map((vif) => vif.mac).join(', ')}` : ''}`;
    const label = station.label || shortMac(station.mac); const text = document.createElementNS(svgNS, 'text'); text.setAttribute('y', '0'); text.setAttribute('dy', '.35em'); text.setAttribute('font-size', WMediumdGraph.labelFontSize(label, position.radius).toFixed(1)); text.textContent = label; group.append(circle, title, text); svg.appendChild(group);
  }
}

function drawEdge(svg, positions, link, edgeClass, description, visibleLabel = '') {
  const route = WMediumdGraph.edgeRoute(positions, link, 1000, 560); if (!route) return;
  const path = document.createElementNS(svgNS, 'path'); path.setAttribute('d', route.path); path.setAttribute('class', `graph-edge ${edgeClass}`); path.setAttribute('stroke-width', '3');
  const title = document.createElementNS(svgNS, 'title'); title.textContent = description; path.appendChild(title); svg.appendChild(path);
  if (visibleLabel) {
    const point = route.kind === 'curve'
      ? { x: 0.25 * route.start.x + 0.5 * route.control.x + 0.25 * route.end.x, y: 0.25 * route.start.y + 0.5 * route.control.y + 0.25 * route.end.y }
      : { x: (route.start.x + route.end.x) / 2, y: (route.start.y + route.end.y) / 2 };
    const label = document.createElementNS(svgNS, 'text'); label.setAttribute('class', 'graph-edge-label'); label.setAttribute('x', point.x); label.setAttribute('y', point.y - 5); label.textContent = visibleLabel; svg.appendChild(label);
  }
}

function renderActiveLinks() {
  const body = $('active-body'); body.replaceChildren(); const links = (state.snapshot?.active_links || []).filter(WMediumdGraph.hasObservedTraffic); const needle = $('active-filter').value.trim().toLowerCase(); let matched = 0, rendered = 0;
  for (const link of links) {
    if (needle && !`${link.source} ${link.destination} ${link.frequency_mhz} ${link.band}`.toLowerCase().includes(needle)) continue;
    matched += 1; if (rendered >= 800) continue;
    const drops = totalDrops(link); const tr = document.createElement('tr');
    addCells(tr, [
      `${displayName(link.source)} → ${displayName(link.destination)}${link.multicast ? ' · multicast' : ''}`,
      `${link.band} / ch ${link.channel} · ${link.frequency_mhz} MHz`, `${number(link.frames)} / ${bytes(link.bytes)}`,
      `${number(link.attempts)} / ${number(link.retries)} / ${number(link.acked)}`, `${link.last_signal_dbm} dBm / ${link.last_snr_db} dB / ${(Number(link.last_per_million) / 10000).toFixed(2)}%`,
      `${number(link.rx_injected)} / ${number(drops)}`, `${frameType(link.last_type)}:${link.last_subtype} · AC ${link.last_access_category}`
    ]); body.appendChild(tr); rendered += 1;
  }
  $('active-summary').textContent = matched > rendered ? `Showing ${rendered} of ${matched} active paths.` : `${rendered} active paths.`;
}

function renderRadios() {
  const body = $('radio-body'); body.replaceChildren();
  for (const radio of state.snapshot?.radio_frequencies || []) {
    const tr = document.createElement('tr'); addCells(tr, [displayName(radio.radio), `${radio.band} / ch ${radio.channel} · ${radio.frequency_mhz} MHz`, `${number(radio.frames)} / ${bytes(radio.bytes)}`, `${number(radio.management_frames)} / ${number(radio.control_frames)} / ${number(radio.data_frames)} / ${number(radio.eapol_frames)}`, `${number(radio.unicast_frames)} / ${number(radio.multicast_frames)}`, `${number(radio.attempts)} / ${number(radio.retries)}`, `${number(radio.rx_injected)} / ${number(radio.drops)}`]); body.appendChild(tr);
  }
}

function renderVIFs() {
  const body = $('vif-body'); body.replaceChildren();
  for (const vif of state.snapshot?.vifs || []) { const tr = document.createElement('tr'); addCells(tr, [vif.mac, `${displayName(vif.radio)} · ${vif.radio}`, `${vif.band} / ch ${vif.channel} · ${vif.frequency_mhz} MHz`]); body.appendChild(tr); }
}

function renderEvents() {
  const list = $('event-timeline'); list.replaceChildren(); const events = (state.snapshot?.events || []).slice(-30);
  for (const event of events.reverse()) { const item = document.createElement('li'); const title = document.createElement('strong'); title.textContent = `${event.sequence} · ${event.type}`; const detail = document.createElement('span'); detail.textContent = `t=${(Number(event.time_usec) / 1e6).toFixed(3)}s${event.source ? ` · ${displayName(event.source)}` : ''}${event.destination ? ` → ${displayName(event.destination)}` : ''}${event.frequency_mhz ? ` · ${event.band} ch ${event.channel}` : ''} · value ${event.value} · aux ${event.auxiliary}`; item.append(title, detail); list.appendChild(item); }
}

function renderTable() {
  const body = $('links-body'); body.replaceChildren(); if (!state.snapshot) return; const needle = $('link-filter').value.trim().toLowerCase(); const kind = $('kind-filter').value; const rows = [];
  if (kind !== 'frequency') for (const link of state.snapshot.pair_links) rows.push({ kind: 'pair', ...link, band: 'all / fallback', channel: '—', frequency_mhz: '—' });
  if (kind !== 'pair') for (const link of state.snapshot.frequency_overrides) rows.push({ kind: 'override', ...link });
  rows.sort((a, b) => Number(b.source === state.selected) - Number(a.source === state.selected) || a.source.localeCompare(b.source) || a.destination.localeCompare(b.destination));
  let matched = 0, rendered = 0;
  for (const row of rows) { if (needle && !`${row.source} ${row.destination}`.includes(needle)) continue; matched += 1; if (rendered >= 800) continue; const tr = document.createElement('tr'); addCells(tr, [row.kind, row.source, row.destination, row.kind === 'override' ? `${row.band} / ch ${row.channel || '?'}` : row.band, row.frequency_mhz, `${row.snr_db} dB`]); body.appendChild(tr); rendered += 1; }
  $('table-summary').textContent = matched > rendered ? `Showing ${rendered} of ${matched} matching rules.` : `${rendered} matching rules.`;
}

function addCells(row, values) { for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell); } }

async function fetchControls() {
  const response = await fetch('/api/v1/controls', { cache: 'no-store' }); if (!response.ok) throw new Error(`controls HTTP ${response.status}`); state.controls = await response.json(); renderControls();
}

function renderControls() {
  const controls = state.controls || {}; const enabled = Boolean(controls.enabled); $('controls-badge').textContent = enabled ? 'enabled · typed' : 'disabled · read-only'; $('controls-badge').className = `badge ${enabled ? 'live' : 'disabled'}`; $('controls-reason').textContent = controls.reason || '';
  for (const id of ['control-source', 'control-destination', 'control-frequency', 'control-snr', 'pair-set', 'frequency-set', 'frequency-clear']) $(id).disabled = !enabled;
  $('control-undo').disabled = !enabled || !controls.undo?.available; $('controls-form').setAttribute('aria-disabled', String(!enabled));
}

async function issueControl(path, body) {
  if (!state.controls.enabled || !state.snapshot) return;
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wmediumd-CSRF': state.controls.csrf_token }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) { if (Number.isInteger(result.current_generation)) state.snapshot.daemon.generation = result.current_generation; throw new Error(result.error || `HTTP ${response.status}`); } state.snapshot.daemon.generation = result.generation; $('control-result').textContent = `${result.operation} applied as generation ${result.generation}; transaction ${result.transaction_id}`; await fetchControls();
}

function expected() { return { expected_instance_id: state.snapshot.daemon.instance_id, expected_generation: state.snapshot.daemon.generation }; }
function controlValues() { return { source: $('control-source').value, destination: $('control-destination').value, frequency_mhz: Number($('control-frequency').value), snr_db: Number($('control-snr').value) }; }
async function controlAction(action) { try { await action(); } catch (error) { $('control-result').textContent = `Control rejected: ${error.message}`; await fetchControls().catch(() => {}); } }

async function fetchSnapshot() { const response = await fetch('/api/v1/snapshot', { cache: 'no-store' }); if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`); render(await response.json()); }
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; const socket = new WebSocket(`${protocol}//${location.host}/api/v1/stream`);
  socket.addEventListener('open', () => setConnection(state.controls.enabled ? 'live · typed control' : 'live · read-only', 'live'));
  socket.addEventListener('message', (event) => { const update = JSON.parse(event.data); if (update.type === 'snapshot') render(update.snapshot); if (update.type === 'collector_error') setConnection(update.error || 'collector error', 'error'); });
  socket.addEventListener('close', () => { setConnection('reconnecting', 'waiting'); setTimeout(connect, 2000); }); socket.addEventListener('error', () => socket.close());
}

$('source-select').addEventListener('change', (event) => { state.selected = event.target.value; renderGraph(); renderTable(); });
$('graph-mode').addEventListener('change', renderGraph); $('active-filter').addEventListener('input', renderActiveLinks); $('link-filter').addEventListener('input', renderTable); $('kind-filter').addEventListener('change', renderTable);
$('pair-set').addEventListener('click', () => controlAction(() => { const item = controlValues(); return issueControl('/api/v1/controls/pairs/set', { ...expected(), updates: [{ source: item.source, destination: item.destination, snr_db: item.snr_db }] }); }));
$('frequency-set').addEventListener('click', () => controlAction(() => issueControl('/api/v1/controls/frequencies/set', { ...expected(), updates: [controlValues()] })));
$('frequency-clear').addEventListener('click', () => controlAction(() => { const item = controlValues(); return issueControl('/api/v1/controls/frequencies/clear', { ...expected(), targets: [{ source: item.source, destination: item.destination, frequency_mhz: item.frequency_mhz }] }); }));
$('control-undo').addEventListener('click', () => controlAction(() => issueControl('/api/v1/controls/undo', expected())));

Promise.all([fetchSnapshot(), fetchControls()]).catch((error) => setConnection(error.message, 'error')).finally(connect);
