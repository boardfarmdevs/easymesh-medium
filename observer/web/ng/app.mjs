import { ObserverClient } from './client.mjs';
import { MediumScene } from './scene.mjs';
import { signalColor, counter, frameType, fresh, keyOf, coalescePatch, nativeLoadValue } from './model.mjs';

const element = id => document.getElementById(id);
const node = (tag, text, className) => { const result = document.createElement(tag); if (text != null) result.textContent = text; if (className) result.className = className; return result; };
const pretty = value => value == null ? 'Unavailable' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const decimal = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
const exact = value => value == null ? '—' : counter(value).toLocaleString();
const age = stamp => !stamp || String(stamp).startsWith('0001-') ? 'not sampled' : `${Math.max(0, (Date.now() - Date.parse(stamp)) / 1000).toFixed(1)} s ago`;
const options = { mode: 'observed', arrangement: 'medium', expanded: [], minSNR: '', sort: 'label', direction: 'asc', animate: true };
const fields = ['mode', 'search', 'band', 'frequency', 'presence', 'role', 'traffic', 'type', 'minSNR', 'sort', 'direction', 'showMAC', 'arrangement', 'allEdges', 'fanout', 'animate'];
let data = {}, result = null, selection = null, tab = 'rf', frozen = false, servicesOpen = false, revision = 0, renderedRevision = 0, workerBusy = false, pendingPatch = {}, lastProcessed = '';
let scrollIndex = 0, lastSelectionKey = '', history = [], lastHistory = '', toastTimer;
let selectionControlsSignature = '';
let pendingOptions = false;
let rfCatalog = null;
fetch('/api/v2/rf-catalog').then(response => response.ok ? response.json() : null)
  .then(value => { rfCatalog = value; }).catch(() => {});
const worker = new Worker('/ng/worker.mjs', { type: 'module' });
const client = new ObserverClient();
const scene = new MediumScene(element('scene'), select);

function toast(message) { element('toast').textContent = message; element('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { element('toast').hidden = true; }, 7000); }
function setting(key, value) { try { if (value === undefined) return localStorage.getItem(`wmediumd-ng:${location.host}:${key}`); localStorage.setItem(`wmediumd-ng:${location.host}:${key}`, value); } catch { return null; } }
function property(list, label, value, title) { const term = node('dt', label), description = node('dd', pretty(value)); if (title) term.title = title; list.append(term, description); }
function notice(host, text) { host.append(node('p', text, 'notice')); }
function raw(host, title, value) { const details = node('details'), summary = node('summary', title), pre = node('pre', pretty(value)); details.append(summary, pre); host.append(details); }
function heading(host, text) { host.append(node('h3', text)); }
function rfGuide(host, anchor) { const link = node('a', 'How this RF property is modeled and observed ↗'); link.href = `/ng/rf-properties.html#${anchor}`; link.target = '_blank'; link.rel = 'noopener'; host.append(link); }
function properties(host, entries) { const list = node('dl'); for (const [label, value, title] of entries) property(list, label, value, title); host.append(list); return list; }

function interest() {
  const topics = frozen ? [] : ['radios', 'room'];
  if (!frozen) {
    topics.push(options.mode === 'observed' ? 'paths' : 'pairs');
    if (servicesOpen) topics.push('services', 'events', 'survey');
    if (element('events-enabled').checked) topics.push('events');
    if (selection) { topics.push('ownership', 'detail'); if (tab === 'traffic') topics.push('paths'); if (tab === 'load') topics.push('survey', 'vifs'); }
  }
  const source = selection?.source || selection?.mac || '', destination = selection?.destination || '';
  client.subscribe({ topics: [...new Set(topics)], source, destination, frequency_mhz: Number(selection?.frequency_mhz || 0) });
}
function process(patch = {}) {
  pendingPatch = coalescePatch(pendingPatch, patch);
  if (workerBusy || frozen) { pendingOptions = true; return; }
  pendingOptions = false;
  workerBusy = true; revision++;
  worker.postMessage({ patch: pendingPatch, options: { ...options, selection: undefined }, revision }); pendingPatch = {};
}
worker.onmessage = event => {
  workerBusy = false;
  if (event.data.error) { toast(`Explorer data error: ${event.data.error}`); return; }
  if (!frozen && event.data.revision >= renderedRevision) {
    renderedRevision = event.data.revision; result = event.data.result; render();
  }
  if (pendingOptions || Object.keys(pendingPatch).length) process();
};
worker.onerror = () => toast('The explorer worker could not load. Reload this page and check the console service version.');
client.addEventListener('status', event => { element('connection').textContent = event.detail; });
client.addEventListener('data', event => {
  if (frozen) return;
  const previousInstance = data.daemon?.instance_id;
  data = event.detail.data;
  if (previousInstance && previousInstance !== data.daemon?.instance_id) { history = []; lastHistory = ''; toast('Daemon restarted: RF readbacks and rate baselines reset.'); }
  process(event.detail.patch);
});

function render() {
  renderStatus(); renderTable(); renderSelectionControls(); renderInspector(); renderEvents(); if (servicesOpen) renderServices();
  const arrangement = options.mode === 'matrix' ? 'matrix' : options.arrangement;
  scene.setMode(arrangement); scene.labels.hidden = arrangement === 'matrix' || !scene.renderer;
  scene.update(result, data, { ...options, selection });
  if (!lastProcessed && result.radios.length) scene.fit();
  lastProcessed = data.sequence || '';
  const frequency = element('frequency');
  const signature = result.frequencies.join(',');
  if (frequency.dataset.signature !== signature) {
    frequency.dataset.signature = signature; frequency.replaceChildren(new Option('All frequencies', ''));
    for (const value of result.frequencies) frequency.add(new Option(`${value} MHz`, value));
    if (options.frequency && !result.frequencies.includes(Number(options.frequency))) frequency.add(new Option(`${options.frequency} MHz (cached)`, options.frequency));
    frequency.value = options.frequency || '';
  }
}
function renderStatus() {
  const stale = Date.now() - Date.parse(data.last_success || '') > 5000 || !data.daemon?.instance_id || data.summary?.available === false;
  const stats = data.summary?.summary || {}, rates = data.summary?.rates || {};
  element('health').classList.toggle('warning', Boolean(stale || data.error || data.health?.event_history_gap));
  element('health').textContent = `${frozen ? 'FROZEN VIEW · ' : ''}${stale ? 'STALE / UNAVAILABLE · ' : 'READ-ONLY · '}generation ${data.daemon?.generation ?? '—'} · ${decimal(rates.frames_per_second)} frames/s · queue ${stats.queue_depth ?? '—'} · last daemon sample ${age(data.last_success)}${data.error ? ` · ${data.error}` : ''}`;
  element('world').textContent = result?.roomValid ? data.room.data.world : 'Room overlay unavailable';
  const pool = element('pool'); pool.replaceChildren(node('strong', 'Client pool'));
  if (result) { pool.append(node('span', `${result.pool.present} present / ${result.pool.bound} bound`, 'value'), node('p', `${result.pool.excluded} room-excluded · ${result.pool.unknown} unknown. Excluded does not mean removed from hwsim or zero frames.`)); }
  const coverage = element('coverage'); coverage.replaceChildren(node('strong', 'Collection coverage'));
  for (const topic of options.mode === 'observed' ? ['paths', 'radios'] : ['pairs', 'frequencies']) {
    const status = data.coverage?.[topic]; coverage.append(node('p', `${topic}: ${status?.state || 'not requested'} · ${status?.rows ?? 0}/${status?.total ?? '?'} · ${age(status?.observed_at)}`));
  }
  if (data.identity_inventory?.error) coverage.append(node('p', `Names: ${data.identity_inventory.error}`));
  if (data.paths_delivered != null && options.mode === 'observed') coverage.append(node('p', `Browser paths: ${data.paths_delivered}/${data.paths_cached} cached rows delivered. Collection continues progressively.`));
  coverage.append(node('p', 'Pages are sampled over time, not an atomic traffic snapshot. A moving RF generation may prevent a complete matrix.'));
}

function renderTable() {
  if (!result) return;
  const viewport = element('table'), rows = element('table-rows'), total = result.rows.length;
  element('table-count').textContent = `${result.radios.length} radios · ${result.paths.length}/${result.totalPaths} paths`;
  element('table-spacer').style.height = `${total * 34}px`; viewport.setAttribute('aria-rowcount', total);
  const start = Math.max(0, Math.floor(viewport.scrollTop / 34) - 5), end = Math.min(total, start + Math.ceil(viewport.clientHeight / 34) + 12);
  rows.style.transform = `translateY(${start * 34}px)`; rows.replaceChildren();
  for (let index = start; index < end; index++) {
    const row = result.rows[index], item = node('div', null, `table-row row-${row.kind}`);
    item.setAttribute('role', 'row'); item.setAttribute('aria-rowindex', index + 1); item.setAttribute('aria-level', row.depth + 1); item.setAttribute('aria-selected', selection?.key === row.key); item.dataset.key = row.key;
    const name = node('span', null, 'tree-label'); name.style.paddingLeft = `${row.depth * 12}px`;
    if (row.kind !== 'path') {
      item.setAttribute('aria-expanded', row.expanded); const toggle = node('button', row.expanded ? '▾' : '▸', 'toggle'); toggle.tabIndex = -1; toggle.setAttribute('aria-label', `${row.expanded ? 'Collapse' : 'Expand'} ${row.label}`);
      toggle.addEventListener('click', event => { event.stopPropagation(); toggleRow(row.key); }); name.append(toggle);
    }
    const label = node('span', row.kind === 'path' ? row.destination_name : row.label); label.title = `${row.label}${row.mac ? ` · ${row.mac}` : ''}`; name.append(label); if (row.count != null) name.append(node('span', row.count, 'subtle'));
    if (options.showMAC && row.mac) label.textContent += ` · ${row.mac}`;
    const snr = node('span', row.snr == null ? '—' : `${decimal(row.snr)}`, 'snr'); snr.style.borderColor = signalColor(row.snr); snr.title = row.snrProvenance || 'Not measured';
    const cells = [name, node('span', row.frequency_mhz ? `${row.band || ''} ${row.frequency_mhz}` : row.kind === 'path' ? 'Pair' : '—'), snr,
      node('span', decimal(row.rate)), node('span', exact(row.drops)), node('span', row.age == null ? '—' : `${decimal(row.age)} s`), node('span', row.kind === 'radio' ? row.presence : row.kind === 'path' ? `${row.multicast ? 'Fan-out + ' : ''}${row.type}` : `${row.count} directed paths`)];
    for (const cell of cells) { cell.setAttribute('role', 'gridcell'); item.append(cell); }
    item.addEventListener('click', () => { scrollIndex = index; select(row); viewport.focus({ preventScroll: true }); }); rows.append(item);
  }
}
function toggleRow(key, expanded) {
  const keys = new Set(options.expanded); if (expanded ?? !keys.has(key)) keys.add(key); else keys.delete(key);
  options.expanded = [...keys]; process();
}
element('table').addEventListener('scroll', () => renderTable(), { passive: true });
element('table').addEventListener('keydown', event => {
  if (!result?.rows.length || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'ArrowDown') scrollIndex++;
  if (event.key === 'ArrowUp') scrollIndex--;
  if (event.key === 'Home') scrollIndex = 0;
  if (event.key === 'End') scrollIndex = result.rows.length - 1;
  scrollIndex = Math.min(result.rows.length - 1, Math.max(0, scrollIndex)); const row = result.rows[scrollIndex];
  if (event.key === 'ArrowLeft') toggleRow(row.key, false); else if (event.key === 'ArrowRight' && row.kind !== 'path') toggleRow(row.key, true); else select(row);
  const top = scrollIndex * 34, viewport = element('table'); if (top < viewport.scrollTop || top + 34 > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = Math.max(0, top - viewport.clientHeight / 2);
});

function select(row) {
  if (!row) return;
  selection = { key: row.key, kind: row.kind, source: row.source, destination: row.destination, mac: row.mac, frequency_mhz: row.frequency_mhz || 0, label: row.label };
  if (lastSelectionKey !== row.key) { history = []; lastHistory = ''; lastSelectionKey = row.key; }
  renderSelectionControls(); interest(); renderTable(); renderInspector(); if (result) scene.update(result, data, { ...options, selection });
}
function renderSelectionControls() {
  const signature = JSON.stringify([selection, result?.allRadios.map(radio => [radio.mac, radio.label]), result?.frequencies]);
  if (signature === selectionControlsSignature) return;
  selectionControlsSignature = signature;
  const controls = element('selection-controls'); controls.replaceChildren(); if (!selection) return;
  const source = selection.source || selection.mac;
  const label = node('label', 'Inspect destination'), destination = node('select'); destination.add(new Option('Radio only', ''));
  for (const radio of result?.allRadios || []) if (radio.mac !== source) destination.add(new Option(radio.label, radio.mac));
  destination.value = selection.destination || ''; label.append(destination); controls.append(label);
  const frequencyLabel = node('label', 'Readback frequency'), frequency = node('select'); frequency.add(new Option('Pair fallback only', '0'));
  const values = new Set([...(result?.frequencies || []), Number(selection.frequency_mhz || 0)]); values.delete(0);
  for (const value of [...values].sort((left, right) => left - right)) frequency.add(new Option(`${value} MHz`, value));
  frequency.value = String(selection.frequency_mhz || 0); frequencyLabel.append(frequency); controls.append(frequencyLabel);
  const update = () => { const target = destination.value; select({ kind: target ? 'path' : 'radio', mac: source, source, destination: target, frequency_mhz: Number(frequency.value), key: target ? keyOf({ source, destination: target, frequency_mhz: frequency.value }) : source, label: result?.allRadios.find(radio => radio.mac === source)?.label || source }); };
  destination.addEventListener('change', update); frequency.addEventListener('change', update);
}
function renderInspector() {
  const host = element('properties');
  const openDetails = new Set([...host.querySelectorAll('details[open]')].map(item => item.querySelector('summary').textContent));
  const scrollTop = element('inspector').scrollTop;
  host.replaceChildren(); if (!selection) return;
  const source = selection.source || selection.mac, destination = selection.destination, frequency = Number(selection.frequency_mhz || 0);
  const radio = result?.allRadios.find(row => row.mac === source), peer = result?.allRadios.find(row => row.mac === destination);
  element('selection-title').textContent = destination ? `${radio?.label || source} → ${peer?.label || destination}` : radio?.label || source;
  const path = (data.paths || []).find(row => row.source === source && row.destination === destination && Number(row.frequency_mhz) === frequency);
  const key = keyOf({ source, destination, frequency_mhz: frequency });
  if (tab === 'rf') renderRF(host, radio, peer, frequency, key);
  if (tab === 'traffic') renderTraffic(host, radio, path, key);
  if (tab === 'load') renderLoad(host, radio, frequency);
  if (tab === 'evidence') {
    properties(host, [['Daemon instance', data.daemon?.instance_id], ['Current generation', data.daemon?.generation], ['Radio identity', source], ['Inventory owner', radio?.owner], ['Role', radio?.role], ['Identity inventory', data.identity_inventory?.path], ['Inventory generated', data.identity_inventory?.generated_at], ['Room role', radio?.roleState?.role]]);
    raw(host, 'Selected RF readbacks', data.selected); raw(host, 'Protocol ownership', radio?.ownership); raw(host, 'Room intent / recovery', radio?.roleState);
    raw(host, 'VIF aliases', (data.vifs || []).filter(row => row.radio === source)); raw(host, 'Collection coverage', data.coverage); raw(host, 'Capabilities', data.daemon?.capabilities);
  }
  if (selection.destination && path && path.last_update_sequence !== lastHistory) {
    lastHistory = path.last_update_sequence; history.push({ at: Date.now(), snr: Number(path.last_snr_db), frames: path.frames, drops: result?.paths.find(row => row.key === key)?.drops }); history = history.filter(sample => Date.now() - sample.at <= 300000).slice(-150);
  }
  const historyHost = element('history'); historyHost.replaceChildren();
  if (history.length) { heading(historyHost, 'Selected path · up to 5 minutes'); const graph = node('div', null, 'histogram'); for (const sample of history.slice(-60)) { const bar = node('span'); bar.style.height = `${Math.max(2, Math.min(100, (sample.snr + 10) * 2))}%`; bar.title = `${new Date(sample.at).toLocaleTimeString()} · last SNR ${sample.snr} dB · frames ${sample.frames}`; graph.append(bar); } historyHost.append(graph, node('p', 'Last packet SNR; local history starts when selected. No history is inferred before collection.', 'hint')); }
  for (const details of host.querySelectorAll('details')) details.open = openDetails.has(details.querySelector('summary').textContent);
  element('inspector').scrollTop = scrollTop;
}
function renderRF(host, radio, peer, frequency, key) {
  rfGuide(host, 'directed-snr');
  if (rfCatalog) raw(host, 'Shared RF property catalog · support is not policy use', rfCatalog);
  properties(host, [['Radio', radio?.label], ['Room presence', radio?.presence], ['Observed association', radio?.ownership?.available ? radio.ownership.data.evidence : 'Unavailable'], ['Owner radio', radio?.ownership?.data?.owner], ['Ownership fetched', radio?.ownership ? age(radio.ownership.observed_at) : 'not requested']]);
  if (radio?.presence === 'room-excluded') {
    notice(host, 'This client remains a bound hwsim radio. Room exclusion requests low-SNR RF gating plus client disconnection; it does not delete a container or prove RF silence.');
    properties(host, [['Disconnect journal', radio.roleState?.disconnect_requested ? 'requested / recorded' : 'not recorded'], ['Room generation', data.room?.data?.generation], ['Room RF application', data.room?.data?.last_rf_applied_at]]);
  }
  if (radio?.presence === 'unknown') notice(host, 'No fresh, matching room evidence. Do not infer that this radio is offline.');
  const contexts = (data.radio_frequencies || []).filter(row => row.radio === radio?.mac);
  raw(host, 'Observed radio/frequency contexts', contexts);
  if (!selection.destination) { notice(host, 'Choose a destination for exact directed RF readback and its reverse direction.'); return; }
  heading(host, 'Current RF readback');
  for (const [source, destination, title] of [[selection.source || selection.mac, selection.destination, 'Forward'], [selection.destination, selection.source || selection.mac, 'Reverse']]) {
    const baseline = data.selected?.[keyOf({ source, destination, frequency_mhz: 0 })];
    const startup = data.details?.[keyOf({ source, destination, frequency_mhz: 0 })]?.data;
    const rule = data.selected?.[keyOf({ source, destination, frequency_mhz: frequency })];
    const valid = rule && !rule.error && rule.generation === data.daemon?.generation && Date.now() - Date.parse(rule.observed_at) < 5000;
    properties(host, [[`${title} pair`, baseline ? `${baseline.snr_db} dB · generation ${baseline.generation}` : 'Waiting for selected readback'], [`${title} effective`, valid ? `${rule.snr_db} dB · ${rule.override ? 'exact-frequency override' : 'pair fallback'}` : 'Unverified / warming up'], [`${title} frequency`, frequency ? `${frequency} MHz` : 'all-frequency pair'], [`${title} sampled`, rule ? age(rule.observed_at) : 'not sampled']]);
    properties(host, [[`${title} observer-start baseline`, startup?.startup_snr_db == null ? 'Unavailable on this daemon' : `${startup.startup_snr_db} dB · captured at generation ${startup.baseline_generation}`]]);
    if (rule?.error) notice(host, `${title} readback: ${rule.error}`);
  }
  notice(host, 'Configured SNR is a simulation input; last-packet SNR is an observation. Static startup configuration, current pair values and dynamic frequency overrides are different sources. The startup file hash is in Services.');
}
function renderTraffic(host, radio, path, key) {
  rfGuide(host, 'packet-error-probability-and-loss');
  if (path) {
    const row = result?.paths.find(row => row.key === key);
    properties(host, [['Path counters sampled', path.sampled_at ? age(path.sampled_at) : 'Unknown']]);
    properties(host, [['Path record', `${path.source} → ${path.destination} @ ${path.frequency_mhz} MHz`], ['TX frames (lifetime)', path.frames], ['TX attempts / retries', `${path.attempts} / ${path.retries}`], ['ACKed / not ACKed', `${path.acked} / ${path.no_ack}`], ['RX injections (lifetime)', path.rx_injected], ['Frames/s', decimal(row?.rate)], ['Last signal / SNR', `${path.last_signal_dbm} dBm / ${path.last_snr_db} dB`], ['Last PER', `${decimal(Number(path.last_per_million) / 10000)}%`], ['Last frame', frameType(path.last_type, path.last_subtype)], ['Last access category', ['Voice (VO)', 'Video (VI)', 'Best effort (BE)', 'Background (BK)'][Number(path.last_access_category)] || 'Unavailable'], ['Includes multicast fan-out', path.multicast ? 'Yes; may also contain unicast' : 'No multicast flag observed']]);
    heading(host, 'Outcome counters'); properties(host, ['offchannel', 'cca', 'interference', 'per', 'no_receiver'].map(reason => [`Drop · ${reason}`, path[`drops_${reason}`]]));
    notice(host, 'TX frames and receiver candidates have different counting boundaries. A multicast-only path can have RX outcomes with zero TX frames. Never sum both as unique packets.');
  } else notice(host, selection.destination ? 'No traffic record collected yet for this exact directed frequency. The full scan can take time; the selected frame window below updates independently. Missing collection is not proof of no traffic.' : 'Choose a destination for packet-path details.');
  const detail = data.details?.[key];
  heading(host, 'Selected frame-type window');
  if (!data.daemon?.capabilities?.includes('explorer_details')) notice(host, 'This daemon has legacy path telemetry: last type/subtype only. Install the Console NG telemetry patch for leased subtype counters and header metadata.');
  else if (!fresh(detail)) notice(host, 'Warming up selected detail. This is a bounded diagnostic window, not lifetime history.');
  else {
    const detailData = detail.data;
    properties(host, [['Window start (daemon µs)', detailData.started_usec], ['Sample (daemon µs)', detailData.observed_usec], ['Window lease', '15 seconds; renewed only while selected'], ['Ring overwrites', detailData.header_overwrites], ['Scope', detailData.scope]]);
    properties(host, [['TX unicast / multicast', `${detailData.tx_unicast} / ${detailData.tx_multicast}`], ['RX unicast / multicast candidates', `${detailData.rx_unicast} / ${detailData.rx_multicast}`], ['TX / RX EAPOL', `${detailData.tx_eapol} / ${detailData.rx_eapol}`]]);
    for (const boundary of ['tx', 'rx']) {
      heading(host, boundary === 'tx' ? 'TX decisions by type/subtype' : 'RX candidates by type/subtype');
      const counts = detailData[`${boundary}_subtypes`] || []; const entries = counts.map((value, index) => [frameType(Math.floor(index / 16), index % 16), value]).filter(entry => counter(entry[1]) > 0n);
      if (entries.length) properties(host, entries); else host.append(node('p', 'No samples in this window.', 'hint'));
    }
    raw(host, 'Recent selected headers (no payload)', detailData.headers); raw(host, 'Full selected telemetry', detailData);
  }
  raw(host, 'Source radio type counters', (data.radio_frequencies || []).filter(row => row.radio === radio?.mac));
}
function renderLoad(host, radio, frequency) {
  rfGuide(host, 'channel-utilization');
  const survey = data.survey, status = survey?.data;
  const recorded = counter(status?.recorded_monotonic_ns), reader = counter(status?.reader_monotonic_ns);
  const bridgeAge = reader >= recorded && recorded > 0n ? Number(reader - recorded) / 1e9 + Math.max(0, (Date.now() - Date.parse(survey.observed_at)) / 1000) : null;
  const publicationValid = recorded > 0n && reader >= recorded && reader - recorded <= 1000000000n;
  const valid = fresh(survey) && status?.instance_id === data.daemon?.instance_id && publicationValid;
  heading(host, 'Modeled medium / driver survey');
  properties(host, [['Source', status?.source], ['Profile', status?.profile], ['Bridge cache age', bridgeAge === null ? 'Unknown' : `${decimal(bridgeAge)} s`], ['Publication when cache read', publicationValid ? 'within 1-second TTL' : 'stale / unknown'], ['Driver right now', bridgeAge !== null && bridgeAge <= 1 && valid ? 'recent publication; consumption not queried' : 'not queried; cache age exceeds TTL'], ['Physical capacity qualified', 'No'], ['Channel width', '20 MHz provider contexts only']]);
  if (!valid) notice(host, `Survey unavailable or stale: ${survey?.error || 'no matching fresh provider sample'}. It must not be displayed as zero utilization.`);
  for (const observation of status?.channel_observations || []) {
    if (frequency && Number(observation.frequency_mhz) !== frequency) continue;
    const usable = valid && observation.state === 'valid'; properties(host, [[`Global channel ${observation.frequency_mhz} MHz`, usable ? `${decimal(observation.value)}% modeled busy` : observation.state || 'Unavailable'], ['Observation window', observation.window_us ? `${decimal(Number(observation.window_us) / 1000)} ms` : 'warming up']]);
    if (usable) { const meter = node('div', null, 'meter'), fill = node('span'); fill.style.width = `${Math.min(100, Math.max(0, Number(observation.value)))}%`; meter.append(fill); host.append(meter); }
  }
  const written = (status?.written || []).filter(row => row.radio === radio?.mac && (!frequency || Number(row.frequency_mhz) === frequency));
  for (const context of written) {
    const active = counter(context.active_us), busy = counter(context.busy_us);
    const usable = valid && active > 0n && busy >= 0n && busy <= active;
    properties(host, [[`Radio-local ${context.frequency_mhz} MHz`, usable ? `${decimal(Number(busy * 10000n / active) / 100)}% published busy / active` : 'Unavailable / stale'], ['Published active / busy', `${context.active_us} / ${context.busy_us} µs`], ['Context epoch / provider', `${context.epoch} / ${context.provider}`]]);
  }
  raw(host, 'Radio-local published contexts / epochs', written);
  notice(host, 'Global channel occupancy and a radio-local survey are not interchangeable. Values model airtime visibility, not physical RF throughput. Provider writes are not proof of a fresh beacon.');
  heading(host, 'Native EasyMesh BSS load');
  const native = data.room?.data?.native, aliases = new Map((data.vifs || []).filter(row => row.radio === radio?.mac).map(row => [row.mac, row]));
  const records = (native?.bss_loads || []).filter(row => {
    const context = aliases.get(row.bssid);
    const matched = Boolean(context) || row.radio_id === radio?.mac || (row.role && row.role === radio?.roleState?.role);
    const observedFrequency = Number(row.frequency_mhz || context?.frequency_mhz);
    return matched && (!frequency || !observedFrequency || observedFrequency === frequency);
  });
  if (!records.length) notice(host, 'No cached native BSS-load record correlated to this radio. No AP query or packet capture is triggered by this panel.');
  for (const record of records) {
    const context = aliases.get(record.bssid);
    const observedFrequency = Number(record.frequency_mhz || context?.frequency_mhz);
    properties(host, [['Native channel / observed BSSID frequency', `${record.channel ?? 'unknown'} / ${observedFrequency ? `${observedFrequency} MHz` : 'unverified; not necessarily the selected frequency'}`]]);
    const sample = nativeLoadValue(record, native, result?.roomValid);
    if (record.context_state === 'unverified') notice(host, 'Fresh native BSSID/device report; radio/channel join unverified. Not policy evidence.');
    const byte = sample.utilization;
    properties(host, [['BSSID', record.bssid], ['Native report freshness', sample.valid ? age(record.observed_at) : 'stale / unknown'], ['Channel utilization byte', byte], ['Byte / 255', byte == null ? 'Unavailable' : `${decimal(Number(byte) * 100 / 255)}%`], ['Station count', sample.station_count], ['Source / transport', `${record.source || 'unknown'} / ${record.transport || 'unknown'}`], ['Epoch', record.epoch]]);
  }
  if (native) raw(host, 'Shared RF observations · not decision-used values', native.observations || native);
  const backhaul = native?.backhaul?.paths?.find(row => row.role === radio?.roleState?.role);
  if (backhaul) {
    heading(host, 'Native backhaul path · inspection only');
    const seconds = (Date.now() - Date.parse(backhaul.observed_at)) / 1000;
    const validPath = result?.roomValid && backhaul.state === 'valid' && seconds >= 0 && seconds <= 5;
    properties(host, [['Actual path', validPath ? backhaul.path.join(' → ') : 'Unavailable / stale'],
      ['Wireless hops', validPath ? backhaul.wireless_hops : null]]);
    if (validPath) for (const link of backhaul.links || []) {
      const value = record => {
        const elapsed = (Date.now() - Date.parse(record?.observed_at)) / 1000;
        return record?.state === 'valid' && elapsed >= 0 && elapsed <= 5 ? `${record.value} ${record.unit}` : 'Unavailable';
      };
      properties(host, [['Hop', `${link.role} → ${link.parent_role}`], ['Frequency MHz', link.frequency_mhz],
        ['Native signal', value(link.signal)], ['AP utilization', value(link.utilization)], ['Backhaul traffic', value(link.traffic)]]);
    }
    notice(host, 'Same-frequency hops may contend. Load is not additive; this explanation neither estimates capacity nor changes steering.');
  }
  if (native?.error) notice(host, native.error);
  heading(host, 'Advertised beacon BSS Load');
  let advertised = false;
  for (const [key, detail] of Object.entries(data.details || {})) {
    if (!key.startsWith(`${radio?.mac}>`) || !fresh(detail) || (frequency && Number(detail.data?.frequency_mhz) !== frequency)) continue;
    const beacon = detail.data?.beacon_bss_load;
    if (!beacon || Number(detail.data.observed_usec) - Number(beacon.observed_usec) > 5000000) continue;
    advertised = true;
    properties(host, [['Observed BSSID', beacon.bssid], ['Beacon utilization byte', beacon.utilization], ['Beacon utilization / 255', `${decimal(Number(beacon.utilization) * 100 / 255)}%`], ['Beacon station count', beacon.station_count], ['Available admission capacity', `${beacon.admission_capacity} × 32 µs/s`], ['Evidence', 'BSS Load IE in a processed beacon header, not proof of successful receiver delivery']]);
  }
  if (!advertised) notice(host, 'No fresh beacon BSS Load IE observed in the selected path window. Select this AP → a receiver and exact frequency to collect bounded header metadata. A native report is not proof of a beacon IE.');
  if (status?.errors?.length) raw(host, 'Survey bridge errors', status.errors);
}

function renderServices() {
  const host = element('services');
  const openDetails = new Set([...host.querySelectorAll('details[open]')].map(item => item.querySelector('summary').textContent));
  host.replaceChildren();
  const collector = data.collector || {}, service = data.service;
  heading(host, 'Console observer');
  properties(host, [['Read-only', collector.read_only], ['Shared subscriptions', collector.subscriptions], ['Socket requests / bytes', `${collector.requests ?? '—'} / ${collector.bytes ?? '—'}`], ['Read budget', `${collector.request_budget_per_second ?? 10} requests/s · ${collector.byte_budget_per_second ?? 262144} bytes/s`], ['Daemon contact', age(data.last_success)], ['Summary sampled', age(data.captured_at)]]);
  heading(host, 'Daemon control services');
  rfGuide(host, 'noise-reference-and-cca');
  if (fresh(service)) {
    const status = service.data;
    properties(host, [['Airtime fidelity', status.airtime_profile], ['Survey width', status.survey_width_mhz == null ? 'Unavailable' : `${status.survey_width_mhz} MHz`], ['Fixed noise reference', status.noise_reference_dbm == null ? 'Unavailable' : `${status.noise_reference_dbm} dBm (not measured)`], ['CCA threshold', status.cca_threshold_dbm == null ? 'Unavailable' : `${status.cca_threshold_dbm} dBm`], ['Independent reverse ACK', status.independent_reverse_ack], ['Interference enabled', status.interference_enabled], ['Fading coefficient', status.fading_coefficient], ['Daemon packet capture enabled', status.pcap_enabled]]);
  }
  if (fresh(service)) { const status = service.data; properties(host, [['Visibility contention', status.visibility_contention], ['Priority queues', status.priority_queues], ['Survey enabled', status.survey_enabled], ['Model', status.model], ['Last writer PID / UID', `${status.last_writer_pid ?? 'unknown'} / ${status.last_writer_uid ?? 'unknown'}`], ['Last writer generation', status.last_writer_generation], ['Last write (daemon µs)', status.last_write_usec]]); raw(host, 'Connections, requests and protocol errors', status.endpoints); raw(host, 'Runtime modes / observer capacities', status); }
  else notice(host, service?.error || 'Detailed service accounting needs the Console NG daemon capability. Existing summary counters remain available.');
  const opcodeNames = ['reserved', 'hello', 'status', 'apply pairs', 'read pair', 'dump pairs', 'apply frequencies', 'read frequency', 'dump frequencies', 'summary', 'radio contexts', 'active paths', 'VIFs', 'events', 'association', 'channel survey', 'observer surveys', 'NG detail'];
  if (fresh(service)) for (const endpoint of service.data.endpoints || []) {
    heading(host, endpoint.name);
    properties(host, [['Connections', endpoint.connections], ['RPC requests / bytes', `${endpoint.requests} / ${endpoint.request_bytes}`], ['Framing errors', endpoint.protocol_errors], ['I/O or opcode disconnects', endpoint.io_or_opcode_disconnects], ['Handler maximum', `${endpoint.handler_usec_max} µs`]]);
    properties(host, (endpoint.opcodes || []).map((count, index) => [opcodeNames[index] || `opcode ${index}`, count]).filter(entry => counter(entry[1]) > 0n));
  }
  heading(host, 'Independent sources'); properties(host, [['Room source', fresh(data.room) ? `${data.room.data?.world} · ${age(data.room.observed_at)}` : data.room?.error || 'not connected'], ['Room writer (reported intent)', data.room?.data?.writer], ['Room requested generation', data.room?.data?.generation], ['Recovery journal', data.room?.data?.recovery?.state], ['Survey source', data.survey?.data?.source || data.survey?.error || 'not requested']]);
  notice(host, 'A PID/UID identifies a socket peer, not a verified service name. A missing HTTP/file source does not prove its systemd unit is stopped.');
  raw(host, 'Configuration and binary hashes', data.artifacts); raw(host, 'Capabilities', data.daemon?.capabilities);
  raw(host, 'Packet, scheduler and netlink counters', data.summary?.summary);
  for (const details of host.querySelectorAll('details')) details.open = openDetails.has(details.querySelector('summary').textContent);
}
function renderEvents() {
  const host = element('timeline'); host.replaceChildren();
  if (!element('events-enabled').checked && !servicesOpen) { host.textContent = 'Event collection is off. Enable it to observe generations, learned VIFs, active paths and netlink rejections.'; return; }
  if (data.health?.event_history_gap) host.append(node('div', 'History gap: some events are unavailable.'));
  const names = new Map((result?.allRadios || []).map(row => [row.mac, row.label]));
  const filtered = (data.events || []).filter(event => !selection || !event.source || event.source === (selection.source || selection.mac) || event.destination === (selection.source || selection.mac));
  for (const event of filtered.slice(-100).reverse()) host.append(node('div', `#${event.sequence} · ${event.type} · ${names.get(event.source) || event.source || ''} ${event.destination ? `→ ${names.get(event.destination) || event.destination}` : ''} ${event.frequency_mhz ? `${event.frequency_mhz} MHz` : ''} · value ${event.value}`));
}

for (const field of fields) {
  const control = element(field), saved = ['showMAC', 'arrangement', 'animate'].includes(field) ? setting(field) : null;
  if (saved != null) { if (control.type === 'checkbox') control.checked = saved === 'true'; else control.value = saved; }
  options[field] = control.type === 'checkbox' ? control.checked : control.value;
  control.addEventListener(field === 'search' || field === 'minSNR' ? 'input' : 'change', () => {
    options[field] = control.type === 'checkbox' ? control.checked : control.value;
    if (['showMAC', 'arrangement', 'animate'].includes(field)) setting(field, String(options[field]));
    if (field === 'mode') { element('table').scrollTop = 0; options.expanded = []; }
    process(); interest();
  });
}
for (const button of document.querySelectorAll('[data-preset]')) button.addEventListener('click', () => {
  for (const field of ['presence', 'role', 'traffic', 'type', 'band', 'frequency', 'search', 'minSNR']) { element(field).value = ''; options[field] = ''; }
  const preset = button.dataset.preset;
  if (preset === 'present' || preset === 'excluded') { options.presence = preset === 'present' ? 'present' : 'room-excluded'; element('presence').value = options.presence; }
  if (preset === 'drops') { options.traffic = 'drops'; element('traffic').value = 'drops'; }
  if (preset === 'mesh') { options.role = 'mesh'; const choice = element('role'); if (![...choice.options].some(item => item.value === 'mesh')) choice.add(new Option('All mesh radios', 'mesh')); choice.value = 'mesh'; }
  process();
});
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => { tab = button.dataset.tab; document.querySelectorAll('[data-tab]').forEach(item => item.setAttribute('aria-pressed', item === button)); interest(); renderInspector(); });
element('services-toggle').addEventListener('click', () => { servicesOpen = !servicesOpen; element('services').hidden = !servicesOpen; element('services-toggle').setAttribute('aria-expanded', servicesOpen); interest(); renderServices(); });
element('events-enabled').addEventListener('change', () => { interest(); renderEvents(); });
element('fit').addEventListener('click', () => scene.fit());
element('expand').addEventListener('click', () => { const keys = new Set(options.expanded); for (const radio of result?.radios || []) keys.add(radio.mac); for (const path of result?.paths || []) keys.add(`${path.source}@${path.frequency_mhz}`); options.expanded = [...keys]; process(); });
element('collapse').addEventListener('click', () => { options.expanded = []; process(); });
element('freeze').addEventListener('click', () => { frozen = !frozen; element('freeze').textContent = frozen ? 'Resume live view' : 'Freeze view'; element('freeze').setAttribute('aria-pressed', frozen); interest(); if (!frozen) { client.send('resync'); process(); } scene.animate = !frozen && options.animate; renderStatus(); });
element('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { toast('Full screen is unavailable in this browser.'); } });
document.addEventListener('fullscreenchange', () => { element('fullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
function download(name, text, type) { const url = URL.createObjectURL(new Blob([text], { type })), link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
element('export').addEventListener('click', async () => {
  try { const response = await fetch('/api/v2/export', { cache: 'no-store' }), document = await response.json(); if (!response.ok) throw new Error(document.error); download('wmediumd-console-ng.json', JSON.stringify(document, null, 2), 'application/json'); }
  catch (error) { toast(error.message); }
});
element('csv').addEventListener('click', () => {
  if (!result) return;
  const fields = ['source_name', 'destination_name', 'source', 'destination', 'frequency_mhz', 'snr', 'snrProvenance', 'rate', 'frames', 'rx_injected', 'drops', 'age', 'type', 'multicast'];
  const cell = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, character => `'${character}`).replaceAll('"', '""')}"`;
  download('wmediumd-filtered-paths.csv', [fields.join(','), ...result.paths.map(row => fields.map(field => cell(row[field])).join(','))].join('\n'), 'text/csv');
});
const divider = element('divider');
function resizeSidebar(width) { width = Math.max(180, Math.min(500, width)); document.documentElement.style.setProperty('--sidebar', `${width}px`); divider.setAttribute('aria-valuenow', width); setting('sidebar', width); }
if (setting('sidebar')) resizeSidebar(Number(setting('sidebar')));
divider.addEventListener('pointerdown', event => { divider.setPointerCapture(event.pointerId); const move = movement => resizeSidebar(movement.clientX); divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', () => divider.removeEventListener('pointermove', move), { once: true }); });
divider.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); resizeSidebar(Number(divider.getAttribute('aria-valuenow')) + (event.key === 'ArrowLeft' ? -10 : 10)); } });
new ResizeObserver(renderTable).observe(element('table'));
setInterval(() => { if (!document.hidden && !frozen) { renderStatus(); if (result) process(); } }, 2000);
window.addEventListener('pagehide', () => { client.close(); worker.terminate(); scene.dispose(); }, { once: true });
interest();
