(function (root) {
  'use strict';
  const defaultAngles = Object.freeze({theta: -0.9, phi: 0.95});
  function floor(position, origin = [0, 0], angles = defaultAngles) {
    const deltaX = position[0] - origin[0], deltaY = position[1] - origin[1];
    return {
      x: (deltaX * Math.cos(angles.theta) + deltaY * Math.sin(angles.theta)) || 0,
      y: (Math.cos(angles.phi) * (deltaX * Math.sin(angles.theta) - deltaY * Math.cos(angles.theta))) || 0
    };
  }
  const api = {defaultAngles, floor};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoomProjection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
