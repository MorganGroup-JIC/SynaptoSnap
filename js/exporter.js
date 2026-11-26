/* CZI Volume Studio — CZI export, snapshots, turntable movies, line profiles. */
(function () {
  const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  function layerColor(L) {
    if (L.kind === 'labels') return '#ffffff';
    if (L.kind === 'mask' || L.disp.cmap === 'custom') return L.disp.color;
    const lut = Colormaps.lut(L.disp.cmap, L.disp.color);
    const k = L.disp.cmap === 'invgray' ? 0 : 255 * 3;
    return Colormaps.rgbToHex(lut[k] / 255, lut[k + 1] / 255, lut[k + 2] / 255);
  }
  window.layerColor = layerColor;

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function region(app, o) {
    const [W, H, D] = app.dims;
    if (o.region !== 'box') return { x0: 0, y0: 0, z0: 0, w: W, h: H, d: D, full: true };
    const b = app.rs.box;
    const x0 = Math.floor(b[0] * W), y0 = Math.floor(b[1] * H), z0 = Math.floor(b[2] * D);
    const x1 = Math.ceil(b[3] * W), y1 = Math.ceil(b[4] * H), z1 = Math.ceil(b[5] * D);
    return { x0, y0, z0, w: x1 - x0, h: y1 - y0, d: z1 - z0, full: x0 === 0 && y0 === 0 && z0 === 0 && x1 === W && y1 === H && z1 === D };
  }

  function autoPixelType(layers, o) {
    if (o.pixelType !== 'auto') return o.pixelType;
    if (o.values === 'display') return layers.every((L) => L.dtype === 'uint8' || L.kind === 'mask') ? 'Gray8' : 'Gray16';
    if (layers.every((L) => L.dtype === 'uint8')) return 'Gray8';
    const floats = layers.filter((L) => L.dtype === 'float32');
    if (!floats.length) return 'Gray16';
    const ok16 = floats.every((L) => L.range[0] >= 0 && L.range[1] <= 65535 && L.range[1] - L.range[0] >= 255);
    return ok16 ? 'Gray16' : 'Gray32Float';
  }

  function converter(L, pt, o) {
    const tmax = pt === 'Gray8' ? 255 : pt === 'Gray16' ? 65535 : 0;
    const [mn, mx] = L.range, span = (mx - mn) || 1;
    if (o.values === 'display' && L.kind === 'intensity') {
      const lo = L.disp.lo, s = 1 / ((L.disp.hi - lo) || 1), g = L.disp.gamma, m = tmax || 1;
      return { f: (v) => { let t = (v - lo) * s; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.pow(t, g) * m; }, low: 0, high: 1, note: 'display-scaled' };
    }
    if (L.kind === 'mask') return { f: (v) => (v ? (tmax || 1) : 0), low: 0, high: 1 };
    if (L.kind === 'labels') return { f: (v) => (tmax && v > tmax ? tmax : v), low: 0, high: tmax ? Math.min(1, mx / tmax) : 1, identity: !!tmax && mx <= tmax };
    if (!tmax) return { f: (v) => v, low: (L.disp.lo - mn) / span, high: (L.disp.hi - mn) / span };
    if (L.dtype !== 'float32' && mx <= tmax) return { f: (v) => v, low: L.disp.lo / tmax, high: L.disp.hi / tmax, identity: true };
    if (L.dtype === 'float32' && (o.floatMode === 'clip' || (o.pixelType === 'auto' && mn >= 0 && mx <= tmax))) {
      return { f: (v) => v, low: clamp01(L.disp.lo / tmax), high: clamp01(L.disp.hi / tmax), note: 'rounded' };
    }
    const s = tmax / span;
    return { f: (v) => (v - mn) * s, low: clamp01((L.disp.lo - mn) / span), high: clamp01((L.disp.hi - mn) / span), note: `rescaled ${fmtNum(mn)}–${fmtNum(mx)} → 0–${tmax}` };
  }

  Object.assign(App.prototype, {
    exportPlan(o) {
      const warnings = [];
      const r = region(this, o);
      if (!o.layers.length) return { error: 'Select at least one layer', dims: [r.w, r.h, r.d], bytes: 0, pixelType: '', warnings };
      const pt = autoPixelType(o.layers, o);
      const bpp = pt === 'Gray8' ? 1 : pt === 'Gray16' ? 2 : 4;
      o.layers.forEach((L) => {
        if (L.kind === 'labels' && pt === 'Gray8' && L.range[1] > 255) warnings.push(`"${L.name}" has ${L.range[1]} labels — clipped at 255 in 8-bit`);
        if (L.kind === 'labels' && pt === 'Gray16' && L.range[1] > 65535) warnings.push(`"${L.name}" has more than 65535 labels — use 32-bit float`);
        if (L.kind === 'intensity' && o.values === 'raw' && pt !== 'Gray32Float' && (L.dtype === 'float32' || L.range[1] > (pt === 'Gray8' ? 255 : 65535))) {
          const c = converter(L, pt, o);
          if (c.note) warnings.push(`"${L.name}" ${c.note}`);
        }
      });
      return { dims: [r.w, r.h, r.d], bytes: (r.w * r.h * bpp + 320) * r.d * o.layers.length + 8192, pixelType: pt, warnings, region: r };
    },

    async exportCZI(o) {
      if (!this.dims) return this.toast('Nothing loaded');
      const plan = this.exportPlan(o);
      if (plan.error) return this.toast(plan.error);
      if (!LITTLE_ENDIAN) return this.error('Export needs a little-endian machine');
      let name = (o.name || 'export.czi').replace(/[\\/:*?"<>|]/g, '_');
      if (!/\.czi$/i.test(name)) name += '.czi';
      // Ask for the destination first, while we still have the click's user activation.
      let handle = null;
      if (window.showSaveFilePicker) {
        try {
          handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Zeiss CZI image', accept: { 'application/octet-stream': ['.czi'] } }] });
        } catch (e) {
          if (e.name === 'AbortError') return;
          handle = null;
        }
      }
      const r = plan.region, pt = plan.pixelType, layers = o.layers;
      const [W, H] = this.dims, P = W * H, n = r.w * r.h;
      const convs = layers.map((L) => converter(L, pt, o));
      const Arr = pt === 'Gray8' ? Uint8Array : pt === 'Gray16' ? Uint16Array : Float32Array;
      const tmax = pt === 'Gray8' ? 255 : pt === 'Gray16' ? 65535 : 0;
      const sameType = (L) => (pt === 'Gray8' && L.data instanceof Uint8Array) || (pt === 'Gray16' && L.data instanceof Uint16Array) || (pt === 'Gray32Float' && L.data instanceof Float32Array);
      let maxOut = 0;
      const getPlane = (c, z) => {
        const L = layers[c], cv = convs[c], a = L.data;
        if (r.full && cv.identity && sameType(L)) {
          for (let i = z * P; i < (z + 1) * P; i++) if (a[i] > maxOut) maxOut = a[i];
          return new Uint8Array(a.buffer, a.byteOffset + z * P * a.BYTES_PER_ELEMENT, P * a.BYTES_PER_ELEMENT);
        }
        const out = new Arr(n), f = cv.f;
        for (let y = 0; y < r.h; y++) {
          const s = ((z + r.z0) * H + (y + r.y0)) * W + r.x0, o2 = y * r.w;
          for (let x = 0; x < r.w; x++) {
            let v = f(a[s + x]);
            if (tmax) { v = Math.round(v); v = v < 0 ? 0 : v > tmax ? tmax : v; if (v > maxOut) maxOut = v; }
            out[o2 + x] = v;
          }
        }
        return new Uint8Array(out.buffer);
      };
      // bit depth: estimate from layer ranges after conversion
      let est = 0;
      layers.forEach((L, c) => { const cv = convs[c]; est = Math.max(est, Math.round(Math.max(cv.f(L.range[1]), cv.f(L.range[0])))); });
      const bitCount = pt === 'Gray8' ? 8 : pt === 'Gray32Float' ? 32 : est <= 4095 ? 12 : est <= 16383 ? 14 : 16;
      // Low/High are written relative to the full pixel-type range, with BitCountRange set to match.
      const lowHigh = (cv) => [clamp01(cv.low), clamp01(cv.high)];
      const desc = [
        'Exported by CZI Volume Studio on ' + new Date().toISOString(),
        'Source: ' + (this.vol ? this.vol.fileName || this.vol.name : 'unknown'),
        'Region: ' + (r.full ? 'whole volume' : `x ${r.x0}-${r.x0 + r.w - 1}, y ${r.y0}-${r.y0 + r.h - 1}, z ${r.z0}-${r.z0 + r.d - 1}`),
        'Values: ' + (o.values === 'display' ? 'display contrast/gamma applied' : 'data values') + ', pixel type ' + pt,
        '',
        ...layers.map((L, i) => `Channel ${i + 1} "${L.name}" [${L.kind}]: ` + L.history.join(' -> ') + (convs[i].note ? ` -> ${convs[i].note}` : '')),
        '',
        'Session log:',
        ...this.history.map((e) => e.time.toISOString() + '  ' + e.msg),
      ].join('\n');
      const xml = this.czi.buildMetadataXML({
        name: name.replace(/\.czi$/i, ''), width: r.w, height: r.h, depth: r.d, pixelType: pt, bitCount,
        scaling: { x: this.spacing[0], y: this.spacing[1], z: this.spacing[2] },
        channels: layers.map((L, i) => {
          const [low, high] = lowHigh(convs[i]);
          return { name: L.name, color: layerColor(L), low, high, gamma: o.values === 'display' ? 1 : (L.disp.gamma || 1), sourceNode: o.includeMeta && L.source && L.source.meta ? L.source.meta.node : null };
        }),
        sourceDoc: o.includeMeta && this.meta ? this.meta.doc : null,
        description: desc,
      });
      const czi = this.czi.planCZI({ width: r.w, height: r.h, depth: r.d, pixelType: pt, nChannels: layers.length, getPlane, xml });
      const total = layers.length * r.d;
      const ok = await this.task('Writing ' + name + '…', async (progress) => {
        let k = 0, bytes = 0;
        if (handle) {
          const ws = await handle.createWritable();
          try {
            for (const part of czi.parts()) {
              await ws.write(part);
              bytes += part.byteLength;
              if (part.byteLength > 4096) progress(++k / total, 'Writing ' + name);
            }
            await ws.close();
          } catch (e) { try { await ws.abort(); } catch (_) { /* ignore */ } throw e; }
        } else {
          const chunks = [];
          for (const part of czi.parts()) {
            chunks.push(part.byteOffset === 0 && part.byteLength === part.buffer.byteLength ? part : part.slice());
            bytes += part.byteLength;
            if (part.byteLength > 4096) { progress(++k / total, 'Packing ' + name); if (k % 16 === 0) await new Promise((res) => setTimeout(res, 0)); }
          }
          download(new Blob(chunks, { type: 'application/octet-stream' }), name);
        }
        if (bytes !== czi.size) throw new Error(`Internal size mismatch (${bytes} vs ${czi.size})`);
        return true;
      });
      if (ok) {
        this.log(`Exported ${layers.length} channel(s) to ${name} (${pt}, ${r.w}×${r.h}×${r.d}, ${fmtBytes(czi.size)})`);
        this.toast('Saved ' + name + ' (' + fmtBytes(czi.size) + ')');
        this.status('Exported ' + name + (handle ? '' : ' to your Downloads folder') + '.');
      }
    },

    /** Build CZI bytes in memory (used for tests / round trips). */
    buildCZIBlob(o) {
      const plan = this.exportPlan(o), r = plan.region, pt = plan.pixelType, layers = o.layers;
      const [W, H] = this.dims, n = r.w * r.h;
      const convs = layers.map((L) => converter(L, pt, o));
      const Arr = pt === 'Gray8' ? Uint8Array : pt === 'Gray16' ? Uint16Array : Float32Array, tmax = pt === 'Gray8' ? 255 : pt === 'Gray16' ? 65535 : 0;
      const getPlane = (c, z) => {
        const out = new Arr(n), a = layers[c].data, f = convs[c].f;
        for (let y = 0; y < r.h; y++) {
          const s = ((z + r.z0) * H + (y + r.y0)) * W + r.x0;
          for (let x = 0; x < r.w; x++) { let v = f(a[s + x]); if (tmax) { v = Math.round(v); v = v < 0 ? 0 : v > tmax ? tmax : v; } out[y * r.w + x] = v; }
        }
        return new Uint8Array(out.buffer);
      };
      const xml = this.czi.buildMetadataXML({
        name: 'test', width: r.w, height: r.h, depth: r.d, pixelType: pt, bitCount: pt === 'Gray8' ? 8 : pt === 'Gray16' ? 16 : 32,
        scaling: { x: this.spacing[0], y: this.spacing[1], z: this.spacing[2] },
        channels: layers.map((L, i) => ({ name: L.name, color: layerColor(L), low: convs[i].low, high: convs[i].high, gamma: 1, sourceNode: L.source && L.source.meta ? L.source.meta.node : null })),
        sourceDoc: this.meta ? this.meta.doc : null, description: 'round-trip test',
      });
      const czi = this.czi.planCZI({ width: r.w, height: r.h, depth: r.d, pixelType: pt, nChannels: layers.length, getPlane, xml });
      return new Blob(Array.from(czi.parts()).map((p) => p.slice()), { type: 'application/octet-stream' });
    },

    // ------------------------------------------------------------------ images
    async snapshot(scale = 1) {
      if (!this.dims) return this.toast('Nothing to capture yet');
      const ids = this.view === '3d' ? ['v3d'] : this.view === 'xy' ? ['vxy'] : ['vxy', 'vyz', 'vxz', 'v3d'];
      const root = $('#views').getBoundingClientRect();
      const has3D = ids.includes('v3d') && this.renderer;
      const gl = $('#gl'), ov = $('#overlay');
      const dpr = has3D ? gl.width / (gl.clientWidth || 1) : window.devicePixelRatio || 1;
      const k = dpr * scale;
      if (has3D && scale > 1) {
        const w = gl.clientWidth, hh = gl.clientHeight;
        const maxDim = this.renderer.gl.getParameter(this.renderer.gl.MAX_RENDERBUFFER_SIZE);
        const s = Math.min(k, maxDim / Math.max(w, hh));
        for (const c of [gl, ov]) { c.width = Math.round(w * s); c.height = Math.round(hh * s); }
      }
      if (has3D) { this.interacting = false; this.draw3D(); }
      const out = h('canvas', { width: Math.round(root.width * k), height: Math.round(root.height * k) });
      const ctx = out.getContext('2d');
      ctx.fillStyle = this.bgColor; ctx.fillRect(0, 0, out.width, out.height);
      for (const id of ids) {
        const el = $('#' + id), r = el.getBoundingClientRect();
        const x = (r.left - root.left) * k, y = (r.top - root.top) * k, w = r.width * k, hh = r.height * k;
        if (id === 'v3d') { ctx.drawImage(gl, x, y, w, hh); ctx.drawImage(ov, x, y, w, hh); }
        else ctx.drawImage($('canvas', el), x, y, w, hh);
      }
      if (has3D && scale > 1) this.resize3D();
      const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
      const name = (this.vol ? this.vol.name : 'volume').replace(/[\\/:*?"<>|]/g, '_') + '_' + this.view + (scale > 1 ? '_' + scale + 'x' : '') + '.png';
      download(blob, name);
      this.status(`Saved snapshot ${name} (${out.width}×${out.height}).`);
    },

    async recordTurntable(seconds = 8) {
      if (!this.renderer || !this.dims) return this.toast('Load data first');
      if (!window.MediaRecorder) return this.error('Video recording is not supported in this browser');
      if (!this.show3D()) this.setView('3d');
      await new Promise((r) => setTimeout(r, 120));
      const gl = $('#gl'), ov = $('#overlay');
      const rc = h('canvas', { width: gl.width & ~1, height: gl.height & ~1 });
      const ctx = rc.getContext('2d');
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      const stream = rc.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16e6 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { rec.onstop = r; });
      this.rs.autoRotate = false; this.ui.syncAutoRotate();
      let cancelled = false;
      const onCancel = () => { cancelled = true; };
      this.busy(true, 'Recording 360° turntable…');
      $('#btnCancel').addEventListener('click', onCancel, { once: true });
      rec.start(250);
      const fps = 30, frames = Math.round(seconds * fps);
      for (let i = 0; i < frames && !cancelled; i++) {
        const t0 = performance.now();
        this.renderer.camera.rotate(2 * Math.PI / frames, 0);
        this.interacting = false;
        this.draw3D();
        ctx.drawImage(gl, 0, 0, rc.width, rc.height);
        ctx.drawImage(ov, 0, 0, rc.width, rc.height);
        this.progress(i / frames, 'Recording turntable');
        await new Promise((r) => setTimeout(r, Math.max(0, 1000 / fps - (performance.now() - t0))));
      }
      rec.stop();
      await stopped;
      this.busy(false);
      if (cancelled) return this.status('Recording cancelled.');
      const name = (this.vol ? this.vol.name : 'volume').replace(/[\\/:*?"<>|]/g, '_') + '_turntable.webm';
      download(new Blob(chunks, { type: 'video/webm' }), name);
      this.status('Saved ' + name + '.');
    },

    // ------------------------------------------------------------------ line profile
    profileDone() {
      const lp = this.profileLine;
      if (!lp || !this.dims) return;
      const [x0, y0, x1, y1] = lp, [sx, sy] = this.spacing, [W, H] = this.dims, z = this.cursor[2];
      const len = Math.hypot((x1 - x0) * sx, (y1 - y0) * sy);
      if (len <= 0) return;
      const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1);
      const layers = this.layers.filter((L) => L.disp.visible && L.kind === 'intensity');
      if (!layers.length) return this.toast('Show at least one intensity layer to sample a profile');
      const dist = [], series = layers.map((L) => ({ name: L.name, color: layerColor(L), y: [] }));
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const u = x0 + t * (x1 - x0) - 0.5, v = y0 + t * (y1 - y0) - 0.5;
        dist.push(t * len);
        const xa = Math.max(0, Math.min(W - 1, Math.floor(u))), ya = Math.max(0, Math.min(H - 1, Math.floor(v)));
        const xb = Math.min(W - 1, xa + 1), yb = Math.min(H - 1, ya + 1);
        const fx = Math.max(0, Math.min(1, u - xa)), fy = Math.max(0, Math.min(1, v - ya));
        layers.forEach((L, k) => {
          const a = L.data, o = z * W * H;
          const val = (a[o + ya * W + xa] * (1 - fx) + a[o + ya * W + xb] * fx) * (1 - fy) + (a[o + yb * W + xa] * (1 - fx) + a[o + yb * W + xb] * fx) * fy;
          series[k].y.push(val);
        });
      }
      this.ui.showProfile({ dist, series, length: len });
      this.ui.showTab('analyze');
    },
  });
})();
