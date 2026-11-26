/* Synthetic pachytene nucleus: N bivalents as worm-like synaptonemal-complex tracks (ZYP1-like),
 * confined to a sphere and avoiding each other, imaged with a Z-elongated PSF, with gaps and noise.
 * Ground truth (curves, lengths, voxel ownership) is kept in app.scTruth for validation. */
function makeSCDemo(app, opts = {}) {
  const lengths = opts.lengths || [13, 11, 10, 8];
  const R = opts.radius || 3.2, Rz = opts.radiusZ || 1.9, sx = 0.04, sz = 0.125;
  const W = Math.ceil((2 * R + 0.8) / sx), H = W, D = Math.ceil((2 * Rz + 1.4) / sz), P = W * H;
  const ell = (rel) => Math.hypot(rel[0] / R, rel[1] / R, rel[2] / Rz); // 1 = nuclear envelope
  let seed = opts.seed || 7;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const c0 = [W * sx / 2, H * sx / 2, D * sz / 2];
  const ds = 0.02, Lp = opts.persistence || 3, avoid = opts.avoid || 0.35, cell = avoid;
  const grid = new Map(), key = (p) => Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell) + ',' + Math.floor(p[2] / cell);
  const curves = [];
  lengths.forEach((L, ci) => {
    let best = null;
    for (let attempt = 0; attempt < 30 && !best; attempt++) {
      // start near the nuclear envelope, heading inward-ish
      const u = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, s = Math.sqrt(1 - u * u);
      const n0 = [s * Math.cos(ph), s * Math.sin(ph), u];
      let p = [c0[0] + n0[0] * R * 0.85, c0[1] + n0[1] * R * 0.85, c0[2] + n0[2] * Rz * 0.85];
      let t = [-n0[0] + gauss() * 0.6, -n0[1] + gauss() * 0.6, -n0[2] + gauss() * 0.6];
      let tl = Math.hypot(...t); t = t.map((v) => v / tl);
      const pts = [p.slice()];
      const own = new Map(); // self-avoidance (points more than ~0.6 µm back along the curve)
      let ok = true;
      for (let k = 0; k < L / ds; k++) {
        const sig = Math.sqrt(ds / Lp); // gives <θ²> = 2·ds/Lp for the two perpendicular components
        t = t.map((v) => v + gauss() * sig);
        const rel = p.map((v, k2) => v - c0[k2]), e = ell(rel);
        if (e > 0.8) { const gn = [rel[0] / (R * R), rel[1] / (R * R), rel[2] / (Rz * Rz)], gl = Math.hypot(...gn); t = t.map((v, k2) => v - (gn[k2] / gl) * (e - 0.8) * 4); }
        const kk = key(p).split(',').map(Number);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
          const kc = (kk[0] + a) + ',' + (kk[1] + b) + ',' + (kk[2] + c);
          for (const lst of [grid.get(kc), own.get(kc)]) {
            if (!lst) continue;
            for (const q of lst) {
              const d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]], dl = Math.hypot(...d);
              if (dl < avoid && dl > 1e-6) t = t.map((v, k2) => v + d[k2] / dl * (avoid - dl) * 4);
            }
          }
        }
        tl = Math.hypot(...t); t = t.map((v) => v / tl);
        p = p.map((v, k2) => v + t[k2] * ds);
        if (ell(p.map((v, k2) => v - c0[k2])) > 1) { ok = false; break; }
        pts.push(p.slice());
        if (pts.length > 30) { const q = pts[pts.length - 31], kq = key(q); if (!own.has(kq)) own.set(kq, []); own.get(kq).push(q); }
      }
      if (ok) best = pts;
    }
    if (!best) return;
    for (const q of best) { const kq = key(q); if (!grid.has(kq)) grid.set(kq, []); grid.get(kq).push(q); }
    curves.push({ id: ci + 1, pts: best, length: (best.length - 1) * ds });
  });
  // render: splat anisotropic Gaussians along each curve, remember which bivalent dominates each voxel
  const sgx = 0.06, sgz = 0.18, img = new Float32Array(P * D), wmax = new Float32Array(P * D), owner = new Uint8Array(P * D);
  const rx = Math.ceil(3 * sgx / sx), rz = Math.ceil(3 * sgz / sz);
  for (const cv of curves) {
    const n = cv.pts.length;
    const gaps = [];
    const nGaps = 1 + Math.floor(rnd() * 2);
    for (let g = 0; g < nGaps; g++) { const at = 0.15 + rnd() * 0.7, len = 0.15 + rnd() * 0.2; gaps.push([at * cv.length, at * cv.length + len]); }
    cv.gaps = gaps;
    let mod = 1, modT = 1;
    for (let i = 0; i < n; i++) {
      const s = i * ds;
      if (i % 25 === 0) modT = 0.65 + 0.35 * rnd();
      mod += (modT - mod) * 0.05;
      const inGap = gaps.some((g) => s >= g[0] && s <= g[1]);
      const amp = (inGap ? 0.08 : 1) * mod;
      const q = cv.pts[i], X = q[0] / sx, Y = q[1] / sx, Z = q[2] / sz;
      const x0 = Math.round(X), y0 = Math.round(Y), z0 = Math.round(Z);
      for (let dz = -rz; dz <= rz; dz++) {
        const z = z0 + dz; if (z < 0 || z >= D) continue;
        const fz = Math.exp(-(((z - Z) * sz) ** 2) / (2 * sgz * sgz));
        for (let dy = -rx; dy <= rx; dy++) {
          const y = y0 + dy; if (y < 0 || y >= H) continue;
          const fy = Math.exp(-(((y - Y) * sx) ** 2) / (2 * sgx * sgx));
          for (let dx = -rx; dx <= rx; dx++) {
            const x = x0 + dx; if (x < 0 || x >= W) continue;
            const w = fz * fy * Math.exp(-(((x - X) * sx) ** 2) / (2 * sgx * sgx));
            const v = (z * H + y) * W + x;
            img[v] += amp * w;
            if (w > wmax[v]) { wmax[v] = w; owner[v] = cv.id; }
          }
        }
      }
    }
  }
  let mx = 0;
  for (let i = 0; i < img.length; i++) if (img[i] > mx) mx = img[i];
  const out = new Uint16Array(P * D);
  for (let i = 0; i < img.length; i++) {
    const s = img[i] / mx * 2600;
    out[i] = Math.max(0, Math.min(4095, Math.round(90 + s + gauss() * Math.sqrt(3 * s + 40))));
  }
  app.scTruth = { curves, owner, dims: [W, H, D], spacing: [sx, sx, sz] };
  const meta = {
    scaling: { x: sx, y: sx, z: sz },
    channels: [{ name: 'ZYP1 (synthetic)', color: '#8a5cff', emission: '520' }],
    info: { objective: 'Synthetic 63×/1.4 Oil', na: 1.4, immersion: 'Oil', bitCount: 12, microscope: 'Simulated' },
    doc: null,
  };
  app.setVolume({
    name: 'Demo – synthetic pachytene (' + curves.length + ' bivalents)', fileName: 'demo (synthetic SC)', dims: [W, H, D], spacing: [sx, sx, sz], meta, xml: '',
    summary: { pixelTypes: ['Gray16'], compressions: ['none'], dims: { C: [0], Z: Array.from({ length: D }, (_, i) => i) } }, bin: 1,
    channels: [{ name: 'ZYP1 (synthetic)', data: out, dtype: 'uint16', color: '#8a5cff', source: { c: 0, meta: meta.channels[0] } }],
  });
  app.status(`Synthetic pachytene nucleus: ${curves.length} bivalents, true SC lengths ${curves.map((c) => c.length.toFixed(1)).join(', ')} µm (with gaps). Try Analyze › Chromosome tracing.`);
}

/* CZI Volume Studio — synthetic demo stack: a Turing-type spot→stripe pattern on a curved
 * epidermis, plus a cell-wall channel, with depth attenuation and camera noise (12-bit). */
function makeDemoVolume(app) {
  const W = 256, H = 256, D = 40, sx = 0.25, sz = 0.6, P = W * H;
  let seed = 12345;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // 2D fields: pattern, surface height, walls
  const pat = new Float32Array(P), zs = new Float32Array(P), wall = new Float32Array(P);
  const lam = 4.0, k = 2 * Math.PI / lam, phases = [0.3, 1.9, 4.2];
  const seeds = [];
  for (let i = 0; i < 70; i++) seeds.push([rnd() * W * sx, rnd() * H * sx]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const X = x * sx, Y = y * sx, i = y * W + x;
    // fixed orientation + gentle displacement warp keeps the wavelength at λ (±~8 %) everywhere
    const th = 0.2, Xd = X + 0.5 * Math.sin(Y / 6), Yd = Y + 0.5 * Math.sin(X / 7);
    let hex = 0;
    for (let j = 0; j < 3; j++) { const a = th + j * Math.PI / 3; hex += Math.cos(k * (Math.cos(a) * Xd + Math.sin(a) * Yd) + phases[j]); }
    const stripes = 3 * Math.cos(k * (Math.cos(th + 0.5) * Xd + Math.sin(th + 0.5) * Yd));
    const w = smooth(36, 50, X + 4 * Math.sin(Y / 6));
    const f = (1 - w) * hex + w * stripes;
    pat[i] = Math.pow(Math.max(0, f - 1.1) / 1.9, 1.3);
    zs[i] = 4 + 0.0045 * ((X - 30) ** 2 + (Y - 34) ** 2);
    let d1 = 1e9, d2 = 1e9;
    for (const s of seeds) { const d = Math.hypot(s[0] - X, s[1] - Y); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
    wall[i] = Math.exp(-((d2 - d1) ** 2) / (2 * 0.22 ** 2));
  }
  const spots = new Uint16Array(P * D), walls = new Uint16Array(P * D);
  for (let z = 0; z < D; z++) {
    const Z = z * sz, att = Math.exp(-Z / 22);
    for (let i = 0; i < P; i++) {
      const dz = Z - zs[i];
      const s1 = 2600 * pat[i] * Math.exp(-(dz * dz) / (2 * 0.9 * 0.9)) * att;
      const shell = dz > -0.6 && dz < 5 ? Math.exp(-Math.max(0, dz) / 2.5) : 0;
      const s2 = (1500 * wall[i] * shell + 160 * Math.exp(-(dz * dz) / 2)) * att;
      const n1 = 100 + s1 + gauss() * Math.sqrt(4 * s1 + 64), n2 = 100 + s2 + gauss() * Math.sqrt(4 * s2 + 64);
      spots[z * P + i] = Math.max(0, Math.min(4095, Math.round(n1)));
      walls[z * P + i] = Math.max(0, Math.min(4095, Math.round(n2)));
    }
  }
  const meta = {
    scaling: { x: sx, y: sx, z: sz },
    channels: [{ name: 'Pigment (spots)', color: '#ff00ff', emission: '610' }, { name: 'Cell walls', color: '#00ff00', emission: '520' }],
    info: { objective: 'Synthetic 40×/1.2 W', na: 1.2, immersion: 'Water', bitCount: 12, microscope: 'Simulated confocal' },
    doc: null,
  };
  app.setVolume({
    name: 'Demo – synthetic Turing pattern', fileName: 'demo (synthetic)', dims: [W, H, D], spacing: [sx, sx, sz], meta, xml: '',
    summary: { pixelTypes: ['Gray16'], compressions: ['none'], dims: { C: [0, 1], Z: Array.from({ length: D }, (_, i) => i) } }, bin: 1,
    channels: [
      { name: 'Pigment (spots)', data: spots, dtype: 'uint16', color: '#ff00ff', source: { c: 0, meta: meta.channels[0] } },
      { name: 'Cell walls', data: walls, dtype: 'uint16', color: '#00ff00', source: { c: 1, meta: meta.channels[1] } },
    ],
  });
  app.status('Demo volume: hexagonal spots (λ = 4 µm) turning into stripes on a curved surface, with depth attenuation and noise. Try Analyze › Pattern spectrum or Spot detection.');
}
