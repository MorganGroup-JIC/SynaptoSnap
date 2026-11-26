/* SynaptoSnap — dense pachytene nucleus modelled on a real ZYP1 3D-SIM stack
 * (~120 µm of SC in a 6.5 µm nucleus).
 *
 * N long, wavy synaptonemal complexes are packed into a flattened, dome-shaped nucleus. They lie in
 * layers with occasional climbs over one another, keep a minimum distance from each other, and have
 * their telomeres at the nuclear envelope.
 * Imaging: Z-elongated SIM-like PSF with weak axial side lobes, beaded intensity, short gaps, a few
 * bright aggregates, dim nucleoplasmic foci, grainy noise centred on zero and clipped at the floor
 * (about half of all voxels end up exactly at 0, as in SIM reconstructions).
 * Ground truth goes to app.scTruth (curves, voxel ownership), as for makeSCDemo. */
function makeDenseSCDemo(app, opts = {}) {
  const o = Object.assign({
    seed: 11, n: 4, total: 170, rel: [1.18, 1.04, 0.94, 0.84], radius: 3.2, halfThick: 1.35, dome: 0.35,
    Lp: 1.1, zSlope: 0.4, minSep: 0.28, sx: 0.03125, sz: 0.1,
    psfXY: 0.075, psfZ: 0.22, lobe: 0.06, lobeDist: 0.55, beadCV: 0.3, gapEvery: 4, dimEvery: 5, beads: 8, foci: 120, noise: 0.02, noiseShot: 0.04, diffuse: 0.02, grain: 0.045, ring: 0.25,
  }, opts);
  let seed = o.seed;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const { sx, sz } = o, R = o.radius;
  const relSum = o.rel.slice(0, o.n).reduce((a, b) => a + b, 0) || 1;
  const lengths = o.lengths || Array.from({ length: o.n }, (_, i) => o.total * (o.rel[i] || 1) / relSum);
  const pad = 0.4, W = Math.ceil((2 * R + 2 * pad) / sx), H = W;
  const D = Math.ceil((2 * o.halfThick + Math.abs(o.dome) + 1.8) / sz), P = W * H;
  const c0 = [W * sx / 2, H * sx / 2, D * sz / 2];
  const zc = (r) => c0[2] + o.dome * (0.5 - (r / R) ** 2);           // dome: centre higher than the rim
  const hh = (r) => o.halfThick * (1 - 0.45 * Math.min(1, (r / R) ** 2)); // thinner towards the rim
  const inside = (q) => { const r = Math.hypot(q[0] - c0[0], q[1] - c0[1]); return r <= R && Math.abs(q[2] - zc(r)) <= hh(r); };

  // ---------------------------------------------------------------- growth (all chains together)
  const ds = 0.04, cell = 0.25, grid = new Map();
  const key = (x, y, z) => Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell);
  const add = (pt) => { const k = key(pt[0], pt[1], pt[2]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(pt); };
  const remove = (pt) => { const l = grid.get(key(pt[0], pt[1], pt[2])); if (l) { const i = l.indexOf(pt); if (i >= 0) l.splice(i, 1); } };
  const selfSkip = Math.ceil(0.6 / ds);
  const clearance = (q, ci, idx) => {
    let best = Infinity;
    const kx = Math.floor(q[0] / cell), ky = Math.floor(q[1] / cell), kz = Math.floor(q[2] / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const l = grid.get((kx + a) + ',' + (ky + b) + ',' + (kz + c)); if (!l) continue;
      for (const p of l) { if (p[3] === ci && idx - p[4] < selfSkip) continue; const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); if (d < best) best = d; }
    }
    return best;
  };
  const chains = lengths.map((L, ci) => {
    for (let t = 0; t < 200; t++) {
      const ph = rnd() * 2 * Math.PI, r = R - 0.2;
      const pt = [c0[0] + r * Math.cos(ph), c0[1] + r * Math.sin(ph), 0, ci, 0];
      pt[2] = zc(r) + (rnd() * 2 - 1) * 0.6 * hh(r);
      if (clearance(pt, ci, 0) < 2 * o.minSep) continue;
      add(pt);
      return { ci, L, pts: [pt], th: ph + Math.PI + gauss() * 0.5, k: 0, steps: Math.round(L / ds), fails: 0, done: false };
    }
    return { ci, L, pts: [], done: true, fails: 0 };
  });
  const sdTurn = Math.sqrt(ds / o.Lp), tau = 0.5;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const step = (C) => {
    const p = C.pts[C.pts.length - 1], idx = C.pts.length;
    const r = Math.hypot(p[0] - c0[0], p[1] - c0[1]), dzRel = (p[2] - zc(r)) / hh(r);
    const remain = C.steps - idx;
    let thBias = 0;
    if (remain < 0.12 * C.steps) thBias = 0.12 * wrap(Math.atan2(p[1] - c0[1], p[0] - c0[0]) - C.th); // telomere heads for the envelope
    const cands = [];
    for (let c = 0; c < 12; c++) {
      const th = C.th + thBias + gauss() * sdTurn * (c >= 10 ? 3 : 1);
      let k = C.k - C.k * ds / tau + gauss() * o.zSlope * Math.sqrt(2 * ds / tau) - (Math.abs(dzRel) > 0.8 ? 0.08 * Math.sign(dzRel) : 0);
      if (c === 8 || c === 9) k = (c === 8 ? 1 : -1) * (0.35 + 0.3 * rnd()); // climb over / dive under
      const sl = ds / Math.hypot(1, k), q = [p[0] + sl * Math.cos(th), p[1] + sl * Math.sin(th), p[2] + sl * k, C.ci, idx];
      if (!inside(q)) continue;
      const cl = clearance(q, C.ci, idx);
      if (cl < o.minSep) continue;
      const rq = Math.hypot(q[0] - c0[0], q[1] - c0[1]), rim = remain < 0.12 * C.steps ? 1 : Math.min(1, 0.4 + (R - rq) / 0.35); // keep off the envelope except near the telomeres
      cands.push({ q, th, k, w: (Math.min(cl - o.minSep, 0.25) + 0.02) * rim });
    }
    if (!cands.length) {
      // stuck: back up a little and try another way
      C.fails++;
      const back = Math.min(C.pts.length - 1, 5 + Math.floor(rnd() * (C.fails > 300 ? 60 : 20)));
      for (let i = 0; i < back; i++) remove(C.pts.pop());
      const a = C.pts[Math.max(0, C.pts.length - 3)], b = C.pts[C.pts.length - 1];
      C.th = (a === b ? C.th : Math.atan2(b[1] - a[1], b[0] - a[0])) + gauss() * 0.8; C.k = 0;
      if (C.fails > 1500) C.done = true;
      return;
    }
    let s = 0; for (const c of cands) s += c.w;
    let u = rnd() * s, pick = cands[0];
    for (const c of cands) { u -= c.w; if (u <= 0) { pick = c; break; } }
    add(pick.q); C.pts.push(pick.q); C.th = pick.th; C.k = pick.k;
    if (C.pts.length >= C.steps) C.done = true;
  };
  for (let guard = 0; guard < 200000 && chains.some((C) => !C.done); guard++) for (const C of chains) if (!C.done) step(C);

  // resample to 0.02 µm for rendering and ground truth
  const curves = [];
  for (const C of chains) {
    if (C.pts.length < 10) continue;
    const pts = [];
    for (let i = 0; i < C.pts.length; i++) {
      const a = C.pts[i]; pts.push([a[0], a[1], a[2]]);
      const b = C.pts[i + 1]; if (b) pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    }
    let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    curves.push({ id: curves.length + 1, pts, length: L, target: C.L });
  }

  // ---------------------------------------------------------------- rendering
  const N = P * D, sig = new Float32Array(N), wmax = new Float32Array(N), owner = new Uint8Array(N);
  const rzLobe = Math.ceil((o.lobeDist + 2.4 * o.psfZ) / sz);
  const splat = (X, Y, Z, amp, sgx, sgz, lobe, id) => {
    const x0 = Math.round(X / sx), y0 = Math.round(Y / sx), z0 = Math.round(Z / sz);
    const rxx = Math.ceil(3 * sgx / sx), rzz = lobe ? rzLobe : Math.ceil(3 * sgz / sz);
    const fx = [], fy = [];
    for (let d = -rxx; d <= rxx; d++) { fx.push(Math.exp(-(((x0 + d) * sx - X) ** 2) / (2 * sgx * sgx))); fy.push(Math.exp(-(((y0 + d) * sx - Y) ** 2) / (2 * sgx * sgx))); }
    const sl = 0.8 * sgz;
    for (let dz = -rzz; dz <= rzz; dz++) {
      const z = z0 + dz; if (z < 0 || z >= D) continue;
      const u = z * sz - Z;
      const main = Math.exp(-(u * u) / (2 * sgz * sgz));
      const fz = main + (lobe ? lobe * (Math.exp(-((u - o.lobeDist) ** 2) / (2 * sl * sl)) + Math.exp(-((u + o.lobeDist) ** 2) / (2 * sl * sl))) : 0);
      for (let dy = -rxx; dy <= rxx; dy++) {
        const y = y0 + dy; if (y < 0 || y >= H) continue;
        const row = z * P + y * W, wy = fy[dy + rxx] * amp;
        for (let dx = -rxx; dx <= rxx; dx++) {
          const x = x0 + dx; if (x < 0 || x >= W) continue;
          const v = row + x, w = fx[dx + rxx] * wy;
          sig[v] += w * fz;
          if (id && w * main > wmax[v]) { wmax[v] = w * main; owner[v] = id; }
        }
      }
    }
  };
  const sgLog = Math.sqrt(Math.log(1 + o.beadCV * o.beadCV));
  for (const cv of curves) {
    const n = cv.pts.length, st = 0.02;
    const gaps = [], nG = Math.max(0, Math.round(cv.length / o.gapEvery + gauss() * 0.7));
    for (let g = 0; g < nG; g++) { const at = (0.05 + 0.9 * rnd()) * cv.length; gaps.push([at, at + 0.08 + 0.17 * rnd()]); }
    const beads = []; for (let b = 0; b < o.beads / curves.length * (0.5 + rnd()); b++) beads.push((0.05 + 0.9 * rnd()) * cv.length);
    const dims_ = [], nD = Math.max(0, Math.round(cv.length / o.dimEvery + gauss() * 0.7)); // dim stretches (weak staining)
    for (let g = 0; g < nD; g++) { const at = (0.05 + 0.9 * rnd()) * cv.length; dims_.push([at, at + 0.3 + 0.5 * rnd(), 0.3 + 0.2 * rnd()]); }
    cv.gaps = gaps;
    let g = gauss();
    const ph = rnd() * 2 * Math.PI, lam = 0.32 + 0.08 * rnd();
    for (let i = 0; i < n; i++) {
      const s = i * st;
      g = g * Math.exp(-st / 0.15) + Math.sqrt(1 - Math.exp(-2 * st / 0.15)) * gauss(); // OU, 0.15 µm correlation
      let amp = Math.exp(sgLog * g - sgLog * sgLog / 2);
      if (gaps.some((q) => s >= q[0] && s <= q[1])) amp *= 0.12;
      for (const q of dims_) if (s >= q[0] && s <= q[1]) amp *= q[2];
      for (const b of beads) amp *= 1 + 1.1 * Math.exp(-((s - b) ** 2) / (2 * 0.06 * 0.06));
      // fine waviness of the SC (~0.02 µm, ~0.35 µm period), rendering only
      const a = cv.pts[Math.max(0, i - 1)], b2 = cv.pts[Math.min(n - 1, i + 1)], tl = Math.hypot(b2[0] - a[0], b2[1] - a[1]) || 1;
      const off = 0.02 * Math.sin(2 * Math.PI * s / lam + ph);
      const q = cv.pts[i];
      splat(q[0] - (b2[1] - a[1]) / tl * off, q[1] + (b2[0] - a[0]) / tl * off, q[2], amp, o.psfXY, o.psfZ, o.lobe, cv.id);
    }
  }
  // normalise: median peak along the tracks = 1
  const pk = [];
  for (const cv of curves) for (let i = 0; i < cv.pts.length; i += 7) { const q = cv.pts[i]; pk.push(sig[Math.round(q[2] / sz) * P + Math.round(q[1] / sx) * W + Math.round(q[0] / sx)]); }
  pk.sort((a, b) => a - b);
  const nrm = 1 / (pk[pk.length >> 1] || 1);
  for (let i = 0; i < N; i++) sig[i] *= nrm;
  // dim foci in the nucleoplasm (mostly towards the rim) and a faint diffuse background
  for (let f = 0; f < o.foci; f++) {
    const r = R * Math.sqrt(0.25 + 0.75 * rnd()) * 1.02, ph = rnd() * 2 * Math.PI, rc = Math.min(r, R);
    splat(c0[0] + r * Math.cos(ph), c0[1] + r * Math.sin(ph), zc(rc) + (rnd() * 2 - 1) * hh(rc), 0.06 + 0.2 * rnd() * rnd(), o.psfXY * 1.2, o.psfZ, 0, 0);
  }
  // SIM reconstruction ringing: a shallow negative skirt around every structure (≈ 0.17 µm wide in xy),
  // which after clipping leaves the dark halo seen next to real tracks
  if (o.ring > 0) {
    const blurSum = (a, stride, len, count, sigVox, base) => {
      const r = Math.max(1, Math.ceil(3 * sigVox)), k = []; let ks = 0;
      for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigVox * sigVox)); k.push(v); ks += v; }
      const kn = k.map((v) => v / ks), line = new Float32Array(len);
      for (let c = 0; c < count; c++) {
        const b0 = base(c);
        for (let i = 0; i < len; i++) line[i] = a[b0 + i * stride];
        for (let i = 0; i < len; i++) { let s = 0; for (let j = -r; j <= r; j++) s += line[Math.min(len - 1, Math.max(0, i + j))] * kn[j + r]; a[b0 + i * stride] = s; }
      }
    };
    const bl = sig.slice();
    blurSum(bl, 1, W, H * D, 0.17 / sx, (c) => c * W);
    blurSum(bl, W, H, W * D, 0.17 / sx, (c) => Math.floor(c / W) * P + (c % W));
    blurSum(bl, P, D, P, 0.15 / sz, (c) => c);
    for (let i = 0; i < N; i++) sig[i] -= o.ring * bl[i];
    const pk2 = [];
    for (const cv of curves) for (let i = 0; i < cv.pts.length; i += 7) { const q = cv.pts[i]; pk2.push(sig[Math.round(q[2] / sz) * P + Math.round(q[1] / sx) * W + Math.round(q[0] / sx)]); }
    pk2.sort((a, b) => a - b);
    const n2 = 1 / (pk2[pk2.length >> 1] || 1);
    for (let i = 0; i < N; i++) sig[i] *= n2;
  }
  const env = new Float32Array(N); // 1 inside the nucleus, fading to 0 outside (SIM output is 0 there)
  for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x * sx - c0[0], y * sx - c0[1]); if (r >= R + 0.3) continue;
    const rc = Math.min(r, R), e = Math.max(0, Math.min(1, 1.3 - Math.abs(z * sz - zc(rc)) / (hh(rc) + 0.3)));
    const v = z * P + y * W + x;
    env[v] = e * Math.min(1, (R + 0.3 - r) / 0.5);
    sig[v] += o.diffuse * env[v];
  }
  // grainy noise (white noise blurred to ~SIM resolution, unit variance), zero mean, clipped at the floor
  const nz = new Float32Array(N);
  for (let i = 0; i < N; i++) nz[i] = gauss();
  const blur1 = (a, stride, len, count, sigVox, base) => {
    const r = Math.max(1, Math.ceil(3 * sigVox)), k = []; let ks = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigVox * sigVox)); k.push(v); ks += v * v; }
    const kn = k.map((v) => v / Math.sqrt(ks));
    const line = new Float32Array(len);
    for (let c = 0; c < count; c++) {
      const b0 = base(c);
      for (let i = 0; i < len; i++) line[i] = a[b0 + i * stride];
      for (let i = 0; i < len; i++) { let s = 0; for (let j = -r; j <= r; j++) s += line[Math.min(len - 1, Math.max(0, i + j))] * kn[j + r]; a[b0 + i * stride] = s; }
    }
  };
  blur1(nz, 1, W, H * D, o.grain / sx, (c) => c * W);
  blur1(nz, W, H, W * D, o.grain / sx, (c) => Math.floor(c / W) * P + (c % W));
  blur1(nz, P, D, P, 0.09 / sz, (c) => c);
  const val = new Float32Array(N);
  for (let i = 0; i < N; i++) val[i] = sig[i] + nz[i] * (o.noise * env[i] + o.noiseShot * Math.sqrt(Math.max(0, sig[i])));
  // the SIM floor: everything at or below zero is stored as 0
  const sm = []; for (let i = 0; i < N; i += 11) sm.push(val[i]); sm.sort((a, b) => a - b);
  const K = 32000 / Math.max(1e-6, sm[Math.floor(0.999 * sm.length)]);
  const out = new Uint16Array(N);
  for (let i = 0; i < N; i++) out[i] = Math.max(0, Math.min(65535, Math.round(val[i] * K)));

  app.scTruth = { curves, owner, dims: [W, H, D], spacing: [sx, sx, sz] };
  const meta = {
    scaling: { x: sx, y: sx, z: sz },
    channels: [{ name: 'ZYP1 (synthetic SIM)', color: '#ff8a3d', emission: '597.5' }],
    info: { objective: 'Synthetic 63×/1.4 Oil (SIM)', na: 1.4, immersion: 'Oil', bitCount: 16, microscope: 'Simulated' },
    doc: null,
  };
  app.setVolume({
    name: 'Demo – dense pachytene (' + curves.length + ' SCs, SIM-like)', fileName: 'demo (dense synthetic SC)', dims: [W, H, D], spacing: [sx, sx, sz], meta, xml: '',
    summary: { pixelTypes: ['Gray16'], compressions: ['none'], dims: { C: [0], Z: Array.from({ length: D }, (_, i) => i) } }, bin: 1,
    channels: [{ name: 'ZYP1 (synthetic SIM)', data: out, dtype: 'uint16', color: '#ff8a3d', source: { c: 0, meta: meta.channels[0] } }],
  });
  const tot = curves.reduce((s, c) => s + c.length, 0);
  app.status(`Dense synthetic pachytene nucleus: ${curves.length} SCs, true lengths ${curves.map((c) => c.length.toFixed(1)).join(', ')} µm (total ${tot.toFixed(0)} µm), modelled on a real 3D-SIM ZYP1 stack. Try Analyze › Chromosome tracing.`);
  return { curves: curves.map((c) => [+c.length.toFixed(1), +c.target.toFixed(1)]), fails: chains.map((C) => C.fails || 0), dims: [W, H, D] };
}
