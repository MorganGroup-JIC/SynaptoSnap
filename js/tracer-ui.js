/* SynaptoSnap — chromosome tracing: results panel, overlays and manual correction. */
(function () {
  const css = (rgb) => `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;
  const chromColor = (k) => (k ? css(Colormaps.labelColor(k)) : '#9aa0a6');
  // unassigned confident tracks: muted, but distinguishable from each other
  const chainColor = (c) => { const k = Colormaps.labelColor(c + 997); return css(k.map((v) => 0.45 + 0.35 * v)); };
  // line widths (px): pieces assigned to a chromosome are drawn thicker than unassigned ones
  const W_CHROM = 3, W_MUTED = 1.3;
  // Hiding is view state only (not undone, not exported): t.hidden holds chromosome numbers, 0 = unassigned pieces.
  const isShown = (t, k) => !t.hidden || !t.hidden.has(k || 0);
  // the region a reference trace was made for: the clipping box (App.roiPart / trace.roi) or the whole image
  const roiKeyOf = (r) => (r ? [r.x0, r.y0, r.z0, r.w, r.h, r.d].join(',') : 'all');
  const edgeShown = (t, i) => isShown(t, t.edgeChrom[i]) || (t.edgeChrom2[i] > 0 && isShown(t, t.edgeChrom2[i]));
  /** Chromosomes present at each node, for colouring hand links (null when there are none). */
  function chromsAtNodes(t) {
    if (!t.bridges.some((b) => b.user)) return null;
    const at = new Map();
    const add = (n, c) => { if (!c) return; if (!at.has(n)) at.set(n, new Set()); at.get(n).add(c); };
    t.edges.forEach((e, i) => { for (const c of [t.edgeChrom[i], t.edgeChrom2[i]]) { add(e.a, c); add(e.b, c); } });
    return at;
  }
  /** Chromosomes on the two sides of a bridge; a hand link takes a chromosome present at both of its ends. */
  function bridgeChroms(t, b, atNode) {
    if (b.user && atNode) { const A = atNode.get(b.a), B = atNode.get(b.b); const c = (A && B && [...A].find((x) => B.has(x))) || 0; return [c, c]; }
    return [t.edgeChrom[b.ea] || 0, t.edgeChrom[b.eb] || 0];
  }
  const bridgeShown = (t, ka, kb) => (ka && ka === kb ? isShown(t, ka) : isShown(t, ka) && isShown(t, kb));
  /**
   * Segments of chromosome k in order along it, as pieces (connected parts, longest first), each a list of
   * edge ids walked from an end through its segments and gap bridges. k = 0: unassigned segments, longest first.
   */
  function segmentOrder(t, k) {
    const E = t.edges;
    if (!k) return [E.map((_, i) => i).filter((i) => !t.edgeChrom[i] && !t.edgeChrom2[i]).sort((a, b) => E[b].length - E[a].length)];
    const has = (i) => i >= 0 && (t.edgeChrom[i] === k || t.edgeChrom2[i] === k);
    const es = E.map((_, i) => i).filter(has);
    const touch = new Set();
    for (const i of es) { touch.add(E[i].a); touch.add(E[i].b); }
    const adj = new Map();
    const link = (a, b, e) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, e }); };
    for (const i of es) { link(E[i].a, E[i].b, i); link(E[i].b, E[i].a, i); }
    for (const b of t.bridges) if (b.on !== false && (b.user ? touch.has(b.a) && touch.has(b.b) : has(b.ea) && has(b.eb))) { link(b.a, b.b, -1); link(b.b, b.a, -1); }
    const used = new Set(), seen = new Set(), pieces = [];
    const deg = (n) => adj.get(n).length;
    const starts = [...adj.keys()].sort((a, b) => (deg(a) === 1 ? 0 : 1) - (deg(b) === 1 ? 0 : 1)); // ends first
    for (const s of starts) {
      if (seen.has(s)) continue;
      const piece = [], stack = [s];
      seen.add(s);
      while (stack.length) { // depth-first along unused segments (bridges only to new nodes)
        const n = stack[stack.length - 1];
        const nx = adj.get(n).find((x) => (x.e >= 0 ? !used.has(x.e) : !seen.has(x.to)));
        if (!nx) { stack.pop(); continue; }
        if (nx.e >= 0) { used.add(nx.e); piece.push(nx.e); }
        seen.add(nx.to);
        stack.push(nx.to);
      }
      if (piece.length) pieces.push(piece);
    }
    const len = (p) => p.reduce((s, i) => s + E[i].length, 0);
    return pieces.sort((p, q) => len(q) - len(p));
  }
  /** The chromosome a segment counts for when picking whole traces (its first one; 0 = unassigned). */
  const kOf = (t, i) => t.edgeChrom[i] || t.edgeChrom2[i] || 0;
  /**
   * The trace a segment belongs to. For a chromosome: its connected piece (segments and the gap links
   * between them). For an unassigned segment: the unbranched run of unassigned segments through it (it stops
   * at junctions). Hidden segments are left out. Returns { k, edges: Set, bridges: Set, nodes: Set, ends }
   * with ends = its free ends (or, for an unassigned run, where it stops).
   */
  function traceOf(t, e0) {
    const k = kOf(t, e0), E = t.edges;
    const mine = (i) => i >= 0 && i < E.length && edgeShown(t, i) && (k ? t.edgeChrom[i] === k || t.edgeChrom2[i] === k : !t.edgeChrom[i] && !t.edgeChrom2[i]);
    const adj = new Map(), touch = new Set();
    const add = (a, b, e) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, e }); };
    E.forEach((ed, i) => { if (mine(i)) { add(ed.a, ed.b, i); add(ed.b, ed.a, i); touch.add(ed.a); touch.add(ed.b); } });
    t.bridges.forEach((b, bi) => { if (b.on !== false && (b.user ? touch.has(b.a) && touch.has(b.b) : mine(b.ea) && mine(b.eb))) { add(b.a, b.b, -1 - bi); add(b.b, b.a, -1 - bi); } });
    const deg = (n) => (adj.get(n) || []).length;
    const edges = new Set([e0]), bridges = new Set(), nodes = new Set([E[e0].a, E[e0].b]), stack = [E[e0].a, E[e0].b];
    while (stack.length) {
      const n = stack.pop();
      if (!k && deg(n) !== 2) continue; // an unassigned run stops at its ends and at junctions
      for (const x of adj.get(n) || []) {
        if (x.e >= 0) { if (edges.has(x.e)) continue; edges.add(x.e); } else { if (bridges.has(-1 - x.e)) continue; bridges.add(-1 - x.e); }
        if (!nodes.has(x.to)) { nodes.add(x.to); stack.push(x.to); }
      }
    }
    let ends = [...nodes].filter((n) => (k ? deg(n) === 1 : deg(n) !== 2));
    if (!ends.length) ends = [...nodes].filter((n) => deg(n) !== 2);
    if (!ends.length) ends = [E[e0].a, E[e0].b];
    return { k, edges, bridges, nodes, ends };
  }
  const MODES = [['trace', 'Trace', 'Click points along a chromosome: the stretch between clicks follows the image (as in Fiji SNT), also over existing traces. Click near a trace\'s end (or Shift+click it anywhere) and then a point to extend it; then another trace\'s end to join them. Esc, Enter, a right-click or a click on the last point finishes.'],
    ['erase', 'Erase', 'Drag over traces to erase the part under the brush; a trace erased in the middle becomes two. Click a trace to erase all of it. Ctrl+Z restores.'],
    ['paint', 'Paint', 'Click a track to give the whole confident track to the active chromosome (Alt+click = one segment only)'],
    ['select', 'Select', 'Click a segment or gap, then press a number to reassign it']];
  // earlier tools, still available under "More tools"
  const MORE_MODES = [['route', 'Route', 'Click along a chromosome: the smoothest path through the existing pieces between consecutive clicks is assigned to the active chromosome. Where no path exists, the two pieces are linked directly.'],
    ['link', 'Link', 'Join any two pieces by hand with a straight link: click near the end of one, then near the end of the other (click mid-segment to join there). No distance or angle limits.'],
    ['guide', 'Guide', 'Drag along the true course of a chromosome in an XY view: it is re-traced from the image inside the band you paint, replaces the active chromosome\'s segments in that band, and joins the pieces at both ends. With Unassign (0) it unassigns everything in the band. Shift+drag (or middle/right drag) pans.']];
  const MODE_NAME = Object.fromEntries([...MODES, ...MORE_MODES].map(([m, l]) => [m, l]));

  // ------------------------------------------------------------------ hand-edit geometry
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const polyLen = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += d3(p[i], p[i - 1]); return s; };
  const grow = (arr, n) => { const o = new Int32Array(n); if (arr) for (let i = 0; i < Math.min(n, arr.length); i++) o[i] = arr[i]; return o; };
  function newNode(t, p) {
    if (t.nextNode == null) t.nextNode = Object.keys(t.nodes).reduce((m, k) => Math.max(m, +k), -1) + 1;
    const id = t.nextNode++;
    t.nodes[id] = p.slice();
    return id;
  }
  const armOf = (t, e, n) => 2 * e + (t.edges[e].b === n ? 1 : 0);
  /** Arclength position of a hit along its edge. */
  function hitArc(t, hit) {
    const P = t.edges[hit.id].pts, j = Math.max(1, Math.min(P.length - 1, hit.j || 1));
    let s = 0;
    for (let i = 1; i < j; i++) s += d3(P[i], P[i - 1]);
    return s + (hit.f || 0) * d3(P[j], P[j - 1]);
  }
  /** Which end of the clicked edge a link should start from: { node } for an end, { j } to split there. */
  function pickEnd(t, hit) {
    const e = t.edges[hit.id], L = e.length || polyLen(e.pts), s = hitArc(t, hit);
    if (L < 1 || e.pts.length < 5) return { node: s <= L / 2 ? e.a : e.b };
    if (s <= 0.35) return { node: e.a };
    if (L - s <= 0.35) return { node: e.b };
    return { j: Math.max(2, Math.min(e.pts.length - 3, (hit.j || 1) - ((hit.f || 0) < 0.5 ? 1 : 0))) };
  }
  /**
   * Split edge i at polyline index j into i (start…j) and a new edge (j…end). Returns the node at the
   * cut (an existing end node if j is at an end) and the new edge's index.
   */
  function splitEdge(app, t, i, j) {
    const e = t.edges[i], P = e.pts;
    if (j <= 0) return { node: e.a, e2: -1 };
    if (j >= P.length - 1) return { node: e.b, e2: -1 };
    const nn = newNode(t, P[j]), E = t.edges.length;
    const p1 = P.slice(0, j + 1), p2 = P.slice(j);
    let v1 = null, v2 = null;
    if (e.vox && e.vox.length) {
      const [W, H] = app.dims, [sx, sy, sz] = app.spacing, WH = W * H, a1 = [], a2 = [];
      for (const v of e.vox) {
        const z = (v / WH) | 0, r = v - z * WH, y = (r / W) | 0, x = r - y * W, q = [x * sx, y * sy, z * sz];
        let bi = 0, bd = Infinity;
        for (let k = 0; k < P.length; k++) { const d = d3(q, P[k]); if (d < bd) { bd = d; bi = k; } }
        (bi <= j ? a1 : a2).push(v);
      }
      v1 = Int32Array.from(a1); v2 = Int32Array.from(a2);
    }
    const f1 = v1 ? v1.length / Math.max(1, e.vox.length) : polyLen(p1) / Math.max(1e-9, polyLen(P));
    const e1 = { a: e.a, b: nn, pts: p1, length: polyLen(p1), vox: v1, isum: (e.isum || 0) * f1, icnt: Math.round((e.icnt || 0) * f1) };
    const e2 = { a: nn, b: e.b, pts: p2, length: polyLen(p2), vox: v2, isum: (e.isum || 0) * (1 - f1), icnt: (e.icnt || 0) - e1.icnt };
    t.edges[i] = e1; t.edges.push(e2);
    t.edgeChrom = grow(t.edgeChrom, E + 1); t.edgeChrom[E] = t.edgeChrom[i];
    t.edgeChrom2 = grow(t.edgeChrom2, E + 1); t.edgeChrom2[E] = t.edgeChrom2[i];
    if (t.edgeChain) { t.edgeChain = grow(t.edgeChain, E + 1); t.edgeChain[E] = t.edgeChain[i]; }
    // whatever was attached at the old far end now belongs to the new edge
    t.bridges = t.bridges.map((b) => {
      let o = b;
      if (b.ea === i && b.a === e.b) o = Object.assign({}, o, { ea: E });
      if (b.eb === i && b.b === e.b) o = Object.assign({}, o, { eb: E });
      return o;
    });
    t.gapCands = (t.gapCands || []).map((g) => (g.x === 2 * i + 1 || g.y === 2 * i + 1
      ? Object.assign({}, g, { x: g.x === 2 * i + 1 ? 2 * E + 1 : g.x, y: g.y === 2 * i + 1 ? 2 * E + 1 : g.y }) : g));
    return { node: nn, e2: E };
  }
  /** Add (or switch on) a hand-drawn link between two nodes; also usable by Route afterwards. */
  function addUserLink(t, na, nb) {
    const have = t.bridges.find((b) => (b.a === na && b.b === nb) || (b.a === nb && b.b === na));
    if (have) { have.on = true; return have; }
    const incident = (n) => t.edges.map((_, i) => i).filter((i) => t.edges[i].a === n || t.edges[i].b === n);
    const ia = incident(na), ib = incident(nb), k = t.active;
    const pick = (list) => list.find((i) => k && (t.edgeChrom[i] === k || t.edgeChrom2[i] === k)) ?? list[0];
    const pa = t.nodes[na], pb = t.nodes[nb], d = d3(pa, pb);
    const br = { a: na, b: nb, pa, pb, length: d, ea: pick(ia), eb: pick(ib), on: true, manual: true, user: true };
    t.bridges.push(br);
    t.gapCands = t.gapCands || [];
    for (const x of ia) for (const y of ib) t.gapCands.push({ a: na, b: nb, pa, pb, d, cost: 0, x: armOf(t, x, na), y: armOf(t, y, nb), user: true });
    return br;
  }
  /**
   * Delete segments (edge indices) and links (bridge indices) from the trace altogether. Indices are
   * compacted everywhere they are used; links left without a segment at either end go too.
   * Nodes are kept (unused ones are harmless). Undo restores from a snapshot.
   */
  function deleteItems(t, dropE, dropB = new Set()) {
    const E = t.edges.length, map = new Int32Array(E).fill(-1);
    let n = 0;
    for (let i = 0; i < E; i++) if (!dropE.has(i)) map[i] = n++;
    const keep = (arr) => { if (!arr) return arr; const o = new Int32Array(n); for (let i = 0; i < E; i++) if (map[i] >= 0) o[map[i]] = arr[i]; return o; };
    const edges = t.edges.filter((_, i) => map[i] >= 0);
    const incident = new Map();
    edges.forEach((e, i) => { for (const nd of [e.a, e.b]) { if (!incident.has(nd)) incident.set(nd, []); incident.get(nd).push(i); } });
    const mapped = (i) => (i != null && i >= 0 && i < E ? map[i] : -1);
    const bridges = [];
    t.bridges.forEach((b, bi) => {
      if (dropB.has(bi)) return;
      let ea = mapped(b.ea), eb = mapped(b.eb);
      if (b.user) { // hand links join nodes: keep them while both nodes still have a segment
        const ia = incident.get(b.a), ib = incident.get(b.b);
        if (!ia || !ib) return;
        if (!ia.includes(ea)) ea = ia[0];
        if (!ib.includes(eb)) eb = ib[0];
      } else if (ea < 0 || eb < 0) return;
      bridges.push(ea === b.ea && eb === b.eb ? b : Object.assign({}, b, { ea, eb }));
    });
    const arm = (x) => { const m = mapped(x >> 1); return m >= 0 ? 2 * m + (x & 1) : -1; };
    const gaps = [];
    for (const g of t.gapCands || []) { const x = arm(g.x), y = arm(g.y); if (x >= 0 && y >= 0) gaps.push(x === g.x && y === g.y ? g : Object.assign({}, g, { x, y })); }
    t.edges = edges; t.edgeChrom = keep(t.edgeChrom); t.edgeChrom2 = keep(t.edgeChrom2);
    if (t.edgeChain) t.edgeChain = keep(t.edgeChain);
    t.bridges = bridges; t.gapCands = gaps;
    t.sel = null; t.anchor = null; t.linkFrom = null; t.tip = null;
  }
  let tipSid = 0; // numbers each trace drawn with the Trace tool, so undo never resumes a finished one
  /** Colours of suggestions 1, 2, 3 (dashed lines with numbered ends). */
  const SUGGEST_COLORS = ['#ffd84d', '#4dd2ff', '#ff7ad9'];
  /** A numbered marker (suggestion end) on a 2D canvas. */
  window.drawNumberBadge = function (ctx, x, y, color, label, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha; ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, 6.2832); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.font = '700 11px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.5);
    ctx.restore();
  };
  const DEL = -1; // the "Delete" tool in place of a chromosome number
  const toolColor = (k) => (k === DEL ? '#e5645a' : k ? chromColor(k) : '#9aa0a6');
  /** Add a hand-traced segment between nodes na and nb along path G; returns its index. */
  function addEdge(t, na, nb, G, k, chain) {
    const pts = G.pts.length >= 2 ? G.pts.map((p) => p.slice()) : [t.nodes[na].slice(), t.nodes[nb].slice()];
    pts[0] = t.nodes[na].slice(); pts[pts.length - 1] = t.nodes[nb].slice();
    const E = t.edges.length;
    t.edges.push({ a: na, b: nb, pts, length: polyLen(pts), vox: G.vox || null, isum: G.isum || 0, icnt: G.icnt || 0, guided: true });
    t.edgeChrom = grow(t.edgeChrom, E + 1); t.edgeChrom[E] = Math.max(0, k);
    t.edgeChrom2 = grow(t.edgeChrom2, E + 1);
    if (t.edgeChain) { t.edgeChain = grow(t.edgeChain, E + 1); t.edgeChain[E] = chain != null ? chain : t.edgeChain.reduce((m, v) => Math.max(m, v), 0) + 1; }
    return E;
  }
  /** Give the segments of a piece that count for chromosome kOld (0: the unassigned ones) chromosome kNew. */
  function recolour(t, edges, kOld, kNew, chain) {
    for (const i of edges) {
      if (t.edgeChrom[i] === kOld) t.edgeChrom[i] = kNew;
      else if (kOld && t.edgeChrom2[i] === kOld) t.edgeChrom2[i] = kNew;
      if (t.edgeChrom2[i] === t.edgeChrom[i]) t.edgeChrom2[i] = 0;
      if (chain != null && t.edgeChain) t.edgeChain[i] = chain;
    }
  }

  /**
   * How line-like a channel is, 0–1: synaptonemal complexes (ZYP1) are long thin lines; foci are spots and
   * DAPI is broad. On the max projection, smoothed at σ ≈ 0.07 µm, the brightest 10% of pixels are scored by
   * (|λ1| − |λ2|) / (|λ1| + |λ2|) of the Hessian (λ1 the curvature across a bright line) and averaged.
   * On the 1804 / 1805 nuclei: ZYP1 (T2) 0.55 / 0.53, the other channels 0.35–0.41.
   */
  function lineScore(L, dims, spacing) {
    const [W, H, D] = dims, P = W * H, I = L.data;
    const M = new Float32Array(P);
    for (let z = 0; z < D; z++) { const o = z * P; for (let i = 0; i < P; i++) { const v = I[o + i]; if (v > M[i]) M[i] = v; } }
    const smp = [];
    for (let i = 0; i < P; i += 7) smp.push(M[i]);
    smp.sort((a, b) => a - b);
    const med = smp[smp.length >> 1], hi = smp[Math.floor(0.995 * (smp.length - 1))];
    const sc = hi - med || 1;
    for (let i = 0; i < P; i++) M[i] = Math.max(0, (M[i] - med) / sc);
    const sg = Math.max(1, 0.07 / spacing[0]), r = Math.ceil(3 * sg), k = [];
    let ks = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sg * sg)); k.push(v); ks += v; }
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    const T = new Float32Array(P), S = new Float32Array(P);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0; for (let j = -r; j <= r; j++) a += M[y * W + Math.min(W - 1, Math.max(0, x + j))] * k[j + r]; T[y * W + x] = a; }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0; for (let j = -r; j <= r; j++) a += T[Math.min(H - 1, Math.max(0, y + j)) * W + x] * k[j + r]; S[y * W + x] = a; }
    const ss = [];
    for (let i = 0; i < P; i += 5) ss.push(S[i]);
    ss.sort((a, b) => a - b);
    const thr = ss[Math.floor(0.9 * (ss.length - 1))];
    let sum = 0, n = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, c = S[i];
      if (c < thr) continue;
      const xx = S[i - 1] - 2 * c + S[i + 1], yy = S[i - W] - 2 * c + S[i + W], xy = (S[i - W - 1] + S[i + W + 1] - S[i - W + 1] - S[i + W - 1]) / 4;
      const tr = xx + yy, dt = Math.sqrt((xx - yy) ** 2 + 4 * xy * xy), l1 = (tr - dt) / 2, l2 = (tr + dt) / 2;
      if (l1 >= 0) continue;
      sum += Math.max(0, (-l1 - Math.abs(l2)) / (-l1 + Math.abs(l2) + 1e-12)); n++;
    }
    return n ? sum / n : 0;
  }

  // ------------------------------------------------------------------ suggestions: ways to continue a trace
  const angXY = (a, b) => { const la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]); return la > 1e-9 && lb > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)))) : 0; };
  /** Polyline p cut at arclength L. */
  function cutAt(p, L) {
    let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const l = d3(p[i], p[i - 1]);
      if (acc + l >= L) return p.slice(0, i).concat([TracePath.along([p[i - 1], p[i]], L - acc)]);
      acc += l;
    }
    return p;
  }
  /** Points every `step` µm along polyline p. */
  function resample(p, step) {
    const L = polyLen(p), n = Math.max(1, Math.round(L / step)), out = [];
    for (let i = 0; i <= n; i++) out.push(TracePath.along(p, (L * i) / n));
    return out;
  }
  /**
   * µm along polyline p to where its depth first changes by more than dzMax within w µm (where that change
   * starts), or its whole length. On the hand-traced nuclei, stopping suggestions there removed most of the
   * wrong ones that stayed on a single traced segment: those jump onto a track stacked above or below.
   */
  function zStep(p, dzMax = 0.25, w = 0.6) {
    const arc = [0];
    for (let i = 1; i < p.length; i++) arc.push(arc[i - 1] + d3(p[i], p[i - 1]));
    let j = 0;
    for (let i = 0; i < p.length; i++) {
      while (arc[i] - arc[j] > w) j++;
      let lo = Infinity, hi = -Infinity;
      for (let k = j; k <= i; k++) { if (p[k][2] < lo) lo = p[k][2]; if (p[k][2] > hi) hi = p[k][2]; }
      if (hi - lo > dzMax) return arc[j];
    }
    return arc[arc.length - 1];
  }
  /** Is point q within rXY (in XY) and rZ (in Z, at the closest place) of polyline P? */
  function nearLine(q, P, rXY = 0.15, rZ = 0.3) {
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
      let f = l2 > 0 ? ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / l2 : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const dx = a[0] + f * vx - q[0], dy = a[1] + f * vy - q[1];
      if (dx * dx + dy * dy <= rXY * rXY && Math.abs(a[2] + f * (b[2] - a[2]) - q[2]) <= rZ) return true;
    }
    return P.length === 1 && Math.hypot(P[0][0] - q[0], P[0][1] - q[1]) <= rXY && Math.abs(P[0][2] - q[2]) <= rZ;
  }
  /**
   * Suggested continuations of a trace, from a reference trace made by the automatic tracer over the whole
   * image (R: { edges, nodes, bridges, edgeChain, gapCands, params }).
   * - Only chains of R that the trace's last `win` µm already runs along (≥ minCov of it within 0.15 µm in XY,
   *   0.3 µm in Z, and its last 0.3 µm too) are continued: where the trace and the automatic trace agree.
   * - The way on follows that chain as the tracer joined it (at junctions and across gaps), up to `lfull` µm.
   * - `end`, where the suggestion stops unless you move it, is the first gap link the chain crosses, a junction
   *   where another branch turns about as well (within `margin`), a sharp change of depth, the chain's end or `lmax`:
   *   on the hand-traced nuclei 39 of 40 (1804) and 23 of 26 (1805) suggestions were right up to there.
   * - Suggestions with less than `minLen` µm before that point are not shown: nothing is suggested where the
   *   tracer itself was unsure.
   * trail: the trace's last few µm, ending at its end. Returns [{ pts (from the end), end, full, cov }] best first.
   */
  function chainSuggestions(R, trail, o = {}) {
    const E = R.edges, Lmax = o.lmax || 5, Lfull = Math.max(Lmax, o.lfull || 15), win = o.win || 1.5;
    const minCov = o.minCov != null ? o.minCov : 0.75, minLen = o.minLen != null ? o.minLen : 0.5;
    const margin = o.margin != null ? o.margin : 0.3;
    const zRef = (R.params && R.params.zRef) || 0.3, maxBend = 75 * Math.PI / 180;
    const T = trail[trail.length - 1];
    const back = cutAt(trail.slice().reverse(), win);
    if (polyLen(back) < 0.6) return [];
    const recent = resample(back.slice().reverse(), 0.05); // older → T
    const ch = (i) => (R.edgeChain && R.edgeChain.length > i ? R.edgeChain[i] : -1 - i);
    // segments near the trace's end, and which of the recent points each chain covers
    const reach = win + 0.5, cov = new Map(), chainEdges = new Map();
    for (let i = 0; i < E.length; i++) {
      const P = E[i].pts;
      let close = false;
      for (let q = 0; q < P.length && !close; q += 2) if (Math.abs(P[q][0] - T[0]) < reach && Math.abs(P[q][1] - T[1]) < reach) close = true;
      if (!close) continue;
      const c = ch(i);
      if (!chainEdges.has(c)) { chainEdges.set(c, []); cov.set(c, new Uint8Array(recent.length)); }
      chainEdges.get(c).push(i);
      const m = cov.get(c);
      for (let k = 0; k < recent.length; k++) if (!m[k] && nearLine(recent[k], P)) m[k] = 1;
    }
    const nTail = Math.max(1, Math.round(0.3 / 0.05));
    const atNode = new Map(), brAt = new Map(), gapAt = new Map();
    const add = (m, n, v) => { if (!m.has(n)) m.set(n, []); m.get(n).push(v); };
    E.forEach((e, i) => { add(atNode, e.a, i); add(atNode, e.b, i); });
    R.bridges.forEach((b, bi) => { if (b.on !== false) { add(brAt, b.a, bi); add(brAt, b.b, bi); } });
    (R.gapCands || []).forEach((g) => { if (!g.user) { add(gapAt, g.a, g); add(gapAt, g.b, g); } });
    const fromNode = (e, n) => (E[e].a === n ? E[e].pts : E[e].pts.slice().reverse());
    const far = (e, n) => (E[e].a === n ? E[e].b : E[e].a);
    const armXY = (pts, L = 0.5) => { const a = TracePath.along(pts, Math.min(L, polyLen(pts))); return [a[0] - pts[0][0], a[1] - pts[0][1]]; };
    const armZ = (pts, L = 0.5) => TracePath.meanZ(pts, 0, Math.min(L, polyLen(pts)));
    const turnCost = (pts, P) => {
      const bk = cutAt(pts.slice().reverse(), 0.6), th = Math.PI - angXY(armXY(bk), armXY(P));
      return (th / maxBend) ** 2 + 1.5 * ((armZ(bk) - armZ(P)) / zRef) ** 2;
    };
    const gapCost = (n, m) => { for (const g of gapAt.get(n) || []) if ((g.a === n && g.b === m) || (g.b === n && g.a === m)) return g.cost; return null; };
    /** Continue pts from node n (reached along e) along e's chain, up to Lfull; .stop = length at the first unsure choice. */
    const onward = (e, n, pts, seen) => {
      let len = polyLen(pts), stop = null;
      const joins = [];
      for (let guard = 0; guard < 400 && len < Lfull; guard++) {
        let next = null;
        for (const f of atNode.get(n) || []) if (f !== e && !seen.has(f) && ch(f) === ch(e)) { next = { f, n }; break; }
        if (next) { // through a junction: how much better than the other branches it turns
          const c = turnCost(pts, fromNode(next.f, n));
          let alt = Infinity;
          for (const g of atNode.get(n) || []) if (g !== e && g !== next.f && !seen.has(g)) alt = Math.min(alt, turnCost(pts, fromNode(g, n)) - c);
          joins.push({ len, kind: 'junction', cost: c, alt });
        }
        if (!next) for (const bi of brAt.get(n) || []) {
          const b = R.bridges[bi], other = b.a === n ? b.b : b.a, f = b.a === n ? b.eb : b.ea;
          if (f >= 0 && f < E.length && !seen.has(f) && (E[f].a === other || E[f].b === other) && ch(f) === ch(e)) { next = { f, n: other, jump: true, b }; break; }
        }
        if (next && next.jump) { // across a gap: the tracer's cost for it, and how much better than the other candidates
          const c = gapCost(n, next.n);
          let alt = Infinity;
          for (const g of gapAt.get(n) || []) { const m = g.a === n ? g.b : g.a; if (m !== next.n && c != null) alt = Math.min(alt, g.cost - c); }
          const b = next.b;
          joins.push({ len, kind: b.forced ? 'forced' : b.linked ? 'linked' : b.bright ? 'bright' : b.user ? 'user' : 'gap', cost: c, alt, d: b.length || d3(b.pa, b.pb), pa: b.pa, pb: b.pb });
        }
        // where the suggestion stops by default: at every gap link (12 of 93 gap links the suggestions crossed on
        // 1804 were wrong, and nothing the tracer records tells which), and at a junction where another branch
        // turns about as well (within margin)
        if (next && stop == null) { const j = joins[joins.length - 1]; if (o.sure ? !o.sure(j) : j.kind !== 'junction' || !(j.alt >= margin)) stop = len; }
        if (!next) break; // the chain ends
        if (next.jump) pts.push(R.nodes[next.n].slice());
        seen.add(next.f);
        const P = fromNode(next.f, next.n);
        for (let i = 1; i < P.length; i++) pts.push(P[i]);
        e = next.f; n = far(next.f, next.n); len = polyLen(pts);
      }
      const r = cutAt(pts, Lfull);
      r.stop = stop != null ? Math.min(stop, polyLen(r)) : polyLen(r);
      r.joins = joins;
      return r;
    };
    const out = [];
    for (const [c, m] of cov) {
      let n = 0;
      for (let k = 0; k < m.length; k++) n += m[k];
      const f = n / m.length;
      let tail = 0;
      for (let k = m.length - nTail; k < m.length; k++) if (k >= 0) tail += m[k];
      if (f < minCov || tail < 0.66 * nTail) continue;
      // where the trace's end lies on the chain
      let bi = -1, bj = -1, bd = Infinity;
      for (const i of chainEdges.get(c)) {
        const P = E[i].pts;
        for (let q = 0; q < P.length; q++) { const d = Math.hypot(P[q][0] - T[0], P[q][1] - T[1]) + 0.3 * Math.abs(P[q][2] - T[2]); if (d < bd) { bd = d; bi = i; bj = q; } }
      }
      if (bi < 0) continue;
      // both ways along the chain from there; the way on is the one the trace has not come along
      let best = null;
      for (const s of [1, -1]) {
        const P = E[bi].pts, part = s > 0 ? P.slice(bj) : P.slice(0, bj + 1).reverse(), nd = s > 0 ? E[bi].b : E[bi].a;
        const pts = onward(bi, nd, [T.slice()].concat(part.slice(1)), new Set([bi]));
        const head = resample(cutAt(pts, 0.5), 0.05);
        const back2 = head.filter((q) => nearLine(q, back, 0.12, 0.3)).length / head.length;
        if (polyLen(pts) < 0.3) continue;
        if (!best || back2 < best.back2) best = { pts, back2 };
      }
      if (!best || best.back2 > 0.5) continue;
      // and where it changes depth sharply (a jump onto a stacked track; SC tracks mostly stay in their layer)
      const end = Math.min(best.pts.stop, Lmax, zStep(best.pts, o.zStep || 0.25)), full = polyLen(best.pts);
      if (end < minLen) continue; // the tracer is unsure right here: no suggestion
      out.push({ pts: best.pts, end, full, cov: f, chain: c, joins: best.pts.joins });
    }
    out.sort((a, b) => b.cov - a.cov);
    // one suggestion per way: drop one that runs along a better one
    const res = [];
    for (const g of out) {
      const head = resample(cutAt(g.pts, g.end), 0.1);
      if (res.some((h) => head.filter((q) => nearLine(q, cutAt(h.pts, Math.max(h.end, g.end)), 0.12, 0.3)).length > 0.7 * head.length)) continue;
      res.push(g);
      if (res.length >= (o.k || 3)) break;
    }
    return res;
  }
  window.TraceSuggest = { chainSuggestions };

  /**
   * Minimum-cost path through the image inside a painted band (3D Dijkstra on voxels). The band is
   * every voxel whose XY distance to the stroke is ≤ R (any Z); cost favours bright voxels near the
   * stroke's centre line and penalises Z steps, so the path stays on the track and in its layer.
   */
  function guidePath(app, img, stroke, R, ends, zHint, sigma = 0, strict = true, zWin = 0) {
    const [W, H, D] = app.dims, [sx, sy, sz] = app.spacing, WH = W * H, I = img.data;
    // drawn on a single slice: the path stays within ±zWin µm of it (and prefers to stay close)
    const zLo = zHint != null && zWin > 0 ? Math.max(0, Math.floor(zHint - zWin / sz)) : 0;
    const zHi = zHint != null && zWin > 0 ? Math.min(D - 1, Math.ceil(zHint + zWin / sz)) : D - 1;
    // stroke resampled to half-pixel steps (µm, xy)
    const S = [stroke[0]];
    for (let i = 1; i < stroke.length; i++) {
      const a = S[S.length - 1], b = stroke[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.floor(d / (0.5 * sx));
      for (let k = 1; k <= n; k++) S.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    }
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const p of S) { mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]); mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]); }
    const x0 = Math.max(0, Math.floor((mnx - R) / sx) - 1), x1 = Math.min(W - 1, Math.ceil((mxx + R) / sx) + 1);
    const y0 = Math.max(0, Math.floor((mny - R) / sy) - 1), y1 = Math.min(H - 1, Math.ceil((mxy + R) / sy) + 1);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, BP = bw * bh;
    // XY distance of each band pixel to the stroke, and how far along the stroke its nearest point is.
    // Where the stroke passes a pixel twice (a self-crossing or a tight bend) both positions are kept.
    const dxy = new Float32Array(BP).fill(Infinity), arc = new Float32Array(BP), d2 = new Float32Array(BP).fill(Infinity), arc2 = new Float32Array(BP).fill(NaN);
    const rx = Math.ceil(R / sx) + 1, ry = Math.ceil(R / sy) + 1;
    let s0 = 0;
    for (let s = 1; s < S.length || s === 1; s++) {
      const a = S[s - 1], b = S[Math.min(s, S.length - 1)];
      const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy, sl = Math.sqrt(l2);
      const ax = Math.round(Math.min(a[0], b[0]) / sx), bx = Math.round(Math.max(a[0], b[0]) / sx);
      const ay = Math.round(Math.min(a[1], b[1]) / sy), by = Math.round(Math.max(a[1], b[1]) / sy);
      for (let y = Math.max(y0, ay - ry); y <= Math.min(y1, by + ry); y++) {
        for (let x = Math.max(x0, ax - rx); x <= Math.min(x1, bx + rx); x++) {
          const px = x * sx, py = y * sy;
          let tt = l2 ? ((px - a[0]) * vx + (py - a[1]) * vy) / l2 : 0;
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          const d = Math.hypot(a[0] + tt * vx - px, a[1] + tt * vy - py), q = (y - y0) * bw + (x - x0);
          if (d > R) continue; // only stroke positions within the band count
          const ac = s0 + tt * sl;
          if (dxy[q] === Infinity || Math.abs(ac - arc[q]) <= 2 * R) { if (d < dxy[q]) { dxy[q] = d; arc[q] = ac; } }
          else if (isNaN(arc2[q]) || Math.abs(ac - arc2[q]) <= 2 * R) { if (d < d2[q]) { d2[q] = d; arc2[q] = ac; } }
          else if (d < Math.max(dxy[q], d2[q])) { if (dxy[q] > d2[q]) { dxy[q] = d; arc[q] = ac; } else { d2[q] = d; arc2[q] = ac; } }
        }
      }
      s0 += sl;
    }
    for (let q = 0; q < BP; q++) if (d2[q] < dxy[q]) dxy[q] = d2[q]; // band distance = nearest pass
    const inBand = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && dxy[(y - y0) * bw + (x - x0)] <= R;
    // the stroke position on this pixel nearest to the path's progress p (NaN if both are too far)
    const arcNear = (q, p) => { const a = arc[q], b = arc2[q], da = Math.abs(a - p), db = isNaN(b) ? Infinity : Math.abs(b - p); return Math.min(da, db) > R ? NaN : da <= db ? a : b; };
    const N = BP * D, lid = (x, y, z) => z * BP + (y - y0) * bw + (x - x0);
    // the band's voxels, sharpened along Z as the tracer does (Richardson–Lucy, measured axial blur),
    // which separates stacked tracks
    const J = new Float32Array(N), vals = [];
    let mx = 0;
    for (let q = 0; q < BP; q++) if (dxy[q] <= R) { const c = (y0 + ((q / bw) | 0)) * W + x0 + (q % bw); for (let z = 0; z < D; z++) { const v = I[z * WH + c]; J[z * BP + q] = v; if (v > mx) mx = v; } }
    if (sigma > 0.6 * sz && D > 4) {
      const sg = sigma / sz, r = Math.max(1, Math.ceil(3 * sg)), ker = [];
      let ks = 0;
      for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sg * sg)); ker.push(v); ks += v; }
      for (let i = 0; i < ker.length; i++) ker[i] /= ks;
      const bg = 0.01 * mx + 1e-6, d = new Float64Array(D), est = new Float64Array(D), b = new Float64Array(D), qq = new Float64Array(D);
      const blur = (src, dst) => { for (let z = 0; z < D; z++) { let a = 0; for (let j = -r; j <= r; j++) { const zz = z + j < 0 ? 0 : z + j >= D ? D - 1 : z + j; a += src[zz] * ker[j + r]; } dst[z] = a; } };
      for (let q = 0; q < BP; q++) {
        if (!(dxy[q] <= R)) continue;
        for (let z = 0; z < D; z++) { d[z] = J[z * BP + q] + bg; est[z] = d[z]; }
        for (let it = 0; it < 20; it++) {
          blur(est, b);
          for (let z = 0; z < D; z++) qq[z] = d[z] / Math.max(b[z], 1e-9);
          blur(qq, b);
          for (let z = 0; z < D; z++) est[z] *= b[z];
        }
        for (let z = 0; z < D; z++) J[z * BP + q] = Math.max(0, est[z] - bg);
      }
    }
    // robust intensity scale inside the band
    for (let q = 0; q < BP; q++) if (dxy[q] <= R) for (let z = 0; z < D; z++) vals.push(J[z * BP + q]);
    if (!vals.length) return null;
    const sorted = Float32Array.from(vals).sort();
    const lo = sorted[Math.floor(0.5 * (sorted.length - 1))], hi = Math.max(lo + 1e-9, sorted[Math.floor(0.995 * (sorted.length - 1))]);
    const norm = (v) => { const n = (v - lo) / (hi - lo); return n < 0 ? 0 : n > 1 ? 1 : n; };
    const zr = zHint != null ? Math.max(1, Math.round(0.3 / sz)) : D;
    // path end voxels: a snapped trace point, or every bright voxel near the stroke end (any layer, or
    // near the shown slice) — the search then picks the layer with the best continuous track
    const endVox = (k) => {
      const sn = ends[k];
      if (sn) return [[Math.round(sn.p[0] / sx), Math.round(sn.p[1] / sy), Math.max(0, Math.min(D - 1, Math.round(sn.p[2] / sz)))]];
      const c = k ? S[S.length - 1] : S[0], all = [];
      let bv = -Infinity;
      for (let y = Math.max(y0, Math.round((c[1] - R) / sy)); y <= Math.min(y1, Math.round((c[1] + R) / sy)); y++) {
        for (let x = Math.max(x0, Math.round((c[0] - R) / sx)); x <= Math.min(x1, Math.round((c[0] + R) / sx)); x++) {
          if (Math.hypot(x * sx - c[0], y * sy - c[1]) > R) continue;
          for (let z = zHint != null ? Math.max(zLo, zHint - zr) : 0; z <= (zHint != null ? Math.min(zHi, zHint + zr) : D - 1); z++) {
            const v = norm(J[lid(x, y, z)]);
            all.push([x, y, z, v]);
            if (v > bv) bv = v;
          }
        }
      }
      return all.filter((p) => p[3] >= 0.5 * bv).map((p) => p.slice(0, 3));
    };
    const srcs = endVox(0), dsts = endVox(1);
    if (!srcs.length || !dsts.length) return null;
    const cost = new Float32Array(N).fill(-1);
    const costAt = (x, y, z, q) => {
      if (cost[q] < 0) {
        const n = norm(J[q]), r = Math.min(1, dxy[(y - y0) * bw + (x - x0)] / R);
        const zf = zWin > 0 && zHint != null ? (Math.abs(z - zHint) * sz) / zWin : 0;
        cost[q] = (1 + 3 * r * r) * (1 + 2 * zf * zf) / ((0.03 + n) * (0.03 + n));
      }
      return cost[q];
    };
    const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
    const hd = [], hq = [];
    const push = (d, q) => { hd.push(d); hq.push(q); let i = hd.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= hd[i]) break; [hd[p], hd[i]] = [hd[i], hd[p]]; [hq[p], hq[i]] = [hq[i], hq[p]]; i = p; } };
    const pop = () => {
      const d = hd[0], q = hq[0], ld = hd.pop(), lq = hq.pop();
      if (hd.length) {
        hd[0] = ld; hq[0] = lq;
        let i = 0;
        for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hd.length && hd[l] < hd[m]) m = l; if (r < hd.length && hd[r] < hd[m]) m = r; if (m === i) break; [hd[m], hd[i]] = [hd[i], hd[m]]; [hq[m], hq[i]] = [hq[i], hq[m]]; i = m; }
      }
      return [d, q];
    };
    const inBox = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    // prog: how far along the stroke the path to each voxel has got. A step may only move to a pixel
    // the stroke passes near that progress, so the path cannot jump between stretches of the stroke
    // that run close together (two sides of a bend) but can go straight through a self-crossing.
    const forced = new Set(), isDst = new Uint8Array(N), prog = new Float32Array(N);
    for (const p of srcs) if (inBox(p)) { const q = lid(...p); forced.add(q); dist[q] = 0; prog[q] = Math.min(arc[q % BP], isNaN(arc2[q % BP]) ? Infinity : arc2[q % BP]); push(0, q); }
    for (const p of dsts) if (inBox(p)) { const q = lid(...p); forced.add(q); isDst[q] = 1; }
    if (!hd.length) return null;
    const allowed = (x, y, z) => (inBand(x, y) && z >= zLo && z <= zHi) || forced.has(lid(x, y, z));
    let tq = -1;
    while (hd.length) {
      const [d, q] = pop();
      if (d > dist[q]) continue;
      if (isDst[q] && (!strict || prog[q] >= s0 - 3 * R)) { tq = q; break; } // s0 = stroke length: the path must have come all the way
      const z = (q / BP) | 0, r = q - z * BP, y = y0 + ((r / bw) | 0), x = x0 + (r % bw), cq = costAt(x, y, z, q), pq = prog[q];
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz; if (zz < 0 || zz >= D) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < y0 || yy > y1) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if ((!dx && !dy && !dz) || xx < x0 || xx > x1 || !allowed(xx, yy, zz)) continue;
            let pn = pq;
            if (strict && inBand(xx, yy)) { pn = arcNear((yy - y0) * bw + (xx - x0), pq); if (isNaN(pn)) continue; }
            const u = lid(xx, yy, zz);
            // Z steps count double, so the path changes layer only when the image says so
            const nd = d + Math.hypot(dx * sx, dy * sy, 2 * dz * sz) * 0.5 * (cq + costAt(xx, yy, zz, u));
            if (nd < dist[u]) { dist[u] = nd; prev[u] = q; prog[u] = pn; push(nd, u); }
          }
        }
      }
    }
    if (tq < 0) return null;
    const path = [];
    for (let q = tq; q >= 0; q = prev[q]) path.push(q);
    path.reverse();
    // voxel path -> µm points, with sub-voxel Z from the local intensity profile, then smoothed
    const vox = [], raw = [];
    for (const q of path) {
      const z = (q / BP) | 0, r = q - z * BP, y = y0 + ((r / bw) | 0), x = x0 + (r % bw);
      vox.push(z * WH + y * W + x);
      let sw = 0, sz2 = 0;
      for (let k = Math.max(0, z - 2); k <= Math.min(D - 1, z + 2); k++) { const wv = Math.max(0, J[lid(x, y, k)] - lo); sw += wv; sz2 += wv * k; }
      raw.push([x * sx, y * sy, (sw > 0 ? sz2 / sw : z) * sz]);
    }
    const pts = raw.map((p, i) => {
      if (i === 0 || i === raw.length - 1) return p;
      const h = Math.min(3, i, raw.length - 1 - i), s = [0, 0, 0];
      for (let k = -h; k <= h; k++) { s[0] += raw[i + k][0]; s[1] += raw[i + k][1]; s[2] += raw[i + k][2]; }
      return s.map((v) => v / (2 * h + 1));
    });
    if (ends[0]) pts[0] = ends[0].p.slice();
    if (ends[1]) pts[pts.length - 1] = ends[1].p.slice();
    let isum = 0;
    for (const v of vox) isum += I[v];
    // band membership of any µm point (for replacing segments inside the band)
    const inBandUm = (p) => inBand(Math.round(p[0] / sx), Math.round(p[1] / sy));
    return { pts, vox: Int32Array.from(new Set(vox)), isum, icnt: vox.length, inBandUm };
  }

  // ------------------------------------------------------------------ App: state & edits
  Object.assign(App.prototype, {
    /** Trace tool: suggest ways on from the end of the trace being drawn, up to this many µm (0: off). */
    traceSuggestLen: 5,
    async runTrace(inputs, params) {
      const first = this.nextId;
      const r = await this.runOp(ANALYSIS_DEFS.trace, inputs, params);
      if (!r) return;
      const T = r.res.trace;
      // the suggestions while tracing follow this result, as it came out (later edits do not change it)
      const refImg = inputs.find((L) => L && L.kind === 'intensity');
      if (refImg) this.traceSetRef(T, refImg);
      const added = this.layers.filter((L) => L.id >= first);
      const labels = added.find((L) => L.kind === 'labels');
      const ridge = added.find((L) => L.kind === 'mask' && L.name.startsWith('Ridge'));
      const skeleton = added.find((L) => L.kind === 'mask' && L.name.startsWith('Skeleton'));
      if (ridge) ridge.disp.visible = false;
      if (skeleton) skeleton.disp.visible = false;
      const old = this.trace;
      this.trace = {
        edges: T.edges, nodes: T.nodes, bridges: T.bridges, edgeChrom: T.edgeChrom, edgeChrom2: new Int32Array(T.edges.length),
        edgeChain: T.edgeChain, gapCands: T.gapCands || [], mode: T.mode, nChains: T.nChains, warnings: T.warnings || [],
        n: T.n, params: T.params, labelsLayer: labels, maskLayer: ridge || inputs[0], visible: true, sel: null, undo: [], shared: false,
        clickMode: 'trace', active: 1, anchor: null, version: T.version || '', deconv: T.deconv || null,
        imageLayer: inputs.find((L) => L && L.kind === 'intensity') || null,
      };
      this.selectedLabel = 0;
      const kept = old ? this.traceCarryOver(old, this.trace) : 0;
      this.traceSummary();
      this.layersChanged();
      if (kept) this.traceChanged(); else this.ui.refreshTrace();
    },
    /**
     * Hand-drawn (Guide) segments and the hand links between them survive a new automatic trace:
     * they are added to it with their chromosomes, and the automatic pieces then come in unassigned
     * so they do not clash with your numbering. Returns the number of segments kept.
     */
    traceCarryOver(old, t) {
      const keep = old.edges.map((e, i) => i).filter((i) => old.edges[i].guided);
      if (!keep.length) return 0;
      t.edgeChrom = new Int32Array(t.edges.length);
      const nodeMap = new Map();
      const node = (id) => { if (!nodeMap.has(id)) nodeMap.set(id, newNode(t, old.nodes[id])); return nodeMap.get(id); };
      const E0 = t.edges.length, n = keep.length;
      t.edgeChrom = grow(t.edgeChrom, E0 + n); t.edgeChrom2 = grow(t.edgeChrom2, E0 + n);
      if (t.edgeChain) t.edgeChain = grow(t.edgeChain, E0 + n);
      let chain = t.edgeChain ? t.edgeChain.reduce((m, v) => Math.max(m, v), 0) : 0;
      keep.forEach((i, j) => {
        const e = old.edges[i];
        t.edges.push(Object.assign({}, e, { a: node(e.a), b: node(e.b) }));
        t.edgeChrom[E0 + j] = old.edgeChrom[i]; t.edgeChrom2[E0 + j] = old.edgeChrom2[i];
        if (t.edgeChain) t.edgeChain[E0 + j] = ++chain;
      });
      const at = (nd) => t.edges.findIndex((e, i) => i >= E0 && (e.a === nd || e.b === nd));
      for (const b of old.bridges) {
        if (!b.user || b.on === false || !nodeMap.has(b.a) || !nodeMap.has(b.b)) continue;
        const a = nodeMap.get(b.a), c = nodeMap.get(b.b);
        t.bridges.push(Object.assign({}, b, { a, b: c, ea: at(a), eb: at(c) }));
      }
      t.clickMode = old.clickMode || t.clickMode; t.active = old.active != null ? old.active : t.active;
      if (old.n > t.n) t.n = old.n;
      const len = keep.reduce((s, i) => s + old.edges[i].length, 0);
      this.toast(`Automatic trace finished. Your ${n} hand-drawn segment${n > 1 ? 's' : ''} (${fmtNum(len)} µm) ${n > 1 ? 'were' : 'was'} kept; the automatic pieces were added unassigned (muted) for you to paint.` +
        (old.mode !== 'manual' ? ' Assignments of the previous automatic pieces were not carried over.' : ''), 'warn');
      return n;
    },
    /** Start editing without an automatic trace: an empty trace on the chosen image, for drawing chromosomes with Guide. */
    traceStartManual() {
      if (!this.dims) return this.toast('Open an image first');
      const form = this.ui.anaForms.trace, p = (form && form.params) || {};
      const N = this.dims[0] * this.dims[1] * this.dims[2];
      const ok = (L) => L && L.kind === 'intensity' && L.data && L.data.length === N;
      // the tracing form's input, which defaults to the SC channel (the most line-like one)
      const fi = form && form.firstInput();
      const img = ok(fi) ? fi : this.traceSCChannel() || this.layers.find((L) => ok(L) && L.disp.visible) || this.layers.find(ok);
      if (!img) return this.toast('Editing by hand needs an intensity image (the ZYP1 channel) — choose it as the tracing input', 'warn');
      const sz = this.spacing[2];
      let deconv = null;
      if (p.deconvZ !== false && p.deconvZ !== 'false' && this.dims[2] > 4) {
        let sg = parseFloat(p.deconvSigma), how = 'set by hand';
        if (!(sg > 0)) { const zw = this.tracer.zProfileWidth(img.data, this.proc.makeCtx(this.dims, this.spacing)); sg = isFinite(zw.fwhm) ? 0.9 * zw.fwhm / 2.3548 : NaN; how = 'measured'; }
        deconv = sg > 0.6 * sz ? { sigma: sg, iters: 20, how } : { skipped: isFinite(sg) ? 'axial blur below one Z step' : 'could not measure the axial blur' };
      }
      this.trace = {
        edges: [], nodes: {}, bridges: [], edgeChrom: new Int32Array(0), edgeChrom2: new Int32Array(0), edgeChain: new Int32Array(0), gapCands: [],
        mode: 'manual', nChains: 0, warnings: [], n: Math.max(1, Math.round(+p.n || 4)),
        params: { width: 0.15, maxGap: 0, maxBend: Math.PI / 3, minLen: 0, zPenalty: 1.5, zRef: Math.max(0.2, 3 * sz) },
        labelsLayer: null, maskLayer: null, visible: true, sel: null, undo: [], shared: false, clickMode: 'trace', active: 1, anchor: null,
        version: this.tracer.VERSION, deconv, imageLayer: img, source: img.name,
      };
      this.selectedLabel = 0;
      this.traceSummary();
      this.ui.showTab && this.ui.showTab('analyze');
      if (this.tool !== 'trace') this.ui.toggleTraceEdit(); else { this.ui.refreshTrace(); this.requestRender(); }
      this.toast(`Tracing by hand on "${img.name}"${img === this.traceSCChannel() ? " (the most line-like channel, so most likely the SC / ZYP1 channel)" : ""} — if that is not the SC (ZYP1) channel, pick it under "Trace on" in the Edit panel. Click points along a chromosome with Trace. You can start the automatic trace at any time; your drawn segments are kept.`, 'warn');
    },
    traceSummary() {
      const t = this.trace;
      if (!t) return null;
      t.summary = this.tracer.summarize(t);
      return t.summary;
    },
    traceSnapshot() {
      const t = this.trace;
      // shallow copies: hand edits replace edge/bridge objects rather than changing them (except bridge.on)
      t.undo.push({ c: t.edgeChrom.slice(), c2: t.edgeChrom2.slice(), ch: t.edgeChain ? t.edgeChain.slice() : null, edges: t.edges.slice(),
        bridges: t.bridges.slice(), on: t.bridges.map((b) => b.on), gaps: (t.gapCands || []).slice(),
        // where a trace being drawn had got to: undo steps back along it (as in SNT)
        tip: t.tip ? Object.assign({}, t.tip, t.tip.own ? { own: t.tip.own.slice() } : null) : null });
      if (t.undo.length > 200) t.undo.shift();
    },
    traceUndo() {
      const t = this.trace;
      if (!t || !t.undo.length) return this.toast('Nothing to undo');
      const s = t.undo.pop();
      t.edgeChrom = s.c; t.edgeChrom2 = s.c2;
      if (s.edges) { t.edges = s.edges; t.edgeChain = s.ch; t.gapCands = s.gaps; t.bridges = s.bridges; }
      s.on.forEach((on, i) => { t.bridges[i].on = on; });
      t.anchor = null; t.linkFrom = null; t.sel = null;
      // undo steps back along a trace still being drawn (the same one: sid), never into one already finished
      t.tip = t.clickMode === 'trace' && t.tip && s.tip && s.tip.sid === t.tip.sid ? s.tip : null;
      this.traceChanged();
    },
    /** Link mode: first click picks one end, second click joins it to the other piece, with no limits. */
    traceLinkClick(hit) {
      const t = this.trace;
      if (!t.linkFrom || t.linkFrom.id >= t.edges.length) {
        t.linkFrom = { id: hit.id, pick: pickEnd(t, hit) };
        const pk = t.linkFrom.pick;
        t.linkFrom.p = pk.node != null ? t.nodes[pk.node] : t.edges[hit.id].pts[pk.j];
        t.sel = null;
        this.ui.refreshTraceSelection(); this.requestRender();
        return;
      }
      const A = t.linkFrom;
      if (A.id === hit.id) { this.toast('Click a different piece to link to (or Esc to cancel)'); return; }
      t.linkFrom = null;
      this.traceSnapshot();
      const B = { id: hit.id, pick: pickEnd(t, hit) };
      const k = t.active;
      // an unassigned piece linked by its end joins the active chromosome (one cut mid-segment is left
      // for you to paint: only one of its halves is likely to be the continuation)
      const halves = [];
      const resolve = (P) => {
        if (P.pick.node != null) { halves.push([P.id]); return P.pick.node; }
        return splitEdge(this, t, P.id, P.pick.j).node;
      };
      const na = resolve(A), nb = resolve(B);
      for (const hs of halves) {
        if (k > 0 && hs.every((i) => !t.edgeChrom[i] && !t.edgeChrom2[i])) { for (const i of hs) t.edgeChrom[i] = k; this.traceReveal(k); }
      }
      if (na === nb) { t.undo.pop(); this.toast('Those points are already joined'); return; }
      const br = addUserLink(t, na, nb);
      t.sel = { type: 'bridge', id: t.bridges.indexOf(br) };
      this.selectedLabel = Math.max(0, k);
      this.traceChanged();
    },
    // ---------------------------------------------------------------- Trace tool (click to click, as in SNT)
    /** The path-search cache for the trace's image (Z-sharpened like the tracer), or null with a message. */
    tracePathCache() {
      const t = this.trace, img = this.traceImage();
      if (!img) { this.toast('Tracing needs the intensity image (the ZYP1 channel) — open or keep that channel loaded', 'warn'); return null; }
      // axial blur for Z sharpening: the tracer's own measurement for its input channel, else measured once
      // for this channel (imported traces, or another channel picked under "Trace on")
      let sg;
      if (img === t.imageLayer && t.deconv) sg = t.deconv.sigma || 0;
      else {
        this._sigmaFor = this._sigmaFor || new WeakMap();
        if (!this._sigmaFor.has(img)) {
          let s = 0;
          if (this.dims[2] > 4) { const zw = this.tracer.zProfileWidth(img.data, this.proc.makeCtx(this.dims, this.spacing)), v = isFinite(zw.fwhm) ? 0.9 * zw.fwhm / 2.3548 : 0; s = v > 0.6 * this.spacing[2] ? v : 0; }
          this._sigmaFor.set(img, s);
        }
        sg = this._sigmaFor.get(img);
      }
      const C = this._pathCache;
      if (!C || C.img !== img || C.I !== img.data || C.sigma !== sg) this._pathCache = TracePath.makeCache(img, this.dims, this.spacing, sg);
      return this._pathCache;
    },
    /**
     * A click in a slice view as voxel(s) on the track there. On a single slice: the brightest voxel within
     * ±3 px and ±0.2 µm of the slice. On a max projection the depth is not known from the click: every bright
     * layer at that spot is kept as a candidate, and the path search picks the one the track continues into
     * (taking the brightest layer put about one click in five on another, stacked track).
     * Returns an array of voxels, best guess first.
     */
    traceClickVoxels(at) {
      const C = this.tracePathCache();
      if (!C) return null;
      const v = at.view, ax = v.axis, i = v.index, a = at.u - 0.5, b = at.v - 0.5, [W, H, D] = this.dims;
      const p = ax === 'xy' ? [a, b, i] : ax === 'xz' ? [a, i, b] : [i, b, a];
      if (p[0] < -0.5 || p[1] < -0.5 || p[2] < -0.5 || p[0] > W - 0.5 || p[1] > H - 0.5 || p[2] > D - 0.5) return null;
      if (isProjected(this, ax)) {
        const r = this.roiBox(), c = r.full ? TracePath.depthCandidates(C, p) : TracePath.depthCandidates(C, p, 3, 0.25, 6, r.z0, r.z0 + r.d); // the projection's Z range
        if (c.length) return c;
      }
      const slice = ax === 'xy' ? 2 : ax === 'xz' ? 1 : 0, r = [3, 3, 2];
      r[slice] = slice === 2 ? 2 : 6;
      return [TracePath.snap(C, p, r)];
    },
    /** µm point -> voxel. */
    traceVox(p) {
      const [W, H, D] = this.dims, sp = this.spacing, lim = [W, H, D];
      return p.map((v, i) => clampInt(v / sp[i], 0, lim[i] - 1));
    },
    /** Path through the image between voxel sets A and B (each one voxel or candidates); a straight line if the search finds nothing. */
    tracePathVox(A, B) {
      const C = this.tracePathCache();
      if (!C) return null;
      const sp = this.spacing, um = (q) => q.map((v, i) => v * sp[i]);
      return TracePath.findPath(C, A, B) || { pts: [um(A[0]), um(B[0])] };
    },
    /** Path through the image between two points (µm). */
    tracePathBetween(pa, pb) { return this.tracePathVox([this.traceVox(pa)], [this.traceVox(pb)]); },
    /** Screen position of a µm point in a slice view. */
    traceScreenOf(view, p) {
      const [sx, sy, sz] = this.spacing, ax = view.axis;
      const m = ax === 'xy' ? [p[0] / sx, p[1] / sy] : ax === 'xz' ? [p[0] / sx, p[2] / sz] : [p[2] / sz, p[1] / sy];
      return view.toScreen(m[0] + 0.5, m[1] + 0.5);
    },
    /**
     * Trace tool click. at = { view, u, v, x, y } for a click in a slice view (null in 3D).
     * - On empty image: starts a trace, or adds the next stretch to the one being drawn.
     * - On a trace with nothing started: selects it, to extend it (then click a point) or join it (then click another trace).
     * - On another trace while drawing or with one selected: joins the two at their closest ends.
     */
    traceTraceClick(hit, ev = {}, at = null) {
      const t = this.trace;
      if (hit && hit.type === 'bridge') { const b = t.bridges[hit.id]; hit = b && t.edges[b.ea] && edgeShown(t, b.ea) ? { type: 'edge', id: b.ea } : null; }
      if (hit && ev.altKey && at) hit = null; // Alt: a point, even on top of another trace
      const tip = t.tip;
      // a click on the last point (within 7 px) finishes
      const nearPx = (p) => { if (!at || !p) return false; const s = this.traceScreenOf(at.view, p); return Math.hypot(s[0] - at.x, s[1] - at.y) <= 7; };
      if (tip && tip.kind === 'node') {
        if (nearPx(t.nodes[tip.node])) return this.traceFinish(); // a click on the last point finishes
        // the trace being drawn (and the trace it extends) can double back past itself: clicks on it place points
        if (hit && traceOf(t, tip.own[tip.own.length - 1]).edges.has(hit.id)) { if (!at) return this.traceFinish(); hit = null; }
      }
      if (tip && tip.kind === 'point' && nearPx(tip.p)) return this.traceFinish();
      // In a slice view a click counts as a click on a trace only near one of its ends (that is where it is
      // extended or joined anyway); elsewhere it places a point, as in SNT. Otherwise clicking along a
      // chromosome that the automatic trace already covers joined whole automatic pieces, wrong stretches
      // included (1805: 43–86% of the result on the hand trace, against 93–100% now). Shift+click selects a
      // trace anywhere along it.
      if (hit && at && !ev.shiftKey) {
        const T0 = traceOf(t, hit.id);
        if (!T0.ends.some((n) => { const s = this.traceScreenOf(at.view, t.nodes[n]); return Math.hypot(s[0] - at.x, s[1] - at.y) <= 8; })) hit = null;
      }
      // a click on a suggestion (not on another trace's end) takes it up to there; Alt+click still places a point
      if (!hit && at && !ev.altKey) {
        const sa = this.traceSuggestAt(at);
        if (sa && sa.s >= 0.3) { this.traceSuggestAccept(sa.i + 1, sa.s); return; }
      }
      if (hit) {
        const T = traceOf(t, hit.id);
        if (!tip) { // select this trace: the next click extends it or joins it to another
          // the end clicked near (suggestions go on from there)
          let near = null;
          if (at) { let bd = Infinity; for (const n of T.ends) { const s = this.traceScreenOf(at.view, t.nodes[n]), d = Math.hypot(s[0] - at.x, s[1] - at.y); if (d < bd) { bd = d; near = n; } } }
          t.tip = { kind: 'trace', edges: [...T.edges], ends: T.ends, near, k: T.k, chain: t.edgeChain ? t.edgeChain[hit.id] : null, sid: ++tipSid };
          t.sel = null;
          this.selectedLabel = T.k;
          this.ui.refreshTraceSelection(); this.requestRender();
          this.traceSuggestSoon();
          return;
        }
        // clicked again (e.g. further along a piece just joined on): it stays selected; Esc or a right-click lets go
        if (tip.kind === 'trace' && tip.edges.includes(hit.id)) { this.ui.refreshTraceSelection(); this.requestRender(); return; }
        this.traceJoin(T, hit.id);
        return;
      }
      if (!at) {
        if (!tip) this.traceSelect(null);
        this.toast('Place points in a slice view (Slice or Ortho). In 3D you can click a trace and then another to join them.');
        return;
      }
      const cands = this.traceClickVoxels(at);
      if (!cands) return;
      const sp = this.spacing, p = cands[0].map((x, i) => x * sp[i]), deep = cands.length > 1;
      if (!tip) { t.tip = { kind: 'point', p, src: cands, k: Math.max(0, t.active), sid: ++tipSid }; t.sel = null; this.ui.refreshTraceSelection(); this.requestRender(); return; }
      let src, from = null, k = tip.k, chain = tip.chain != null ? tip.chain : null, own = [], fresh = true;
      if (tip.kind === 'point') src = tip.src || [this.traceVox(tip.p)];
      else if (tip.kind === 'trace') { // extend from the selected trace's end nearest to the click (in XY when its depth is open)
        const dist = (q) => (deep ? Math.hypot(q[0] - p[0], q[1] - p[1]) : d3(q, p));
        from = tip.ends.reduce((b, n) => (b == null || dist(t.nodes[n]) < dist(t.nodes[b]) ? n : b), null);
        src = [this.traceVox(t.nodes[from])]; fresh = false;
      } else { from = tip.node; src = [this.traceVox(t.nodes[from])]; own = tip.own; fresh = tip.fresh; }
      const G = this.tracePathVox(src, cands);
      if (!G) return;
      this.traceSnapshot();
      if (from == null) from = newNode(t, G.pts[0]);
      const nb = newNode(t, G.pts[G.pts.length - 1]);
      const E = addEdge(t, from, nb, G, k, chain);
      if (chain == null && t.edgeChain) chain = t.edgeChain[E];
      t.tip = { kind: 'node', node: nb, k, chain, own: [...own, E], fresh, sid: tip.sid };
      t.sel = null;
      this.selectedLabel = k;
      if (this.traceReveal(k)) this.displayVersion++;
      this.traceChanged();
    },
    /** Join the trace being drawn (or the selected trace) to trace T at their closest ends, along the image. */
    traceJoin(T, hitId) {
      const t = this.trace, tip = t.tip;
      let froms, A, fresh, kA = tip.k;
      if (tip.kind === 'trace') { froms = tip.ends.map((n) => [n, t.nodes[n]]); A = tip.edges; fresh = false; }
      else if (tip.kind === 'node') { froms = [[tip.node, t.nodes[tip.node]]]; fresh = tip.fresh; A = fresh ? tip.own : [...traceOf(t, tip.own[tip.own.length - 1]).edges]; }
      else { froms = [[null, tip.p]]; A = []; fresh = true; }
      let best = null;
      for (const [na, pa] of froms) for (const nb of T.ends) { const d = d3(pa, t.nodes[nb]); if (na !== nb && (!best || d < best.d)) best = { na, pa, nb, d }; }
      if (!best) { this.toast('Those two are already joined there'); return; }
      // from a start point clicked on a max projection, any of its candidate layers may start the join
      const G = best.na == null && tip.src ? this.tracePathVox(tip.src, [this.traceVox(t.nodes[best.nb])]) : this.tracePathBetween(best.pa, t.nodes[best.nb]);
      if (!G) return;
      this.traceSnapshot();
      const na = best.na != null ? best.na : newNode(t, G.pts[0]);
      // one trace now, so one chromosome: a trace you clicked first keeps its number (the other takes it);
      // a trace you are drawing from scratch takes the number of the trace it joins, if that has one
      const kB = T.k, chainB = t.edgeChain ? t.edgeChain[hitId] : null;
      let k, moved = null;
      if (fresh ? kB : !kA) { k = kB || kA; if (kA !== k) { recolour(t, A, kA, k); moved = 'a'; } else if (kB !== k) { recolour(t, T.edges, kB, k); moved = 'b'; } }
      else { k = kA || kB; if (kB !== k) { recolour(t, T.edges, kB, k); moved = 'b'; } }
      const chain = tip.chain != null ? tip.chain : chainB;
      if (t.edgeChain && chain != null) { for (const i of A) t.edgeChain[i] = chain; for (const i of T.edges) t.edgeChain[i] = chain; }
      const E = addEdge(t, na, best.nb, G, k, chain);
      // the joined trace stays selected, so clicking on along a chromosome keeps adding to it: the next piece
      // clicked joins at its closest end, a click on empty image extends it (Esc or a right-click finishes)
      const J = traceOf(t, E);
      // suggestions go on from the far end of the trace just joined on
      const farEnds = T.ends.filter((n) => n !== best.nb && J.ends.includes(n));
      t.tip = { kind: 'trace', edges: [...J.edges], ends: J.ends, near: farEnds.length === 1 ? farEnds[0] : null, k: J.k, chain: t.edgeChain ? t.edgeChain[E] : null, sid: tip.sid };
      t.sel = null;
      this.selectedLabel = k;
      if (this.traceReveal(k)) this.displayVersion++;
      const name = (c) => (c ? 'chromosome ' + c : 'unassigned');
      this.toast(`Joined along ${fmtNum(t.edges[E].length)} µm of image` + (moved === 'b' && kB !== k ? ` — the trace you joined (${name(kB)}) is now ${name(k)}` : moved === 'a' && kA !== k ? ` — ${tip.kind === 'trace' ? 'the trace you clicked first' : 'your trace'} (${name(kA)}) takes its number: ${name(k)}` : '') + '. Ctrl+Z undoes.');
      this.traceChanged();
    },
    // ---------------------------------------------------------------- suggestions while tracing (key 1–3)
    /**
     * Where the trace being drawn goes on from: its last point (or the end of a selected trace you clicked
     * near) and its last few µm (trail, ending there). Null for a start point alone or when not tracing.
     */
    traceTipEnd() {
      const t = this.trace, tp = t && t.tip;
      if (!tp || this.tool !== 'trace' || t.clickMode !== 'trace') return null;
      let node, own;
      if (tp.kind === 'node') { node = tp.node; own = traceOf(t, tp.own[tp.own.length - 1]).edges; }
      else if (tp.kind === 'trace' && tp.near != null) { node = tp.near; own = new Set(tp.edges); }
      else return null;
      if (!t.nodes[node]) return null;
      // the trace's last few µm, walking back from the end along its own segments
      const trail = [t.nodes[node]];
      let n = node, prev = -1, acc = 0;
      for (let guard = 0; guard < 50 && acc < 4; guard++) {
        let e = -1;
        for (const i of own) if (i !== prev && t.edges[i] && (t.edges[i].a === n || t.edges[i].b === n)) { e = i; break; }
        if (e < 0) break;
        const P = t.edges[e].a === n ? t.edges[e].pts : t.edges[e].pts.slice().reverse();
        for (let i = 1; i < P.length; i++) { acc += d3(P[i], P[i - 1]); trail.push(P[i]); }
        n = t.edges[e].a === n ? t.edges[e].b : t.edges[e].a; prev = e;
      }
      if (acc < 0.15) return null;
      return { node, T: trail[0], own, trail: trail.slice().reverse() };
    },
    /**
     * The reference the suggestions follow: an automatic trace of the whole image (or of the clipping box), as the tracer made it (later
     * edits do not change it). After "Trace chromosomes" it is that result; before it, the same tracing runs in
     * the background, on the channel Trace follows, with the tracing form's settings (a second worker: it
     * does not block anything else). Returns the reference when ready, else null (and starts it if needed).
     */
    traceEnsureRef() {
      const img = this.trace && this.traceImage();
      if (!img) return null;
      const part = this.roiPart();   // the same region as Trace chromosomes: the clipping box
      if (part === false) return null;
      const R = this.traceRef, key = roiKeyOf(part);
      if (R && R.data === img.data && R.roiKey === key) return R.status === 'ready' ? R : null;
      if (R && R.worker) { try { R.worker.w.terminate(); } catch (e) { /* gone */ } } // made for another channel or box
      const form = this.ui.anaForms.trace, params = Object.assign({}, (form && form.params) || {});
      const ref = this.traceRef = { img, data: img.data, roiKey: key, status: 'running', frac: 0, worker: new WorkerHost() };
      const args = part ? this.roiArgs(ANALYSIS_DEFS.trace, [img], params, part)
        : { op: 'trace', inputs: [{ data: img.data, kind: 'intensity', dtype: img.dtype }], dims: this.dims, spacing: this.spacing, params };
      const t0 = performance.now();
      ref.worker.call('op', args, [], (f) => { ref.frac = f; if (this.trace && this.trace.tip) this.requestRender('2d'); })
        .then((res) => {
          if (this.traceRef !== ref) return;
          if (part) this.roiResult(res, part);
          this.traceSetRef(res.trace, img);
          this.log && this.log(`Reference trace for suggestions on "${img.name}" made in the background (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
          this.traceSuggestSoon();
        })
        .catch((e) => { if (this.traceRef === ref) { ref.status = 'failed'; ref.error = e.message; this.ui.refreshTraceSelection(); } })
        .finally(() => { try { ref.worker.w.terminate(); URL.revokeObjectURL(ref.worker.url); } catch (e) { /* gone */ } ref.worker = null; });
      return null;
    },
    /** Keep tracer result T (worker output, before any edits) as the suggestions' reference for image img. */
    traceSetRef(T, img) {
      if (!T || !img) return;
      if (this.traceRef && this.traceRef.worker && this.traceRef.data !== img.data) { try { this.traceRef.worker.w.terminate(); } catch (e) { /* gone */ } }
      this.traceRef = { img, data: img.data, roiKey: roiKeyOf(T.roi), status: 'ready', edges: T.edges.slice(), nodes: Object.assign({}, T.nodes), bridges: T.bridges.map((b) => Object.assign({}, b)),
        edgeChain: T.edgeChain ? T.edgeChain.slice() : null, gapCands: (T.gapCands || []).slice(), params: T.params, n: T.edges.length };
    },
    /** The suggestions for the trace being drawn, if they are still for its current end (else null). */
    traceSuggestions() {
      const t = this.trace, s = t && t.sugg;
      return s && t.tip && s.tip === t.tip && this.tool === 'trace' && t.clickMode === 'trace' && s.list.length ? s : null;
    },
    /** Suggest ways on from the trace's end shortly (after the view has redrawn); stale ones are dropped. */
    traceSuggestSoon() {
      const t = this.trace;
      clearTimeout(this._suggT);
      if (!t || !t.tip || !(this.traceSuggestLen > 0) || this.tool !== 'trace' || t.clickMode !== 'trace') return;
      const tip = t.tip;
      this._suggT = setTimeout(() => {
        if (this.trace !== t || t.tip !== tip) return;
        try { this.traceSuggestNow(); } catch (e) { console.warn('suggestions', e); }
        this.ui.refreshTraceSelection(); this.requestRender();
      }, 20);
    },
    /**
     * Continuations of the trace being drawn (t.sugg), from the reference trace: only where the trace's last
     * 1.5 µm runs along one of its chains, and only as far as the tracer was sure (see chainSuggestions).
     * Each is re-traced through the image; `end` (µm along it) is how much a key press takes.
     */
    traceSuggestNow() {
      const t = this.trace;
      t.sugg = null;
      const end = this.traceTipEnd();
      if (!end) return null;
      const R = this.traceEnsureRef();
      if (!R) return null;
      const L = this.traceSuggestLen || 5;
      const list = chainSuggestions(R, end.trail, { lmax: L, lfull: Math.max(15, L) }).map((g) => {
        const r = this.traceRefine(g.pts), full = polyLen(r.pts);
        return { pts: r.pts, full, end: Math.min(full, g.end * (full / Math.max(1e-9, g.full))), def: g.end };
      }).filter((g) => g.end >= 0.3);
      t.sugg = { tip: t.tip, node: end.node, list, focus: 0 };
      return t.sugg;
    },
    /**
     * A suggestion's route re-traced through the image, as clicks along it would be: waypoints every 0.8 µm
     * (on the brightest voxel next to the route), joined by the Trace tool's path search. The automatic trace
     * gives the route; its straight gap links and junction centres can lie beside the track.
     */
    traceRefine(pts) {
      const C = this.tracePathCache(), L = polyLen(pts);
      if (!C || L < 0.2) return { pts };
      const n = Math.max(1, Math.round(L / 0.8)), wps = [this.traceVox(pts[0])];
      for (let i = 1; i <= n; i++) wps.push(TracePath.snap(C, this.traceVox(TracePath.along(pts, (L * i) / n)), [1, 1, 1]));
      let out = [pts[0].slice()];
      for (let i = 1; i < wps.length; i++) {
        const G = TracePath.findPath(C, [wps[i - 1]], [wps[i]], { maxMargin: 0.4, zMargin: 0.5 });
        if (!G) return { pts };
        out = out.concat(G.pts.slice(1));
      }
      return { pts: out };
    },
    /** The state of the suggestions, for the status line. */
    traceSuggestInfo() {
      if (!(this.traceSuggestLen > 0)) return 'Suggestions are off (Suggestions, above).';
      const img = this.traceImage(), R = this.traceRef;
      if (R && img && R.data === img.data && R.status === 'running') return `Suggestions: an automatic trace of "${img.name}" is being made in the background (${Math.round(100 * (R.frac || 0))}%); they appear when it is ready.`;
      if (R && img && R.data === img.data && R.status === 'failed') return `No suggestions: the background trace failed (${R.error || 'unknown error'}).`;
      const s = this.traceSuggestions();
      if (!s) return 'No suggestion here: suggestions appear only where your last 1.5 µm runs along the automatic trace, and stop where it was unsure.';
      const n = s.list.length, g = s.list[s.focus || 0];
      return `Suggested way on (dashed${n > 1 ? ', ' + n + ' of them' : ''}): press ${n > 1 ? '1–' + n : '1'} to take ${g.end.toFixed(1)} of ${g.full.toFixed(1)} µm. Shift+scroll takes more or less; or click on it where it should stop. Keep clicking to ignore it.`;
    },
    /** One line for the bottom of the XY view while tracing: what the keys do now. */
    traceHint() {
      const t = this.trace;
      if (!t || this.tool !== 'trace' || t.clickMode !== 'trace') return '';
      const tp = t.tip, name = (k) => (k > 0 ? 'chromosome ' + k : 'unassigned');
      if (!tp) return `New trace: ${name(t.active)} (keys 1–9 pick it) · click along a chromosome`;
      const s = this.traceSuggestions(), img = this.traceImage(), R = this.traceRef;
      let msg = `Tracing ${name(tp.k)}`;
      if (s) { const g = s.list[s.focus || 0]; msg += ` · ${s.list.length > 1 ? '1–' + s.list.length : '1'}: take ${g.end.toFixed(1)} µm · Shift+scroll: more / less · or click on it`; }
      else if (this.traceSuggestLen > 0 && R && img && R.data === img.data && R.status === 'running') msg += ` · suggestions: preparing (${Math.round(100 * (R.frac || 0))}%)`;
      return msg + ' · Esc: done';
    },
    /** Shift+scroll: move where the suggestion nearest the mouse stops (by `dir` steps of 0.25 µm). */
    traceSuggestScroll(dir, at) {
      const s = this.traceSuggestions();
      if (!s) return false;
      if (at && s.list.length > 1) { // the suggestion nearest the mouse
        let bd = Infinity;
        s.list.forEach((g, i) => { for (const p of g.pts) { const q = this.traceScreenOf(at.view, p), d = Math.hypot(q[0] - at.x, q[1] - at.y); if (d < bd) { bd = d; s.focus = i; } } });
      }
      const g = s.list[s.focus || 0];
      g.end = Math.max(0.3, Math.min(g.full, g.end + 0.25 * dir));
      this.ui.refreshTraceSelection();
      this.requestRender();
      return true;
    },
    /** A click on a suggestion (within 6 px) in a slice view: { i, s } (which, and µm along it), else null. */
    traceSuggestAt(at) {
      const s = this.traceSuggestions();
      if (!s || !at) return null;
      let best = null;
      s.list.forEach((g, i) => {
        let acc = 0;
        for (let j = 0; j < g.pts.length; j++) {
          if (j) acc += d3(g.pts[j], g.pts[j - 1]);
          const q = this.traceScreenOf(at.view, g.pts[j]), d = Math.hypot(q[0] - at.x, q[1] - at.y);
          if (d <= 6 && (!best || d < best.d)) best = { i, s: acc, d };
        }
      });
      return best;
    },
    /** Add suggestion k (1-based) to the trace, up to `upTo` µm along it (default: where it is set to stop). */
    traceSuggestAccept(k, upTo) {
      const t = this.trace, s = this.traceSuggestions();
      if (!s || k < 1 || k > s.list.length) return false;
      const g = s.list[k - 1], tip = t.tip, [W, H] = this.dims, I = this.traceImage();
      const pts = cutAt(g.pts, Math.max(0.1, upTo != null ? upTo : g.end));
      const vox = [];
      for (const p of pts) { const [x, y, z] = this.traceVox(p), v = (z * H + y) * W + x; if (vox[vox.length - 1] !== v) vox.push(v); }
      let isum = 0;
      if (I && I.data) for (const v of vox) isum += I.data[v];
      this.traceSnapshot();
      const nb = newNode(t, pts[pts.length - 1]);
      let chain = tip.chain != null ? tip.chain : null;
      const E = addEdge(t, s.node, nb, { pts, vox: Int32Array.from(vox), isum, icnt: vox.length }, tip.k, chain);
      if (chain == null && t.edgeChain) chain = t.edgeChain[E];
      t.tip = { kind: 'node', node: nb, k: tip.k, chain, own: [...(tip.kind === 'node' ? tip.own : []), E], fresh: tip.kind === 'node' ? tip.fresh : false, sid: tip.sid };
      t.sel = null;
      this.selectedLabel = Math.max(0, tip.k);
      if (this.traceReveal(tip.k)) this.displayVersion++;
      this.traceChanged();
      return true;
    },
    /** Segment ids of the trace segment i belongs to (see traceOf). */
    tracePiece(i) { return this.trace && this.trace.edges[i] ? [...traceOf(this.trace, i).edges] : []; },
    /** Stop drawing (or drop the selected trace / start point). */
    traceFinish() {
      const t = this.trace;
      if (!t || !t.tip) return;
      t.tip = null;
      this.ui.refreshTraceSelection();
      this.requestRender();
    },
    // ---------------------------------------------------------------- Erase tool
    traceEraseStart(view, u, v) {
      this.traceStroke = { view, pts: [[u, v]], R: 10 / Math.max(1e-9, view.zoom), erase: true };
    },
    /** Erase what the brush stroke went over: segments are cut where the brush starts and ends along them. */
    traceEraseEnd() {
      const st = this.traceStroke, t = this.trace;
      this.traceStroke = null;
      if (!st || !t) return;
      const view = st.view, proj = traceProjector(view), Rpx = st.R * view.zoom;
      const S = st.pts.map(([u, v]) => view.toScreen(u, v));
      const dS = (s) => {
        let best = Infinity;
        for (let i = 0; i < S.length; i++) {
          const a = S[Math.max(0, i - 1)], b = S[i], vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
          let tt = l2 ? ((s[0] - a[0]) * vx + (s[1] - a[1]) * vy) / l2 : 0;
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          best = Math.min(best, Math.hypot(a[0] + tt * vx - s[0], a[1] + tt * vy - s[1]));
        }
        return best;
      };
      const inside = (p) => { const s = proj(p); return !!s && dS(s) <= Rpx; };
      const atNode = chromsAtNodes(t), dropB = new Set();
      t.bridges.forEach((b, i) => {
        if (b.on === false || !bridgeShown(t, ...bridgeChroms(t, b, atNode))) return;
        for (let f = 0; f <= 1.0001; f += 0.1) if (inside([0, 1, 2].map((a) => b.pa[a] + (b.pb[a] - b.pa[a]) * f))) { dropB.add(i); break; }
      });
      const touched = [];
      t.edges.forEach((e, i) => { if (!edgeShown(t, i)) return; const fl = e.pts.map(inside); if (fl.some(Boolean)) touched.push([i, fl]); });
      if (!touched.length && !dropB.size) { this.toast('Nothing to erase there (hidden traces, and on a slice those away from it, are left alone)'); this.requestRender('2d'); return; }
      this.traceSnapshot();
      const dropE = new Set();
      let len = 0;
      for (const [i, fl] of touched) {
        // cut at the last point before the brush and the first point after it, so kept parts keep all their points
        const cuts = new Set();
        for (let j = 0; j + 1 < fl.length; j++) { if (!fl[j] && fl[j + 1]) cuts.add(j); else if (fl[j] && !fl[j + 1]) cuts.add(j + 1); }
        const order = [...cuts].filter((j) => j > 0 && j < fl.length - 1).sort((a, b) => b - a);
        const pieces = [];
        let end = fl.length - 1;
        for (const j of order) { const r = splitEdge(this, t, i, j); if (r.e2 >= 0) pieces.push([r.e2, j, end]); end = j; }
        pieces.push([i, 0, end]);
        for (const [id, a, b] of pieces) {
          let gone = false;
          for (let j = a; j <= b && !gone; j++) if (fl[j]) gone = true;
          if (!gone && pieces.length > 1 && t.edges[id].length < 0.06) gone = true; // no slivers
          if (gone) { dropE.add(id); len += t.edges[id].length; }
        }
      }
      deleteItems(t, dropE, dropB);
      this.toast(`Erased ${fmtNum(len)} µm of trace${dropB.size ? ` and ${dropB.size} link${dropB.size > 1 ? 's' : ''}` : ''} — Ctrl+Z restores`);
      this.traceChanged();
      this.requestRender();
    },
    /** Erase click: the whole trace clicked (a link: just that link). */
    traceEraseClick(hit) {
      const t = this.trace;
      if (!hit) { this.toast('Click a trace to erase all of it, or drag over part of one'); return; }
      if (hit.type === 'bridge') { this.traceDelete(new Set(), new Set([hit.id])); return; }
      const T = traceOf(t, hit.id);
      let len = 0;
      for (const i of T.edges) len += t.edges[i].length;
      this.traceSnapshot();
      deleteItems(t, T.edges, T.bridges);
      this.toast(`Erased the whole trace (${T.k ? 'chromosome ' + T.k + ' piece' : 'unassigned'}, ${fmtNum(len)} µm) — Ctrl+Z restores`);
      this.traceChanged();
      this.requestRender();
    },
    traceGuideStart(view, u, v) {
      const t = this.trace, w = (t.params && t.params.width) || 0.15;
      this.traceStroke = { view, pts: [[u, v]], R: Math.max(0.18, 1.2 * w, 7 / Math.max(1e-9, view.zoom)) };
    },
    traceGuideEnd() {
      const st = this.traceStroke;
      this.traceStroke = null;
      if (!st) return;
      const [sx, sy] = this.spacing;
      const um = st.pts.map(([u, v]) => [(u - 0.5) * sx, (v - 0.5) * sy]);
      const zHint = isProjected(this, 'xy') ? null : st.view.index;
      this.traceGuide(um, st.R, zHint);
    },
    /**
     * Guide stroke: the user paints the true course of the active chromosome. Re-trace it from the image
     * inside the band, hook both ends onto the active chromosome's pieces (or unassigned ones), and take
     * the active chromosome off segments that lie in the band (they are the wrong route through it).
     */
    traceGuide(stroke, R, zHint) {
      const t = this.trace, k = t.active;
      const len = stroke.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - stroke[i - 1][0], p[1] - stroke[i - 1][1]) : 0), 0);
      if (len < 2 * R) { this.toast('Drag further along the chromosome (the stroke was very short)'); this.requestRender('2d'); return; }
      // you see what a stroke changes: it shows the traces and the chromosome drawn (the unassigned pieces when unassigning)
      if (this.traceReveal(k)) this.traceVisChanged();
      const dStroke = (p) => {
        let best = Infinity;
        for (let i = 1; i < stroke.length; i++) {
          const a = stroke[i - 1], b = stroke[i], vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
          let tt = l2 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0;
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          best = Math.min(best, Math.hypot(a[0] + tt * vx - p[0], a[1] + tt * vy - p[1]));
        }
        return best;
      };
      const fracIn = (e) => e.pts.reduce((s, p) => s + (dStroke(p) <= R ? 1 : 0), 0) / e.pts.length;
      // hidden chromosomes are left alone by strokes
      if (k === DEL) { // delete band: remove every visible segment lying mostly inside it, assigned or not
        const drop = new Set();
        t.edges.forEach((e, i) => { if (edgeShown(t, i) && fracIn(e) >= 0.5) drop.add(i); });
        if (!drop.size) { this.toast('No segments lie along that stroke'); this.requestRender('2d'); return; }
        this.traceDelete(drop);
        return;
      }
      if (k === 0) { // eraser band: unassign every segment lying mostly inside it
        this.traceSnapshot();
        let n = 0;
        t.edges.forEach((e, i) => { if ((t.edgeChrom[i] || t.edgeChrom2[i]) && edgeShown(t, i) && fracIn(e) >= 0.5) { t.edgeChrom[i] = 0; t.edgeChrom2[i] = 0; n++; } });
        if (!n) { t.undo.pop(); this.toast('No assigned segments lie along that stroke'); this.requestRender('2d'); return; }
        this.toast(`Unassigned ${n} segment${n > 1 ? 's' : ''}`);
        this.traceChanged();
        return;
      }
      const img = this.traceImage();
      if (!img) return this.toast('Guide needs the intensity image the trace was made from — open or keep that channel loaded', 'warn');
      // hook-up points: nearest point of the active chromosome's segments to each stroke end, else of unassigned ones
      const sz = this.spacing[2];
      // drawn on a single slice: stay within the depth where traces show and can be clicked around it
      const zWin = zHint != null ? Math.max(0.3, 3 * traceDepth(this)) : 0;
      let zFree = false; // set when nothing could be followed near the slice and depth was left open
      const snap = (c) => {
        for (const want of [(i) => t.edgeChrom[i] === k || t.edgeChrom2[i] === k, (i) => !t.edgeChrom[i] && !t.edgeChrom2[i]]) {
          let best = null;
          t.edges.forEach((e, i) => {
            if (!want(i) || !edgeShown(t, i)) return;
            e.pts.forEach((p, j) => {
              if (zWin && !zFree && Math.abs(p[2] - zHint * sz) > zWin) return;
              const d = Math.hypot(p[0] - c[0], p[1] - c[1]) + (zHint != null ? 0.3 * Math.abs(p[2] - zHint * sz) : 0);
              if (d <= R && (!best || d < best.d)) best = { d, id: i, j, p };
            });
          });
          if (best) return best;
        }
        return null;
      };
      const findEnds = () => {
        const en = [snap(stroke[0]), snap(stroke[stroke.length - 1])];
        if (en[0] && en[1] && en[0].id === en[1].id && Math.abs(en[0].j - en[1].j) < 2) en[1] = null;
        return en;
      };
      let ends = findEnds();
      const sg = (t.deconv && t.deconv.sigma) || 0;
      // if keeping to the stroke's order finds no path (rare), try once without it; if nothing can be
      // followed near the slice, follow the image in depth rather than refuse (and say so)
      const run = (w) => guidePath(this, img, stroke, R, ends, zHint, sg, true, w) || guidePath(this, img, stroke, R, ends, zHint, sg, false, w);
      let G = run(zWin);
      if (!G && zWin) { zFree = true; ends = findEnds(); G = run(0); }
      if (!G || G.pts.length < 2) return this.toast('Could not follow the image along that stroke — paint over the track itself', 'warn');
      this.traceSnapshot();
      // cut the hooked-up segments at the hook points (the later point first when both are on one segment)
      const order = [0, 1].filter((s) => ends[s]).sort((p, q) => (ends[p].id === ends[q].id ? ends[q].j - ends[p].j : 0));
      const nodeAt = [null, null];
      for (const s of order) nodeAt[s] = splitEdge(this, t, ends[s].id, ends[s].j).node;
      const na = nodeAt[0] != null ? nodeAt[0] : newNode(t, G.pts[0]);
      const nb = nodeAt[1] != null ? nodeAt[1] : newNode(t, G.pts[G.pts.length - 1]);
      G.pts[0] = t.nodes[na].slice(); G.pts[G.pts.length - 1] = t.nodes[nb].slice();
      // the active chromosome leaves segments lying in the band (it now runs along the new trace)
      let replaced = 0;
      t.edges.forEach((e, i) => {
        if ((t.edgeChrom[i] === k || t.edgeChrom2[i] === k) && fracIn(e) >= 0.5) {
          if (t.edgeChrom[i] === k) { t.edgeChrom[i] = t.edgeChrom2[i]; t.edgeChrom2[i] = 0; } else t.edgeChrom2[i] = 0;
          replaced++;
        }
      });
      const E = t.edges.length;
      t.edges.push({ a: na, b: nb, pts: G.pts, length: polyLen(G.pts), vox: G.vox, isum: G.isum, icnt: G.icnt, guided: true });
      t.edgeChrom = grow(t.edgeChrom, E + 1); t.edgeChrom[E] = k;
      t.edgeChrom2 = grow(t.edgeChrom2, E + 1);
      if (t.edgeChain) { t.edgeChain = grow(t.edgeChain, E + 1); t.edgeChain[E] = t.edgeChain.reduce((m, v) => Math.max(m, v), 0) + 1; }
      t.sel = { type: 'edge', id: E };
      this.selectedLabel = k;
      this.toast((zFree ? `No track could be followed within ±${fmtNum(zWin)} µm of this slice, so the depth was taken from the image (it may run in another layer). ` : '') +
        `Re-traced ${fmtNum(t.edges[E].length)} µm for chromosome ${k}` + (replaced ? `, replacing ${replaced} segment${replaced > 1 ? 's' : ''} in the band` : '') +
        ((!ends[0] || !ends[1]) && t.mode !== 'manual' ? ` — ${!ends[0] && !ends[1] ? 'neither end was' : 'one end was not'} on a piece of chromosome ${k} or an unassigned piece, so ${!ends[0] && !ends[1] ? 'it is' : 'that end is'} left free (use Link to join it)` : ''));
      this.traceChanged();
    },
    /** The intensity layer to re-trace from: the trace's own input if still loaded, else the first visible intensity layer. */
    traceImage() {
      const t = this.trace, N = this.dims ? this.dims[0] * this.dims[1] * this.dims[2] : 0;
      const ok = (L) => L && L.kind === 'intensity' && this.layers.includes(L) && L.data && L.data.length === N;
      if (ok(t.traceOn)) return t.traceOn; // picked under "Trace on" in the Edit panel
      if (ok(t.imageLayer)) return t.imageLayer;
      return this.traceSCChannel() || this.layers.find((L) => ok(L) && L.disp.visible) || this.layers.find(ok) || null;
    },
    /**
     * The channel to trace chromosomes on: the most line-like of the file's channels (the SC / ZYP1 channel),
     * measured once per channel. Processed layers are only considered when there are no original channels.
     */
    traceSCChannel() {
      if (!this.dims) return null;
      const N = this.dims[0] * this.dims[1] * this.dims[2];
      const all = this.layers.filter((L) => L.kind === 'intensity' && L.data && L.data.length === N);
      const orig = all.filter((L) => L.source && L.source.c != null), pool = orig.length ? orig : all;
      if (pool.length <= 1) return pool[0] || null;
      this._lineScore = this._lineScore || new WeakMap();
      let best = null, bs = -1;
      for (const L of pool) {
        let s = this._lineScore.get(L.data);
        if (s == null) { s = lineScore(L, this.dims, this.spacing); this._lineScore.set(L.data, s); }
        if (s > bs) { bs = s; best = L; }
      }
      return best;
    },
    traceSelect(hit) {
      if (!this.trace) return;
      this.trace.sel = hit;
      if (hit && hit.type === 'edge') this.selectedLabel = this.trace.edgeChrom[hit.id] || 0;
      this.ui.refreshTraceSelection();
      this.requestRender();
    },
    /**
     * Show segment i picked from a Segs dropdown in the trace table (k = that row's chromosome, 0 = unassigned):
     * highlights it, shows it if it was hidden and brings it into view on the slice views. It does not change
     * the mode: outside Edit mode this is only for looking; in Edit mode (Select) 1–9, 0 and Delete act on it.
     */
    traceSelectSegment(i, k) {
      const t = this.trace;
      if (!t || !t.edges[i]) return;
      if (k != null) this.ui.segChrom = k;
      if (!edgeShown(t, i)) this.traceReveal(t.edgeChrom[i] || t.edgeChrom2[i] || 0);
      t.visible = true;
      t.anchor = null; t.linkFrom = null;
      t.sel = { type: 'edge', id: i };
      this.selectedLabel = t.edgeChrom[i] || 0;
      this.traceFocus(t.edges[i].pts);
      this.displayVersion++;
      this.ui.refreshTrace();
      this.requestRender();
    },
    /** Drop the highlighted segment (and the chromosome highlight it lit). */
    traceUnselect() {
      const t = this.trace;
      if (!t) return;
      t.sel = null;
      if (this.selectedLabel) { this.selectedLabel = 0; if (this.ui.labelSelected) this.ui.labelSelected(0); }
      this.ui.refreshTrace();
      this.requestRender();
    },
    /** Next (+1) or previous (−1) segment along the chromosome whose dropdown the shown segment came from. */
    traceStepSegment(dir) {
      const t = this.trace;
      if (!t) return;
      if (!t.sel || t.sel.type !== 'edge') return this.toast('Pick a segment from the Segs dropdown in the trace table first; then [ and ] step along its chromosome');
      const list = this.ui.segListOrder ? this.ui.segListOrder() : [];
      if (!list.length) return this.toast('No segments in the list');
      const ui = this.ui, cur = list.indexOf(t.sel.id);
      if (cur < 0 && ui.segLastChrom === ui.segChrom && ui.segLastList) {
        // the selected segment just left this list (reassigned): carry on from its place in the list as it was
        const old = ui.segLastList, p = old.indexOf(t.sel.id);
        if (p >= 0) {
          for (let q = p + dir; q >= 0 && q < old.length; q += dir) if (list.includes(old[q])) return this.traceSelectSegment(old[q]);
          return this.toast(dir > 0 ? 'That was the last segment' : 'That was the first segment');
        }
      }
      const j = cur >= 0 ? cur + dir : dir > 0 ? 0 : list.length - 1;
      if (j < 0 || j >= list.length) return this.toast(j < 0 ? 'That is the first segment' : 'That is the last segment');
      this.traceSelectSegment(list[j]);
    },
    /** Move the slice cursor to the middle of a polyline (µm) and pan slice views that do not show all of it. */
    traceFocus(pts) {
      if (!pts || !pts.length || !this.dims) return;
      const [sx, sy, sz] = this.spacing, [W, H, D] = this.dims, m = pts[pts.length >> 1];
      const c = this.cursor;
      c[0] = clampInt(m[0] / sx, 0, W - 1); c[1] = clampInt(m[1] / sy, 0, H - 1); c[2] = clampInt(m[2] / sz, 0, D - 1);
      for (const v of Object.values(this.sliceViews || {})) {
        const w = v.host.clientWidth, hh = v.host.clientHeight;
        if (!w || !hh || !v.zoom) continue;
        const [px, py] = v.pxSize();
        const uv = (p) => (v.axis === 'xy' ? [p[0], p[1]] : v.axis === 'xz' ? [p[0], p[2]] : [p[2], p[1]]);
        const off = pts.some((p) => { const [a, b] = uv(p), X = (a + px / 2 - v.cx) * v.zoom + w / 2, Y = (b + py / 2 - v.cy) * v.zoom + hh / 2; return X < 24 || Y < 24 || X > w - 24 || Y > hh - 24; });
        if (off) { const [a, b] = uv(m); v.cx = a + px / 2; v.cy = b + py / 2; }
      }
      this.cursorChanged();
    },
    /** Click on a traced segment in any view, interpreted by the current click mode. */
    traceClick(hit, ev = {}, at = null) {
      const t = this.trace;
      if (!t) return;
      if (t.clickMode === 'trace') { this.traceTraceClick(hit, ev, at); return; }
      if (t.clickMode === 'erase') { this.traceEraseClick(hit); return; }
      if (!hit) { this.traceSelect(null); return; }
      if (t.clickMode === 'select' || t.clickMode === 'guide' || (hit.type === 'bridge' && !(t.active === DEL && t.clickMode !== 'link'))) { this.traceSelect(hit); return; }
      if (t.clickMode === 'link') { this.traceLinkClick(hit); return; }
      const k = t.active, shared = !!(ev.shiftKey || t.shared) && k > 0;
      if (k === DEL) { this.traceDeleteClick(hit, ev); return; }
      let edges;
      if (t.clickMode === 'paint') {
        edges = ev.altKey || !t.edgeChain ? [hit.id] : t.edges.map((_, i) => i).filter((i) => t.edgeChain[i] === t.edgeChain[hit.id] && (i === hit.id || edgeShown(t, i)));
        this.traceSnapshot();
      } else {
        this.traceSnapshot();
        if (t.anchor != null && t.anchor !== hit.id) {
          const r = this.tracer.route(t, t.anchor, hit.id);
          // a route that is a long detour for two nearby clicks is not what was meant
          const mid = (i) => t.edges[i].pts[t.edges[i].pts.length >> 1];
          const pa = mid(t.anchor), pb = mid(hit.id);
          const straight = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
          const along = r ? r.edges.slice(1, -1).reduce((s, i) => s + t.edges[i].length, 0) : Infinity;
          if (!r || along > 2.5 * straight + 1.5) {
            // trust the user: join the two clicked pieces directly at their nearest ends
            const A = t.edges[t.anchor], B = t.edges[hit.id];
            let best = null;
            for (const a of [A.a, A.b]) for (const b of [B.a, B.b]) { const d = d3(t.nodes[a], t.nodes[b]); if (a !== b && (!best || d < best.d)) best = { a, b, d }; }
            if (best) addUserLink(t, best.a, best.b);
            edges = [hit.id];
            this.toast(`No path along the trace${r ? ' without a long detour' : ''} — linked the two pieces directly at their nearest ends (${fmtNum(best ? best.d : 0)} µm). Ctrl+Z if that is wrong; use Link to choose the ends yourself.`);
          } else {
            edges = r.edges;
            for (const gi of r.gaps) {
              const g = t.gapCands[gi], ea = g.x >> 1, eb = g.y >> 1;
              if (g.user) { addUserLink(t, g.a, g.b); continue; }
              const have = t.bridges.find((b) => (b.ea === ea && b.eb === eb) || (b.ea === eb && b.eb === ea));
              if (have) have.on = true;
              else t.bridges.push({ a: g.a, b: g.b, pa: g.pa, pb: g.pb, length: g.d, ea, eb, on: true, manual: true });
            }
          }
        } else edges = [hit.id];
        t.anchor = hit.id;
      }
      for (const i of edges) {
        if (k === 0) { t.edgeChrom[i] = 0; t.edgeChrom2[i] = 0; }
        else if (shared) { if (t.edgeChrom[i] !== k) t.edgeChrom2[i] = k; }
        else { t.edgeChrom[i] = k; if (t.edgeChrom2[i] === k) t.edgeChrom2[i] = 0; }
      }
      t.sel = hit;
      this.selectedLabel = k;
      this.traceReveal(k);
      this.traceChanged();
    },
    /** Delete tool click: Paint deletes the whole piece (Alt: one segment); Route deletes the stretch between two clicks. */
    traceDeleteClick(hit, ev = {}) {
      const t = this.trace;
      if (hit.type === 'bridge') { this.traceDelete(new Set(), new Set([hit.id])); return; }
      if (t.clickMode === 'route') {
        if (t.anchor == null || t.anchor === hit.id) { t.anchor = hit.id; this.ui.refreshTraceSelection(); this.requestRender(); return; }
        const r = this.tracer.route(t, t.anchor, hit.id), a0 = t.anchor;
        t.anchor = null;
        this.traceDelete(new Set(r ? r.edges.filter((i) => i === a0 || i === hit.id || edgeShown(t, i)) : [hit.id]));
        if (!r) this.toast('No path along the trace between those clicks — deleted only the segment clicked last. Ctrl+Z restores it.');
        return;
      }
      const edges = ev.altKey || !t.edgeChain ? [hit.id] : t.edges.map((_, i) => i).filter((i) => t.edgeChain[i] === t.edgeChain[hit.id] && (i === hit.id || edgeShown(t, i)));
      this.traceDelete(new Set(edges));
    },
    /** Delete segments and/or links from the trace altogether (undoable). */
    traceDelete(dropE, dropB = new Set()) {
      const t = this.trace;
      if (!t || (!dropE.size && !dropB.size)) return;
      this.traceSnapshot();
      let len = 0;
      for (const i of dropE) len += t.edges[i].length;
      deleteItems(t, dropE, dropB);
      const parts = [];
      if (dropE.size) parts.push(`${dropE.size} segment${dropE.size > 1 ? 's' : ''} (${fmtNum(len)} µm)`);
      if (dropB.size) parts.push(`${dropB.size} link${dropB.size > 1 ? 's' : ''}`);
      this.toast(`Deleted ${parts.join(' and ')} — Ctrl+Z restores`);
      this.traceChanged();
      this.requestRender();
    },
    /** Delete what is selected (Select mode). */
    traceDeleteSel() {
      const t = this.trace;
      if (!t || !t.sel) return this.toast('Select a segment or link first (Select mode), or pick the Delete tool and click');
      if (t.sel.type === 'edge') this.traceDelete(new Set([t.sel.id]));
      else this.traceDelete(new Set(), new Set([t.sel.id]));
    },
    /**
     * Called when Edit mode is switched on or off. Drops any half-made route, link or stroke. Leaving also drops
     * the selection; entering keeps a segment you were looking at (picked from the table), so you can change it.
     */
    traceEditOff() {
      const t = this.trace;
      const entering = this.tool === 'trace';
      if (t) { t.anchor = null; t.linkFrom = null; t.tip = null; if (!entering) t.sel = null; }
      this.traceStroke = null; this.traceHoverAt = null;
      // the chromosome highlighted in the labels layer by a selection would otherwise stay lit
      if (!entering && this.selectedLabel) { this.selectedLabel = 0; if (this.ui.labelSelected) this.ui.labelSelected(0); }
      this.requestRender();
    },
    /** Number key: choose the active chromosome (and, in Select mode, assign the selected segment). */
    traceDigit(k, shift, button = false) {
      const t = this.trace;
      if (!t) return;
      // While a trace is in progress (being drawn, or selected to extend), the number keys belong to its
      // suggestions and never switch the chromosome; they pick a chromosome again once it is finished (Esc).
      // The number buttons in the panel still renumber the trace in progress.
      const cur = this.tool === 'trace' && t.clickMode === 'trace' ? t.tip : null;
      if (cur && !button && k !== DEL) {
        if (k > 0 && this.traceSuggestAccept(k)) return;
        const s = this.traceSuggestions();
        this.toast(s ? `There is no suggestion ${k}: press ${s.list.length > 1 ? '1–' + s.list.length : '1'} to take ${s.list.length > 1 ? 'one' : 'it'}.`
          : 'A trace is in progress, so the number keys only take suggestions. To pick another chromosome, finish this trace first: Esc, Enter, a right-click or the Done button. (The number buttons in the panel renumber the trace in progress.)');
        return;
      }
      if (k === DEL && t.clickMode === 'select') { this.traceDeleteSel(); return; }
      if (k === DEL) { // Delete key outside Select mode: the Erase tool
        t.clickMode = 'erase'; t.anchor = null; t.linkFrom = null; t.tip = null; t.sel = null;
        this.toast('Erase: drag over a trace to erase that part, or click a trace to erase all of it');
        this.ui.refreshTrace(); this.requestRender();
        return;
      }
      if (t.clickMode === 'select' && t.sel && t.sel.type === 'edge') { this.traceAssign(k, shift); return; }
      const tip = t.clickMode === 'trace' ? t.tip : null;
      if (tip && (tip.kind === 'point' || (tip.kind === 'node' && tip.fresh)) && tip.k !== k) {
        // a number while drawing a new trace gives it that chromosome
        if (tip.kind === 'node') { this.traceSnapshot(); recolour(t, tip.own, tip.k, k); }
        tip.k = k; t.active = k;
        this.selectedLabel = k;
        if (tip.kind === 'node') { this.traceReveal(k); this.traceChanged(); } else this.ui.refreshTrace();
        this.requestRender();
        return;
      }
      t.active = k; t.anchor = null; t.linkFrom = null;
      this.ui.refreshTrace();
      this.requestRender();
    },
    traceAssign(k, shared) {
      const t = this.trace;
      if (!t || !t.sel) return this.toast('Click a traced segment first (Edit traces mode)');
      if (t.sel.type !== 'edge') return this.toast('Select a segment (not a gap) to assign it');
      this.traceSnapshot();
      const i = t.sel.id;
      if (k === 0) { t.edgeChrom[i] = 0; t.edgeChrom2[i] = 0; }
      else if (shared || t.shared) t.edgeChrom2[i] = t.edgeChrom2[i] === k ? 0 : k;
      else t.edgeChrom[i] = k;
      if (t.edgeChrom2[i] === t.edgeChrom[i]) t.edgeChrom2[i] = 0;
      this.selectedLabel = t.edgeChrom[i];
      this.traceReveal(k);
      this.traceChanged();
    },
    traceClear(k) {
      const t = this.trace;
      if (!t) return;
      this.traceSnapshot();
      for (let i = 0; i < t.edgeChrom.length; i++) {
        if (k == null || t.edgeChrom[i] === k) t.edgeChrom[i] = 0;
        if (k == null || t.edgeChrom2[i] === k) t.edgeChrom2[i] = 0;
      }
      t.anchor = null;
      this.traceChanged();
    },
    traceToggleBridge() {
      const t = this.trace;
      if (!t || !t.sel || t.sel.type !== 'bridge') return this.toast('Select a gap bridge (dashed line) first');
      this.traceSnapshot();
      const b = t.bridges[t.sel.id];
      b.on = b.on === false;
      this.traceChanged();
    },
    traceRenumber() {
      const t = this.trace;
      if (!t) return;
      this.traceSnapshot();
      const rows = this.traceSummary().rows.filter((r) => r.nSeg).sort((a, b) => b.length - a.length);
      const map = new Map(rows.map((r, i) => [r.id, i + 1]));
      for (let i = 0; i < t.edgeChrom.length; i++) { t.edgeChrom[i] = map.get(t.edgeChrom[i]) || 0; t.edgeChrom2[i] = map.get(t.edgeChrom2[i]) || 0; }
      this.traceChanged();
    },
    traceChanged() {
      const t = this.trace;
      this.traceSummary();
      const L = t.labelsLayer, M = t.maskLayer;
      if (L && M && this.layers.includes(L) && M.data && M.data.length === L.data.length) {
        const ctx = this.proc.makeCtx(this.dims, this.spacing);
        L.data = this.tracer.floodLabels(M.data, ctx, t.edges, t.edgeChrom);
        L.range = this.proc.minmax(L.data);
        L.hist = this.computeHist(L);
        L.version++;
        this.upload(L);
      }
      this.displayChanged(L);
      this.ui.refreshTrace();
      this.traceSuggestSoon();
    },
    /** Polylines for overlays: [{pts, color, width, dash}] */
    traceLines() {
      const t = this.trace;
      if (!t || !t.visible) return [];
      // half-made routes/links are only shown while editing; the selection also outside Edit mode (a segment
      // picked from the table to look at; leaving Edit mode clears selections made there)
      const editing = this.tool === 'trace', sel = t.sel;
      // Trace tool: the selected trace (to extend or join) is outlined like a selection
      const tipSet = editing && t.clickMode === 'trace' && t.tip && t.tip.kind === 'trace' ? new Set(t.tip.edges) : null;
      // drawing order: unassigned pieces underneath, chromosomes over them, the selection on top
      const low = [], high = [], top = [];
      t.edges.forEach((e, i) => {
        const k = t.edgeChrom[i], k2 = t.edgeChrom2[i];
        const s1 = isShown(t, k), s2 = k2 > 0 && isShown(t, k2);
        if (!s1 && !s2) return; // hidden
        const isSel = (sel && sel.type === 'edge' && sel.id === i) || (tipSet && tipSet.has(i));
        const out = isSel ? top : k || k2 ? high : low, w = k || !s1 ? W_CHROM : W_MUTED;
        if (isSel || (editing && (i === t.anchor || (t.linkFrom && t.linkFrom.id === i)))) out.push({ pts: e.pts, color: t.active === DEL && !isSel ? '#e5645a' : '#ffffff', width: w + 3.5 });
        if (s1) out.push({ pts: e.pts, color: k ? chromColor(k) : t.edgeChain ? chainColor(t.edgeChain[i]) : '#9aa0a6', width: isSel ? w + 0.5 : w });
        if (s2) out.push({ pts: e.pts, color: chromColor(k2), width: W_CHROM, dash: [3, 4] });
      });
      const atNode = chromsAtNodes(t);
      t.bridges.forEach((b, i) => {
        const [ka, kb] = bridgeChroms(t, b, atNode), c = ka && ka === kb ? ka : 0;
        if (!bridgeShown(t, ka, kb)) return;
        const isSel = sel && sel.type === 'bridge' && sel.id === i;
        const col = b.on === false ? '#e5645a' : c ? chromColor(c) : !ka && !kb && t.edgeChain ? chainColor(t.edgeChain[b.ea]) : '#9aa0a6';
        (isSel ? top : c ? high : low).push({ pts: [b.pa, b.pb], color: isSel ? '#ffffff' : col, width: isSel ? 3.5 : (c ? 2.2 : 1.5) + (b.user ? 0.5 : 0),
          dash: b.user ? [9, 3] : b.forced ? [2, 3] : b.linked || b.bright ? [6, 3, 1.5, 3] : [5, 4] });
      });
      // suggestions for the trace being drawn (keys 1–3): the part a key press takes is dashed and bold; the rest
      // of the way the automatic trace goes on (Shift+scroll reaches into it) is thin and faint
      const sg = this.traceSuggestions();
      if (sg) for (let i = sg.list.length - 1; i >= 0; i--) {
        const g = sg.list[i], take = cutAt(g.pts, g.end), rest = cutAt(g.pts.slice().reverse(), Math.max(0, g.full - g.end)).reverse();
        if (g.full - g.end > 0.05) top.push({ pts: rest, color: SUGGEST_COLORS[i], width: 1.2, dash: [2, 4], alpha: 0.6 });
        top.push({ pts: take, color: '#000000', width: 4.6, alpha: 0.55 });
        top.push({ pts: take, color: SUGGEST_COLORS[i], width: 2.6, dash: [7, 4] });
      }
      return low.concat(high, top);
    },
    traceEnds() {
      const t = this.trace;
      if (!t || !t.visible || !t.summary) return [];
      const out = [];
      for (const r of t.summary.rows) if (isShown(t, r.id)) for (const n of r.ends) if (t.nodes[n]) out.push({ p: t.nodes[n], color: chromColor(r.id) });
      if (this.tool === 'trace' && t.linkFrom && t.linkFrom.p) out.push({ p: t.linkFrom.p, color: '#ffffff', big: true });
      // Trace tool: the ends of unassigned pieces too (small, grey), since a click near an end extends or joins
      if (this.tool === 'trace' && t.clickMode === 'trace' && isShown(t, 0)) {
        const deg = new Map(), un = (i) => i >= 0 && i < t.edges.length && !t.edgeChrom[i] && !t.edgeChrom2[i];
        const bump = (n) => deg.set(n, (deg.get(n) || 0) + 1);
        t.edges.forEach((e, i) => { if (un(i)) { bump(e.a); bump(e.b); } });
        const touched = new Set(deg.keys()); // links count as in traceOf (hand links: both nodes on unassigned segments)
        for (const b of t.bridges) if (b.on !== false && (b.user ? touched.has(b.a) && touched.has(b.b) : un(b.ea) && un(b.eb))) { bump(b.a); bump(b.b); }
        for (const [n, d] of deg) if (d !== 2 && t.nodes[n]) out.push({ p: t.nodes[n], color: '#9aa0a6', small: true });
      }
      // Trace tool: where the next stretch starts (the selected trace's ends, the last point, or the start point)
      const tp = this.tool === 'trace' && t.clickMode === 'trace' ? t.tip : null;
      if (tp) {
        const pts = tp.kind === 'trace' ? tp.ends.map((n) => t.nodes[n]) : [tp.kind === 'node' ? t.nodes[tp.node] : tp.p];
        for (const p of pts) if (p) out.push({ p, color: '#ffffff', big: true });
      }
      // the suggestions' numbers, at their ends
      const sg = this.traceSuggestions();
      if (sg) sg.list.forEach((g, i) => { const e = cutAt(g.pts, g.end); out.push({ p: e[e.length - 1], color: SUGGEST_COLORS[i], label: String(i + 1) }); });
      return out;
    },
    /** The segment or link under a click. Hidden ones cannot be hit (nothing can while all traces are hidden). */
    traceHit(proj, x, y) {
      const t = this.trace;
      if (!t) return null;
      if (!t.visible) { if (this.tool === 'trace') this.toast('Traces are hidden — press T (or tick Show traces) to see and click them'); return null; }
      if (!t.hidden || !t.hidden.size) return this.tracer.hitTest(t, proj, x, y, 9);
      const atNode = chromsAtNodes(t);
      return this.tracer.hitTest(t, proj, x, y, 9, (i) => edgeShown(t, i), (i) => bridgeShown(t, ...bridgeChroms(t, t.bridges[i], atNode)));
    },
    /** Show or hide one chromosome (0 = the unassigned pieces): its lines, ends and colour in the labels layer. */
    traceSetShown(k, on) {
      const t = this.trace;
      if (!t) return;
      if (!t.hidden) t.hidden = new Set();
      if (on) t.hidden.delete(k); else t.hidden.add(k);
      if (!on && t.sel && ((t.sel.type === 'edge' && !edgeShown(t, t.sel.id)) || t.sel.type === 'bridge')) t.sel = null;
      this.traceVisChanged();
    },
    /** Show only chromosome k (k = null: show everything). */
    traceShowOnly(k) {
      const t = this.trace;
      if (!t) return;
      t.visible = true;
      t.hidden = new Set();
      if (k != null) {
        for (const r of t.summary ? t.summary.rows : []) if (r.id !== k) t.hidden.add(r.id);
        for (let c = 1; c <= t.n; c++) if (c !== k) t.hidden.add(c);
        t.hidden.add(0);
        t.sel = null;
      }
      this.traceVisChanged();
    },
    traceToggleVisible() {
      const t = this.trace;
      if (!t) return;
      t.visible = !t.visible;
      this.traceVisChanged();
      this.toast(t.visible ? 'Traces shown' : 'Traces hidden — press T to show them again');
    },
    /**
     * An edit for chromosome k (0 = unassigning) makes sure you can see its result: it shows the traces
     * and that chromosome. Returns true when that changed what is shown (callers then redraw).
     */
    traceReveal(k) {
      const t = this.trace;
      if (!t) return false;
      const was = t.visible && !(t.hidden && t.hidden.has(k));
      t.visible = true;
      if (t.hidden && k >= 0) t.hidden.delete(k);
      return !was;
    },
    traceVisChanged() {
      this.displayVersion++; // slice views cache their image layers; the labels layer follows the hidden set
      this.ui.refreshTrace();
      this.requestRender();
    },
    /** Hidden chromosomes as a bit mask (bit k−1 for chromosome k ≤ 32) for the 3D labels layer. */
    traceHideMask(L) {
      const t = this.trace;
      if (!t || !t.hidden || !t.hidden.size || t.labelsLayer !== L) return 0;
      let m = 0;
      for (const k of t.hidden) if (k >= 1 && k <= 32) m |= 1 << (k - 1);
      return m >>> 0;
    },
    /** Hidden chromosome numbers for drawing a labels layer on slices (null if none apply to it). */
    traceHiddenFor(L) {
      const t = this.trace;
      return t && t.hidden && t.hidden.size && t.labelsLayer === L ? t.hidden : null;
    },
  });

  // ------------------------------------------------------------------ drawing helpers
  /** Draw traces on a slice view. */
  window.drawTraceOverlay = function (view, ctx) {
    const app = view.app;
    if (!app.trace) return; // with traces hidden, lines and ends are empty but a Guide stroke is still drawn
    const [sx, sy, sz] = app.spacing, ax = view.axis, idx = view.index;
    const proj = isProjected(app, ax);
    const map = (p) => (ax === 'xy' ? [p[0] / sx, p[1] / sy, p[2] / sz] : ax === 'xz' ? [p[0] / sx, p[2] / sz, p[1] / sy] : [p[2] / sz, p[1] / sy, p[0] / sx]);
    const spD = ax === 'xy' ? sz : ax === 'xz' ? sy : sx;
    // Parts of a trace within ±depth µm of the plane are drawn solid; further away they fade to `floor`
    // over two more depths (and get thinner), so the slice's own tracks stand out.
    const depth = traceDepth(app), floor = 0.12;
    const alphaOf = (m) => {
      if (proj) return 1;
      const d = Math.abs(m[2] - idx) * spD;
      return d <= depth ? 1 : Math.max(floor, 1 - ((d - depth) / (2 * depth)) * (1 - floor));
    };
    const segs = [];
    for (const l of app.traceLines()) {
      // parts outside the clipping box are not drawn (as in 3D)
      let a = map(l.pts[0]), aa = alphaOf(a), ain = app.inClipBox(l.pts[0]);
      for (let i = 1; i < l.pts.length; i++) {
        const b = map(l.pts[i]), ab = alphaOf(b), bin = app.inClipBox(l.pts[i]);
        if (ain && bin) segs.push({ a, b, alpha: (aa + ab) / 2, l });
        a = b; aa = ab; ain = bin;
      }
    }
    segs.sort((p, q) => p.alpha - q.alpha); // faded parts underneath, in-plane parts on top
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of segs) {
      const l = s.l;
      ctx.globalAlpha = s.alpha * (l.alpha != null ? l.alpha : 1);
      ctx.strokeStyle = l.color; ctx.lineWidth = l.width * (s.alpha < 1 ? 0.55 + 0.45 * s.alpha : 1); ctx.setLineDash(l.dash || []);
      const [x0, y0] = view.toScreen(s.a[0] + 0.5, s.a[1] + 0.5), [x1, y1] = view.toScreen(s.b[0] + 0.5, s.b[1] + 0.5);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const e of app.traceEnds()) {
      if (!app.inClipBox(e.p)) continue;
      const a = map(e.p), [x, y] = view.toScreen(a[0] + 0.5, a[1] + 0.5), al = alphaOf(a);
      if (e.label) { drawNumberBadge(ctx, x, y, e.color, e.label, Math.max(0.6, al)); continue; }
      ctx.globalAlpha = e.small ? 0.8 * al : al;
      ctx.fillStyle = e.color; ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.arc(x, y, e.big ? 6.5 : e.small ? (al < 1 ? 2 : 3) : al < 1 ? 3 : 4.5, 0, 6.2832); ctx.fill(); ctx.stroke();
    }
    // guide stroke being painted: the band it will re-trace in, and its centre line
    // Trace tool: a dashed line from where the next stretch starts to the mouse
    const tp = app.trace.tip, hv = app.traceHoverAt;
    if (tp && hv && hv.view === view && app.tool === 'trace' && app.trace.clickMode === 'trace') {
      const [hx, hy] = view.toScreen(hv.u, hv.v);
      const starts = tp.kind === 'trace' ? tp.ends.map((n) => app.trace.nodes[n]) : [tp.kind === 'node' ? app.trace.nodes[tp.node] : tp.p];
      let best = null;
      for (const p of starts) {
        if (!p) continue;
        const a = map(p), [x, y] = view.toScreen(a[0] + 0.5, a[1] + 0.5), d = Math.hypot(x - hx, y - hy);
        if (!best || d < best.d) best = { x, y, d };
      }
      if (best) {
        ctx.globalAlpha = 0.85; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(best.x, best.y); ctx.lineTo(hx, hy); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    const st = app.traceStroke;
    if (st && st.view === view && st.pts.length > 1) {
      const sc = st.pts.map(([u, v]) => view.toScreen(u, v));
      const line = () => { ctx.beginPath(); sc.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); };
      ctx.globalAlpha = 0.3; ctx.strokeStyle = st.erase ? toolColor(DEL) : toolColor(app.trace.active);
      ctx.lineWidth = Math.max(4, 2 * st.R * view.zoom); line();
      ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.setLineDash([4, 3]); line(); ctx.setLineDash([]);
    }
    // Trace tool: what the keys do now, along the bottom of the XY view
    const hint = ax === 'xy' && app.traceHint ? app.traceHint() : '';
    if (hint) {
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      ctx.font = '12px Segoe UI, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      const W = view.host.clientWidth, H = view.host.clientHeight, pad = 7;
      let txt = hint;
      while (txt.length > 20 && ctx.measureText(txt).width > W - 24) txt = txt.slice(0, -2);
      if (txt !== hint) txt = txt.slice(0, -1) + '…';
      const w = ctx.measureText(txt).width + 2 * pad;
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(8, H - 32, w, 22);
      ctx.fillStyle = '#ffffff'; ctx.fillText(txt, 8 + pad, H - 21);
    }
    ctx.restore();
  };
  /** The XY panel shows a max projection only in the single-slice view (Ortho always shows planes). */
  window.isProjected = (app, axis) => axis === 'xy' && app.projectXY && app.view === 'xy';
  /** Half-thickness (µm) of the slab around a slice whose traces are drawn solid. */
  window.traceDepth = (app) => (app.traceDepth > 0 ? app.traceDepth : 0.15);
  /** Screen projector for hit-testing on a slice view (only nearby parts unless projecting). */
  window.traceProjector = function (view) {
    const app = view.app, [sx, sy, sz] = app.spacing, ax = view.axis, idx = view.index;
    const proj = isProjected(app, ax);
    const spD = ax === 'xy' ? sz : ax === 'xz' ? sy : sx;
    const reach = Math.max(0.3, 3 * traceDepth(app)); // only clearly visible parts are clickable
    return (p) => {
      const m = ax === 'xy' ? [p[0] / sx, p[1] / sy, p[2] / sz] : ax === 'xz' ? [p[0] / sx, p[2] / sz, p[1] / sy] : [p[2] / sz, p[1] / sy, p[0] / sx];
      if (!proj && Math.abs(m[2] - idx) * spD > reach) return null;
      if (!app.inClipBox(p)) return null;   // hidden outside the clipping box, so not clickable
      return view.toScreen(m[0] + 0.5, m[1] + 0.5);
    };
  };

  // ------------------------------------------------------------------ UI panel
  Object.assign(UI.prototype, {
    buildTraceSection() {
      const app = this.app;
      this.anaForms.trace = new OpForm(this, ANALYSIS_DEFS.trace, { noDesc: true, applyLabel: 'Trace chromosomes', onApply: (inp, p) => app.runTrace(inp, p) });
      this.traceRes = h('div', { class: 'result' });
      return h('details', { class: 'section', open: true }, h('summary', null, 'Chromosome tracing (SC / filaments)'),
        h('p', { class: 'desc' }, 'Separates N tangled tracks such as synaptonemal complexes (ZYP1, SYCP1) at pachytene. Give it the raw image: it builds a ridge mask, skeletonises it and joins the pieces through crossings and gaps. Sparse nuclei are separated automatically; for dense ones it finds the confident track pieces and you assemble them with Paint or Route.'),
        this.anaForms.trace.el,
        h('div', { class: 'btns' }, this.traceHandBtn = h('button', {
          title: 'Go straight into Edit mode without waiting for the automatic trace: draw chromosomes with Guide on the chosen input image. You can run the automatic trace at the same time or later; your hand-drawn segments are kept and its pieces are added unassigned.',
          onclick: () => app.traceStartManual(),
        }, '✎ Edit by hand now'), h('button', {
          title: 'Load paths traced in Fiji SNT (or exported from here) on this image — e.g. a ground truth. Paths named "Chr 1", "Chr 2"… become those chromosomes.',
          onclick: () => {
            const inp = h('input', { type: 'file', accept: '.traces,.xml' });
            inp.addEventListener('change', () => { if (inp.files[0]) app.importTraces(inp.files[0]); });
            inp.click();
          },
        }, 'Import .traces (SNT)…')),
        this.traceRes);
    },
    refreshTrace() {
      const app = this.app, t = app.trace, host = this.traceRes;
      if (!host) return;
      host.innerHTML = '';
      if (this.traceHandBtn) this.traceHandBtn.style.display = t ? 'none' : '';
      if (!t) return;
      const S = t.summary || app.traceSummary();
      const rows = S.rows.filter((r) => r.nSeg || r.id <= t.n);
      const found = rows.filter((r) => r.nSeg).length;
      const issues = rows.filter((r) => r.status !== 'ok');
      const forced = t.bridges.filter((b) => b.forced && b.on !== false).length;
      host.append(h('div', { class: 'stats' },
        stat('Chromosomes', found + ' / ' + t.n, issues.length ? issues.length + ' need checking' : 'all single paths'),
        stat('Assigned SC length', fmtNum(S.total) + ' µm', 'mean ' + fmtNum(S.total / Math.max(1, found)) + ' µm'),
        stat('Unassigned', fmtNum(S.unassigned) + ' µm', t.mode === 'exact' ? 'skeleton not in any track' : t.mode === 'imported' ? 'paths without a chromosome' : t.mode === 'manual' ? 'drawn segments without a chromosome' : t.nChains + ' confident pieces in total'),
        t.mode === 'imported'
          ? stat('Imported', t.nPaths + ' path' + (t.nPaths === 1 ? '' : 's'), t.source)
          : t.mode === 'manual'
            ? stat('Drawn by hand', t.edges.length + ' segment' + (t.edges.length === 1 ? '' : 's'), 'on ' + (t.source || 'the image'))
            : stat('Track width', fmtNum(t.params.width) + ' µm', 'gaps ≤ ' + fmtNum(t.params.maxGap) + ' µm bridged' + (t.bridges.some((b) => b.linked) ? ', ' + t.bridges.filter((b) => b.linked).length + ' longer along faint ridges' : '') + (t.bridges.some((b) => b.bright) ? ', ' + t.bridges.filter((b) => b.bright).length + ' where the image stays bright' : '') +
            (t.bridges.some((b) => b.user && b.on !== false) ? ', ' + t.bridges.filter((b) => b.user && b.on !== false).length + ' linked by hand' : ''))));
      if (t.mode === 'imported') {
        host.append(h('div', { class: 'infobox' }, t.named
          ? `Imported from ${t.source}. Paths were numbered by their names (e.g. "Chr 2" → chromosome 2); paths without a chromosome name are unassigned (muted). Edit as usual with Paint, Route or Select.`
          : `Imported from ${t.source}. No path is named after a chromosome, so each SNT path tree became its own chromosome. Merge them with Paint (pick a number, click a path), or name the paths "Chr 1", "Chr 2"… in SNT before importing.`));
      } else if (t.mode === 'manual') {
        host.append(h('div', { class: 'infobox' }, `Tracing by hand, no automatic trace yet. Pick a chromosome number and click points along it with Trace; the stretch between clicks follows the image. Click a trace first to extend it, or click two traces to join them. You can start the automatic trace above at any time (also while you draw): when it finishes, your drawn segments are kept and its pieces are added unassigned for you to paint.`));
      } else if (t.mode !== 'exact') {
        host.append(h('div', { class: 'infobox' }, `Dense nucleus: too many contacts to separate all ${t.n} chromosomes automatically with confidence, so nothing was forced. The ${t.n} longest confident tracks are numbered as a start; the other pieces are shown in muted colours. Join pieces with Trace (click one piece, then the next: they are joined along the image and take the first one's number), trace missing stretches by clicking points, cut wrong joins with Erase, or number whole pieces with Paint.`));
      }
      const warn = [...(t.warnings || []), ...issues.filter((r) => r.nSeg || t.mode === 'exact').map((r) => `Chromosome ${r.id}: ${r.status === 'empty' ? 'no segments' : r.status}${r.nEnds !== 2 && r.status !== 'empty' ? ' (' + r.nEnds + ' ends)' : ''}`)];
      if (forced) warn.push(`${forced} long or sharply bent gap bridge${forced > 1 ? 's were' : ' was'} needed (dotted) — worth checking`);
      if (warn.length) host.append(h('div', { class: 'warnbox' }, warn.map((w) => h('div', null, w))));
      if (t.version !== app.tracer.VERSION) host.append(h('div', { class: 'warnbox' }, 'The tracing engine is out of date: close and reopen the app (or press Ctrl+R), then trace again.'));
      host.append(h('div', { style: { fontSize: '11px', opacity: 0.6, margin: '2px 0 6px' } }, 'Tracer ' + (t.version || 'unknown (old build)')));
      const tbody = h('tbody');
      // show/hide tick per chromosome (and for the unassigned pieces); a click on it does not select the row
      const eye = (k, what) => h('td', { class: 'eye' }, h('input', {
        type: 'checkbox', checked: isShown(t, k), title: 'Show ' + what + ' in all views (lines, ends' + (k ? ' and its colour in the Chromosomes layer' : '') + ')',
        onclick: (ev) => ev.stopPropagation(), onchange: (ev) => app.traceSetShown(k, ev.target.checked),
      }));
      // Segs cell: a dropdown of that chromosome's segments in order along it (pieces longest first; unassigned
      // pieces longest first). Picking one highlights it and brings it into view, without changing the mode.
      this.segSelects = new Map();
      const segCell = (k) => {
        const pieces = segmentOrder(t, k).filter((p) => p.length), n = pieces.reduce((s, p) => s + p.length, 0);
        const sel = h('select', {
          class: 'segmenu', title: (k ? `Segments of chromosome ${k} in order along it` : 'Unassigned segments, longest first') + ': place, segment #, length, depth range. Picking one highlights it and brings it into view (the mode stays as it is). [ and ] step to the previous / next one; Esc clears the highlight.',
          onclick: (ev) => ev.stopPropagation(),
          onchange: (ev) => { const v = ev.target.value; ev.target.value = ''; ev.target.blur(); if (v === 'none') app.traceUnselect(); else if (v !== '') app.traceSelectSegment(+v, k); },
        }, h('option', { value: '' }, String(n)));
        let num = 0;
        pieces.forEach((p, pi) => {
          const len = p.reduce((s, i) => s + t.edges[i].length, 0);
          const into = pieces.length > 1 ? h('optgroup', { label: `Piece ${pi + 1} of ${pieces.length} · ${fmtNum(len)} µm` }) : sel;
          for (const i of p) {
            const e = t.edges[i];
            let z0 = Infinity, z1 = -Infinity;
            for (const q of e.pts) { if (q[2] < z0) z0 = q[2]; if (q[2] > z1) z1 = q[2]; }
            const other = k ? (t.edgeChrom[i] === k ? t.edgeChrom2[i] : t.edgeChrom[i]) : 0;
            const label = `${++num}.  #${i + 1} · ${fmtNum(e.length)} µm · z ${z0.toFixed(1)}–${z1.toFixed(1)} µm` + (other ? ` · shared with ${other}` : '') + (e.guided ? ' · drawn' : '');
            into.append(h('option', { value: i, 'data-text': label }, label));
          }
          if (into !== sel) sel.append(into);
        });
        sel.disabled = !n;
        this.segSelects.set(k, { sel, list: pieces.flat() });
        return h('td', { class: 'segs' }, sel);
      };
      rows.forEach((r) => {
        const tr = h('tr', { 'data-label': r.id, class: (r.id === app.selectedLabel ? 'sel' : '') + (isShown(t, r.id) ? '' : ' hid') || null },
          eye(r.id, 'chromosome ' + r.id),
          h('td', null, h('span', { class: 'swatch', style: { background: chromColor(r.id), width: '14px' } })),
          h('td', null, String(r.id)), h('td', null, fmtNum(r.length)), h('td', null, (r.rel * 100).toFixed(1)),
          segCell(r.id), h('td', null, r.nGap ? r.nGap + ' (' + fmtNum(r.gapLen) + ')' : '0'),
          h('td', null, String(r.nEnds)), h('td', { class: r.status === 'ok' ? 'ok' : 'bad' }, r.status));
        tr.addEventListener('click', () => { app.selectedLabel = r.id; t.active = r.id; t.anchor = null; this.segChrom = r.id; this.refreshTrace(); app.requestRender(); });
        tbody.append(tr);
      });
      const nUn = t.edges.reduce((s, e, i) => s + (!t.edgeChrom[i] && !t.edgeChrom2[i] ? 1 : 0), 0);
      if (nUn) {
        tbody.append(h('tr', { class: 'unrow' + (isShown(t, 0) ? '' : ' hid'), title: 'Pieces not assigned to any chromosome (muted colours)' },
          eye(0, 'the unassigned pieces'),
          h('td', null, h('span', { class: 'swatch', style: { background: '#9aa0a6', width: '14px' } })),
          h('td', { style: { textAlign: 'left' } }, 'none'), h('td', null, fmtNum(S.unassigned)), h('td', null, ''), segCell(0), h('td', null, ''), h('td', null, ''), h('td', null, '')));
      }
      const eyeHead = h('th', { title: 'Show / hide' }, '👁');
      host.append(h('div', { class: 'tablewrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, eyeHead, ['', '#', 'Length µm', '%', 'Segs', 'Gaps (µm)', 'Ends', 'Status'].map((c) => h('th', c === 'Segs' ? { title: 'Number of segments; click it for a list of them to look at one by one' } : null, c)))), tbody)));
      this.segInfo = h('p', { class: 'muted small seginfo' });
      host.append(this.segInfo);
      const nHid = t.hidden ? t.hidden.size : 0, solo = t.active > 0 ? t.active : 0;
      host.append(
        check('Show traces (key T)', t.visible, (v) => { t.visible = v; app.traceVisChanged(); }, 'Hide or show all trace lines at once, e.g. to look at the image underneath. The ticks in the table hide single chromosomes, or the unassigned pieces.'),
        h('div', { class: 'btns' },
          h('button', { disabled: (!nHid && t.visible) || null, title: 'Show every chromosome and the unassigned pieces', onclick: () => app.traceShowOnly(null) }, 'Show all'),
          h('button', { disabled: !solo || null, title: 'Hide everything except the active chromosome (pick it with its number key or by clicking its row)', onclick: () => app.traceShowOnly(solo) }, 'Show only ' + (solo ? 'chromosome ' + solo : 'the active chromosome')),
          h('button', { disabled: !nUn || null, title: 'Hide or show the pieces not assigned to any chromosome', onclick: () => app.traceSetShown(0, !isShown(t, 0)) }, isShown(t, 0) ? 'Hide unassigned' : 'Show unassigned')));
      if (nHid && t.visible) {
        const hk = [...t.hidden].filter((k) => k > 0).sort((a, b) => a - b), parts = [];
        if (hk.length) parts.push((hk.length > 1 ? 'chromosomes ' + hk.slice(0, -1).join(', ') + ' and ' : 'chromosome ') + hk[hk.length - 1]);
        if (t.hidden.has(0)) parts.push('the unassigned pieces');
        host.append(h('p', { class: 'muted small' }, 'Hidden: ' + parts.join(', and ') + '. Hidden parts cannot be clicked or changed by strokes; editing a chromosome shows it again.'));
      }
      // editing
      const editBtn = h('button', { class: 'wide' + (app.tool === 'trace' ? ' on' : ''), onclick: () => this.toggleTraceEdit() }, app.tool === 'trace' ? 'Editing — click tracks in any view (Esc to stop)' : '✎ Edit traces');
      const pickMode = (m) => {
        t.clickMode = m; t.anchor = null; t.linkFrom = null; t.tip = null; app.traceHoverAt = null;
        if (m !== 'select') t.sel = null;
        if ((m === 'guide' || m === 'trace' || m === 'erase') && app.view === '3d' && app.tool === 'trace') app.setView('xy');
        this.refreshTrace(); app.requestRender();
      };
      const modeBtn = ([m, l, tip]) => h('button', { class: t.clickMode === m ? 'on' : null, title: tip, onclick: () => pickMode(m) }, l);
      const modeSeg = h('div', { class: 'seg grid4' }, MODES.map(modeBtn));
      const older = MORE_MODES.some(([m]) => m === t.clickMode);
      const moreModes = h('details', { class: 'moretools', open: older || null },
        h('summary', null, 'More tools' + (older ? ' — ' + MODE_NAME[t.clickMode] + ' in use' : '')),
        h('div', { class: 'seg grid3' }, MORE_MODES.map(modeBtn)));
      const nKeys = Math.max(t.n, found);
      const tp = t.clickMode === 'trace' ? t.tip : null;
      const keyOn = (k) => (t.clickMode === 'select' ? false : tp && tp.kind !== 'trace' && (tp.kind === 'point' || tp.fresh) ? tp.k === k : t.active === k);
      const keys = h('div', { class: 'btns chrom-keys' },
        Array.from({ length: nKeys + 1 }, (_, i) => i + 1).map((k) => h('button', { class: keyOn(k) ? 'on' : null, title: (t.clickMode === 'select' ? 'Assign the selected segment to chromosome ' : t.clickMode === 'trace' ? 'New traces get chromosome ' : 'Active chromosome ') + k + (k <= 9 ? ' (key ' + k + ')' : ''), style: { borderColor: chromColor(k) }, onclick: () => app.traceDigit(k, false, true) }, String(k))),
        h('button', { class: keyOn(0) ? 'on' : null, title: (t.clickMode === 'select' ? 'Unassign the selected segment' : t.clickMode === 'trace' ? 'New traces get no chromosome (muted)' : 'Unassign tool: clicks take segments off their chromosome') + ' (key 0). Unassigned segments stay in the trace, muted, and can be painted again; they are left out of lengths and exports.', onclick: () => app.traceDigit(0, false, true) }, 'Unassign'),
        t.clickMode === 'select' ? h('button', { class: 'danger', title: 'Delete the selected segment or link from the trace (key Delete). Ctrl+Z restores it.', style: { borderColor: '#e5645a' }, onclick: () => app.traceDigit(DEL) }, 'Delete') : null);
      const shared = t.clickMode === 'paint' || t.clickMode === 'route' || t.clickMode === 'select' ? check('Add as shared segment (two chromosomes lie together)', t.shared, (v) => { t.shared = v; }, 'Same as Shift+click / Shift+digit') : null;
      this.traceSelInfo = h('p', { class: 'muted small' });
      const keyLabel = t.clickMode === 'select' ? 'Assign selected segment to' : t.clickMode === 'trace' ? (tp && tp.kind === 'node' && tp.fresh ? 'This trace is chromosome' : 'New traces get chromosome') : 'Active chromosome';
      // the channel Trace and Guide follow (the ZYP1 channel): shown, and changeable, so a wrong default is visible
      let traceOn = null;
      if (t.clickMode === 'trace' || t.clickMode === 'guide') {
        const N = app.dims ? app.dims[0] * app.dims[1] * app.dims[2] : 0, cur = app.traceImage();
        const chans = app.layers.filter((L) => L.kind === 'intensity' && L.data && L.data.length === N);
        if (chans.length > 1 || !cur) {
          const sel = h('select', { title: 'The channel the path between clicks follows: pick the SC channel (ZYP1). It defaults to the channel traced automatically, or for "Edit by hand now" to the tracing form\'s input.',
            onchange: (ev) => { t.traceOn = chans[+ev.target.value] || null; app._pathCache = null; this.refreshTrace(); } },
          chans.map((L, i) => h('option', { value: i, selected: L === cur || null }, L.name)));
          traceOn = h('div', { class: 'row2' }, h('label', null, 'Trace on'), sel);
        }
      }
      // Trace: suggested ways on from the end of the trace being drawn (number keys take them)
      let suggestRow = null;
      if (t.clickMode === 'trace') {
        const lens = [0, 3, 5, 8, 12], cur = app.traceSuggestLen || 0;
        const sel = h('select', { title: 'While you trace, the way on is suggested as a dashed line wherever your trace runs along a chain of an automatic trace of the image (inside the clipping box, if one is set) (made in the background if you have not run Trace chromosomes). Press 1 to take it; Shift+scroll moves where it stops; or click on it where you want to stop. A suggestion stops where the automatic tracer was unsure; this sets the most it takes by default.',
          onchange: (ev) => { app.traceSuggestLen = +ev.target.value; ev.target.blur(); if (t.sugg) t.sugg = null; app.traceSuggestSoon(); app.requestRender(); this.refreshTraceSelection(); } },
        lens.map((v) => h('option', { value: v, selected: v === cur || (!lens.includes(cur) && v === 5) || null }, v ? 'up to ' + fmtNum(v) + ' µm' : 'Off')));
        suggestRow = h('div', { class: 'row2' }, h('label', null, 'Suggestions'), sel);
      }
      // finishing the trace in progress, so that the next click (or number) starts a new one
      this.traceDoneBtn = h('button', { class: 'wide', style: { display: 'none' }, title: 'Finish the trace in progress (Esc, Enter or a right-click do the same). Then the number keys pick a chromosome again and the next click starts a new trace.', onclick: () => app.traceFinish() }, '✓ Done with this trace (Esc)');
      host.append(h('h2', null, 'Assemble & correct'), editBtn,
        h('label', { class: 'sub' }, 'Click action'), modeSeg, moreModes, ...(traceOn ? [traceOn] : []), ...(suggestRow ? [suggestRow] : []),
        h('label', { class: 'sub' }, keyLabel), keys, this.traceSelInfo, this.traceDoneBtn, ...(shared ? [shared] : []),
        h('div', { class: 'btns' },
          h('button', { onclick: () => app.traceToggleBridge(), title: 'Turn the selected gap bridge on or off (key B)' }, 'Gap on/off'),
          h('button', { onclick: () => app.traceUndo(), title: 'Ctrl+Z' }, 'Undo'),
          h('button', { onclick: () => app.traceRenumber(), title: 'Number chromosomes 1…N from longest to shortest' }, 'Renumber by length')),
        h('div', { class: 'btns' },
          h('button', { disabled: !(t.active > 0) || null, onclick: () => { if (t.active > 0) app.traceClear(t.active); }, title: 'Unassign every segment of the active chromosome (the segments stay, muted)' }, 'Clear chromosome ' + (t.active > 0 ? t.active : '')),
          h('button', { onclick: () => { if (confirm('Unassign all segments from all chromosomes?')) app.traceClear(null); } }, 'Unassign all')),
        sliderRow({ label: 'Solid within ± µm', min: 0.05, max: 1.5, log: true, step: 0.01, value: traceDepth(app), hint: 'On slice views (Slice without max projection, and Ortho), trace parts within this distance of the plane are drawn solid; parts further away fade out.', onInput: (v) => { app.traceDepth = v; app.requestRender('2d'); } }).el,
        h('div', { class: 'btns' },
          h('button', { onclick: () => this.exportTraceLengths() }, 'Lengths CSV'),
          h('button', { onclick: () => this.exportTraceCoords() }, 'Trace coordinates CSV')),
        h('div', { class: 'btns' },
          h('button', { onclick: () => app.exportTraces({ unassigned: !!this.sntUnassigned }), title: 'Save the traces as an SNT (Fiji) .traces file: one path per chromosome, named "Chromosome N"' }, 'Export .traces (SNT)')),
        check('Include unassigned pieces in .traces', !!this.sntUnassigned, (v) => { this.sntUnassigned = v; }, 'Also save the pieces not assigned to a chromosome, as paths named "Unassigned piece N"'),
        h('p', { class: 'muted small' }, `Tip: Trace follows the image between clicks; where chromosomes are crowded, click every 2–3 µm and at sharp turns (clicks further apart may cut across to a neighbouring track: Ctrl+Z and click a point in between). On a single slice a click snaps to the track within ±0.2 µm of the slice; on the max projection it takes the brightest depth. Edit mode from 3D shows an XY max projection; switch to Ortho or 3D to check crossings in depth. Unassign (0) takes segments off their chromosome but keeps them in the trace (muted); Erase removes them from the trace altogether.` +
          (t.mode === 'imported' || t.mode === 'manual' ? '' : ` Settings used: max bend ${Math.round(t.params.maxBend * 180 / Math.PI)}°, max gap ${fmtNum(t.params.maxGap)} µm, pieces under ${fmtNum(t.params.minLen)} µm ignored` +
            (t.deconv && t.deconv.sigma ? `; sharpened along Z first (axial σ ${fmtNum(t.deconv.sigma)} µm, ${t.deconv.how}).` : t.deconv && t.deconv.skipped ? `; Z sharpening skipped (${t.deconv.skipped}).` : '; no Z sharpening.'))));
      this.refreshTraceSelection();
    },
    /** Segment ids of the chromosome that [ and ] step along (the row whose dropdown was used), in list order. */
    segListOrder() {
      const t = this.app.trace;
      return t && this.segChrom != null ? segmentOrder(t, this.segChrom).flat() : [];
    },
    /**
     * Mark the shown segment in the table's Segs dropdowns ("4/11" in its row) and in the line under the table.
     * The stepping list follows a newly selected segment to its chromosome, otherwise stays on the row you used.
     */
    syncSegMenus() {
      const app = this.app, t = app.trace;
      if (!t || !this.segSelects) return;
      const selId = t.sel && t.sel.type === 'edge' && t.edges[t.sel.id] ? t.sel.id : -1;
      const k1 = selId >= 0 ? t.edgeChrom[selId] : 0, k2 = selId >= 0 ? t.edgeChrom2[selId] : 0;
      const inList = (k) => (k ? k1 === k || k2 === k : !k1 && !k2);
      if (selId !== this.segSelSeen) {
        this.segSelSeen = selId;
        if (selId >= 0 && !inList(this.segChrom)) this.segChrom = k1 || k2 || 0;
      }
      for (const [k, { sel, list }] of this.segSelects) {
        const cur = list.indexOf(selId);
        sel.options[0].textContent = cur >= 0 ? `${cur + 1}/${list.length}` : String(list.length);
        sel.classList.toggle('on', cur >= 0);
        for (const o of sel.options) if (o.dataset.text) o.textContent = (+o.value === selId ? '▶ ' : '') + o.dataset.text;
        const clr = sel.querySelector('option[value="none"]');
        if (cur >= 0 && !clr) sel.options[0].after(h('option', { value: 'none' }, '✕  Clear the highlight (Esc)'));
        else if (cur < 0 && clr) clr.remove();
        sel.value = '';
        if (k === this.segChrom && cur >= 0) { this.segLastList = list; this.segLastChrom = k; }
      }
      if (this.segInfo) {
        const row = selId >= 0 && this.segSelects.get(inList(this.segChrom) ? this.segChrom : k1 || k2 || 0);
        const pos = row ? row.list.indexOf(selId) : -1;
        if (pos >= 0) {
          const e = t.edges[selId], k = inList(this.segChrom) ? this.segChrom : k1 || k2 || 0;
          let z0 = Infinity, z1 = -Infinity;
          for (const q of e.pts) { if (q[2] < z0) z0 = q[2]; if (q[2] > z1) z1 = q[2]; }
          this.segInfo.textContent = `Showing segment ${pos + 1} of ${row.list.length} ${k ? 'along chromosome ' + k : 'unassigned (longest first)'}: #${selId + 1}, ${fmtNum(e.length)} µm, z ${z0.toFixed(1)}–${z1.toFixed(1)} µm. [ and ] step to the previous / next one; Esc clears the highlight.`;
          this.segInfo.style.display = '';
        } else { this.segInfo.textContent = ''; this.segInfo.style.display = 'none'; }
      }
    },
    refreshTraceSelection() {
      const app = this.app, t = app.trace;
      if (!t || !this.traceSelInfo) return;
      this.syncSegMenus();
      const s = t.sel;
      if (this.traceDoneBtn) this.traceDoneBtn.style.display = app.tool === 'trace' && t.clickMode === 'trace' && t.tip ? '' : 'none';
      if (app.tool !== 'trace') { this.traceSelInfo.textContent = ''; return; }
      if (t.clickMode === 'trace') {
        const tp = t.tip, name = (k) => (k ? 'chromosome ' + k : 'unassigned');
        if (!tp) this.traceSelInfo.textContent = `Click along a chromosome to trace it (${name(Math.max(0, t.active))}); each click adds a stretch that follows the image (${(app.traceImage() || { name: '?' }).name}, see Trace on), also over existing traces. To extend or join a trace, click near one of its ends (the dots; Shift+click selects it anywhere along it), then a point to extend it, or another trace's end to join the two.` +
          (isProjected(app, 'xy') && app.view === 'xy' ? ' On the max projection the depth of each click is chosen by where the track continues; on a single slice clicks are a little more accurate (untick Max projection).' : '');
        else if (tp.kind === 'point') this.traceSelInfo.textContent = 'Start point set. Click the next point along the chromosome, or a trace to join it (Esc cancels).';
        else if (tp.kind === 'trace') this.traceSelInfo.textContent = `Trace selected (${name(tp.k)}, ends marked white). Click a point to extend it from its nearest end, or near another trace's end (Shift+click: anywhere on it) to join it on at the closest ends; it stays selected, so you can keep going. Esc, Enter or a right-click lets go.`;
        else {
          const len = tp.own.reduce((s2, i) => s2 + (t.edges[i] ? t.edges[i].length : 0), 0);
          this.traceSelInfo.textContent = `Tracing (${name(tp.k)}, ${fmtNum(len)} µm so far): click the next point, or another trace to join it. Esc, Enter, a right-click or a click on the last point finishes; Ctrl+Z takes back the last stretch.`;
        }
        if (tp) this.traceSelInfo.textContent += ' ' + app.traceSuggestInfo();
        return;
      }
      if (t.clickMode === 'erase') { this.traceSelInfo.textContent = 'Drag over a trace to erase that part (a trace erased in the middle becomes two); click a trace to erase all of it. The brush is 10 screen pixels wide each side: zoom in to erase finely. On a single slice only traces near the slice are erased. Shift+drag pans; Ctrl+Z restores.'; return; }
      if (t.active === DEL && t.clickMode !== 'select' && t.clickMode !== 'link' && !s) {
        this.traceSelInfo.textContent = t.clickMode === 'paint' ? 'Delete: click a track to remove the whole piece from the trace (Alt+click = one segment), or click a gap/link to remove it. Ctrl+Z restores.'
          : t.clickMode === 'route' ? (t.anchor != null ? 'Delete: now click the other end of the stretch to remove.' : 'Delete: click the start, then the end of a stretch to remove it from the trace.')
          : 'Delete: drag over segments to remove them from the trace (assigned or not). Shift+drag (or middle/right drag) pans.';
        return;
      }
      if (t.clickMode === 'route' && t.anchor != null) { this.traceSelInfo.textContent = `Routing for chromosome ${t.active}: click the next point along it (Esc ends the route).`; return; }
      if (t.clickMode === 'link' && t.linkFrom) { this.traceSelInfo.textContent = 'Now click the piece to join it to, near the end to use (Esc cancels).'; return; }
      if (t.clickMode === 'link' && !s) { this.traceSelInfo.textContent = 'Click near the end of a piece, then near the end of the piece it continues into. Any distance, any angle.'; return; }
      if (t.clickMode === 'guide' && !s) { this.traceSelInfo.textContent = t.active ? `Drag along the true course of chromosome ${t.active} in an XY view, starting and ending on its pieces. The shaded band is where it re-traces. ` +
        (isProjected(app, 'xy') && app.view === 'xy' ? 'On the max projection the depth comes from the image; untick Max projection to keep the trace on the slice you see. ' : `On a single slice the trace stays within about ±${fmtNum(Math.max(0.3, 3 * traceDepth(app)))} µm of it; draw a track that dives away on the slice where it continues. `) + 'Shift+drag (or middle/right drag) pans.' : 'Unassign: drag over segments to take them off their chromosomes (they stay in the trace, muted). Shift+drag (or middle/right drag) pans.'; return; }
      if (!s) { this.traceSelInfo.textContent = t.clickMode === 'select' ? 'Click a coloured segment or a dashed gap; then 1–9 assigns, 0 unassigns, Delete removes it.' : `Clicks go to ${t.active ? 'chromosome ' + t.active : 'Unassign (segments stay, muted)'}.`; return; }
      if (s.type === 'edge') {
        const e = t.edges[s.id], k = t.edgeChrom[s.id], k2 = t.edgeChrom2[s.id];
        this.traceSelInfo.textContent = `Segment ${s.id + 1}: ${fmtNum(e.length)} µm → ${k ? 'chromosome ' + k : 'unassigned'}${k2 ? ' + shared with ' + k2 : ''}.` + (t.clickMode === 'select' ? ' Press 1–9 to reassign, 0 to unassign, Delete to remove it from the trace.' : ' To change it with the number keys, switch Click action to Select.');
      } else {
        const b = t.bridges[s.id];
        this.traceSelInfo.textContent = `${b.user ? 'Hand-drawn link' : 'Gap bridge'}: ${fmtNum(b.length)} µm, ${b.on === false ? 'OFF' : 'on'}${b.forced ? ' (long/sharp)' : b.linked ? ' (longer gap, linked along a faint ridge)' : b.bright ? ' (linked: the image stays bright across the gap)' : ''}. Press B to toggle${t.clickMode === 'select' ? ', Delete to remove it' : ''}.`;
      }
    },
    toggleTraceEdit() {
      const app = this.app;
      app.tool = app.tool === 'trace' ? null : 'trace';
      app.traceEditOff();
      const box = $('#projXY');
      if (app.tool === 'trace' && app.view === '3d') {
        // edit from 3D: show all traces on an XY max projection, and remember to undo that on leaving
        if (!app.projectXY) this.traceProjAuto = true;
        app.projectXY = true; box.checked = true; app.displayVersion++; app.setView('xy');
      } else if (app.tool !== 'trace' && this.traceProjAuto) {
        // leaving Edit mode: back to single slices, unless max projection was switched off and on again by hand meanwhile
        this.traceProjAuto = false;
        if (app.projectXY) { app.projectXY = false; box.checked = false; app.displayVersion++; app.requestRender('2d'); }
      }
      this.syncTool();
      this.refreshTrace();
      app.requestRender();
    },
    exportTraceLengths() {
      const app = this.app, t = app.trace;
      if (!t) return;
      const rows = app.traceSummary().rows.filter((r) => r.nSeg);
      const cols = [['id', 'chromosome'], ['length', 'length_um'], [(r) => r.rel * 100, 'percent_of_total'], ['nSeg', 'segments'], ['nGap', 'gaps_bridged'], ['gapLen', 'gap_length_um'], ['nEnds', 'ends'], ['status', 'status'], ['meanI', 'mean_intensity'],
        [(r) => (r.ends[0] != null && t.nodes[r.ends[0]] ? t.nodes[r.ends[0]].map((v) => v.toFixed(3)).join(' ') : ''), 'end1_xyz_um'], [(r) => (r.ends[1] != null && t.nodes[r.ends[1]] ? t.nodes[r.ends[1]].map((v) => v.toFixed(3)).join(' ') : ''), 'end2_xyz_um']];
      download(new Blob([toCSV(rows, cols)], { type: 'text/csv' }), (app.vol ? app.vol.name : 'volume') + '_chromosome_lengths.csv');
    },
    exportTraceCoords() {
      const app = this.app, t = app.trace;
      if (!t) return;
      const rows = [];
      t.edges.forEach((e, i) => e.pts.forEach((p, j) => rows.push({ k: t.edgeChrom[i], k2: t.edgeChrom2[i], seg: i + 1, j, x: p[0], y: p[1], z: p[2] })));
      download(new Blob([toCSV(rows, [['k', 'chromosome'], ['k2', 'shared_with'], ['seg', 'segment'], ['j', 'point'], ['x', 'x_um'], ['y', 'y_um'], ['z', 'z_um']])], { type: 'text/csv' }), (app.vol ? app.vol.name : 'volume') + '_traces.csv');
    },
  });
})();
