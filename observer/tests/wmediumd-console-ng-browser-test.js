#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../web');
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = path.resolve(root, pathname === '/' ? 'ng/index.html' : `.${pathname}`);
  if (!filename.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
  fs.readFile(filename, (error, bytes) => {
    if (error) { response.writeHead(404).end(); return; }
    const type = filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript';
    response.writeHead(200, { 'Content-Type': type }); response.end(bytes);
  });
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const failures = []; page.on('pageerror', error => failures.push(error.message));
    await page.addInitScript(() => {
      const mac = index => `02:00:00:00:${Math.floor(index / 256).toString(16).padStart(2, '0')}:${(index % 256).toString(16).padStart(2, '0')}`;
      const radios = Array.from({ length: 105 }, (_, index) => ({ mac: mac(index + 1), label: index < 5 ? index === 0 ? 'Agent-1' : `Extender-${index}` : `sta-${(index - 4).toString(16).padStart(2, '0')}`, role: index === 0 ? 'controller-agent' : index < 5 ? 'extender' : 'wlan-client', owner: `container-${index}` }));
      let sequence = 0;
      window.__ngSubscriptions = [];
      window.WebSocket = class {
        static OPEN = 1;
        constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 20); }
        send(payload) {
          const interest = JSON.parse(payload); window.__ngSubscriptions.push(interest);
          if (!interest.topics.length) return;
          sequence++;
          const now = new Date().toISOString();
          const paths = radios.slice(5).map(radio => ({ source: radio.mac, destination: radios[0].mac, frequency_mhz: '5180', frames: '9007199254740993', bytes: '1000000', attempts: '30', retries: '2', acked: '28', no_ack: '2', rx_injected: '28', first_seen_usec: '1', last_seen_usec: '999999', last_update_sequence: String(sequence), last_snr_db: '32', last_type: '2', last_subtype: '8' }));
          const selected = {};
          if (interest.source && interest.destination) for (const direction of [[interest.source, interest.destination], [interest.destination, interest.source]]) for (const frequency of [0, interest.frequency_mhz]) selected[`${direction[0]}>${direction[1]}@${frequency}`] = { source: direction[0], destination: direction[1], frequency_mhz: String(frequency), snr_db: '32', override: frequency !== 0, generation: '4', observed_at: now };
          const data = { sequence: String(sequence), captured_at: now, last_success: now, daemon: { instance_id: 'fixture', generation: '4', capabilities: ['telemetry', 'frequency_qualified_snr'] }, radios, paths, selected, summary: { summary: { uptime_usec: '1000000', queue_depth: '0' }, rates: { frames_per_second: 30 } }, coverage: { paths: { state: 'complete', rows: '100', total: '100', observed_at: now } },
            radio_frequencies: radios.map(radio => ({ radio: radio.mac, frequency_mhz: '5180' })), room: { available: true, observed_at: now, data: { world: 'Console NG browser fixture', live: true, instance_id: 'fixture', roles: radios.map((radio, index) => ({ radio: radio.mac, present: index < 25, container: radio.owner, position: [index % 12, Math.floor(index / 12)] })), layout: { walls: [] } } } };
          this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', sequence: String(sequence), baseline: '0', data }) });
        }
        close() { this.readyState = 3; }
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.getElementById('pool').textContent.includes('20 present / 100 bound'));
    assert.match(await page.locator('#pool').innerText(), /80 room-excluded/);
    await page.locator('[data-preset="excluded"]').click();
    await page.waitForFunction(() => document.getElementById('table-count').textContent.includes('80 radios'));
    assert.ok(await page.locator('.table-row').count() < 40, 'table must remain virtualized');
    await page.locator('[data-preset="clear"]').click();
    await page.locator('#search').fill('sta-01');
    await page.waitForFunction(() => document.getElementById('table-count').textContent.includes('1 radios'));
    await page.locator('#expand').click();
    await page.waitForSelector('.row-path');
    await page.locator('.row-path').first().click();
    await page.waitForFunction(() => document.getElementById('properties').textContent.includes('exact-frequency override'));
    await page.locator('[data-tab="traffic"]').click();
    await page.waitForFunction(() => document.getElementById('properties').textContent.includes('9007199254740993'));
    assert.match(await page.locator('#properties').innerText(), /legacy path telemetry/);
    await page.locator('#freeze').click();
    assert.ok(await page.evaluate(() => window.__ngSubscriptions.at(-1).topics.length === 0), 'freeze must release collection');
    await page.locator('#freeze').click();
    await page.locator('#mode').selectOption('matrix');
    await page.waitForFunction(() => document.querySelector('.scene-notice').textContent.includes('Directed SNR'));
    await page.locator('#divider').focus(); await page.keyboard.press('ArrowRight');
    assert.ok(Number(await page.locator('#divider').getAttribute('aria-valuenow')) >= 190);
    const manual = await page.request.get(`http://127.0.0.1:${server.address().port}/ng/manual.html`);
    assert.equal(manual.status(), 200); assert.match(await manual.text(), /Beacon BSS Load/);
    const properties = await page.request.get(`http://127.0.0.1:${server.address().port}/ng/rf-properties.html`);
    assert.equal(properties.status(), 200); assert.match(await properties.text(), /Noise reference and CCA/);
    assert.equal(await page.locator('header a[href="/ng/rf-properties.html"]').count(), 1);
    assert.deepEqual(failures, []);
    console.log('PASS Console NG: pool identity, filters, virtualization, selection, exact counters, capability fallback, freeze, matrix, divider, embedded manual (mock transport).');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
