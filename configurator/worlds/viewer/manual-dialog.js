(function () {
  'use strict';
  const dialog = document.getElementById('viewerManual');
  const opener = document.getElementById('openManual');
  const frame = document.getElementById('manualFrame');
  if (!dialog || !opener || !frame) return;
  opener.addEventListener('click', event => {
    if (typeof dialog.showModal !== 'function') return;
    event.preventDefault();
    if (!frame.getAttribute('src')) frame.src = opener.href;
    dialog.showModal();
  });
  document.getElementById('closeManual').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => opener.focus());
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
  frame.addEventListener('load', () => {
    frame.contentDocument.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dialog.close();
      }
    });
  });
}());
