'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname,
  '../../worlds/viewer/index.html'), 'utf8');
const loading = source.slice(source.indexOf("  const sel = $('#world');"),
  source.indexOf('  // ---- controls', source.indexOf("  const sel = $('#world');")));
const staticCatalog = vm.runInNewContext(source.match(/const GOLDEN = (\[[\s\S]*?\]);/)[1]);
const installedCatalog = fs.readdirSync(path.resolve(__dirname, '../../worlds/golden'))
  .filter(filename => filename.endsWith('.world.json')).map(filename => filename.slice(0, -11)).sort();
assert.deepEqual(Array.from(staticCatalog).sort(), installedCatalog, 'static catalog includes every installed room');

class WorldFile {
  constructor(contents, size = contents.length) {
    this.contents = contents;
    this.size = size;
    this.name = 'uploaded.world.json';
  }
  async text() { return this.contents; }
}

function harness({interactive = true, live = true} = {}) {
  const elements = new Map();
  function element() {
    return {value: '', disabled: false, hidden: false, style: {}, dataset: {},
      options: [], listeners: {},
      addEventListener(event, listener) { this.listeners[event] = listener; },
      appendChild(option) {
        this.options.push(option);
        option.remove = () => { this.options = this.options.filter(item => item !== option); };
      }};
  }
  const writes = [];
  const previews = [];
  const context = vm.createContext({
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    document: {createElement: element}, File: WorldFile, GOLDEN: ['old', 'new'],
    liveMode: live, interactiveLiveMode: interactive,
    world: {name: 'Old room'}, interaction: {}, clearTimeout,
    acquireInteractionLease: async () => true,
    sendControl: async (url, method, payload) => {
      writes.push({url, method, world: payload.world});
      return {expected_online_clients: 10, pool_clients: 20};
    },
    refreshInteractionSnapshot: async () => {},
    fetchWorld: name => previews.push(name), loadWorld: world => previews.push(world),
    err: message => { context.error = message; },
  });
  vm.runInContext(loading, context);
  vm.runInContext("liveWorldCatalog = [{id: 'old', name: 'Old room'}, {id: 'new', name: 'New room'}];", context);
  const select = elements.get('#world');
  select.value = 'old';
  return {context, writes, previews, elements, select};
}

async function main() {
  const selected = harness();
  selected.select.value = 'new';
  await selected.select.listeners.change();
  assert.equal(selected.writes.length, 1);
  assert.equal(selected.writes[0].world, 'new');
  assert.equal(selected.writes[0].url, '/api/demo/world/apply');
  assert.deepEqual(selected.previews, [], 'scene only changes on a server commit');

  const uploaded = harness();
  const fileInput = uploaded.elements.get('#file');
  await fileInput.listeners.change({target: {files: [new WorldFile('{"schema":"wmdcfg.world-plan.v1","name":"Upload"}')]}});
  assert.equal(uploaded.writes[0].world.name, 'Upload');
  assert.equal(fileInput.value, '', 'the same file can be selected again');
  assert.deepEqual(uploaded.previews, []);
  uploaded.context.world = {name: 'Upload'};
  vm.runInContext('selectCurrentLiveWorld()', uploaded.context);
  assert.equal(uploaded.select.value, '');
  assert.equal(uploaded.select.options.at(-1).textContent, 'Upload (uploaded)');
  uploaded.context.world = {name: 'Old room'};
  vm.runInContext('selectCurrentLiveWorld()', uploaded.context);
  assert.equal(uploaded.select.value, 'old');
  assert.equal(uploaded.select.options.length, 2);

  for (const file of [new WorldFile('invalid'), new WorldFile('{}'), new WorldFile('{}', 4 * 1024 * 1024 + 1)]) {
    const invalid = harness();
    invalid.select.value = 'new';
    await invalid.elements.get('#file').listeners.change({target: {files: [file]}});
    assert.equal(invalid.writes.length, 0);
    assert.equal(invalid.select.value, 'old');
    assert.equal(invalid.select.disabled, false);
    assert.deepEqual(invalid.previews, []);
    assert.ok(invalid.elements.get('#worldSwitchStatus').textContent);
  }

  for (const failure of ['capability', 'server']) {
    const rejected = harness();
    if (failure === 'capability') rejected.context.acquireInteractionLease = async () => false;
    else rejected.context.sendControl = async () => null;
    rejected.select.value = 'new';
    await rejected.select.listeners.change();
    assert.equal(rejected.select.value, 'old');
    assert.deepEqual(rejected.previews, []);
    assert.equal(vm.runInContext('worldSwitchError', rejected.context), true);
  }

  const busy = harness();
  let release;
  busy.context.acquireInteractionLease = () => new Promise(resolve => { release = resolve; });
  busy.select.value = 'new';
  const pending = busy.select.listeners.change();
  for (const selector of ['#world', '#file', '#defaultWorld']) {
    assert.equal(busy.elements.get(selector).disabled, true);
  }
  await busy.elements.get('#defaultWorld').listeners.click();
  assert.equal(busy.writes.length, 0);
  release(true);
  await pending;
  assert.equal(busy.writes.length, 1, 'one in-flight switch at a time');
  assert.equal(busy.select.disabled, false);

  const defaults = harness();
  await defaults.elements.get('#defaultWorld').listeners.click();
  assert.equal(defaults.writes[0].world, 'default');

  const starting = harness();
  vm.runInContext('liveWorldCatalog = []; setWorldControlsBusy(false)', starting.context);
  assert.equal(starting.select.disabled, true, 'wait for the authoritative catalog before enabling loading');
  await starting.select.listeners.change();
  assert.deepEqual(starting.writes, []);

  const observer = harness({interactive: false});
  observer.select.value = 'new';
  await observer.select.listeners.change();
  await observer.elements.get('#file').listeners.change({target: {files: [new WorldFile('{}')]}});
  assert.deepEqual(observer.writes, []);
  assert.deepEqual(observer.previews, []);

  const offline = harness({interactive: false, live: false});
  offline.select.value = 'new';
  await offline.select.listeners.change();
  await offline.elements.get('#file').listeners.change({target: {files: [new WorldFile('{"schema":"wmdcfg.world-plan.v1"}')]}});
  assert.deepEqual(offline.writes, []);
  assert.equal(offline.previews.length, 2);
  console.log('PASS: automatic world select/upload, busy guard, rejection, default and observer/offline boundaries');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
