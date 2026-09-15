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
    const measured = (value, timestamp, maximumAge = 5) => {
      const seconds = age(timestamp);
      return value != null && seconds !== null && seconds <= maximumAge
        ? value + ' · received ' + seconds.toFixed(1) + ' s ago' : '— unavailable/stale';
    };
    const lines = ['Selected: ' + (input.selected || 'none')];
    if (input.view === 'traffic') {
      const traffic = input.traffic || {};
      lines.push('BOUNDED ICMP TRAFFIC — actual packets via client wlan0',
        'State: ' + (traffic.state || (input.world?.traffic_experiment ? 'waiting for Play' : 'not scheduled')),
        'Source role: ' + (traffic.role || 'none'),
        'Requested rate: ' + (traffic.requested_packets_per_second ?? 'none') + ' packets/s',
        'Payload: ' + (traffic.payload_bytes ?? 'none') + ' bytes',
        'Requested load is not measured demand, airtime, throughput or capacity.');
      if (traffic.error) lines.push('Error: ' + traffic.error);
      for (const result of traffic.history || []) {
        if (result.world_sha256 && result.world_sha256 !== input.world?.golden_sha256) continue;
        lines.push('Run ' + (result.key?.[1] ?? '?') + ' · phase ' +
          (Number.isInteger(result.key?.[2]) ? result.key[2] + 1 : '?') + ' · ' + result.state,
          'Generated: ' + (result.transmitted_packets ?? 'unknown') + ' packets',
          'Delivered echo replies: ' + (result.received_echo_replies ?? 'unknown'),
          'Elapsed: ' + (result.elapsed_seconds ?? 'unknown') + ' s');
        if (result.error) lines.push('Error: ' + result.error);
      }
      lines.push('Counters come from ping summaries at phase end. Replies are not application goodput.',
        'Pause, lease loss, world change, source offline and shutdown cancel traffic. Play resumes only the remaining phase.',
        'Native AP load is a separate observation; a high requested rate does not guarantee overload.');
    } else if (input.view === 'configured') {
      lines.push('SCENARIO / MODEL — not native measurements',
        'World: ' + (input.world?.name || 'unknown'),
        'Backhaul RF: ' + (input.world?.backhaul_rf || 'fixed'),
        'Traffic schedule: ' + (input.world?.traffic_experiment ? 'bounded ICMP; requested load is not delivered load' : 'none'),
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
      const scan = optimizer.band_steering?.[decision?.sta_mac];
      if (scan) {
        lines.push('Received scan: ' + (scan.available ? 'available' : 'unavailable') +
          ' · ' + (scan.scan_id || 'no scan ID') + ' · age ' + (age(scan.observed_at)?.toFixed(1) ?? 'unknown') + ' s');
        for (const [bssid, reason] of Object.entries(scan.rejected || {})) lines.push(bssid + ': ' + reason);
        if (scan.error) lines.push('Scan error: ' + scan.error);
      }
      const records = (observations.bss_loads || []).filter(row => row.role === input.selected || row.bssid === client?.connected_bssid);
      if (!records.length) lines.push(observations.enabled
        ? 'Native AP load: — no matching fresh report' : 'Native AP load collector inactive; enable an explicit load-policy session.');
      for (const row of records) {
        lines.push('Radio ' + row.radio_id + ' · channel ' + row.channel,
          'BSSID ' + row.bssid,
          'Utilization (0–255): ' + measured(row.utilization, row.observed_at, observations.maximum_age_seconds),
          'Associated stations: ' + measured(row.station_count, row.observed_at, observations.maximum_age_seconds),
          'Source: ' + row.source + ' / ' + row.transport,
          'Provider epoch: ' + row.epoch,
          'Sample window: unknown; timestamp describes native report receipt');
      }
      const activity = (observations.client_activity || []).find(row => row.sta_mac === decision?.sta_mac);
      if (activity) lines.push('Packet activity: ' + measured(activity.packets_per_second, activity.observed_at,
        observations.maximum_age_seconds) + ' packets/s; delta window ' + activity.interval_seconds + ' s');
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
