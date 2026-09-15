(function (root) {
  'use strict';
  function attach({container, handle, property, storageKey, initial, minimum, maximum = 640, rightMinimum = 360, breakpoint = 760}) {
    if (!container || !handle) return null;
    let preferred = initial, pointer = null, pending = null, frame = null, applied = null;
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= minimum && saved <= maximum) preferred = saved;
    } catch (_) {}
    const limits = () => ({min: minimum, max: Math.max(minimum, Math.min(maximum, container.clientWidth - rightMinimum - 8))});
    const enabled = () => window.innerWidth > breakpoint && !document.fullscreenElement;
    const render = () => {
      frame = null;
      if (pending !== null) { preferred = pending; pending = null; }
      const range = limits();
      const width = Math.round(Math.max(range.min, Math.min(range.max, preferred)));
      if (applied !== width) { container.style.setProperty(property, width + 'px'); applied = width; }
      handle.setAttribute('aria-valuemin', String(range.min));
      handle.setAttribute('aria-valuemax', String(range.max));
      handle.setAttribute('aria-valuenow', String(width));
      handle.setAttribute('aria-valuetext', width + ' pixels for the left panel');
    };
    const schedule = width => {
      if (width !== undefined) pending = Math.max(limits().min, Math.min(limits().max, width));
      if (frame === null) frame = requestAnimationFrame(render);
    };
    const save = () => { try { localStorage.setItem(storageKey, String(preferred)); } catch (_) {} };
    const finish = event => {
      if (pointer === null || event && event.pointerId !== pointer) return;
      if (frame !== null) cancelAnimationFrame(frame);
      render();
      const captured = pointer;
      pointer = null;
      if (handle.hasPointerCapture(captured)) handle.releasePointerCapture(captured);
      document.documentElement.classList.remove('pane-resizing');
      save();
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !enabled()) return;
      event.preventDefault();
      handle.focus();
      pointer = event.pointerId;
      handle.setPointerCapture(pointer);
      document.documentElement.classList.add('pane-resizing');
    });
    handle.addEventListener('pointermove', event => {
      if (event.pointerId === pointer) schedule(event.clientX - container.getBoundingClientRect().left - 4);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
    handle.addEventListener('keydown', event => {
      if (!enabled() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 50 : 10;
      const width = event.key === 'Home' ? limits().min : event.key === 'End' ? limits().max :
        applied + (event.key === 'ArrowLeft' ? -step : step);
      pending = Math.max(limits().min, Math.min(limits().max, width));
      if (frame !== null) cancelAnimationFrame(frame);
      render();
      save();
    });
    handle.addEventListener('dblclick', () => {
      if (!enabled()) return;
      if (frame !== null) cancelAnimationFrame(frame);
      preferred = initial;
      pending = null;
      render();
      save();
    });
    const resized = () => { if (!enabled()) finish(); schedule(); };
    const observer = new ResizeObserver(resized);
    observer.observe(container);
    window.addEventListener('resize', resized);
    document.addEventListener('fullscreenchange', resized);
    render();
    return {close() {
      finish();
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', resized);
      document.removeEventListener('fullscreenchange', resized);
    }};
  }
  root.PaneDivider = {attach};
})(typeof globalThis !== 'undefined' ? globalThis : this);
