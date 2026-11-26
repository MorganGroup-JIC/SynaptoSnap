/* SynaptoSnap — 3D skeletonisation and chromosome (synaptonemal-complex) tracing.
 *
 * Pipeline: mask -> topology-preserving thinning -> skeleton graph (end / junction nodes, edges)
 * -> cleanup (spurs, crossings split into two Y's, small loops) -> pair edge ends at every junction
 * by straightest continuation -> chains -> bridge gaps between aligned ends and split weak joints
 * until N chromosomes remain -> label the mask voxels by nearest traced chromosome.
 *
 * Runs in the worker (heavy parts) and on the main thread (re-labelling and stats after manual edits).
 */
function TracingFactory(Proc) {
  const VERSION = '2026-11-24f (bright-gap links, max bend 75°)';
  'use strict';

  // ------------------------------------------------ simple-point test (Bertrand & Malandain)
  const OFF = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) OFF.push([dx, dy, dz]);
  const IN18 = new Uint8Array(27), FACE = new Uint8Array(27), FACES = [], ADJ26 = [], ADJ6 = [];
  for (let i = 0; i < 27; i++) {
    const a = OFF[i], m = Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]);
    IN18[i] = i !== 13 && m <= 2 ? 1 : 0;
    if (m === 1) { FACE[i] = 1; FACES.push(i); }
  }
  for (let i = 0; i < 27; i++) {
    ADJ26.push([]); ADJ6.push([]);
    if (i === 13) continue;
    for (let j = 0; j < 27; j++) {
      if (j === i || j === 13) continue;
      const a = OFF[i], b = OFF[j], d0 = Math.abs(a[0] - b[0]), d1 = Math.abs(a[1] - b[1]), d2 = Math.abs(a[2] - b[2]);
      if (d0 <= 1 && d1 <= 1 && d2 <= 1) ADJ26[i].push(j);
      if (d0 + d1 + d2 === 1 && IN18[i] && IN18[j]) ADJ6[i].push(j);
    }
  }
  const Q = new Int32Array(32), SEEN = new Uint8Array(27);
  /** n: Uint8Array(27) neighbourhood, centre at 13. True if deleting the centre keeps topology. */
  function isSimple(n) {
    let first = -1, nfg = 0;
    for (let i = 0; i < 27; i++) if (i !== 13 && n[i]) { nfg++; if (first < 0) first = i; }
    if (!nfg) return false;
    SEEN.fill(0);
    let h = 0, t = 0, cnt = 1;
    Q[t++] = first; SEEN[first] = 1;
    while (h < t) {
      const A = ADJ26[Q[h++]];
      for (let k = 0; k < A.length; k++) { const j = A[k]; if (n[j] && !SEEN[j]) { SEEN[j] = 1; Q[t++] = j; cnt++; } }
    }
    if (cnt !== nfg) return false; // foreground would split
    let fb = -1, nfb = 0;
    for (let k = 0; k < 6; k++) { const i = FACES[k]; if (!n[i]) { nfb++; if (fb < 0) fb = i; } }
    if (!nfb) return false; // interior voxel
    SEEN.fill(0);
    h = 0; t = 0;
    Q[t++] = fb; SEEN[fb] = 1;
    let reached = 1;
    while (h < t) {
      const A = ADJ6[Q[h++]];
      for (let k = 0; k < A.length; k++) { const j = A[k]; if (!n[j] && !SEEN[j]) { SEEN[j] = 1; Q[t++] = j; if (FACE[j]) reached++; } }
    }
    return reached === nfb; // exactly one background component touches the centre
  }

  /** Topology-preserving directional thinning to 1-voxel-wide curves (curve end points are kept). */
  function skeletonize(mask, ctx, rep) {
    const { W, H, D } = ctx, P = W * H, N = W * H * D;
    const img = new Uint8Array(N);
    let list = [];
    for (let i = 0; i < N; i++) if (mask[i]) { img[i] = 1; list.push(i); }
    const total = Math.max(1, list.length);
    const n = new Uint8Array(27);
    const load = (x, y, z) => {
      let k = 0, c = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz, zin = zz >= 0 && zz < D;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy, yin = zin && yy >= 0 && yy < H, row = zz * P + yy * W;
          for (let dx = -1; dx <= 1; dx++, k++) { const xx = x + dx; const v = yin && xx >= 0 && xx < W ? img[row + xx] : 0; n[k] = v; c += v; }
        }
      }
      return c - n[13];
    };
    const dirs = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]].slice(0, D > 1 ? 6 : 4);
    const cand = [];
    let changed = true, pass = 0;
    while (changed && pass < 1000) {
      changed = false; pass++;
      for (const [dx, dy, dz] of dirs) {
        cand.length = 0;
        for (let t = 0; t < list.length; t++) {
          const i = list[t];
          if (!img[i]) continue;
          const z = (i / P) | 0, r = i - z * P, y = (r / W) | 0, x = r - y * W;
          const xx = x + dx, yy = y + dy, zz = z + dz;
          if (xx >= 0 && xx < W && yy >= 0 && yy < H && zz >= 0 && zz < D && img[zz * P + yy * W + xx]) continue;
          if (load(x, y, z) <= 1) continue;
          if (isSimple(n)) cand.push(i);
        }
        for (let t = 0; t < cand.length; t++) {
          const i = cand[t], z = (i / P) | 0, r = i - z * P, y = (r / W) | 0, x = r - y * W;
          if (load(x, y, z) > 1 && isSimple(n)) { img[i] = 0; changed = true; }
        }
      }
      list = list.filter((i) => img[i]);
      if (rep) rep(Math.min(0.98, 1 - list.length / total), 'Skeletonising (pass ' + pass + ')');
    }
    return img;
  }

  // ------------------------------------------------ geometry helpers
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a) => { const l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
  function polyLen(p) { let s = 0; for (let i = 1; i < p.length; i++) s += norm(sub(p[i], p[i - 1])); return s; }
  function smoothPts(p) {
    if (p.length < 5) return p;
    const o = p.map((q) => q.slice());
    for (let i = 1; i < p.length - 1; i++) {
      const a = Math.max(0, i - 2), b = Math.min(p.length - 1, i + 2);
      const s = [0, 0, 0];
      for (let j = a; j <= b; j++) { s[0] += p[j][0]; s[1] += p[j][1]; s[2] += p[j][2]; }
      o[i] = [s[0] / (b - a + 1), s[1] / (b - a + 1), s[2] / (b - a + 1)];
    }
    return o;
  }
  /** Point at arc length s along polyline p (clamped to its end). */
  function pointAt(p, s) {
    let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const l = norm(sub(p[i], p[i - 1]));
      if (acc + l >= s) { const f = (s - acc) / (l || 1); return [p[i - 1][0] + f * (p[i][0] - p[i - 1][0]), p[i - 1][1] + f * (p[i][1] - p[i - 1][1]), p[i - 1][2] + f * (p[i][2] - p[i - 1][2])]; }
      acc += l;
    }
    return p[p.length - 1];
  }
  /** Unit vector from the node at `side` of edge e into the edge, measured between arc lengths
   *  skip and skip+L (skipping the distorted zone right at a junction). */
  function endDir(e, side, L, skip = 0) {
    const p = side === 0 ? e.pts : e.pts.slice().reverse();
    const s0 = Math.min(skip, e.length * 0.4);
    const d = sub(pointAt(p, s0 + L), pointAt(p, s0));
    return norm(d) > 1e-9 ? unit(d) : [1, 0, 0];
  }

  // ------------------------------------------------ skeleton -> graph
  function buildGraph(skel, ctx) {
    const { W, H, D, sx, sy, sz } = ctx, P = W * H;
    const vox = [];
    for (let i = 0; i < skel.length; i++) if (skel[i]) vox.push(i);
    const nv = vox.length, at = new Map();
    vox.forEach((v, k) => at.set(v, k));
    const nb = new Array(nv);
    for (let k = 0; k < nv; k++) {
      const i = vox[k], z = (i / P) | 0, r = i - z * P, y = (r / W) | 0, x = r - y * W, l = [];
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue;
        const xx = x + dx, yy = y + dy, zz = z + dz;
        if (xx < 0 || yy < 0 || zz < 0 || xx >= W || yy >= H || zz >= D) continue;
        const j = at.get(zz * P + yy * W + xx);
        if (j !== undefined) l.push(j);
      }
      nb[k] = l;
    }
    const pos = (k) => { const i = vox[k], z = (i / P) | 0, r = i - z * P, y = (r / W) | 0, x = r - y * W; return [x * sx, y * sy, z * sz]; };
    const nodeOf = new Int32Array(nv).fill(-1);
    const nodes = [], edges = [];
    const mkNode = (ks) => {
      const id = nodes.length, c = [0, 0, 0];
      for (const k of ks) { nodeOf[k] = id; const p = pos(k); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
      nodes.push({ id, pos: [c[0] / ks.length, c[1] / ks.length, c[2] / ks.length], vox: ks.map((k) => vox[k]), alive: true });
      return id;
    };
    for (let k = 0; k < nv; k++) {
      if (nb[k].length < 3 || nodeOf[k] !== -1) continue;
      const ks = [k]; nodeOf[k] = -2;
      for (let h = 0; h < ks.length; h++) for (const j of nb[ks[h]]) if (nb[j].length >= 3 && nodeOf[j] === -1) { nodeOf[j] = -2; ks.push(j); }
      mkNode(ks);
    }
    for (let k = 0; k < nv; k++) if (nb[k].length <= 1 && nodeOf[k] === -1) mkNode([k]);
    const edgeOf = new Int32Array(nv).fill(-1);
    const mkEdge = (a, b, chain) => {
      const pts = [nodes[a].pos.slice()];
      for (const k of chain) pts.push(pos(k));
      pts.push(nodes[b].pos.slice());
      const e = { id: edges.length, a, b, pts: smoothPts(pts), vox: chain.map((k) => vox[k]), alive: true };
      e.length = polyLen(e.pts);
      edges.push(e);
    };
    const traceFrom = (nid, startK, firstK) => {
      const eid = edges.length, chain = [firstK];
      edgeOf[firstK] = eid;
      let prev = startK, cur = firstK, end = nid;
      for (let guard = 0; guard <= nv; guard++) {
        let next = -1;
        for (const j of nb[cur]) if (j !== prev) { next = j; if (nodeOf[j] >= 0) break; }
        if (next < 0) break;
        if (nodeOf[next] >= 0) { end = nodeOf[next]; break; }
        if (edgeOf[next] >= 0) break;
        edgeOf[next] = eid; chain.push(next); prev = cur; cur = next;
      }
      mkEdge(nid, end, chain);
    };
    const direct = new Set();
    const nNodes = nodes.length;
    for (let nid = 0; nid < nNodes; nid++) {
      for (const vi of nodes[nid].vox) {
        const k = at.get(vi);
        for (const j of nb[k]) {
          const o = nodeOf[j];
          if (o === nid) continue;
          if (o >= 0) {
            const key = Math.min(nid, o) + ':' + Math.max(nid, o);
            if (!direct.has(key)) { direct.add(key); mkEdge(nid, o, []); }
            continue;
          }
          if (edgeOf[j] >= 0) continue;
          traceFrom(nid, k, j);
        }
      }
    }
    // closed loops with no node: put a node on them
    for (let k = 0; k < nv; k++) {
      if (nodeOf[k] !== -1 || edgeOf[k] >= 0) continue;
      const id = mkNode([k]);
      const j = nb[k].find((q) => nodeOf[q] === -1 && edgeOf[q] < 0);
      if (j !== undefined) traceFrom(id, k, j);
    }
    return { nodes, edges };
  }

  // ------------------------------------------------ graph cleanup
  function incidence(G) {
    const inc = G.nodes.map(() => []);
    for (const e of G.edges) { if (!e.alive) continue; inc[e.a].push([e, 0]); inc[e.b].push([e, 1]); }
    return inc;
  }
  function newEdge(G, a, b, pts, vox) {
    const e = { id: G.edges.length, a, b, pts, vox, alive: true };
    e.length = polyLen(pts);
    G.edges.push(e);
    return e;
  }
  /** Join the two edges meeting at a degree-2 node into one. */
  function mergeAt(G, nid, inc) {
    const ends = inc[nid];
    if (ends.length !== 2 || ends[0][0] === ends[1][0]) return false;
    const [e1, s1] = ends[0], [e2, s2] = ends[1];
    const p1 = s1 === 1 ? e1.pts : e1.pts.slice().reverse(), o1 = s1 === 1 ? e1.a : e1.b;
    const p2 = s2 === 0 ? e2.pts : e2.pts.slice().reverse(), o2 = s2 === 0 ? e2.b : e2.a;
    e1.alive = e2.alive = false;
    G.nodes[nid].alive = false;
    newEdge(G, o1, o2, p1.concat(p2.slice(1)), e1.vox.concat(G.nodes[nid].vox, e2.vox));
    return true;
  }
  function mergeAllDeg2(G) {
    let changed = true;
    while (changed) {
      changed = false;
      const inc = incidence(G);
      for (const nd of G.nodes) if (nd.alive && inc[nd.id].length === 2 && mergeAt(G, nd.id, inc)) { changed = true; break; }
    }
    const inc = incidence(G);
    for (const nd of G.nodes) if (nd.alive && !inc[nd.id].length && !nd.vox.length) nd.alive = false;
  }
  const zRise = (e) => Math.abs(e.pts[e.pts.length - 1][2] - e.pts[0][2]);
  /** Remove side branches shorter than minBranch; with steepLen > 0 also steep (mostly-Z) side
   *  branches up to that length — axial blur and SIM side-lobes produce these, real SCs rarely do. */
  function pruneSpurs(G, minBranch, steepLen = 0) {
    let changed = true;
    while (changed) {
      changed = false;
      const inc = incidence(G), deg = inc.map((l) => l.length);
      const order = G.edges.filter((e) => e.alive && e.a !== e.b).sort((p, q) => p.length - q.length);
      for (const e of order) {
        if (!e.alive) continue;
        if (e.length >= minBranch && !(steepLen > 0 && e.length < steepLen && zRise(e) > 0.5 * e.length)) continue;
        let endN = -1, junc = -1;
        if (deg[e.a] === 1 && deg[e.b] >= 3) { endN = e.a; junc = e.b; } else if (deg[e.b] === 1 && deg[e.a] >= 3) { endN = e.b; junc = e.a; }
        if (endN < 0) continue;
        e.alive = false; G.nodes[endN].alive = false;
        G.nodes[junc].vox = G.nodes[junc].vox.concat(e.vox, G.nodes[endN].vox);
        deg[junc]--; deg[endN] = 0;
        changed = true;
      }
      if (changed) mergeAllDeg2(G);
    }
  }
  /** Collapse edge e into a single node (its two end nodes are fused). */
  function fuse(G, e) {
    const A = G.nodes[e.a], B = G.nodes[e.b];
    const wa = Math.max(1, A.vox.length), wb = Math.max(1, B.vox.length);
    A.pos = A.pos.map((v, k) => (v * wa + B.pos[k] * wb) / (wa + wb));
    A.vox = A.vox.concat(B.vox, e.vox);
    e.alive = false; B.alive = false;
    for (const f of G.edges) {
      if (!f.alive) continue;
      if (f.a === B.id) f.a = A.id;
      if (f.b === B.id) f.b = A.id;
      // move the end to the fused node in xy only — each edge keeps its own depth (see refineZ)
      if (f.a === A.id) f.pts[0] = [A.pos[0], A.pos[1], f.pts[0][2]];
      if (f.b === A.id) f.pts[f.pts.length - 1] = [A.pos[0], A.pos[1], f.pts[f.pts.length - 1][2]];
      f.length = polyLen(f.pts);
    }
  }
  /** Two Y junctions joined by a short edge are one crossing: fuse them. Short edges are always
   *  fused; with rungLen > 0, steep (mostly-Z) edges up to rungLen are too — these are where two
   *  tracks stacked in Z merged through the axial blur, not a track running vertically. */
  function contractShort(G, mergeDist, rungLen = 0) {
    for (;;) {
      const inc = incidence(G);
      const cands = G.edges.filter((e) => e.alive && e.a !== e.b && inc[e.a].length >= 3 && inc[e.b].length >= 3 &&
        (e.length < mergeDist || (rungLen > 0 && e.length < rungLen && zRise(e) > 0.5 * e.length))).sort((p, q) => p.length - q.length);
      if (!cands.length) break;
      fuse(G, cands[0]);
    }
    mergeAllDeg2(G);
  }

  /** Keep mask voxels within ±h slices of a peak of `ref` along Z (per xy column). A peak must be
   *  the maximum within ±r slices, which drops weaker side-lobe copies close above/below a track. */
  function zThin(mask, ref, ctx, h, r = 1) {
    const { W, H, D } = ctx, P = W * H, out = new Uint8Array(ctx.N);
    for (let i = 0; i < P; i++) {
      for (let z = 0; z < D; z++) {
        const o = z * P + i;
        if (!mask[o]) continue;
        const v = ref[o];
        let peak = true;
        for (let k = 1; k <= r && peak; k++) {
          if (z - k >= 0 && ref[o - k * P] > v) peak = false;
          if (z + k < D && ref[o + k * P] >= v) peak = false; // strict on one side so a plateau gives one peak
        }
        if (!peak) continue;
        for (let k = -h; k <= h; k++) {
          const zz = z + k;
          if (zz >= 0 && zz < D && mask[zz * P + i]) out[zz * P + i] = 1;
        }
      }
    }
    return out;
  }

  /** Sub-voxel Z for every skeleton point, from the image profile in its column, then smoothed along
   *  the track. Thinning on coarse Z steps otherwise leaves a staircase that inflates lengths and
   *  makes xy-running tracks look Z-oriented. */
  function refineZ(G, ctx, img, zSmooth = 0.3) {
    const { W, H, D, sx, sy, sz } = ctx, P = W * H;
    if (D < 3 || !img) return;
    const R = 3, prof = new Float64Array(2 * R + 1);
    const zAt = (p) => {
      const xi = Math.min(W - 1, Math.max(0, Math.round(p[0] / sx))), yi = Math.min(H - 1, Math.max(0, Math.round(p[1] / sy)));
      const zi = Math.min(D - 1, Math.max(0, Math.round(p[2] / sz)));
      for (let k = -R; k <= R; k++) {
        const z = zi + k;
        let s = -Infinity;
        if (z >= 0 && z < D) {
          s = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const y = yi + dy; if (y < 0 || y >= H) continue;
            for (let dx = -1; dx <= 1; dx++) { const x = xi + dx; if (x >= 0 && x < W) s += img[z * P + y * W + x]; }
          }
        }
        prof[k + R] = s;
      }
      // brightest plane within ±2 slices of the skeleton point, then weighted centroid around it
      let pk = R;
      for (let k = R - 2; k <= R + 2; k++) if (prof[k] > prof[pk]) pk = k;
      let lo = Infinity;
      for (let k = pk - 2; k <= pk + 2; k++) if (k >= 0 && k <= 2 * R && isFinite(prof[k]) && prof[k] < lo) lo = prof[k];
      let sw = 0, swz = 0;
      for (let k = pk - 2; k <= pk + 2; k++) {
        if (k < 0 || k > 2 * R || !isFinite(prof[k])) continue;
        const wgt = (prof[k] - lo) ** 2;
        sw += wgt; swz += wgt * (zi + k - R);
      }
      return sw > 0 ? (swz / sw) * sz : p[2];
    };
    // Each edge gets its own Z profile right up to its ends. Edge ends are NOT pinned to their node's
    // Z: at a crossing of stacked tracks one node serves two tracks at different depths, and pinning
    // would force one of them to dive vertically into the node.
    const endZ = new Map();
    for (const e of G.edges) {
      if (!e.alive) continue;
      const n = e.pts.length;
      const z = e.pts.map((p, i) => {
        if (n > 2 && i === 0) return zAt([p[0], p[1], e.pts[1][2]]);         // start the column search
        if (n > 2 && i === n - 1) return zAt([p[0], p[1], e.pts[n - 2][2]]); // from the edge's own level
        return zAt(p);
      });
      // Gaussian smoothing of Z over the xy arc length (σ = zSmooth µm): the axial resolution cannot
      // support Z changes over shorter distances, so short "jumps" are estimation noise.
      const s = new Float64Array(n);
      for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
      const zs = z.slice(), sig = Math.max(1e-6, zSmooth), lim = 2.5 * sig;
      for (let i = 0; i < n; i++) {
        let sw = 0, swz = 0;
        for (let j = i; j >= 0 && s[i] - s[j] <= lim; j--) { const wgt = Math.exp(-((s[i] - s[j]) ** 2) / (2 * sig * sig)); sw += wgt; swz += wgt * z[j]; }
        for (let j = i + 1; j < n && s[j] - s[i] <= lim; j++) { const wgt = Math.exp(-((s[j] - s[i]) ** 2) / (2 * sig * sig)); sw += wgt; swz += wgt * z[j]; }
        zs[i] = swz / sw;
      }
      e.pts = e.pts.map((p, i) => [p[0], p[1], zs[i]]);
      e.length = polyLen(e.pts);
      for (const [nid, zv] of [[e.a, zs[0]], [e.b, zs[n - 1]]]) { if (!endZ.has(nid)) endZ.set(nid, []); endZ.get(nid).push(zv); }
    }
    // node markers sit at the mean depth of the edge ends meeting there
    for (const [nid, zl] of endZ) { const nd = G.nodes[nid]; nd.pos = [nd.pos[0], nd.pos[1], zl.reduce((a, b) => a + b, 0) / zl.length]; }
  }
  // ------------------------------------------------ axial sharpening (stacked tracks)
  /**
   * Axial blur of the data, measured on the sharpest bright Z-profiles: the FWHM (µm) at the given
   * percentile over bright voxels (top 3 %) that are local maxima along Z. Thin, flat tracks give
   * the narrowest profiles, so a low percentile approximates the axial PSF. Returns { fwhm, n }.
   */
  function zProfileWidth(I, ctx, pct = 0.25) {
    const { W, H, D, sz } = ctx, P = W * H, N = ctx.N;
    const samp = [];
    for (let i = 0; i < N; i += 13) if (I[i] > 0) samp.push(I[i]);
    if (samp.length < 100) return { fwhm: NaN, n: 0 };
    samp.sort((a, b) => a - b);
    const thr = samp[Math.floor(0.97 * samp.length)];
    const R = Math.max(3, Math.round(1.0 / sz)), widths = [];
    for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < W - 1; x += 2) {
      const c = y * W + x;
      for (let z = 1; z < D - 1; z++) {
        const v = I[z * P + c];
        if (v < thr || v < I[(z - 1) * P + c] || v < I[(z + 1) * P + c]) continue;
        let base = v;
        for (let k = Math.max(0, z - R); k <= Math.min(D - 1, z + R); k++) base = Math.min(base, I[k * P + c]);
        const half = base + (v - base) / 2;
        let l = z, r = z;
        while (l > 0 && l > z - R && I[(l - 1) * P + c] > half) l--;
        while (r < D - 1 && r < z + R && I[(r + 1) * P + c] > half) r++;
        if (l === 0 || r === D - 1 || l <= z - R || r >= z + R) continue;
        const a0 = I[(l - 1) * P + c], a1 = I[l * P + c], b0 = I[(r + 1) * P + c], b1 = I[r * P + c];
        widths.push((r - l + (a1 - half) / Math.max(1e-9, a1 - a0) + (b1 - half) / Math.max(1e-9, b1 - b0)) * sz);
      }
    }
    if (widths.length < 30) return { fwhm: NaN, n: widths.length };
    widths.sort((a, b) => a - b);
    return { fwhm: widths[Math.floor(pct * widths.length)], n: widths.length };
  }
  /**
   * Richardson–Lucy deconvolution along Z only (every xy column on its own) with a Gaussian axial PSF
   * of σ µm. Tracks stacked 0.3–0.6 µm apart, which the axial blur merges into one thick ridge (and a
   * false junction), come apart into separate layers. Returns a new Float32Array.
   */
  function rlZ(I, ctx, sigmaUm, iters, report) {
    const { W, H, D, sz } = ctx, P = W * H, N = ctx.N;
    const s = sigmaUm / sz, r = Math.max(1, Math.ceil(3 * s)), k = [];
    let ks = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * s * s)); k.push(v); ks += v; }
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    let mx = 0;
    for (let i = 0; i < N; i += 7) if (I[i] > mx) mx = I[i];
    const bg = 0.01 * mx + 1e-6; // small offset keeps the ratio stable where SIM data are clipped at 0
    const out = new Float32Array(N), d = new Float64Array(D), est = new Float64Array(D), b = new Float64Array(D), q = new Float64Array(D);
    const blur = (src, dst) => {
      for (let z = 0; z < D; z++) {
        let a = 0;
        for (let j = -r; j <= r; j++) { const zz = z + j < 0 ? 0 : z + j >= D ? D - 1 : z + j; a += src[zz] * k[j + r]; }
        dst[z] = a;
      }
    };
    for (let c = 0; c < P; c++) {
      let any = false;
      for (let z = 0; z < D; z++) { const v = I[z * P + c]; d[z] = v + bg; est[z] = d[z]; if (v > 0) any = true; }
      if (any) for (let it = 0; it < iters; it++) {
        blur(est, b);
        for (let z = 0; z < D; z++) q[z] = d[z] / Math.max(b[z], 1e-9);
        blur(q, b);
        for (let z = 0; z < D; z++) est[z] *= b[z];
      }
      for (let z = 0; z < D; z++) out[z * P + c] = Math.max(0, est[z] - bg);
      if (report && (c & 4095) === 0) report(c / P);
    }
    return out;
  }

  // ------------------------------------------------ faint-ridge links (second joining pass)
  const LINK_SCORE = 0.6;
  const BRIGHT_SCORE = 0; // bright-gap links (third joining pass): accept above this score
  /**
   * Faint-ridge test for linking two track ends: is there a path from end a to end b through voxels
   * whose ridge response is at least `frac` × the detection threshold, no longer than 1.5 × their
   * distance + 0.25 µm, that never touches another traced track? A dim stretch of the same SC
   * usually leaves such a path; two different tracks usually do not. Returns (ea, eb, pa, pb, d) → bool
   * with ea/eb the graph edge ids of the two ends.
   */
  function makeRidgeLink(G, tube, thr, ctx, frac = 0.25) {
    const { W, H, D, sx, sy, sz } = ctx, P = W * H, N = ctx.N;
    const own = new Int32Array(N).fill(-1); // traced tracks, widened by one voxel in xy
    for (const e of G.edges) {
      if (!e.alive) continue;
      for (const v of e.vox) {
        const z = (v / P) | 0, r = v - z * P, y = (r / W) | 0, x = r - y * W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const u = z * P + yy * W + xx;
          if (own[u] < 0) own[u] = e.id;
        }
      }
    }
    const seen = new Int32Array(N), dist = new Float32Array(N), q = new Int32Array(1 << 18);
    const lo = frac * thr, step = [];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) step.push([dx, dy, dz, Math.hypot(dx * sx, dy * sy, dz * sz)]);
    const vox = (p) => Math.min(D - 1, Math.max(0, Math.round(p[2] / sz))) * P + Math.min(H - 1, Math.max(0, Math.round(p[1] / sy))) * W + Math.min(W - 1, Math.max(0, Math.round(p[0] / sx)));
    let stamp = 0;
    return (ea, eb, pa, pb, d) => {
      const va = vox(pa), vb = vox(pb), zb = (vb / P) | 0, rb = vb - zb * P, yb = (rb / W) | 0, xb = rb - yb * W;
      const maxLen = 1.5 * d + 0.25;
      stamp++;
      let qh = 0, qt = 0;
      q[qt++] = va; seen[va] = stamp; dist[va] = 0;
      while (qh < qt) {
        const v = q[qh++], z = (v / P) | 0, r = v - z * P, y = (r / W) | 0, x = r - y * W;
        if (Math.abs(x - xb) <= 1 && Math.abs(y - yb) <= 1 && Math.abs(z - zb) <= 1) return true;
        for (const [dx, dy, dz, l] of step) {
          const xx = x + dx, yy = y + dy, zz = z + dz;
          if (xx < 0 || yy < 0 || zz < 0 || xx >= W || yy >= H || zz >= D) continue;
          const u = zz * P + yy * W + xx;
          if (seen[u] === stamp || tube[u] < lo) continue;
          const o = own[u];
          if (o >= 0 && o !== ea && o !== eb) continue;
          const nd = dist[v] + l;
          if (nd > maxLen) continue;
          seen[u] = stamp; dist[u] = nd;
          if (qt < q.length) q[qt++] = u;
        }
      }
      return false;
    };
  }

  /** Remove small loops (holes in the mask) and duplicate parallel paths. */
  function removeBubbles(G, maxLoop) {
    for (const e of G.edges) if (e.alive && e.a === e.b && e.length < maxLoop) { e.alive = false; G.nodes[e.a].vox = G.nodes[e.a].vox.concat(e.vox); }
    const groups = new Map();
    for (const e of G.edges) {
      if (!e.alive || e.a === e.b) continue;
      const key = Math.min(e.a, e.b) + ':' + Math.max(e.a, e.b);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((p, q) => p.length - q.length);
      for (let i = 1; i < g.length; i++) if (g[i].length < maxLoop) { g[i].alive = false; G.nodes[g[i].a].vox = G.nodes[g[i].a].vox.concat(g[i].vox); }
    }
    mergeAllDeg2(G);
  }

  // ------------------------------------------------ continuation geometry (layered tracks)
  /** Geometry of an edge end: direction into the edge, its xy projection, and the mean Z of the
   *  arm (sampled between skip and skip+L from the node). */
  function armInfo(e, side, skip, L) {
    const p = side === 0 ? e.pts : e.pts.slice().reverse();
    const s0 = Math.min(skip, e.length * 0.4);
    const d = sub(pointAt(p, s0 + L), pointAt(p, s0));
    let z = 0;
    for (let k = 0; k <= 4; k++) z += pointAt(p, s0 + (L * k) / 4)[2];
    const nxy = Math.hypot(d[0], d[1]);
    return { dir: norm(d) > 1e-9 ? unit(d) : [1, 0, 0], xy: nxy > 1e-9 ? [d[0] / nxy, d[1] / nxy] : null, z: z / 5 };
  }
  const angleXY = (a, b) => (a && b ? Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) : Math.PI / 2);
  /**
   * Cost of continuing from arm a into arm b at a junction.
   * zp = 0: isotropic — the 3D bend angle.
   * zp > 0: tracks run in xy layers — bend of the xy projections, plus a penalty on the change in
   * Z level between the two arms (zRef ≈ axial resolution). At a crossing of stacked tracks that
   * merged through the axial blur, this keeps each track on its own layer instead of taking the
   * straight-in-3D diagonal down to the other track.
   */
  function joinCost(a, b, zp, zRef, bend) {
    if (!(zp > 0)) { const th = Math.PI - angle(a.dir, b.dir); return { th, cost: bend(th) }; }
    const th = Math.PI - angleXY(a.xy, b.xy);
    return { th, cost: bend(th) + zp * ((a.z - b.z) / zRef) ** 2 };
  }
  /** Alignment of two tips with the gap vector g between them (xy angles when zp > 0) and the
   *  Z-change penalty. */
  function gapAngles(a, b, g, zp, zRef) {
    if (!(zp > 0)) {
      return { tx: angle([-a.dir[0], -a.dir[1], -a.dir[2]], g), ty: angle([-b.dir[0], -b.dir[1], -b.dir[2]], [-g[0], -g[1], -g[2]]), zc: 0 };
    }
    const gl = Math.hypot(g[0], g[1]);
    const gxy = gl > 1e-9 ? [g[0] / gl, g[1] / gl] : null;
    const tx = gxy ? angleXY(a.xy && [-a.xy[0], -a.xy[1]], gxy) : 0;
    const ty = gxy ? angleXY(b.xy && [-b.xy[0], -b.xy[1]], [-gxy[0], -gxy[1]]) : 0;
    return { tx, ty, zc: zp * (g[2] / zRef) ** 2 };
  }

  /**
   * Bright-gap test for the third joining pass: the dimmest point along the straight gap between
   * two ends, relative to the dimmer end (raw intensity; each sample is the brightest of 3 × 3
   * voxels in xy, since the straight line may run a voxel beside the track).
   */
  function makeGapBrightness(I, ctx) {
    const { W, H, D, sx, sy, sz } = ctx;
    const at = (p) => {
      const x = Math.round(p[0] / sx), y = Math.round(p[1] / sy), z = Math.max(0, Math.min(D - 1, Math.round(p[2] / sz)));
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.max(0, Math.min(W - 1, x + dx)), yy = Math.max(0, Math.min(H - 1, y + dy)), v = I[(z * H + yy) * W + xx];
        if (v > m) m = v;
      }
      return m;
    };
    return (pa, pb) => {
      const ref = Math.max(1, Math.min(at(pa), at(pb)));
      let mn = Infinity;
      for (let t = 0.1; t <= 0.9001; t += 0.05) mn = Math.min(mn, at([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]));
      return mn / ref;
    };
  }

  // ------------------------------------------------ continuation joins -> N chromosome paths
  /**
   * Every edge end can be continued by at most one other edge end, either straight through a
   * junction or across a gap. All candidate continuations are ranked by bend angle (and gap
   * length) and accepted greedily without ever closing a loop (Kruskal-style), so the result is
   * always a set of linear paths. Confident continuations are always taken; weaker ones only
   * while there are more than N chromosome-length paths. Too few paths -> the weakest
   * continuations are undone.
   * prm: { n, Ldir, width, maxGap, maxBend (rad), minLen }
   */
  function resolve(G, prm) {
    const edges = G.edges.filter((e) => e.alive);
    const E = edges.length;
    const idx = new Map(edges.map((e, i) => [e.id, i]));
    const inc = incidence(G);
    const node = (x) => ((x & 1) === 0 ? edges[x >> 1].a : edges[x >> 1].b);
    const arms = new Array(2 * E);
    for (let x = 0; x < 2 * E; x++) arms[x] = armInfo(edges[x >> 1], x & 1, prm.skip || 0, prm.Ldir);
    const dirs = arms.map((a) => a.dir); // into the edge
    const weak = (x) => edges[x >> 1].length < 1.5 * prm.width; // direction of very short pieces is unreliable
    const zp = prm.zPenalty || 0, zRef = prm.zRef || 0.3;
    // all candidate continuations, judged against the current bend limit (prm.maxBend)
    const makeCands = () => {
    const bend = (th) => (th / prm.maxBend) ** 2;
    const FORCE_ANGLE = Math.min(Math.PI * 0.75, prm.maxBend * 2);
    const cand = [];
    // straight-through continuations at junctions
    for (const nd of G.nodes) {
      if (!nd.alive) continue;
      const ends = inc[nd.id].map(([e, s]) => idx.get(e.id) * 2 + s);
      for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
        const x = ends[i], y = ends[j];
        if (x >> 1 === y >> 1) continue;
        const { th, cost } = joinCost(arms[x], arms[y], zp, zRef, bend);
        if (th > FORCE_ANGLE) continue;
        cand.push({ x, y, type: 'junction', node: nd.id, cost, normal: th <= prm.maxBend, d: 0 });
      }
    }
    // continuations across gaps
    const R2 = prm.maxGap * 2.5;
    for (let x = 0; x < 2 * E; x++) for (let y = x + 1; y < 2 * E; y++) {
      if (x >> 1 === y >> 1) continue;
      const na = node(x), nb = node(y);
      if (na === nb) continue;
      const pa = G.nodes[na].pos, pb = G.nodes[nb].pos, g = sub(pb, pa), d = norm(g);
      if (d > R2 || d < 1e-9) continue;
      const { tx, ty, zc } = gapAngles(arms[x], arms[y], g, zp, zRef);
      const wx = weak(x) ? 0.25 : 1, wy = weak(y) ? 0.25 : 1;
      if (tx * wx > FORCE_ANGLE || ty * wy > FORCE_ANGLE) continue;
      const normal = d <= prm.maxGap && tx * wx <= prm.maxBend && ty * wy <= prm.maxBend;
      cand.push({ x, y, type: 'bridge', a: na, b: nb, pa, pb, d, cost: 0.3 + d / prm.maxGap + 0.5 * (wx * bend(tx) + wy * bend(ty)) + zc, normal, tx, ty });
    }
    if (prm.allow) for (let i = cand.length - 1; i >= 0; i--) if (!prm.allow(cand[i], edges)) cand.splice(i, 1); // testing hook
    cand.sort((p, q) => p.cost - q.cost);
    return cand;
    };
    let cand = makeCands();

    // union-find over edges, tracking path length
    const parent = new Int32Array(E), len = new Float64Array(E);
    edges.forEach((e, i) => { parent[i] = i; len[i] = e.length; });
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    let major = 0;
    for (let i = 0; i < E; i++) if (len[i] >= prm.minLen) major++;
    const partner = new Int32Array(2 * E).fill(-1), joinOf = new Map();
    const accept = (c, forced) => {
      if (partner[c.x] >= 0 || partner[c.y] >= 0) return false;
      const ra = find(c.x >> 1), rb = find(c.y >> 1);
      if (ra === rb) return false;
      const la = len[ra], lb = len[rb], l = la + lb + c.d;
      parent[ra] = rb; len[rb] = l;
      major += (l >= prm.minLen ? 1 : 0) - (la >= prm.minLen ? 1 : 0) - (lb >= prm.minLen ? 1 : 0);
      partner[c.x] = c.y; partner[c.y] = c.x;
      const j = Object.assign({}, c, { forced: !!forced });
      joinOf.set(c.x, j); joinOf.set(c.y, j);
      return true;
    };
    const lenOf = (x) => len[find(x >> 1)];

    /* Exact global optimum (branch & bound): choose continuations so that the non-noise edges form
     * exactly N' linear paths (N' = N, or the smallest feasible value above it) with minimum total
     * cost. Leaving an edge end free costs nothing at a tip (telomere or gap) and `freeJunction`
     * at a junction (a chromosome end touching another one). */
    const exactJoins = () => {
      const NE = 2 * E;
      if (NE > 120) return null;
      const degN = new Map();
      for (let x = 0; x < NE; x++) degN.set(node(x), (degN.get(node(x)) || 0) + 1);
      const freeCost = new Float64Array(NE);
      for (let x = 0; x < NE; x++) freeCost[x] = degN.get(node(x)) >= 2 ? prm.freeJunction : 0;
      const gapOK = new Uint8Array(NE);
      for (const c of cand) if (c.type === 'bridge' && c.normal) { gapOK[c.x] = 1; gapOK[c.y] = 1; }
      const noise = new Uint8Array(E);
      for (let i = 0; i < E; i++) {
        const a = 2 * i, b = a + 1;
        if (degN.get(node(a)) === 1 && degN.get(node(b)) === 1 && edges[i].length < prm.minLen && !gapOK[a] && !gapOK[b]) noise[i] = 1;
      }
      const opts = Array.from({ length: NE }, () => []);
      for (const c of cand) {
        if (noise[c.x >> 1] || noise[c.y >> 1]) continue;
        const cost = c.cost + (c.normal ? 0 : 1.5);
        opts[c.x].push({ y: c.y, cost, c }); opts[c.y].push({ y: c.x, cost, c });
      }
      const ends = [];
      for (let x = 0; x < NE; x++) if (!noise[x >> 1]) ends.push(x);
      ends.sort((p, q) => opts[p].length - opts[q].length);
      const minCost = new Float64Array(NE);
      for (const x of ends) { let m = freeCost[x]; for (const o of opts[x]) m = Math.min(m, o.cost / 2); minCost[x] = m; }
      for (const x of ends) opts[x].sort((p, q) => p.cost - q.cost);
      const nEdges = ends.length / 2;
      // length prior: a chromosome much shorter than the average one is implausible
      let total = 0;
      for (let i = 0; i < E; i++) if (!noise[i]) total += edges[i].length;
      const Lmin = (prm.minChromFrac == null ? 0.35 : prm.minChromFrac) * total / Math.max(1, prm.n);
      const ufp = new Int32Array(E), ufl = new Float64Array(E);
      const uf = (a) => { while (ufp[a] !== a) a = ufp[a] = ufp[ufp[a]]; return a; };
      const lengthPenalty = (sel) => {
        for (let i = 0; i < E; i++) { ufp[i] = i; ufl[i] = edges[i].length; }
        for (const c of sel) { const a = uf(c.x >> 1), b = uf(c.y >> 1); if (a !== b) { ufp[a] = b; ufl[b] += ufl[a] + c.d; } }
        let pen = 0;
        for (let i = 0; i < E; i++) if (!noise[i] && ufp[i] === i && ufl[i] < Lmin) pen += (prm.shortPenalty || 4) * (1 - ufl[i] / Lmin) ** 2;
        return pen;
      };
      const other = new Int32Array(NE);
      for (let x = 0; x < NE; x++) other[x] = x ^ 1;
      const decided = new Uint8Array(NE), chosen = [];
      let best = null, bestCost = Infinity, budget = 0, freeTarget = 0;
      const dfs = (k, cost, free, left, lb) => {
        if (--budget < 0 || cost + lb >= bestCost - 1e-12) return;
        while (k < ends.length && decided[ends[k]]) k++;
        if (k === ends.length) {
          if (free !== freeTarget) return;
          const tot = cost + (Lmin > 0 ? lengthPenalty(chosen) : 0);
          if (tot < bestCost) { bestCost = tot; best = chosen.slice(); }
          return;
        }
        const need = freeTarget - free;
        if (need < 0 || need > left || (left - need) % 2) return;
        const x = ends[k];
        const tryFree = () => {
          if (need <= 0) return;
          decided[x] = 1;
          dfs(k + 1, cost + freeCost[x], free + 1, left - 1, lb - minCost[x]);
          decided[x] = 0;
        };
        let freeTried = false;
        for (const o of opts[x]) {
          if (!freeTried && freeCost[x] <= o.cost) { tryFree(); freeTried = true; }
          const y = o.y;
          if (decided[y] || other[x] === y) continue;
          const ox = other[x], oy = other[y];
          decided[x] = decided[y] = 1; other[ox] = oy; other[oy] = ox; chosen.push(o.c);
          dfs(k + 1, cost + o.cost, free, left - 2, lb - minCost[x] - minCost[y]);
          chosen.pop(); other[ox] = x; other[oy] = y; decided[x] = decided[y] = 0;
        }
        if (!freeTried) tryFree();
      };
      const lb0 = ends.reduce((s, x) => s + minCost[x], 0);
      for (let Np = Math.min(prm.n, nEdges); Np <= Math.min(nEdges, prm.n + 8); Np++) {
        freeTarget = 2 * Np; budget = prm.searchBudget || 600000; best = null; bestCost = Infinity;
        dfs(0, 0, 0, ends.length, lb0);
        if (best) { prm.outCost = bestCost; prm.outPaths = Np; return best; }
        if (budget < 0) return null; // too large to search exhaustively: fall back to greedy
      }
      return null;
    };
    const exact = prm.exact === false ? null : exactJoins();
    let mode = 'exact';
    if (exact) for (const c of exact) accept(c, !c.normal);
    else {
      /* Too large to optimise exactly (dense data): accept only clear-cut continuations — good
       * geometry AND clearly better than every alternative for both ends (including stopping
       * there) — and never force joins. The user assembles the rest (Paint / Route). */
      mode = 'local';
      // dense data: real SIM tracks often bend 60–120° where they break, so the automatic bend limit
      // is looser here (75°) than for the exact search on sparse nuclei (60°)
      if (prm.maxBendDense && prm.maxBendDense !== prm.maxBend) { prm.maxBend = prm.maxBendDense; cand = makeCands(); }
      const degN = new Map();
      for (let x = 0; x < 2 * E; x++) degN.set(node(x), (degN.get(node(x)) || 0) + 1);
      // (a) each junction on its own: cheapest arrangement of straight-through pairs and stopped ends
      const byNode = new Map();
      for (const c of cand) if (c.type === 'junction' && c.normal) { if (!byNode.has(c.node)) byNode.set(c.node, []); byNode.get(c.node).push(c); }
      const chosen = [];
      for (const [nd, cs] of byNode) {
        const ends = Array.from(new Set(cs.flatMap((c) => [c.x, c.y])));
        if (ends.length > 9) { // pathological clump: greedy
          const used = new Set();
          for (const c of cs.slice().sort((p, q) => p.cost - q.cost)) if (!used.has(c.x) && !used.has(c.y) && c.cost < 2 * prm.freeJunction) { used.add(c.x); used.add(c.y); chosen.push(c); }
          continue;
        }
        let best = { cost: Infinity, set: [] };
        const rec = (i, used, cost, set) => {
          if (cost >= best.cost) return;
          while (i < ends.length && used.has(ends[i])) i++;
          if (i === ends.length) { best = { cost, set: set.slice() }; return; }
          const x = ends[i];
          used.add(x);
          rec(i + 1, used, cost + prm.freeJunction, set); // x stops here
          for (const c of cs) {
            const y = c.x === x ? c.y : c.y === x ? c.x : -1;
            if (y < 0 || used.has(y)) continue;
            used.add(y); set.push(c);
            rec(i + 1, used, cost + c.cost, set);
            set.pop(); used.delete(y);
          }
          used.delete(x);
        };
        rec(0, new Set(), 0, []);
        chosen.push(...best.set);
        void nd;
      }
      // (b) gaps: only between tips that are each other's best match
      const bestGap = new Map();
      for (const c of cand) {
        if (c.type !== 'bridge' || !c.normal || degN.get(node(c.x)) !== 1 || degN.get(node(c.y)) !== 1) continue;
        for (const x of [c.x, c.y]) if (!bestGap.has(x) || bestGap.get(x).cost > c.cost) bestGap.set(x, c);
      }
      for (const c of new Set(bestGap.values())) if (bestGap.get(c.x) === c && bestGap.get(c.y) === c) chosen.push(c);
      chosen.sort((p, q) => p.cost - q.cost);
      for (const c of chosen) accept(c);
      /* (c) second pass, "faint-ridge links": an end still free after (a) and (b) may be linked to
       * another free end up to 2.5 max gaps away, when at least one of the two is a tip and the
       * score below is high enough. The score grows with closeness, with Z level agreement and with
       * how well each end points at the other, plus a bonus when a faint ridge (≥ 0.25 × the
       * detection threshold) connects them without touching any other track. Weights were fitted on
       * SIM-like test nuclei (logistic regression on true/false continuations); on 22 other nuclei
       * the added links were 90 % correct and cut the pieces to assemble by 17 %. */
      if (prm.ridgeLink) {
        const ext = [];
        for (const c of cand) {
          if (c.type !== 'bridge' || partner[c.x] >= 0 || partner[c.y] >= 0 || find(c.x >> 1) === find(c.y >> 1)) continue;
          const tipX = degN.get(node(c.x)) === 1, tipY = degN.get(node(c.y)) === 1;
          if (!tipX && !tipY) continue; // two arms stopped at junctions: mostly wrong
          let s = 2.15 - 0.87 * c.d / prm.maxGap - 1.8 * (c.tx + c.ty) / (2 * prm.maxBend) + (tipX && tipY ? 0.3 : 0);
          if (zp > 0) s -= 0.9 * Math.abs(arms[c.x].z - arms[c.y].z) / zRef;
          if (s + 1.1 <= LINK_SCORE) continue; // cannot pass even with a ridge link
          if (prm.ridgeLink(edges[c.x >> 1].id, edges[c.y >> 1].id, c.pa, c.pb, c.d)) s += 1.1;
          if (s > LINK_SCORE) ext.push(Object.assign({}, c, { score: s, kind: 'linked' }));
        }
        ext.sort((p, q) => q.score - p.score);
        for (const c of ext) accept(c);
      }
      /* (d) third pass, "bright-gap links": an end still free may be linked to another free end
       * (up to 2.5 max gaps away) when the raw image stays bright across the gap and the two ends
       * sit at the same depth. Fitted on two hand-traced real SIM nuclei (logistic regression on
       * true/false continuations between free ends): the dimmest point along the straight gap,
       * relative to the dimmer end, was by far the best cue (AUC 0.86-0.89; bend angles 0.59-0.70),
       * then the Z difference. Weights fitted on one nucleus and tested on the other: about 93 % of
       * the added links were right, and the pieces to assemble fell by 18-26 %. Greedy, best first. */
      if (prm.gapBright) {
        const ext = [];
        for (const c of cand) {
          if (c.type !== 'bridge' || partner[c.x] >= 0 || partner[c.y] >= 0 || find(c.x >> 1) === find(c.y >> 1)) continue;
          const tips = degN.get(node(c.x)) === 1 && degN.get(node(c.y)) === 1 ? 1 : 0;
          // everything but the brightness first: skip the image lookup when it cannot pass anyway
          const geo = -1.2 - 0.4 * c.d / prm.maxGap - 1.2 * Math.abs(arms[c.x].z - arms[c.y].z) / zRef - 0.8 * (c.tx + c.ty) / (2 * prm.maxBend) + 0.6 * tips;
          if (geo + 3.5 * 2 <= BRIGHT_SCORE) continue;
          const rel = prm.gapBright(c.pa, c.pb), s = geo + 3.5 * rel;
          if (s > BRIGHT_SCORE) ext.push(Object.assign({}, c, { score: s, rel, kind: 'bright' }));
        }
        ext.sort((p, q) => q.score - p.score);
        for (const c of ext) accept(c);
      }
    }

    // build paths from the continuation structure
    const build = () => {
      const seen = new Uint8Array(E), chains = [];
      const walk = (start) => {
        const segs = [], joints = [];
        let cur = start;
        for (;;) {
          const i = cur >> 1, side = cur & 1;
          seen[i] = 1;
          segs.push({ e: edges[i], rev: side === 1 });
          const exit = i * 2 + (1 - side), p = partner[exit];
          if (p < 0 || seen[p >> 1]) break;
          joints.push(joinOf.get(exit));
          cur = p;
        }
        return { segs, joints };
      };
      for (let x = 0; x < 2 * E; x++) if (partner[x] < 0 && !seen[x >> 1]) chains.push(walk(x));
      for (let i = 0; i < E; i++) if (!seen[i]) chains.push(walk(i * 2)); // safety (cannot happen without loops)
      return chains;
    };
    let chains = build();
    // 4) too few paths: undo the weakest continuation that leaves two chromosome-length pieces
    let guard = 0;
    for (;;) {
      const nMajor = chains.filter((c) => chainLength(c) >= prm.minLen).length;
      if (mode !== 'exact' || nMajor >= prm.n || guard++ > 100) break;
      let best = null;
      for (const c of chains) {
        const total = chainLength(c);
        let acc = 0;
        for (let k = 0; k < c.joints.length; k++) {
          acc += c.segs[k].e.length;
          const j = c.joints[k], gap = j.type === 'bridge' ? j.d : 0;
          const left = acc, right = total - acc - gap;
          acc += gap;
          if (left < prm.minLen || right < prm.minLen) continue;
          const s = j.cost + (j.forced ? 10 : 0);
          if (!best || s > best.s) best = { j, s };
        }
      }
      if (!best) break;
      partner[best.j.x] = -1; partner[best.j.y] = -1;
      joinOf.delete(best.j.x); joinOf.delete(best.j.y);
      chains = build();
    }
    chains.sort((p, q) => chainLength(q) - chainLength(p));
    const major2 = chains.filter((c) => chainLength(c) >= prm.minLen).length;
    return { chains, major: major2, mode, gapCands: cand.filter((c) => c.type === 'bridge' && c.normal) };
  }

  function chainLength(c) {
    let s = 0;
    for (const g of c.segs) s += g.e.length;
    for (const j of c.joints) if (j.type === 'bridge') s += j.d;
    return s;
  }

  // ------------------------------------------------ labels & stats
  /** Assign mask voxels to the chromosome of the nearest traced skeleton voxel (26-connected flood). */
  function floodLabels(mask, ctx, edges, edgeChrom) {
    const { W, H, D } = ctx, P = W * H, N = W * H * D;
    const out = new Uint16Array(N), q = new Int32Array(N);
    let qt = 0;
    edges.forEach((e, k) => {
      const c = edgeChrom[k] || 65535;
      for (const v of e.vox) if (!out[v]) { out[v] = c; q[qt++] = v; }
    });
    let qh = 0;
    while (qh < qt) {
      const v = q[qh++], z = (v / P) | 0, r = v - z * P, y = (r / W) | 0, x = r - y * W, L = out[v];
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= D) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          const row = zz * P + yy * W;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const u = row + xx;
            if (!out[u] && mask[u]) { out[u] = L; q[qt++] = u; }
          }
        }
      }
    }
    for (let i = 0; i < N; i++) if (out[i] === 65535) out[i] = 0;
    return out;
  }

  /** Per-chromosome statistics from the (possibly hand-edited) assignment. */
  function summarize(tr) {
    const E = tr.edges, ec = tr.edgeChrom, ec2 = tr.edgeChrom2;
    let K = tr.n || 0;
    for (let i = 0; i < E.length; i++) K = Math.max(K, ec[i], ec2[i]);
    const has = (i, k) => ec[i] === k || ec2[i] === k;
    const rows = [];
    for (let k = 1; k <= K; k++) {
      const es = [];
      for (let i = 0; i < E.length; i++) if (has(i, k)) es.push(i);
      // hand-drawn links count when both of their end nodes touch this chromosome
      const touch = new Set();
      for (const i of es) { touch.add(E[i].a); touch.add(E[i].b); }
      const brs = tr.bridges.filter((b) => b.on !== false && (b.user ? touch.has(b.a) && touch.has(b.b) : has(b.ea, k) && has(b.eb, k)));
      const deg = new Map(), parent = new Map();
      const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
      const addNode = (a) => { if (!parent.has(a)) parent.set(a, a); };
      const join = (a, b) => { addNode(a); addNode(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
      const bump = (a) => deg.set(a, (deg.get(a) || 0) + 1);
      let length = 0, isum = 0, icnt = 0;
      for (const i of es) { const e = E[i]; length += e.length; bump(e.a); bump(e.b); join(e.a, e.b); isum += e.isum || 0; icnt += e.icnt || 0; }
      let gapLen = 0;
      for (const b of brs) { gapLen += b.length; bump(b.a); bump(b.b); join(b.a, b.b); }
      length += gapLen;
      const ends = [], roots = new Set();
      let branch = 0;
      for (const [a, d] of deg) { if (d === 1) ends.push(a); if (d >= 3) branch++; roots.add(find(a)); }
      const pieces = roots.size;
      let status = 'ok';
      if (!es.length) status = 'empty';
      else if (pieces > 1) status = pieces + ' pieces';
      else if (branch) status = 'branched';
      else if (!ends.length) status = 'loop';
      rows.push({ id: k, length, nSeg: es.length, nGap: brs.length, gapLen, ends, nEnds: ends.length, pieces, branch, status, meanI: icnt ? isum / icnt : null });
    }
    const total = rows.reduce((s, r) => s + r.length, 0);
    rows.forEach((r) => { r.rel = total ? r.length / total : 0; });
    let unassigned = 0;
    for (let i = 0; i < E.length; i++) if (!ec[i]) unassigned += E[i].length;
    return { rows, total, unassigned };
  }

  /** Ordered polyline(s) of one chromosome for export. */
  function polylines(tr, k) {
    const out = [];
    tr.edges.forEach((e, i) => { if (tr.edgeChrom[i] === k || tr.edgeChrom2[i] === k) out.push({ edge: i, pts: e.pts }); });
    return out;
  }

  // ------------------------------------------------ worker operations
  const OPS = {
    skeletonize(inp, p, ctx) {
      const skel = skeletonize(inp[0].data, ctx, (f, m) => ctx.report(f * 0.8, m));
      const minBranch = +p.prune || 0;
      if (minBranch > 0) {
        const G = buildGraph(skel, ctx);
        pruneSpurs(G, minBranch);
        skel.fill(0);
        for (const e of G.edges) if (e.alive) for (const v of e.vox) skel[v] = 1;
        for (const nd of G.nodes) if (nd.alive) for (const v of nd.vox) skel[v] = 1;
      }
      let n = 0;
      for (let i = 0; i < skel.length; i++) n += skel[i];
      return { layers: [{ data: skel, kind: 'mask' }], info: n.toLocaleString() + ' skeleton voxels' };
    },

    trace(inp, p, ctx) {
      const num = (v, d) => (v === '' || v == null || !isFinite(+v) ? d : +v);
      let mask = inp[0].data, ridgeMask = null, tube = null;
      const stats = inp[1] ? inp[1].data : inp[0].kind === 'intensity' ? inp[0].data : null;
      let deconv = null, ridgeThr = 0;
      if (inp[0].kind === 'intensity') {
        // axial sharpening: Richardson–Lucy along Z with the axial blur measured from the data, so
        // stacked tracks separate before the ridge filter (on SIM-like test nuclei: fewer junctions,
        // more of each chromosome traced, fewer pieces to assemble)
        let ridgeSrc = inp[0].data;
        if (p.deconvZ !== false && p.deconvZ !== 'false' && ctx.D > 4) {
          ctx.report(0.005, 'Measuring axial blur');
          let sg = num(p.deconvSigma, NaN), how = 'set by hand';
          if (!(sg > 0)) { const zw = zProfileWidth(ridgeSrc, ctx); sg = isFinite(zw.fwhm) ? 0.9 * zw.fwhm / 2.3548 : NaN; how = 'measured'; }
          if (sg > 0.6 * ctx.sz) {
            const iters = Math.max(1, Math.round(num(p.deconvIter, 20)));
            ridgeSrc = rlZ(ridgeSrc, ctx, sg, iters, (f) => ctx.report(0.01 + 0.09 * f, 'Sharpening along Z'));
            deconv = { sigma: sg, iters, how };
          } else deconv = { skipped: isFinite(sg) ? 'axial blur below one Z step' : 'could not measure the axial blur' };
        }
        // ridge mask: Z-corrected tubeness at a small scale, thresholded relative to Otsu
        ctx.report(0.1, 'Enhancing ridges');
        const sigma = num(p.ridgeSigma, 1.5 * Math.min(ctx.sx, ctx.sy));
        tube = Proc.OPS.hessian([{ data: ridgeSrc }], { kind: 'tube', sigmas: String(sigma), zAniso: num(p.zAniso, 1), polarity: 'bright' }, ctx).layers[0].data;
        const thr = Proc.thresholdValue(tube, 'otsu') * num(p.ridgeFactor, 1.1);
        ridgeThr = thr;
        ridgeMask = new Uint8Array(ctx.N);
        for (let i = 0; i < ctx.N; i++) ridgeMask[i] = tube[i] >= thr ? 1 : 0;
        mask = ridgeMask;
      }
      // layered tracks: keep only a thin band around each intensity peak along Z in every column,
      // so tracks stacked a few hundred nm apart (merged by the axial blur) become separate layers
      if ((p.zThin === true || p.zThin === 'true') && ctx.D > 2) {
        ctx.report(0.12, 'Thinning in Z');
        const I = inp[0].kind === 'intensity' ? inp[0].data : inp[1] ? inp[1].data : null;
        const ref = I ? Proc.gaussian(I, ctx, num(p.ridgeSigma, 1.5 * Math.min(ctx.sx, ctx.sy)), 0, 0.12, 0.14, 'Thinning in Z')
          : Proc.edt(mask, ctx, (v) => !(v > 0));
        mask = zThin(mask, ref, ctx, Math.max(1, Math.round(num(p.zBand, 0.12) / ctx.sz)), Math.max(1, Math.round(num(p.zPeakSep, 0.1) / ctx.sz)));
        if (ridgeMask) ridgeMask = mask;
      }
      const floodMask = mask;
      if (num(p.close, 0) > 0) mask = Proc.OPS.morph([{ data: mask }], { op: 'close', radius: +p.close }, ctx).layers[0].data;
      ctx.report(0.15, 'Skeletonising');
      const skel = skeletonize(mask, ctx, (f, m) => ctx.report(0.15 + 0.47 * f, m));
      // track width from the distance map sampled on the skeleton
      const dist = Proc.edt(mask, ctx, (v) => !(v > 0), 0.62, 0.75);
      const samp = [];
      for (let i = 0; i < skel.length; i++) if (skel[i] && isFinite(dist[i])) samp.push(dist[i]);
      samp.sort((a, b) => a - b);
      const minVox = Math.min(ctx.sx, ctx.sy);
      const w = Math.max(2 * minVox, 2 * (samp.length ? samp[samp.length >> 1] : minVox));
      const prm = {
        n: Math.max(1, Math.round(num(p.n, 4))),
        Ldir: num(p.dirLen, 2) * w, // short arms: SC tracks curve within a micron (dense-demo tuning)
        skip: num(p.dirSkip, 0.5) * w,
        freeJunction: num(p.freeJunction, 0.6),
        minChromFrac: num(p.minChromFrac, 0.35),
        shortPenalty: num(p.shortPenalty, 4),
        searchBudget: num(p.searchBudget, 600000),
        exact: p.exact !== false && p.exact !== 'false',
        minBranch: num(p.minBranch, 2.5 * w),
        mergeDist: 2 * w,
        maxGap: num(p.maxGap, Math.max(num(p.gapW, 4) * w, 6 * minVox)),
        // blank = automatic: 60° for the exact search (sparse nuclei), 75° for dense nuclei
        maxBend: num(p.maxBend, 60) * Math.PI / 180,
        maxBendDense: num(p.maxBend, 75) * Math.PI / 180,
        minLen: num(p.minLen, 10 * w),
        zPenalty: num(p.zPenalty, 1.5),
        zRef: num(p.zRef, Math.max(0.2, 3 * ctx.sz)),
        width: w,
      };
      ctx.report(0.78, 'Building skeleton graph');
      const G = buildGraph(skel, ctx);
      pruneSpurs(G, prm.minBranch);
      // sub-voxel Z from the ridge response (or intensity, or the distance map for a mask input)
      refineZ(G, ctx, tube || stats || dist, num(p.zSmooth, 0.3));
      contractShort(G, prm.mergeDist);
      removeBubbles(G, 4 * prm.mergeDist);
      pruneSpurs(G, prm.minBranch, prm.zPenalty > 0 ? 6 * w : 0);
      mergeAllDeg2(G);
      ctx.report(0.85, 'Resolving crossings');
      // faint-ridge test for the second joining pass (dense data, image input only)
      if (tube && ridgeThr > 0 && p.linkGaps !== false && p.linkGaps !== 'false') prm.ridgeLink = makeRidgeLink(G, tube, ridgeThr, ctx);
      // bright-gap test for the third joining pass (dense data, image input only)
      if (stats && inp[0].kind === 'intensity' && p.brightGaps !== false && p.brightGaps !== 'false') prm.gapBright = makeGapBrightness(stats, ctx);
      const R = resolve(G, prm);
      // compact output
      const alive = G.edges.filter((e) => e.alive);
      const newId = new Map(alive.map((e, i) => [e.id, i]));
      const edgeChrom = new Int32Array(alive.length), edgeChain = new Int32Array(alive.length);
      const bridges = [];
      // exact mode: every chromosome-length path is a chromosome. Confident mode (dense data): the
      // N longest confident tracks are numbered as a starting point, the rest stay unassigned.
      R.chains.forEach((c, ci) => {
        const id = R.mode === 'exact' ? (chainLength(c) >= prm.minLen ? ci + 1 : 0) : (ci < prm.n && chainLength(c) >= prm.minLen ? ci + 1 : 0);
        for (const s of c.segs) { edgeChrom[newId.get(s.e.id)] = id; edgeChain[newId.get(s.e.id)] = ci + 1; }
        for (const j of c.joints) if (j.type === 'bridge') bridges.push({ a: j.a, b: j.b, pa: j.pa, pb: j.pb, length: j.d, ea: j.x >> 1, eb: j.y >> 1, on: true, forced: j.forced, linked: j.kind === 'linked', bright: j.kind === 'bright' });
      });
      const gapCands = R.gapCands.map((c) => ({ a: c.a, b: c.b, pa: c.pa, pb: c.pb, d: c.d, cost: c.cost, x: c.x, y: c.y }));
      const I = stats;
      const edges = alive.map((e) => {
        let isum = 0;
        if (I) for (const v of e.vox) isum += I[v];
        return { a: e.a, b: e.b, length: e.length, pts: e.pts, vox: Int32Array.from(e.vox), isum, icnt: I ? e.vox.length : 0 };
      });
      const usedNodes = new Set();
      edges.forEach((e) => { usedNodes.add(e.a); usedNodes.add(e.b); });
      const nodes = {};
      for (const id of usedNodes) nodes[id] = G.nodes[id].pos;
      ctx.report(0.93, 'Labelling chromosomes');
      const labels = floodLabels(floodMask, ctx, edges, edgeChrom);
      const layers = [{ data: labels, kind: 'labels', name: 'Chromosomes' }];
      if (ridgeMask) layers.push({ data: ridgeMask, kind: 'mask', name: 'Ridge mask' });
      if (p.skeletonLayer === true || p.skeletonLayer === 'true') {
        const sk = new Uint8Array(ctx.N);
        for (const e of edges) for (const v of e.vox) sk[v] = 1;
        layers.push({ data: sk, kind: 'mask', name: 'Skeleton' });
      }
      const nChrom = R.chains.filter((c) => chainLength(c) >= prm.minLen).length;
      // sanity: a "track" mask that is thick or fills its bounding box is probably a whole region
      const warnings = [];
      if (w > 0.6) warnings.push(`The mask is thick (median track width ${w.toFixed(2)} µm) — it probably includes more than the tracks. Raise the threshold.`);
      let mv = 0, x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1, z0 = Infinity, z1 = -1;
      for (let i = 0; i < ctx.N; i++) if (mask[i]) { mv++; const z = (i / (ctx.W * ctx.H)) | 0, r = i - z * ctx.W * ctx.H, y = (r / ctx.W) | 0, x = r - y * ctx.W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      const fill = mv / Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1));
      if (fill > 0.3) warnings.push(`The mask fills ${(fill * 100).toFixed(0)} % of its bounding box — tracks should be thin lines. Check the threshold (for SIM data use Otsu, not Triangle or Mean).`);
      return {
        layers,
        trace: { edges, nodes, bridges, edgeChrom, edgeChain, gapCands, n: prm.n, mode: R.mode, nChains: R.chains.length, warnings, params: Object.assign({}, prm, { allow: undefined, ridgeLink: undefined, gapBright: undefined }), deconv, hasRidgeMask: !!ridgeMask, version: VERSION },
        info: (R.mode === 'exact'
          ? nChrom + ' chromosome' + (nChrom === 1 ? '' : 's') + ' traced (target ' + prm.n + ')'
          : `Dense data: ${R.chains.length} track pieces found; the ${Math.min(prm.n, nChrom)} longest are numbered — assemble the rest in Edit mode`)
          + (deconv && deconv.sigma ? ` · sharpened along Z (axial σ ${deconv.sigma.toFixed(2)} µm)` : ''),
      };
    },
  };

  /**
   * Smoothest route through the skeleton graph from edge `from` to edge `to` (Dijkstra over
   * directed edge states). Cost = length + bend penalty at each junction (+ gap jumps), so the
   * route follows the straightest continuation through crossings. Returns { edges, gaps } or null.
   */
  function route(tr, from, to, o = {}) {
    const E = tr.edges.length;
    if (from === to) return { edges: [from], gaps: [] };
    const w = (tr.params && tr.params.width) || 0.15;
    const Ld = o.Ldir || 3 * w, skip = o.skip == null ? w : o.skip;
    const maxBend = o.maxBend || (110 * Math.PI / 180), ref = Math.PI / 3, lam = o.bendCost == null ? 1.5 : o.bendCost;
    const zp = o.zPenalty != null ? o.zPenalty : (tr.params && tr.params.zPenalty) || 0;
    const zRef = (tr.params && tr.params.zRef) || 0.3;
    const arms = new Array(2 * E);
    for (let x = 0; x < 2 * E; x++) arms[x] = armInfo(tr.edges[x >> 1], x & 1, skip, Ld);
    const bend = (th) => (th / ref) ** 2;
    const nodeOf = (x) => ((x & 1) ? tr.edges[x >> 1].b : tr.edges[x >> 1].a);
    const at = new Map();
    for (let x = 0; x < 2 * E; x++) { const n = nodeOf(x); if (!at.has(n)) at.set(n, []); at.get(n).push(x); }
    const gaps = new Map();
    (tr.gapCands || []).forEach((g, gi) => {
      if (!gaps.has(g.x)) gaps.set(g.x, []);
      if (!gaps.has(g.y)) gaps.set(g.y, []);
      gaps.get(g.x).push({ y: g.y, d: g.d, gi }); gaps.get(g.y).push({ y: g.x, d: g.d, gi });
    });
    const dist = new Float64Array(2 * E).fill(Infinity), prev = new Int32Array(2 * E).fill(-1), via = new Int32Array(2 * E).fill(-1);
    const heap = [];
    const push = (x, d) => { heap.push([d, x]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    for (const s of [from * 2, from * 2 + 1]) { dist[s] = 0; push(s, 0); }
    let goal = -1;
    while (heap.length) {
      const [d, x] = pop();
      if (d > dist[x]) continue;
      if ((x >> 1) === to) { goal = x; break; }
      const exit = x ^ 1;
      const relax = (y, c, g) => { if (c < dist[y]) { dist[y] = c; prev[y] = x; via[y] = g; push(y, c); } };
      for (const y of at.get(nodeOf(exit)) || []) {
        if ((y >> 1) === (x >> 1)) continue;
        const { th, cost } = joinCost(arms[exit], arms[y], zp, zRef, bend);
        if (th > maxBend) continue;
        relax(y, d + tr.edges[y >> 1].length + lam * cost, -1);
      }
      for (const g of gaps.get(exit) || []) {
        const gc = tr.gapCands[g.gi];
        const zc = zp > 0 ? zp * ((gc.pb[2] - gc.pa[2]) / zRef) ** 2 : 0;
        relax(g.y, d + tr.edges[g.y >> 1].length + 2 * g.d + lam * (0.5 + zc), g.gi);
      }
    }
    if (goal < 0) return null;
    const edges = [], gs = [];
    for (let x = goal; x >= 0; x = prev[x]) { edges.push(x >> 1); if (via[x] >= 0) gs.push(via[x]); if (dist[x] === 0) break; }
    return { edges: edges.reverse(), gaps: gs };
  }

  /** Nearest edge or bridge to a screen point. proj(pt) -> [x, y] or null; okE(i) / okB(i) (optional) skip hidden ones. */
  function hitTest(tr, proj, sx, sy, maxPx, okE, okB) {
    let best = null, segT = 0;
    const segDist = (a, b) => {
      const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
      let t = l2 ? ((sx - a[0]) * vx + (sy - a[1]) * vy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      segT = t;
      return Math.hypot(a[0] + t * vx - sx, a[1] + t * vy - sy);
    };
    // for edges, also report where along the polyline the hit is: between pts[j-1] and pts[j], fraction f
    tr.edges.forEach((e, i) => {
      if (okE && !okE(i)) return;
      let prev = null;
      e.pts.forEach((p, j) => {
        const s = proj(p);
        if (s && prev) { const d = segDist(prev, s); if (d <= maxPx && (!best || d < best.d)) best = { type: 'edge', id: i, d, j, f: segT }; }
        prev = s;
      });
    });
    tr.bridges.forEach((b, i) => {
      if (okB && !okB(i)) return;
      const s = proj(b.pa), t = proj(b.pb);
      if (s && t) { const d = segDist(s, t); if (d <= maxPx && (!best || d < best.d - 1)) best = { type: 'bridge', id: i, d }; }
    });
    return best;
  }

  return { VERSION, zProfileWidth, rlZ, skeletonize, buildGraph, pruneSpurs, contractShort, removeBubbles, mergeAllDeg2, resolve, floodLabels, summarize, polylines, hitTest, route, endDir, isSimple, OPS };
}
