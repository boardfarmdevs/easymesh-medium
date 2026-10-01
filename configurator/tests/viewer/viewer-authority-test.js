'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const elements = Object.fromEntries(['#profilingAuthority', '#fullscreenAuthority', '#backhaulPolicyTitle',
  '#backhaulPolicyDetail', '#backhaulPolicyCard'].map(selector => [selector, {textContent: '', dataset: {}}]));
const context = {profilingState: null, noConnectMode: false, $: selector => elements[selector],
  RoomGuide: {backhaulDescription: policy => ({title: policy, detail: policy})}};
vm.createContext(context);
for (const name of ['renderProfilingAuthority', 'renderBackhaulPolicy']) {
  vm.runInContext(source.match(new RegExp('  function ' + name + '\\([\\s\\S]*?\\n  \\}'))[0], context);
}
context.renderBackhaulPolicy('fixed-startup-mesh');
assert.equal(elements['#fullscreenAuthority'].textContent, '');
context.profilingState = {mode: 'unassisted-btm', backhaul_rf: 'fixed-startup-mesh'};
for (const [policy, expected] of [['fixed-startup-mesh', 'protected startup backhaul'],
  ['modeled', 'geometry backhaul · native parents'], ['adaptive-rdk', 'geometry backhaul · assisted parents'],
  [undefined, 'backhaul pending']]) {
  context.renderBackhaulPolicy(policy);
  for (const selector of ['#profilingAuthority', '#fullscreenAuthority']) {
    assert.equal(elements[selector].textContent, 'External policy · unassisted BTM · ' + expected);
  }
}
context.profilingState.mode = 'native-observation';
context.renderProfilingAuthority('modeled');
assert.equal(elements['#fullscreenAuthority'].textContent,
  'Native observation · no lab steering · geometry backhaul · native parents');
assert.match(source, /profilingState = event.payload;\s+renderProfilingAuthority\(interaction.backhaulPolicy\)/);
console.log('PASS: room changes update sidebar and fullscreen authority without stale startup backhaul');
