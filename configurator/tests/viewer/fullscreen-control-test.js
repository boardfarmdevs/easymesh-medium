'use strict';

// The fullscreen control the room viewer and the topology page share (fullscreen-control.js).
const assert = require('assert').strict;
const path = require('path');
const helper = require(path.resolve(__dirname, '../../worlds/viewer/fullscreen-control.js'));

function fixture() {
  const document = new EventTarget();
  Object.assign(document, {fullscreenElement: null, fullscreenEnabled: true});
  const button = new EventTarget();
  const attributes = {};
  let focusCount = 0;
  Object.assign(button, {setAttribute: (name, value) => {attributes[name] = value;},
    focus: () => {focusCount++;}});
  const target = {ownerDocument: document, async requestFullscreen() {
    document.fullscreenElement = target;
    document.dispatchEvent(new Event('fullscreenchange'));
  }};
  document.exitFullscreen = async () => {
    document.fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  return {document, target, button, status: {}, attributes, focusCount: () => focusCount};
}

(async () => {
  const view = fixture();
  const changes = [];
  const control = helper.attach({...view, onChange: active => changes.push(active)});
  assert.equal(view.button.textContent, 'Full screen');
  await control.toggle();
  assert.equal(view.attributes['aria-pressed'], 'true');
  assert.equal(view.button.textContent, 'Exit full screen');
  await view.document.exitFullscreen();
  assert.equal(view.attributes['aria-pressed'], 'false');
  assert.equal(view.focusCount(), 1);
  await control.toggle();
  await control.toggle();
  assert.equal(view.document.fullscreenElement, null);
  assert.equal(view.focusCount(), 2);
  view.target.requestFullscreen = async () => {throw new Error('Permission denied');};
  await control.toggle();
  assert.match(view.status.textContent, /Permission denied/);
  assert.equal(view.attributes['aria-pressed'], 'false');
  assert.equal(view.button.disabled, false);
  let finish;
  let requests = 0;
  view.target.requestFullscreen = () => {requests++; return new Promise(resolve => {finish = resolve;});};
  const pending = control.toggle();
  assert.equal(view.button.disabled, true);
  await control.toggle();
  assert.equal(requests, 1);
  finish();
  await pending;
  control.destroy();
  const changeCount = changes.length;
  view.document.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(changes.length, changeCount);
  for (const supported of [false, undefined]) {
    const unavailable = fixture();
    if (supported === false) unavailable.document.fullscreenEnabled = false;
    else unavailable.target.requestFullscreen = undefined;
    const disabled = helper.attach(unavailable);
    assert.equal(unavailable.button.disabled, true);
    await disabled.toggle();
    assert.equal(unavailable.document.fullscreenElement, null);
  }
  console.log('PASS: full screen enter/exit, Esc state/focus, rejection, pending clicks and unsupported embedding');
})().catch(error => {console.error(error); process.exitCode = 1;});
