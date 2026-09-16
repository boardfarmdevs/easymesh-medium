(function (root) {
  'use strict';
  function describe(input) {
    const optimizer = input.optimizer || {}, observations = optimizer.rf_observations || {};
    const decision = (optimizer.client_decisions || []).find(row => row.role === input.selected);
    const client = (input.network?.clients || []).find(row => row.role === input.selected);
    const now = input.now;
    const age = timestamp => {
      const value = (now - Date.parse(timestamp || '')) / 1000;
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
    const measured = (value, timestamp, maximumAge = 5, format = String) => {
      const seconds = age(timestamp);
      return Number.isFinite(value) && seconds !== null && seconds <= maximumAge
        ? format(value) + ' · received ' + seconds.toFixed(1) + ' s ago' : '— unavailable/stale';
    };
    const channel = frequency => {
      if (frequency === 2484) return 14;
      if (frequency === 5935) return 2;
      if (!Number.isInteger(frequency)) return 'unknown';
      if (frequency >= 2412 && frequency <= 2472 && (frequency - 2407) % 5 === 0) return (frequency - 2407) / 5;
      if (frequency > 5000 && frequency < 5925 && frequency % 5 === 0) return (frequency - 5000) / 5;
      if (frequency >= 5955 && frequency <= 7115 && (frequency - 5950) % 5 === 0) return (frequency - 5950) / 5;
      return 'unknown';
    };
    const lines = ['Selected: ' + (input.selected || 'none')];
    if (input.view === 'traffic') {
      const traffic = input.traffic || {};
      const udp = traffic.mode === 'udp' || input.world?.traffic_experiment?.phases?.some(phase => phase.mode === 'udp');
      lines.push('BOUNDED ' + (udp ? 'UDP' : 'ICMP') + ' TRAFFIC — actual packets via client wlan0',
        'State: ' + (traffic.state || (input.world?.traffic_experiment ? 'waiting for Play' : 'not scheduled')),
        'Source role: ' + (traffic.role || 'none'),
        'Requested rate: ' + (udp ? (traffic.requested_offered_mbps ?? 'none') + ' offered Mbps'
          : (traffic.requested_packets_per_second ?? 'none') + ' packets/s'),
        'Payload: ' + (traffic.payload_bytes ?? 'none') + ' bytes',
        'Requested load is not measured demand, airtime, throughput or capacity.');
      if (traffic.error) lines.push('Error: ' + traffic.error);
      for (const result of traffic.history || []) {
        if (result.world_sha256 && result.world_sha256 !== input.world?.golden_sha256) continue;
        lines.push('Run ' + (result.key?.[1] ?? '?') + ' · phase ' +
          (Number.isInteger(result.key?.[2]) ? result.key[2] + 1 : '?') + ' · ' + result.state);
        if (result.mode === 'udp') {
          const mbps = value => Number.isFinite(value) ? (value / 1000000).toFixed(3) + ' Mbps' : 'unknown';
          lines.push('Requested: ' + (result.requested_offered_mbps ?? 'unknown') + ' offered Mbps',
            'Sender actual: ' + mbps(result.sender?.bits_per_second) + ' · ' + (result.sender?.status || 'missing'),
            'Receiver goodput: ' + mbps(result.receiver?.goodput_bits_per_second) + ' · ' + (result.receiver?.status || 'missing'),
            'Receiver loss: ' + (result.receiver?.lost_packets ?? 'unknown') + ' / ' +
              (result.receiver?.packets ?? 'unknown') + ' expected datagrams · ' + (result.receiver?.loss_percent ?? 'unknown') + '%',
            'Measured windows: sender ' + (result.sender?.seconds ?? 'unknown') + ' s / receiver ' +
              (result.receiver?.seconds ?? 'unknown') + ' s');
          for (const endpoint of ['sender', 'receiver']) {
            if (result[endpoint]?.error) lines.push(endpoint + ': ' + result[endpoint].error);
          }
        } else lines.push('Generated: ' + (result.transmitted_packets ?? 'unknown') + ' packets',
          'Delivered echo replies: ' + (result.received_echo_replies ?? 'unknown'));
        lines.push('Elapsed: ' + (result.elapsed_seconds ?? 'unknown') + ' s');
        if (result.error) lines.push('Error: ' + result.error);
      }
      lines.push(udp ? 'UDP records come from each owned iperf3 endpoint; missing records remain unknown.'
        : 'Counters come from ping summaries at phase end. Replies are not application goodput.',
        'Pause, lease loss, world change, source offline and shutdown cancel traffic. Play resumes only the remaining phase.',
        'Native AP load is a separate observation; a high requested rate does not guarantee overload.');
    } else if (input.view === 'configured') {
      lines.push('SCENARIO / MODEL — not native measurements',
        'World: ' + (input.world?.name || 'unknown'),
        'Backhaul RF: ' + (input.world?.backhaul_rf || 'fixed'),
        'Traffic schedule: ' + (input.world?.traffic_experiment ? 'bounded ' +
          (input.world.traffic_experiment.phases?.some(phase => phase.mode === 'udp') ? 'UDP' : 'ICMP') +
          '; requested load is not delivered load' : 'none'),
        'Radio profile: ' + (input.capabilities?.profile || 'unknown'),
        'Run qualification: ' + (input.capabilities?.support?.current_run_qualification || 'not established'),
        'Scan profile: ' + JSON.stringify(input.world?.band_steering?.[input.selected] || 'native same-band candidate path'),
        'Geometry overlays are predictions, not proof of reception.');
    } else if (input.view === 'decision') {
      lines.push('OPTIMIZER — external policy, not native autonomous optimization');
      if (!decision) return lines.concat('No client decision for this selection.').join('\n');
      lines.push('Reason: ' + decision.reason,
        'Decision age: ' + (age(optimizer.evaluated_at)?.toFixed(1) ?? 'unknown') + ' s',
        'Action: ' + decision.action, 'Target: ' + (decision.target_bssid || 'none'),
        'Wait: ' + (decision.wait_remaining_seconds || 0) + ' s at evaluation');
      const evidence = decision.load_evidence;
      if (evidence) {
        lines.push('Load source: native AP metrics · raw 0–255',
          'Current load at decision: ' + (evidence.current_utilization ?? 'unavailable'),
          'Client activity: ' + (evidence.client_packets_per_second ?? 'unavailable') + ' packets/s (not demand)',
          'Report age budget: ' + evidence.maximum_report_age_seconds + ' s');
        for (const target of evidence.candidate_assessments || []) {
          lines.push(target.bssid + ': ' + target.state + ' · ' + (target.reasons.join(', ') || 'passed load gates'));
        }
      } else lines.push('No load-policy evidence; signal/capability policy may be active.');
    } else {
      lines.push('NATIVE OBSERVATIONS — never filled from geometry or modeled busy time');
      if (decision) lines.push(
        'Serving RCPI: ' + measured(decision.current_rcpi, decision.metric_observed_at,
          decision.measurement_source === 'client_nl80211_received_scan' ? 2 : 5),
        'Signal source: ' + (decision.measurement_source || 'unknown'),
        'Direction: ' + (decision.measurement_source === 'client_nl80211_received_scan'
          ? 'AP → client (received scan)' : 'provider-defined; not assumed reciprocal'));
      const records = (observations.bss_loads || []).filter(row => row.role === input.selected || row.bssid === client?.connected_bssid);
      lines.push('LOCAL AP METRICS — reported by the AP');
      if (!records.length) lines.push(observations.enabled
        ? 'Native AP load: — no matching fresh report' : 'Native AP load collector unavailable; inspect room service status.');
      if (observations.error) lines.push('AP load collection: ' + observations.error);
      for (const row of records) {
        lines.push('Radio ' + row.radio_id + ' · channel ' + row.channel,
          'BSSID ' + row.bssid,
          'Utilization (0–255): ' + measured(row.utilization, row.observed_at, observations.maximum_age_seconds),
          'Associated stations: ' + measured(row.station_count, row.observed_at, observations.maximum_age_seconds),
          'Source: ' + row.source + ' / ' + row.transport,
          'Provider epoch: ' + row.epoch,
          'Sample window: unknown; timestamp describes native report receipt');
      }
      lines.push('RECEIVED BSS LOAD — client-heard advertisements, not AP scans or local AP counters');
      const station = decision?.sta_mac || client?.sta_mac;
      const received = [];
      for (const [receiver, scan] of Object.entries(optimizer.band_steering || {})) {
        const ownScan = station === receiver;
        const neighbors = scan.neighbors || [];
        const servesReceiver = !station && neighbors.some(row => row.bssid === scan.serving_bssid && row.role === input.selected);
        for (const neighbor of neighbors) {
          if (ownScan || (!station && (servesReceiver || neighbor.role === input.selected))) received.push({receiver, scan, neighbor});
        }
        if (ownScan) {
          for (const [bssid, reason] of Object.entries(scan.rejected || {})) lines.push(bssid + ': ' + reason);
          if (scan.error) lines.push('Scan error: ' + scan.error);
        }
      }
      received.sort((left, right) => (age(left.neighbor.observed_at) ?? Infinity) - (age(right.neighbor.observed_at) ?? Infinity));
      if (!received.length) lines.push('No matching received scan; advertised load is unavailable. No scan is started by this inspector.');
      for (const {receiver, scan, neighbor} of received.slice(0, 24)) {
        const seconds = age(neighbor.observed_at);
        const fresh = scan.available === true && scan.source === 'client_nl80211_received_scan'
          && seconds !== null && seconds <= 2;
        const load = neighbor.advertised_bss_load || {};
        const valid = load.state === 'available' && Number.isInteger(load.utilization)
          && load.utilization >= 0 && load.utilization <= 255
          && ['station_count', 'admission_capacity'].every(key => Number.isInteger(load[key]) && load[key] >= 0 && load[key] <= 65535);
        lines.push('BSSID ' + neighbor.bssid + (neighbor.role ? ' (' + neighbor.role + ')' : '') +
          ' · channel ' + channel(neighbor.frequency_mhz) + ' · ' + (neighbor.frequency_mhz ?? 'unknown') + ' MHz',
          'Source: ' + (scan.source || 'unknown') + ' · receiver ' + (scan.receiver_role || receiver) + ' [' + receiver + ']',
          'Scan: ' + (scan.scan_id || 'unknown') + ' · received ' + (seconds?.toFixed(1) ?? 'unknown') + ' s ago' +
            (fresh ? '' : ' · unavailable/stale'),
          'Received RCPI: ' + measured(fresh ? neighbor.rcpi : null, neighbor.observed_at, 2),
          fresh && valid ? 'Advertised BSS Load: ' + load.utilization + '/255 · ' + load.station_count +
            ' stations · admission ' + load.admission_capacity + ' ×32 µs' : 'Advertised BSS Load: unavailable/stale');
      }
      if (received.length > 24) lines.push('Showing the 24 most recent matching advertisements of ' + received.length + '.');
      const activity = (observations.client_activity || []).find(row => row.sta_mac === station);
      if (activity) lines.push('Packet activity: ' + measured(activity.packets_per_second, activity.observed_at,
        observations.maximum_age_seconds) + ' packets/s; delta window ' + activity.interval_seconds + ' s',
        'Byte activity: ' + measured(activity.bytes_per_second, activity.observed_at, observations.maximum_age_seconds,
          value => (value * 8 / 1000000).toFixed(3) + ' Mbit/s'),
        'AP TX retries/s: ' + measured(activity.retries_per_second, activity.observed_at, observations.maximum_age_seconds,
          value => value.toFixed(3)),
        'AP TX failures/s: ' + measured(activity.tx_errors_per_second, activity.observed_at, observations.maximum_age_seconds,
          value => value.toFixed(3)),
        'AP RX drops/s: ' + measured(activity.rx_errors_per_second, activity.observed_at, observations.maximum_age_seconds,
          value => value.toFixed(3)),
        'Retries may follow lost ACKs despite delivery. RX drops are not a measurement of undecodable RF frames.');
      lines.push('Shared-radio BSS reports are not independent airtime budgets.',
        'Frequency-wide activity is displayed separately; noise and physical capacity remain unqualified.');
    }
    return lines.join('\n');
  }
  function render(element, input) {
    if (!element) return;
    const output = describe(input);
    if (element.textContent !== output) element.textContent = output;
  }
  const api = {describe, render};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoomRFInspector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
