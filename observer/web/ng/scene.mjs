import * as THREE from './vendor/three.js';
import { signalColor } from './model.mjs';

export class MediumScene {
  constructor(host, select) {
    this.host = host; this.select = select; this.rows = []; this.points = new Map(); this.edges = []; this.mode = 'medium'; this.dirty = true; this.animate = false;
    this.canvas = document.createElement('canvas'); this.canvas.setAttribute('aria-label', 'Interactive medium: drag to orbit, right-drag to pan, wheel to zoom. Use the radio table for keyboard navigation.'); this.canvas.tabIndex = 0;
    this.host.append(this.canvas);
    this.labels = document.createElement('div'); this.labels.className = 'scene-labels'; this.host.append(this.labels);
    this.notice = document.createElement('div'); this.notice.className = 'scene-notice'; this.host.append(this.notice);
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'low-power' });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#101d2d');
      this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000); this.camera.position.set(28, 38, 35);
      this.controls = new THREE.OrbitControls(this.camera, this.canvas); this.controls.enableDamping = false; this.controls.minDistance = 3; this.controls.maxDistance = 180;
      this.controls.addEventListener('change', () => { this.dirty = true; });
      this.grid = new THREE.GridHelper(60, 30, '#395265', '#243444'); this.scene.add(this.grid);
      this.markers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.32, 12, 8), new THREE.MeshBasicMaterial(), 1024);
      this.markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.markers.count = 0; this.scene.add(this.markers);
      this.tokens = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 6, 4), new THREE.MeshBasicMaterial({ color: '#eeeeff' }), 160);
      this.tokens.count = 0; this.scene.add(this.tokens);
      this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
      this.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.notice.textContent = 'WebGL context lost. Use the table or reload to restore 3D.'; this.lost = true; });
    } catch {
      this.renderer = null; this.canvas.remove(); this.canvas = document.createElement('canvas'); this.canvas.tabIndex = 0; this.host.prepend(this.canvas);
      this.context = this.canvas.getContext('2d'); this.notice.textContent = 'WebGL2 unavailable · accessible 2D medium view';
    }
    this.canvas.addEventListener('pointerdown', event => { this.start = [event.clientX, event.clientY]; });
    this.canvas.addEventListener('pointerup', event => {
      if (!this.start || Math.hypot(event.clientX - this.start[0], event.clientY - this.start[1]) > 5) return;
      const rect = this.canvas.getBoundingClientRect();
      if (this.renderer && this.mode !== 'matrix') {
        this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hit = this.raycaster.intersectObject(this.markers)[0]; if (hit) this.select(this.rows[hit.instanceId]);
      } else this.pick2D(event.clientX - rect.left, event.clientY - rect.top);
    });
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
    this.loop = time => {
      if (!document.hidden && !this.lost && (this.dirty || this.animate) && time - (this.lastFrame || 0) >= 33) { this.lastFrame = time; this.render(time); this.dirty = false; }
      this.frame = requestAnimationFrame(this.loop);
    };
    this.frame = requestAnimationFrame(this.loop);
  }
  resize() {
    this.width = Math.max(1, this.host.clientWidth); this.height = Math.max(1, this.host.clientHeight);
    if (this.renderer && this.mode !== 'matrix') { this.renderer.setSize(this.width, this.height, false); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix(); }
    else { this.canvas.width = this.width * devicePixelRatio; this.canvas.height = this.height * devicePixelRatio; }
    this.dirty = true;
  }
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'matrix' && this.renderer) {
      this.canvas.hidden = true; this.matrixCanvas = document.createElement('canvas'); this.matrixCanvas.tabIndex = 0; this.matrixCanvas.setAttribute('aria-label', 'Directed RF matrix; rows are sources, columns destinations. The table is the accessible equivalent.');
      this.host.prepend(this.matrixCanvas); this.matrixCanvas.addEventListener('click', event => { const rect = this.matrixCanvas.getBoundingClientRect(); this.pick2D(event.clientX - rect.left, event.clientY - rect.top); });
    } else { this.matrixCanvas?.remove(); this.matrixCanvas = null; this.canvas.hidden = false; }
    if (this.result) this.update(this.result, this.data, this.options);
    this.resize();
    this.fit();
  }
  update(result, data, options = {}) {
    this.result = result; this.data = data; this.options = options;
    this.rows = result.radios.slice(0, 1024); this.points.clear(); this.labels.replaceChildren();
    const mesh = this.rows.filter(row => !['wlan-client', 'iot-client'].includes(row.role));
    const clients = this.rows.filter(row => ['wlan-client', 'iot-client'].includes(row.role));
    const excluded = result.allRadios.filter(row => row.presence === 'room-excluded');
    const allCoordinates = result.allRadios.filter(row => row.position && row.presence === 'present').map(row => row.position);
    const center = allCoordinates.length ? [0, 1].map(axis => (Math.min(...allCoordinates.map(position => Number(position[axis]))) + Math.max(...allCoordinates.map(position => Number(position[axis])))) / 2) : [0, 0];
    const extent = allCoordinates.length ? Math.max(10, ...allCoordinates.flatMap(position => [Math.abs(Number(position[0]) - center[0]) * 2, Math.abs(Number(position[1]) - center[1]) * 2])) : 30;
    this.layoutCenter = center; this.layoutScale = 36 / extent;
    const matrix = new THREE.Matrix4();
    this.rows.forEach((row, index) => {
      const client = clients.includes(row), roleIndex = (client ? clients : mesh).indexOf(row);
      let horizontal, depth;
      if (this.mode === 'room' && row.presence === 'room-excluded') {
        const slot = excluded.indexOf(row); horizontal = 25 + slot % 10 * 2.8; depth = -12 + Math.floor(slot / 10) * 2.8;
      }
      else if (this.mode === 'room' && row.position) { horizontal = (Number(row.position[0]) - center[0]) * this.layoutScale; depth = (Number(row.position[1]) - center[1]) * this.layoutScale; }
      else if (client) { horizontal = (roleIndex % 12 - 5.5) * 3; depth = 7 + Math.floor(roleIndex / 12) * 2.4; }
      else { horizontal = (roleIndex - (mesh.length - 1) / 2) * 5; depth = -5; }
      const frequency = Number(options.frequency || (data.radio_frequencies || []).find(context => context.radio === row.mac)?.frequency_mhz || 0);
      const height = this.mode === 'medium' ? (frequency >= 5955 ? 6 : frequency >= 5000 ? 3 : 0.5) : 0.5;
      const position = new THREE.Vector3(horizontal, height, depth); this.points.set(row.mac, position);
      const color = row.presence === 'room-excluded' ? '#687584' : row.role === 'controller-agent' ? '#ef7675' : client ? (row.role === 'iot-client' ? '#bca2ed' : '#72c1dc') : '#ed9c62';
      row.sceneColor = color;
      if (this.renderer) { matrix.makeScale(client ? 1 : 1.5, client ? 1 : 1.5, client ? 1 : 1.5); matrix.setPosition(position); this.markers.setMatrixAt(index, matrix); this.markers.setColorAt(index, new THREE.Color(color)); }
      const label = document.createElement('button'); label.textContent = options.showMAC ? `${row.label} · ${row.mac}` : row.label; label.className = 'scene-label'; label.title = `${row.label} · ${row.presence}${this.mode === 'room' && row.presence === 'room-excluded' ? ' · parked outside room; not RF coordinates' : ''}`; label.addEventListener('click', () => this.select(row));
      this.labels.append(label); row.labelElement = label;
    });
    if (this.renderer) { this.markers.count = this.rows.length; this.markers.instanceMatrix.needsUpdate = true; if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true; this.markers.computeBoundingSphere(); }
    const selection = options.selection;
    const paths = result.paths.filter(row => this.points.has(row.source) && this.points.has(row.destination) && (!options.fanout ? !row.multicast : true));
    paths.sort((left, right) => Number(right.key === selection?.key || right.source === selection?.mac || right.destination === selection?.mac) - Number(left.key === selection?.key || left.source === selection?.mac || left.destination === selection?.mac) || (right.rate || 0) - (left.rate || 0));
    this.edges = paths.filter(row => options.allEdges || !selection && row.age != null && row.age <= 5 || row.key === selection?.key || row.source === selection?.mac || row.destination === selection?.mac).slice(0, options.allEdges || selection ? 200 : 40);
    this.animate = Boolean(options.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches && this.edges.some(row => row.rate > 0));
    this.makeLines();
    this.makeWalls();
    const baseNotice = this.mode === 'room' ? !result.roomValid ? 'Room overlay unavailable or from another daemon; using stable medium layout. ' : excluded.length ? 'Grey excluded pool is parked beside the room (display positions only). ' : '' : '';
    this.notice.textContent = `${baseNotice}${this.mode === 'matrix' ? 'Directed SNR: source ↓ · destination →. Grey is missing/stale, not zero.' : `${this.edges.length}/${paths.length} filtered paths drawn · ${options.fanout ? 'fan-out included' : 'fan-out hidden'} · particles illustrate measured rates, not individual packets`}`;
    this.dirty = true;
  }
  makeLines() {
    if (!this.renderer) return;
    if (this.lines) { this.scene.remove(this.lines); this.lines.geometry.dispose(); this.lines.material.dispose(); }
    const positions = [], colors = [];
    const segment = (start, end, color) => { positions.push(start.x, start.y, start.z, end.x, end.y, end.z); colors.push(color.r, color.g, color.b, color.r, color.g, color.b); };
    for (const edge of this.edges) {
      const start = this.points.get(edge.source), end = this.points.get(edge.destination), color = new THREE.Color(signalColor(edge.snr));
      const direction = end.clone().sub(start).normalize(), side = new THREE.Vector3(-direction.z, 0, direction.x).multiplyScalar(0.18);
      const source = start.clone().add(side), destination = end.clone().add(side);
      segment(source, destination, color);
      const tip = destination.clone().sub(direction.clone().multiplyScalar(0.5)), back = tip.clone().sub(direction.clone().multiplyScalar(0.65));
      segment(back.clone().add(side), tip, color); segment(back.clone().sub(side), tip, color);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.65 })); this.scene.add(this.lines);
  }
  makeWalls() {
    if (!this.renderer) return;
    const walls = this.mode === 'room' && this.result.roomValid ? this.data.room?.data?.layout?.walls || [] : [];
    const signature = JSON.stringify([walls, this.layoutCenter, this.layoutScale]);
    if (signature === this.wallSignature) return;
    this.wallSignature = signature;
    if (this.walls) { this.scene.remove(this.walls); this.walls.geometry.dispose(); this.walls.material.dispose(); }
    const positions = [];
    for (const wall of walls) {
      if (!Array.isArray(wall.start) || !Array.isArray(wall.end)) continue;
      const start = [(wall.start[0] - this.layoutCenter[0]) * this.layoutScale, (wall.start[1] - this.layoutCenter[1]) * this.layoutScale];
      const end = [(wall.end[0] - this.layoutCenter[0]) * this.layoutScale, (wall.end[1] - this.layoutCenter[1]) * this.layoutScale];
      positions.push(start[0], 0, start[1], end[0], 0, end[1], start[0], 1.4, start[1], end[0], 1.4, end[1], start[0], 0, start[1], start[0], 1.4, start[1], end[0], 0, end[1], end[0], 1.4, end[1]);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.walls = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#6d8699', transparent: true, opacity: 0.45, depthTest: false })); this.scene.add(this.walls);
  }
  fit() { if (this.renderer) { const bounds = new THREE.Box3(); for (const position of this.points.values()) bounds.expandByPoint(position); if (!bounds.isEmpty()) { const center = bounds.getCenter(new THREE.Vector3()); const size = bounds.getSize(new THREE.Vector3()).length(); this.controls.target.copy(center); this.camera.position.copy(center).add(new THREE.Vector3(0.45, 0.9, 1).normalize().multiplyScalar(Math.max(15, size * 1.3))); this.controls.update(); } } this.dirty = true; }
  render(time) {
    if (this.mode === 'matrix') { this.renderMatrix(); return; }
    if (!this.renderer) { this.render2D(); return; }
    const matrix = new THREE.Matrix4(); let tokenIndex = 0;
    if (this.animate) for (const edge of this.edges) {
      if (!(edge.rate > 0) || tokenIndex >= 160) continue;
      const phase = (time / (3500 / Math.max(1, Math.log10(edge.rate + 1))) + tokenIndex * 0.27) % 1;
      matrix.makeTranslation(...this.points.get(edge.source).clone().lerp(this.points.get(edge.destination), phase).toArray()); this.tokens.setMatrixAt(tokenIndex++, matrix);
    }
    this.tokens.count = tokenIndex; this.tokens.instanceMatrix.needsUpdate = true; this.tokens.computeBoundingSphere();
    this.renderer.render(this.scene, this.camera);
    const occupied = [];
    for (const row of this.rows) {
      const projected = this.points.get(row.mac).clone().project(this.camera), horizontal = (projected.x + 1) * this.width / 2, vertical = (-projected.y + 1) * this.height / 2;
      const label = row.labelElement, width = Math.max(52, row.label.length * 7);
      const overlap = occupied.some(box => Math.abs(box[0] - horizontal) < (box[2] + width) / 2 && Math.abs(box[1] - vertical) < 22);
      label.hidden = overlap || projected.z < -1 || projected.z > 1 || horizontal < 0 || horizontal > this.width || vertical < 0 || vertical > this.height;
      if (!label.hidden) { occupied.push([horizontal, vertical, width]); label.style.transform = `translate(${horizontal}px,${vertical + 8}px) translateX(-50%)`; }
    }
  }
  surface() {
    const canvas = this.matrixCanvas || this.canvas; canvas.width = this.width * devicePixelRatio; canvas.height = this.height * devicePixelRatio;
    const context = canvas.getContext('2d'); context.scale(devicePixelRatio, devicePixelRatio); context.fillStyle = '#101d2d'; context.fillRect(0, 0, this.width, this.height); return context;
  }
  renderMatrix() {
    this.labels.hidden = true; const context = this.surface(), count = this.rows.length;
    const margin = 90, cell = Math.max(1, Math.min((this.width - margin - 20) / Math.max(count, 1), (this.height - margin - 35) / Math.max(count, 1)));
    this.matrixGrid = { margin, cell, count };
    const index = new Map(this.rows.map((row, offset) => [row.mac, offset])); const chosen = new Map();
    for (const path of this.result.paths) { if (!index.has(path.source) || !index.has(path.destination)) continue; const key = `${path.source}>${path.destination}`; if (!chosen.has(key) || path.frequency_mhz) chosen.set(key, path); }
    this.matrixPaths = chosen;
    for (let row = 0; row < count; row++) for (let column = 0; column < count; column++) {
      const path = chosen.get(`${this.rows[row].mac}>${this.rows[column].mac}`);
      context.fillStyle = row === column ? '#101d2d' : signalColor(path?.snr); context.fillRect(margin + column * cell, margin + row * cell, Math.max(1, cell - 1), Math.max(1, cell - 1));
    }
    context.fillStyle = '#d4dfeb'; context.font = '11px system-ui';
    const step = Math.max(1, Math.ceil(14 / cell));
    this.rows.forEach((row, index) => { if (index % step) return; context.textAlign = 'right'; context.fillText(row.label, margin - 6, margin + index * cell + cell * 0.7); context.save(); context.translate(margin + index * cell + cell * 0.6, margin - 7); context.rotate(-Math.PI / 2); context.textAlign = 'left'; context.fillText(row.label, 0, 0); context.restore(); });
  }
  render2D() {
    this.labels.hidden = true; const context = this.surface(); this.flat = new Map();
    const values = [...this.points.values()]; if (!values.length) return;
    const bounds = new THREE.Box3().setFromPoints(values), span = bounds.getSize(new THREE.Vector3());
    const scale = Math.min((this.width - 90) / Math.max(1, span.x), (this.height - 80) / Math.max(1, span.z));
    for (const [key, point] of this.points) this.flat.set(key, [45 + (point.x - bounds.min.x) * scale, 30 + (point.z - bounds.min.z) * scale]);
    for (const edge of this.edges) { const source = this.flat.get(edge.source), destination = this.flat.get(edge.destination); context.strokeStyle = signalColor(edge.snr); context.beginPath(); context.moveTo(...source); context.lineTo(...destination); context.stroke(); }
    context.font = '12px system-ui'; context.textAlign = 'center';
    for (const row of this.rows) { const point = this.flat.get(row.mac); context.fillStyle = row.sceneColor; context.beginPath(); context.arc(...point, 5, 0, Math.PI * 2); context.fill(); context.fillStyle = '#d4dfeb'; context.fillText(row.label, point[0], point[1] + 20); }
  }
  pick2D(horizontal, vertical) {
    if (this.mode === 'matrix') { const grid = this.matrixGrid; if (!grid) return; const source = this.rows[Math.floor((vertical - grid.margin) / grid.cell)], destination = this.rows[Math.floor((horizontal - grid.margin) / grid.cell)]; if (source && destination) { const path = this.matrixPaths?.get(`${source.mac}>${destination.mac}`); if (path) this.select(path); } return; }
    for (const row of this.rows) { const point = this.flat?.get(row.mac); if (point && Math.hypot(point[0] - horizontal, point[1] - vertical) < 15) { this.select(row); return; } }
  }
  dispose() { cancelAnimationFrame(this.frame); this.resizeObserver.disconnect(); this.controls?.dispose(); for (const item of [this.markers, this.tokens, this.lines, this.walls, this.grid]) { item?.geometry.dispose(); item?.material.dispose(); } this.renderer?.dispose(); }
}
