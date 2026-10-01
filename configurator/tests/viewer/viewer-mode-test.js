'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../../worlds/viewer/index.html'), 'utf8');
const configuration = html.slice(html.indexOf('  const requestedMode ='), html.indexOf('  let liveSource ='));

function mode(search, serverMode) {
  return vm.runInNewContext(configuration + '\n({requestedMode, noConnectMode, interactiveLiveMode, liveMode, replayMode})', {
    location: {search}, URLSearchParams,
    document: {querySelector: () => serverMode ? {content: serverMode} : null},
  });
}

assert.match(html, /<meta name="room-viewer-mode" content="no-connect">/);
for (const serverMode of ['no-connect', 'interactive', 'live', 'replay', null]) {
  for (const search of ['', '?world=home-a-stationary', '?mode=']) {
    const result = mode(search, serverMode);
    assert.equal(result.requestedMode, serverMode || 'no-connect');
    assert.equal(result.noConnectMode, !serverMode || serverMode === 'no-connect');
    assert.equal(result.interactiveLiveMode, serverMode === 'interactive');
    assert.equal(result.liveMode, ['interactive', 'live'].includes(serverMode));
    assert.equal(result.replayMode, serverMode === 'replay');
  }
  for (const override of ['no-connect', 'interactive', 'live', 'replay']) {
    assert.equal(mode('?mode=' + override, serverMode).requestedMode, override);
  }
}
assert.doesNotMatch(configuration, /fetch\(|XMLHttpRequest|EventSource/);
console.log('PASS: host-specific defaults, offline fallback, clean/empty URLs and explicit mode overrides without backend probing');
