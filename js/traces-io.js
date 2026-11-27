/* SynaptoSnap — import and export of SNT (Fiji "Simple Neurite Tracer") .traces files.
 *
 * A .traces file is XML, normally gzip-compressed: <tracings> holds <samplespacing> (voxel size and
 * unit), <imagesize> and one <path> per traced path. Each path is a list of <point>s with voxel
 * indices x, y, z (0-based) and calibrated coordinates xd, yd, zd. A path can start (or end) on
 * another path ("startson" + "startsindex"), which is how SNT stores branches.
 *
 * Chromosome numbers: a path named like "Chr 2", "chromosome2", "Bivalent 2", "SC2", "2" or tagged
 * "[chr2]" belongs to chromosome 2; paths named "Unassigned…" belong to none. If no path in the file
 * carries a chromosome name, each SNT tree (a path with its branches) becomes its own chromosome.
 */
(function () {
  const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const chromHex = (k) => { const c = Colormaps.labelColor(k); return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]); };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (v) => String(Math.round(v * 1e6) / 1e6);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const polyLen = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += dist(p[i], p[i - 1]); return s; };

  // ---------------------------------------------------------------- reading
  async function readText(file) { return (await readTextInfo(file)).text; }
  /** The XML of a .traces file, and whether the file was gzip-compressed (saving back keeps it that way). */
  async function readTextInfo(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return { text: await new Response(s).text(), gzip: true };
    }
    return { text: new TextDecoder().decode(buf), gzip: false };
  }
  /** Import button: the browser's file dialog with a handle on the file where there is one (Chrome / Edge). */
  async function pickTraces(app) {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({ types: [{ description: 'SNT traces (Fiji)', accept: { 'application/octet-stream': ['.traces', '.xml'] } }] });
        return app.importTraces(await handle.getFile(), handle);
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.traces,.xml';
    inp.addEventListener('change', () => { if (inp.files[0]) app.importTraces(inp.files[0]); });
    inp.click();
  }

  /** µm per file unit; null = uncalibrated (pixels). */
  function unitToUm(u, spacing) {
    const s = String(u || '').trim().toLowerCase().replace('μ', 'µ');
    if (!s) return spacing && spacing.every((v) => Math.abs(v - 1) < 1e-9) ? null : 1;
    if (/^(pixels?|px|voxels?)$/.test(s)) return null;
    if (/^(nm|nanomet)/.test(s)) return 0.001;
    if (/^(mm|millimet)/.test(s)) return 1000;
    if (/^(m|meters?|metres?)$/.test(s)) return 1e6;
    return 1; // micron, microns, µm, um
  }

  function parse(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const perr = doc.getElementsByTagName('parsererror')[0];
    if (perr) throw new Error('the XML could not be parsed (' + perr.textContent.trim().split('\n')[0].slice(0, 120) + ')');
    const root = doc.documentElement;
    if (!root || root.nodeName !== 'tracings') throw new Error('it is not an SNT .traces file (no <tracings> element)');
    const num = (el, a, d) => { const v = el && el.getAttribute(a); return v == null || v === '' || !isFinite(+v) ? d : +v; };
    const ss = root.getElementsByTagName('samplespacing')[0], is = root.getElementsByTagName('imagesize')[0];
    const spacing = ss ? [num(ss, 'x', 1), num(ss, 'y', 1), num(ss, 'z', 1)] : null;
    const paths = [];
    for (const el of root.getElementsByTagName('path')) {
      const pts = [];
      for (const q of el.getElementsByTagName('point')) {
        pts.push({ x: num(q, 'x', NaN), y: num(q, 'y', NaN), z: num(q, 'z', 0), xd: num(q, 'xd', NaN), yd: num(q, 'yd', NaN), zd: num(q, 'zd', NaN) });
      }
      const a = (k) => { const v = el.getAttribute(k); return v == null || v === '' ? null : v; };
      paths.push({
        id: a('id'), name: a('name') || '', pts,
        startson: a('startson'), startsindex: num(el, 'startsindex', NaN), endson: a('endson'), endsindex: num(el, 'endsindex', NaN),
        fitted: a('fitted'), fittedversionof: a('fittedversionof'), usefitted: a('usefitted') === 'true',
      });
    }
    return { spacing, units: ss ? ss.getAttribute('units') || '' : '', size: is ? [num(is, 'width', 0), num(is, 'height', 0), num(is, 'depth', 0)] : null, paths };
  }

  const CHR = /(?:^|[^a-z])(?:chr|chrom|chromosome|biv|bivalent|sc)\s*[#_.:-]?\s*(\d+)/i;
  const nameChrom = (name) => { const m = CHR.exec(name); if (m) return +m[1]; return /^\s*\d+\s*$/.test(name) ? +name : null; };
  const nameUnassigned = (name) => /^\s*(unassigned|unknown|piece)/i.test(name);

  /**
   * Turn parsed SNT paths into the tracer's data structure on the current volume.
   * Points are placed by voxel position, so a .traces file made on the same image (in Fiji, with
   * any calibration) lines up exactly.
   */
  function toTrace(T, app) {
    const sp = app.spacing, dims = app.dims, warnings = [];
    const fac = T.spacing ? unitToUm(T.units, T.spacing) : null;
    const fsp = T.spacing && fac ? T.spacing.map((v) => v * fac) : null; // file voxel size, µm
    if (!fsp) warnings.push('The file has no voxel size (pixel units): points were placed by voxel position.');
    else if (fsp.some((v, i) => Math.abs(v - sp[i]) > 0.02 * sp[i])) {
      warnings.push(`The file's voxel size (${fsp.map((v) => fmtNum(v)).join(' × ')} µm) differs from this image's (${sp.map((v) => fmtNum(v)).join(' × ')} µm): points were placed by voxel position.`);
    }
    if (T.size && T.size.some((v, i) => v && v !== dims[i])) {
      warnings.push(`The traces were made on a ${T.size.join(' × ')} image, but this one is ${dims.join(' × ')}. If one is a crop of the other, the traces will be shifted.`);
    }
    // voxel position (fractional, 0-based) -> µm in this volume
    const world = (q) => {
      let v;
      if (isFinite(q.xd) && isFinite(q.yd)) v = fsp ? [q.xd * fac / fsp[0], q.yd * fac / fsp[1], (isFinite(q.zd) ? q.zd * fac : 0) / fsp[2]] : [q.xd, q.yd, isFinite(q.zd) ? q.zd : 0];
      else v = [q.x, q.y, q.z];
      return [v[0] * sp[0], v[1] * sp[1], v[2] * sp[2]];
    };

    // fitted copies: use the fitted version only where the original asks for it
    const byId = new Map(T.paths.map((p) => [p.id, p]));
    const alias = new Map();
    const use = T.paths.filter((p) => {
      if (p.fittedversionof != null) {
        const o = byId.get(p.fittedversionof);
        if (o && o.usefitted) {
          // the fitted copy stands in for the original: same name (chromosome) and the same parent
          alias.set(o.id, p);
          if (o.name) p.name = o.name;
          if (p.startson == null && o.startson != null) { p.startson = o.startson; p.startsindex = NaN; }
          if (p.endson == null && o.endson != null) { p.endson = o.endson; p.endsindex = NaN; }
          return true;
        }
        return !o;
      }
      return !(p.usefitted && p.fitted != null && byId.has(p.fitted));
    }).filter((p) => p.pts.length >= 2);
    const skipped = T.paths.filter((p) => p.pts.length < 2 && p.fittedversionof == null).length;
    if (skipped) warnings.push(`${skipped} path${skipped > 1 ? 's' : ''} with a single point ${skipped > 1 ? 'were' : 'was'} skipped.`);
    const ref = (id) => (id == null ? null : alias.get(id) || (use.includes(byId.get(id)) ? byId.get(id) : null));
    use.forEach((p, i) => { p.ix = i; p.w = p.pts.map(world); });

    // outside the volume?
    let out = 0, tot = 0;
    for (const p of use) for (const q of p.w) { tot++; if (q.some((v, k) => v < -0.5 * sp[k] || v > (dims[k] - 0.5) * sp[k])) out++; }
    if (out) warnings.push(`${Math.round((100 * out) / tot)} % of the points lie outside this image.`);

    // trees (a path plus the paths branching from it) and chromosome numbers
    const rootOf = (p) => { const seen = new Set(); while (p && !seen.has(p)) { seen.add(p); const q = ref(p.startson); if (!q) return p; p = q; } return p; };
    const trees = new Map();
    for (const p of use) { const r = rootOf(p); if (!trees.has(r)) trees.set(r, []); trees.get(r).push(p); }
    const named = use.some((p) => nameChrom(p.name) != null);
    let next = 0;
    const treeIx = new Map(), chromOf = new Map();
    for (const [r, ps] of trees) {
      treeIx.set(r, treeIx.size + 1);
      const tn = ps.map((p) => nameChrom(p.name)).find((k) => k != null);
      const treeChrom = nameUnassigned(r.name) ? 0 : tn != null ? tn : named ? 0 : ++next;
      for (const p of ps) { const k = nameChrom(p.name); chromOf.set(p, nameUnassigned(p.name) ? 0 : k != null ? k : treeChrom); }
    }

    // nodes at path ends and where other paths join; split paths there
    const splits = new Map(use.map((p) => [p, new Set([0, p.pts.length - 1])]));
    const joinTo = new Map(); // "path:index" of a child end -> the parent path and point index it joins
    const nearest = (P, q) => { let b = 0, bd = Infinity; P.w.forEach((w, i) => { const d = dist(w, q); if (d < bd) { bd = d; b = i; } }); return b; };
    for (const p of use) {
      for (const [on, idx, end] of [[p.startson, p.startsindex, 0], [p.endson, p.endsindex, p.pts.length - 1]]) {
        const P = ref(on);
        if (!P || P === p) continue;
        const i = idx >= 0 && idx < P.pts.length && !alias.has(on) ? Math.round(idx) : nearest(P, p.w[end]);
        splits.get(P).add(i);
        joinTo.set(p.ix + ':' + end, { P, i });
      }
    }
    const nodeId = new Map(), nodes = {};
    const nodeOf = (p, i) => {
      let P = p, k = i;
      for (let g = 0; g < 50; g++) { const j = joinTo.get(P.ix + ':' + k); if (!j) break; P = j.P; k = j.i; }
      const key = P.ix + ':' + k;
      if (!nodeId.has(key)) { nodes[nodeId.size] = P.w[k]; nodeId.set(key, nodeId.size); }
      return nodeId.get(key);
    };
    const tol = 0.5 * Math.min(sp[0], sp[1]);
    const edges = [], edgeChrom = [], edgeChain = [];
    for (const p of use) {
      const cut = [...splits.get(p)].sort((a, b) => a - b);
      for (let j = 1; j < cut.length; j++) {
        const ia = cut[j - 1], ib = cut[j], na = nodeOf(p, ia), nb = nodeOf(p, ib);
        let pts = p.w.slice(ia, ib + 1);
        // a branch that starts or ends a little away from its parent: draw the connection
        if (dist(nodes[na], pts[0]) > tol) pts = [nodes[na], ...pts];
        if (dist(nodes[nb], pts[pts.length - 1]) > tol) pts = [...pts, nodes[nb]];
        edges.push({ a: na, b: nb, length: polyLen(pts), pts, vox: null, isum: 0, icnt: 0 });
        edgeChrom.push(chromOf.get(p));
        edgeChain.push(treeIx.get(rootOf(p)));
      }
    }

    // voxels along each edge, and a thin tube around all of them (the mask labels spread into)
    const { W, H, D } = { W: dims[0], H: dims[1], D: dims[2] }, P = W * H;
    const step = 0.4 * Math.min(sp[0], sp[1], sp[2]);
    const tube = new Uint8Array(W * H * D);
    const rx = Math.max(1, Math.round(0.06 / sp[0])), ry = Math.max(1, Math.round(0.06 / sp[1])), rz = Math.max(1, Math.round(0.12 / sp[2]));
    for (const e of edges) {
      const set = new Set();
      for (let i = 1; i < e.pts.length; i++) {
        const a = e.pts[i - 1], b = e.pts[i], n = Math.max(1, Math.ceil(dist(a, b) / step));
        for (let k = i === 1 ? 0 : 1; k <= n; k++) {
          const t = k / n, x = Math.round((a[0] + (b[0] - a[0]) * t) / sp[0]), y = Math.round((a[1] + (b[1] - a[1]) * t) / sp[1]), z = Math.round((a[2] + (b[2] - a[2]) * t) / sp[2]);
          if (x >= 0 && x < W && y >= 0 && y < H && z >= 0 && z < D) set.add(z * P + y * W + x);
        }
      }
      e.vox = Int32Array.from(set);
      for (const v of e.vox) {
        const z0 = (v / P) | 0, r0 = v - z0 * P, y0 = (r0 / W) | 0, x0 = r0 - y0 * W;
        for (let dz = -rz; dz <= rz; dz++) {
          const z = z0 + dz; if (z < 0 || z >= D) continue;
          for (let dy = -ry; dy <= ry; dy++) {
            const y = y0 + dy; if (y < 0 || y >= H) continue;
            for (let dx = -rx; dx <= rx; dx++) {
              const x = x0 + dx; if (x < 0 || x >= W) continue;
              if ((dx / rx) ** 2 + (dy / ry) ** 2 + (dz / rz) ** 2 <= 1) tube[z * P + y * W + x] = 1;
            }
          }
        }
      }
    }
    const n = Math.max(0, ...edgeChrom);
    return {
      edges, nodes, edgeChrom: Int32Array.from(edgeChrom), edgeChain: Int32Array.from(edgeChain), tube, warnings, n,
      nPaths: use.length, nTrees: trees.size, named, nUnassigned: edgeChrom.filter((k) => !k).length,
    };
  }

  // ---------------------------------------------------------------- writing
  const DTD = `<!DOCTYPE tracings [
  <!ELEMENT tracings       (samplespacing,imagesize,path*,fill*)>
  <!ELEMENT imagesize      EMPTY>
  <!ELEMENT samplespacing  EMPTY>
  <!ELEMENT path           (point+)>
  <!ELEMENT point          EMPTY>
  <!ELEMENT fill           (node*)>
  <!ELEMENT node           EMPTY>
  <!ATTLIST samplespacing  x                 CDATA           #REQUIRED>
  <!ATTLIST samplespacing  y                 CDATA           #REQUIRED>
  <!ATTLIST samplespacing  z                 CDATA           #REQUIRED>
  <!ATTLIST samplespacing  units             CDATA           #REQUIRED>
  <!ATTLIST imagesize      width             CDATA           #REQUIRED>
  <!ATTLIST imagesize      height            CDATA           #REQUIRED>
  <!ATTLIST imagesize      depth             CDATA           #REQUIRED>
  <!ATTLIST path           id                CDATA           #REQUIRED>
  <!ATTLIST path           primary           CDATA           #IMPLIED>
  <!ATTLIST path           name              CDATA           #IMPLIED>
  <!ATTLIST path           startson          CDATA           #IMPLIED>
  <!ATTLIST path           startsindex       CDATA           #IMPLIED>
  <!ATTLIST path           startsx           CDATA           #IMPLIED>
  <!ATTLIST path           startsy           CDATA           #IMPLIED>
  <!ATTLIST path           startsz           CDATA           #IMPLIED>
  <!ATTLIST path           endson            CDATA           #IMPLIED>
  <!ATTLIST path           endsindex         CDATA           #IMPLIED>
  <!ATTLIST path           endsx             CDATA           #IMPLIED>
  <!ATTLIST path           endsy             CDATA           #IMPLIED>
  <!ATTLIST path           endsz             CDATA           #IMPLIED>
  <!ATTLIST path           reallength        CDATA           #IMPLIED>
  <!ATTLIST path           usefitted         (true|false)    #IMPLIED>
  <!ATTLIST path           fitted            CDATA           #IMPLIED>
  <!ATTLIST path           fittedversionof   CDATA           #IMPLIED>
  <!ATTLIST path           swctype           CDATA           #IMPLIED>
  <!ATTLIST path           color             CDATA           #IMPLIED>
  <!ATTLIST path           channel           CDATA           #IMPLIED>
  <!ATTLIST path           frame             CDATA           #IMPLIED>
  <!ATTLIST path           spines            CDATA           #IMPLIED>
  <!ATTLIST path           canvasoffsetx     CDATA           #IMPLIED>
  <!ATTLIST path           canvasoffsety     CDATA           #IMPLIED>
  <!ATTLIST path           canvasoffsetz     CDATA           #IMPLIED>
  <!ATTLIST point          x                 CDATA           #REQUIRED>
  <!ATTLIST point          y                 CDATA           #REQUIRED>
  <!ATTLIST point          z                 CDATA           #REQUIRED>
  <!ATTLIST point          xd                CDATA           #IMPLIED>
  <!ATTLIST point          yd                CDATA           #IMPLIED>
  <!ATTLIST point          zd                CDATA           #IMPLIED>
  <!ATTLIST point          tx                CDATA           #IMPLIED>
  <!ATTLIST point          ty                CDATA           #IMPLIED>
  <!ATTLIST point          tz                CDATA           #IMPLIED>
  <!ATTLIST point          r                 CDATA           #IMPLIED>
  <!ATTLIST fill           id                CDATA           #REQUIRED>
  <!ATTLIST fill           frompaths         CDATA           #IMPLIED>
  <!ATTLIST fill           metric            CDATA           #REQUIRED>
  <!ATTLIST fill           threshold         CDATA           #REQUIRED>
  <!ATTLIST fill           volume            CDATA           #IMPLIED>
  <!ATTLIST node           id                CDATA           #REQUIRED>
  <!ATTLIST node           x                 CDATA           #REQUIRED>
  <!ATTLIST node           y                 CDATA           #REQUIRED>
  <!ATTLIST node           z                 CDATA           #REQUIRED>
  <!ATTLIST node           previousid        CDATA           #IMPLIED>
  <!ATTLIST node           distance          CDATA           #REQUIRED>
  <!ATTLIST node           status            (open|closed)   #REQUIRED>
]>`;

  /**
   * Ordered point lists for a set of edges and bridges: walks from free ends, continuing as
   * straight as possible through junctions. A clean chromosome gives exactly one list.
   */
  function trails(items) {
    const adj = new Map();
    items.forEach((it, j) => { for (const n of [it.a, it.b]) { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(j); } });
    const used = new Uint8Array(items.length), out = [];
    const free = (n) => adj.get(n).filter((j) => !used[j]).length;
    const oriented = (it, from) => (it.a === from ? it.pts : it.pts.slice().reverse());
    for (;;) {
      let start = null;
      for (const [n] of adj) if (free(n) === 1) { start = n; break; }
      if (start == null) for (const [n] of adj) if (free(n)) { start = n; break; }
      if (start == null) break;
      let cur = start, pts = [];
      for (;;) {
        const opts = adj.get(cur).filter((j) => !used[j]);
        if (!opts.length) break;
        let best = opts[0];
        if (opts.length > 1 && pts.length >= 2) {
          const a = pts[pts.length - 2], b = pts[pts.length - 1], din = [b[0] - a[0], b[1] - a[1]];
          let bc = -Infinity;
          for (const j of opts) {
            const q = oriented(items[j], cur), k = Math.min(q.length - 1, 3), d = [q[k][0] - q[0][0], q[k][1] - q[0][1]];
            const c = (din[0] * d[0] + din[1] * d[1]) / (Math.hypot(...din) * Math.hypot(...d) || 1);
            if (c > bc) { bc = c; best = j; }
          }
        }
        used[best] = 1;
        const it = items[best], q = oriented(it, cur);
        pts = pts.length ? pts.concat(q.slice(1)) : q.slice();
        cur = it.a === cur ? it.b : it.a;
      }
      if (pts.length >= 2) out.push(pts);
    }
    return out;
  }

  function write(app, o = {}) {
    const t = app.trace, E = t.edges, sp = app.spacing, dims = app.dims;
    const has = (i, k) => t.edgeChrom[i] === k || t.edgeChrom2[i] === k;
    let K = 0;
    for (let i = 0; i < E.length; i++) K = Math.max(K, t.edgeChrom[i], t.edgeChrom2[i]);
    const groups = [];
    const itemsOf = (es, inSet) => {
      const touch = new Set();
      for (const i of es) { touch.add(E[i].a); touch.add(E[i].b); }
      return [
        ...es.map((i) => ({ a: E[i].a, b: E[i].b, pts: E[i].pts })),
        ...t.bridges.filter((b) => b.on !== false && (b.user ? touch.has(b.a) && touch.has(b.b) : inSet(b.ea) && inSet(b.eb))).map((b) => ({ a: b.a, b: b.b, pts: [b.pa, b.pb] })),
      ];
    };
    for (let k = 1; k <= K; k++) {
      const es = E.map((_, i) => i).filter((i) => has(i, k));
      if (es.length) groups.push({ name: 'Chromosome ' + k, color: chromHex(k), items: itemsOf(es, (i) => has(i, k)) });
    }
    if (o.unassigned) {
      const byChain = new Map();
      E.forEach((_, i) => { if (!t.edgeChrom[i] && !t.edgeChrom2[i]) { const c = t.edgeChain ? t.edgeChain[i] : i; if (!byChain.has(c)) byChain.set(c, []); byChain.get(c).push(i); } });
      let n = 0;
      for (const es of byChain.values()) { const s = new Set(es); groups.push({ name: 'Unassigned piece ' + ++n, color: '#9aa0a6', items: itemsOf(es, (i) => s.has(i)) }); }
    }
    const lines = [];
    let id = 1; // SNT numbers paths from 1
    for (const g of groups) {
      trails(g.items).forEach((pts, j) => {
        const name = j ? `${g.name} (part ${j + 1})` : g.name;
        // attributes as SNT itself writes them: SNT reads spines with Integer.parseInt (spines="false" made
        // SNT 5 refuse the file: "NumberFormatException: For input string: "false""), colours as #rrggbbaa
        lines.push(`  <path id="${id++}" swctype="0" color="${g.color}ff" channel="1" frame="1" spines="0" primary="true" usefitted="false" name="${esc(name)}" reallength="${fmt(polyLen(pts))}">`);
        for (const p of pts) lines.push(`    <point x="${Math.round(p[0] / sp[0])}" y="${Math.round(p[1] / sp[1])}" z="${Math.round(p[2] / sp[2])}" xd="${fmt(p[0])}" yd="${fmt(p[1])}" zd="${fmt(p[2])}"/>`);
        lines.push('  </path>');
      });
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${DTD}\n<tracings>\n  <samplespacing x="${fmt(sp[0])}" y="${fmt(sp[1])}" z="${fmt(sp[2])}" units="µm"/>\n  <imagesize width="${dims[0]}" height="${dims[1]}" depth="${dims[2]}"/>\n${lines.join('\n')}\n</tracings>\n`;
    return { xml, nPaths: id - 1, nGroups: groups.length };
  }

  async function gzip(text) {
    return await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  }

  window.SNTTraces = { readText, readTextInfo, pickTraces, parse, toTrace, write, trails, gzip, nameChrom };

  // ---------------------------------------------------------------- App integration
  Object.assign(App.prototype, {
    /**
     * Load an SNT .traces file as the trace. handle: a FileSystemFileHandle on it (Chrome / Edge, from the Open
     * dialog, the import button or a drop): then Save writes the edited trace back to that file.
     */
    async importTraces(file, handle = null) {
      if (!this.dims) return this.toast('Open the image the traces were made on first, then import the .traces file.', 'warn');
      const t0 = this.trace;
      if (t0 && this.traceUnsaved() && !confirm('The current trace has changes that are not saved to a file. Replace it with the imported one anyway?')) return;
      if (t0 && !this.traceUnsaved() && t0.undo && t0.undo.length && !confirm('Replace the current trace, including your edits, with the imported one?')) return;
      let R, info;
      try { info = await readTextInfo(file); R = toTrace(parse(info.text), this); } catch (e) { return this.error('Could not read ' + file.name + ': ' + e.message); }
      if (!R.edges.length) return this.error(file.name + ' has no paths with at least two points.');
      const base = file.name.replace(/\.traces$/i, '');
      const ctx = this.proc.makeCtx(this.dims, this.spacing);
      const mask = this.addLayer({ name: 'Trace tube · ' + base, kind: 'mask', data: R.tube, silent: true });
      mask.disp.visible = false;
      const labels = this.addLayer({ name: 'Chromosomes · ' + base, kind: 'labels', data: this.tracer.floodLabels(R.tube, ctx, R.edges, R.edgeChrom), silent: true });
      const w = Math.max(4 * Math.min(this.spacing[0], this.spacing[1]), 0.1);
      this.trace = {
        edges: R.edges, nodes: R.nodes, bridges: [], edgeChrom: R.edgeChrom, edgeChrom2: new Int32Array(R.edges.length),
        edgeChain: R.edgeChain, gapCands: [], mode: 'imported', nChains: R.nTrees, warnings: R.warnings, n: R.n,
        params: { width: w, maxGap: 0, maxBend: Math.PI / 3, minLen: 0, zPenalty: 1, zRef: Math.max(0.2, 3 * this.spacing[2]) },
        labelsLayer: labels, maskLayer: mask, visible: true, sel: null, undo: [], shared: false, clickMode: 'trace', active: 1, anchor: null,
        version: this.tracer.VERSION, source: file.name, nPaths: R.nPaths, named: R.named,
        // the file this trace is saved to (handle: null where the browser cannot write files), and the edit count at the last save
        file: { handle, name: file.name, gzip: info.gzip, fromImport: true }, edits: 0, savedEdits: 0,
      };
      this.selectedLabel = 0;
      this.traceSummary();
      this.layersChanged();
      this.ui.showTab('analyze');
      this.ui.refreshTrace();
      this.requestRender();
      this.status(`Imported ${R.nPaths} path${R.nPaths === 1 ? '' : 's'} from ${file.name}`);
      this.toast(`Imported ${R.nPaths} SNT path${R.nPaths === 1 ? '' : 's'} as ${R.n} chromosome${R.n === 1 ? '' : 's'}`);
    },
    /** True when the trace has edits made since it was made, opened from a file or last saved. */
    traceUnsaved() {
      const t = this.trace;
      return !!t && (t.edits || 0) > (t.savedEdits || 0);
    },
    /**
     * Save: write the trace back to its file, i.e. the .traces file it was opened from or last saved to with
     * Save as… (Chrome / Edge). Everything is written, unassigned pieces included, so nothing in the file is lost
     * that is still in the trace. Without such a file (other browsers, or a trace made here) this is Save as….
     */
    async saveTraces() {
      const t = this.trace;
      if (!t) return this.toast('Trace or import chromosomes first');
      const f = t.file;
      if (!f || !f.handle) return this.saveTracesAs({ unassigned: true });
      if (f.fromImport && !f.confirmed && !(await this.ui.confirmDialog('Replace ' + f.name + '?',
        `Save writes the traces as they are now in SynaptoSnap into ${f.name}: one path per chromosome ("Chromosome N") and the unassigned pieces ("Unassigned piece N").\n\nOther things SNT may have stored in that file (its own path names, tags, fitted paths) are not kept. To keep the original as it is, cancel and use Save as… instead.`, 'Replace'))) return;
      try {
        // asked on the click (the browser shows "Save changes to …?" once per file)
        if ((await f.handle.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await f.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
          return this.toast(`No permission to change ${f.name}. Use Save as… to save it under another name.`, 'warn');
        }
        f.confirmed = true;
        const r = write(this, { unassigned: true });
        if (!r.nPaths) return this.toast('There are no traces to save');
        const edits = t.edits || 0;
        await writeToHandle(f.handle, f.gzip ? await gzip(r.xml) : new Blob([r.xml], { type: 'application/xml' }));
        t.savedEdits = edits;
        this.ui.refreshTraceFile();
        this.status(`Saved ${r.nPaths} SNT path${r.nPaths === 1 ? '' : 's'} to ${f.name}`);
      } catch (e) { this.error(`Could not save ${f.name}: ${e.message}`); }
    },
    /**
     * Save as…: a new .traces file, with the name and folder chosen in the browser's save dialog (Chrome / Edge);
     * the trace is then saved to that file by Save. Other browsers ask for a name and download the file.
     * o.unassigned: also save the pieces not assigned to a chromosome.
     */
    async saveTracesAs(o = {}) {
      const t = this.trace;
      if (!t) return this.toast('Trace or import chromosomes first');
      const r = write(this, o);
      if (!r.nPaths) return this.toast(o.unassigned ? 'There are no traces to save' : 'No chromosomes are assigned yet — assign some, or tick "Include unassigned pieces"');
      const base = t.file ? t.file.name.replace(/\.traces$/i, '') : (this.vol ? this.vol.name : 'volume');
      const edits = t.edits || 0;
      let res;
      try {
        res = await saveFileAs(() => gzip(r.xml), base + (t.file && t.file.fromImport ? '_edited' : '') + '.traces',
          { description: 'SNT traces (Fiji)', mime: 'application/octet-stream', ext: ['.traces'] });
      } catch (e) { return this.error('Could not save the traces: ' + e.message); }
      if (!res) return;
      // the trace now belongs to the new file; a download only counts as saved when there is no file to write to
      if (res.handle) { t.file = { handle: res.handle, name: res.name, gzip: true, confirmed: true }; t.savedEdits = edits; }
      else if (!t.file || !t.file.handle) { t.file = { handle: null, name: res.name, gzip: true, downloaded: true }; t.savedEdits = edits; }
      this.ui.refreshTraceFile();
      this.status(`Saved ${r.nPaths} SNT path${r.nPaths === 1 ? '' : 's'} to ${res.name}` + (res.handle ? '' : ' (in your downloads)'));
    },
    exportTraces(o = {}) { return this.saveTracesAs(o); },
  });
})();
