/* SynaptoSnap — 2D slice views (XY / XZ / YZ) composited on the CPU at full resolution. */

/* Per-layer lookup tables raw value -> premultiplied RGB (0..255), cached by display version. */
function layerLUT(L) {
  const d = L.disp;
  const key = [d.cmap, d.color, d.lo, d.hi, d.gamma, d.opacity, L.version].join('|');
  if (L._lut && L._lutKey === key) return L._lut;
  const base = Colormaps.lut(d.cmap, d.color);
  const lo = d.lo, hi = d.hi, span = (hi - lo) || 1, g = d.gamma, op = d.opacity;
  let tab, mode, scale = 0, offset = 0;
  const fill = (n, valOf) => {
    const t = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      let v = (valOf(i) - lo) / span;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const k = Math.round(Math.pow(v, g) * 255) * 3;
      t[i * 3] = base[k] * op; t[i * 3 + 1] = base[k + 1] * op; t[i * 3 + 2] = base[k + 2] * op;
    }
    return t;
  };
  if (L.dtype === 'uint8') { tab = fill(256, (i) => i); mode = 'direct'; }
  else if (L.dtype === 'uint16') { tab = fill(65536, (i) => i); mode = 'direct'; }
  else {
    // float: 4096 steps across the contrast window
    const n = 4096;
    tab = fill(n, (i) => lo + (i / (n - 1)) * span);
    mode = 'scaled'; scale = (n - 1) / span; offset = lo;
  }
  L._lut = { tab, mode, scale, offset };
  L._lutKey = key;
  return L._lut;
}

function sliceGeometry(app, axis, index) {
  const [W, H, D] = app.dims, P = W * H;
  if (axis === 'xy') return { w: W, h: H, base: index * P, du: 1, dv: W };
  if (axis === 'xz') return { w: W, h: D, base: index * W, du: 1, dv: P };
  return { w: D, h: H, base: index, du: P, dv: W }; // yz: horizontal = z, vertical = y
}

/* Maximum projection along Z of a layer over slices z0 … z1-1. Cached per data array and range; for masks and
   labels also per version, since their data can be edited in place. Opened channels come with one already
   (made by the loader). Contrast changes no longer re-project intensity layers. */
function projectedXY(app, L, z0 = 0, z1 = app.dims[2]) {
  const key = z0 + '|' + z1 + (L.kind === 'intensity' ? '' : '|' + L.version);
  if (L._proj && L._projSrc === L.data && L._projKey === key) return L._proj;
  const [W, H] = app.dims, P = W * H, a = L.data, out = new a.constructor(P);
  out.set(a.subarray(z0 * P, (z0 + 1) * P));
  for (let z = z0 + 1; z < z1; z++) { const o = z * P; for (let i = 0; i < P; i++) if (a[o + i] > out[i]) out[i] = a[o + i]; }
  L._proj = out; L._projSrc = L.data; L._projKey = key;
  return out;
}

/* The clipping box in a view's pixel coordinates, or null when it covers the whole image. u/v are the view's
   horizontal/vertical pixels; out: the slice shown lies outside the box (never for the max projection);
   z0/z1: the box's Z range (what the max projection covers). Slices hide everything outside it, as 3D does. */
function sliceClip(app, axis, index, proj) {
  const r = app.roiBox();
  if (r.full) return null;
  const X = [r.x0, r.x0 + r.w], Y = [r.y0, r.y0 + r.h], Z = [r.z0, r.z0 + r.d];
  const [U, V, N] = axis === 'xy' ? [X, Y, Z] : axis === 'xz' ? [X, Z, Y] : [Z, Y, X];
  return { u0: U[0], u1: U[1], v0: V[0], v1: V[1], out: r.w < 1 || r.h < 1 || r.d < 1 || (!proj && (index < N[0] || index >= N[1])), z0: Z[0], z1: Z[1] };
}

function compositeSlice(app, axis, index, preview) {
  const g0 = sliceGeometry(app, axis, index);
  const proj = isProjected(app, axis);
  const clip = sliceClip(app, axis, index, proj);
  if (clip && clip.out) return new ImageData(g0.w, g0.h);   // the slice is outside the clipping box: transparent
  const g = proj ? Object.assign({}, g0, { base: 0 }) : g0;
  const src = (L) => (proj ? (clip ? projectedXY(app, L, clip.z0, clip.z1) : projectedXY(app, L)) : L.data);
  const { w, h, base, du, dv } = g, n = w * h;
  const acc = new Uint16Array(n * 3);
  const layers = app.layers.slice().reverse().filter((L) => L.disp.visible);
  // intensity layers: additive
  for (const L of layers) {
    if (L.kind !== 'intensity') continue;
    const lut = layerLUT(L), t = lut.tab, a = src(L);
    let p = 0;
    if (lut.mode === 'direct') {
      for (let v = 0; v < h; v++) {
        let vi = base + v * dv;
        for (let u = 0; u < w; u++, vi += du, p += 3) {
          const k = a[vi] * 3;
          acc[p] += t[k]; acc[p + 1] += t[k + 1]; acc[p + 2] += t[k + 2];
        }
      }
    } else {
      const sc = lut.scale, off = lut.offset, mx = 4095;
      for (let v = 0; v < h; v++) {
        let vi = base + v * dv;
        for (let u = 0; u < w; u++, vi += du, p += 3) {
          let k = ((a[vi] - off) * sc) | 0;
          k = (k < 0 ? 0 : k > mx ? mx : k) * 3;
          acc[p] += t[k]; acc[p + 1] += t[k + 1]; acc[p + 2] += t[k + 2];
        }
      }
    }
  }
  const img = new ImageData(w, h);
  const out = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    out[i * 4] = acc[j] > 255 ? 255 : acc[j];
    out[i * 4 + 1] = acc[j + 1] > 255 ? 255 : acc[j + 1];
    out[i * 4 + 2] = acc[j + 2] > 255 ? 255 : acc[j + 2];
    out[i * 4 + 3] = 255;
  }
  // masks and labels: alpha-blended on top
  const blend = (i, r, gg, b, al) => {
    const o = i * 4;
    out[o] += (r - out[o]) * al; out[o + 1] += (gg - out[o + 1]) * al; out[o + 2] += (b - out[o + 2]) * al;
  };
  for (const L of layers) {
    if (L.kind === 'intensity') continue;
    const a = src(L), al = L.disp.opacity;
    if (L.kind === 'mask') {
      const c = Colormaps.hexToRgb(L.disp.color).map((x) => x * 255);
      let p = 0;
      for (let v = 0; v < h; v++) {
        let vi = base + v * dv;
        for (let u = 0; u < w; u++, vi += du, p++) if (a[vi]) blend(p, c[0], c[1], c[2], al);
      }
    } else if (L.kind === 'labels') {
      const sel = app.selectedLabel, outline = L.disp.outline, only = L.disp.onlySelected && sel;
      const hid = app.traceHiddenFor ? app.traceHiddenFor(L) : null; // chromosomes hidden in the trace panel
      const cache = new Map();
      let p = 0;
      for (let v = 0; v < h; v++) {
        let vi = base + v * dv;
        for (let u = 0; u < w; u++, vi += du, p++) {
          const id = a[vi];
          if (!id || (only && id !== sel) || (hid && hid.has(id))) continue;
          if (outline) {
            const edge = (u > 0 && a[vi - du] !== id) || (u < w - 1 && a[vi + du] !== id) || (v > 0 && a[vi - dv] !== id) || (v < h - 1 && a[vi + dv] !== id) || u === 0 || v === 0 || u === w - 1 || v === h - 1;
            if (!edge) continue;
          }
          let c = cache.get(id);
          if (!c) { c = Colormaps.labelColor(id).map((x) => x * 255); cache.set(id, c); }
          if (sel && id === sel) blend(p, 255, 255, 255, Math.min(1, al + 0.35));
          else blend(p, c[0], c[1], c[2], outline ? Math.min(1, al + 0.3) : (sel ? al * 0.5 : al));
        }
      }
    }
  }
  // threshold preview
  if (preview && preview.layer) {
    const a = src(preview.layer);
    let p = 0;
    for (let v = 0; v < h; v++) {
      let vi = base + v * dv;
      for (let u = 0; u < w; u++, vi += du, p++) {
        const x = a[vi];
        if (preview.high != null) {
          if (x >= preview.high) blend(p, 255, 40, 40, 0.55);
          else if (x >= preview.low) blend(p, 255, 200, 0, 0.45);
        } else if ((x >= preview.value) !== !!preview.invert) blend(p, 255, 40, 40, 0.5);
      }
    }
  }
  // outside the clipping box: transparent, so the view's background shows
  if (clip) {
    for (let v = 0; v < h; v++) {
      const inV = v >= clip.v0 && v < clip.v1;
      for (let u = 0; u < w; u++) if (!inV || u < clip.u0 || u >= clip.u1) out[(v * w + u) * 4 + 3] = 0;
    }
  }
  return img;
}

class SliceView {
  constructor(app, host, axis) {
    this.app = app; this.host = host; this.axis = axis;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'slice-canvas';
    host.appendChild(this.canvas);
    this.badge = document.createElement('div');
    this.badge.className = 'view-badge';
    host.appendChild(this.badge);
    this.ctx = this.canvas.getContext('2d');
    this.off = document.createElement('canvas');
    this.offKey = '';
    this.zoom = 0; this.cx = 0; this.cy = 0;
    this.drag = null;
    this._events();
    new ResizeObserver(() => this.resize()).observe(host);
  }

  get index() { const c = this.app.cursor; return this.axis === 'xy' ? c[2] : this.axis === 'xz' ? c[1] : c[0]; }
  set index(v) {
    const [W, H, D] = this.app.dims, c = this.app.cursor;
    if (this.axis === 'xy') c[2] = clampInt(v, 0, D - 1);
    else if (this.axis === 'xz') c[1] = clampInt(v, 0, H - 1);
    else c[0] = clampInt(v, 0, W - 1);
  }
  get count() { const [W, H, D] = this.app.dims; return this.axis === 'xy' ? D : this.axis === 'xz' ? H : W; }
  imgDims() { const [W, H, D] = this.app.dims; return this.axis === 'xy' ? [W, H] : this.axis === 'xz' ? [W, D] : [D, H]; }
  pxSize() { const [sx, sy, sz] = this.app.spacing; return this.axis === 'xy' ? [sx, sy] : this.axis === 'xz' ? [sx, sz] : [sz, sy]; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return; // hidden view
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    if (!this.zoom && this.app.dims) this.fit();
    this.draw();
  }
  /** What a fitted view frames, in µm along this view's horizontal (u) and vertical (v): the clipping box, or the whole slice. */
  fitRegion() {
    const r = this.app.roiBox(), [sx, sy, sz] = this.app.spacing;
    const X = r.full || r.w < 1 ? [0, r.W * sx] : [r.x0 * sx, (r.x0 + r.w) * sx];
    const Y = r.full || r.h < 1 ? [0, r.H * sy] : [r.y0 * sy, (r.y0 + r.h) * sy];
    const Z = r.full || r.d < 1 ? [0, r.D * sz] : [r.z0 * sz, (r.z0 + r.d) * sz];
    const [U, V] = this.axis === 'xy' ? [X, Y] : this.axis === 'xz' ? [X, Z] : [Z, Y];
    return { u0: U[0], u1: U[1], v0: V[0], v1: V[1] };
  }
  fitZoom() {
    const R = this.fitRegion(), w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    return Math.min(w / Math.max(1e-9, R.u1 - R.u0), h / Math.max(1e-9, R.v1 - R.v0)) * 0.94;
  }
  /**
   * Frame the clipping box (the whole slice when there is none). In Ortho the three panes are fitted together:
   * one scale for all, centred on the same point, so XY and XZ line up in x, XY and YZ in y (see App.syncOrtho).
   */
  fit() {
    const app = this.app;
    if (!app.dims) return;
    const views = app.view === 'ortho' && app.sliceViews ? Object.values(app.sliceViews).filter((s) => s.host.clientWidth) : [this];
    if (!views.includes(this)) views.push(this);
    const z = Math.min(...views.map((s) => s.fitZoom()));
    for (const s of views) {
      const R = s.fitRegion();
      s.zoom = app.view === 'ortho' ? z : s.fitZoom();
      s.cx = (R.u0 + R.u1) / 2; s.cy = (R.v0 + R.v1) / 2;
      s.fitted = true;
    }
  }
  // screen (CSS px) -> image voxel coords (float)
  toImage(sx, sy) {
    const [px, py] = this.pxSize(), w = this.host.clientWidth, h = this.host.clientHeight;
    return [((sx - w / 2) / this.zoom + this.cx) / px, ((sy - h / 2) / this.zoom + this.cy) / py];
  }
  toScreen(u, v) {
    const [px, py] = this.pxSize(), w = this.host.clientWidth, h = this.host.clientHeight;
    return [(u * px - this.cx) * this.zoom + w / 2, (v * py - this.cy) * this.zoom + h / 2];
  }
  voxel(u, v) {
    const i = Math.floor(u), j = Math.floor(v), c = this.app.cursor;
    if (this.axis === 'xy') return [i, j, c[2]];
    if (this.axis === 'xz') return [i, c[1], j];
    return [c[0], j, i];
  }

  draw() {
    const app = this.app, ctx = this.ctx;
    const dpr = this.canvas.width / (this.host.clientWidth || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = app.bgColor || '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!app.dims || !app.layers.length) { this.badge.textContent = ''; return; }
    const idx = this.index;
    const pv = app.previewState();
    const proj = isProjected(app, this.axis);
    const key = this.axis + '|' + (proj ? 'mip' : idx) + '|' + app.displayVersion + '|' + (pv ? pv.key : '') + '|' + app.selectedLabel + '|' + app.rs.box.join(',');
    if (key !== this.offKey) {
      const img = compositeSlice(app, this.axis, idx, pv);
      this.off.width = img.width; this.off.height = img.height;
      this.off.getContext('2d').putImageData(img, 0, 0);
      this.offKey = key;
    }
    const [iw, ih] = this.imgDims(), [px, py] = this.pxSize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [x0, y0] = this.toScreen(0, 0);
    ctx.imageSmoothingEnabled = this.zoom * Math.min(px, py) < 2;
    ctx.drawImage(this.off, x0, y0, iw * px * this.zoom, ih * py * this.zoom);
    // crosshair
    const c = app.cursor;
    if (app.showCrosshair) {
      const [u, v] = this.axis === 'xy' ? [c[0], c[1]] : this.axis === 'xz' ? [c[0], c[2]] : [c[2], c[1]];
      const [sx, sy] = this.toScreen(u + 0.5, v + 0.5);
      ctx.strokeStyle = 'rgba(94,200,168,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, this.host.clientHeight); ctx.moveTo(0, sy); ctx.lineTo(this.host.clientWidth, sy); ctx.stroke();
      ctx.setLineDash([]);
    }
    // points
    const pts = app.points;
    if (pts && pts.visible && pts.list.length) {
      const [sx, sy, sz] = app.spacing, r = pts.diameter / 2;
      ctx.strokeStyle = pts.color; ctx.lineWidth = 1.5;
      const ai = this.axis === 'xy' ? 'z' : this.axis === 'xz' ? 'y' : 'x';
      const sp = this.axis === 'xy' ? sz : this.axis === 'xz' ? sy : sx;
      for (const q of pts.list) {
        if (!app.inClipBox([q.x * sx, q.y * sy, q.z * sz])) continue;
        const d = Math.abs(q[ai] - idx) * sp;
        if (d > r && !proj) continue;
        const rr = (proj ? r : Math.sqrt(r * r - d * d)) * this.zoom;
        const [u, v] = this.axis === 'xy' ? [q.x, q.y] : this.axis === 'xz' ? [q.x, q.z] : [q.z, q.y];
        const [X, Y] = this.toScreen(u + 0.5, v + 0.5);
        ctx.beginPath(); ctx.arc(X, Y, Math.max(2, rr), 0, 6.2832); ctx.stroke();
      }
    }
    drawTraceOverlay(this, ctx);
    // line profile
    const lp = app.profileLine;
    if (lp && this.axis === 'xy') {
      const [ax, ay] = this.toScreen(lp[0] + 0.5, lp[1] + 0.5), [bx, by] = this.toScreen(lp[2] + 0.5, lp[3] + 0.5);
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.fillStyle = '#ffd166';
      ctx.beginPath(); ctx.arc(ax, ay, 3, 0, 6.2832); ctx.arc(bx, by, 3, 0, 6.2832); ctx.fill();
    }
    // scale bar
    if (app.showScaleBar) {
      const target = 100 / this.zoom;
      const p10 = Math.pow(10, Math.floor(Math.log10(target)));
      const nice = [1, 2, 5, 10].map((k) => k * p10).filter((v) => v <= target).pop() || p10;
      const len = nice * this.zoom, X = this.host.clientWidth - 18, Y = this.host.clientHeight - 16;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(X - len, Y - 3, len, 3);
      ctx.font = '11px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(fmtLen(nice), X - len / 2, Y - 5);
    }
    const name = this.axis.toUpperCase();
    const coord = this.axis === 'xy' ? 'z' : this.axis === 'xz' ? 'y' : 'x';
    const sp = this.axis === 'xy' ? app.spacing[2] : this.axis === 'xz' ? app.spacing[1] : app.spacing[0];
    const clip = sliceClip(app, this.axis, idx, proj);
    this.badge.textContent = proj
      ? (clip ? `${name}  ·  max projection over slices ${clip.z0 + 1}–${clip.z1} (clipping box)` : `${name}  ·  max projection over ${this.count} slices`)
      : `${name}  ·  ${coord} = ${idx + 1}/${this.count}  (${(idx * sp).toFixed(2)} µm)` + (clip && clip.out ? '  ·  outside the clipping box' : '');
  }

  _events() {
    const cv = this.canvas;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.app.dims) return;
      // Trace: Shift+scroll moves where a suggestion stops (forward = longer), instead of changing slice
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && this.app.tool === 'trace' && this.app.traceSuggestions && this.app.traceSuggestions()) {
        const r = cv.getBoundingClientRect(), d = e.deltaY || e.deltaX; // Shift turns the wheel horizontal on Windows
        if (d) this.app.traceSuggestScroll(Math.max(-2, Math.min(2, -d / 100)), { view: this, x: e.clientX - r.left, y: e.clientY - r.top });
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
        const [px, py] = this.pxSize();
        const [u, v] = this.toImage(mx, my);
        this.zoom *= Math.exp(-e.deltaY * 0.0025);
        // keep point under mouse fixed
        const w = this.host.clientWidth, h = this.host.clientHeight;
        this.cx = u * px - (mx - w / 2) / this.zoom;
        this.cy = v * py - (my - h / 2) / this.zoom;
        this.fitted = false;
        this.draw();
        this.app.syncOrtho(this);
      } else {
        const step = (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 5 : 1);
        this.index = this.index + step;
        this.app.cursorChanged();
      }
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      if (!this.app.dims) return;
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or lost pointer */ }
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.app.tool === 'line' && this.axis === 'xy' && e.button === 0) {
        const [u, v] = this.toImage(mx, my);
        this.drag = { line: true };
        this.app.profileLine = [u, v, u, v];
        this.draw();
        return;
      }
      const tr = this.app.trace;
      const editing = this.app.tool === 'trace' && tr;
      // left-drag strokes: Guide (XY views) and Erase (any slice view)
      if (editing && e.button === 0 && !e.shiftKey && ((tr.clickMode === 'guide' && this.axis === 'xy') || tr.clickMode === 'erase')) {
        const [u, v] = this.toImage(mx, my);
        this.drag = { guide: true, x: mx, y: my, moved: false, button: 0 };
        if (tr.clickMode === 'erase') this.app.traceEraseStart(this, u, v); else this.app.traceGuideStart(this, u, v);
        return;
      }
      // Shift+drag always pans (so Guide and Erase, which use the left drag for strokes, can still pan); a Shift-click does nothing
      const panOnly = editing && (tr.clickMode === 'guide' || tr.clickMode === 'erase') && e.shiftKey && e.button === 0;
      this.drag = { x: mx, y: my, cx: this.cx, cy: this.cy, moved: false, button: panOnly ? -1 : e.button };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.app.dims) return;
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const [u, v] = this.toImage(mx, my);
      this.app.hover(this.voxel(u, v));
      // Trace tool: a dashed line from where the next stretch starts follows the mouse
      const tr = this.app.trace;
      if (this.app.tool === 'trace' && tr && tr.clickMode === 'trace' && tr.tip && !(this.drag && this.drag.moved)) { this.app.traceHoverAt = { view: this, u, v }; this.draw(); }
      else if (this.app.traceHoverAt) { this.app.traceHoverAt = null; this.draw(); }
      if (!this.drag) return;
      if (this.drag.line) {
        const lp = this.app.profileLine;
        if (e.shiftKey) { // snap to horizontal / vertical
          if (Math.abs(u - lp[0]) > Math.abs(v - lp[1])) { lp[2] = u; lp[3] = lp[1]; } else { lp[2] = lp[0]; lp[3] = v; }
        } else { lp[2] = u; lp[3] = v; }
        this.draw();
        return;
      }
      if (this.drag.guide) {
        const st = this.app.traceStroke;
        if (Math.abs(mx - this.drag.x) + Math.abs(my - this.drag.y) > 3) this.drag.moved = true;
        if (st) {
          const last = st.pts[st.pts.length - 1];
          if (Math.hypot(u - last[0], v - last[1]) * this.zoom * this.pxSize()[0] > 2) { st.pts.push([u, v]); this.draw(); }
        }
        return;
      }
      const dx = mx - this.drag.x, dy = my - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      if (this.drag.moved) {
        this.cx = this.drag.cx - dx / this.zoom;
        this.cy = this.drag.cy - dy / this.zoom;
        this.fitted = false;
        this.draw();
        this.app.syncOrtho(this);
      }
    });
    const end = (e) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (d.line) { this.app.profileDone(); return; }
      if (d.guide) {
        if (d.moved) { if (this.app.traceStroke && this.app.traceStroke.erase) this.app.traceEraseEnd(); else this.app.traceGuideEnd(); this.draw(); return; }
        this.app.traceStroke = null; // a plain click selects (Guide) or erases the whole trace (Erase)
      }
      const tr = this.app.trace;
      if (!d.moved && d.button === 2 && this.app.tool === 'trace' && tr && tr.clickMode === 'trace' && tr.tip) { this.app.traceFinish(); return; } // right-click finishes a trace
      if (!d.moved && d.button === 0 && this.app.tool === 'trace' && tr) {
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        const [u, v] = this.toImage(x, y);
        this.app.traceClick(this.app.traceHit(traceProjector(this), x, y), e, { view: this, u, v, x, y });
        return;
      }
      if (!d.moved && d.button === 0) {
        const r = cv.getBoundingClientRect();
        const [u, v] = this.toImage(e.clientX - r.left, e.clientY - r.top);
        const [iw, ih] = this.imgDims();
        if (u < 0 || v < 0 || u >= iw || v >= ih) return;
        const vx = this.voxel(u, v);
        this.app.setCursor(vx, true);
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', () => { if (this.drag && this.drag.guide) { this.app.traceStroke = null; this.draw(); } this.drag = null; });
    cv.addEventListener('pointerleave', () => { this.app.hover(null); if (this.app.traceHoverAt && this.app.traceHoverAt.view === this) { this.app.traceHoverAt = null; this.draw(); } });
    // while tracing or erasing, quick clicks are not a request to refit the view, and right-click finishes a trace
    const clicking = () => this.app.tool === 'trace' && this.app.trace && (this.app.trace.clickMode === 'trace' || this.app.trace.clickMode === 'erase');
    cv.addEventListener('dblclick', () => { if (clicking()) return; this.fit(); this.app.requestRender('2d'); });
    cv.addEventListener('contextmenu', (e) => { if (this.app.tool === 'trace') e.preventDefault(); });
  }
}

function clampInt(v, a, b) { v = Math.round(v); return v < a ? a : v > b ? b : v; }
