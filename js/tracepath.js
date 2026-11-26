/* CZI Volume Studio — click-to-click path search through the image (as in Fiji SNT), for tracing by hand. */
(function () {
  /**
   * The intensity image sharpened along Z (Richardson–Lucy with the measured axial blur, as the automatic
   * tracer does; it separates stacked tracks). Columns are sharpened the first time a search reaches them
   * and kept, so the first clicks in a region cost a little more than later ones.
   */
  function makeCache(img, dims, spacing, sigma) {
    const [W, H, D] = dims, [sx, sy, sz] = spacing, P = W * H, I = img.data;
    const sharpen = sigma > 0.6 * sz && D > 4;
    const C = { img, sigma, W, H, D, sx, sy, sz, P, I, sharpen, J: null, done: null };
    if (!sharpen) { C.at = (q) => I[q]; return C; }
    const s = sigma / sz, r = Math.max(1, Math.ceil(3 * s)), k = [];
    let ks = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * s * s)); k.push(v); ks += v; }
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    let mx = 0;
    for (let i = 0; i < I.length; i += 7) if (I[i] > mx) mx = I[i];
    const bg = 0.01 * mx + 1e-6;
    const J = new Float32Array(P * D), done = new Uint8Array(P);
    const d = new Float64Array(D), est = new Float64Array(D), b = new Float64Array(D), q = new Float64Array(D);
    const blur = (src, dst) => {
      for (let z = 0; z < D; z++) {
        let a = 0;
        for (let j = -r; j <= r; j++) { const zz = z + j < 0 ? 0 : z + j >= D ? D - 1 : z + j; a += src[zz] * k[j + r]; }
        dst[z] = a;
      }
    };
    const col = (c) => {
      let any = false;
      for (let z = 0; z < D; z++) { const v = I[z * P + c]; d[z] = v + bg; est[z] = d[z]; if (v > 0) any = true; }
      if (any) for (let it = 0; it < 20; it++) {
        blur(est, b);
        for (let z = 0; z < D; z++) q[z] = d[z] / Math.max(b[z], 1e-9);
        blur(q, b);
        for (let z = 0; z < D; z++) est[z] *= b[z];
      }
      for (let z = 0; z < D; z++) J[z * P + c] = Math.max(0, est[z] - bg);
      done[c] = 1;
    };
    C.J = J; C.done = done; C.col = col;
    C.at = (qq) => { const c = qq % P; if (!done[c]) col(c); return J[qq]; };
    return C;
  }

  /**
   * The brightest voxel near a click (the track you clicked), as [x, y, z] voxel indices. r = [rx, ry, rz]
   * search half-widths in voxels (a large one leaves that axis free, e.g. Z on a max projection).
   */
  function snap(C, p, r) {
    const { W, H, D, P } = C;
    const lo = [0, 1, 2].map((a) => Math.max(0, Math.round(p[a]) - r[a])), hi = [0, 1, 2].map((a, i) => Math.min([W, H, D][i] - 1, Math.round(p[a]) + r[a]));
    let best = null, bv = -Infinity;
    for (let z = lo[2]; z <= hi[2]; z++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let x = lo[0]; x <= hi[0]; x++) {
          // a slight preference for the clicked spot, so a flat track is not snapped along itself
          const dd = Math.hypot((x - p[0]) / Math.max(1, r[0]), (y - p[1]) / Math.max(1, r[1]), (z - p[2]) / Math.max(1, r[2]));
          const v = C.at(z * P + y * W + x) * (1 - 0.15 * Math.min(1, dd));
          if (v > bv) { bv = v; best = [x, y, z]; }
        }
      }
    }
    return best || p.map(Math.round);
  }

  /**
   * Candidate depths for a click on a max projection: the brightest voxel within ±r px of the click in each
   * bright layer (local maxima along Z of the column's profile, at least `frac` of its peak), best first.
   * The path search then picks the one that continues the track, instead of the brightest layer (which is
   * another, stacked track about one click in five).
   */
  function depthCandidates(C, p, r = 3, frac = 0.25, max = 6) {
    const { W, H, D, P } = C, px = Math.round(p[0]), py = Math.round(p[1]);
    const prof = new Float64Array(D), at = [];
    for (let z = 0; z < D; z++) {
      let bv = -Infinity, bx = px, by = py;
      for (let y = Math.max(0, py - r); y <= Math.min(H - 1, py + r); y++) {
        for (let x = Math.max(0, px - r); x <= Math.min(W - 1, px + r); x++) {
          const dd = Math.hypot(x - p[0], y - p[1]) / Math.max(1, r);
          const v = C.at(z * P + y * W + x) * (1 - 0.15 * Math.min(1, dd));
          if (v > bv) { bv = v; bx = x; by = y; }
        }
      }
      prof[z] = bv; at.push([bx, by, z]);
    }
    let peak = 0;
    for (let z = 0; z < D; z++) if (prof[z] > peak) peak = prof[z];
    const out = [];
    for (let z = 0; z < D; z++) if (prof[z] >= frac * peak && (z === 0 || prof[z] >= prof[z - 1]) && (z === D - 1 || prof[z] >= prof[z + 1])) out.push(z);
    out.sort((a, b) => prof[b] - prof[a]);
    return out.slice(0, max).map((z) => at[z]);
  }

  // search buffers, reused between clicks (grown as needed)
  let bufN = 0, G = null, PREV = null, COST = null, CLOSED = null, HF = new Float64Array(1 << 16), HQ = new Int32Array(1 << 16);
  const MAXN = 7e6;
  /**
   * Least-cost path between voxels a and b ([x, y, z]) through the sharpened image: A* over 26-neighbours in
   * a box around the two points. A step costs its length (Z steps count double, so the path changes layer
   * only when the image says so) times 1 / (eps + brightness)^pow, brightness scaled 0–1 inside the box.
   * Returns { pts (µm, sub-voxel Z, lightly smoothed), vox (voxel indices), isum, icnt } or null.
   */
  function findPath(C, a, b, o = {}) {
    const { W, H, D, sx, sy, sz, P } = C;
    const EPS = o.eps != null ? o.eps : 0.05, POW = o.pow != null ? o.pow : 1, ZF = 2;
    // either end may be several candidate voxels (a click on a max projection: one per bright layer);
    // the search starts from all of one set and stops at the first of the other it reaches
    const As = Array.isArray(a[0]) ? a : [a], Bs = Array.isArray(b[0]) ? b : [b];
    const all = As.concat(Bs), mn = [0, 1, 2].map((i) => Math.min(...all.map((p) => p[i]))), mx = [0, 1, 2].map((i) => Math.max(...all.map((p) => p[i])));
    const dxy = Math.hypot((As[0][0] - Bs[0][0]) * sx, (As[0][1] - Bs[0][1]) * sy);
    const zm = Math.max(3, Math.round((o.zMargin != null ? o.zMargin : 1.0) / sz));
    const z0 = Math.max(0, mn[2] - zm), z1 = Math.min(D - 1, mx[2] + zm), bd = z1 - z0 + 1;
    let m = Math.min(o.maxMargin || 3, Math.max(0.8, 0.6 * dxy));
    let x0, x1, y0, y1, bw, bh, N;
    for (;;) {
      x0 = Math.max(0, Math.floor(mn[0] - m / sx)); x1 = Math.min(W - 1, Math.ceil(mx[0] + m / sx));
      y0 = Math.max(0, Math.floor(mn[1] - m / sy)); y1 = Math.min(H - 1, Math.ceil(mx[1] + m / sy));
      bw = x1 - x0 + 1; bh = y1 - y0 + 1; N = bw * bh * bd;
      if (N <= MAXN || m <= 0.3) break;
      m *= 0.75;
    }
    if (N > bufN) { bufN = N; G = new Float32Array(N); PREV = new Int32Array(N); COST = new Float32Array(N); CLOSED = new Uint8Array(N); }
    G.fill(Infinity, 0, N); PREV.fill(-1, 0, N); COST.fill(-1, 0, N); CLOSED.fill(0, 0, N);
    const BP = bw * bh;
    const lid = (x, y, z) => (z - z0) * BP + (y - y0) * bw + (x - x0);
    const gid = (l) => { const z = z0 + ((l / BP) | 0), r = l % BP; return z * P + (y0 + ((r / bw) | 0)) * W + x0 + (r % bw); };
    // brightness scale inside the box, from a sample of its columns
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const nCol = Math.min(BP, 2500), vals = new Float32Array(nCol * bd);
    for (let i = 0, n = 0; i < nCol; i++) {
      const c = nCol === BP ? i : Math.floor(rnd() * BP), y = y0 + ((c / bw) | 0), x = x0 + (c % bw);
      for (let z = z0; z <= z1; z++) vals[n++] = C.at(z * P + y * W + x);
    }
    vals.sort();
    const lo = vals[Math.floor(0.5 * (vals.length - 1))], hi = Math.max(lo + 1e-9, vals[Math.floor(0.995 * (vals.length - 1))]);
    const costOf = (l) => {
      let n = (C.at(gid(l)) - lo) / (hi - lo);
      n = n < 0 ? 0 : n > 1 ? 1 : n;
      return (COST[l] = POW === 1 ? 1 / (EPS + n) : 1 / Math.pow(EPS + n, POW));
    };
    // A*: the heuristic is the straight distance at the cheapest possible cost, times HW (> 1 trades a
    // slightly less than least-cost path for a much smaller search; checked against hand traces)
    // 1.5: on the 1804/1805 hand traces, clicks 2.5 µm apart stay 99.6% / 96% within 0.1 µm of the hand
    // trace (exact search: 99.7% / 96.8%), with 2–3× fewer voxels searched
    const HW = o.hw != null ? o.hw : 1.5;
    const cmin = HW / Math.pow(EPS + 1, POW);
    const inB = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && p[2] >= z0 && p[2] <= z1;
    const srcs = As.filter(inB), dsts = Bs.filter(inB);
    if (!srcs.length || !dsts.length) return null;
    const tset = new Set(dsts.map((p) => lid(p[0], p[1], p[2])));
    const zsz = ZF * sz, nT = dsts.length, TX = dsts.map((p) => p[0] * sx), TY = dsts.map((p) => p[1] * sy), TZ = dsts.map((p) => p[2] * zsz);
    // distance to the nearest target (µm, Z steps doubled)
    const hd = (x, y, z) => {
      const X = x * sx, Y = y * sy, Z = z * zsz;
      let best = Infinity;
      for (let i = 0; i < nT; i++) { const ex = X - TX[i], ey = Y - TY[i], ez = Z - TZ[i], d = ex * ex + ey * ey + ez * ez; if (d < best) best = d; }
      return Math.sqrt(best);
    };
    // neighbour offsets and step lengths
    const NX = new Int8Array(26), NY = new Int8Array(26), NZ = new Int8Array(26), NO = new Int32Array(26), NL = new Float64Array(26);
    let nn = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy && !dz) continue;
      NX[nn] = dx; NY[nn] = dy; NZ[nn] = dz; NO[nn] = dz * BP + dy * bw + dx; NL[nn] = 0.5 * Math.hypot(dx * sx, dy * sy, ZF * dz * sz); nn++;
    }
    // binary heap on f (typed arrays, grown as needed)
    let hn = 0;
    const push = (f, q) => {
      if (hn >= HF.length) { const F2 = new Float64Array(HF.length * 2), Q2 = new Int32Array(HF.length * 2); F2.set(HF); Q2.set(HQ); HF = F2; HQ = Q2; }
      let i = hn++;
      while (i > 0) { const p = (i - 1) >> 1; if (HF[p] <= f) break; HF[i] = HF[p]; HQ[i] = HQ[p]; i = p; }
      HF[i] = f; HQ[i] = q;
    };
    const pop = () => {
      const q = HQ[0], lf = HF[--hn], lq = HQ[hn];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= hn) break;
        const r = l + 1, m = r < hn && HF[r] < HF[l] ? r : l;
        if (HF[m] >= lf) break;
        HF[i] = HF[m]; HQ[i] = HQ[m]; i = m;
      }
      HF[i] = lf; HQ[i] = lq;
      return q;
    };
    for (const p of srcs) { const s = lid(p[0], p[1], p[2]); G[s] = 0; push(cmin * hd(p[0], p[1], p[2]), s); }
    // (tested: preferring target layers near the previous point's depth did not help consistently)
    let found = false, nExp = 0, tL = -1;
    while (hn) {
      const q = pop();
      if (CLOSED[q]) continue;
      CLOSED[q] = 1; nExp++;
      if (tset.has(q)) { found = true; tL = q; break; }
      const z = z0 + ((q / BP) | 0), rr = q % BP, y = y0 + ((rr / bw) | 0), x = x0 + (rr % bw), gq = G[q];
      let cq = COST[q];
      if (cq < 0) cq = costOf(q);
      for (let k = 0; k < 26; k++) {
        const xx = x + NX[k], yy = y + NY[k], zz = z + NZ[k];
        if (xx < x0 || xx > x1 || yy < y0 || yy > y1 || zz < z0 || zz > z1) continue;
        const u = q + NO[k];
        if (CLOSED[u]) continue;
        let cu = COST[u];
        if (cu < 0) cu = costOf(u);
        const nd = gq + NL[k] * (cq + cu);
        if (nd < G[u]) {
          G[u] = nd; PREV[u] = q;
          push(nd + cmin * (nT === 1 ? Math.sqrt(((xx * sx - TX[0]) ** 2) + ((yy * sy - TY[0]) ** 2) + ((zz * zsz - TZ[0]) ** 2)) : hd(xx, yy, zz)), u);
        }
      }
    }
    if (!found) return null;
    const path = [];
    for (let q = tL; q >= 0; q = PREV[q]) path.push(gid(q));
    path.reverse();
    return Object.assign(voxPath(C, path, lo), { expanded: nExp, box: N });
  }

  /** Voxel path (global indices) -> µm points with sub-voxel Z from the local profile, lightly smoothed. */
  function voxPath(C, path, lo) {
    const { W, D, sx, sy, sz, P } = C;
    const raw = [];
    for (const g of path) {
      const z = (g / P) | 0, r2 = g - z * P, y = (r2 / W) | 0, x = r2 - y * W;
      let sw = 0, sz2 = 0;
      for (let kz = Math.max(0, z - 2); kz <= Math.min(D - 1, z + 2); kz++) { const wv = Math.max(0, C.at(kz * P + r2) - lo); sw += wv; sz2 += wv * kz; }
      raw.push([x * sx, y * sy, (sw > 0 ? sz2 / sw : z) * sz]);
    }
    const pts = raw.map((p, i) => {
      if (i === 0 || i === raw.length - 1) return p;
      const hh = Math.min(3, i, raw.length - 1 - i), s = [0, 0, 0];
      for (let kk = -hh; kk <= hh; kk++) { s[0] += raw[i + kk][0]; s[1] += raw[i + kk][1]; s[2] += raw[i + kk][2]; }
      return s.map((v) => v / (2 * hh + 1));
    });
    let isum = 0;
    for (const v of path) isum += C.I[v];
    return { pts, vox: Int32Array.from(path), isum, icnt: path.length };
  }

  /** Point at arclength s along polyline p. */
  function along(p, s) {
    let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const l = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1], p[i][2] - p[i - 1][2]);
      if (acc + l >= s && l > 0) { const f = (s - acc) / l; return [0, 1, 2].map((a) => p[i - 1][a] + f * (p[i][a] - p[i - 1][a])); }
      acc += l;
    }
    return p[p.length - 1].slice();
  }
  /** Mean Z over arclength [s0, s1] of p. */
  const meanZ = (p, s0, s1) => { let z = 0; for (let k = 0; k <= 4; k++) z += along(p, s0 + ((s1 - s0) * k) / 4)[2]; return z / 5; };

  window.TracePath = { makeCache, snap, depthCandidates, findPath, along, meanZ };
})();
