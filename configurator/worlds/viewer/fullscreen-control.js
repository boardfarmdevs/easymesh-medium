(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EasyMeshFullscreen = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function attach({target, button, status, onChange = () => {}}) {
    const document = target.ownerDocument;
    const supported = typeof target.requestFullscreen === 'function'
      && typeof document.exitFullscreen === 'function' && document.fullscreenEnabled !== false;
    let pending = false;
    let wasActive = false;
    function sync() {
      const active = document.fullscreenElement === target;
      button.textContent = active ? 'Exit full screen' : 'Full screen';
      button.setAttribute('aria-pressed', String(active));
      button.title = supported ? 'Full screen · Esc to exit'
        : 'Full screen is unavailable. Embedded viewers need allowfullscreen.';
      button.disabled = !supported || pending;
      if (wasActive && !active) button.focus({preventScroll: true});
      wasActive = active;
      onChange(active);
    }
    async function toggle() {
      if (!supported || pending) return;
      pending = true;
      status.textContent = '';
      sync();
      try {
        if (document.fullscreenElement === target) await document.exitFullscreen();
        else await target.requestFullscreen();
      } catch (error) {
        status.textContent = 'Could not change full screen: ' + error.message;
      } finally {
        pending = false;
        sync();
      }
    }
    button.addEventListener('click', toggle);
    document.addEventListener('fullscreenchange', sync);
    sync();
    return {toggle, destroy() {
      button.removeEventListener('click', toggle);
      document.removeEventListener('fullscreenchange', sync);
    }};
  }
  return {attach};
});
