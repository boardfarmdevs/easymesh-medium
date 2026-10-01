'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const roomName = require('../../worlds/viewer/room-name.js');
const roomProjection = require('../../worlds/viewer/room-projection.js');
const interactionModel = require('../../worlds/viewer/interaction-model.js');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(__dirname, '../../worlds');
const html = fs.readFileSync(path.join(root, 'viewer/index.html'), 'utf8');
const guideSource = fs.readFileSync(path.join(root, 'viewer/room-guide.js'), 'utf8');
const styles = html.match(/<style>[\s\S]*?<\/style>/)[0] + '<style>' +
  fs.readFileSync(path.join(root, 'viewer/room-guide.css'), 'utf8') + '</style>';
const markup = html.match(/<dialog id="roomGuide"[\s\S]*?<\/dialog>/)[0];
const opener = html.match(/<button id="openRoomGuide"[^\n]+/)[0];
const keyboard = html.match(/  document\.addEventListener\('keydown', \(event\) =>[^\n]+/)[0];
const catalog = Array.from(vm.runInNewContext(html.match(/const GOLDEN = (\[[\s\S]*?\]);/)[1]));

async function main() {
  const server = http.createServer((request, response) => {
    const filename = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const type = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'}[path.extname(filename)];
    response.writeHead(200, {'Content-Type': type || 'application/octet-stream'});
    fs.createReadStream(filename).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const environment = {...process.env};
    delete environment.DISPLAY;
    browser = await chromium.launch({headless: true, env: environment,
      ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}),
      args: ['--no-sandbox', '--ozone-platform=headless', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']});
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
    const fixture = async mode => {
      await page.goto('about:blank');
      await page.setContent('<!doctype html><html><head>' + styles + '</head><body>' +
        '<aside><select id="world"></select>' + opener + '</aside>' + markup + '</body></html>');
      await page.addScriptTag({content: guideSource});
      await page.evaluate(({mode, catalog}) => {
        window.changes = [];
        const select = document.getElementById('world');
        for (const id of catalog) select.add(new Option(id, id));
        select.value = 'home-a-stationary';
        select.addEventListener('change', () => window.changes.push(select.value));
        RoomGuide.mount(document, select, mode);
      }, {mode, catalog});
      await page.addScriptTag({content: 'var playCalls = 0; function togglePlay() { playCalls++; }\n' + keyboard});
      await page.locator('#openRoomGuide').click();
    };
    const preview = id => page.locator('#roomGuideList button').filter({has: page.locator('small', {hasText: id})});

    for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}, {width: 600, height: 500}]) {
      await page.setViewportSize(viewport);
      await fixture('interactive');
      assert.equal(await page.locator('#roomGuideList button').count(), catalog.length);
      for (const id of catalog) {
        await preview(id).hover();
        assert.equal(await page.locator('#roomGuideRoomId').textContent(), id);
        assert.ok((await page.locator('#roomGuide-rf').textContent()).length > 100);
      }
      assert.deepEqual(await page.evaluate(() => changes), []);
      assert.equal(await page.locator('#world').inputValue(), 'home-a-stationary');
      await preview('home-a-stationary').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('#roomGuideRoomId').textContent(), 'home-a-slow-walk-ten');
      await page.locator('#roomGuideDetails').focus();
      await page.keyboard.press('Space');
      assert.equal(await page.evaluate(() => playCalls), 0);
      const fits = await page.locator('#roomGuide').evaluate(dialog => {
        const bounds = dialog.getBoundingClientRect();
        const footer = dialog.querySelector('footer').getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight &&
          dialog.scrollWidth <= dialog.clientWidth && footer.bottom <= bounds.bottom &&
          dialog.querySelector('#roomGuideDetails').clientHeight > 60;
      });
      assert.ok(fits, 'dialog and load control fit ' + JSON.stringify(viewport));
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#roomGuide').evaluate(dialog => dialog.open), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'openRoomGuide');
      assert.deepEqual(await page.evaluate(() => changes), []);
    }

    await fixture('interactive');
    await preview('home-a-flash-crowd').click();
    await page.evaluate(() => { document.getElementById('world').disabled = true; });
    await page.waitForFunction(() => document.getElementById('loadGuideRoom').disabled);
    assert.deepEqual(await page.evaluate(() => changes), []);
    await page.evaluate(() => { document.getElementById('world').disabled = false; });
    await page.waitForFunction(() => !document.getElementById('loadGuideRoom').disabled);
    await page.locator('#loadGuideRoom').click();
    assert.deepEqual(await page.evaluate(() => changes), ['home-a-flash-crowd']);
    assert.equal(await page.locator('#roomGuide').evaluate(dialog => dialog.open), false);
    await page.locator('#world').selectOption('home-a-stationary');
    assert.deepEqual(await page.evaluate(() => changes), ['home-a-flash-crowd', 'home-a-stationary']);

    for (const mode of ['live', 'replay', 'no-connect']) {
      await fixture(mode);
      await preview('home-a-one-client-handover').click();
      assert.deepEqual(await page.evaluate(() => changes), []);
      assert.equal(await page.locator('#loadGuideRoom').isDisabled(), mode !== 'no-connect');
      if (mode === 'no-connect') {
        assert.equal(await page.locator('#loadGuideRoom').textContent(), 'Load preview');
        await page.locator('#loadGuideRoom').click();
        assert.deepEqual(await page.evaluate(() => changes), ['home-a-one-client-handover']);
      }
    }

    await fixture('interactive');
    await page.evaluate(() => {
      const select = document.getElementById('world');
      select.replaceChildren(new Option('<img src=x onerror="window.injected=true">', 'custom-room'));
    });
    await page.waitForFunction(() => document.querySelectorAll('#roomGuideList button').length === 1);
    await page.locator('#roomGuideList button').click();
    assert.equal(await page.locator('#roomGuideRoomTitle').textContent(), 'Custom or unlisted room');
    assert.equal(await page.locator('#roomGuideList img').count(), 0);
    assert.match(await page.locator('#roomGuide-limits').textContent(), /No room-specific/);
    await page.locator('#loadGuideRoom').click();
    assert.deepEqual(await page.evaluate(() => changes), ['custom-room']);
    await page.evaluate(() => {
      const select = document.getElementById('world');
      const option = new Option('My uploaded room', '');
      option.dataset.uploaded = 'true';
      select.replaceChildren(option);
    });
    await page.locator('#openRoomGuide').click();
    assert.equal(await page.locator('#loadGuideRoom').isDisabled(), true);
    await page.evaluate(() => document.getElementById('world').replaceChildren());
    await page.waitForFunction(() => document.querySelectorAll('#roomGuideList button').length === 0);
    assert.equal(await page.locator('#loadGuideRoom').isDisabled(), true);

    await page.setViewportSize({width: 1440, height: 1000});
    await page.goto('http://127.0.0.1:' + server.address().port + '/viewer/index.html?world=home-a-stationary');
    await page.waitForFunction(() => {
      const error = document.getElementById('err').textContent;
      if (error) throw new Error(error);
      return window.__viewer && document.getElementById('worldmeta').textContent.includes('stationary');
    });
    const initialRoom = JSON.parse(fs.readFileSync(path.join(root, 'golden/home-a-stationary.world.json'))).name;
    assert.equal(await page.locator('#roomName').textContent(), 'Room: ' + roomName.format(initialRoom));
    const assertWorldFirst = async targetPage => {
      assert.equal(await targetPage.locator('#roomSidebar').evaluate(sidebar => {
        const controls = ['world', 'openRoomGuide', 'backhaulPolicyCard', 'file', 'defaultWorld', 'worldSwitchStatus'];
        const readings = ['worldmeta', 'liveStatus', 'profilingAuthority', 'liveRun', 'rfLoadCard', 'optimizerCard'];
        return controls.every(control => readings.every(reading =>
          sidebar.querySelector('#' + control).compareDocumentPosition(sidebar.querySelector('#' + reading)) &
          Node.DOCUMENT_POSITION_FOLLOWING));
      }), true, 'world setup precedes dependent readings in visual and keyboard order');
      const visible = await targetPage.locator('#world').evaluate(select => {
        const bounds = select.getBoundingClientRect();
        const sidebar = select.closest('aside');
        const panel = sidebar.getBoundingClientRect();
        return sidebar.scrollTop === 0 && bounds.top >= panel.top && bounds.bottom <= panel.bottom;
      });
      assert.equal(visible, true, 'world selector is visible without scrolling');
    };
    await assertWorldFirst(page);
    await page.evaluate(() => document.body.classList.add('live-presentation'));
    await assertWorldFirst(page);
    await page.evaluate(() => document.body.classList.remove('live-presentation'));
    const initialSceneWidth = await page.locator('#roomView').evaluate(element => element.clientWidth);
    const divider = await page.locator('#roomPanelDivider').boundingBox();
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
    await page.mouse.down();
    await page.mouse.move(divider.x - 120, divider.y + divider.height / 2, {steps: 6});
    await page.mouse.up();
    await page.waitForFunction(previous => document.getElementById('roomView').clientWidth > previous + 100, initialSceneWidth);
    await page.waitForFunction(() => document.querySelector('#roomView canvas').width / Math.min(devicePixelRatio, 2) === document.getElementById('roomView').clientWidth);
    await page.locator('#roomPanelDivider').dblclick();
    await page.waitForFunction(() => document.getElementById('roomSidebar').getBoundingClientRect().width === 380);
    await page.waitForFunction(() => document.querySelector('#roomView canvas').width / Math.min(devicePixelRatio, 2) === document.getElementById('roomView').clientWidth);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const dimensions = interactionModel.roomSize(JSON.parse(fs.readFileSync(path.join(root, 'golden/home-a-stationary.world.json'))));
    const center = [dimensions.width / 2, dimensions.height / 2];
    const corners = [[0, 0], [dimensions.width, 0], [0, dimensions.height], [dimensions.width, dimensions.height]];
    const rendered = await page.evaluate(points => points.map(point => window.__viewer.projectFloor(point)), [center, ...corners]);
    for (const [index, point] of corners.entries()) {
      const expected = roomProjection.floor(point, center);
      const actual = {x: rendered[index + 1].x - rendered[0].x, y: rendered[index + 1].y - rendered[0].y};
      const alignment = (actual.x * expected.x + actual.y * expected.y) / (Math.hypot(actual.x, actual.y) * Math.hypot(expected.x, expected.y));
      assert.ok(alignment > 0.999999, 'topology orientation differs from the actual room camera');
    }
    await page.locator('#openRoomGuide').click();
    await preview('band-upgrade-24-5').hover();
    assert.equal(await page.locator('#world').inputValue(), 'home-a-stationary');
    await page.screenshot({path: process.env.ROOM_GUIDE_SCREENSHOT || '/tmp/rdk-room-guide.png'});
    await page.locator('#loadGuideRoom').click();
    await page.waitForFunction(() => document.getElementById('worldmeta').textContent.includes('band-upgrade-24-5'));
    assert.equal(await page.locator('#world').inputValue(), 'band-upgrade-24-5');
    const loadedRoom = JSON.parse(fs.readFileSync(path.join(root, 'golden/band-upgrade-24-5.world.json'))).name;
    assert.equal(await page.locator('#roomName').textContent(), 'Room: ' + roomName.format(loadedRoom));
    await page.locator('#roomFullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'roomView');
    assert.equal(await page.locator('#roomName').isVisible(), true);
    await page.evaluate(() => document.exitFullscreen());
    assert.deepEqual(errors, []);

    const touch = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true});
    const touchPage = await touch.newPage();
    await touchPage.goto('http://127.0.0.1:' + server.address().port + '/viewer/index.html?world=home-a-stationary');
    await touchPage.waitForFunction(() => window.__viewer);
    await assertWorldFirst(touchPage);
    await touchPage.evaluate(() => document.body.classList.add('live-presentation'));
    await assertWorldFirst(touchPage);
    await touchPage.evaluate(() => document.body.classList.remove('live-presentation'));
    await touchPage.locator('#openRoomGuide').tap();
    await touchPage.locator('#roomGuideList button[data-world="home-a-border-hover"]').tap();
    assert.equal(await touchPage.locator('#roomGuideRoomId').textContent(), 'home-a-border-hover');
    assert.equal(await touchPage.locator('#world').inputValue(), 'home-a-stationary');
    await touch.close();
    console.log('PASS: hover/focus/touch, keyboard isolation, responsive layout, live-load delegation, busy/read-only guards, catalog replacement, safe custom rooms and full sandbox integration');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
