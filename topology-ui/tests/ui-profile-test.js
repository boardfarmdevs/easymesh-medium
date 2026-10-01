'use strict';
// The stack profiles (profiles/*.js, installed as static/ui-profile.js): the page's names,
// tabs, charts and WebSocket follow the profile; RDK's profile leaves RDK's page as it is.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = path.resolve(process.argv[2]);
const profiles = path.resolve(__dirname, '../profiles');
let elements = {};
global.document = {
  title: '', addEventListener() {}, getElementById(id) { return elements['#' + id] ??= {classList: {add() {}}, innerHTML: ''}; },
  querySelector(selector) { return elements[selector] ??= {textContent: '', classList: {add() {}}}; },
  querySelectorAll() { return []; },
};
global.window = {addEventListener() {}};
const Controller = require(source);

function profile(stack) {
  const sandbox = {window: {}};
  vm.runInNewContext(fs.readFileSync(path.join(profiles, stack + '.js'), 'utf8'), sandbox);
  return sandbox.window.EASYMESH_UI_PROFILE;
}
function controller(stack) {
  elements = {};
  document.title = '';
  window.EASYMESH_UI_PROFILE = stack ? profile(stack) : undefined;
  return new Controller();
}

const stacks = fs.readdirSync(profiles).filter(name => name.endsWith('.js')).map(name => name.slice(0, -3)).sort();
assert.deepEqual(stacks, ['prplmesh', 'rdk']);
assert.deepEqual(Object.keys(profile('prplmesh')).sort(), Object.keys(profile('rdk')).sort());

// No profile: RDK's page.
let page = controller();
assert.equal(page.currentTab, 'dashboard');
assert.equal(page.supportedTabs, null);
assert.equal(document.title, '');

// RDK: its profile repeats the page's own names, every tab, charts and the WebSocket.
const html = fs.readFileSync(path.join(path.dirname(source), 'index.html'), 'utf8');
const rdk = profile('rdk');
assert.ok(html.includes(`<title>${rdk.title}</title>`));
assert.ok(html.includes(`<span class="logo-text">${rdk.logo}</span>`));
assert.ok(html.includes(`<span class="version-badge">${rdk.badge}</span>`));
assert.ok(html.includes(`<span class="wireless-label">${rdk.wirelessLabel}</span>`));
assert.ok(html.indexOf('ui-profile.js') < html.indexOf('script.js'), 'the profile loads before the page');
page = controller('rdk');
assert.equal(page.currentTab, 'dashboard');
assert.equal(page.supportedTabs, null);
assert.equal(rdk.charts, true);
assert.equal(rdk.websocket, true);

// prplMesh: its names, the topology first, four tabs, no charts, no WebSocket.
const prpl = profile('prplmesh');
page = controller('prplmesh');
assert.equal(document.title, prpl.title);
assert.equal(elements['.logo-text'].textContent, prpl.logo);
assert.equal(elements['.version-badge'].textContent, prpl.badge);
assert.equal(elements['.wireless-label'].textContent, prpl.wirelessLabel);
assert.equal(page.currentTab, 'topology');
assert.deepEqual([...page.supportedTabs].sort(), ['clients', 'devices', 'topology', 'wireless']);
let loads = 0;
page.loadPerformanceData = async () => { loads += 1; };
page.loadTabData('performance');
assert.equal(loads, 0, 'an unsupported tab called its backend');
page.showTab('performance');
assert.match(elements['#performance'].innerHTML, /not served by this controller's backend/);
assert.equal(loads, 0);
let status = null;
page.updateConnectionStatus = connected => { status = connected; };
page.initializeWebSocket();
assert.equal(status, true);
assert.equal(page.wsConnection, null, 'the prplMesh page opened a WebSocket');
console.log('PASS: profiles: RDK page unchanged, prplMesh names, tabs, no charts or WebSocket');
