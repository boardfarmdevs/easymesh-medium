'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
async function run() {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH,
    headless: true, args: ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu']});
  try {
    const page = await browser.newPage({viewport: {width: 1800, height: 1200}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<html><body style="margin:0;background:#fafafa"><svg width="1800" height="1200"><g class="scene"><g class="steering-effects"></g><g class="nodes"></g><g class="sta-nodes"></g></g></svg></body></html>');
    await page.addScriptTag({path: path.resolve(process.argv[3])});
    await page.addScriptTag({path: path.resolve(process.argv[2])});
    const report = await page.evaluate(() => {
      const scene = d3.select('.scene'), group = scene.select('.steering-effects');
      const nodes = Array.from({length: 6}, (_unused, index) => ({
        x: 230 + index % 3 * 560, y: 250 + Math.floor(index / 3) * 500,
        name: index ? 'Extender-' + index : 'Agent-1'
      }));
      const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect x="1" y="1" width="42" height="42" rx="10" fill="#ea580c"/></svg>');
      const mesh = scene.select('.nodes').selectAll('.node').data(nodes).join('g').attr('class', 'node')
        .attr('transform', node => `translate(${node.x},${node.y})`);
      mesh.append('circle').attr('r', 132).attr('fill', '#dbeafe').attr('fill-opacity', 0.6);
      mesh.append('image').attr('href', icon).attr('x', -22).attr('y', -22).attr('width', 44).attr('height', 44);
      mesh.append('text').attr('class', 'mesh-identity-label').attr('x', 0).attr('y', 50)
        .attr('font-size', 24).attr('text-anchor', 'middle').text(node => node.name);
      const stations = [];
      const cuesStartedAt = performance.now();
      for (let ordinal = 0; ordinal < 24; ordinal++) {
        const nodeRef = nodes[ordinal % nodes.length];
        const station = {nodeRef, iconSize: 30, sta: {staMAC: 'sta-' + ordinal},
          to: {x: ordinal % 2 ? -92 : 92, y: -85 + Math.floor(ordinal / 6) * 65}};
        stations.push(station);
        const client = scene.select('.sta-nodes').append('g').datum(station).attr('class', 'sta-node')
          .attr('transform', `translate(${nodeRef.x},${nodeRef.y})`);
        client.append('rect').attr('class', 'sta-icon').attr('x', station.to.x - 15).attr('y', station.to.y - 15)
          .attr('width', 30).attr('height', 30).attr('rx', 8).attr('fill', '#334155');
        client.append('text').attr('class', 'sta-identity-label').attr('x', station.to.x).attr('y', station.to.y + 37)
          .attr('font-size', 22).attr('text-anchor', 'middle').text('sta-' + ordinal);
        const sourceNode = nodes[(ordinal + 2) % nodes.length];
        const effect = {staMAC: station.sta.staMAC, fromBSSID: 'old-' + ordinal, toBSSID: 'new-' + ordinal,
          changedAt: Date.now(), ageMs: 0, remainingMs: 6000, sourceOffsetX: station.to.x,
          sourceOffsetY: station.to.y, fromOwnerName: sourceNode.name, toOwnerName: nodeRef.name};
        const action = {sta_mac: effect.staMAC, source_bssid: effect.fromBSSID, target_bssid: effect.toBSSID,
          method: 'btm-request', requested_at: new Date(effect.changedAt).toISOString()};
        SteeringCues.draw(group, effect, sourceNode, nodeRef, station, effect.staMAC, [action], 1);
      }
      for (const station of stations.slice(0, 2)) {
        const client = scene.selectAll('.sta-node').filter(data => data === station);
        const badge = client.append('g').attr('class', 'sta-steer-intent-badge');
        badge.append('rect').attr('x', -125).attr('y', -19).attr('width', 250).attr('height', 38)
          .attr('rx', 12).attr('fill', '#fff7ed').attr('stroke', '#f59e0b');
        badge.append('text').attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
          .attr('font-size', 18).text('MOVING ' + station.sta.staMAC + ' → Ext-3');
        group.append('path').datum({sourceNode: station.nodeRef, targetNode: nodes[3], staData: station})
          .attr('class', 'sta-steering-intent-path').attr('fill', 'none').attr('stroke', '#f59e0b')
          .attr('stroke-width', 4).attr('stroke-dasharray', '12 8');
      }
      const checkLabels = () => {
        const boxes = selector => Array.from(document.querySelectorAll(selector), element => {
          const box = element.getBoundingClientRect();
          return {x: box.x, y: box.y, width: box.width, height: box.height};
        });
        const entities = boxes('.mesh-identity-label, .node image, .sta-identity-label, .sta-icon');
        const labels = boxes('.sta-roam-origin-label, .sta-steer-intent-badge');
        for (const [index, box] of labels.entries()) {
          if ([...entities, ...labels.slice(0, index)].some(other => SteeringCues.intersects(box, other))) {
            throw new Error('steering label collision at ' + index);
          }
        }
        return labels;
      };
      const started = performance.now();
      SteeringCues.layout(group);
      const layoutMs = performance.now() - started;
      const labels = checkLabels();
      group.selectAll('.sta-roam-cue').each(function() { SteeringCues.position(d3.select(this)); });
      SteeringCues.layout(group);
      if (JSON.stringify(checkLabels()) !== JSON.stringify(labels)) throw new Error('cached tick reset label placement');
      const initial = group.select('.sta-steering-trail').attr('d');
      nodes[2].x += 85;
      mesh.attr('transform', node => `translate(${node.x},${node.y})`);
      scene.selectAll('.sta-node').attr('transform', station => `translate(${station.nodeRef.x},${station.nodeRef.y})`);
      group.selectAll('.sta-roam-cue').each(function() { SteeringCues.position(d3.select(this)); });
      SteeringCues.layout(group);
      checkLabels();
      if (group.select('.sta-steering-trail').attr('d') === initial) throw new Error('source movement did not update trail');
      for (const trail of group.selectAll('.sta-steering-trail, .sta-steering-intent-path').nodes()) {
        if (trail.classList.contains('sta-steering-trail') && trail.getAttribute('stroke') !== '#7c3aed') throw new Error('BTM is not purple');
        const mask = trail.getAttribute('mask');
        const identifier = mask && mask.match(/^url\(#(.+)\)$/)?.[1];
        const maskElement = identifier && document.getElementById(identifier);
        if (!maskElement) throw new Error('missing entity clearance mask');
        const protectedBoxes = Array.from(maskElement.querySelectorAll('rect')).slice(1).map(element => ({
          x: Number(element.getAttribute('x')), y: Number(element.getAttribute('y')),
          width: Number(element.getAttribute('width')), height: Number(element.getAttribute('height'))
        }));
        for (const entity of document.querySelectorAll('.node image, .mesh-identity-label, .sta-icon, .sta-identity-label, .sta-roam-origin-label')) {
          const box = entity.getBoundingClientRect();
          if (!protectedBoxes.some(protectedBox => box.x >= protectedBox.x && box.y >= protectedBox.y &&
              box.right <= protectedBox.x + protectedBox.width && box.bottom <= protectedBox.y + protectedBox.height)) {
            throw new Error('entity missing from clearance mask');
          }
        }
      }
      const bounds = scene.node().getBBox();
      d3.select('svg').attr('viewBox', `${bounds.x - 12} ${bounds.y - 12} ${bounds.width + 24} ${bounds.height + 24}`);
      const expiry = {layouts: 0, elapsedMs: null};
      const getScreenCTM = scene.node().getScreenCTM.bind(scene.node());
      scene.node().getScreenCTM = () => { expiry.layouts++; return getScreenCTM(); };
      const observer = new MutationObserver(() => {
        if (!group.select('.sta-roam-cue').empty()) return;
        expiry.elapsedMs = performance.now() - cuesStartedAt;
        observer.disconnect();
      });
      observer.observe(group.node(), {childList: true});
      window.steeringFixture = {group, scene, stations, nodes, expiry, checkLabels};
      return {cues: group.selectAll('.sta-roam-cue').size(), labels: labels.length, layoutMs, width: bounds.width, height: bounds.height};
    });
    assert.equal(report.cues, 24);
    assert.equal(report.labels, 26);
    assert.ok(report.layoutMs < 1500, `unbounded batch layout: ${report.layoutMs} ms`);
    if (process.argv[4]) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      fs.writeFileSync(process.argv[4] + '.svg', await page.locator('svg').evaluate(element => element.outerHTML));
      await page.screenshot({path: process.argv[4]});
    }
    await page.waitForFunction(() => !document.querySelector('.sta-roam-cue'), null, {timeout: 8000});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    report.expiry = await page.evaluate(() => {
      const {group, expiry, checkLabels} = window.steeringFixture;
      return {...expiry, labels: checkLabels().length,
        intents: group.selectAll('.sta-steering-intent-path').size(),
        maskRects: group.selectAll('mask rect').size(),
        entities: document.querySelectorAll('.node image, .mesh-identity-label, .sta-icon, .sta-identity-label').length};
    });
    assert.ok(report.expiry.layouts > 0 && report.expiry.layouts < report.cues,
      `expiry must batch scene layouts: ${JSON.stringify(report.expiry)}`);
    assert.equal(report.expiry.labels, 2);
    assert.equal(report.expiry.intents, 2);
    assert.equal(report.expiry.maskRects, 1 + report.expiry.entities + report.expiry.labels,
      'clearance mask must release expired labels while retaining entities and intent badges');
    assert.deepEqual(errors, []);
    console.log('PASS: 24 simultaneous roams, collision-free labels, masked entities, purple BTM, cached ticks, movement and unchanged six-second expiry', JSON.stringify(report));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
