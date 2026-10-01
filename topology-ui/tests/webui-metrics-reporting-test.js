#!/usr/bin/env node

'use strict';

const assert = require('assert').strict;
const path = require('path');

if (process.argv.length !== 3) {
  console.error(`Usage: ${path.basename(process.argv[1])} SCRIPT_JS`);
  process.exit(2);
}

const button = { disabled: false, innerHTML: '' };
global.document = {
  addEventListener() {},
  getElementById(id) { return id === 'enable-all-metrics' ? button : null; }
};
global.window = { addEventListener() {} };

const Controller = require(path.resolve(process.argv[2]));

(async () => {
  const controller = new Controller();
  const calls = [];
  const notifications = [];
  let policyReloaded = false;

  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url === '/api/v1/metricsreporting/enable') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, devices: 5, radios: 15 })
      };
    }
    if (url === '/api/v1/clients') {
      return {
        ok: true,
        json: async () => ({
          clients: Array.from({ length: 10 }, (_, index) => ({
            mac: `02:00:00:00:${String(index).padStart(2, '0')}:00`,
            client_metrics: { rcpi: 120 + index }
          }))
        })
      };
    }
    throw new Error(`unexpected request: ${url}`);
  };

  controller.showNotification = (message, level) => notifications.push({ message, level });
  controller.loadWifiPolicyConfig = async () => { policyReloaded = true; };

  await controller.enableAllMetricsReporting();

  assert.deepEqual(calls, [
    { url: '/api/v1/metricsreporting/enable', method: 'POST' },
    { url: '/api/v1/clients', method: 'GET' }
  ]);
  assert.equal(policyReloaded, true, 'policy UI was not refreshed after activation');
  assert.equal(button.disabled, false, 'metrics button remained disabled');
  assert.match(button.innerHTML, /Enable All Metrics/);
  assert.ok(notifications.some(({ message, level }) =>
    level === 'success' && /5 devices \/ 15 radios, 10\/10 clients/.test(message)),
  'the UI did not report end-to-end metrics success');

  console.log('PASS: one-click metrics activation verifies all devices, radios and clients');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
