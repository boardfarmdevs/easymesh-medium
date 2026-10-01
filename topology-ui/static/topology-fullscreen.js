EasyMeshFullscreen.attach({
  target: document.getElementById('topology'),
  button: document.getElementById('topologyFullscreen'),
  status: document.getElementById('topologyFullscreenStatus'),
  onChange: () => window.dispatchEvent(new Event('resize')),
});
