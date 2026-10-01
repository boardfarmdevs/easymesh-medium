'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const method = source.slice(source.indexOf('  async refreshTopologyData()'), source.indexOf('\n  /**', source.indexOf('  async refreshTopologyData()')));
const context = vm.createContext({console});
const Controller = vm.runInContext('(class {' + method + '})', context);
const settle = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  const controller = new Controller();
  let releaseMetrics;
  let topologyCalls = 0;
  let metricCalls = 0;
  let topologyRenders = 0;
  let metricRenders = 0;
  controller.apiCall = endpoint => {
    if (endpoint === '/topology') { topologyCalls++; return Promise.resolve({nodes: []}); }
    metricCalls++;
    return new Promise(resolve => { releaseMetrics = resolve; });
  };
  controller.applyTopologyRefresh = () => { topologyRenders++; return true; };
  controller.updateTopologyClients = () => { metricRenders++; };
  controller.refreshTopologySignalVisuals = () => {};
  controller.refreshTopologyData();
  await settle();
  assert.equal(topologyRenders, 1, 'slow metrics blocked the association graph');
  await controller.refreshTopologyData();
  assert.equal(topologyCalls, 2);
  assert.equal(metricCalls, 1, 'a slow metrics response accumulated duplicate requests');
  releaseMetrics({clients: []});
  await settle();
  assert.equal(metricRenders, 1);
  let releaseTopology;
  controller.topologyMetricsNextAt = 0;
  controller.apiCall = endpoint => endpoint === '/topology'
    ? new Promise(resolve => { releaseTopology = resolve; }) : Promise.resolve({clients: []});
  const pending = controller.refreshTopologyData();
  await settle();
  assert.equal(metricRenders, 2, 'slow topology blocked the signal update');
  releaseTopology({nodes: []});
  await pending;
  console.log('PASS: independent topology/metrics rendering with one bounded request per stream');
}

main().catch(error => {console.error(error); process.exitCode = 1;});
