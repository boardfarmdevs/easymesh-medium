(function (root) {
  'use strict';
  function rows(report, elapsedMs = 0) {
    return ['2.4', '5', '6'].map(band => {
      const samples = (report.channels || []).filter(sample =>
        (sample.frequency_mhz < 3000 ? '2.4' : sample.frequency_mhz < 5925 ? '5' : '6') === band);
      return {band, samples: samples.map(sample => {
        const age = sample.age_ms + elapsedMs;
        const valid = report.state === 'valid' && sample.state === 'valid' &&
          typeof sample.value === 'number' && Number.isFinite(sample.value) &&
          sample.value >= 0 && sample.value <= 100 && age >= 0 && age <= 1000;
        return {frequency: sample.frequency_mhz, value: valid ? sample.value : null,
          age, window: sample.window_ms};
      })};
    });
  }
  function start(element, endpoint) {
    let latest = {state: 'unavailable'}, received = performance.now(), stopped = false;
    const cells = rows(latest).map(group => {
      const label = document.createElement('span');
      label.textContent = group.band + ' GHz';
      const value = document.createElement('b');
      value.textContent = '—';
      element.append(label, value);
      return value;
    });
    async function update() {
      if (stopped) return;
      try {
        const response = await fetch(endpoint, {cache: 'no-store', signal: AbortSignal.timeout(1500)});
        if (!response.ok) throw new Error('RF endpoint unavailable');
        latest = await response.json();
        received = performance.now();
      } catch {
        latest = {state: 'unavailable'};
      }
      render();
      if (!stopped) setTimeout(update, 500);
    }
    function render() {
      for (const [index, group] of rows(latest, performance.now() - received).entries()) {
        const value = cells[index];
        const valid = group.samples.filter(sample => sample.value !== null);
        value.textContent = valid.length ? valid.map(sample => sample.value.toFixed(1) + '%').join(' / ') : '—';
        value.title = valid.length ? valid.map(sample => sample.frequency + ' MHz · ' +
          Math.round(sample.age) + ' ms old · ' + Math.round(sample.window) + ' ms window').join('\n')
          : 'Unavailable or stale; not measured zero';
      }
      element.dataset.state = latest.state;
    }
    const ageTimer = setInterval(render, 250);
    update();
    return () => { stopped = true; clearInterval(ageTimer); };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {rows, start};
  else root.RoomRFLoad = {rows, start};
})(typeof globalThis !== 'undefined' ? globalThis : this);
