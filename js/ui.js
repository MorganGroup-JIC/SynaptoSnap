/* SynaptoSnap — user interface panels. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(3)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const roundTo = (v, step) => (step >= 1 ? Math.round(v) : +(+v).toPrecision(5));

/* Slider + number box. opts: {label, min, max, step, value, log, onInput, hint, fmt} */
function sliderRow(o) {
  const N = 1000;
  const toPos = (v) => (o.log ? Math.log(v / o.min) / Math.log(o.max / o.min) : (v - o.min) / ((o.max - o.min) || 1)) * N;
  const fromPos = (p) => (o.log ? o.min * Math.pow(o.max / o.min, p / N) : o.min + (o.max - o.min) * p / N);
  const rng = h('input', { type: 'range', min: 0, max: N, step: 1 });
  const num = h('input', { type: 'number', step: o.step || 'any' });
  const row = h('div', { class: 'row', title: o.hint || null }, h('label', null, o.label), rng, num);
  const api = {
    el: row, value: o.value,
    set(v, silent) {
      api.value = v;
      rng.value = Math.max(0, Math.min(N, toPos(v)));
      num.value = o.fmt ? o.fmt(v) : roundTo(v, o.step || 0.001);
      if (!silent && o.onInput) o.onInput(v);
    },
    setRange(min, max, step) { o.min = min; o.max = max; if (step) { o.step = step; num.step = step; } api.set(api.value, true); },
  };
  rng.addEventListener('input', () => { let v = fromPos(+rng.value); if (o.step >= 1) v = Math.round(v / o.step) * o.step; api.value = v; num.value = o.fmt ? o.fmt(v) : roundTo(v, o.step || 0.001); if (o.onInput) o.onInput(v); });
  num.addEventListener('change', () => { const v = parseFloat(num.value); if (isFinite(v)) api.set(v); });
  api.set(o.value, true);
  return api;
}
function selectEl(options, value, onChange, attrs) {
  const s = h('select', attrs || null, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value;
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}
function row2(label, control, hint) { return h('div', { class: 'row2', title: hint || null }, h('label', null, label), control); }
function check(label, value, onChange, hint) {
  const c = h('input', { type: 'checkbox', checked: value });
  c.addEventListener('change', () => onChange(c.checked));
  return h('label', { class: 'check', title: hint || null }, c, label);
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
function toCSV(rows, cols) {
  const esc = (v) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(7)) : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  return cols.map((c) => c[1]).join(',') + '\n' + rows.map((r) => cols.map((c) => esc(typeof c[0] === 'function' ? c[0](r) : r[c[0]])).join(',')).join('\n') + '\n';
}

/* --------------------------------------------------------------- small charts */
function lineChart(canvas, o) {
  // o = { series:[{name, color, x:[], y:[]}], xLabel, yLabel, logY, marker:{x, label}, xFmt }
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 280, H = canvas.clientHeight || 150;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.body);
  const ink = css.getPropertyValue('--text').trim() || '#ddd', muted = css.getPropertyValue('--muted').trim() || '#888', grid = css.getPropertyValue('--line').trim() || '#333';
  const pad = { l: 46, r: 10, t: 10, b: 30 };
  let xs = [], ys = [];
  o.series.forEach((s) => { xs = xs.concat(s.x); ys = ys.concat(s.y.map((v) => (o.logY ? Math.log10(Math.max(v, 1e-30)) : v))); });
  const fin = (a) => a.filter((v) => isFinite(v));
  xs = fin(xs); ys = fin(ys);
  if (!xs.length) return;
  const x0 = o.xMin != null ? o.xMin : Math.min(...xs), x1 = o.xMax != null ? o.xMax : Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (o.logY) y0 = Math.max(y0, y1 - 8);
  if (!o.logY && y0 > 0) y0 = 0;
  if (y1 === y0) y1 = y0 + 1;
  const X = (v) => pad.l + (v - x0) / ((x1 - x0) || 1) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((o.logY ? Math.log10(Math.max(v, 1e-30)) : v) - y0) / (y1 - y0) * (H - pad.t - pad.b);
  const draw = (hx) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px Segoe UI, sans-serif';
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = muted;
    // y ticks
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const v = y0 + (y1 - y0) * i / 3, py = H - pad.b - i / 3 * (H - pad.t - pad.b);
      ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(W - pad.r, py); ctx.stroke();
      ctx.fillText(o.logY ? '1e' + v.toFixed(0) : fmtNum(v), pad.l - 4, py);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) { const v = x0 + (x1 - x0) * i / 4; ctx.fillText(o.xFmt ? o.xFmt(v) : fmtNum(v), X(v), H - pad.b + 4); }
    ctx.fillText(o.xLabel || '', (pad.l + W - pad.r) / 2, H - 12);
    if (o.marker && o.marker.x != null) {
      ctx.strokeStyle = muted; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(o.marker.x), pad.t); ctx.lineTo(X(o.marker.x), H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(o.marker.label || '', Math.min(X(o.marker.x) + 4, W - 80), pad.t);
    }
    o.series.forEach((s) => {
      ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.x.length; i++) {
        if (!isFinite(s.y[i]) || (o.logY && s.y[i] <= 0)) continue;
        const px = X(s.x[i]), py = Y(s.y[i]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    if (hx != null && hx >= pad.l && hx <= W - pad.r) {
      const xv = x0 + (hx - pad.l) / (W - pad.l - pad.r) * (x1 - x0);
      ctx.strokeStyle = muted; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, H - pad.b); ctx.stroke();
      const lines = [(o.xFmt ? o.xFmt(xv) : fmtNum(xv)) + ' ' + (o.xUnit || '')];
      o.series.forEach((s) => {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < s.x.length; i++) { const d = Math.abs(s.x[i] - xv); if (d < bd) { bd = d; bi = i; } }
        lines.push([s.name, fmtNum(s.y[bi]), s.color]);
        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(s.x[bi]), Y(s.y[bi]), 3.5, 0, 6.3); ctx.fill();
      });
      const bw = 150, bh = 14 * lines.length + 8, bx = hx + 8 + bw > W ? hx - bw - 8 : hx + 8;
      ctx.fillStyle = 'rgba(16,18,22,0.92)'; ctx.fillRect(bx, pad.t, bw, bh);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach((l, i) => {
        if (typeof l === 'string') { ctx.fillStyle = '#e6e8ec'; ctx.fillText(l, bx + 6, pad.t + 4); return; }
        ctx.fillStyle = l[2]; ctx.fillRect(bx + 6, pad.t + 7 + i * 14, 8, 2);
        ctx.fillStyle = '#e6e8ec'; ctx.fillText(l[0].slice(0, 16) + ': ' + l[1], bx + 18, pad.t + 4 + i * 14);
      });
    }
  };
  draw(null);
  canvas.onpointermove = (e) => { const r = canvas.getBoundingClientRect(); draw(e.clientX - r.left); };
  canvas.onpointerleave = () => draw(null);
}

/* --------------------------------------------------------------- histogram widget */
class HistWidget {
  constructor(app, L, onChange) {
    this.app = app; this.L = L; this.onChange = onChange;
    this.canvas = h('canvas', { class: 'hist' });
    this.tip = null;
    const cv = this.canvas;
    let dragging = null;
    const valAt = (e) => { const r = cv.getBoundingClientRect(); const H = this.L.hist; return H.lo + (e.clientX - r.left) / r.width * (H.hi - H.lo); };
    cv.addEventListener('pointerdown', (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or lost pointer */ }
      const v = valAt(e), d = this.L.disp;
      dragging = Math.abs(v - d.lo) <= Math.abs(v - d.hi) ? 'lo' : 'hi';
      this._set(dragging, v);
    });
    cv.addEventListener('pointermove', (e) => {
      if (dragging) { this._set(dragging, valAt(e)); return; }
      const r = cv.getBoundingClientRect();
      this.tip = (e.clientX - r.left) / r.width;
      this.draw();
    });
    cv.addEventListener('pointerup', () => { dragging = null; });
    cv.addEventListener('pointerleave', () => { this.tip = null; this.draw(); });
    requestAnimationFrame(() => this.draw());
  }
  _set(which, v) {
    const d = this.L.disp, H = this.L.hist;
    v = Math.max(H.lo, Math.min(H.hi, v));
    if (this.L.dtype !== 'float32') v = Math.round(v);
    if (which === 'lo') d.lo = Math.min(v, d.hi - (this.L.dtype !== 'float32' ? 1 : 1e-6));
    else d.hi = Math.max(v, d.lo + (this.L.dtype !== 'float32' ? 1 : 1e-6));
    this.onChange();
    this.draw();
  }
  draw() {
    const cv = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 260, Hh = cv.clientHeight || 84;
    cv.width = W * dpr; cv.height = Hh * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.body);
    const L = this.L, H = L.hist, d = L.disp;
    const nb = Math.min(W, 256), agg = new Float64Array(nb);
    for (let i = 0; i < H.h.length; i++) agg[Math.min(nb - 1, Math.floor(i * nb / H.h.length))] += H.h[i];
    let mx = 0;
    for (let i = 0; i < nb; i++) { agg[i] = Math.log1p(agg[i]); if (agg[i] > mx) mx = agg[i]; }
    const X = (v) => (v - H.lo) / ((H.hi - H.lo) || 1) * W;
    ctx.fillStyle = css.getPropertyValue('--well').trim();
    ctx.fillRect(0, 0, W, Hh);
    const lut = Colormaps.lut(d.cmap, d.color);
    const bw = W / nb;
    for (let i = 0; i < nb; i++) {
      const v = H.lo + (i + 0.5) / nb * (H.hi - H.lo);
      let t = (v - d.lo) / ((d.hi - d.lo) || 1); t = t < 0 ? 0 : t > 1 ? 1 : t;
      const k = Math.round(Math.pow(t, d.gamma) * 255) * 3;
      const inside = v >= d.lo && v <= d.hi;
      ctx.fillStyle = inside ? `rgb(${Math.max(90, lut[k])},${Math.max(90, lut[k + 1])},${Math.max(90, lut[k + 2])})` : css.getPropertyValue('--muted').trim();
      ctx.globalAlpha = inside ? 0.9 : 0.35;
      const bh = mx ? agg[i] / mx * (Hh - 6) : 0;
      ctx.fillRect(i * bw, Hh - bh, Math.max(1, bw - 0.5), bh);
    }
    ctx.globalAlpha = 1;
    // gamma curve
    ctx.strokeStyle = css.getPropertyValue('--text').trim(); ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) { const t = i / 40, x = X(d.lo + t * (d.hi - d.lo)), y = Hh - 2 - Math.pow(t, d.gamma) * (Hh - 8); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
    // handles
    ctx.fillStyle = css.getPropertyValue('--accent').trim();
    for (const v of [d.lo, d.hi]) { const x = Math.max(1, Math.min(W - 1, X(v))); ctx.fillRect(x - 1, 0, 2, Hh); ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.fill(); }
    if (this.tip != null) {
      const v = H.lo + this.tip * (H.hi - H.lo), bi = Math.min(H.h.length - 1, Math.max(0, Math.floor(this.tip * H.h.length)));
      const txt = fmtNum(v) + '  ·  ' + Math.round(H.h[bi] * (L.data.length / H.total)).toLocaleString() + ' vox';
      ctx.font = '10px Segoe UI, sans-serif'; ctx.textBaseline = 'top';
      const tw = ctx.measureText(txt).width + 8;
      const tx = Math.min(W - tw - 2, Math.max(2, this.tip * W + 6));
      ctx.fillStyle = 'rgba(16,18,22,0.9)'; ctx.fillRect(tx, 10, tw, 15);
      ctx.fillStyle = '#e6e8ec'; ctx.fillText(txt, tx + 4, 12);
    }
  }
}

/* --------------------------------------------------------------- generic op form */
class OpForm {
  constructor(ui, def, opts = {}) {
    this.ui = ui; this.app = ui.app; this.def = def; this.opts = opts;
    this.params = {};
    this.inputSel = [];
    this.controls = {};
    this.el = h('div', { class: 'opform' });
    this.build();
  }
  ctx() { const a = this.app; return { sx: a.spacing[0], sy: a.spacing[1], sz: a.spacing[2], W: a.dims && a.dims[0], H: a.dims && a.dims[1], D: a.dims && a.dims[2], meta: a.meta }; }
  inputLayers() { return this.inputSel.map((s) => (s && s.value ? this.app.layer(+s.value) : null)); }
  firstInput() { return this.inputLayers()[0]; }
  evalDef(p) { return typeof p.def === 'function' ? p.def(this.ctx(), this.firstInput(), this.params) : p.def; }
  build() {
    const def = this.def, el = this.el;
    el.innerHTML = '';
    if (def.desc && !this.opts.noDesc) el.append(h('p', { class: 'desc' }, def.desc));
    this.inputSel = def.inputs.map((inp, i) => {
      const s = h('select');
      s.addEventListener('change', () => this.inputChanged(i));
      const r = row2(inp.label, s);
      r.dataset.input = i;
      el.append(r);
      return s;
    });
    this.refreshInputs();
    def.params.forEach((p) => {
      this.params[p.k] = this.evalDef(p);
      let ctl;
      if (p.type === 'select') {
        ctl = selectEl(p.options, this.params[p.k], (v) => { this.params[p.k] = v; this.changed(p.k); });
        ctl = row2(p.label, ctl, p.hint);
      } else if (p.type === 'check') {
        ctl = check(p.label, !!this.params[p.k], (v) => { this.params[p.k] = v; this.changed(p.k); }, p.hint);
      } else if (p.type === 'text') {
        const t = h('input', { type: 'text', value: this.params[p.k] });
        t.addEventListener('change', () => { this.params[p.k] = t.value; this.changed(p.k); });
        ctl = row2(p.label, t, p.hint);
      } else if (p.slider) {
        const L = this.firstInput();
        const r = L ? L.range : [0, 1];
        const sl = sliderRow({ label: p.label, min: r[0], max: r[1], step: L && L.dtype !== 'float32' ? 1 : (r[1] - r[0]) / 1000, value: this.params[p.k], onInput: (v) => { this.params[p.k] = v; this.changed(p.k); } });
        this.sliders = this.sliders || {};
        this.sliders[p.k] = sl;
        ctl = sl.el;
      } else {
        const n = h('input', { type: 'number', step: p.step || 'any', min: p.min, max: p.max, value: this.params[p.k] });
        n.addEventListener('change', () => { this.params[p.k] = n.value === '' ? '' : +n.value; this.changed(p.k); });
        ctl = row2(p.label, n, p.hint);
      }
      ctl.dataset.param = p.k;
      this.controls[p.k] = ctl;
      el.append(ctl);
    });
    if (def.preview) {
      this.previewInfo = h('span', { class: 'muted small' });
      this.previewChk = check('Preview on slices', false, () => this.updatePreview());
      el.append(h('div', { class: 'preview-row' }, this.previewChk, this.previewInfo));
    }
    this.applyBtn = h('button', { class: 'primary wide', onclick: () => this.apply() }, this.opts.applyLabel || 'Apply → new layer');
    el.append(this.applyBtn);
    this.updateVisibility();
  }
  refreshInputs() {
    const layers = this.app.layers;
    this.def.inputs.forEach((inp, i) => {
      const s = this.inputSel[i], prev = s.value;
      s.innerHTML = '';
      if (inp.optional) s.append(h('option', { value: '' }, '— none —'));
      const ok = layers.filter((L) => inp.kinds.includes(L.kind));
      ok.forEach((L) => s.append(h('option', { value: L.id }, L.name + (L.kind !== 'intensity' ? ' [' + L.kind + ']' : ''))));
      if (prev && ok.some((L) => String(L.id) === prev)) s.value = prev;
      else {
        const sel = this.app.selected;
        // chromosome tracing: the SC (ZYP1) channel, found as the most line-like one (the first channel is
        // often foci or DAPI, and a wrong channel makes tracing follow the wrong structures)
        const sc = inp.prefer === 'sc' && this.app.traceSCChannel ? this.app.traceSCChannel() : null;
        if (sc && ok.includes(sc)) s.value = sc.id;
        else if (sel && inp.kinds.includes(sel.kind) && i === 0) s.value = sel.id;
        else if (ok.length) s.value = ok[Math.min(i, ok.length - 1)].id;
        if (inp.optional && i > 0 && !(sc && ok.includes(sc))) { const t = ok.find((L) => L.kind === 'intensity'); s.value = t ? t.id : ''; }
      }
    });
    if (this.applyBtn) this.applyBtn.disabled = !this.app.dims || this.def.inputs.some((inp, i) => !inp.optional && !(inp.show && !inp.show(this.params)) && !this.inputSel[i].value);
  }
  inputChanged(i) {
    if (i === 0) {
      this.def.params.forEach((p) => {
        if (typeof p.def === 'function' && p.def.length >= 2) { this.params[p.k] = this.evalDef(p); this.setControl(p); }
        if (p.slider && this.sliders && this.sliders[p.k]) {
          const L = this.firstInput();
          if (L) { this.sliders[p.k].setRange(L.range[0], L.range[1], L.dtype !== 'float32' ? 1 : (L.range[1] - L.range[0]) / 1000); }
        }
      });
    }
    this.refreshInputs();
    this.updatePreview();
  }
  resetDefaults() {
    this.edited = new Set();
    this.def.params.forEach((p) => { this.params[p.k] = this.evalDef(p); this.setControl(p); });
    this.def.params.forEach((p) => {
      if (p.slider && this.sliders && this.sliders[p.k]) { const L = this.firstInput(); if (L) this.sliders[p.k].setRange(L.range[0], L.range[1], L.dtype !== 'float32' ? 1 : (L.range[1] - L.range[0]) / 1000); }
    });
    this.updateVisibility();
  }
  setControl(p) {
    const c = this.controls[p.k];
    if (!c) return;
    if (this.sliders && this.sliders[p.k]) { this.sliders[p.k].set(this.params[p.k], true); return; }
    const inp = c.querySelector('input, select');
    if (!inp) return;
    if (inp.type === 'checkbox') inp.checked = !!this.params[p.k]; else inp.value = this.params[p.k];
  }
  changed(k) {
    (this.edited = this.edited || new Set()).add(k);
    if (k === 'method' && this.params.method === 'manual' && this.lastLevel != null && this.sliders && this.sliders.value) {
      this.params.value = this.lastLevel; this.sliders.value.set(this.lastLevel, true);
    }
    // defaults that depend on another parameter follow it until the user edits them
    this.def.params.forEach((p) => {
      if (p.recalcOn && p.recalcOn.includes(k) && !this.edited.has(p.k)) { this.params[p.k] = this.evalDef(p); this.setControl(p); }
    });
    this.updateVisibility();
    this.refreshInputs();
    this.updatePreview();
  }
  updateVisibility() {
    this.def.params.forEach((p) => { if (this.controls[p.k]) this.controls[p.k].style.display = !p.show || p.show(this.params) ? '' : 'none'; });
    this.def.inputs.forEach((inp, i) => { const r = this.el.querySelector(`[data-input="${i}"]`); if (r) r.style.display = !inp.show || inp.show(this.params) ? '' : 'none'; });
  }
  updatePreview() {
    if (!this.def.preview || !this.previewChk) return;
    const on = this.previewChk.querySelector('input').checked;
    const L = this.firstInput();
    if (!on || !L) { if (this.app.preview && this.app.preview.owner === this) this.app.setPreview(null); this.previewInfo.textContent = ''; return; }
    if (this.def.preview === 'hysteresis') {
      this.app.setPreview({ owner: this, layer: L, low: +this.params.low, high: +this.params.high });
      return;
    }
    const m = this.params.method;
    let v;
    if (m === 'manual') v = +this.params.value;
    else {
      const key = L.id + '|' + L.version + '|' + m + '|' + this.params.percentile;
      if (this._lvlKey !== key) { this._lvl = this.app.proc.thresholdValue(L.data, m, this.params.percentile); this._lvlKey = key; }
      v = this._lvl;
      this.lastLevel = v;
    }
    this.previewInfo.textContent = 'level ' + fmtNum(v);
    this.app.setPreview({ owner: this, layer: L, value: v, invert: !!this.params.invert });
  }
  stopPreview() {
    if (this.previewChk) this.previewChk.querySelector('input').checked = false;
    if (this.app.preview && this.app.preview.owner === this) this.app.setPreview(null);
    if (this.previewInfo) this.previewInfo.textContent = '';
  }
  async apply() {
    const inputs = this.inputLayers().map((L, i) => (this.def.inputs[i].show && !this.def.inputs[i].show(this.params) ? null : L));
    if (this.def.inputs.some((inp, i) => !inp.optional && !(inp.show && !inp.show(this.params)) && !inputs[i])) return this.app.toast('Choose an input layer first');
    const params = Object.assign({}, this.params);
    this.stopPreview();
    if (this.opts.onApply) return this.opts.onApply(inputs, params);
    return this.app.runOp(this.def, inputs, params);
  }
}

/* --------------------------------------------------------------- main UI */
class UI {
  constructor(app) {
    this.app = app;
    this._topbar();
    this._tabs();
    this.buildRenderTab();
    this.buildProcessTab();
    this.buildAnalyzeTab();
    this.buildExportTab();
    this.refreshLayers();
    this.refreshInfo();
    $('#zSlider').addEventListener('input', (e) => { if (!app.dims) return; app.cursor[2] = +e.target.value - 1; app.cursorChanged(); });
  }

  _topbar() {
    const app = this.app;
    $('#btnOpen').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) app.openFile(f); });
    $('#btnDemo').addEventListener('click', () => this.modal('Demo volumes', h('div', null,
      h('p', { class: 'muted' }, 'Synthetic stacks with known ground truth for trying the tools.'),
      h('div', { class: 'btns' },
        h('button', { class: 'primary', onclick: () => { this.closeModal(); makeDenseSCDemo(app, { seed: 1 + Math.floor(Math.random() * 1000) }); this.showTab('analyze'); }, title: 'Modelled on a real ZYP1 3D-SIM stack: 4 long SCs (~170 µm in total) packed into a 6.5 µm nucleus, with SIM-like blur, ringing and noise. A new random nucleus each time.' }, 'Dense pachytene — SIM-like, 4 SCs'),
        h('button', { onclick: () => { this.closeModal(); makeSCDemo(app); this.showTab('analyze'); } }, 'Sparse pachytene — 4 short SCs'),
        h('button', { onclick: () => { this.closeModal(); makeDemoVolume(app); } }, 'Turing pattern — spots and stripes'))),
      [h('button', { onclick: () => this.closeModal() }, 'Cancel')]));
    $('#projXY').addEventListener('change', (e) => { app.projectXY = e.target.checked; this.traceProjAuto = false; /* your choice wins over Edit mode's */ app.displayVersion++; app.requestRender('2d'); if (this.refreshTraceSelection) this.refreshTraceSelection(); });
    $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => app.setView(b.dataset.view)));
    $('#btnSnap').addEventListener('click', () => app.snapshot(1));
    $('#btnHelp').addEventListener('click', () => this.toggleHelp());
    $('#btnCancel').addEventListener('click', () => app.cancelTask());
    $('#btnLayerUp').addEventListener('click', () => app.selected && app.moveLayer(app.selectedId, -1));
    $('#btnLayerDown').addEventListener('click', () => app.selected && app.moveLayer(app.selectedId, 1));
    $('#btnLayerDup').addEventListener('click', () => {
      const L = app.selected;
      if (!L) return;
      app.addLayer({ name: L.name + ' copy', kind: L.kind, data: L.data.slice(), dtype: L.dtype, range: L.range.slice(), history: L.history.slice(), source: L.source, disp: { cmap: L.disp.cmap, color: L.disp.color } });
    });
    $('#btnLayerDel').addEventListener('click', () => {
      const L = app.selected;
      if (!L) return;
      if (confirm(`Delete layer "${L.name}"? This cannot be undone.`)) { app.removeLayer(L.id); app.log('Deleted layer "' + L.name + '"'); }
    });
  }
  _tabs() {
    $$('#right .tabs button').forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab)));
    this.showTab('render');
  }
  showTab(name) {
    if (window.AppLayout) window.AppLayout.show('right'); // a hidden tools panel opens (Ctrl+S, Edit by hand now…)
    $$('#right .tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('#right .tabpage').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    if (name === 'export') this.refreshExport();
  }

  volumeChanged() {
    this.refreshInfo();
    this.refreshRender();
    if (this.opForm) this.opForm.resetDefaults();
    Object.values(this.anaForms || {}).forEach((f) => f.resetDefaults());
    this.refreshAnalyzeResults();
    if (this.refreshTrace) this.refreshTrace();
    this.syncTool();
    this.refreshExport();
    this.refreshHistory();
    this.syncZSlider();
  }

  // ----------------------------------------------------------- layers list
  refreshLayers() {
    const app = this.app, list = $('#layerList');
    list.innerHTML = '';
    if (!app.layers.length) list.append(h('div', { class: 'empty' }, 'No data loaded'));
    app.layers.forEach((L) => list.append(this._layerRow(L)));
    if (app.points) {
      const P = app.points;
      const eye = h('input', { type: 'checkbox', class: 'eye', checked: P.visible, title: 'Show / hide' });
      eye.addEventListener('change', () => { P.visible = eye.checked; app.requestRender(); });
      const col = h('input', { type: 'color', value: P.color, class: 'mini-color', title: 'Colour' });
      col.addEventListener('input', () => { P.color = col.value; app.requestRender(); });
      const del = h('button', { class: 'icon', title: 'Remove spots', onclick: () => { app.points = null; this.refreshLayers(); this.refreshAnalyzeResults(); app.requestRender(); } }, '×');
      list.append(h('div', { class: 'layer-row points' }, eye, col, h('span', { class: 'lname' }, P.name), h('span', { class: 'ltag' }, P.list.length + ' pts'), del));
    }
    this.refreshLayerPanel();
    if (this.opForm) this.opForm.refreshInputs();
    Object.values(this.anaForms || {}).forEach((f) => f.refreshInputs());
    this.refreshExport();
  }
  _swatch(L) {
    if (L.kind === 'labels') return 'conic-gradient(#e6194b, #3cb44b, #ffe119, #4363d8, #f58231, #911eb4, #46f0f0, #e6194b)';
    if (L.kind === 'mask') return L.disp.color;
    return Colormaps.gradientCSS(L.disp.cmap, L.disp.color);
  }
  _layerRow(L) {
    const app = this.app;
    const eye = h('input', { type: 'checkbox', class: 'eye', checked: L.disp.visible, title: 'Show / hide (← →)' });
    eye.addEventListener('click', (e) => e.stopPropagation());
    eye.addEventListener('change', () => {
      L.disp.visible = eye.checked;
      if (L.kind === 'labels' && eye.checked) app.layers.forEach((q) => { if (q !== L && q.kind === 'labels' && q.disp.visible) { q.disp.visible = false; this.refreshLayerRow(q); } });
      app.displayChanged(L);
    });
    const name = h('span', { class: 'lname', title: L.name + '\n' + L.history.join('\n → ') }, L.name);
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const inp = h('input', { type: 'text', value: L.name, class: 'rename' });
      name.replaceWith(inp); inp.focus(); inp.select();
      const done = () => { L.name = inp.value.trim() || L.name; app.layersChanged(); };
      inp.addEventListener('blur', done);
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = L.name; inp.blur(); } });
    });
    const row = h('div', { class: 'layer-row' + (L.id === app.selectedId ? ' sel' : ''), 'data-id': L.id },
      eye, h('span', { class: 'swatch', style: { background: this._swatch(L) } }), name,
      L.kind !== 'intensity' ? h('span', { class: 'ltag ' + L.kind }, L.kind) : h('span', { class: 'ltag' }, L.dtype.replace('uint', 'u').replace('float', 'f')));
    row.addEventListener('click', () => { if (app.selectedId !== L.id) { app.selectedId = L.id; $$('.layer-row').forEach((r) => r.classList.toggle('sel', +r.dataset.id === L.id)); this.refreshLayerPanel(); } });
    return row;
  }
  refreshLayerRow(L) {
    if (!L) return;
    const r = $(`.layer-row[data-id="${L.id}"]`);
    if (!r) return;
    r.querySelector('.swatch').style.background = this._swatch(L);
    r.querySelector('.eye').checked = L.disp.visible;
  }
  refreshMemory() {
    const b = this.app.layers.reduce((s, L) => s + L.data.byteLength, 0);
    $('#memInfo').textContent = this.app.layers.length ? this.app.layers.length + ' layers · ' + fmtBytes(b) : '';
  }

  // ----------------------------------------------------------- layer display panel
  refreshLayerPanel() {
    const app = this.app, host = $('#layerPanel'), L = app.selected;
    host.innerHTML = '';
    if (!L) return;
    const changed = () => app.displayChanged(L);
    host.append(h('h2', null, 'Display · ' + (L.name.length > 26 ? L.name.slice(0, 25) + '…' : L.name)));
    if (L.kind === 'intensity') {
      const hw = new HistWidget(app, L, () => { lo.set(L.disp.lo, true); hi.set(L.disp.hi, true); changed(); });
      this.hist = hw;
      host.append(hw.canvas);
      const [r0, r1] = L.range, st = L.dtype === 'float32' ? (r1 - r0) / 1000 || 0.001 : 1;
      const lo = sliderRow({ label: 'Min', min: r0, max: r1, step: st, value: L.disp.lo, onInput: (v) => { L.disp.lo = Math.min(v, L.disp.hi); hw.draw(); changed(); } });
      const hi = sliderRow({ label: 'Max', min: r0, max: r1, step: st, value: L.disp.hi, onInput: (v) => { L.disp.hi = Math.max(v, L.disp.lo); hw.draw(); changed(); } });
      const setLH = (a, b) => { L.disp.lo = a; L.disp.hi = b > a ? b : a + st; lo.set(L.disp.lo, true); hi.set(L.disp.hi, true); hw.draw(); changed(); };
      host.append(lo.el, hi.el, h('div', { class: 'btns' },
        h('button', { onclick: () => setLH(L.pct(0.05), L.pct(99.95)), title: 'Saturate 0.05 % at both ends' }, 'Auto'),
        h('button', { onclick: () => setLH(L.pct(1), L.pct(99.5)), title: 'Stronger stretch: 1 % – 99.5 %' }, 'Auto+'),
        h('button', { onclick: () => setLH(r0, r1) }, 'Min–max'),
        h('button', { onclick: () => { app.layers.filter((q) => q.kind === 'intensity' && q !== L).forEach((q) => { q.disp.lo = q.pct(0.05); q.disp.hi = q.pct(99.95); app.displayChanged(q, { skipList: true }); }); this.refreshLayers(); }, title: 'Auto-contrast every other intensity layer' }, 'Auto all')));
      const cm = selectEl(Colormaps.NAMES, L.disp.cmap, (v) => { L.disp.cmap = v; colRow.style.display = v === 'custom' ? '' : 'none'; hw.draw(); changed(); });
      host.append(row2('Colour map', cm));
      const col = h('input', { type: 'color', value: L.disp.color });
      col.addEventListener('input', () => { L.disp.color = col.value; hw.draw(); changed(); });
      const colRow = row2('Colour', col);
      colRow.style.display = L.disp.cmap === 'custom' ? '' : 'none';
      host.append(colRow);
      host.append(sliderRow({ label: 'Gamma', min: 0.1, max: 5, log: true, step: 0.01, value: L.disp.gamma, onInput: (v) => { L.disp.gamma = v; hw.draw(); changed(); } }).el);
      host.append(sliderRow({ label: 'Opacity', min: 0, max: 1, step: 0.01, value: L.disp.opacity, onInput: (v) => { L.disp.opacity = v; changed(); } }).el);
      host.append(sliderRow({ label: 'Iso level', min: r0, max: r1, step: st, value: L.disp.iso, hint: 'Surface threshold used by the Iso-surface render mode', onInput: (v) => { L.disp.iso = v; app.requestRender('3d'); } }).el);
    } else if (L.kind === 'mask') {
      const col = h('input', { type: 'color', value: L.disp.color });
      col.addEventListener('input', () => { L.disp.color = col.value; changed(); });
      host.append(row2('Colour', col));
      host.append(sliderRow({ label: 'Opacity', min: 0, max: 1, step: 0.01, value: L.disp.opacity, onInput: (v) => { L.disp.opacity = v; changed(); } }).el);
      let n = 0; for (let i = 0; i < L.data.length; i++) n += L.data[i];
      host.append(h('p', { class: 'muted small' }, `${n.toLocaleString()} voxels (${(n / L.data.length * 100).toFixed(2)} %) · ${fmtNum(n * app.spacing[0] * app.spacing[1] * app.spacing[2])} µm³. Tip: use Iso-surface mode for a solid 3D view.`));
    } else if (L.kind === 'labels') {
      host.append(sliderRow({ label: 'Opacity', min: 0, max: 1, step: 0.01, value: L.disp.opacity, onInput: (v) => { L.disp.opacity = v; changed(); } }).el);
      host.append(check('Outlines only (slices)', L.disp.outline, (v) => { L.disp.outline = v; changed(); }));
      host.append(check('Show only the selected object', L.disp.onlySelected, (v) => { L.disp.onlySelected = v; changed(); }));
      host.append(h('p', { class: 'muted small' }, `${L.range[1].toLocaleString()} objects. Click an object in a slice view to select it.`),
        h('div', { class: 'btns' }, h('button', { onclick: () => { this.showTab('analyze'); this.anaForms.measure.inputSel[0].value = L.id; this.anaForms.measure.apply(); } }, 'Measure objects')));
    }
    host.append(h('details', { class: 'hist-log' }, h('summary', null, 'Provenance · ' + L.dtype + ' · range ' + fmtNum(L.range[0]) + '–' + fmtNum(L.range[1]) + ' · ' + fmtBytes(L.data.byteLength)),
      h('ol', null, L.history.map((s) => h('li', null, s)))));
  }

  // ----------------------------------------------------------- info panel
  refreshInfo() {
    const app = this.app, host = $('#infoPanel');
    host.innerHTML = '';
    if (!app.dims) return;
    const m = app.meta || {}, info = m.info || {}, v = app.vol || {};
    const [W, H, D] = app.dims;
    const rows = [];
    const add = (k, val) => { if (val != null && val !== '') rows.push(h('tr', null, h('th', null, k), h('td', null, String(val)))); };
    add('File', v.fileName || v.name);
    add('Size', `${W} × ${H} × ${D} voxels`);
    add('Extent', `${fmtNum(W * app.spacing[0])} × ${fmtNum(H * app.spacing[1])} × ${fmtNum(D * app.spacing[2])} µm`);
    if (v.summary) {
      add('Pixel type', v.summary.pixelTypes.join(', ') + (info.bitCount ? ` (${info.bitCount}-bit)` : ''));
      add('Compression', v.summary.compressions.join(', '));
      const d = v.summary.dims;
      const extra = Object.keys(d).filter((k) => !['C', 'Z'].includes(k) && d[k].length > 1).map((k) => `${k}: ${d[k].length}`);
      if (extra.length) add('Other dims', extra.join(', ') + (v.selection ? ` (loaded S=${v.selection.scene ?? 0}, T=${v.selection.t ?? 0})` : ''));
      if (v.bin > 1) add('Binning on load', v.bin + '×' + v.bin);
    }
    add('Objective', info.objective ? info.objective + (info.na ? ` · NA ${info.na}` : '') + (info.immersion ? ` · ${info.immersion}` : '') : null);
    add('Microscope', info.microscope);
    add('Acquired', info.acquired || info.created);
    (m.channels || []).forEach((c, i) => add('Ch ' + (i + 1), [c.name, c.fluor, c.excitation && 'ex ' + Math.round(c.excitation) + ' nm', c.emission && 'em ' + Math.round(c.emission) + ' nm', c.mode].filter(Boolean).join(' · ')));
    const sp = app.spacing.map((s) => h('input', { type: 'number', step: 'any', value: +s.toPrecision(5), class: 'vox' }));
    const apply = h('button', { onclick: () => { const vals = sp.map((i) => parseFloat(i.value)); if (vals.every((x) => x > 0)) { app.setSpacing(vals); app.log('Voxel size set to ' + vals.join(' × ') + ' µm'); } } }, 'Apply');
    host.append(h('details', { open: true }, h('summary', null, 'File info'),
      h('table', { class: 'info' }, rows),
      h('div', { class: 'vox-row' }, h('label', null, 'Voxel size (µm)'), h('div', null, 'x', sp[0], 'y', sp[1], 'z', sp[2], apply))));
  }

  // ----------------------------------------------------------- render tab
  buildRenderTab() {
    const app = this.app, rs = app.rs, host = $('#tab-render');
    const R = () => app.requestRender('3d');
    const modes = [['mip', 'MIP', 'Maximum intensity projection'], ['amip', 'Att. MIP', 'Attenuated MIP: maximum weighted by depth, gives depth cues'], ['dvr', 'Translucent', 'Alpha-blended volume rendering'], ['iso', 'Iso-surface', 'Shaded surfaces at each layer\'s Iso level'], ['minip', 'MinIP', 'Minimum intensity projection'], ['avg', 'Average', 'Mean intensity along the ray']];
    const seg = h('div', { class: 'seg grid3' }, modes.map(([k, l, t]) => h('button', { 'data-mode': k, title: t, onclick: () => { rs.mode = k; syncMode(); R(); } }, l)));
    const syncMode = () => {
      $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.mode === rs.mode));
      dens.el.style.display = rs.mode === 'dvr' ? '' : 'none';
      att.el.style.display = rs.mode === 'amip' ? '' : 'none';
      isoHint.style.display = rs.mode === 'iso' ? '' : 'none';
    };
    const dens = sliderRow({ label: 'Density', min: 0.02, max: 10, log: true, step: 0.01, value: rs.density, onInput: (v) => { rs.density = v; R(); } });
    const att = sliderRow({ label: 'Attenuation', min: 0.1, max: 50, log: true, step: 0.1, value: rs.attenuation, onInput: (v) => { rs.attenuation = v; R(); } });
    const isoHint = h('p', { class: 'muted small' }, 'Each visible layer is drawn as a surface at its Iso level (left panel). Opacity below 1 makes surfaces see-through.');
    host.append(h('h2', null, 'Rendering'), seg, dens.el, att.el, isoHint,
      sliderRow({ label: 'Quality', min: 0.25, max: 4, log: true, step: 0.05, value: rs.quality, hint: 'Samples per voxel along each ray', onInput: (v) => { rs.quality = v; R(); } }).el);
    const proj = selectEl([['ortho', 'Orthographic'], ['persp', 'Perspective']], rs.ortho ? 'ortho' : 'persp', (v) => { rs.ortho = v === 'ortho'; fov.el.style.display = rs.ortho ? 'none' : ''; R(); });
    const fov = sliderRow({ label: 'Field of view', min: 10, max: 80, step: 1, value: 30, onInput: (v) => { app.renderer && (app.renderer.camera.fov = v); R(); } });
    fov.el.style.display = 'none';
    const bg = h('input', { type: 'color', value: app.bgColor });
    bg.addEventListener('input', () => { app.bgColor = bg.value; app.displayVersion++; app.requestRender(); });
    const bgp = (c) => h('button', { class: 'chip', style: { background: c }, title: c, onclick: () => { bg.value = c; app.bgColor = c; app.requestRender(); } });
    const budget = selectEl([['auto', 'Auto (≤ 96 M voxels / layer)'], ['full', 'Full resolution'], ['fast', 'Fast (≤ 12 M voxels)']], rs.budget, (v) => { rs.budget = v; app.reuploadAll(); });
    this.gpuInfo = h('p', { class: 'muted small' });
    host.append(row2('Projection', proj), fov.el, row2('Background', h('div', { class: 'inline' }, bg, bgp('#000000'), bgp('#1b1e24'), bgp('#808080'), bgp('#ffffff'))),
      row2('3D resolution', budget), this.gpuInfo,
      h('div', { class: 'checks' },
        check('Bounding box', rs.showBox, (v) => { rs.showBox = v; R(); }),
        check('Axes', rs.showAxes, (v) => { rs.showAxes = v; R(); }),
        check('Scale bar', rs.showScale, (v) => { rs.showScale = v; app.showScaleBar = v; app.displayVersion++; app.requestRender(); }),
        check('Crosshair (slices)', app.showCrosshair, (v) => { app.showCrosshair = v; app.requestRender('2d'); })));
    // clipping
    this.clipHost = h('div');
    const plane = rs.plane;
    const pAxis = selectEl([['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['view', 'Facing camera']], plane.axis, (v) => { plane.axis = v; R(); });
    const pPos = sliderRow({ label: 'Position', min: 0, max: 1, step: 0.001, value: plane.pos, onInput: (v) => { plane.pos = v; R(); } });
    host.append(h('h2', null, 'Clipping box'), this.clipHost,
      h('div', { class: 'btns' }, h('button', { onclick: () => { rs.box = [0, 0, 0, 1, 1, 1]; this.refreshRender(); R(); } }, 'Reset box'), h('button', { onclick: () => { this.showTab('process'); app.cropToBox(); } , title: 'Permanently crop every layer to the box' }, 'Crop data to box')),
      h('h2', null, 'Clipping plane'), check('Enable clipping plane', plane.on, (v) => { plane.on = v; R(); }), row2('Normal', pAxis), pPos.el, check('Flip side', plane.flip, (v) => { plane.flip = v; R(); }));
    // camera
    const view = (v) => { if (!app.renderer) return; app.renderer.camera.reset(v); R(); };
    this.autoRot = check('Auto-rotate (Space)', rs.autoRotate, (v) => { rs.autoRotate = v; R(); });
    host.append(h('h2', null, 'Camera'),
      h('div', { class: 'btns' }, h('button', { onclick: () => view('oblique') }, '3D'), h('button', { onclick: () => view('xy') }, 'XY'), h('button', { onclick: () => view('xz') }, 'XZ'), h('button', { onclick: () => view('yz') }, 'YZ')),
      this.autoRot, sliderRow({ label: 'Speed (°/s)', min: 2, max: 120, step: 1, value: rs.rotSpeed, onInput: (v) => { rs.rotSpeed = v; } }).el,
      h('p', { class: 'muted small' }, 'Drag = rotate · Shift/right-drag = pan · Alt-drag = roll · wheel = zoom · double-click = reset.'));
    syncMode();
  }
  refreshRender() {
    const app = this.app, rs = app.rs, host = this.clipHost;
    if (!host) return;
    host.innerHTML = '';
    if (!app.dims) { host.append(h('p', { class: 'muted small' }, 'Load data to set clipping.')); return; }
    ['X', 'Y', 'Z'].forEach((ax, k) => {
      const n = app.dims[k];
      const a = sliderRow({ label: ax + ' min', min: 0, max: n, step: 1, value: Math.round(rs.box[k] * n), onInput: (v) => { rs.box[k] = Math.min(v / n, rs.box[k + 3] - 1 / n); app.requestRender('3d'); } });
      const b = sliderRow({ label: ax + ' max', min: 0, max: n, step: 1, value: Math.round(rs.box[k + 3] * n), onInput: (v) => { rs.box[k + 3] = Math.max(v / n, rs.box[k] + 1 / n); app.requestRender('3d'); } });
      host.append(a.el, b.el);
    });
    this.refreshRenderInfo();
  }
  refreshRenderInfo() {
    if (!this.gpuInfo) return;
    const L = this.app.layers.find((q) => q.gpu);
    this.gpuInfo.textContent = L ? `GPU volume ${L.gpu.dims.join('×')}` + (L.gpu.factor[0] > 1 || L.gpu.factor[1] > 1 ? ` (downsampled ${L.gpu.factor[0]}× XY, ${L.gpu.factor[1]}× Z for display only)` : ' (full resolution)') + ` · max 3D texture ${this.app.renderer ? this.app.renderer.maxTex3D : '?'}` : '';
  }
  syncAutoRotate() { if (this.autoRot) this.autoRot.querySelector('input').checked = this.app.rs.autoRotate; }
  syncZSlider() {
    const app = this.app, s = $('#zSlider');
    if (!app.dims) return;
    s.max = app.dims[2]; s.value = app.cursor[2] + 1;
    $('#zLabel').textContent = `z ${app.cursor[2] + 1} / ${app.dims[2]}  ·  ${(app.cursor[2] * app.spacing[2]).toFixed(2)} µm`;
  }

  // ----------------------------------------------------------- process tab
  buildProcessTab() {
    const app = this.app, host = $('#tab-process');
    const sel = h('select', { class: 'opselect' }, OP_GROUPS.map((g) => h('optgroup', { label: g.group }, g.items.map((o) => h('option', { value: o.id }, o.name)))));
    this.formHost = h('div');
    sel.addEventListener('change', () => this.showOp(sel.value));
    this.opSelect = sel;
    host.append(h('h2', null, 'Operation'), sel, this.formHost,
      h('h2', null, 'Whole volume'),
      h('p', { class: 'muted small' }, 'These change the geometry of every layer.'),
      h('div', { class: 'btns' },
        h('button', { onclick: () => app.cropToBox(), title: 'Uses the clipping box from the Render tab' }, 'Crop to clipping box'),
        h('button', { onclick: () => app.binVolume(2, 1) }, 'Bin 2×2 (XY)'),
        h('button', { onclick: () => app.binVolume(2, 2) }, 'Bin 2×2×2')),
      h('h2', null, 'Processing log'), this.historyEl = h('ol', { class: 'log' }),
      h('div', { class: 'btns' }, h('button', { onclick: () => this.copyLog() }, 'Copy log'), h('button', { onclick: () => download(new Blob([this.logText()], { type: 'text/plain' }), (app.vol ? app.vol.name : 'volume') + '_processing-log.txt') }, 'Save log')));
    this.showOp('gaussian');
  }
  showOp(id) {
    if (this.opForm) this.opForm.stopPreview();
    this.opSelect.value = id;
    this.opForm = new OpForm(this, OP_INDEX[id]);
    this.formHost.innerHTML = '';
    this.formHost.append(this.opForm.el);
  }
  logText() { return this.app.history.map((e) => e.time.toLocaleTimeString() + '  ' + e.msg).join('\n'); }
  copyLog() { navigator.clipboard.writeText(this.logText()).then(() => this.app.toast('Log copied'), () => this.app.toast('Could not access the clipboard')); }
  refreshHistory() {
    if (!this.historyEl) return;
    this.historyEl.innerHTML = '';
    this.app.history.slice(-60).forEach((e) => this.historyEl.append(h('li', null, h('span', { class: 'muted' }, e.time.toLocaleTimeString() + ' '), e.msg)));
    this.historyEl.scrollTop = 1e9;
  }

  // ----------------------------------------------------------- analyze tab
  buildAnalyzeTab() {
    const app = this.app, host = $('#tab-analyze');
    this.anaForms = {};
    const sec = (title, sub, form, resHost) => h('details', { class: 'section', open: true }, h('summary', null, title), sub ? h('p', { class: 'desc' }, sub) : null, form ? form.el : null, resHost);
    // spots
    this.anaForms.spots = new OpForm(this, ANALYSIS_DEFS.spots, { noDesc: true, applyLabel: 'Detect spots', onApply: (inp, p) => this.runSpots(inp, p) });
    this.spotsRes = h('div', { class: 'result' });
    // measure
    this.anaForms.measure = new OpForm(this, ANALYSIS_DEFS.measure, { noDesc: true, applyLabel: 'Measure', onApply: (inp, p) => this.runMeasure(inp, p) });
    this.measureRes = h('div', { class: 'result' });
    // spectrum
    this.anaForms.spectrum = new OpForm(this, ANALYSIS_DEFS.spectrum, { noDesc: true, applyLabel: 'Compute spectrum', onApply: (inp, p) => this.runSpectrum(inp, p) });
    this.specRes = h('div', { class: 'result' });
    // profile
    this.lineBtn = h('button', { class: 'wide', onclick: () => { app.tool = app.tool === 'line' ? null : 'line'; if (app.traceEditOff) app.traceEditOff(); if (app.tool && app.view === '3d') app.setView('xy'); this.syncTool(); } }, 'Draw line on XY slice');
    this.profRes = h('div', { class: 'result' });
    host.append(
      this.buildTraceSection(),
      sec('Spot detection', 'Finds bright, roughly round spots (LoG detector with sub-voxel refinement). Reports spacing statistics useful for periodic patterns.', this.anaForms.spots, this.spotsRes),
      sec('Object measurements', 'Volume, surface, shape and intensity for every labelled object. A mask is labelled automatically.', this.anaForms.measure, this.measureRes),
      sec('Pattern spectrum (periodicity)', 'Radially averaged power spectrum of a projection: dominant wavelength (pattern spacing) and how strongly the pattern is oriented (stripes ≈ 1, spots/labyrinths ≈ 0).', this.anaForms.spectrum, this.specRes),
      sec('Line profile', 'Drag on the XY slice (Shift = straight). Samples every visible intensity layer.', null, h('div', null, this.lineBtn, this.profRes)));
  }
  syncTool() {
    this.lineBtn.classList.toggle('on', this.app.tool === 'line');
    this.lineBtn.textContent = this.app.tool === 'line' ? 'Drawing… drag on the XY slice (Esc to stop)' : 'Draw line on XY slice';
    document.body.classList.toggle('tool-line', this.app.tool === 'line');
    document.body.classList.toggle('tool-trace', this.app.tool === 'trace');
    if (this.app.trace && this.traceRes) this.refreshTrace();
  }
  labelSelected(id) {
    if (!this.tableBody) return;
    $$('tr', this.tableBody).forEach((tr) => tr.classList.toggle('sel', +tr.dataset.label === id));
    const tr = $(`tr[data-label="${id}"]`, this.tableBody);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }

  async runSpots(inp, p) {
    const app = this.app, src = inp[0];
    const r = await app.runOp(Object.assign({}, ANALYSIS_DEFS.spots, { short: () => 'Spots' }), [src], p);
    if (!r) return;
    app.points = { list: r.res.points, visible: true, color: '#ffd166', size: 3, diameter: +p.diameter, name: 'Spots · ' + src.name, source: src.name };
    this.refreshLayers();
    this.refreshAnalyzeResults();
    app.requestRender();
  }
  async runMeasure(inp, p) {
    const app = this.app;
    const r = await app.runOp(ANALYSIS_DEFS.measure, inp, p);
    if (!r) return;
    app.table = { rows: r.res.table, labels: inp[0], intensity: inp[1], sort: ['label', 1], filter: null };
    this.refreshAnalyzeResults();
  }
  async runSpectrum(inp, p) {
    const app = this.app;
    p.z = app.cursor[2];
    const r = await app.runOp(ANALYSIS_DEFS.spectrum, inp, p);
    if (!r) return;
    this.spectrum = Object.assign({ source: inp[0].name, mode: p.source }, r.res.spectrum);
    this.refreshAnalyzeResults();
  }
  /** Spacing statistics. Clark–Evans R (no edge correction) uses the points' own bounding box:
   *  2D = XY projection (right for patterns on a sheet), 3D = true 3D distances in the box volume. */
  pointStats(list) {
    const app = this.app, [sx, sy, sz] = app.spacing;
    const n = list.length;
    if (n < 3) return null;
    const meanOf = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const nn3 = list.map((q) => q.nnd).filter((v) => v != null && isFinite(v));
    const nn2 = app.proc.nnd(list.map((q) => [q.x * sx, q.y * sy, 0])).filter((v) => v != null && isFinite(v));
    const ext = (k, s) => { const v = list.map((q) => q[k] * s); return Math.max(...v) - Math.min(...v); };
    const ex = Math.max(ext('x', sx), sx), ey = Math.max(ext('y', sy), sy), ez = Math.max(ext('z', sz), sz);
    const m3 = meanOf(nn3), m2 = meanOf(nn2);
    const sd = Math.sqrt(meanOf(nn3.map((v) => (v - m3) ** 2)));
    const d2 = n / (ex * ey), d3 = n / (ex * ey * ez);
    const R2 = m2 / (0.5 / Math.sqrt(d2)), R3 = m3 / (0.55396 * Math.pow(d3, -1 / 3));
    return { n, mean: m3, mean2: m2, sd, cv: sd / m3, R2, R3, d2, d3 };
  }
  refreshAnalyzeResults() {
    const app = this.app;
    if (!this.spotsRes) return;
    // spots
    this.spotsRes.innerHTML = '';
    if (app.points) {
      const P = app.points, st = this.pointStats(P.list);
      const cols = [['x', 'x_px'], ['y', 'y_px'], ['z', 'z_px'], [(q) => q.x * app.spacing[0], 'x_um'], [(q) => q.y * app.spacing[1], 'y_um'], [(q) => q.z * app.spacing[2], 'z_um'], ['response', 'log_response'], ['intensity', 'intensity'], ['nnd', 'nearest_neighbour_um']];
      this.spotsRes.append(
        h('div', { class: 'stats' },
          stat('Spots', P.list.length.toLocaleString()),
          st ? stat('Mean NN distance', fmtNum(st.mean) + ' µm', '3D · ± ' + fmtNum(st.sd) + ' µm (CV ' + (st.cv * 100).toFixed(0) + ' %)') : null,
          st ? stat('Clark–Evans R (XY)', st.R2.toFixed(2), ceWord(st.R2) + ' · ' + fmtNum(st.d2) + ' /µm²') : null,
          st ? stat('Clark–Evans R (3D)', st.R3.toFixed(2), ceWord(st.R3) + ' · ' + fmtNum(st.d3) + ' /µm³') : null),
        st ? this._nndHist(P.list) : null,
        h('div', { class: 'btns' },
          h('button', { onclick: () => download(new Blob([toCSV(P.list, cols)], { type: 'text/csv' }), (app.vol ? app.vol.name : 'volume') + '_spots.csv') }, 'Export CSV'),
          h('label', { class: 'check inline-check' }, (() => { const c = h('input', { type: 'checkbox', checked: P.visible }); c.addEventListener('change', () => { P.visible = c.checked; this.refreshLayers(); app.requestRender(); }); return c; })(), 'Show')));
    }
    // measurements
    this.measureRes.innerHTML = '';
    this.tableBody = null;
    if (app.table) this.measureRes.append(this._table());
    // spectrum
    this.specRes.innerHTML = '';
    if (this.spectrum) this.specRes.append(this._spectrumView());
  }
  _nndHist(list) {
    const v = list.map((q) => q.nnd).filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
    const hi = v[Math.floor(v.length * 0.99)] * 1.15 || 1, nb = 30, bins = new Array(nb).fill(0);
    v.forEach((x) => { bins[Math.min(nb - 1, Math.floor(x / hi * nb))]++; });
    const cv = h('canvas', { class: 'chart' });
    requestAnimationFrame(() => lineChart(cv, { series: [{ name: 'Spots', color: '#ffd166', x: bins.map((_, i) => (i + 0.5) * hi / nb), y: bins }], xLabel: 'Nearest-neighbour distance (µm)', xUnit: 'µm' }));
    return cv;
  }
  _table() {
    const app = this.app, T = app.table;
    const hasI = T.rows.length && T.rows[0].mean != null;
    const is3D = app.dims[2] > 1;
    const COLS = [['label', 'ID'], ['volume', is3D ? 'Vol µm³' : 'Area µm²', (r) => (is3D ? r.volume : r.voxels * app.spacing[0] * app.spacing[1])], ['eqDiameter', 'Eq. diam µm'],
      is3D ? ['sphericity', 'Spheric.'] : null, ['elongation', 'Elong.'], ['nnd', 'NN µm'],
      hasI ? ['mean', 'Mean I'] : null, hasI ? ['sum', 'Sum I'] : null, ['border', 'Edge', (r) => (r.border ? '✓' : '')]].filter(Boolean);
    const filt = T.filter;
    let rows = T.rows.filter((r) => !filt || ((filt.min === '' || r[filt.col] >= +filt.min) && (filt.max === '' || r[filt.col] <= +filt.max) && (!filt.noBorder || !r.border)));
    const [sk, sd] = T.sort;
    rows = rows.slice().sort((a, b) => ((a[sk] ?? -Infinity) > (b[sk] ?? -Infinity) ? 1 : (a[sk] ?? -Infinity) < (b[sk] ?? -Infinity) ? -1 : 0) * sd);
    const vals = (k) => rows.map((r) => r[k]).filter((v) => v != null && isFinite(v));
    const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
    const sdv = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
    const vol = vals('volume');
    const head = h('tr', null, COLS.map((c) => h('th', { onclick: () => { T.sort = [c[0], T.sort[0] === c[0] ? -T.sort[1] : 1]; this.refreshAnalyzeResults(); } }, c[1] + (sk === c[0] ? (sd > 0 ? ' ▲' : ' ▼') : ''))));
    const body = h('tbody');
    rows.slice(0, 1500).forEach((r) => {
      const tr = h('tr', { 'data-label': r.label, class: r.label === app.selectedLabel ? 'sel' : null }, COLS.map((c) => h('td', null, c[2] ? (typeof c[2](r) === 'number' ? fmtNum(c[2](r)) : c[2](r)) : fmtNum(r[c[0]]))));
      tr.addEventListener('click', () => { app.selectLabel(r.label, true); this.labelSelected(r.label); });
      body.append(tr);
    });
    this.tableBody = body;
    const colSel = selectEl([['volume', 'Volume'], ['eqDiameter', 'Eq. diameter'], ['sphericity', 'Sphericity'], ['elongation', 'Elongation'], ['nnd', 'NN distance'], ['mean', 'Mean intensity'], ['sum', 'Sum intensity'], ['voxels', 'Voxels']], filt ? filt.col : 'volume');
    const fmin = h('input', { type: 'number', step: 'any', placeholder: 'min', value: filt ? filt.min : '' });
    const fmax = h('input', { type: 'number', step: 'any', placeholder: 'max', value: filt ? filt.max : '' });
    const fborder = h('input', { type: 'checkbox', checked: filt ? filt.noBorder : false });
    const applyF = () => { T.filter = { col: colSel.value, min: fmin.value, max: fmax.value, noBorder: fborder.checked }; this.refreshAnalyzeResults(); };
    [colSel, fmin, fmax, fborder].forEach((e) => e.addEventListener('change', applyF));
    const csvCols = [['label', 'label'], ['voxels', 'voxels'], ['volume', is3D ? 'volume_um3' : 'area_um2'], ['surface', 'surface_um2'], ['eqDiameter', 'equivalent_diameter_um'], ['sphericity', 'sphericity'], ['major', 'major_axis_um'], ['minor', 'minor_axis_um'], ['elongation', 'elongation'],
      ['cx', 'centroid_x_um'], ['cy', 'centroid_y_um'], ['cz', 'centroid_z_um'], ['nnd', 'nearest_neighbour_um'], ['border', 'touches_border'],
      ['mean', 'mean_intensity'], ['std', 'sd_intensity'], ['min', 'min_intensity'], ['max', 'max_intensity'], ['sum', 'integrated_intensity'], [(r) => r.bbox.join(' '), 'bbox_x0_y0_z0_x1_y1_z1']];
    return h('div', null,
      h('div', { class: 'stats' },
        stat('Objects', rows.length.toLocaleString() + (rows.length !== T.rows.length ? ' of ' + T.rows.length.toLocaleString() : '')),
        stat(is3D ? 'Mean volume' : 'Mean area', fmtNum(mean(vol)) + (is3D ? ' µm³' : ' µm²'), '± ' + fmtNum(sdv(vol))),
        stat('Mean NN dist.', fmtNum(mean(vals('nnd'))) + ' µm'),
        hasI ? stat('Mean intensity', fmtNum(mean(vals('mean')))) : null),
      h('div', { class: 'filter' }, h('span', { class: 'muted small' }, 'Filter'), colSel, fmin, fmax, h('label', { class: 'check inline-check', title: 'Exclude objects cut by the volume edge' }, fborder, 'no edge')),
      h('div', { class: 'tablewrap' }, h('table', { class: 'data' }, h('thead', null, head), body)),
      rows.length > 1500 ? h('p', { class: 'muted small' }, 'Showing the first 1,500 rows; the CSV contains all.') : null,
      h('div', { class: 'btns' },
        h('button', { onclick: () => download(new Blob([toCSV(rows, csvCols)], { type: 'text/csv' }), (app.vol ? app.vol.name : 'volume') + '_objects.csv') }, 'Export CSV'),
        h('button', {
          title: 'Create a new labels layer with only the objects passing the filter', disabled: !(T.labels && T.labels.kind === 'labels' && app.layers.includes(T.labels)),
          onclick: () => app.runOp({ id: 'keepLabels', name: 'Keep filtered objects', params: [], short: () => 'Filtered' }, [T.labels], { labels: rows.map((r) => r.label) }),
        }, 'Keep filtered → new layer')));
  }
  _spectrumView() {
    const S = this.spectrum, app = this.app;
    const cv = h('canvas', { class: 'chart' });
    const ps = h('canvas', { class: 'psimg', width: S.imgSize, height: S.imgSize, title: 'Log power spectrum (centre = zero frequency)' });
    const ctx = ps.getContext('2d'), img = ctx.createImageData(S.imgSize, S.imgSize), lut = Colormaps.lut('magma');
    for (let i = 0; i < S.img.length; i++) { const k = S.img[i] * 3; img.data[i * 4] = lut[k]; img.data[i * 4 + 1] = lut[k + 1]; img.data[i * 4 + 2] = lut[k + 2]; img.data[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    const n = S.k.length, xs = [], ys = [];
    for (let i = 1; i < n; i++) { xs.push(S.k[i]); ys.push(S.power[i]); }
    requestAnimationFrame(() => lineChart(cv, {
      series: [{ name: 'Power', color: '#5ec8a8', x: xs, y: ys }], xLabel: 'Spatial frequency (cycles/µm)', xUnit: 'cyc/µm', logY: true,
      marker: S.peakK ? { x: S.peakK, label: 'λ = ' + fmtNum(S.wavelength) + ' µm' } : null, xFmt: (v) => v.toFixed(2),
    }));
    const kind = S.order == null ? '' : S.order > 0.5 ? 'stripes (strongly oriented)' : S.order > 0.2 ? 'partly oriented' : 'isotropic (spots / labyrinth)';
    const cols = [['k', 'frequency_cyc_per_um'], [(r) => (r.k > 0 ? 1 / r.k : ''), 'wavelength_um'], ['p', 'radial_power']];
    const rows = S.k.map((k, i) => ({ k, p: S.power[i] }));
    return h('div', null,
      h('div', { class: 'stats' },
        stat('Dominant wavelength', S.wavelength ? fmtNum(S.wavelength) + ' µm' : 'none found', S.wavelength ? `spectral peak, ${(Math.exp(S.prominence) * 100 - 100).toFixed(0)} % above background` : 'no clear peak — try min/max wavelength'),
        S.order != null ? stat('Orientation order', S.order.toFixed(2), kind) : null,
        S.order != null && S.order > 0.2 ? stat('Wave-vector angle', S.angle.toFixed(0) + '°', 'stripes run at ' + ((S.angle + 90 + 180) % 180).toFixed(0) + '°') : null),
      h('div', { class: 'specrow' }, cv, ps),
      h('p', { class: 'muted small' }, `${S.source} · ${{ mip: 'max projection', mean: 'mean projection', slice: 'XY slice ' + (app.cursor[2] + 1) }[S.mode]}`),
      h('div', { class: 'btns' }, h('button', { onclick: () => download(new Blob([toCSV(rows, cols)], { type: 'text/csv' }), (app.vol ? app.vol.name : 'volume') + '_spectrum.csv') }, 'Export CSV')));
  }
  showProfile(prof) {
    const host = this.profRes;
    host.innerHTML = '';
    if (!prof) return;
    const cv = h('canvas', { class: 'chart' });
    const cols = [['d', 'distance_um']].concat(prof.series.map((s, i) => [(r) => r.v[i], s.name.replace(/[,\n]/g, ' ')]));
    const rows = prof.dist.map((d, j) => ({ d, v: prof.series.map((s) => s.y[j]) }));
    host.append(cv,
      prof.series.length > 1 ? h('div', { class: 'legend' }, prof.series.map((s) => h('span', null, h('i', { style: { background: s.color } }), s.name))) : null,
      h('p', { class: 'muted small' }, `Length ${fmtNum(prof.length)} µm · z ${this.app.cursor[2] + 1}`),
      h('div', { class: 'btns' }, h('button', { onclick: () => download(new Blob([toCSV(rows, cols)], { type: 'text/csv' }), 'line_profile.csv') }, 'Export CSV')));
    requestAnimationFrame(() => lineChart(cv, { series: prof.series.map((s) => ({ name: s.name, color: s.color, x: prof.dist, y: s.y })), xLabel: 'Distance (µm)', xUnit: 'µm' }));
  }

  // ----------------------------------------------------------- export tab
  buildExportTab() {
    const app = this.app, host = $('#tab-export');
    this.exp = { region: 'all', values: 'raw', pixelType: 'auto', floatMode: 'rescale', includeMeta: true, name: '' };
    this.expLayers = h('div', { class: 'checklist' });
    this.expInfo = h('p', { class: 'muted small' });
    this.expName = h('input', { type: 'text', placeholder: 'file name.czi' });
    const E = this.exp, upd = () => this.refreshExportInfo();
    host.append(h('h2', null, 'Export CZI'),
      h('p', { class: 'desc' }, 'Writes the chosen layers as channels of a new uncompressed .czi with voxel size, channel names/colours, display settings and the processing history in the metadata. Opens in ZEN, Fiji/Bio-Formats, napari and Python (pylibCZIrw, aicspylibczi).'),
      h('label', { class: 'sub' }, 'Layers → channels'), this.expLayers,
      row2('Region', selectEl([['all', 'Whole volume'], ['box', 'Clipping box only']], E.region, (v) => { E.region = v; upd(); })),
      row2('Values', selectEl([['raw', 'Data values'], ['display', 'Apply display contrast & gamma']], E.values, (v) => { E.values = v; upd(); }), 'Apply display bakes the current Min/Max/Gamma into the exported intensities'),
      row2('Pixel type', selectEl([['auto', 'Automatic'], ['Gray8', '8-bit'], ['Gray16', '16-bit'], ['Gray32Float', '32-bit float']], E.pixelType, (v) => { E.pixelType = v; upd(); })),
      row2('Float → integer', selectEl([['rescale', 'Rescale min–max to full range'], ['clip', 'Round & clip']], E.floatMode, (v) => { E.floatMode = v; upd(); })),
      check('Copy instrument & channel metadata from the source file', E.includeMeta, (v) => { E.includeMeta = v; }),
      row2('File name', this.expName), this.expInfo,
      h('button', { class: 'primary wide', onclick: () => app.exportCZI(this.exportOptions()) }, 'Export .czi…'),
      h('h2', null, 'Images & movies'),
      h('div', { class: 'btns' }, h('button', { onclick: () => app.snapshot(1) }, 'Snapshot PNG'), h('button', { onclick: () => app.snapshot(2), title: 'Re-renders the 3D view at twice the resolution' }, 'Snapshot 2×'), h('button', { onclick: () => app.snapshot(4) }, '4×')),
      h('div', { class: 'btns' }, h('button', { onclick: () => app.recordTurntable(8) }, 'Record 360° turntable (WebM)')),
      h('h2', null, 'Tables'),
      h('p', { class: 'muted small' }, 'Spot lists, object measurements, spectra and line profiles export from the Analyze tab; the processing log from the Process tab.'));
  }
  exportOptions() {
    const ids = $$('input[type=checkbox]', this.expLayers).filter((c) => c.checked).map((c) => +c.value);
    return Object.assign({}, this.exp, { layers: ids.map((id) => this.app.layer(id)).filter(Boolean), name: this.expName.value.trim() });
  }
  refreshExport() {
    if (!this.expLayers) return;
    const app = this.app, prev = new Map($$('input[type=checkbox]', this.expLayers).map((c) => [+c.value, c.checked]));
    this.expLayers.innerHTML = '';
    if (!app.layers.length) this.expLayers.append(h('p', { class: 'muted small' }, 'Nothing to export yet.'));
    app.layers.forEach((L) => { // same order as the Layers list (loaded channels keep their file order)
      const c = h('input', { type: 'checkbox', value: L.id, checked: prev.has(L.id) ? prev.get(L.id) : L.disp.visible });
      c.addEventListener('change', () => this.refreshExportInfo());
      this.expLayers.append(h('label', { class: 'check' }, c, h('span', { class: 'swatch', style: { background: this._swatch(L) } }), L.name, h('span', { class: 'muted small' }, ' ' + L.kind + ' · ' + L.dtype)));
    });
    if (app.vol && !this.expName.value) this.expName.value = app.vol.name.replace(/[\\/:*?"<>|]/g, '_') + '_processed.czi';
    this.refreshExportInfo();
  }
  refreshExportInfo() {
    if (!this.expInfo || !this.app.dims) return;
    const o = this.exportOptions(), plan = this.app.exportPlan(o);
    this.expInfo.textContent = plan.error ? '⚠ ' + plan.error : `${plan.dims.join(' × ')} × ${o.layers.length} channel(s), ${plan.pixelType} → ≈ ${fmtBytes(plan.bytes)}` + (plan.warnings.length ? ' · ' + plan.warnings.join(' · ') : '');
  }

  // ----------------------------------------------------------- dialogs
  modal(title, body, buttons) {
    const m = $('#modal');
    m.innerHTML = '';
    const box = h('div', { class: 'dialog' }, h('h3', null, title), body, h('div', { class: 'btns right' }, buttons));
    m.append(box);
    m.classList.remove('hidden');
    return box;
  }
  closeModal() { const m = $('#modal'); m.classList.add('hidden'); m.innerHTML = ''; if (this._modalResolve) { const r = this._modalResolve; this._modalResolve = null; r(null); } }
  toggleHelp() {
    if (!$('#modal').classList.contains('hidden')) return this.closeModal();
    const k = (a, b) => h('tr', null, h('td', null, h('kbd', null, a)), h('td', null, b));
    this.modal('SynaptoSnap — quick guide', h('div', { class: 'help' },
      h('p', null, 'Open a .czi (drag & drop works), adjust each channel in the left panel, choose a rendering style in the Render tab, process in the Process tab, quantify in Analyze and save a new .czi from Export. Every processing step creates a new layer, so the original data is never changed.'),
      h('table', null,
        k('Ctrl+O', 'Open CZI'), k('1 / 2 / 3', '3D / Slice / Ortho views'), k('Drag', 'Rotate (3D) · pan (slices)'), k('Shift-drag, right-drag', 'Pan (3D)'),
        k('Wheel', 'Zoom (3D) · change slice (2D)'), k('Ctrl+wheel', 'Zoom slices'), k('↑ ↓ / PgUp PgDn', 'Previous / next Z slice'), k('← →', 'Toggle selected layer'),
        k('Trace: click · click', 'Trace edit mode: points along a chromosome (the stretch between follows the image, also over existing traces) · near a trace\'s end then a point: extend it · near one trace\'s end then another\'s: join them (Shift+click selects a trace anywhere)'),
        k('Enter · right-click · Esc', 'Trace edit mode: finish the trace being drawn (Esc again leaves Edit mode)'), k('Backspace · Ctrl+Z', 'Trace edit mode: take back the last stretch · undo'), k('Alt + click', 'Trace: always place a point, even at a trace\'s end · Paint: one segment only'),
        k('1 (while tracing)', 'Trace: take the suggested way on (the dashed line from the end of your trace, shown only where it runs along the automatic trace and that is sure). While a trace is in progress the number keys only take suggestions; finish it (Esc) to pick another chromosome'),
        k('Shift+wheel · click on it', 'Trace: move where the suggestion stops (forward = longer) · take it up to the place clicked'),
        k('1–9 · 0 · Delete', 'Trace edit mode, no trace in progress: chromosome for new traces · Unassign · Erase tool (Select mode: assign / unassign / delete the selected segment)'), k('Shift + click', 'Paint / Route: add as shared stretch'), k('B', 'Trace edit mode: toggle gap bridge'),
        k('T', 'Show / hide all traces (single chromosomes: the ticks in the trace table)'), k('[ · ]', 'Previous / next segment along the chromosome, after picking one from a Segs dropdown in the trace table (Esc clears)'),
        k('Space', 'Auto-rotate'), k('R', 'Reset 3D view'), k('Click (slice)', 'Move cursor · select labelled object'), k('Double-click', 'Fit / reset view'), k('Esc', 'Cancel running task / close dialog'), k('Ctrl+S', 'Go to Export'), k('H', 'This help')),
      h('p', { class: 'muted small' }, 'Supported: uncompressed, zstd and JPEG compressed CZI; Gray 8/16/32-bit and RGB; Z-stacks, channels, scenes, time points, tiled mosaics. JPEG-XR compressed files must be re-saved from ZEN without that compression.')),
      [h('button', { class: 'primary', onclick: () => this.closeModal() }, 'Close')]);
  }

  /** Ask which part of a CZI to load when it has scenes / time points / is very large. Resolves to a selection or null. */
  loadDialog(S, meta, file) {
    const d = S.dims, zN = d.Z ? d.Z.length : 1, cVals = d.C || [0];
    const sceneVals = d.S || [null], tVals = d.T || [0];
    const box = (s) => S.sceneBoxes.find((b) => b.scene === s) || S.sceneBoxes[0];
    const bpp = /16/.test(S.pixelTypes[0]) ? 2 : /32|Float/.test(S.pixelTypes[0]) ? 4 : 1;
    const comps = /Bgr/.test(S.pixelTypes[0]) ? 3 : 1;
    const sel = { scene: sceneVals[0], t: tVals[0], channels: cVals.slice(), z0: 0, z1: zN - 1, bin: 1 };
    const est = () => { const b = box(sel.scene); return Math.floor(b.width / sel.bin) * Math.floor(b.height / sel.bin) * (sel.z1 - sel.z0 + 1) * sel.channels.length * comps * bpp; };
    const extra = Object.keys(d).filter((k) => !['C', 'Z', 'S', 'T', 'M'].includes(k) && d[k].length > 1);
    const needDialog = sceneVals.length > 1 || tVals.length > 1 || extra.length || est() > 1.2e9 || cVals.length > 6;
    if (!needDialog) return Promise.resolve(sel);
    return new Promise((resolve) => {
      this._modalResolve = resolve;
      const info = h('p', { class: 'muted' });
      const upd = () => { const b = box(sel.scene); info.textContent = `${Math.floor(b.width / sel.bin)} × ${Math.floor(b.height / sel.bin)} × ${sel.z1 - sel.z0 + 1} voxels × ${sel.channels.length * comps} channel(s) ≈ ${fmtBytes(est())} in memory` + (est() > 2e9 ? ' — large! Consider binning or fewer Z slices.' : ''); };
      const rows = [];
      if (sceneVals.length > 1) rows.push(row2('Scene', selectEl(sceneVals.map((s) => [s, `Scene ${s + 1} (${box(s).width}×${box(s).height})`]), sel.scene, (v) => { sel.scene = +v; upd(); })));
      if (tVals.length > 1) rows.push(row2('Time point', selectEl(tVals.map((t) => [t, 'T ' + (t + 1)]), sel.t, (v) => { sel.t = +v; upd(); })));
      const chk = h('div', { class: 'checklist' }, cVals.map((c) => {
        const cb = h('input', { type: 'checkbox', checked: true });
        cb.addEventListener('change', () => { sel.channels = cb.checked ? Array.from(new Set(sel.channels.concat([c]))).sort((a, b) => a - b) : sel.channels.filter((x) => x !== c); upd(); });
        return h('label', { class: 'check' }, cb, (meta.channels[c] && meta.channels[c].name) || 'Channel ' + (c + 1));
      }));
      rows.push(h('label', { class: 'sub' }, 'Channels'), chk);
      if (zN > 1) {
        const z0 = h('input', { type: 'number', min: 1, max: zN, value: 1 }), z1 = h('input', { type: 'number', min: 1, max: zN, value: zN });
        const zc = () => { sel.z0 = Math.max(0, Math.min(zN - 1, (+z0.value || 1) - 1)); sel.z1 = Math.max(sel.z0, Math.min(zN - 1, (+z1.value || zN) - 1)); upd(); };
        z0.addEventListener('change', zc); z1.addEventListener('change', zc);
        rows.push(row2('Z slices', h('div', { class: 'inline' }, z0, ' to ', z1, ` of ${zN}`)));
      }
      rows.push(row2('XY binning', selectEl([[1, 'None (full resolution)'], [2, '2 × 2'], [4, '4 × 4'], [8, '8 × 8']], 1, (v) => { sel.bin = +v; upd(); })));
      if (extra.length) rows.push(h('p', { class: 'muted small' }, 'Other dimensions (' + extra.join(', ') + ') — the first index is loaded.'));
      upd();
      this.modal('Load ' + file.name, h('div', null, rows, info), [
        h('button', { onclick: () => this.closeModal() }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => { if (!sel.channels.length) return; this._modalResolve = null; this.closeModal(); resolve(sel); } }, 'Load'),
      ]);
    });
  }
}

function ceWord(R) { return R > 1.3 ? 'regular' : R < 0.8 ? 'clustered' : 'near random'; }
function stat(label, value, sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'stat-sub' }, sub) : null);
}
