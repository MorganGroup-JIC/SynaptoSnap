/* SynaptoSnap — application core: state, worker, loading, layers, views, rendering loop. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

class WorkerHost {
  constructor() { this.pending = new Map(); this.seq = 0; this._spawn(); }
  _spawn() {
    const src = [FzstdFactory, CZIFactory, ProcFactory, TracingFactory, WorkerMain].map((f) => f.toString()).join('\n') +
      '\nconst fzstd = FzstdFactory(); const CZI = CZIFactory(fzstd); const Proc = ProcFactory();' +
      '\nconst Tracing = TracingFactory(Proc); Object.assign(Proc.OPS, Tracing.OPS); WorkerMain();';
    this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    this.w = new Worker(this.url);
    this.w.onmessage = (e) => {
      const m = e.data, p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.frac, m.msg); return; }
      this.pending.delete(m.id);
      if (m.type === 'done') p.resolve(m.result); else p.reject(new Error(m.message));
    };
    this.w.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error('Processing worker failed: ' + (e.message || 'out of memory?')));
      this.pending.clear();
    };
  }
  get busy() { return this.pending.size > 0; }
  call(cmd, args, transfer, onProgress) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, onProgress });
      this.w.postMessage({ id, cmd, args }, transfer || []);
    });
  }
  cancel() {
    this.w.terminate();
    URL.revokeObjectURL(this.url);
    for (const p of this.pending.values()) { const e = new Error('Cancelled'); e.cancelled = true; p.reject(e); }
    this.pending.clear();
    this._spawn();
  }
}

const dtypeOf = (a) => (a instanceof Uint8Array ? 'uint8' : a instanceof Uint16Array ? 'uint16' : a instanceof Uint32Array ? 'uint32' : 'float32');
const fmtNum = (v) => {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
  if (Number.isInteger(v)) return String(v);
  return a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toPrecision(3);
};
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' kB');

class App {
  constructor() {
    this.proc = ProcFactory();
    this.tracer = TracingFactory(this.proc);
    Object.assign(this.proc.OPS, this.tracer.OPS);
    this.czi = CZIFactory(FzstdFactory());
    this.worker = new WorkerHost();
    this.layers = [];
    this.selectedId = null;
    this.nextId = 1;
    this.dims = null;
    this.spacing = [1, 1, 1];
    this.meta = { scaling: {}, channels: [], info: {} };
    this.cursor = [0, 0, 0];
    this.displayVersion = 0;
    this.selectedLabel = 0;
    this.points = null;
    this.table = null;
    this.view = '3d';
    this.tool = null;
    this.profileLine = null;
    this.showCrosshair = true;
    this.showScaleBar = true;
    this.bgColor = '#000000';
    this.history = [];
    this.preview = null;
    this.rs = {
      mode: 'mip', quality: 1, density: 1, attenuation: 2, ortho: true, showBox: true, showAxes: true, showScale: true,
      budget: 'auto', box: [0, 0, 0, 1, 1, 1], plane: { on: false, axis: 'z', pos: 0.5, flip: false }, autoRotate: false, rotSpeed: 24,
    };
    this.renderer = null;
    try {
      this.renderer = new VolumeRenderer($('#gl'), $('#overlay'));
    } catch (e) {
      $('#v3d').insertAdjacentHTML('beforeend', `<div class="gl-error">${e.message}</div>`);
    }
    this.sliceViews = {
      xy: new SliceView(this, $('#vxy'), 'xy'),
      xz: new SliceView(this, $('#vxz'), 'xz'),
      yz: new SliceView(this, $('#vyz'), 'yz'),
    };
    new ResizeObserver(() => this.resize3D()).observe($('#v3d'));
    this.ui = new UI(this);
    this._events3D();
    this._globalEvents();
    this.setView('3d');
    this.status('Open a .czi file (button, drag & drop, or Ctrl+O) — or load the demo volume.');
  }

  // ------------------------------------------------------------- status
  status(msg) { $('#statusMsg').textContent = msg; }
  toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show ' + (kind || '');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.className = ''; }, kind === 'error' ? 7000 : 3500);
  }
  error(msg) { this.toast(msg, 'error'); this.status('⚠ ' + msg); console.error(msg); }
  busy(on, msg) {
    document.body.classList.toggle('busy', !!on);
    $('#prog').style.visibility = on ? 'visible' : 'hidden';
    $('#btnCancel').style.display = on ? '' : 'none';
    $('#progBar').style.width = '0%';
    if (msg) this.status(msg);
  }
  progress(f, msg) {
    $('#progBar').style.width = Math.round(f * 100) + '%';
    if (msg) this.status(msg + ' — ' + Math.round(f * 100) + '%');
  }
  async task(msg, fn) {
    if (this.worker.busy) { this.toast('Another operation is still running'); return null; }
    this.busy(true, msg);
    const t0 = performance.now();
    try {
      const r = await fn((f, m) => this.progress(f, m || msg));
      this.lastTaskTime = (performance.now() - t0) / 1000;
      return r;
    } catch (e) {
      if (e.cancelled) this.status('Cancelled.');
      else this.error(e.message || String(e));
      return null;
    } finally { this.busy(false); }
  }

  // ------------------------------------------------------------- loading
  async openFile(file) {
    if (!file) return;
    if (/\.traces$/i.test(file.name)) return this.importTraces(file);
    const r = await this.task('Reading ' + file.name + '…', async () => {
      const info = await this.worker.call('czi.open', { file });
      return info;
    });
    if (!r) return;
    const meta = this.czi.parseMetadata(r.xml);
    const sel = await this.ui.loadDialog(r.summary, meta, file);
    if (!sel) { this.status('Loading cancelled.'); return; }
    const res = await this.task('Decoding image data…', (p) => this.worker.call('czi.load', { sel }, [], p));
    if (!res) return;
    const sc = meta.scaling;
    let sx = sc.x, sy = sc.y || sc.x, sz = sc.z;
    const noScale = !sx;
    if (!sx) { sx = sy = 1; }
    if (!sz) sz = sx;
    sx *= res.bin; sy *= res.bin;
    const comps = { R: '#ff0000', G: '#00ff00', B: '#0000ff' };
    const chans = res.channels.map((ch, k) => {
      const mc = meta.channels[ch.c] || meta.channels[k] || {};
      return {
        data: ch.data, dtype: ch.dtype,
        name: (mc.name || ('Channel ' + (ch.c + 1))) + (ch.comp ? ' ' + ch.comp : ''),
        color: ch.comp ? comps[ch.comp] : mc.color,
        source: { c: ch.c, comp: ch.comp, meta: mc },
      };
    });
    const parts = [];
    if (r.summary.dims.S && r.summary.dims.S.length > 1) parts.push('scene ' + sel.scene);
    if (r.summary.dims.T && r.summary.dims.T.length > 1) parts.push('t ' + sel.t);
    this.setVolume({
      name: file.name.replace(/\.czi$/i, '') + (parts.length ? ' (' + parts.join(', ') + ')' : ''),
      fileName: file.name, dims: [res.width, res.height, res.depth], spacing: [sx, sy, sz],
      meta, xml: r.xml, summary: r.summary, channels: chans, bin: res.bin, selection: sel,
    });
    this.status(`Loaded ${file.name}: ${res.width}×${res.height}×${res.depth}, ${chans.length} channel(s) in ${this.lastTaskTime.toFixed(1)} s` + (noScale ? ' — no voxel size in metadata, assuming 1 µm (edit under File info).' : ''));
    if (noScale) this.toast('No voxel size found in the metadata — set it under File info.', 'warn');
  }

  setVolume(v) {
    if (this.renderer) this.renderer.clear();
    this.layers = [];
    this.selectedId = null;
    this.points = null;
    this.table = null;
    this.trace = null;
    if (this.tool === 'trace') this.tool = null;
    if (this.ui.traceProjAuto) { this.ui.traceProjAuto = false; this.projectXY = false; $('#projXY').checked = false; } // Edit mode's max projection
    this.selectedLabel = 0;
    this.profileLine = null;
    this.history = [];
    this.vol = v;
    this.meta = v.meta || { scaling: {}, channels: [], info: {} };
    this.dims = v.dims.slice();
    this.spacing = v.spacing.slice();
    this.rs.box = [0, 0, 0, 1, 1, 1];
    this.rs.plane.on = false;
    if (this.renderer) { this.renderer.setGeometry(this.dims, this.spacing); this.renderer.camera.reset(this.dims[2] > 1 ? 'oblique' : 'xy'); }
    this.cursor = this.dims.map((d) => Math.floor(d / 2));
    const single = v.channels.length === 1;
    for (let i = v.channels.length - 1; i >= 0; i--) {
      const ch = v.channels[i];
      this.addLayer({
        name: ch.name, kind: 'intensity', data: ch.data, dtype: ch.dtype, source: ch.source,
        disp: { color: ch.color || Colormaps.DEFAULT_COLORS[i % Colormaps.DEFAULT_COLORS.length], cmap: single && !ch.color ? 'gray' : 'custom' },
        history: ['Loaded from ' + (v.fileName || v.name)], silent: true,
      });
    }
    this.selectedId = this.layers.length ? this.layers[0].id : null;
    document.body.classList.add('has-data');
    $('#fileLabel').textContent = v.name;
    document.title = v.name + ' — SynaptoSnap';
    Object.values(this.sliceViews).forEach((s) => { s.zoom = 0; s.offKey = ''; });
    this.layoutViews();
    this.layersChanged();
    this.ui.volumeChanged();
    this.log('Opened ' + (v.fileName || v.name) + ` (${this.dims.join('×')}, voxel ${this.spacing.map((s) => s.toPrecision(3)).join('×')} µm)`);
  }

  setSpacing(sp) {
    this.spacing = sp.slice();
    if (this.renderer) this.renderer.setGeometry(this.dims, this.spacing);
    Object.values(this.sliceViews).forEach((s) => { s.zoom = 0; });
    this.layoutViews();
    this.ui.volumeChanged();
    this.requestRender();
  }

  // ------------------------------------------------------------- layers
  computeHist(L) {
    const a = L.data, n = a.length, [lo, hi] = L.range;
    const NB = 1024, h = new Float64Array(NB);
    const span = hi - lo || 1, sc = NB / span;
    const step = Math.max(1, Math.floor(n / 8e6));
    for (let i = 0; i < n; i += step) {
      let b = ((a[i] - lo) * sc) | 0;
      if (b >= NB) b = NB - 1; else if (b < 0) b = 0;
      h[b]++;
    }
    return { h, lo, hi, bw: span / NB, total: Math.ceil(n / step) };
  }
  layerPct(L, p) {
    const H = L.hist, target = H.total * p / 100;
    let c = 0;
    for (let i = 0; i < H.h.length; i++) { c += H.h[i]; if (c >= target) return H.lo + (i + 0.5) * H.bw; }
    return H.hi;
  }

  addLayer(o) {
    const data = o.data;
    const L = {
      id: this.nextId++, name: o.name || 'Layer', kind: o.kind || 'intensity', data, dtype: o.dtype || dtypeOf(data),
      range: o.range || this.proc.minmax(data), history: o.history || [], source: o.source || null, version: 0,
    };
    if (L.kind === 'mask') L.range = [0, 1];
    L.hist = this.computeHist(L);
    L.pct = (p) => this.layerPct(L, p);
    const given = o.disp || {};
    if (L.kind === 'intensity') {
      let lo = L.pct(0.05), hi = L.pct(99.95);
      if (!(hi > lo)) { lo = L.range[0]; hi = L.range[1]; }
      if (!(hi > lo)) hi = lo + 1;
      L.disp = {
        visible: given.visible !== false, cmap: given.cmap || 'custom', color: given.color || this.nextColor(), lo, hi,
        gamma: 1, opacity: 1, iso: lo + 0.35 * (hi - lo),
      };
    } else if (L.kind === 'mask') {
      const maskColors = ['#ff5a5a', '#ffd166', '#5ec8f0', '#c792ea', '#7bd88f'];
      L.disp = { visible: true, cmap: 'custom', color: given.color || maskColors[this.layers.filter((q) => q.kind === 'mask').length % maskColors.length], lo: 0, hi: 1, gamma: 1, opacity: 0.55, iso: 0.5 };
    } else {
      L.disp = { visible: true, opacity: 0.75, outline: false, onlySelected: false, lo: 0, hi: L.range[1], gamma: 1 };
      // only one labels layer is shown in 3D: hide older ones
      this.layers.forEach((q) => { if (q.kind === 'labels') q.disp.visible = false; });
    }
    this.layers.unshift(L);
    this.upload(L);
    if (!o.silent) { this.selectedId = L.id; this.layersChanged(); }
    return L;
  }
  nextColor() {
    const used = new Set(this.layers.map((l) => l.disp && l.disp.color));
    return Colormaps.DEFAULT_COLORS.find((c) => !used.has(c)) || Colormaps.DEFAULT_COLORS[this.layers.length % Colormaps.DEFAULT_COLORS.length];
  }
  budgetVoxels() { return { auto: 96e6, full: 4e9, fast: 12e6 }[this.rs.budget] || 96e6; }
  upload(L) {
    if (!this.renderer) return;
    try { L.gpu = this.renderer.uploadLayer(L, this.budgetVoxels()); }
    catch (e) { this.error('GPU upload failed for ' + L.name + ': ' + e.message); }
  }
  reuploadAll() { this.layers.forEach((L) => this.upload(L)); this.ui.renderTab && this.ui.refreshRenderInfo(); this.requestRender('3d'); }
  layer(id) { return this.layers.find((l) => l.id === id) || null; }
  get selected() { return this.layer(this.selectedId); }
  removeLayer(id) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    if (this.renderer) this.renderer.deleteLayer(id);
    this.layers.splice(i, 1);
    if (this.selectedId === id) this.selectedId = this.layers.length ? this.layers[Math.min(i, this.layers.length - 1)].id : null;
    this.layersChanged();
  }
  moveLayer(id, dir) {
    const i = this.layers.findIndex((l) => l.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= this.layers.length) return;
    [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
    this.layersChanged();
  }
  layersChanged() {
    this.displayVersion++;
    this.ui.refreshLayers();
    this.ui.refreshMemory();
    this.requestRender();
  }
  displayChanged(L, opts = {}) {
    if (L) L.version++;
    this.displayVersion++;
    if (!opts.skipList) this.ui.refreshLayerRow(L);
    this.requestRender();
  }

  // ------------------------------------------------------------- views
  setView(v) {
    this.view = v;
    document.body.dataset.view = v;
    $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    this.layoutViews();
    this.requestRender();
  }
  layoutViews() {
    const g = $('#views');
    if (this.view === 'ortho' && this.dims) {
      const [W, H, D] = this.dims, [sx, sy, sz] = this.spacing;
      const a = W * sx, b = Math.max(D * sz, 1e-9), c = H * sy;
      const clamp = (f) => Math.min(0.72, Math.max(0.28, f));
      const fc = clamp(a / (a + b)), fr = clamp(c / (c + b));
      g.style.gridTemplateColumns = `${fc}fr ${1 - fc}fr`;
      g.style.gridTemplateRows = `${fr}fr ${1 - fr}fr`;
    } else { g.style.gridTemplateColumns = ''; g.style.gridTemplateRows = ''; }
    // reading clientWidth forces layout, so the new sizes are available immediately
    Object.values(this.sliceViews).forEach((s) => { s.zoom = 0; s.resize(); });
    this.resize3D();
  }
  resize3D() {
    if (!this.renderer) return;
    const host = $('#v3d'), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    for (const c of [$('#gl'), $('#overlay')]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    this.requestRender('3d');
  }
  show3D() { return this.view === '3d' || this.view === 'ortho'; }

  requestRender(what = 'all') {
    if (what === 'all' || what === '3d') this.dirty3D = true;
    if (what === 'all' || what === '2d') this.dirty2D = true;
    if (!this.raf) this.raf = requestAnimationFrame((t) => this._frame(t));
  }
  _frame(t) {
    this.raf = 0;
    if (this.rs.autoRotate && this.show3D() && this.renderer && this.dims) {
      const dt = this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 0;
      this.renderer.camera.rotate(dt * this.rs.rotSpeed * Math.PI / 180, 0);
      this.dirty3D = true;
      this.lastT = t;
      this.raf = requestAnimationFrame((tt) => this._frame(tt));
    } else this.lastT = 0;
    if (this.dirty3D && this.show3D()) { this.dirty3D = false; this.draw3D(); }
    if (this.dirty2D) {
      this.dirty2D = false;
      if (this.view === 'xy') this.sliceViews.xy.draw();
      if (this.view === 'ortho') Object.values(this.sliceViews).forEach((s) => s.draw());
      this.ui.syncZSlider();
    }
  }
  planeUniform() {
    const p = this.rs.plane;
    if (!p.on) return { on: false };
    if (p.axis === 'view') {
      const R = this.renderer.camera.R, ext = this.renderer.extent;
      const nw = R[2].map((v) => -v), n = nw.map((v, k) => v * ext[k]);
      const d = (p.pos - 0.5) * 1.8 * (p.flip ? -1 : 1);
      const sgn = p.flip ? -1 : 1;
      const nt = n.map((v) => v * sgn);
      return { on: true, normal: nt, offset: -(nt[0] * 0.5 + nt[1] * 0.5 + nt[2] * 0.5) - d * sgn };
    }
    const k = { x: 0, y: 1, z: 2 }[p.axis];
    const n = [0, 0, 0];
    n[k] = p.flip ? -1 : 1;
    return { on: true, normal: n, offset: p.flip ? p.pos : -p.pos };
  }
  render3DState(interactive) {
    const vis = this.layers.filter((L) => L.disp.visible && (L.kind === 'intensity' || L.kind === 'mask'));
    const lab = this.layers.find((L) => L.disp.visible && L.kind === 'labels');
    const big = this.dims && this.dims[0] * this.dims[1] * this.dims[2] > 40e6;
    return {
      layers: vis.slice(0, 6).map((L) => ({
        id: L.id, clim: [L.disp.lo, L.disp.hi], gamma: L.disp.gamma, opacity: L.disp.opacity, iso: L.disp.iso,
        lut: L.kind === 'mask' ? Colormaps.lut('custom', L.disp.color) : Colormaps.lut(L.disp.cmap, L.disp.color),
      })),
      labels: lab ? { id: lab.id, opacity: lab.disp.opacity, selected: this.selectedLabel, onlySelected: lab.disp.onlySelected, hide: this.traceHideMask ? this.traceHideMask(lab) : 0 } : null,
      mode: this.rs.mode, quality: interactive ? this.rs.quality * 0.6 : this.rs.quality, density: this.rs.density, attenuation: this.rs.attenuation,
      bg: Colormaps.hexToRgb(this.bgColor), box: this.rs.box, plane: this.planeUniform(), scale: interactive ? (big ? 0.5 : 0.7) : 1,
    };
  }
  draw3D() {
    const r = this.renderer;
    if (!r) return;
    if (!this.dims) { const gl = r.gl; gl.clearColor(0.06, 0.07, 0.09, 1); gl.clear(gl.COLOR_BUFFER_BIT); r.octx.clearRect(0, 0, r.overlay.width, r.overlay.height); return; }
    r.ortho = this.rs.ortho;
    try {
      r.render(this.render3DState(this.interacting));
    } catch (e) { this.error(e.message); return; }
    r.drawOverlay({
      box: this.rs.box, plane: this.planeUniform(), showBox: this.rs.showBox, showAxes: this.rs.showAxes, showScale: this.rs.showScale,
      boxColor: this.bgColor === '#ffffff' ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)',
      points: this.points ? { visible: this.points.visible, list: this.points.list, color: this.points.color, size: this.points.size } : null,
      lines: this.traceLines ? this.traceLines() : null, ends: this.traceEnds ? this.traceEnds() : null,
    });
    const nVis = this.layers.filter((L) => L.disp.visible && (L.kind === 'intensity' || L.kind === 'mask')).length;
    $('#v3dBadge').textContent = '3D · ' + { mip: 'MIP', amip: 'Attenuated MIP', dvr: 'Translucent', iso: 'Iso-surface', minip: 'MinIP', avg: 'Average' }[this.rs.mode] + (nVis > 6 ? ' · showing first 6 visible layers' : '');
  }

  _events3D() {
    const el = $('#overlay');
    let drag = null;
    const kick = () => {
      this.interacting = true;
      clearTimeout(this._idleT);
      this._idleT = setTimeout(() => { this.interacting = false; this.requestRender('3d'); }, 160);
      this.requestRender('3d');
    };
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (!this.renderer) return;
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or lost pointer */ }
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false, button: e.button, mode: e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : e.altKey ? 'roll' : 'rotate' };
      this.rs.autoRotate = false; this.ui.syncAutoRotate && this.ui.syncAutoRotate();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 3) drag.moved = true;
      if (!drag.moved) return;
      const cam = this.renderer.camera, h = el.clientHeight || 1;
      if (drag.mode === 'rotate') cam.rotate(dx * 0.008, dy * 0.008);
      else if (drag.mode === 'roll') cam.roll(dx * 0.008);
      else cam.pan(dx / h, dy / h, cam.viewHeight());
      kick();
    });
    const up = (e) => {
      const d = drag;
      drag = null;
      if (!d || d.moved || d.button !== 0 || this.tool !== 'trace' || !this.trace || !this.renderer) return;
      const r = el.getBoundingClientRect(), R = this.renderer, M = R.lastMatrices || R.matrices();
      const [W3, H3, D3] = this.dims, [sx, sy, sz] = this.spacing, b = this.rs.box;
      const proj = (p) => {
        const t = [(p[0] / sx + 0.5) / W3, (p[1] / sy + 0.5) / H3, (p[2] / sz + 0.5) / D3];
        if (t[0] < b[0] || t[0] > b[3] || t[1] < b[1] || t[1] > b[4] || t[2] < b[2] || t[2] > b[5]) return null;
        return R.project(t, M);
      };
      this.traceClick(this.traceHit(proj, e.clientX - r.left, e.clientY - r.top), e);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.renderer) return;
      const cam = this.renderer.camera;
      cam.dist = Math.min(20, Math.max(0.05, cam.dist * Math.exp(e.deltaY * 0.0012)));
      kick();
    }, { passive: false });
    el.addEventListener('dblclick', () => { if (this.renderer) { this.renderer.camera.reset(this.dims && this.dims[2] > 1 ? 'oblique' : 'xy'); this.requestRender('3d'); } });
  }

  _globalEvents() {
    const vp = $('#viewport');
    ['dragenter', 'dragover'].forEach((t) => vp.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((t) => vp.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === vp) document.body.classList.remove('dragging'); }));
    vp.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.openFile(f);
    });
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#fileInput').click(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); this.ui.showTab('export'); return; }
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'Escape') {
        if (this.tool === 'trace' && this.trace) {
          const t = this.trace;
          // first Esc drops a half-made route/link/stroke (or the selection in Select mode); the next leaves Edit mode.
          // It never cancels an automatic trace running in the background while you edit.
          if (t.anchor != null || t.linkFrom || t.tip || this.traceStroke || (t.sel && t.clickMode === 'select')) { t.anchor = null; t.linkFrom = null; t.tip = null; t.sel = null; this.traceStroke = null; this.traceHoverAt = null; this.ui.refreshTrace(); this.requestRender(); return; }
          this.ui.closeModal(); this.ui.toggleTraceEdit(); return;
        }
        if (this.trace && this.trace.sel && !this.worker.busy) { this.traceUnselect(); return; } // a segment picked from the trace table to look at
        if (this.selectedLabel && !this.worker.busy) { // Esc clears a highlighted label first
          this.selectedLabel = 0; if (this.ui.labelSelected) this.ui.labelSelected(0); if (this.trace) this.ui.refreshTrace(); this.requestRender(); return;
        }
        if (this.worker.busy) this.cancelTask(); this.ui.closeModal(); this.tool = null; this.ui.syncTool && this.ui.syncTool();
      }
      if (!this.dims) return;
      const k = e.key;
      if (this.tool === 'trace' && this.trace) {
        const m = /^Digit(\d)$/.exec(e.code) || /^Numpad(\d)$/.exec(e.code);
        if (m) { e.preventDefault(); this.traceDigit(+m[1], e.shiftKey); return; }
        if (k === 'Backspace' && this.trace.tip) { e.preventDefault(); if (this.trace.tip.kind === 'node') this.traceUndo(); else this.traceFinish(); return; } // while tracing: take back the last stretch (or the start point)
        if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); this.traceDigit(-1); return; } // Select mode: delete the selection; otherwise pick the Erase tool
        if (k === 'b' || k === 'B') { this.traceToggleBridge(); return; }
        if (k === 'Enter' && this.trace.tip) { e.preventDefault(); this.traceFinish(); return; } // finish the trace being drawn
        if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); this.traceUndo(); return; }
      }
      if (k === '1') this.setView('3d');
      else if (k === '2') this.setView('xy');
      else if (k === '3') this.setView('ortho');
      else if (k === 'r' || k === 'R') { this.renderer && this.renderer.camera.reset(this.dims[2] > 1 ? 'oblique' : 'xy'); this.requestRender('3d'); }
      else if (k === ' ') { e.preventDefault(); this.rs.autoRotate = !this.rs.autoRotate; this.ui.syncAutoRotate(); this.requestRender('3d'); }
      else if (k === 'ArrowUp' || k === 'PageUp' || k === 'ArrowDown' || k === 'PageDown') {
        e.preventDefault();
        const d = (k === 'ArrowUp' || k === 'PageUp' ? -1 : 1) * (k.startsWith('Page') || e.shiftKey ? 10 : 1);
        this.cursor[2] = clampInt(this.cursor[2] + d, 0, this.dims[2] - 1);
        this.cursorChanged();
      } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        const L = this.selected;
        if (L) { L.disp.visible = !L.disp.visible; this.displayChanged(L); }
      } else if (k === 'h' || k === 'H') this.ui.toggleHelp();
      else if ((k === 't' || k === 'T') && this.trace && !e.ctrlKey && !e.metaKey && !e.altKey) this.traceToggleVisible();
      else if ((k === '[' || k === ']') && this.trace) this.traceStepSegment(k === ']' ? 1 : -1); // previous / next segment along the chromosome (Segs dropdown)
      else if (k === 'Delete' && this.selected && e.shiftKey) this.removeLayer(this.selectedId);
    });
    window.addEventListener('beforeunload', (e) => { if (this.history.length > 1) { e.preventDefault(); e.returnValue = ''; } });
  }
  cancelTask() { this.worker.cancel(); this.busy(false); this.status('Cancelled.'); }

  // ------------------------------------------------------------- cursor / hover
  setCursor(v, fromClick) {
    if (!this.dims) return;
    this.cursor = v.map((x, i) => clampInt(x, 0, this.dims[i] - 1));
    if (fromClick) {
      const lab = this.layers.find((L) => L.disp.visible && L.kind === 'labels');
      if (lab) {
        const [W, H] = this.dims;
        const id = lab.data[(this.cursor[2] * H + this.cursor[1]) * W + this.cursor[0]];
        if (id !== this.selectedLabel) { this.selectedLabel = id; this.ui.labelSelected(id); this.requestRender('3d'); }
      }
    }
    this.cursorChanged();
  }
  cursorChanged() { this.requestRender('2d'); }
  selectLabel(id, jump) {
    this.selectedLabel = id;
    if (jump && this.table) {
      const row = this.table.rows.find((r) => r.label === id);
      if (row) this.cursor = [row.cx / this.spacing[0], row.cy / this.spacing[1], row.cz / this.spacing[2]].map((v, i) => clampInt(v, 0, this.dims[i] - 1));
    }
    this.requestRender();
  }
  hover(v) {
    const el = $('#hoverInfo');
    if (!v || !this.dims) { el.textContent = ''; return; }
    const [W, H, D] = this.dims;
    if (v[0] < 0 || v[1] < 0 || v[2] < 0 || v[0] >= W || v[1] >= H || v[2] >= D) { el.textContent = ''; return; }
    const i = (v[2] * H + v[1]) * W + v[0];
    const [sx, sy, sz] = this.spacing;
    const vals = this.layers.filter((L) => L.disp.visible).slice(0, 5).map((L) => {
      const x = L.data[i];
      return `${L.name.length > 14 ? L.name.slice(0, 13) + '…' : L.name}: ${L.kind === 'labels' ? (x ? '#' + x : '–') : fmtNum(x)}`;
    });
    el.textContent = `x ${v[0]}  y ${v[1]}  z ${v[2]}  (${(v[0] * sx).toFixed(2)}, ${(v[1] * sy).toFixed(2)}, ${(v[2] * sz).toFixed(2)} µm)   ${vals.join('  ·  ')}`;
  }

  previewState() {
    const p = this.preview;
    if (!p || !p.layer || !this.layers.includes(p.layer)) return null;
    return Object.assign({ key: [p.layer.id, p.value, p.low, p.high, p.invert].join('|') }, p);
  }
  setPreview(p) { this.preview = p; this.requestRender('2d'); }

  // ------------------------------------------------------------- processing
  log(msg) {
    this.history.push({ time: new Date(), msg });
    this.ui.refreshHistory && this.ui.refreshHistory();
  }
  describeParams(def, params) {
    return def.params.filter((p) => !p.show || p.show(params)).map((p) => {
      const v = params[p.k];
      const opt = p.options && p.options.find((o) => o[0] === v);
      return `${p.label.replace(/ \(.*\)/, '')}=${opt ? opt[1] : v}${/µm\)/.test(p.label) ? ' µm' : ''}`;
    }).join(', ');
  }
  async runOp(def, inputs, params) {
    if (!this.dims) return null;
    const args = { op: def.id, inputs: inputs.map((L) => (L ? { data: L.data, kind: L.kind, dtype: L.dtype } : null)).filter(Boolean), dims: this.dims, spacing: this.spacing, params };
    const res = await this.task(def.name + '…', (p) => this.worker.call('op', args, [], p));
    if (!res) return null;
    const desc = def.name + (def.params.length ? ' (' + this.describeParams(def, params) + ')' : '');
    const src = inputs[0];
    let last = null;
    for (const out of res.layers) {
      const short = out.name || (def.short ? def.short(params) : def.name);
      const inherit = out.kind === 'intensity' && src && src.kind === 'intensity' ? { cmap: src.disp.cmap, color: src.disp.color } : {};
      last = this.addLayer({
        name: short + ' · ' + (src ? src.name.replace(/^.* · /, '') : ''), kind: out.kind, data: out.data, dtype: out.dtype, range: out.range,
        history: [...(src ? src.history : []), desc], source: src ? src.source : null, disp: inherit,
      });
    }
    const t = this.lastTaskTime ? ` in ${this.lastTaskTime.toFixed(1)} s` : '';
    this.log(desc + (inputs.length ? ' on "' + inputs.filter(Boolean).map((l) => l.name).join('", "') + '"' : '') + (res.info ? ' → ' + res.info : ''));
    this.status((res.info ? res.info + ' — ' : '') + def.name + ' finished' + t + '.');
    return { res, layer: last };
  }

  cropToBox() {
    if (!this.dims) return;
    const [W, H, D] = this.dims, b = this.rs.box;
    const x0 = Math.floor(b[0] * W), y0 = Math.floor(b[1] * H), z0 = Math.floor(b[2] * D);
    const x1 = Math.ceil(b[3] * W), y1 = Math.ceil(b[4] * H), z1 = Math.ceil(b[5] * D);
    const nw = x1 - x0, nh = y1 - y0, nd = z1 - z0;
    if (nw < 1 || nh < 1 || nd < 1) return this.error('Clipping box is empty');
    if (nw === W && nh === H && nd === D) return this.toast('Set a clipping box first (Render tab › Clipping box).');
    for (const L of this.layers) {
      const out = new L.data.constructor(nw * nh * nd);
      for (let z = 0; z < nd; z++) for (let y = 0; y < nh; y++) {
        const s = ((z + z0) * H + (y + y0)) * W + x0;
        out.set(L.data.subarray(s, s + nw), (z * nh + y) * nw);
      }
      L.data = out;
      L.history = [...L.history, `Cropped to x ${x0}–${x1 - 1}, y ${y0}–${y1 - 1}, z ${z0}–${z1 - 1}`];
    }
    if (this.points) this.points.list = this.points.list.filter((q) => q.x >= x0 && q.x < x1 && q.y >= y0 && q.y < y1 && q.z >= z0 && q.z < z1).map((q) => Object.assign({}, q, { x: q.x - x0, y: q.y - y0, z: q.z - z0 }));
    this.log(`Cropped all layers to ${nw}×${nh}×${nd} (x ${x0}–${x1 - 1}, y ${y0}–${y1 - 1}, z ${z0}–${z1 - 1})`);
    this.geometryChanged([nw, nh, nd], this.spacing);
  }
  binVolume(fxy, fz) {
    if (!this.dims) return;
    const [W, H, D] = this.dims, nw = Math.floor(W / fxy), nh = Math.floor(H / fxy), nd = Math.max(1, Math.floor(D / fz));
    if (nw < 2 || nh < 2) return this.error('Volume too small to bin');
    const P = W * H;
    for (const L of this.layers) {
      const out = new L.data.constructor(nw * nh * nd), a = L.data, isInt = L.dtype !== 'float32';
      const nk = fxy * fxy * Math.min(fz, D);
      for (let z = 0; z < nd; z++) for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        let s = 0, m = 0;
        for (let dz = 0; dz < Math.min(fz, D); dz++) for (let dy = 0; dy < fxy; dy++) {
          const row = (z * fz + dz) * P + (y * fxy + dy) * W + x * fxy;
          for (let dx = 0; dx < fxy; dx++) { const v = a[row + dx]; s += v; if (v > m) m = v; }
        }
        const o = (z * nh + y) * nw + x;
        out[o] = L.kind === 'labels' ? m : L.kind === 'mask' ? (s / nk >= 0.5 ? 1 : 0) : isInt ? Math.round(s / nk) : s / nk;
      }
      L.data = out;
      L.history = [...L.history, `Binned ${fxy}×${fxy}×${Math.min(fz, D)}`];
    }
    if (this.points) this.points.list = this.points.list.map((q) => Object.assign({}, q, { x: q.x / fxy, y: q.y / fxy, z: q.z / Math.min(fz, D) }));
    this.log(`Binned all layers ${fxy}×${fxy}×${Math.min(fz, D)} → ${nw}×${nh}×${nd}`);
    const sp = this.spacing;
    this.geometryChanged([nw, nh, nd], [sp[0] * fxy, sp[1] * fxy, sp[2] * Math.min(fz, D)]);
  }
  geometryChanged(dims, spacing) {
    this.dims = dims; this.spacing = spacing;
    this.table = null; this.selectedLabel = 0; this.profileLine = null; this.trace = null;
    this.rs.box = [0, 0, 0, 1, 1, 1];
    if (this.renderer) this.renderer.setGeometry(dims, spacing);
    for (const L of this.layers) {
      L.range = L.kind === 'mask' ? [0, 1] : this.proc.minmax(L.data);
      L.hist = this.computeHist(L);
      L.version++;
      this.upload(L);
    }
    this.cursor = this.dims.map((d) => Math.floor(d / 2));
    Object.values(this.sliceViews).forEach((s) => { s.zoom = 0; s.offKey = ''; });
    this.layoutViews();
    this.layersChanged();
    this.ui.volumeChanged();
  }
}
