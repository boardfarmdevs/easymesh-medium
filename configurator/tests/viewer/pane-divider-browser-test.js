'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(__dirname, '../../worlds/viewer');
const html = '<!doctype html><html><head><style>' + fs.readFileSync(path.join(root, 'pane-divider.css'), 'utf8') +
  'body{margin:0;height:100vh;display:grid;grid-template-columns:var(--panel,280px) 8px minmax(0,1fr)}' +
  '@media(max-width:760px){body{grid-template-columns:1fr}#divider{display:none}}</style></head><body>' +
  '<aside id="left"></aside><div id="divider" class="pane-divider" role="separator" tabindex="0"></div><main id="right"></main><script>' +
  fs.readFileSync(path.join(root, 'pane-divider.js'), 'utf8') +
  ';window.divider=PaneDivider.attach({container:document.body,handle:document.getElementById("divider"),' +
  'property:"--panel",storageKey:"test-panel",initial:280,minimum:140});</script></body></html>';
async function run() {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox']});
  try {
    const context = await browser.newContext({viewport: {width: 1200, height: 900}, hasTouch: true});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({contentType: 'text/html', body: html}));
    await page.goto('http://divider.test/');
    const width = () => page.locator('#left').evaluate(element => element.getBoundingClientRect().width);
    const handle = page.locator('#divider');
    assert.equal(await width(), 280);
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await width(), 270);
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await width(), 320);
    await page.reload();
    assert.equal(await width(), 320, 'width did not persist');
    await handle.focus();
    await page.keyboard.press('Home');
    assert.equal(await width(), 140);
    await page.keyboard.press('End');
    assert.equal(await width(), 640);
    await page.setViewportSize({width: 900, height: 700});
    await page.waitForFunction(() => document.getElementById('left').clientWidth === 532);
    assert.ok(await page.locator('#right').evaluate(element => element.clientWidth >= 360));
    await page.setViewportSize({width: 1200, height: 900});
    await page.waitForFunction(() => document.getElementById('left').clientWidth === 640);
    await handle.dblclick();
    assert.equal(await width(), 280);
    const client = await context.newCDPSession(page);
    const bounds = await handle.boundingBox();
    await client.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: bounds.x + 4, y: 450}]});
    await client.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: 204, y: 450}]});
    await client.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await page.waitForFunction(() => document.getElementById('left').clientWidth === 200);
    assert.equal(await handle.getAttribute('aria-valuenow'), '200');
    assert.equal(await page.locator('html').evaluate(element => element.classList.contains('pane-resizing')), false);
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await handle.isVisible(), false);
    await page.setViewportSize({width: 1200, height: 900});
    await page.waitForFunction(() => document.getElementById('left').clientWidth === 200);
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new Error('storage disabled'); };
      Storage.prototype.getItem = () => { throw new Error('storage disabled'); };
    });
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await width(), 210);
    await page.evaluate(() => window.divider.close());
    assert.deepEqual(errors, []);
    console.log('PASS: divider keyboard/touch, bounds, reset, persistence, narrow-window recovery and disabled storage');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
