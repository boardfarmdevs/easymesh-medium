'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const ribbon = {};
const context = {
  liveMode: true,
  liveClock: {serverMs: Date.parse('2026-09-07T03:40:00Z'), receivedMs: 100},
  performance: {now: () => 100},
  recentEvents: [
    {world_time_ms: 240000, recorded_at: '2026-09-07T03:39:45Z', label: 'First'},
    {world_time_ms: 240000, recorded_at: '2026-09-07T03:39:58Z', label: '<Latest>'},
  ],
  $: () => ribbon,
};
vm.createContext(context);
for (const name of ['esc', 'renderRecentEvents']) {
  vm.runInContext(html.match(new RegExp('  function ' + name + '\\([\\s\\S]*?\\n  \\}'))[0], context);
}
context.renderRecentEvents();
assert.match(ribbon.innerHTML, /15s ago/);
assert.match(ribbon.innerHTML, /2s ago/);
assert.match(ribbon.innerHTML, /2026-09-07T03:39:58Z/);
assert.match(ribbon.innerHTML, /&lt;Latest&gt;/);
assert.doesNotMatch(ribbon.innerHTML, /240\.0s/);
assert.ok(ribbon.innerHTML.indexOf('Latest') < ribbon.innerHTML.indexOf('First'));
context.performance.now = () => 65100;
context.renderRecentEvents();
assert.match(ribbon.innerHTML, /1m 7s ago/);
context.performance.now = () => 3600100;
context.renderRecentEvents();
assert.match(ribbon.innerHTML, /1h 0m ago/);
context.recentEvents.push({world_time_ms: 240000, label: 'Missing timestamp'});
context.renderRecentEvents();
assert.match(ribbon.innerHTML, /Unknown age/);
context.liveClock = null;
assert.doesNotThrow(() => context.renderRecentEvents());
assert.doesNotMatch(ribbon.innerHTML, /NaN|240\.0s/);
context.liveMode = false;
context.renderRecentEvents();
assert.match(ribbon.innerHTML, /Scenario time/);
assert.match(ribbon.innerHTML, /240\.0s/);
assert.doesNotMatch(ribbon.innerHTML, /ago/);
assert.match(html, /recentEvents\.push\(\{world_time_ms: event\.world_time_ms, recorded_at: event\.recorded_at, label\}\)/);
console.log('PASS: live event ages advance beyond paused/capped playback, without browser wall-clock skew; replay retains scenario time');
