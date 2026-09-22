export const keyOf = row => `${row.source}>${row.destination}@${row.frequency_mhz || 0}`;
export const number = value => value === undefined || value === null || value === '' ? null : Number(value);
export const counter = value => { try { return BigInt(value ?? 0); } catch { return 0n; } };
export function applyPathPatch(cache, patch) {
  if (patch.paths_reset || Array.isArray(patch.paths)) cache.clear();
  for (const row of patch.paths || []) cache.set(keyOf(row), row);
  for (const key of patch.path_removed || []) cache.delete(key);
  for (const row of patch.path_updates || []) cache.set(keyOf(row), row);
  return [...cache.values()];
}
export function coalescePatch(pending, patch) {
  const reset = patch.paths_reset || Array.isArray(patch.paths);
  const updates = new Map((reset ? [] : pending.path_updates || []).map(row => [keyOf(row), row]));
  const removed = new Set(reset ? [] : pending.path_removed || []);
  for (const key of patch.path_removed || []) { updates.delete(key); removed.add(key); }
  for (const row of patch.path_updates || []) { const key = keyOf(row); updates.set(key, row); removed.delete(key); }
  const result = { ...pending, ...patch };
  if (pending.path_updates || patch.path_updates || reset) {
    result.path_updates = [...updates.values()]; result.path_removed = [...removed];
    result.paths_reset = Boolean(pending.paths_reset || patch.paths_reset);
  }
  return result;
}
export const drops = row => ['offchannel', 'cca', 'interference', 'per', 'no_receiver'].reduce((total, reason) => total + counter(row[`drops_${reason}`]), 0n);
export const bandOf = frequency => frequency >= 5955 ? '6GHz' : frequency >= 5000 ? '5GHz' : frequency >= 2300 ? '2.4GHz' : 'unknown';
export const signalColor = value => value === null || value === undefined ? '#83909c' : Number(value) < 15 ? '#eb6965' : Number(value) < 25 ? '#e5ba4e' : '#62c798';
export function frameType(type, subtype) {
  const classes = ['Management', 'Control', 'Data', 'Extension'];
  const management = ['Association request', 'Association response', 'Reassociation request', 'Reassociation response', 'Probe request', 'Probe response', 'Timing', 'Reserved', 'Beacon', 'ATIM', 'Disassociation', 'Authentication', 'Deauthentication', 'Action'];
  if (type === undefined || type === null) return 'Unavailable';
  return Number(type) === 0 ? management[Number(subtype)] || `Management / ${subtype}` : `${classes[Number(type)] || 'Unknown'} / subtype ${subtype ?? '?'}`;
}
export function fresh(report, now = Date.now(), seconds = 5) {
  return Boolean(report?.available && now - Date.parse(report.observed_at) < seconds * 1000);
}
export function compare(left, right) {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  if (/^-?\d+$/.test(String(left)) && /^-?\d+$/.test(String(right))) {
    const first = counter(left), second = counter(right);
    return first < second ? -1 : first > second ? 1 : 0;
  }
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}
export class MediumModel {
  constructor() { this.instance = ''; this.previous = new Map(); this.rates = new Map(); this.pathRows = new Map(); this.data = {}; }
  update(patch, now = Date.now()) {
    const instance = patch.daemon?.instance_id || this.instance;
    if (instance !== this.instance) { this.previous.clear(); this.rates.clear(); this.pathRows.clear(); this.data = {}; this.instance = instance; }
    if (patch.paths || patch.path_updates || patch.path_removed || patch.paths_reset) patch = { ...patch, paths: applyPathPatch(this.pathRows, patch) };
    this.data = { ...this.data, ...patch };
    if (patch.paths) {
      const sampled = Date.parse(this.data.coverage?.paths?.observed_at) || now;
      const liveKeys = new Set();
      for (const row of patch.paths) {
        const observed = Date.parse(row.sampled_at) || sampled;
        const key = keyOf(row), before = this.previous.get(key);
        liveKeys.add(key);
        const seconds = before ? (observed - before.at) / 1000 : 0;
        const reset = !before || before.first !== row.first_seen_usec || counter(row.frames) < before.frames || counter(row.last_update_sequence) < before.sequence;
        if (reset || seconds > 0) {
          this.rates.set(key, reset ? null : Number(counter(row.frames) - before.frames) / seconds);
          this.previous.set(key, { frames: counter(row.frames), sequence: counter(row.last_update_sequence), first: row.first_seen_usec, at: observed });
        }
      }
      for (const key of this.previous.keys()) if (!liveKeys.has(key)) { this.previous.delete(key); this.rates.delete(key); }
    }
    return this.data;
  }
  explore(options = {}, now = Date.now()) {
    const data = this.data;
    const roomValid = fresh(data.room, now) && data.room.data?.live !== false && !data.room.data?.fault && data.room.data?.instance_id === data.daemon?.instance_id;
    const roleByRadio = new Map(), roleByOwner = new Map();
    if (roomValid) for (const role of data.room.data.roles || []) {
      if (role.radio) roleByRadio.set(role.radio, role);
      for (const radio of Object.values(role.band_radios || {})) if (radio.tx_mac) roleByRadio.set(radio.tx_mac, role);
      if (role.container) roleByOwner.set(role.container, role);
    }
    const age = value => value == null ? null : Math.max(0, (Number(data.summary?.summary?.uptime_usec || 0) - Number(value)) / 1e6 + Math.max(0, (now - Date.parse(data.captured_at)) / 1000));
    const names = new Map();
    const radios = (data.radios || []).map(radio => {
      const role = roleByRadio.get(radio.mac) || roleByOwner.get(radio.owner);
      const ownership = data.ownership?.[radio.mac];
      const row = { ...radio, kind: 'radio', key: radio.mac, label: radio.label || role?.role?.replace('extender_', 'ext-') || radio.mac,
        presence: role ? (role.present ? 'present' : 'room-excluded') : 'unknown', roleState: role,
        position: role?.position || null, ownership: ownership || null,
        ownershipFresh: fresh(ownership, now, 15), depth: 0 };
      names.set(radio.mac, row);
      return row;
    });
    const frequencyOverrides = new Map((data.frequencies || []).map(row => [keyOf(row), row]));
    const configured = options.mode === 'configured' || options.mode === 'matrix';
    const requestedFrequency = Number(options.frequency || 0);
    const overridesComplete = data.coverage?.frequencies?.state === 'complete' && data.coverage?.frequencies?.generation === data.daemon?.generation;
    const overridesSupported = data.daemon?.capabilities?.includes('frequency_qualified_snr');
    const effectiveRows = requestedFrequency ? (data.pairs || []).map(row => {
      const override = frequencyOverrides.get(keyOf({ ...row, frequency_mhz: requestedFrequency }));
      return { ...row, ...override, frequency_mhz: requestedFrequency, effectivePair: true, override: Boolean(override?.override) };
    }) : [];
    const pathRows = configured ? requestedFrequency ? effectiveRows : [...(data.pairs || []).map(row => ({ ...row, frequency_mhz: 0 })), ...(data.frequencies || [])] : data.paths || [];
    const paths = pathRows.map(row => {
      const key = keyOf(row), source = names.get(row.source), destination = names.get(row.destination);
      const frequency = Number(row.frequency_mhz || 0);
      const selected = data.selected?.[key];
      const readback = selected?.generation === data.daemon?.generation && !selected.error && now - Date.parse(selected.observed_at) < 5000 ? selected : null;
      const override = frequencyOverrides.get(key);
      const rfComplete = data.coverage?.frequencies?.state === 'complete' && data.coverage?.frequencies?.generation === data.daemon?.generation;
      const coverage = data.coverage?.[row.override ? 'frequencies' : 'pairs'];
      const configuredValid = coverage?.state === 'complete' && coverage.generation === data.daemon?.generation && (!row.effectivePair || !overridesSupported || overridesComplete);
      const mediumFresh = now - Date.parse(data.last_success || '') < 5000;
      const configuredSNR = configured ? configuredValid ? Number(row.snr_db) : null : readback ? Number(readback.snr_db) : rfComplete && override ? Number(override.snr_db) : null;
      return { ...row, key, kind: 'path', depth: 2, label: `${source?.label || row.source} → ${destination?.label || row.destination}`,
        source_name: source?.label || row.source, destination_name: destination?.label || row.destination,
        presence: source?.presence || 'unknown', role: source?.role, frequency_mhz: frequency,
        band: row.band || bandOf(frequency), snr: mediumFresh ? configured ? configuredSNR : configuredSNR ?? (age(row.last_seen_usec) <= 5 ? number(row.last_snr_db) : null) : null, configuredSNR,
        snrProvenance: configured ? (row.override ? 'exact-frequency override' : row.effectivePair ? 'current pair fallback' : 'current pair') : readback ? (readback.override ? 'exact-frequency readback' : 'pair fallback readback') : 'last packet (not RF readback)',
        rate: configured ? null : this.rates.get(key) ?? null,
        drops: configured ? null : drops(row).toString(), age: configured ? null : age(row.last_seen_usec),
        type: frameType(row.last_type, row.last_subtype), multicast: Boolean(row.multicast), configured };
    });
    const search = String(options.search || '').toLowerCase().trim();
    const matches = row => {
      if (options.band && row.band !== options.band && row.kind !== 'radio') return false;
      if (options.frequency && Number(row.frequency_mhz) !== Number(options.frequency) && row.kind !== 'radio') return false;
      if (options.presence && row.presence !== options.presence) return false;
      if (options.role === 'mesh' ? !['controller-agent', 'extender'].includes(row.role) : options.role && row.role !== options.role) return false;
      if (options.traffic === 'drops' && counter(row.drops) === 0n) return false;
      if (options.traffic === 'recent' && (row.age == null || row.age > 5)) return false;
      if (options.traffic === 'fanout' && !row.multicast) return false;
      if (options.type && row.kind === 'path' && String(row.last_type) !== options.type) return false;
      if (options.minSNR !== '' && options.minSNR != null && (row.snr == null || row.snr < Number(options.minSNR))) return false;
      return !search || [row.label, row.owner, row.source, row.destination, row.mac, row.band, row.frequency_mhz].join(' ').toLowerCase().includes(search);
    };
    const filtered = paths.filter(matches);
    const sort = options.sort || 'label', direction = options.direction === 'desc' ? -1 : 1;
    const sorter = (left, right) => left[sort] == null || right[sort] == null ? (left[sort] == null ? right[sort] == null ? compare(left.key, right.key) : 1 : -1) : direction * compare(left[sort], right[sort]) || compare(left.key, right.key);
    filtered.sort(sorter);
    const children = new Map();
    for (const path of filtered) { if (!children.has(path.source)) children.set(path.source, []); children.get(path.source).push(path); }
    const visibleRadios = radios.filter(radio => children.has(radio.mac) || (!options.band && !options.frequency && !options.traffic && !options.type && (options.minSNR === '' || options.minSNR == null) && matches(radio))).sort(sorter);
    const expanded = new Set(options.expanded || []), rows = [];
    for (const radio of visibleRadios) {
      const descendants = children.get(radio.mac) || [];
      rows.push({ ...radio, count: descendants.length, expanded: expanded.has(radio.mac) });
      if (!expanded.has(radio.mac)) continue;
      const frequencies = new Map();
      for (const path of descendants) { if (!frequencies.has(path.frequency_mhz)) frequencies.set(path.frequency_mhz, []); frequencies.get(path.frequency_mhz).push(path); }
      for (const [frequency, group] of [...frequencies].sort((left, right) => left[0] - right[0])) {
        const key = `${radio.mac}@${frequency}`;
        rows.push({ kind: 'frequency', key, source: radio.mac, depth: 1, frequency_mhz: frequency, label: frequency ? `${bandOf(frequency)} · ${frequency} MHz` : 'Current pair (all-frequency fallback)', count: group.length, expanded: expanded.has(key) });
        if (expanded.has(key)) rows.push(...group);
      }
    }
    const totalClients = radios.filter(radio => radio.role === 'wlan-client' || radio.role === 'iot-client');
    return { rows, radios: visibleRadios, allRadios: radios, paths: filtered, totalPaths: paths.length, roomValid,
      pool: { bound: totalClients.length, present: totalClients.filter(radio => radio.presence === 'present').length, excluded: totalClients.filter(radio => radio.presence === 'room-excluded').length, unknown: totalClients.filter(radio => radio.presence === 'unknown').length },
      coverage: data.coverage?.[configured ? 'pairs' : 'paths'], frequencies: [...new Set([
        ...(data.radio_frequencies || []).map(row => Number(row.frequency_mhz)),
        ...(data.frequencies || []).map(row => Number(row.frequency_mhz)),
        ...(roomValid ? data.room.data.roles || [] : []).flatMap(role => Object.values(role.frequencies || {}).map(Number)),
      ].filter(value => value >= 2300 && value <= 7125))].sort((left, right) => left - right) };
  }
}
export function nativeLoadValue(record, inspection, roomValid, now = Date.now()) {
  const age = (now - Date.parse(record?.observed_at || '')) / 1000;
  const limit = Math.min(5, Number(inspection?.maximum_age_seconds) || 5);
  const integer = (value, maximum) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= maximum ? number : null;
  };
  const valid = Boolean(roomValid && inspection?.enabled === true && !inspection.error &&
    record?.source === 'native_ap_metrics' &&
    ['ieee1905-ethernet', 'prpl-1905-broker', 'prpl-local-broker'].includes(record.transport) &&
    Number.isFinite(age) && age >= 0 && age <= limit);
  return {valid, utilization: valid ? integer(record.utilization, 255) : null,
    station_count: valid ? integer(record.station_count, 65535) : null};
}
