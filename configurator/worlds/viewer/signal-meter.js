(function (root) {
  'use strict';

  const colors = Object.freeze({
    red: '#dc2626', yellow: '#eab308', green: '#15803d', grey: '#d1d5db',
  });
  const segmentCount = 10;
  const noiseFloorDbm = -91;

  function rssiLevel(rssi) {
    if (typeof rssi !== 'number' || !Number.isFinite(rssi) || rssi < -110 || rssi > 0) return 0;
    return Math.max(1, Math.min(segmentCount, Math.floor((rssi + 90) / 5) + 1));
  }

  function snrLevel(snr) {
    return typeof snr === 'number' && Number.isFinite(snr)
      ? rssiLevel(snr + noiseFloorDbm) : 0;
  }

  function segmentColor(index, level) {
    if (index < 0 || index >= segmentCount || index >= level) return colors.grey;
    return index < 3 ? colors.red : index < 7 ? colors.yellow : colors.green;
  }

  function rssiColor(rssi) {
    const level = rssiLevel(rssi);
    return segmentColor(level - 1, level);
  }

  function snrColor(snr) {
    const level = snrLevel(snr);
    return segmentColor(level - 1, level);
  }

  function textColor(background) {
    return background === colors.yellow || background === colors.grey ? '#111827' : '#ffffff';
  }

  const api = Object.freeze({
    colors, segmentCount, noiseFloorDbm, rssiLevel, snrLevel,
    segmentColor, rssiColor, snrColor, textColor,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EasyMeshSignalMeter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
