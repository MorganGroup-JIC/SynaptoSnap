/* SynaptoSnap — image processing library.
 *
 * Pure functions on 3D volumes stored as flat typed arrays, index = (z*H + y)*W + x.
 * Runs inside a Web Worker (heavy operations) and on the main thread (histograms,
 * threshold values for live previews). Physical units are µm; ctx.sx/sy/sz is the
 * voxel size.
 */
function ProcFactory() {
  'use strict';

  // ------------------------------------------------------------------ basics
  const clampi = (v, a, b) => (v < a ? a : v > b ? b : v);

  function makeCtx(dims, spacing, progress) {
    let last = 0;
    return {
      W: dims[0], H: dims[1], D: dims[2], N: dims[0] * dims[1] * dims[2],
      sx: spacing[0], sy: spacing[1], sz: spacing[2],
      // progress over a sub-range [a,b] of the whole operation
      report(frac, msg) {
        const now = Date.now();
        if (progress && (now - last > 120 || frac >= 1)) { last = now; progress(Math.min(1, frac), msg); }
      },
    };
  }
  function stage(ctx, a, b, msg) { return (f) => ctx.report(a + (b - a) * f, msg); }

  function minmax(a) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0, n = a.length; i < n; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo === Infinity) { lo = 0; hi = 0; }
    return [lo, hi];
  }
  const toF32 = (a) => (a instanceof Float32Array ? a : new Float32Array(a));
  const copyF32 = (a) => new Float32Array(a);
  const isInt = (a) => !(a instanceof Float32Array || a instanceof Float64Array);

  function meanStd(a) {
    let s = 0, s2 = 0;
    const n = a.length;
    for (let i = 0; i < n; i++) { const v = a[i]; s += v; s2 += v * v; }
    const m = s / n;
    return [m, Math.sqrt(Math.max(0, s2 / n - m * m))];
  }

  // ------------------------------------------------------------- histograms
  function histogram(a, nbinsHint, range) {
    const [lo, hi] = range || minmax(a);
    let nb, bw;
    if (isInt(a)) { nb = Math.max(1, Math.min(hi - lo + 1, nbinsHint || 4096)); bw = (hi - lo + 1) / nb; }
    else { nb = nbinsHint || 1024; bw = (hi - lo) / nb || 1; }
    const h = new Float64Array(nb);
    const inv = 1 / bw;
    for (let i = 0, n = a.length; i < n; i++) {
      let b = ((a[i] - lo) * inv) | 0;
      if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
      h[b]++;
    }
    return { h, lo, hi, bw, nb };
  }
  function percentile(a, p, hist) {
    const H = hist || histogram(a, 4096);
    const total = a.length, target = total * p / 100;
    let c = 0;
    for (let i = 0; i < H.nb; i++) { c += H.h[i]; if (c >= target) return H.lo + (i + 0.5) * H.bw; }
    return H.hi;
  }

  // Threshold methods on a histogram. Each returns bin t; foreground = bins > t.
  const TH = {
    otsu(h) {
      let total = 0, sum = 0;
      for (let i = 0; i < h.length; i++) { total += h[i]; sum += i * h[i]; }
      let wB = 0, sumB = 0, best = 0, maxV = -1;
      for (let t = 0; t < h.length; t++) {
        wB += h[t]; if (!wB) continue;
        const wF = total - wB; if (!wF) break;
        sumB += t * h[t];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const v = wB * wF * (mB - mF) * (mB - mF);
        if (v > maxV) { maxV = v; best = t; }
      }
      return best;
    },
    li(h) {
      let N = 0, S = 0;
      for (let i = 0; i < h.length; i++) { N += h[i]; S += (i + 1) * h[i]; }
      let next = S / N, thr = 0, iter = 0;
      for (;;) {
        const old = next; thr = Math.round(old);
        let sb = 0, nb = 0, so = 0, no = 0;
        for (let i = 0; i < h.length; i++) {
          if (i + 1 <= thr) { sb += (i + 1) * h[i]; nb += h[i]; } else { so += (i + 1) * h[i]; no += h[i]; }
        }
        const mb = nb ? sb / nb : 0, mo = no ? so / no : 0;
        if (mb <= 0 || mo <= 0 || mb === mo) break;
        const temp = (mb - mo) / (Math.log(mb) - Math.log(mo));
        next = temp < -2.2e-16 ? Math.round(temp - 0.5) : Math.round(temp + 0.5);
        if (Math.abs(next - old) <= 0.5 || ++iter > 1000) break;
      }
      return clampi(thr - 1, 0, h.length - 1);
    },
    triangle(hIn) {
      const h = Array.from(hIn);
      const n = h.length;
      let min = 0, max = 0, min2 = 0, dmax = 0;
      for (let i = 0; i < n; i++) if (h[i] > 0) { min = i; break; }
      if (min > 0) min--;
      for (let i = n - 1; i > 0; i--) if (h[i] > 0) { min2 = i; break; }
      if (min2 < n - 1) min2++;
      for (let i = 0; i < n; i++) if (h[i] > dmax) { max = i; dmax = h[i]; }
      let inverted = false;
      if ((max - min) < (min2 - max)) { inverted = true; h.reverse(); min = n - 1 - min2; max = n - 1 - max; }
      if (min === max) return inverted ? n - 1 - min : min;
      let nx = h[max], ny = min - max, d = Math.sqrt(nx * nx + ny * ny);
      nx /= d; ny /= d; d = nx * min + ny * h[min];
      let split = min, sd = 0;
      for (let i = min + 1; i <= max; i++) { const nd = nx * i + ny * h[i] - d; if (nd > sd) { split = i; sd = nd; } }
      split--;
      return inverted ? n - 1 - split : Math.max(0, split);
    },
    yen(h) {
      const n = h.length; let total = 0;
      for (let i = 0; i < n; i++) total += h[i];
      const norm = h.map((v) => v / total);
      const P1 = new Float64Array(n), P1s = new Float64Array(n), P2s = new Float64Array(n);
      P1[0] = norm[0]; P1s[0] = norm[0] * norm[0];
      for (let i = 1; i < n; i++) { P1[i] = P1[i - 1] + norm[i]; P1s[i] = P1s[i - 1] + norm[i] * norm[i]; }
      P2s[n - 1] = 0;
      for (let i = n - 2; i >= 0; i--) P2s[i] = P2s[i + 1] + norm[i + 1] * norm[i + 1];
      let thr = 0, maxc = -Infinity;
      for (let t = 0; t < n; t++) {
        const a = P1s[t] * P2s[t], b = P1[t] * (1 - P1[t]);
        const crit = -1 * (a > 0 ? Math.log(a) : 0) + 2 * (b > 0 ? Math.log(b) : 0);
        if (crit > maxc) { maxc = crit; thr = t; }
      }
      return thr;
    },
    isodata(h) {
      let N = 0, S = 0;
      for (let i = 0; i < h.length; i++) { N += h[i]; S += i * h[i]; }
      let t = S / N;
      for (let it = 0; it < 200; it++) {
        let sb = 0, nb = 0, sf = 0, nf = 0;
        for (let i = 0; i < h.length; i++) { if (i <= t) { sb += i * h[i]; nb += h[i]; } else { sf += i * h[i]; nf += h[i]; } }
        const tn = ((nb ? sb / nb : 0) + (nf ? sf / nf : 0)) / 2;
        if (Math.abs(tn - t) < 0.5) { t = tn; break; }
        t = tn;
      }
      return Math.floor(t);
    },
    maxentropy(h) {
      const n = h.length; let total = 0;
      for (let i = 0; i < n; i++) total += h[i];
      const norm = h.map((v) => v / total);
      const P1 = new Float64Array(n); P1[0] = norm[0];
      for (let i = 1; i < n; i++) P1[i] = P1[i - 1] + norm[i];
      // entropy sums via cumulative H = -Σ p log p
      const E = new Float64Array(n); E[0] = norm[0] > 0 ? -norm[0] * Math.log(norm[0]) : 0;
      for (let i = 1; i < n; i++) E[i] = E[i - 1] + (norm[i] > 0 ? -norm[i] * Math.log(norm[i]) : 0);
      const Et = E[n - 1];
      let best = 0, maxe = -Infinity;
      for (let t = 0; t < n - 1; t++) {
        const pb = P1[t], pf = 1 - pb;
        if (pb < 1e-12 || pf < 1e-12) continue;
        // H_b = log(pb) + E_b/pb ; H_f = log(pf) + (Et - E_b)/pf
        const hb = Math.log(pb) + E[t] / pb, hf = Math.log(pf) + (Et - E[t]) / pf;
        if (hb + hf > maxe) { maxe = hb + hf; best = t; }
      }
      return best;
    },
    mean(h) {
      let N = 0, S = 0;
      for (let i = 0; i < h.length; i++) { N += h[i]; S += i * h[i]; }
      return Math.floor(S / N);
    },
  };

  /** Returns a threshold value in data units; voxels >= value are foreground. */
  function thresholdValue(a, method, param) {
    if (method === 'manual') return +param;
    if (method === 'percentile') return percentile(a, +param);
    const H = histogram(a, isInt(a) ? 4096 : 1024);
    const f = TH[method];
    if (!f) throw new Error('Unknown threshold method ' + method);
    const t = f(H.h);
    return H.lo + (t + 1) * H.bw;
  }

  // ------------------------------------------------------- separable filters
  function gaussKernel(sigma) {
    if (!(sigma > 0.3)) return null;
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  }

  function convX(src, dst, W, H, D, k, rep) {
    const r = (k.length - 1) >> 1, K = k.length, buf = new Float32Array(W + 2 * r);
    for (let z = 0; z < D; z++) {
      for (let y = 0; y < H; y++) {
        const o = (z * H + y) * W;
        const a = src[o], b = src[o + W - 1];
        for (let i = 0; i < r; i++) { buf[i] = a; buf[W + r + i] = b; }
        for (let i = 0; i < W; i++) buf[r + i] = src[o + i];
        for (let i = 0; i < W; i++) {
          let s = 0;
          for (let j = 0; j < K; j++) s += k[j] * buf[i + j];
          dst[o + i] = s;
        }
      }
      if (rep) rep((z + 1) / D);
    }
  }
  function convY(src, dst, W, H, D, k, rep) {
    const r = (k.length - 1) >> 1, acc = new Float32Array(W);
    for (let z = 0; z < D; z++) {
      const zo = z * W * H;
      for (let y = 0; y < H; y++) {
        acc.fill(0);
        for (let j = -r; j <= r; j++) {
          const yy = clampi(y + j, 0, H - 1), w = k[j + r], so = zo + yy * W;
          for (let x = 0; x < W; x++) acc[x] += w * src[so + x];
        }
        dst.set(acc, zo + y * W);
      }
      if (rep) rep((z + 1) / D);
    }
  }
  function convZ(src, dst, W, H, D, k, rep) {
    const r = (k.length - 1) >> 1, P = W * H, acc = new Float32Array(P);
    for (let z = 0; z < D; z++) {
      acc.fill(0);
      for (let j = -r; j <= r; j++) {
        const zz = clampi(z + j, 0, D - 1), w = k[j + r], so = zz * P;
        for (let i = 0; i < P; i++) acc[i] += w * src[so + i];
      }
      dst.set(acc, z * P);
      if (rep) rep((z + 1) / D);
    }
  }

  /** Apply 1D kernels along x, y, z (null = skip). Never modifies src. */
  function separable(src, ctx, kx, ky, kz, a = 0, b = 1, msg = 'Filtering') {
    const { W, H, D } = ctx;
    const passes = [];
    if (kx && W > 1) passes.push([convX, kx]);
    if (ky && H > 1) passes.push([convY, ky]);
    if (kz && D > 1) passes.push([convZ, kz]);
    if (!passes.length) return copyF32(src);
    const A = new Float32Array(ctx.N), B = passes.length > 1 ? new Float32Array(ctx.N) : null;
    let s = src, d = A;
    passes.forEach(([fn, k], i) => {
      fn(s, d, W, H, D, k, (f) => ctx.report(a + (b - a) * (i + f) / passes.length, msg));
      s = d; d = d === A ? B : A;
    });
    return s;
  }

  function gaussian(src, ctx, sxy, sz, a, b, msg) {
    return separable(src, ctx, gaussKernel(sxy / ctx.sx), gaussKernel(sxy / ctx.sy), gaussKernel(sz / ctx.sz), a, b, msg || 'Gaussian blur');
  }

  // sliding-window mean, radius in voxels
  function boxMean(src, ctx, rx, ry, rz) {
    const { W, H, D } = ctx, P = W * H;
    let cur = copyF32(src);
    if (rx > 0) {
      const w = 2 * rx + 1, line = new Float64Array(W);
      for (let row = 0; row < H * D; row++) {
        const o = row * W;
        let s = 0;
        for (let j = -rx; j <= rx; j++) s += cur[o + clampi(j, 0, W - 1)];
        for (let x = 0; x < W; x++) {
          line[x] = s / w;
          s += cur[o + clampi(x + rx + 1, 0, W - 1)] - cur[o + clampi(x - rx, 0, W - 1)];
        }
        for (let x = 0; x < W; x++) cur[o + x] = line[x];
      }
    }
    if (ry > 0) {
      const w = 2 * ry + 1, acc = new Float64Array(W), out = new Float32Array(P);
      for (let z = 0; z < D; z++) {
        const zo = z * P;
        acc.fill(0);
        for (let j = -ry; j <= ry; j++) { const so = zo + clampi(j, 0, H - 1) * W; for (let x = 0; x < W; x++) acc[x] += cur[so + x]; }
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) out[y * W + x] = acc[x] / w;
          const ad = zo + clampi(y + ry + 1, 0, H - 1) * W, sb = zo + clampi(y - ry, 0, H - 1) * W;
          for (let x = 0; x < W; x++) acc[x] += cur[ad + x] - cur[sb + x];
        }
        cur.set(out, zo);
      }
    }
    if (rz > 0 && D > 1) {
      const w = 2 * rz + 1, acc = new Float64Array(P), out = new Float32Array(ctx.N);
      for (let j = -rz; j <= rz; j++) { const so = clampi(j, 0, D - 1) * P; for (let i = 0; i < P; i++) acc[i] += cur[so + i]; }
      for (let z = 0; z < D; z++) {
        const zo = z * P;
        for (let i = 0; i < P; i++) out[zo + i] = acc[i] / w;
        const ad = clampi(z + rz + 1, 0, D - 1) * P, sb = clampi(z - rz, 0, D - 1) * P;
        for (let i = 0; i < P; i++) acc[i] += cur[ad + i] - cur[sb + i];
      }
      cur = out;
    }
    return cur;
  }

  // van Herk / Gil-Werman running min or max along one axis
  function minMaxAxis(src, ctx, axis, r, isMax) {
    const { W, H, D } = ctx, P = W * H;
    const out = new Float32Array(ctx.N);
    if (r <= 0) { out.set(src); return out; }
    const n = axis === 0 ? W : axis === 1 ? H : D;
    const stride = axis === 0 ? 1 : axis === 1 ? W : P;
    const w = 2 * r + 1, L = Math.ceil((n + 2 * r) / w) * w;
    const p = new Float32Array(L), g = new Float32Array(L), h = new Float32Array(L);
    const pad = isMax ? -Infinity : Infinity;
    const nLines = ctx.N / n;
    for (let li = 0; li < nLines; li++) {
      let base;
      if (axis === 0) base = li * W;
      else if (axis === 1) { const z = (li / W) | 0, x = li % W; base = z * P + x; }
      else base = li;
      p.fill(pad);
      for (let i = 0; i < n; i++) p[i + r] = src[base + i * stride];
      for (let s = 0; s < L; s += w) {
        g[s] = p[s];
        for (let i = s + 1; i < s + w; i++) g[i] = isMax ? (p[i] > g[i - 1] ? p[i] : g[i - 1]) : (p[i] < g[i - 1] ? p[i] : g[i - 1]);
        h[s + w - 1] = p[s + w - 1];
        for (let i = s + w - 2; i >= s; i--) h[i] = isMax ? (p[i] > h[i + 1] ? p[i] : h[i + 1]) : (p[i] < h[i + 1] ? p[i] : h[i + 1]);
      }
      for (let x = 0; x < n; x++) {
        const A = h[x], B = g[x + w - 1];
        out[base + x * stride] = isMax ? (A > B ? A : B) : (A < B ? A : B);
      }
    }
    return out;
  }
  function minMaxFilter(src, ctx, rx, ry, rz, isMax) {
    let c = minMaxAxis(src, ctx, 0, rx, isMax);
    c = minMaxAxis(c, ctx, 1, ry, isMax);
    if (ctx.D > 1 && rz > 0) c = minMaxAxis(c, ctx, 2, rz, isMax);
    return c;
  }

  // ----------------------------------------------------------- median filter
  function qselect(a, n, k) {
    let l = 0, r = n - 1;
    while (r > l) {
      const piv = a[(l + r) >> 1];
      let i = l, j = r;
      while (i <= j) {
        while (a[i] < piv) i++;
        while (a[j] > piv) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (j < k) l = i;
      if (k < i) r = j;
    }
    return a[k];
  }
  function median(src, ctx, rx, ry, rz) {
    const { W, H, D } = ctx, P = W * H;
    if (D === 1) rz = 0;
    const n = (2 * rx + 1) * (2 * ry + 1) * (2 * rz + 1);
    const buf = new Float32Array(n), out = new Float32Array(ctx.N), half = n >> 1;
    for (let z = 0; z < D; z++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let c = 0;
          for (let k = -rz; k <= rz; k++) {
            const zo = clampi(z + k, 0, D - 1) * P;
            for (let j = -ry; j <= ry; j++) {
              const yo = zo + clampi(y + j, 0, H - 1) * W;
              for (let i = -rx; i <= rx; i++) buf[c++] = src[yo + clampi(x + i, 0, W - 1)];
            }
          }
          out[z * P + y * W + x] = qselect(buf, n, half);
        }
      }
      ctx.report((z + 1) / D, 'Median filter');
    }
    return out;
  }

  // -------------------------------------------------------------- 2D CLAHE
  function clahe(src, ctx, tiles, clip) {
    const { W, H, D } = ctx, P = W * H, NB = 256;
    const [lo, hi] = [percentile(src, 0.05), percentile(src, 99.95)];
    const scale = NB / ((hi - lo) || 1);
    const tx = Math.max(1, Math.min(tiles, W)), ty = Math.max(1, Math.min(tiles, Math.round(tiles * H / W) || 1));
    const tw = W / tx, th = H / ty;
    const maps = new Float32Array(tx * ty * NB);
    const out = new Float32Array(ctx.N);
    const bins = new Uint8Array(P);
    for (let z = 0; z < D; z++) {
      const zo = z * P;
      for (let i = 0; i < P; i++) bins[i] = clampi(((src[zo + i] - lo) * scale) | 0, 0, NB - 1);
      for (let j = 0; j < ty; j++) {
        for (let i = 0; i < tx; i++) {
          const x0 = Math.round(i * tw), x1 = Math.round((i + 1) * tw), y0 = Math.round(j * th), y1 = Math.round((j + 1) * th);
          const hst = new Float64Array(NB);
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hst[bins[y * W + x]]++;
          const count = (x1 - x0) * (y1 - y0) || 1;
          const limit = Math.max(1, clip * count / NB);
          let excess = 0;
          for (let b = 0; b < NB; b++) if (hst[b] > limit) { excess += hst[b] - limit; hst[b] = limit; }
          const add = excess / NB;
          let c = 0;
          const m = (j * tx + i) * NB;
          for (let b = 0; b < NB; b++) { c += hst[b] + add; maps[m + b] = c / count; }
        }
      }
      for (let y = 0; y < H; y++) {
        const fy = (y + 0.5) / th - 0.5, j0 = Math.floor(fy), ay = fy - j0;
        const ja = clampi(j0, 0, ty - 1), jb = clampi(j0 + 1, 0, ty - 1);
        for (let x = 0; x < W; x++) {
          const fx = (x + 0.5) / tw - 0.5, i0 = Math.floor(fx), ax = fx - i0;
          const ia = clampi(i0, 0, tx - 1), ib = clampi(i0 + 1, 0, tx - 1);
          const b = bins[y * W + x];
          const v00 = maps[(ja * tx + ia) * NB + b], v10 = maps[(ja * tx + ib) * NB + b];
          const v01 = maps[(jb * tx + ia) * NB + b], v11 = maps[(jb * tx + ib) * NB + b];
          out[zo + y * W + x] = (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
        }
      }
      ctx.report((z + 1) / D, 'CLAHE');
    }
    return out;
  }

  // ------------------------------------------------- derivatives & Hessian
  function gradientMagnitude(src, ctx, sigma) {
    const { W, H, D, sx, sy, sz } = ctx, P = W * H;
    const g = sigma > 0 ? gaussian(src, ctx, sigma, sigma, 0, 0.6) : toF32(src);
    const out = new Float32Array(ctx.N);
    for (let z = 0; z < D; z++) {
      const zm = Math.max(0, z - 1) * P, zp = Math.min(D - 1, z + 1) * P, dz = D > 1 ? (zp - zm) / P * sz : 1;
      for (let y = 0; y < H; y++) {
        const ym = Math.max(0, y - 1), yp = Math.min(H - 1, y + 1), dy = (yp - ym) * sy || 1;
        for (let x = 0; x < W; x++) {
          const xm = Math.max(0, x - 1), xp = Math.min(W - 1, x + 1), dx = (xp - xm) * sx || 1;
          const i = z * P + y * W;
          const gx = (g[i + xp] - g[i + xm]) / dx;
          const gy = (g[z * P + yp * W + x] - g[z * P + ym * W + x]) / dy;
          const gz = D > 1 ? (g[zp + y * W + x] - g[zm + y * W + x]) / dz : 0;
          out[i + x] = Math.sqrt(gx * gx + gy * gy + gz * gz);
        }
      }
      ctx.report(0.6 + 0.4 * (z + 1) / D, 'Gradient');
    }
    return out;
  }

  function laplacianOfGaussian(src, ctx, sigma, a = 0, b = 1) {
    const { W, H, D, sx, sy, sz } = ctx, P = W * H;
    const g = gaussian(src, ctx, sigma, sigma, a, a + (b - a) * 0.7, 'LoG');
    const out = new Float32Array(ctx.N);
    const ix = 1 / (sx * sx), iy = 1 / (sy * sy), iz = 1 / (sz * sz), s2 = sigma * sigma;
    for (let z = 0; z < D; z++) {
      const zm = Math.max(0, z - 1) * P, zp = Math.min(D - 1, z + 1) * P, zo = z * P;
      for (let y = 0; y < H; y++) {
        const ym = Math.max(0, y - 1) * W, yp = Math.min(H - 1, y + 1) * W, yo = y * W;
        for (let x = 0; x < W; x++) {
          const xm = Math.max(0, x - 1), xp = Math.min(W - 1, x + 1);
          const c = g[zo + yo + x];
          let lap = (g[zo + yo + xp] + g[zo + yo + xm] - 2 * c) * ix + (g[zo + yp + x] + g[zo + ym + x] - 2 * c) * iy;
          if (D > 1) lap += (g[zp + yo + x] + g[zm + yo + x] - 2 * c) * iz;
          out[zo + yo + x] = -s2 * lap;
        }
      }
      ctx.report(a + (b - a) * (0.7 + 0.3 * (z + 1) / D), 'LoG');
    }
    return out;
  }

  function eig3abs(a, b, c, d, e, f, out) {
    // symmetric [[a,d,e],[d,b,f],[e,f,c]] -> eigenvalues sorted by |λ| ascending
    const p1 = d * d + e * e + f * f;
    let e1, e2, e3;
    if (p1 < 1e-30) { e1 = a; e2 = b; e3 = c; }
    else {
      const q = (a + b + c) / 3;
      const p2 = (a - q) * (a - q) + (b - q) * (b - q) + (c - q) * (c - q) + 2 * p1;
      const p = Math.sqrt(p2 / 6), inv = 1 / p;
      const B00 = (a - q) * inv, B11 = (b - q) * inv, B22 = (c - q) * inv, B01 = d * inv, B02 = e * inv, B12 = f * inv;
      let r = (B00 * (B11 * B22 - B12 * B12) - B01 * (B01 * B22 - B12 * B02) + B02 * (B01 * B12 - B11 * B02)) / 2;
      r = r <= -1 ? -1 : r >= 1 ? 1 : r;
      const phi = Math.acos(r) / 3;
      e1 = q + 2 * p * Math.cos(phi);
      e3 = q + 2 * p * Math.cos(phi + 2.0943951023931953);
      e2 = 3 * q - e1 - e3;
    }
    // sort by magnitude
    let t;
    if (Math.abs(e1) > Math.abs(e2)) { t = e1; e1 = e2; e2 = t; }
    if (Math.abs(e2) > Math.abs(e3)) { t = e2; e2 = e3; e3 = t; }
    if (Math.abs(e1) > Math.abs(e2)) { t = e1; e1 = e2; e2 = t; }
    out[0] = e1; out[1] = e2; out[2] = e3;
  }

  /** Multi-scale Hessian feature: kind = 'tube' | 'blob' | 'sheet'; polarity bright (+1) / dark (-1). */
  /* zAniso = axial/lateral blur ratio of the PSF. Smoothing and scale-normalising Z by σ·zAniso makes
   * a filament whose cross-section is stretched in Z look round again, so tubeness responds to it
   * instead of classifying it as a sheet. */
  function hessianFeature(src, ctx, sigmas, kind, polarity, zAniso = 1) {
    const { W, H, D, sx, sy, sz } = ctx, P = W * H;
    const out = new Float32Array(ctx.N);
    const ev = new Float64Array(3);
    const is3D = D > 1;
    sigmas.forEach((sigma, si) => {
      const a = si / sigmas.length, b = (si + 1) / sigmas.length;
      const sgz = sigma * Math.max(0.2, zAniso || 1);
      const g = gaussian(src, ctx, sigma, sgz, a, a + (b - a) * 0.6, 'Hessian σ=' + sigma);
      const s2 = sigma * sigma * polarity, sz2 = sgz * sgz * polarity, sxz = sigma * sgz * polarity;
      for (let z = 0; z < D; z++) {
        const zm = Math.max(0, z - 1) * P, zp = Math.min(D - 1, z + 1) * P, zo = z * P;
        for (let y = 0; y < H; y++) {
          const ym = Math.max(0, y - 1) * W, yp = Math.min(H - 1, y + 1) * W, yo = y * W;
          for (let x = 0; x < W; x++) {
            const xm = Math.max(0, x - 1), xp = Math.min(W - 1, x + 1);
            const c = g[zo + yo + x];
            const hxx = (g[zo + yo + xp] + g[zo + yo + xm] - 2 * c) / (sx * sx) * s2;
            const hyy = (g[zo + yp + x] + g[zo + ym + x] - 2 * c) / (sy * sy) * s2;
            const hxy = (g[zo + yp + xp] - g[zo + yp + xm] - g[zo + ym + xp] + g[zo + ym + xm]) / (4 * sx * sy) * s2;
            let v = 0;
            if (is3D) {
              const hzz = (g[zp + yo + x] + g[zm + yo + x] - 2 * c) / (sz * sz) * sz2;
              const hxz = (g[zp + yo + xp] - g[zp + yo + xm] - g[zm + yo + xp] + g[zm + yo + xm]) / (4 * sx * sz) * sxz;
              const hyz = (g[zp + yp + x] - g[zp + ym + x] - g[zm + yp + x] + g[zm + ym + x]) / (4 * sy * sz) * sxz;
              eig3abs(hxx, hyy, hzz, hxy, hxz, hyz, ev);
              const l1 = ev[0], l2 = ev[1], l3 = ev[2];
              // Sato/Frangi-style: strength sqrt(λ2·λ3), damped where |λ1| is comparable (blob-like)
              if (kind === 'tube') v = (l2 < 0 && l3 < 0) ? Math.sqrt(l2 * l3) * Math.exp(-2 * (l1 * l1) / (l2 * l3)) : 0;
              else if (kind === 'blob') v = (l1 < 0 && l2 < 0 && l3 < 0) ? Math.cbrt(-l1 * l2 * l3) : 0;
              else v = l3 < 0 ? Math.max(0, -l3 - Math.abs(l2)) : 0;
            } else {
              const tr = (hxx + hyy) / 2, det = Math.sqrt(((hxx - hyy) / 2) ** 2 + hxy * hxy);
              let la = tr + det, lb = tr - det;
              if (Math.abs(la) > Math.abs(lb)) { const t = la; la = lb; lb = t; }
              if (kind === 'blob') v = (la < 0 && lb < 0) ? Math.sqrt(la * lb) : 0;
              else v = lb < 0 ? Math.max(0, -lb - Math.abs(la)) : 0;
            }
            const i = zo + yo + x;
            if (v > out[i]) out[i] = v;
          }
        }
        ctx.report(a + (b - a) * (0.6 + 0.4 * (z + 1) / D), 'Hessian σ=' + sigma);
      }
    });
    return out;
  }

  // --------------------------------------------- distance transform (exact EDT)
  const INF = 1e20;
  function edt1d(f, d, v, zz, n, w) {
    let k = 0;
    v[0] = 0; zz[0] = -INF; zz[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + w * q * q) - (f[v[k]] + w * v[k] * v[k])) / (2 * w * (q - v[k]));
      while (s <= zz[k]) {
        k--;
        s = ((f[q] + w * q * q) - (f[v[k]] + w * v[k] * v[k])) / (2 * w * (q - v[k]));
      }
      k++; v[k] = q; zz[k] = s; zz[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (zz[k + 1] < q) k++;
      d[q] = w * (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }
  /** Euclidean distance (µm) from each voxel to the nearest voxel where isTarget(i) is true. */
  function edt(isTargetArr, ctx, targetValueTest, a = 0, b = 1) {
    const { W, H, D, sx, sy, sz } = ctx, P = W * H;
    const g = new Float32Array(ctx.N);
    for (let i = 0; i < ctx.N; i++) g[i] = targetValueTest(isTargetArr[i]) ? 0 : INF;
    const maxn = Math.max(W, H, D);
    const f = new Float64Array(maxn), d = new Float64Array(maxn), v = new Int32Array(maxn), zz = new Float64Array(maxn + 1);
    const axes = [[W, 1, sx], [H, W, sy], [D, P, sz]];
    axes.forEach(([n, stride, sp], ai) => {
      if (n === 1) return;
      const w = sp * sp, nLines = ctx.N / n;
      for (let li = 0; li < nLines; li++) {
        let base;
        if (ai === 0) base = li * W;
        else if (ai === 1) base = ((li / W) | 0) * P + (li % W);
        else base = li;
        for (let i = 0; i < n; i++) f[i] = g[base + i * stride];
        edt1d(f, d, v, zz, n, w);
        for (let i = 0; i < n; i++) g[base + i * stride] = d[i];
        if ((li & 4095) === 0) ctx.report(a + (b - a) * (ai + li / nLines) / 3, 'Distance transform');
      }
    });
    for (let i = 0; i < ctx.N; i++) g[i] = g[i] >= INF * 0.5 ? Infinity : Math.sqrt(g[i]);
    return g;
  }

  // ------------------------------------------------- connected components
  function neighborOffsets(conn) {
    const out = [];
    for (let dz = -1; dz <= 0; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dz === 0 && (dy > 0 || (dy === 0 && dx >= 0))) continue;
      const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (conn === 6 && m > 1) continue;
      if (conn === 18 && m > 2) continue;
      out.push([dx, dy, dz]);
    }
    return out;
  }
  /** Label nonzero voxels. Returns { labels: Int32Array, count }. */
  function connectedComponents(mask, ctx, conn = 26, a = 0, b = 1) {
    const { W, H, D } = ctx, P = W * H;
    const lab = new Int32Array(ctx.N);
    let parent = new Int32Array(4096), next = 1;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const offs = neighborOffsets(D > 1 ? conn : Math.min(conn, 8) === 6 ? 6 : 26).filter((o) => D > 1 || o[2] === 0);
    for (let z = 0; z < D; z++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = z * P + y * W + x;
          if (!mask[i]) continue;
          let l = 0;
          for (let k = 0; k < offs.length; k++) {
            const o = offs[k], xx = x + o[0], yy = y + o[1], zz = z + o[2];
            if (xx < 0 || xx >= W || yy < 0 || zz < 0) continue;
            const m = lab[zz * P + yy * W + xx];
            if (!m) continue;
            if (!l) l = find(m);
            else {
              const rm = find(m);
              if (rm !== l) { if (rm < l) { parent[l] = rm; l = rm; } else parent[rm] = l; }
            }
          }
          if (!l) {
            if (next >= parent.length) { const np = new Int32Array(parent.length * 2); np.set(parent); parent = np; }
            parent[next] = next; l = next++;
          }
          lab[i] = l;
        }
      }
      ctx.report(a + (b - a) * 0.8 * (z + 1) / D, 'Labelling');
    }
    const remap = new Int32Array(next);
    let count = 0;
    for (let i = 1; i < next; i++) { const r = find(i); remap[i] = r === i ? ++count : remap[r]; }
    for (let i = 0; i < ctx.N; i++) if (lab[i]) lab[i] = remap[lab[i]];
    ctx.report(b, 'Labelling');
    return { labels: lab, count };
  }
  function packLabels(lab, count) {
    const out = count < 65535 ? new Uint16Array(lab.length) : new Uint32Array(lab.length);
    out.set(lab);
    return out;
  }
  function labelSizes(lab, count) {
    const s = new Float64Array(count + 1);
    for (let i = 0; i < lab.length; i++) s[lab[i]]++;
    return s;
  }

  // ---------------------------------------------------------- local maxima
  function localMaxima(img, ctx, minValue, maskArr) {
    const { W, H, D } = ctx, P = W * H, cand = [];
    for (let z = 0; z < D; z++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = z * P + y * W + x, v = img[i];
          if (!(v >= minValue) || (maskArr && !maskArr[i])) continue;
          let ok = true;
          for (let dz = -1; dz <= 1 && ok; dz++) {
            const zz = z + dz; if (zz < 0 || zz >= D) continue;
            for (let dy = -1; dy <= 1 && ok; dy++) {
              const yy = y + dy; if (yy < 0 || yy >= H) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx; if (xx < 0 || xx >= W || (!dx && !dy && !dz)) continue;
                const u = img[zz * P + yy * W + xx];
                if (u > v || (u === v && (zz * P + yy * W + xx) < i)) { ok = false; break; }
              }
            }
          }
          if (ok) cand.push(i);
        }
      }
    }
    return cand;
  }
  /** Greedy non-maximum suppression: keep strongest, drop any within minDist µm. */
  function suppress(cand, img, ctx, minDist, maxKeep = 500000) {
    const { W, H, sx, sy, sz } = ctx, P = W * H;
    cand.sort((p, q) => img[q] - img[p]);
    if (cand.length > 4 * maxKeep) cand.length = 4 * maxKeep;
    if (!(minDist > 0)) return cand.slice(0, maxKeep);
    const cell = minDist, grid = new Map(), kept = [], md2 = minDist * minDist;
    for (const i of cand) {
      const z = (i / P) | 0, y = ((i % P) / W) | 0, x = i % W;
      const px = x * sx, py = y * sy, pz = z * sz;
      const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
      let ok = true;
      for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) for (let c = -1; c <= 1 && ok; c++) {
        const lst = grid.get((cx + a) + ',' + (cy + b) + ',' + (cz + c));
        if (!lst) continue;
        for (const q of lst) { const dx = q[0] - px, dy = q[1] - py, dz = q[2] - pz; if (dx * dx + dy * dy + dz * dz < md2) { ok = false; break; } }
      }
      if (!ok) continue;
      const key = cx + ',' + cy + ',' + cz;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push([px, py, pz]);
      kept.push(i);
      if (kept.length >= maxKeep) break;
    }
    return kept;
  }

  // --------------------------------------------------------------- watershed
  /** Marker-controlled flooding from high to low landscape values inside mask (6-connected). */
  function floodWatershed(land, markers, mask, ctx, a, b) {
    const { W, H, D } = ctx, P = W * H, N = ctx.N;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) if (mask[i] && isFinite(land[i])) { if (land[i] < lo) lo = land[i]; if (land[i] > hi) hi = land[i]; }
    const NB = 4096, sc = (NB - 1) / ((hi - lo) || 1);
    const level = (i) => clampi(Math.round(((isFinite(land[i]) ? land[i] : hi) - lo) * sc), 0, NB - 1);
    const head = new Int32Array(NB).fill(-1), tail = new Int32Array(NB).fill(-1), nxt = new Int32Array(N);
    const queued = new Uint8Array(N);
    const lab = markers; // Int32Array, modified in place
    const push = (i, l) => { nxt[i] = -1; if (tail[l] < 0) head[l] = i; else nxt[tail[l]] = i; tail[l] = i; queued[i] = 1; };
    for (let i = 0; i < N; i++) if (lab[i]) push(i, level(i));
    let cur = NB - 1, done = 0;
    while (cur >= 0) {
      const i = head[cur];
      if (i < 0) { cur--; continue; }
      head[cur] = nxt[i]; if (head[cur] < 0) tail[cur] = -1;
      const z = (i / P) | 0, r = i - z * P, y = (r / W) | 0, x = r - y * W, L = lab[i];
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1, z > 0 ? i - P : -1, z < D - 1 ? i + P : -1];
      for (let k = 0; k < 6; k++) {
        const j = nb[k];
        if (j < 0 || queued[j] || !mask[j]) continue;
        lab[j] = L;
        const lj = level(j);
        push(j, lj < cur ? lj : cur);
      }
      if ((++done & 65535) === 0) ctx.report(a + (b - a) * Math.min(1, done / N * 2), 'Watershed');
    }
    return lab;
  }

  // ------------------------------------------------------------ measurements
  function regionProps(labels, intensity, ctx) {
    const { W, H, D, sx, sy, sz } = ctx, P = W * H;
    let max = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] > max) max = labels[i];
    if (max > 2e6) throw new Error('Too many objects to measure (' + max + ')');
    const n = max + 1;
    const cnt = new Float64Array(n), sxA = new Float64Array(n), syA = new Float64Array(n), szA = new Float64Array(n);
    const sxx = new Float64Array(n), syy = new Float64Array(n), szz = new Float64Array(n), sxy = new Float64Array(n), sxz = new Float64Array(n), syz = new Float64Array(n);
    const bx0 = new Int32Array(n).fill(1 << 30), by0 = new Int32Array(n).fill(1 << 30), bz0 = new Int32Array(n).fill(1 << 30);
    const bx1 = new Int32Array(n).fill(-1), by1 = new Int32Array(n).fill(-1), bz1 = new Int32Array(n).fill(-1);
    const isum = new Float64Array(n), isum2 = new Float64Array(n), imin = new Float64Array(n).fill(Infinity), imax = new Float64Array(n).fill(-Infinity);
    const faces = new Float64Array(n);
    const ax = sy * sz, ay = sx * sz, az = sx * sy;
    for (let z = 0; z < D; z++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = z * P + y * W + x, L = labels[i];
          if (!L) continue;
          cnt[L]++;
          const px = x * sx, py = y * sy, pz = z * sz;
          sxA[L] += px; syA[L] += py; szA[L] += pz;
          sxx[L] += px * px; syy[L] += py * py; szz[L] += pz * pz; sxy[L] += px * py; sxz[L] += px * pz; syz[L] += py * pz;
          if (x < bx0[L]) bx0[L] = x; if (x > bx1[L]) bx1[L] = x;
          if (y < by0[L]) by0[L] = y; if (y > by1[L]) by1[L] = y;
          if (z < bz0[L]) bz0[L] = z; if (z > bz1[L]) bz1[L] = z;
          if (intensity) { const v = intensity[i]; isum[L] += v; isum2[L] += v * v; if (v < imin[L]) imin[L] = v; if (v > imax[L]) imax[L] = v; }
          let f = 0;
          if (x === 0 || labels[i - 1] !== L) f += ax;
          if (x === W - 1 || labels[i + 1] !== L) f += ax;
          if (y === 0 || labels[i - W] !== L) f += ay;
          if (y === H - 1 || labels[i + W] !== L) f += ay;
          if (D > 1) {
            if (z === 0 || labels[i - P] !== L) f += az;
            if (z === D - 1 || labels[i + P] !== L) f += az;
          }
          faces[L] += f;
        }
      }
      ctx.report(0.9 * (z + 1) / D, 'Measuring objects');
    }
    const rows = [], vv = sx * sy * sz, ev = new Float64Array(3);
    for (let L = 1; L < n; L++) {
      const c = cnt[L];
      if (!c) continue;
      const mx = sxA[L] / c, my = syA[L] / c, mz = szA[L] / c;
      const cxx = sxx[L] / c - mx * mx + sx * sx / 12, cyy = syy[L] / c - my * my + sy * sy / 12, czz = szz[L] / c - mz * mz + (D > 1 ? sz * sz / 12 : 0);
      const cxy = sxy[L] / c - mx * my, cxz = sxz[L] / c - mx * mz, cyz = syz[L] / c - my * mz;
      eig3abs(cxx, cyy, czz, cxy, cxz, cyz, ev);
      const lam = Array.from(ev).map((e) => Math.max(0, e)).sort((p, q) => q - p);
      const volume = c * vv;
      const area = D > 1 ? faces[L] * (2 / 3) : faces[L] * (Math.PI / 4) / sz; // 3D: µm², 2D: perimeter-ish
      const eqd = D > 1 ? Math.cbrt(6 * volume / Math.PI) : 2 * Math.sqrt(c * sx * sy / Math.PI);
      const sph = D > 1 && area > 0 ? Math.min(1, Math.cbrt(Math.PI) * Math.pow(6 * volume, 2 / 3) / area) : null;
      const major = 2 * Math.sqrt(5 * lam[0]), minor = 2 * Math.sqrt(5 * (D > 1 ? lam[2] : lam[1]));
      const border = bx0[L] === 0 || by0[L] === 0 || bx1[L] === W - 1 || by1[L] === H - 1 || (D > 1 && (bz0[L] === 0 || bz1[L] === D - 1));
      const row = {
        label: L, voxels: c, volume, surface: D > 1 ? area : null, eqDiameter: eqd, sphericity: sph,
        cx: mx, cy: my, cz: mz, major, minor: minor, elongation: minor > 0 ? major / minor : null,
        bbox: [bx0[L], by0[L], bz0[L], bx1[L], by1[L], bz1[L]], border,
      };
      if (intensity) {
        const m = isum[L] / c;
        row.mean = m; row.std = Math.sqrt(Math.max(0, isum2[L] / c - m * m)); row.min = imin[L]; row.max = imax[L]; row.sum = isum[L];
      }
      rows.push(row);
    }
    // nearest neighbour distance between centroids
    nnd(rows.map((r) => [r.cx, r.cy, r.cz])).forEach((d, i) => { rows[i].nnd = d; });
    ctx.report(1, 'Measuring objects');
    return rows;
  }

  function nnd(pts) {
    const n = pts.length, out = new Array(n).fill(null);
    if (n < 2) return out;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const p of pts) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); minz = Math.min(minz, p[2]); maxz = Math.max(maxz, p[2]); }
    const vol = Math.max(1e-9, (maxx - minx) * (maxy - miny) * Math.max(maxz - minz, 1e-3));
    const cell = Math.max(1e-6, Math.cbrt(vol / n) * 1.5);
    const grid = new Map();
    const key = (a, b, c) => a + ',' + b + ',' + c;
    pts.forEach((p, i) => {
      const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    for (let i = 0; i < n; i++) {
      const p = pts[i], cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
      let best = Infinity;
      for (let r = 1; r < 64; r++) {
        for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) {
          if (Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) !== r && r > 1) continue;
          const lst = grid.get(key(cx + a, cy + b, cz + c));
          if (!lst) continue;
          for (const j of lst) {
            if (j === i) continue;
            const q = pts[j], d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
            if (d < best) best = d;
          }
        }
        if (best < Infinity && Math.sqrt(best) <= r * cell) break;
      }
      out[i] = Math.sqrt(best);
    }
    return out;
  }

  // ------------------------------------------------------------------ FFT
  function fft1d(re, im, n, inv) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  /** Radially averaged power spectrum of a 2D image -> dominant wavelength & orientation order. */
  function powerSpectrum(img2d, W, H, sx, sy, minWavelength, maxWavelength) {
    const N = Math.min(2048, nextPow2(W)), M = Math.min(2048, nextPow2(H));
    const re = new Float64Array(N * M), im = new Float64Array(N * M);
    let mean = 0;
    for (let i = 0; i < W * H; i++) mean += img2d[i];
    mean /= W * H;
    const w = Math.min(W, N), h = Math.min(H, M);
    for (let y = 0; y < h; y++) {
      const wy = 0.5 - 0.5 * Math.cos(2 * Math.PI * (y + 0.5) / h);
      for (let x = 0; x < w; x++) {
        const wx = 0.5 - 0.5 * Math.cos(2 * Math.PI * (x + 0.5) / w);
        re[y * N + x] = (img2d[y * W + x] - mean) * wx * wy;
      }
    }
    const rr = new Float64Array(N), ri = new Float64Array(N);
    for (let y = 0; y < M; y++) { fft1d(re.subarray(y * N, y * N + N), im.subarray(y * N, y * N + N), N, false); }
    const cr = new Float64Array(M), ci = new Float64Array(M);
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < M; y++) { cr[y] = re[y * N + x]; ci[y] = im[y * N + x]; }
      fft1d(cr, ci, M, false);
      for (let y = 0; y < M; y++) { re[y * N + x] = cr[y]; im[y * N + x] = ci[y]; }
    }
    void rr; void ri;
    const dkx = 1 / (N * sx), dky = 1 / (M * sy), dk = Math.max(dkx, dky);
    const kmaxAll = Math.min(0.5 / sx, 0.5 / sy);
    const nb = Math.floor(kmaxAll / dk);
    const prof = new Float64Array(nb), cnt = new Float64Array(nb);
    const powImg = new Float32Array(N * M);
    for (let y = 0; y < M; y++) {
      const fy = y < M / 2 ? y : y - M;
      for (let x = 0; x < N; x++) {
        const fx = x < N / 2 ? x : x - N;
        const p = re[y * N + x] ** 2 + im[y * N + x] ** 2;
        powImg[((fy + M / 2) % M) * N + ((fx + N / 2) % N)] = p;
        const k = Math.sqrt((fx * dkx) ** 2 + (fy * dky) ** 2);
        const b = Math.round(k / dk);
        if (b < nb) { prof[b] += p; cnt[b]++; }
      }
    }
    const kArr = [], pArr = [];
    for (let b = 0; b < nb; b++) { kArr.push(b * dk); pArr.push(cnt[b] ? prof[b] / cnt[b] : 0); }
    // Peak search between allowed wavelengths: the local maximum of the smoothed log spectrum with the
    // largest topographic prominence. This ignores the steep low-frequency background, harmonics and
    // the flat noise floor, which all fool a plain arg-max.
    const kMin = Math.max(2.5 * dk, maxWavelength > 0 ? 1 / maxWavelength : 0);
    const kMax = minWavelength > 0 ? Math.min(kmaxAll, 1 / minWavelength) : kmaxAll;
    const sl = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      let s = 0, c = 0;
      for (let j = -1; j <= 1; j++) { const q = b + j; if (q >= 1 && q < nb && pArr[q] > 0) { s += Math.log(pArr[q]); c++; } }
      sl[b] = c ? s / c : -Infinity;
    }
    let b0 = 1; while (b0 < nb && kArr[b0] < kMin) b0++;
    let b1 = nb - 2; while (b1 > b0 && kArr[b1] > kMax) b1--;
    let best = -1, bestProm = 0;
    for (let p = b0 + 1; p < b1; p++) {
      if (!(sl[p] > sl[p - 1] && sl[p] >= sl[p + 1])) continue;
      let lmin = sl[p], rmin = sl[p];
      for (let q = p - 1; q >= b0; q--) { if (sl[q] > sl[p]) break; if (sl[q] < lmin) lmin = sl[q]; }
      for (let q = p + 1; q <= b1; q++) { if (sl[q] > sl[p]) break; if (sl[q] < rmin) rmin = sl[q]; }
      const prom = sl[p] - Math.max(lmin, rmin);
      if (prom > bestProm) { bestProm = prom; best = p; }
    }
    if (bestProm < 0.15) best = -1; // < ~16 % above its surroundings: no clear periodicity
    let peakK = null, wavelength = null, order = null, angle = null;
    if (best > 0) {
      // parabolic refinement on the smoothed log spectrum
      const y0 = sl[best - 1], y1 = sl[best], y2 = sl[best + 1];
      const den = y0 - 2 * y1 + y2;
      const off = den !== 0 ? clampi(0.5 * (y0 - y2) / den, -0.5, 0.5) : 0;
      peakK = (best + off) * dk;
      wavelength = 1 / peakK;
      // orientation order parameter in an annulus around the peak
      let c2 = 0, s2 = 0, tot = 0;
      for (let y = 0; y < M; y++) {
        const fy = y < M / 2 ? y : y - M;
        for (let x = 0; x < N; x++) {
          const fx = x < N / 2 ? x : x - N;
          const kx = fx * dkx, ky = fy * dky, k = Math.sqrt(kx * kx + ky * ky);
          if (k < 0.7 * peakK || k > 1.3 * peakK) continue;
          const p = re[y * N + x] ** 2 + im[y * N + x] ** 2, th = Math.atan2(ky, kx);
          c2 += p * Math.cos(2 * th); s2 += p * Math.sin(2 * th); tot += p;
        }
      }
      order = tot > 0 ? Math.sqrt(c2 * c2 + s2 * s2) / tot : 0;
      angle = (0.5 * Math.atan2(s2, c2)) * 180 / Math.PI; // wave-vector direction (stripes run perpendicular)
    }
    // log power image, 256 px, centred
    const S = 256, out = new Uint8Array(S * S);
    let lmax = -Infinity, lmin = Infinity;
    const lp = new Float32Array(S * S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const v = Math.log10(1e-12 + powImg[Math.floor(j * M / S) * N + Math.floor(i * N / S)]);
      lp[j * S + i] = v;
      if (isFinite(v)) { if (v > lmax) lmax = v; if (v < lmin) lmin = v; }
    }
    const lo = Math.max(lmin, lmax - 6);
    for (let i = 0; i < S * S; i++) out[i] = clampi(Math.round((lp[i] - lo) / ((lmax - lo) || 1) * 255), 0, 255);
    return { k: kArr, power: pArr, peakK, wavelength, order, angle, prominence: bestProm, img: out, imgSize: S, kMin, kMax, kRange: [dkx * N / 2, dky * M / 2] };
  }

  // ------------------------------------------------------------------ OPS
  // Each op: (inputs, params, ctx) -> { layers:[{data, kind, name}], points?, table?, info? }
  const P = (p, k, d) => (p[k] == null || p[k] === '' || Number.isNaN(+p[k]) ? d : +p[k]);
  const vox = (um, s) => Math.max(0, Math.round(um / s));

  const OPS = {
    gaussian(inp, p, ctx) {
      return { layers: [{ data: gaussian(inp[0].data, ctx, P(p, 'sigmaXY', 1), P(p, 'sigmaZ', 1)), kind: 'intensity' }] };
    },
    mean(inp, p, ctx) {
      return { layers: [{ data: boxMean(inp[0].data, ctx, vox(P(p, 'radiusXY', 1), ctx.sx), vox(P(p, 'radiusXY', 1), ctx.sy), vox(P(p, 'radiusZ', 0), ctx.sz)), kind: 'intensity' }] };
    },
    median(inp, p, ctx) {
      const rxy = Math.max(0, P(p, 'radiusXY', 1) | 0), rz = Math.max(0, P(p, 'radiusZ', 1) | 0);
      return { layers: [{ data: median(inp[0].data, ctx, rxy, rxy, rz), kind: 'intensity' }] };
    },
    unsharp(inp, p, ctx) {
      const a = inp[0].data, amt = P(p, 'amount', 1);
      const g = gaussian(a, ctx, P(p, 'sigmaXY', 1), P(p, 'sigmaZ', 1), 0, 0.9);
      for (let i = 0; i < ctx.N; i++) g[i] = Math.max(0, a[i] + amt * (a[i] - g[i]));
      return { layers: [{ data: g, kind: 'intensity' }] };
    },
    background(inp, p, ctx) {
      const a = inp[0].data, r = P(p, 'radius', 10), method = p.method || 'tophat', per2d = p.mode === '2d';
      let bg;
      if (method === 'gaussian') bg = gaussian(a, ctx, r, per2d ? 0 : r, 0, 0.9, 'Background');
      else {
        const rx = vox(r, ctx.sx), ry = vox(r, ctx.sy), rz = per2d ? 0 : vox(r, ctx.sz);
        ctx.report(0.05, 'Morphological opening');
        const er = minMaxFilter(a, ctx, rx, ry, rz, false);
        ctx.report(0.4, 'Morphological opening');
        bg = minMaxFilter(er, ctx, rx, ry, rz, true);
        ctx.report(0.7, 'Smoothing background');
        bg = gaussian(bg, ctx, r / 2, per2d ? 0 : r / 2, 0.7, 0.95, 'Smoothing background');
      }
      if (p.output === 'background') return { layers: [{ data: bg, kind: 'intensity', name: 'Background' }] };
      for (let i = 0; i < ctx.N; i++) bg[i] = Math.max(0, a[i] - bg[i]);
      return { layers: [{ data: bg, kind: 'intensity' }] };
    },
    clahe(inp, p, ctx) {
      return { layers: [{ data: clahe(inp[0].data, ctx, Math.max(1, P(p, 'tiles', 8) | 0), Math.max(1, P(p, 'clip', 2.5))), kind: 'intensity' }] };
    },
    zcorrect(inp, p, ctx) {
      const a = inp[0].data, { D } = ctx, Pn = ctx.W * ctx.H, pc = P(p, 'percentile', 99);
      const stat = [];
      const bgP = percentile(a, 1);
      for (let z = 0; z < D; z++) {
        const sl = a.subarray(z * Pn, (z + 1) * Pn);
        stat.push(Math.max(1e-6, percentile(sl, pc, histogram(sl, 2048)) - bgP));
      }
      let fit = stat.slice();
      if (p.method !== 'perslice') {
        // least squares on log(stat)
        let sz = 0, sl = 0, szz = 0, szl = 0;
        for (let z = 0; z < D; z++) { const l = Math.log(stat[z]); sz += z; sl += l; szz += z * z; szl += z * l; }
        const b = D > 1 ? (D * szl - sz * sl) / (D * szz - sz * sz) : 0, a0 = (sl - b * sz) / D;
        fit = stat.map((_, z) => Math.exp(a0 + b * z));
      } else {
        fit = stat.map((_, z) => { let s = 0, c = 0; for (let k = -2; k <= 2; k++) if (z + k >= 0 && z + k < D) { s += stat[z + k]; c++; } return s / c; });
      }
      const ref = Math.max(...fit);
      const out = new Float32Array(ctx.N);
      for (let z = 0; z < D; z++) {
        const g = Math.min(P(p, 'maxGain', 10), ref / fit[z]);
        for (let i = z * Pn; i < (z + 1) * Pn; i++) { const v = bgP + (a[i] - bgP) * g; out[i] = v < 0 ? 0 : v; }
      }
      return { layers: [{ data: out, kind: 'intensity' }], info: 'Gain range ' + (ref / Math.max(...fit)).toFixed(2) + '–' + Math.min(P(p, 'maxGain', 10), ref / Math.min(...fit)).toFixed(2) + '×' };
    },
    deconv(inp, p, ctx) {
      const a = toF32(inp[0].data), it = Math.max(1, P(p, 'iterations', 10) | 0);
      const sxy = P(p, 'fwhmXY', 0.3) / 2.3548, sz = P(p, 'fwhmZ', 0.8) / 2.3548;
      const [lo] = minmax(a);
      const obs = new Float32Array(ctx.N);
      for (let i = 0; i < ctx.N; i++) obs[i] = a[i] - lo + 1e-3;
      let est = copyF32(obs);
      for (let k = 0; k < it; k++) {
        const s0 = k / it, s1 = (k + 1) / it;
        const blur = gaussian(est, ctx, sxy, sz, s0, s0 + (s1 - s0) / 2, 'Deconvolution ' + (k + 1) + '/' + it);
        for (let i = 0; i < ctx.N; i++) blur[i] = obs[i] / Math.max(blur[i], 1e-6);
        const corr = gaussian(blur, ctx, sxy, sz, s0 + (s1 - s0) / 2, s1, 'Deconvolution ' + (k + 1) + '/' + it);
        for (let i = 0; i < ctx.N; i++) est[i] *= corr[i];
      }
      for (let i = 0; i < ctx.N; i++) est[i] += lo;
      return { layers: [{ data: est, kind: 'intensity' }] };
    },
    intensity(inp, p, ctx) {
      const a = inp[0].data, out = new Float32Array(ctx.N), [lo, hi] = minmax(a), op = p.op || 'invert';
      if (op === 'invert') for (let i = 0; i < ctx.N; i++) out[i] = hi + lo - a[i];
      else if (op === 'log') for (let i = 0; i < ctx.N; i++) out[i] = Math.log1p(Math.max(0, a[i] - lo));
      else if (op === 'sqrt') for (let i = 0; i < ctx.N; i++) out[i] = Math.sqrt(Math.max(0, a[i] - lo));
      else if (op === 'gamma') { const g = P(p, 'value', 0.5), r = (hi - lo) || 1; for (let i = 0; i < ctx.N; i++) out[i] = lo + r * Math.pow((a[i] - lo) / r, g); }
      else if (op === 'normalize') {
        const H = histogram(a, 4096), l = percentile(a, P(p, 'low', 0.1), H), h = percentile(a, P(p, 'high', 99.9), H), r = (h - l) || 1;
        for (let i = 0; i < ctx.N; i++) out[i] = clampi((a[i] - l) / r, 0, 1);
      } else if (op === 'clip') { const l = P(p, 'low', lo), h = P(p, 'high', hi); for (let i = 0; i < ctx.N; i++) out[i] = clampi(a[i], l, h); }
      else if (op === 'scale') { const s = P(p, 'value', 1), o = P(p, 'offset', 0); for (let i = 0; i < ctx.N; i++) out[i] = a[i] * s + o; }
      return { layers: [{ data: out, kind: 'intensity' }] };
    },
    edges(inp, p, ctx) {
      return { layers: [{ data: gradientMagnitude(inp[0].data, ctx, P(p, 'sigma', 0.5)), kind: 'intensity' }] };
    },
    log(inp, p, ctx) {
      const out = laplacianOfGaussian(inp[0].data, ctx, P(p, 'sigma', 1));
      if (p.positive !== false && p.positive !== 'false') for (let i = 0; i < ctx.N; i++) if (out[i] < 0) out[i] = 0;
      return { layers: [{ data: out, kind: 'intensity' }] };
    },
    dog(inp, p, ctx) {
      const s1 = P(p, 'sigma1', 0.5), s2 = P(p, 'sigma2', 2);
      const g1 = gaussian(inp[0].data, ctx, s1, s1, 0, 0.5, 'DoG');
      const g2 = gaussian(inp[0].data, ctx, s2, s2, 0.5, 1, 'DoG');
      const clip = p.positive !== false && p.positive !== 'false';
      for (let i = 0; i < ctx.N; i++) { const v = g1[i] - g2[i]; g1[i] = clip && v < 0 ? 0 : v; }
      return { layers: [{ data: g1, kind: 'intensity' }] };
    },
    hessian(inp, p, ctx) {
      const sig = String(p.sigmas || '1').split(/[ ,;]+/).map(Number).filter((v) => v > 0);
      if (!sig.length) throw new Error('Enter at least one scale (µm)');
      return { layers: [{ data: hessianFeature(inp[0].data, ctx, sig, p.kind || 'tube', p.polarity === 'dark' ? -1 : 1, P(p, 'zAniso', 1)), kind: 'intensity' }] };
    },
    localstd(inp, p, ctx) {
      const a = toF32(inp[0].data), r = P(p, 'radius', 1);
      const rx = vox(r, ctx.sx), ry = vox(r, ctx.sy), rz = vox(r, ctx.sz);
      const m = boxMean(a, ctx, rx, ry, rz);
      ctx.report(0.5, 'Local standard deviation');
      const sq = new Float32Array(ctx.N);
      for (let i = 0; i < ctx.N; i++) sq[i] = a[i] * a[i];
      const m2 = boxMean(sq, ctx, rx, ry, rz);
      for (let i = 0; i < ctx.N; i++) m2[i] = Math.sqrt(Math.max(0, m2[i] - m[i] * m[i]));
      return { layers: [{ data: m2, kind: 'intensity' }] };
    },
    threshold(inp, p, ctx) {
      const a = inp[0].data;
      const t = thresholdValue(a, p.method || 'otsu', p.method === 'percentile' ? P(p, 'percentile', 99) : P(p, 'value', 0));
      const out = new Uint8Array(ctx.N), inv = p.invert === true || p.invert === 'true';
      for (let i = 0; i < ctx.N; i++) out[i] = (a[i] >= t) !== inv ? 1 : 0;
      return { layers: [{ data: out, kind: 'mask' }], info: 'Threshold = ' + fmt(t), threshold: t };
    },
    hysteresis(inp, p, ctx) {
      const a = inp[0].data, lo = P(p, 'low', 0), hi = P(p, 'high', 0);
      const { W, H, D } = ctx, Pn = W * H, out = new Uint8Array(ctx.N);
      const stack = new Int32Array(ctx.N);
      let sp = 0;
      for (let i = 0; i < ctx.N; i++) if (a[i] >= hi) { out[i] = 1; stack[sp++] = i; }
      while (sp > 0) {
        const i = stack[--sp];
        const z = (i / Pn) | 0, r = i - z * Pn, y = (r / W) | 0, x = r - y * W;
        for (let dz = -1; dz <= 1; dz++) { const zz = z + dz; if (zz < 0 || zz >= D) continue;
          for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue;
              const j = zz * Pn + yy * W + xx;
              if (!out[j] && a[j] >= lo) { out[j] = 1; stack[sp++] = j; } } } }
      }
      return { layers: [{ data: out, kind: 'mask' }] };
    },
    localthreshold(inp, p, ctx) {
      const a = toF32(inp[0].data), r = P(p, 'radius', 5), off = P(p, 'offset', 0);
      const rx = vox(r, ctx.sx), ry = vox(r, ctx.sy), rz = p.mode === '2d' ? 0 : vox(r, ctx.sz);
      const m = boxMean(a, ctx, rx, ry, rz);
      const out = new Uint8Array(ctx.N);
      if (p.method === 'sauvola') {
        const sq = new Float32Array(ctx.N);
        for (let i = 0; i < ctx.N; i++) sq[i] = a[i] * a[i];
        const m2 = boxMean(sq, ctx, rx, ry, rz);
        const [lo, hi] = minmax(a), R = (hi - lo) / 2 || 1, k = P(p, 'k', 0.2);
        for (let i = 0; i < ctx.N; i++) {
          const s = Math.sqrt(Math.max(0, m2[i] - m[i] * m[i]));
          out[i] = a[i] > (m[i] - lo) * (1 + k * (s / R - 1)) + lo + off ? 1 : 0;
        }
      } else for (let i = 0; i < ctx.N; i++) out[i] = a[i] > m[i] + off ? 1 : 0;
      return { layers: [{ data: out, kind: 'mask' }] };
    },
    morph(inp, p, ctx) {
      const m = inp[0].data, r = P(p, 'radius', 1), op = p.op || 'open';
      const dil = (src, a, b) => { const d = edt(src, ctx, (v) => v > 0, a, b); const o = new Uint8Array(ctx.N); for (let i = 0; i < ctx.N; i++) o[i] = d[i] <= r ? 1 : 0; return o; };
      const ero = (src, a, b) => { const d = edt(src, ctx, (v) => !(v > 0), a, b); const o = new Uint8Array(ctx.N); for (let i = 0; i < ctx.N; i++) o[i] = src[i] > 0 && d[i] > r ? 1 : 0; return o; };
      let out;
      if (op === 'dilate') out = dil(m, 0, 1);
      else if (op === 'erode') out = ero(m, 0, 1);
      else if (op === 'open') out = dil(ero(m, 0, 0.5), 0.5, 1);
      else out = ero(dil(m, 0, 0.5), 0.5, 1);
      return { layers: [{ data: out, kind: 'mask' }] };
    },
    fillholes(inp, p, ctx) {
      const m = inp[0].data, { W, H, D } = ctx, Pn = W * H;
      const out = new Uint8Array(ctx.N);
      const per2d = p.mode === '2d' || D === 1;
      const outside = new Uint8Array(ctx.N), stack = new Int32Array(ctx.N);
      let sp = 0;
      const seed = (i) => { if (!m[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
      for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || (!per2d && (z === 0 || z === D - 1));
        if (edge) seed(z * Pn + y * W + x);
      }
      while (sp > 0) {
        const i = stack[--sp];
        const z = (i / Pn) | 0, r = i - z * Pn, y = (r / W) | 0, x = r - y * W;
        if (x > 0) seed(i - 1); if (x < W - 1) seed(i + 1);
        if (y > 0) seed(i - W); if (y < H - 1) seed(i + W);
        if (!per2d) { if (z > 0) seed(i - Pn); if (z < D - 1) seed(i + Pn); }
      }
      for (let i = 0; i < ctx.N; i++) out[i] = m[i] || !outside[i] ? 1 : 0;
      return { layers: [{ data: out, kind: 'mask' }] };
    },
    sizefilter(inp, p, ctx) {
      const src = inp[0];
      const vv = ctx.sx * ctx.sy * ctx.sz;
      const toVox = (v) => (p.unit === 'voxels' ? v : v / vv);
      const minV = toVox(P(p, 'min', 0)), maxV = p.max === '' || p.max == null ? Infinity : toVox(P(p, 'max', Infinity));
      let lab, count;
      if (src.kind === 'labels') { lab = src.data; count = minmax(lab)[1]; }
      else { const r = connectedComponents(src.data, ctx, +(p.connectivity || 26), 0, 0.7); lab = r.labels; count = r.count; }
      const sizes = labelSizes(lab, count);
      let kept = 0;
      const keep = new Uint8Array(count + 1);
      for (let l = 1; l <= count; l++) if (sizes[l] >= minV && sizes[l] <= maxV) { keep[l] = 1; kept++; }
      if (src.kind === 'labels') {
        const remap = new Int32Array(count + 1); let c = 0;
        for (let l = 1; l <= count; l++) if (keep[l]) remap[l] = ++c;
        const out = c < 65535 ? new Uint16Array(ctx.N) : new Uint32Array(ctx.N);
        for (let i = 0; i < ctx.N; i++) out[i] = remap[lab[i]];
        return { layers: [{ data: out, kind: 'labels' }], info: kept + ' of ' + count + ' objects kept' };
      }
      const out = new Uint8Array(ctx.N);
      for (let i = 0; i < ctx.N; i++) out[i] = keep[lab[i]];
      return { layers: [{ data: out, kind: 'mask' }], info: kept + ' of ' + count + ' objects kept' };
    },
    label(inp, p, ctx) {
      const { labels, count } = connectedComponents(inp[0].data, ctx, +(p.connectivity || 26));
      return { layers: [{ data: packLabels(labels, count), kind: 'labels' }], info: count + ' objects' };
    },
    watershed(inp, p, ctx) {
      const mask = inp[0].data;
      const minDist = P(p, 'minDistance', 2), smooth = P(p, 'smooth', 0.5);
      let land;
      if (p.landscape === 'intensity' && inp[1]) {
        land = smooth > 0 ? gaussian(inp[1].data, ctx, smooth, smooth, 0, 0.3, 'Smoothing') : copyF32(inp[1].data);
      } else {
        land = edt(mask, ctx, (v) => !(v > 0), 0, 0.3);
        for (let i = 0; i < ctx.N; i++) if (!isFinite(land[i])) land[i] = 0;
        if (smooth > 0) land = gaussian(land, ctx, smooth, smooth, 0.3, 0.4, 'Smoothing distance map');
      }
      ctx.report(0.42, 'Finding seeds');
      for (let i = 0; i < ctx.N; i++) if (!mask[i]) land[i] = -Infinity;
      const cand = localMaxima(land, ctx, -1e30, mask);
      const seeds = suppress(cand, land, ctx, minDist);
      const lab = new Int32Array(ctx.N);
      seeds.forEach((i, k) => { lab[i] = k + 1; });
      floodWatershed(land, lab, mask, ctx, 0.5, 0.95);
      // components without a seed
      let count = seeds.length;
      const rest = new Uint8Array(ctx.N);
      let any = false;
      for (let i = 0; i < ctx.N; i++) if (mask[i] && !lab[i]) { rest[i] = 1; any = true; }
      if (any) {
        const r = connectedComponents(rest, ctx, 26, 0.95, 1);
        for (let i = 0; i < ctx.N; i++) if (r.labels[i]) lab[i] = count + r.labels[i];
        count += r.count;
      }
      return { layers: [{ data: packLabels(lab, count), kind: 'labels' }], info: count + ' objects' };
    },
    spots(inp, p, ctx) {
      const a = inp[0].data, d = P(p, 'diameter', 2);
      const sigma = ctx.D > 1 ? d / (2 * Math.sqrt(3)) : d / (2 * Math.SQRT2);
      const R = laplacianOfGaussian(a, ctx, sigma, 0, 0.6);
      let thr;
      if (p.thresholdMode === 'absolute') thr = P(p, 'threshold', 0);
      else { const [m, s] = meanStd(R); thr = m + P(p, 'threshold', 3) * s; }
      ctx.report(0.65, 'Finding maxima');
      const cand = localMaxima(R, ctx, Math.max(thr, 1e-12), null);
      ctx.report(0.8, 'Suppressing duplicates');
      const kept = suppress(cand, R, ctx, P(p, 'minDistance', d * 0.75), 200000);
      const { W, H, D } = ctx, Pn = W * H;
      const pts = kept.map((i) => {
        const z = (i / Pn) | 0, y = ((i % Pn) / W) | 0, x = i % W;
        let sw = 0, cx = 0, cy = 0, cz = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy, zz = z + dz;
          if (xx < 0 || yy < 0 || zz < 0 || xx >= W || yy >= H || zz >= D) continue;
          const w = Math.max(0, R[zz * Pn + yy * W + xx]);
          sw += w; cx += w * xx; cy += w * yy; cz += w * zz;
        }
        return sw > 0 ? { x: cx / sw, y: cy / sw, z: cz / sw, response: R[i], intensity: a[i] } : { x, y, z, response: R[i], intensity: a[i] };
      });
      const d3 = nnd(pts.map((q) => [q.x * ctx.sx, q.y * ctx.sy, q.z * ctx.sz]));
      pts.forEach((q, k) => { q.nnd = d3[k]; });
      const res = { layers: [], points: pts, info: pts.length + ' spots (LoG threshold ' + fmt(thr) + ')' };
      if (p.makeLabels === true || p.makeLabels === 'true') {
        const lab = pts.length < 65535 ? new Uint16Array(ctx.N) : new Uint32Array(ctx.N);
        const r = d / 2, rx = Math.ceil(r / ctx.sx), ry = Math.ceil(r / ctx.sy), rz = Math.ceil(r / ctx.sz);
        pts.forEach((q, k) => {
          const x0 = Math.round(q.x), y0 = Math.round(q.y), z0 = Math.round(q.z);
          for (let dz = -rz; dz <= rz; dz++) for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) {
            const xx = x0 + dx, yy = y0 + dy, zz = z0 + dz;
            if (xx < 0 || yy < 0 || zz < 0 || xx >= W || yy >= H || zz >= D) continue;
            if ((dx * ctx.sx) ** 2 + (dy * ctx.sy) ** 2 + (dz * ctx.sz) ** 2 > r * r) continue;
            lab[zz * Pn + yy * W + xx] = k + 1;
          }
        });
        res.layers.push({ data: lab, kind: 'labels', name: 'Spots' });
      }
      return res;
    },
    distance(inp, p, ctx) {
      const m = inp[0].data, inside = p.side !== 'outside';
      const d = edt(m, ctx, inside ? (v) => !(v > 0) : (v) => v > 0);
      for (let i = 0; i < ctx.N; i++) if (!isFinite(d[i]) || (inside ? !m[i] : m[i])) d[i] = 0;
      return { layers: [{ data: d, kind: 'intensity' }] };
    },
    math(inp, p, ctx) {
      const a = inp[0].data, b = inp[1].data, op = p.op || 'subtract';
      const logical = { and: 1, or: 1, xor: 1, andnot: 1 }[op];
      if (logical) {
        const out = new Uint8Array(ctx.N);
        for (let i = 0; i < ctx.N; i++) {
          const x = a[i] > 0, y = b[i] > 0;
          out[i] = (op === 'and' ? x && y : op === 'or' ? x || y : op === 'xor' ? x !== y : x && !y) ? 1 : 0;
        }
        return { layers: [{ data: out, kind: 'mask' }] };
      }
      const out = new Float32Array(ctx.N), k = P(p, 'factor', 1);
      for (let i = 0; i < ctx.N; i++) {
        const x = a[i], y = b[i] * k;
        out[i] = op === 'add' ? x + y : op === 'subtract' ? x - y : op === 'multiply' ? x * y : op === 'divide' ? (y !== 0 ? x / y : 0)
          : op === 'min' ? Math.min(x, y) : op === 'max' ? Math.max(x, y) : op === 'absdiff' ? Math.abs(x - y) : op === 'ratio' ? x / (x + y || 1) : x;
      }
      if (p.clip === true || p.clip === 'true') for (let i = 0; i < ctx.N; i++) if (out[i] < 0) out[i] = 0;
      return { layers: [{ data: out, kind: 'intensity' }] };
    },
    applymask(inp, p, ctx) {
      const a = inp[0].data, m = inp[1].data, inv = p.invert === true || p.invert === 'true';
      const out = new (a.constructor)(ctx.N);
      for (let i = 0; i < ctx.N; i++) out[i] = (m[i] > 0) !== inv ? a[i] : 0;
      return { layers: [{ data: out, kind: inp[0].kind }] };
    },
    labelsToMask(inp, p, ctx) {
      const l = inp[0].data, out = new Uint8Array(ctx.N);
      if (p.what === 'boundaries') {
        const { W, H, D } = ctx, Pn = W * H;
        for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = z * Pn + y * W + x, L = l[i];
          if (!L) continue;
          if ((x > 0 && l[i - 1] !== L) || (x < W - 1 && l[i + 1] !== L) || (y > 0 && l[i - W] !== L) || (y < H - 1 && l[i + W] !== L) ||
            (D > 1 && ((z > 0 && l[i - Pn] !== L) || (z < D - 1 && l[i + Pn] !== L)))) out[i] = 1;
        }
      } else for (let i = 0; i < ctx.N; i++) out[i] = l[i] ? 1 : 0;
      return { layers: [{ data: out, kind: 'mask' }] };
    },
    keepLabels(inp, p, ctx) {
      const l = inp[0].data, keep = new Set(p.labels || []);
      const max = minmax(l)[1], remap = new Int32Array(max + 1);
      let c = 0;
      for (let k = 1; k <= max; k++) if (keep.has(k)) remap[k] = ++c;
      const out = c < 65535 ? new Uint16Array(ctx.N) : new Uint32Array(ctx.N);
      for (let i = 0; i < ctx.N; i++) out[i] = remap[l[i]];
      return { layers: [{ data: out, kind: 'labels' }], info: c + ' objects kept' };
    },
    measure(inp, p, ctx) {
      const lab = inp[0].kind === 'mask' ? connectedComponents(inp[0].data, ctx, 26, 0, 0.3).labels : inp[0].data;
      const rows = regionProps(lab, inp[1] ? inp[1].data : null, ctx);
      return { layers: [], table: rows, info: rows.length + ' objects measured' };
    },
    spectrum(inp, p, ctx) {
      const a = inp[0].data, { W, H, D } = ctx, Pn = W * H;
      const img = new Float32Array(Pn);
      if (p.source === 'slice') img.set(a.subarray(p.z * Pn, (p.z + 1) * Pn));
      else if (p.source === 'mean') { for (let z = 0; z < D; z++) for (let i = 0; i < Pn; i++) img[i] += a[z * Pn + i] / D; }
      else { img.fill(-Infinity); for (let z = 0; z < D; z++) for (let i = 0; i < Pn; i++) { const v = a[z * Pn + i]; if (v > img[i]) img[i] = v; } }
      ctx.report(0.3, 'FFT');
      const res = powerSpectrum(img, W, H, ctx.sx, ctx.sy, P(p, 'minWavelength', 0), P(p, 'maxWavelength', 0));
      return { layers: [], spectrum: res, info: res.wavelength ? 'Dominant wavelength ' + res.wavelength.toFixed(3) + ' µm' : 'No clear peak found' };
    },
  };

  function fmt(v) { return Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : v.toPrecision(4); }

  async function run(args, progress) {
    const ctx = makeCtx(args.dims, args.spacing, progress);
    const f = OPS[args.op];
    if (!f) throw new Error('Unknown operation: ' + args.op);
    const res = f(args.inputs, args.params || {}, ctx);
    const transfer = [];
    for (const L of res.layers) {
      L.range = minmax(L.data);
      L.dtype = L.data instanceof Uint8Array ? 'uint8' : L.data instanceof Uint16Array ? 'uint16' : L.data instanceof Uint32Array ? 'uint32' : 'float32';
      if (L.data.byteOffset === 0 && L.data.byteLength === L.data.buffer.byteLength && transfer.indexOf(L.data.buffer) < 0) transfer.push(L.data.buffer);
    }
    return { result: res, transfer };
  }

  return { run, OPS, histogram, percentile, thresholdValue, minmax, meanStd, nnd, powerSpectrum, connectedComponents, edt, gaussian, makeCtx };
}

/* Worker entry point: receives { id, cmd, args } and posts progress / done / error. */
function WorkerMain() {
  let reader = null;
  self.onmessage = async (ev) => {
    const { id, cmd, args } = ev.data;
    const progress = (frac, msg) => self.postMessage({ id, type: 'progress', frac, msg });
    try {
      let result, transfer = [];
      if (cmd === 'czi.open') {
        reader = new CZI.CZIReader(args.file);
        await reader.open();
        result = { summary: reader.summary, xml: reader.xml };
      } else if (cmd === 'czi.load') {
        if (!reader) throw new Error('No CZI file is open');
        result = await reader.loadVolume(args.sel, progress);
        transfer = result.channels.map((c) => c.data.buffer);
      } else if (cmd === 'op') {
        const r = await Proc.run(args, progress);
        result = r.result; transfer = r.transfer;
      } else throw new Error('Unknown worker command ' + cmd);
      self.postMessage({ id, type: 'done', result }, transfer);
    } catch (e) {
      self.postMessage({ id, type: 'error', message: (e && e.message) || String(e) });
    }
  };
}
