'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const implementation = source.slice(source.indexOf('  function makeDraggablePropertiesPanel('), source.indexOf('  function esc(value)'));
const storage = new Map();
let resize;
const context = vm.createContext({
  window: {innerWidth: 1000, innerHeight: 700, addEventListener(_name, handler) { resize = handler; }},
  localStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
  ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } },
});
vm.runInContext(implementation, context);

function panel() {
  const handlers = {}, captures = new Set();
  return {
    handlers, style: {}, offsetWidth: 264, offsetHeight: 250,
    classList: {add() {}, remove() {}}, focus() {},
    addEventListener(name, handler) { handlers[name] = handler; },
    setPointerCapture(pointerId) { captures.add(pointerId); },
    hasPointerCapture(pointerId) { return captures.has(pointerId); },
    releasePointerCapture(pointerId) { captures.delete(pointerId); },
    getBoundingClientRect() { return {left: parseFloat(this.style.left) || 722, top: parseFloat(this.style.top) || 14}; },
  };
}
function event(values = {}) {
  return {button: 0, pointerId: 1, clientX: 732, clientY: 24,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values};
}
const first = panel();
context.makeDraggablePropertiesPanel(first);
first.handlers.pointerdown(event({button: 2}));
assert.equal(first.hasPointerCapture(1), false);
const down = event();
first.handlers.pointerdown(down);
assert.ok(down.prevented && down.stopped);
assert.ok(first.hasPointerCapture(1));
first.handlers.pointermove(event({pointerId: 2, clientX: 400, clientY: 300}));
assert.equal(first.style.left, undefined);
first.handlers.pointermove(event({clientX: 410, clientY: 210}));
assert.equal(first.style.left, '400px');
assert.equal(first.style.top, '200px');
first.handlers.pointerup(event());
assert.equal(first.hasPointerCapture(1), false);
const second = panel();
context.makeDraggablePropertiesPanel(second);
assert.equal(second.style.left, '400px');
assert.equal(second.style.top, '200px');
second.handlers.keydown(event({key: 'ArrowLeft'}));
assert.equal(second.style.left, '390px');
second.handlers.keydown(event({key: 'ArrowDown', shiftKey: true}));
assert.equal(second.style.top, '201px');
second.handlers.pointerdown(event({clientX: 400, clientY: 211}));
second.handlers.pointermove(event({clientX: 10000, clientY: 10000}));
assert.equal(second.style.left, '736px');
assert.equal(second.style.top, '450px');
second.handlers.pointercancel(event());
assert.equal(second.hasPointerCapture(1), false);
context.window.innerWidth = 600;
context.window.innerHeight = 400;
resize();
assert.equal(second.style.left, '336px');
assert.equal(second.style.top, '150px');
second.handlers.keydown(event({key: 'Home'}));
assert.equal(second.style.left, 'auto');
assert.equal(second.style.right, '14px');
assert.equal(storage.size, 0);
context.localStorage.getItem = () => { throw new Error('storage blocked'); };
assert.doesNotThrow(() => context.makeDraggablePropertiesPanel(panel()));
assert.doesNotMatch(implementation, /apiJson|sendControl|acquireInteractionLease|schedulePosition/);
console.log('PASS: properties panel drag, capture/cancel, keyboard, viewport bounds and browser-local persistence without RF writes');
