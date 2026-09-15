(function (root) {
  'use strict';
  const format = value => String(value || '').split('--').map(part => {
    const words = part.replace(/[-_]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }).filter(Boolean).join(' — ') || 'Waiting for room';
  if (typeof module === 'object' && module.exports) module.exports = {format};
  else root.RoomName = {format};
})(typeof globalThis !== 'undefined' ? globalThis : this);
