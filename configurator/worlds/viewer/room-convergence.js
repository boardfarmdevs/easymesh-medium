(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoomConvergence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const count = value => number(value) ?? '—';
  const fresh = (timestamp, now, maximumAge) => {
    const age = now - Date.parse(timestamp || '');
    return Number.isFinite(age) && age >= 0 && age <= maximumAge;
  };

  function healthDetail(health = {}) {
    const issues = [];
    const clients = number(health.api_active), expected = number(health.expected_online_clients);
    if (clients !== null && expected !== null && clients !== expected) {
      const difference = clients - expected;
      issues.push(clients + '/' + expected + ' clients associated (' +
        Math.abs(difference) + (difference > 0 ? ' extra).' : ' missing).'));
    }
    for (const [field, expectedField, label] of [
      ['complete_nodes', 'expected_topology_nodes', 'Complete mesh nodes'],
      ['model_devices', 'expected_model_devices', 'Model devices'],
      ['model_radios', 'expected_model_radios', 'Model radios'],
      ['model_bsses', 'expected_model_bsses', 'Model BSSes'],
      ['model_associated', 'expected_model_associated', 'Model associations'],
    ]) {
      if (number(health[field]) !== null && number(health[expectedField]) !== null &&
          health[field] !== health[expectedField]) {
        issues.push(label + ': ' + health[field] + '/' + health[expectedField] + '.');
      }
    }
    return issues.join(' ') || 'The latest health check is degraded; inspect Whole lab.';
  }

  function budgetDetail(status = {}) {
    return status.automatic_actuation && number(status.maximum_actions) !== null &&
      number(status.actions_used) !== null && status.actions_used >= status.maximum_actions
      ? 'Steering limit reached: ' + status.actions_used + '/' + status.maximum_actions +
        ' requests used. Measurements continue.' : '';
  }

  function protectionDetail(status = {}) {
    const safety = status.steering_safety || {}, paused = safety.paused_clients || [];
    if (paused.length) return paused.length + ' client' + (paused.length === 1 ? '' : 's') +
      ' paused after failures or oscillation. Others continue. Use Resume steering.';
    if (safety.rate_retry_seconds > 0) return safety.requests_in_window + '/' +
      safety.request_limit + ' requests in ' + safety.window_seconds + ' s. Retries are automatic.';
    return '';
  }

  function withSafety(previous, next) {
    const before = previous && previous.steering_safety, after = next && next.steering_safety;
    return before && (!after || before.revision > after.revision)
      ? {...next, steering_safety: before} : next;
  }

  function describe(input) {
    const status = input.optimizer || {}, fleet = status.fleet || {};
    const health = input.health || {}, network = input.network || {};
    const expected = number(status.expected_online_clients) ?? number(health.expected_online_clients);
    const expectedNodes = number(health.expected_topology_nodes);
    const expectedDevices = number(health.expected_mesh_devices) ?? (expectedNodes === null ? null : expectedNodes - 1);
    const summary = count(fleet.clients_checked) + '/' + count(expected) + ' checked · ' +
      count(network.health?.clients ?? health.api_active) + '/' + count(expected) + ' online · ' +
      count(health.topology_nodes) + '/' + count(expectedNodes) + ' mesh';
    const result = (state, title, detail) => ({state, title, summary, detail});
    if (input.mode === 'preview') return result('unknown', 'PREVIEW ONLY', 'No live lab measurements; simulated links do not prove convergence.');
    if (input.mode === 'replay') return result('unknown', 'RECORDED REPLAY', 'Inspect the recorded optimizer result; this is not current lab readiness.');
    if (input.connection === 'disconnected') return result('unknown', 'NO LIVE DATA', 'The connection is lost. Convergence cannot be confirmed.');
    if (input.connection === 'failed' || input.fault) return result('blocked', 'LAB ERROR', 'Inspect the lab and optimizer details before continuing.');
    if (input.loading) return result('working', 'APPLYING ROOM', 'Waiting for the new room, associations and fresh measurements.');
    if (!['running', 'ready'].includes(input.connection)) return result('unknown', 'CHECKING', 'Waiting for a live, running lab.');
    if (input.nativeObservation) return result('unknown', 'NOT EVALUATED', 'Native observation has no external convergence evaluation.');
    const meshMissing = expectedNodes !== null && (
      number(health.topology_nodes) !== null && health.topology_nodes !== expectedNodes ||
      number(network.health?.mesh_devices) !== null && network.health.mesh_devices !== expectedDevices);
    if (meshMissing) return result('blocked', 'MESH INCOMPLETE', 'An extender may have lost backhaul. Client convergence is not confirmed.');
    if (health.healthy === false) return result('blocked', 'LAB NOT READY',
      healthDetail(health) + (budgetDetail(status)
        ? ' Steering limit: ' + status.actions_used + '/' + status.maximum_actions + ' requests used.' : ''));
    if ((status.steering_safety?.paused_clients || []).length) {
      return result('blocked', 'CLIENTS PAUSED', protectionDetail(status));
    }
    if (input.moving) return result('working', 'MOVING', 'Pause at a checkpoint and wait for CONVERGED before comparing results.');
    if (status.progress && status.progress.kind !== 'optimizer.progress' ||
        number(input.environmentEpoch) !== null && status.environment_epoch !== input.environmentEpoch) {
      return result('working', 'SETTLING', 'Room RF changed. Waiting for a fresh evaluation of this layout.');
    }
    if (status.status === 'unavailable') return result('unknown', 'METRICS UNAVAILABLE', 'Steering waits for fresh measurements; inspect External optimizer.');
    if (!fresh(status.evaluated_at, input.now, 60000) || !fresh(network.observed_at, input.now, 20000) ||
        !fresh(health.observed_at, input.now, 60000)) {
      return result('unknown', 'WAITING FOR DATA', 'Fresh optimizer, topology and health readings are required.');
    }
    const rosterReady = expected !== null && expectedNodes !== null && health.healthy === true &&
      health.expected_online_clients === expected && health.api_active === expected &&
      health.topology_nodes === expectedNodes && health.complete_nodes === expectedNodes &&
      network.health?.mesh_devices === expectedDevices && network.health?.clients === expected;
    const bandReady = fleet.policy === 'received-scan-band-preference-v1'
      ? fleet.band_measurements_complete === true : fleet.band_measurements_complete !== false;
    const pending = status.action_batch_size > 0 || (status.client_decisions || []).some(
      row => row.reason === 'steer_pending' || row.reason === 'target_association_observed');
    if (!pending && rosterReady && fleet.converged === true && fleet.clients_checked === expected &&
        fleet.roster_complete === true && fleet.measurement_complete === true && bandReady) {
      return result('ready', 'CONVERGED', !input.canPlay ? 'Client/AP policy satisfied. Monitoring continues.' : input.checkpoint
        ? 'Client/AP policy satisfied. Ready to continue Play.' : 'Client/AP policy satisfied. Ready to Play.');
    }
    if (status.steering_safety?.rate_retry_seconds > 0) {
      return result('working', 'RATE LIMITED', protectionDetail(status));
    }
    if (budgetDetail(status)) {
      return result('blocked', 'STEERING PAUSED', budgetDetail(status));
    }
    return result('working', 'CONVERGING', number(fleet.clients_outside_policy_margin) > 0
      ? fleet.clients_outside_policy_margin + ' clients still need a policy-compliant connection.'
      : 'Waiting for all clients and their fresh AP comparisons.');
  }

  const rendered = new WeakMap();
  function render(element, status) {
    if (!element) return;
    const signature = JSON.stringify(status);
    if (rendered.get(element) === signature) return;
    rendered.set(element, signature);
    element.dataset.state = status.state;
    element.querySelector('[data-room-state]').textContent =
      ({ready: '✓ ', working: '… ', blocked: '! ', unknown: '— '})[status.state] + status.title;
    element.querySelector('[data-room-counts]').textContent = status.summary;
    const detail = element.querySelector('[data-room-detail]');
    if (detail) detail.textContent = status.detail;
    element.title = status.detail + ' Green confirms the configured client/AP policy and reported mesh roster, not optimal backhaul parents or end-to-end traffic on every link.';
  }

  return {describe, render, healthDetail, budgetDetail, protectionDetail, withSafety};
});
