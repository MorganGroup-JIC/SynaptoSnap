/* SynaptoSnap — CZI (Carl Zeiss Image, "ZISRAW") reader and writer.
 *
 * Written as a factory so the same code runs on the main thread and inside the
 * processing Web Worker (where pixel decoding happens).
 *
 * Reading supports: uncompressed, zstd (zstd0), zstd with header incl. hi/lo byte
 * packing (zstd1), and JPEG subblocks; Gray8/16/32/32Float/64 and BGR(A) pixel
 * types; Z-stacks, multiple channels, scenes, time points and tiled mosaics.
 * JPEG-XR and LZW compressed files are reported as unsupported.
 *
 * Writing produces an uncompressed single-file CZI (Gray8 / Gray16 / Gray32Float)
 * with a directory, Scaling and channel metadata.
 */
function CZIFactory(fzstd) {
  'use strict';

  const PIXEL_TYPES = {
    0: { name: 'Gray8', bytes: 1, comps: 1, sample: 'u8' },
    1: { name: 'Gray16', bytes: 2, comps: 1, sample: 'u16' },
    2: { name: 'Gray32Float', bytes: 4, comps: 1, sample: 'f32' },
    3: { name: 'Bgr24', bytes: 3, comps: 3, sample: 'u8' },
    4: { name: 'Bgr48', bytes: 6, comps: 3, sample: 'u16' },
    8: { name: 'Bgr96Float', bytes: 12, comps: 3, sample: 'f32' },
    9: { name: 'Bgra32', bytes: 4, comps: 4, sample: 'u8' },
    10: { name: 'Gray64ComplexFloat', bytes: 8, comps: 1, sample: 'complex' },
    11: { name: 'Bgr192ComplexFloat', bytes: 24, comps: 3, sample: 'complex' },
    12: { name: 'Gray32', bytes: 4, comps: 1, sample: 'i32' },
    13: { name: 'Gray64', bytes: 8, comps: 1, sample: 'f64' },
  };
  const PIXEL_TYPE_IDS = { Gray8: 0, Gray16: 1, Gray32Float: 2 };
  const COMPRESSION = { 0: 'Uncompressed', 1: 'JPEG', 2: 'LZW', 4: 'JPEG-XR', 5: 'zstd', 6: 'zstd (hi/lo)' };
  const OUT_DTYPE = { u8: 'uint8', u16: 'uint16', f32: 'float32', i32: 'float32', f64: 'float32' };

  // ---------------------------------------------------------------- helpers
  function str(dv, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = dv.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  function i64(dv, off) {
    return dv.getInt32(off + 4, true) * 4294967296 + dv.getUint32(off, true);
  }
  function setI64(dv, off, v) {
    dv.setUint32(off, v >>> 0, true);
    dv.setUint32(off + 4, Math.floor(v / 4294967296), true);
  }
  function setStr(u8, off, s) {
    for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i);
  }
  const ceil32 = (n) => Math.ceil(n / 32) * 32;

  function parseEntry(dv, off) {
    const schema = str(dv, off, 2);
    const pixelType = dv.getInt32(off + 2, true);
    const filePos = i64(dv, off + 6);
    const filePart = dv.getInt32(off + 14, true);
    const compression = dv.getInt32(off + 18, true);
    const pyramidType = dv.getUint8(off + 22);
    const dimCount = dv.getInt32(off + 28, true);
    if (schema !== 'DV' || dimCount < 0 || dimCount > 32) throw new Error('Corrupt CZI directory entry');
    const dims = {};
    for (let i = 0; i < dimCount; i++) {
      const o = off + 32 + i * 20;
      const name = str(dv, o, 4);
      dims[name] = {
        start: dv.getInt32(o + 4, true),
        size: dv.getInt32(o + 8, true),
        startCoord: dv.getFloat32(o + 12, true),
        stored: dv.getInt32(o + 16, true),
      };
    }
    return { entry: { pixelType, filePos, filePart, compression, pyramidType, dims }, length: 32 + dimCount * 20 };
  }

  // ----------------------------------------------------------------- reader
  class CZIReader {
    constructor(src) {
      this.src = src; // Blob/File or ArrayBuffer
      this.name = src && src.name ? src.name : 'image.czi';
    }
    get byteLength() { return this.src instanceof ArrayBuffer ? this.src.byteLength : this.src.size; }
    async read(pos, len) {
      const end = Math.min(pos + len, this.byteLength);
      if (this.src instanceof ArrayBuffer) return this.src.slice(pos, end);
      return await this.src.slice(pos, end).arrayBuffer();
    }

    async open() {
      const h = new DataView(await this.read(0, 32 + 80));
      if (h.byteLength < 112 || str(h, 0, 16) !== 'ZISRAWFILE') throw new Error('Not a CZI file (missing ZISRAWFILE header)');
      const d = 32;
      this.version = h.getInt32(d, true) + '.' + h.getInt32(d + 4, true);
      this.filePart = h.getInt32(d + 48, true);
      this.directoryPos = i64(h, d + 52);
      this.metadataPos = i64(h, d + 60);
      this.updatePending = h.getInt32(d + 68, true) !== 0;
      if (this.filePart !== 0) throw new Error('This CZI is one part of a multi-file dataset; open the first part (.czi without "(1)" suffix).');

      this.entries = this.directoryPos > 0 ? await this._readDirectory(this.directoryPos) : await this._scanSubblocks();
      if (!this.entries.length) throw new Error('The CZI file contains no image subblocks');

      this.xml = '';
      if (this.metadataPos > 0) {
        const m = new DataView(await this.read(this.metadataPos, 32 + 256));
        if (str(m, 0, 16) === 'ZISRAWMETADATA') {
          const xmlSize = m.getInt32(32, true);
          const bytes = await this.read(this.metadataPos + 32 + 256, xmlSize);
          this.xml = new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '');
        }
      }
      this.summary = this._summarize();
      return this;
    }

    async _readDirectory(pos) {
      const h = new DataView(await this.read(pos, 32 + 128));
      if (str(h, 0, 16) !== 'ZISRAWDIRECTORY') return await this._scanSubblocks();
      const allocated = i64(h, 16), used = i64(h, 24);
      const count = h.getInt32(32, true);
      const len = Math.max(allocated, used) - 128;
      const dv = new DataView(await this.read(pos + 32 + 128, len));
      const out = [];
      let off = 0;
      for (let i = 0; i < count; i++) {
        const { entry, length } = parseEntry(dv, off);
        out.push(entry);
        off += length;
      }
      return out;
    }

    // Fallback when the directory is missing: walk all segments.
    async _scanSubblocks() {
      const out = [];
      let pos = 0;
      const n = this.byteLength;
      while (pos + 32 <= n) {
        const h = new DataView(await this.read(pos, 32 + 16 + 32 + 20 * 16));
        const id = str(h, 0, 16);
        const allocated = i64(h, 16);
        if (!id || allocated <= 0) break;
        if (id === 'ZISRAWSUBBLOCK') {
          const { entry } = parseEntry(h, 48);
          entry.filePos = pos;
          out.push(entry);
        }
        pos += 32 + allocated;
      }
      return out;
    }

    _summarize() {
      const dimValues = {};
      const pixelTypes = new Set(), compressions = new Set();
      let level0 = 0, pyramid = 0;
      for (const e of this.entries) {
        const isL0 = isLevel0(e);
        if (!isL0) { pyramid++; continue; }
        level0++;
        pixelTypes.add(e.pixelType);
        compressions.add(e.compression);
        for (const k in e.dims) {
          if (k === 'X' || k === 'Y') continue;
          (dimValues[k] || (dimValues[k] = new Set())).add(e.dims[k].start);
        }
      }
      const dims = {};
      for (const k in dimValues) dims[k] = Array.from(dimValues[k]).sort((a, b) => a - b);
      // bounding boxes per scene
      const scenes = dims.S || [null];
      const sceneBoxes = scenes.map((s) => {
        const b = this._bounds((e) => s === null || (e.dims.S && e.dims.S.start === s));
        return { scene: s, width: b.w, height: b.h };
      });
      return {
        fileName: this.name,
        fileSize: this.byteLength,
        version: this.version,
        subblocks: level0,
        pyramidSubblocks: pyramid,
        dims,
        pixelTypes: Array.from(pixelTypes).map((p) => (PIXEL_TYPES[p] || { name: 'Unknown(' + p + ')' }).name),
        compressions: Array.from(compressions).map((c) => COMPRESSION[c] || ('Code ' + c)),
        sceneBoxes,
      };
    }

    _bounds(filter) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const e of this.entries) {
        if (!isLevel0(e) || !filter(e)) continue;
        const X = e.dims.X, Y = e.dims.Y;
        x0 = Math.min(x0, X.start); y0 = Math.min(y0, Y.start);
        x1 = Math.max(x1, X.start + X.size); y1 = Math.max(y1, Y.start + Y.size);
      }
      return { x0, y0, w: x1 - x0, h: y1 - y0 };
    }

    async readSubblockData(e) {
      const h = new DataView(await this.read(e.filePos, 32 + 16 + 32 + 20 * 24));
      if (str(h, 0, 16) !== 'ZISRAWSUBBLOCK') throw new Error('Corrupt CZI: subblock not found at ' + e.filePos);
      const metaSize = h.getInt32(32, true);
      const dataSize = i64(h, 40);
      const dimCount = h.getInt32(48 + 28, true);
      const hdr = Math.max(256, 16 + 32 + 20 * dimCount);
      return await this.read(e.filePos + 32 + hdr + metaSize, dataSize);
    }

    /** Decode one subblock to an array of component planes (each a typed array of stored W*H). */
    async decodeSubblock(e) {
      const pt = PIXEL_TYPES[e.pixelType];
      if (!pt) throw new Error('Unsupported CZI pixel type ' + e.pixelType);
      if (pt.sample === 'complex') throw new Error('Complex-valued CZI pixel types are not supported');
      const w = e.dims.X.stored, hgt = e.dims.Y.stored;
      const buf = await this.readSubblockData(e);
      let raw;
      switch (e.compression) {
        case 0: raw = new Uint8Array(buf); break;
        case 5: raw = fzstd.decompress(new Uint8Array(buf)); break;
        case 6: {
          const u8 = new Uint8Array(buf);
          const hsize = u8[0];
          let hilo = false, p = 1;
          while (p < hsize) {
            const type = u8[p];
            if (type === 1) { hilo = (u8[p + 1] & 1) === 1; p += 2; } else break;
          }
          raw = fzstd.decompress(u8.subarray(hsize));
          if (hilo) raw = unpackHiLo(raw);
          break;
        }
        case 1: return await decodeJpeg(buf, w, hgt, pt);
        case 2: throw new Error('LZW-compressed CZI files are not supported. Re-save the file in ZEN without compression or with zstd.');
        case 4: throw new Error('JPEG-XR compressed CZI files are not supported in the browser. In ZEN use File › Save As with compression "None" or "Zstd".');
        default: throw new Error('Unsupported CZI compression (code ' + e.compression + ')');
      }
      const need = w * hgt * pt.bytes;
      if (raw.length < need) throw new Error('CZI subblock is truncated (' + raw.length + ' of ' + need + ' bytes)');
      return splitComponents(raw, w, hgt, pt);
    }

    /**
     * What loadVolume(sel) reads, as plain data: the output size, the channels, and the tiles of every plane.
     * A pool of workers can then decode the planes in parallel, each with its own reader on the same file
     * (decodePlane needs no open(): every tile entry carries its file position).
     */
    plan(sel) {
      const S = this.summary.dims;
      const zVals = S.Z || [0];
      const zList = zVals.slice(sel.z0 || 0, (sel.z1 == null ? zVals.length - 1 : sel.z1) + 1);
      const zIndex = new Map(zList.map((z, i) => [z, i]));
      const cVals = sel.channels && sel.channels.length ? sel.channels : (S.C || [0]);
      const fixed = {};
      for (const k in S) {
        if (k === 'C' || k === 'Z' || k === 'M') continue;
        if (k === 'S') fixed.S = sel.scene != null ? sel.scene : S.S[0];
        else if (k === 'T') fixed.T = sel.t != null ? sel.t : S.T[0];
        else fixed[k] = sel.extra && sel.extra[k] != null ? sel.extra[k] : S[k][0];
      }
      const accept = (e) => {
        if (!isLevel0(e)) return false;
        for (const k in fixed) if (e.dims[k] && e.dims[k].start !== fixed[k]) return false;
        const c = e.dims.C ? e.dims.C.start : 0;
        const z = e.dims.Z ? e.dims.Z.start : 0;
        return cVals.indexOf(c) >= 0 && zIndex.has(z);
      };
      const list = this.entries.filter(accept);
      if (!list.length) throw new Error('No subblocks match the selected scene / time point / channels');
      const b = this._bounds((e) => accept(e));
      const bin = Math.max(1, sel.bin | 0);
      const W = Math.floor(b.w / bin), H = Math.floor(b.h / bin), D = zList.length;
      if (W < 1 || H < 1) throw new Error('Selected region is empty');
      const chans = [];
      for (const c of cVals) {
        const first = list.find((e) => (e.dims.C ? e.dims.C.start : 0) === c);
        if (!first) continue;
        const pt = PIXEL_TYPES[first.pixelType];
        if (!pt) throw new Error('Unsupported CZI pixel type ' + first.pixelType);
        chans.push({ c, pixelType: first.pixelType, comps: Math.min(pt.comps, 3), dtype: OUT_DTYPE[pt.sample], ptName: pt.name });
      }
      // group tiles by plane so binning can work on a fully assembled plane; file order keeps reads sequential
      const planes = new Map();
      for (const e of list) {
        const c = e.dims.C ? e.dims.C.start : 0;
        const z = e.dims.Z ? e.dims.Z.start : 0;
        const key = c + ':' + z;
        if (!planes.has(key)) planes.set(key, { c, zi: zIndex.get(z), tiles: [] });
        planes.get(key).tiles.push(e);
      }
      for (const p of planes.values()) p.tiles.sort((a, q) => (a.dims.M ? a.dims.M.start : 0) - (q.dims.M ? q.dims.M.start : 0));
      const order = Array.from(planes.values()).filter((p) => chans.some((q) => q.c === p.c));
      order.sort((a, q) => a.tiles[0].filePos - q.tiles[0].filePos);
      return { W, H, D, bin, zValues: zList, x0: b.x0, y0: b.y0, fullW: b.w, fullH: b.h, chans, planes: order };
    }

    /**
     * Decode one plane of a plan (all its tiles, binned if the plan says so) into one W*H array per component.
     * Also returns each component's min/max, and, when fxy > 1, an fxy × fxy box-averaged copy for the 3D display.
     */
    async decodePlane(plan, plane, fxy = 1) {
      const ch = plan.chans.find((q) => q.c === plane.c);
      const { W, H, bin, fullW, fullH } = plan;
      const data = [], tmp = [];
      for (let k = 0; k < ch.comps; k++) { data.push(alloc(ch.dtype, W * H)); if (bin > 1) tmp.push(alloc(ch.dtype, fullW * fullH)); }
      for (const e of plane.tiles) {
        const comps = await this.decodeSubblock(e);
        const tw = e.dims.X.stored, th = e.dims.Y.stored;
        const ox = e.dims.X.start - plan.x0, oy = e.dims.Y.start - plan.y0;
        for (let k = 0; k < ch.comps; k++) {
          if (bin > 1) blit(comps[k], tw, th, tmp[k], fullW, fullH, ox, oy, 0);
          else blit(comps[k], tw, th, data[k], W, H, ox, oy, 0);
        }
      }
      if (bin > 1) for (let k = 0; k < ch.comps; k++) binPlane(tmp[k], fullW, fullH, bin, data[k], W, H, 0, ch.dtype !== 'float32');
      const min = [], max = [], disp = [];
      for (let k = 0; k < ch.comps; k++) {
        const a = data[k];
        let lo = Infinity, hi = -Infinity;
        for (let i = 0, n = a.length; i < n; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        min.push(lo); max.push(hi);
        if (fxy > 1) disp.push(boxPlane(a, W, H, fxy, ch.dtype));
      }
      return { c: plane.c, zi: plane.zi, data, min, max, disp: fxy > 1 ? disp : null };
    }

    /**
     * Load a 3D volume. sel = { scene, t, channels:[C values], z0, z1 (inclusive, as C indices into dims.Z), bin, extra:{dim:value} }
     * Returns { width, height, depth, channels:[{c, comp, comps, dtype, data, range}] }.
     * (One worker, plane after plane. App.loadPlanes decodes the same planes with a pool of workers.)
     */
    async loadVolume(sel, progress) {
      const plan = this.plan(sel), { W, H, D } = plan, P = W * H;
      const arrs = new Map(plan.chans.map((ch) => [ch.c, { ch, arrs: Array.from({ length: ch.comps }, () => alloc(ch.dtype, P * D)), lo: [], hi: [] }]));
      let done = 0;
      for (const plane of plan.planes) {
        const r = await this.decodePlane(plan, plane), a = arrs.get(plane.c);
        r.data.forEach((d, k) => { a.arrs[k].set(d, plane.zi * P); a.lo[k] = Math.min(a.lo[k] ?? Infinity, r.min[k]); a.hi[k] = Math.max(a.hi[k] ?? -Infinity, r.max[k]); });
        done++;
        if (progress) progress(done / plan.planes.length, 'Decoding planes ' + done + '/' + plan.planes.length);
      }
      const channels = [];
      for (const { ch, arrs: list, lo, hi } of arrs.values()) {
        list.forEach((data, k) => channels.push({ c: ch.c, comp: ch.comps > 1 ? ['B', 'G', 'R'][k] : null, comps: ch.comps, dtype: ch.dtype, data, pixelType: ch.ptName,
          range: isFinite(lo[k]) ? [lo[k], hi[k]] : [0, 0] }));
      }
      channels.sort((a, q) => (a.c - q.c) || (compOrder(a.comp) - compOrder(q.comp)));
      return { width: W, height: H, depth: D, zValues: plan.zValues, bin: plan.bin, channels, origin: { x: plan.x0, y: plan.y0 } };
    }
  }

  function compOrder(c) { return c === 'R' ? 0 : c === 'G' ? 1 : c === 'B' ? 2 : 0; }

  function isLevel0(e) {
    const X = e.dims.X, Y = e.dims.Y;
    if (!X || !Y) return false;
    if (e.pyramidType === 0 && X.stored === X.size && Y.stored === Y.size) return true;
    // tolerate ±1 rounding in stored size for level 0
    return Math.abs(X.stored - X.size) <= 1 && Math.abs(Y.stored - Y.size) <= 1;
  }

  function alloc(dtype, n) {
    if (dtype === 'uint8') return new Uint8Array(n);
    if (dtype === 'uint16') return new Uint16Array(n);
    return new Float32Array(n);
  }

  function unpackHiLo(src) {
    const n = src.length >> 1;
    const out = new Uint8Array(src.length);
    for (let i = 0; i < n; i++) { out[2 * i] = src[i]; out[2 * i + 1] = src[n + i]; }
    return out;
  }

  function aligned(raw, bytes) {
    if (raw.byteOffset % bytes === 0) return raw;
    return raw.slice();
  }

  function splitComponents(raw, w, h, pt) {
    const n = w * h;
    const r = aligned(raw, pt.sample === 'f64' ? 8 : 4);
    const samples = n * pt.comps;
    let src;
    switch (pt.sample) {
      case 'u8': src = new Uint8Array(r.buffer, r.byteOffset, samples); break;
      case 'u16': src = new Uint16Array(r.buffer, r.byteOffset, samples); break;
      case 'f32': src = new Float32Array(r.buffer, r.byteOffset, samples); break;
      case 'i32': src = new Int32Array(r.buffer, r.byteOffset, samples); break;
      case 'f64': src = new Float64Array(r.buffer, r.byteOffset, samples); break;
    }
    if (pt.comps === 1) {
      if (pt.sample === 'i32' || pt.sample === 'f64') return [Float32Array.from(src)];
      return [src];
    }
    const comps = Math.min(pt.comps, 3), out = [];
    for (let k = 0; k < comps; k++) {
      const a = new src.constructor(n);
      for (let i = 0, j = k; i < n; i++, j += pt.comps) a[i] = src[j];
      out.push(a);
    }
    return out;
  }

  async function decodeJpeg(buf, w, h, pt) {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') throw new Error('JPEG decoding is not available in this browser');
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const n = bmp.width * bmp.height;
    if (pt.comps === 1) {
      const g = new Uint8Array(n);
      for (let i = 0; i < n; i++) g[i] = px[i * 4];
      return [g];
    }
    const B = new Uint8Array(n), G = new Uint8Array(n), R = new Uint8Array(n);
    for (let i = 0; i < n; i++) { R[i] = px[i * 4]; G[i] = px[i * 4 + 1]; B[i] = px[i * 4 + 2]; }
    return [B, G, R];
  }

  function blit(src, sw, sh, dst, dw, dh, ox, oy, base) {
    const x0 = Math.max(0, -ox), y0 = Math.max(0, -oy);
    const x1 = Math.min(sw, dw - ox), y1 = Math.min(sh, dh - oy);
    if (x1 <= x0) return;
    for (let y = y0; y < y1; y++) {
      const s = y * sw, d = base + (y + oy) * dw + ox;
      dst.set(src.subarray(s + x0, s + x1), d + x0);
    }
  }

  function binPlane(src, sw, sh, bin, dst, dw, dh, base, round) {
    const inv = 1 / (bin * bin);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        let s = 0;
        for (let j = 0; j < bin; j++) {
          const row = (y * bin + j) * sw + x * bin;
          for (let i = 0; i < bin; i++) s += src[row + i];
        }
        dst[base + y * dw + x] = round ? Math.round(s * inv) : s * inv;
      }
    }
  }

  /** f × f box mean of a W×H plane (partial boxes at the right and bottom edges), for the 3D display texture. */
  function boxPlane(src, W, H, f, dtype) {
    const tw = Math.ceil(W / f), th = Math.ceil(H / f), out = alloc(dtype, tw * th), acc = new Float64Array(tw);
    const round = dtype !== 'float32', lastW = W - (tw - 1) * f;
    for (let ty = 0; ty < th; ty++) {
      acc.fill(0);
      const y0 = ty * f, y1 = Math.min(H, y0 + f);
      for (let y = y0; y < y1; y++) {
        const row = y * W;
        for (let tx = 0, x = 0; tx < tw; tx++) { const xe = Math.min(W, x + f); let s = 0; for (; x < xe; x++) s += src[row + x]; acc[tx] += s; }
      }
      const rows = y1 - y0;
      for (let tx = 0; tx < tw; tx++) { const v = acc[tx] / (rows * (tx === tw - 1 ? lastW : f)); out[ty * tw + tx] = round ? Math.round(v) : v; }
    }
    return out;
  }

  // ----------------------------------------------------------------- writer
  /**
   * Plan and produce an uncompressed CZI.
   * spec = { width, height, depth, pixelType:'Gray8'|'Gray16'|'Gray32Float', nChannels,
   *          getPlane(c, z) -> Uint8Array (little-endian bytes of one plane), xml }
   * Returns { size, parts: generator of Uint8Array/ArrayBuffer chunks in file order }.
   */
  function planCZI(spec) {
    const ptId = PIXEL_TYPE_IDS[spec.pixelType];
    if (ptId == null) throw new Error('Unsupported export pixel type ' + spec.pixelType);
    const bpp = PIXEL_TYPES[ptId].bytes;
    const W = spec.width, H = spec.height, D = spec.depth, C = spec.nChannels;
    const planeBytes = W * H * bpp;
    const DIMS = ['X', 'Y', 'C', 'Z', 'T'];
    const entryLen = 32 + DIMS.length * 20;
    const sbHeader = Math.max(256, 16 + entryLen);
    const sbUsed = sbHeader + planeBytes;
    const sbSeg = 32 + ceil32(sbUsed);
    const xmlBytes = new TextEncoder().encode(spec.xml);
    const mdUsed = 256 + xmlBytes.length;
    const mdSeg = 32 + ceil32(mdUsed);
    const nEntries = C * D;
    const dirUsed = 128 + nEntries * entryLen;
    const dirSeg = 32 + ceil32(dirUsed);

    const headerSeg = 32 + 512;
    const firstSb = headerSeg;
    const metadataPos = firstSb + nEntries * sbSeg;
    const directoryPos = metadataPos + mdSeg;
    const size = directoryPos + dirSeg;

    const guid = new Uint8Array(16);
    for (let i = 0; i < 16; i++) guid[i] = (Math.random() * 256) | 0;
    guid[6] = (guid[6] & 0x0f) | 0x40; guid[8] = (guid[8] & 0x3f) | 0x80;

    const sbPos = (c, z) => firstSb + (c * D + z) * sbSeg;

    function segHeader(u8, id, allocated, used) {
      setStr(u8, 0, id);
      const dv = new DataView(u8.buffer, u8.byteOffset, 32);
      setI64(dv, 16, allocated);
      setI64(dv, 24, used);
    }
    function writeEntry(dv, off, c, z, pos) {
      setStr(new Uint8Array(dv.buffer, dv.byteOffset), off, 'DV');
      dv.setInt32(off + 2, ptId, true);
      setI64(dv, off + 6, pos);
      dv.setInt32(off + 14, 0, true);   // file part
      dv.setInt32(off + 18, 0, true);   // uncompressed
      dv.setUint8(off + 22, 0);         // pyramid type none
      dv.setInt32(off + 28, DIMS.length, true);
      const vals = { X: [0, W], Y: [0, H], C: [c, 1], Z: [z, 1], T: [0, 1] };
      DIMS.forEach((name, i) => {
        const o = off + 32 + i * 20;
        setStr(new Uint8Array(dv.buffer, dv.byteOffset), o, name);
        dv.setInt32(o + 4, vals[name][0], true);
        dv.setInt32(o + 8, vals[name][1], true);
        dv.setFloat32(o + 12, 0, true);
        dv.setInt32(o + 16, vals[name][1], true);
      });
    }

    function* parts() {
      // file header
      const fh = new Uint8Array(headerSeg);
      segHeader(fh, 'ZISRAWFILE', 512, 512);
      const fdv = new DataView(fh.buffer);
      fdv.setInt32(32, 1, true); fdv.setInt32(36, 0, true);
      fh.set(guid, 32 + 16); fh.set(guid, 32 + 32);
      fdv.setInt32(32 + 48, 0, true);
      setI64(fdv, 32 + 52, directoryPos);
      setI64(fdv, 32 + 60, metadataPos);
      fdv.setInt32(32 + 68, 0, true);
      setI64(fdv, 32 + 72, 0);
      yield fh;
      // subblocks
      const pad = ceil32(sbUsed) - sbUsed;
      for (let c = 0; c < C; c++) {
        for (let z = 0; z < D; z++) {
          const hdr = new Uint8Array(32 + sbHeader);
          segHeader(hdr, 'ZISRAWSUBBLOCK', ceil32(sbUsed), sbUsed);
          const dv = new DataView(hdr.buffer);
          dv.setInt32(32, 0, true);          // metadata size
          dv.setInt32(36, 0, true);          // attachment size
          setI64(dv, 40, planeBytes);        // data size
          writeEntry(dv, 48, c, z, sbPos(c, z));
          yield hdr;
          const plane = spec.getPlane(c, z);
          if (plane.byteLength !== planeBytes) throw new Error('Plane size mismatch while writing CZI');
          yield plane;
          if (pad) yield new Uint8Array(pad);
        }
      }
      // metadata
      const md = new Uint8Array(32 + 256);
      segHeader(md, 'ZISRAWMETADATA', ceil32(mdUsed), mdUsed);
      const mdv = new DataView(md.buffer);
      mdv.setInt32(32, xmlBytes.length, true);
      mdv.setInt32(36, 0, true);
      yield md;
      yield xmlBytes;
      if (ceil32(mdUsed) - mdUsed) yield new Uint8Array(ceil32(mdUsed) - mdUsed);
      // directory
      const dir = new Uint8Array(dirSeg);
      segHeader(dir, 'ZISRAWDIRECTORY', ceil32(dirUsed), dirUsed);
      const ddv = new DataView(dir.buffer);
      ddv.setInt32(32, nEntries, true);
      let off = 32 + 128;
      for (let c = 0; c < C; c++) for (let z = 0; z < D; z++) { writeEntry(ddv, off, c, z, sbPos(c, z)); off += entryLen; }
      yield dir;
    }
    return { size, parts };
  }

  // ---------------------------------------------------------- metadata (main thread)
  function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function childText(el, path) {
    let cur = el;
    for (const p of path.split('/')) {
      if (!cur) return null;
      cur = Array.from(cur.children).find((c) => c.localName === p) || null;
    }
    return cur ? cur.textContent.trim() : null;
  }
  function child(el, name) { return el ? Array.from(el.children).find((c) => c.localName === name) || null : null; }
  function children(el, name) { return el ? Array.from(el.children).filter((c) => c.localName === name) : []; }
  function walk(el, path) { for (const p of path.split('/')) el = child(el, p); return el; }

  function argbToHex(s) {
    if (!s) return null;
    s = s.trim().replace('#', '');
    if (s.length === 8) s = s.slice(2);
    return s.length === 6 ? '#' + s.toLowerCase() : null;
  }

  /** Parse the CZI XML into the subset the app uses. Requires DOMParser (main thread). */
  function parseMetadata(xml) {
    const out = { scaling: { x: null, y: null, z: null }, channels: [], info: {}, doc: null };
    if (!xml) return out;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return out;
    out.doc = doc;
    const md = walk(doc.documentElement, 'Metadata') || doc.documentElement;
    const items = walk(md, 'Scaling/Items');
    for (const d of children(items, 'Distance')) {
      const id = (d.getAttribute('Id') || '').toUpperCase();
      const v = parseFloat(childText(d, 'Value'));
      if (isFinite(v) && v > 0 && 'XYZ'.includes(id) && id) out.scaling[id.toLowerCase()] = v * 1e6; // µm
    }
    const img = walk(md, 'Information/Image');
    const info = out.info;
    if (img) {
      info.pixelType = childText(img, 'PixelType');
      info.bitCount = parseInt(childText(img, 'ComponentBitCount')) || null;
      info.sizeX = childText(img, 'SizeX'); info.sizeY = childText(img, 'SizeY'); info.sizeZ = childText(img, 'SizeZ');
      info.sizeC = childText(img, 'SizeC'); info.sizeT = childText(img, 'SizeT'); info.sizeS = childText(img, 'SizeS');
      info.acquired = childText(img, 'AcquisitionDateAndTime');
    }
    const dimCh = children(walk(img, 'Dimensions/Channels'), 'Channel');
    const dispCh = children(walk(md, 'DisplaySetting/Channels'), 'Channel');
    const n = Math.max(dimCh.length, dispCh.length);
    for (let i = 0; i < n; i++) {
      const a = dimCh[i], b = dispCh[i];
      const name = (a && a.getAttribute('Name')) || (b && b.getAttribute('Name')) || (b && childText(b, 'ShortName')) || ('Channel ' + (i + 1));
      const color = argbToHex((b && childText(b, 'Color')) || (a && childText(a, 'Color')));
      const ch = {
        name, color,
        low: b ? parseFloat(childText(b, 'Low')) : NaN,
        high: b ? parseFloat(childText(b, 'High')) : NaN,
        gamma: b ? parseFloat(childText(b, 'Gamma')) : NaN,
        excitation: a ? childText(a, 'ExcitationWavelength') : null,
        emission: a ? childText(a, 'EmissionWavelength') : null,
        fluor: a ? childText(a, 'Fluor') : null,
        mode: a ? childText(a, 'AcquisitionMode') : null,
        pinhole: a ? childText(a, 'PinholeSizeAiry') : null,
        node: a || null,
      };
      out.channels.push(ch);
    }
    const inst = walk(md, 'Information/Instrument');
    const obj = child(walk(inst, 'Objectives'), 'Objective');
    if (obj) {
      info.objective = obj.getAttribute('Name') || childText(obj, 'Manufacturer/Model');
      info.na = parseFloat(childText(obj, 'LensNA')) || null;
      info.magnification = parseFloat(childText(obj, 'NominalMagnification')) || null;
      info.immersion = childText(obj, 'Immersion');
    }
    const mic = child(walk(inst, 'Microscopes'), 'Microscope');
    if (mic) info.microscope = mic.getAttribute('Name') || childText(mic, 'System');
    const docEl = walk(md, 'Information/Document');
    if (docEl) {
      info.title = childText(docEl, 'Title') || childText(docEl, 'Name');
      info.created = childText(docEl, 'CreationDate');
      info.user = childText(docEl, 'UserName');
      info.comment = childText(docEl, 'Comment');
      info.description = childText(docEl, 'Description');
    }
    info.application = childText(walk(md, 'Information/Application') || md, 'Name');
    return out;
  }

  /**
   * Build ImageDocument XML for an exported file.
   * o = { name, width, height, depth, pixelType, bitCount, scaling:{x,y,z} (µm),
   *       channels:[{name, color:'#rrggbb', low, high (0..1 of type range), gamma, sourceNode (Element|null), history:[str]}],
   *       sourceDoc (Document|null), description }
   */
  function buildMetadataXML(o) {
    const argb = (hex) => '#FF' + (hex || '#ffffff').replace('#', '').toUpperCase();
    const ser = typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : null;
    const skip = new Set(['PixelType', 'ComponentBitCount', 'Color']);
    let chDims = '', chDisp = '';
    o.channels.forEach((c, i) => {
      let extra = '';
      if (c.sourceNode && ser) {
        for (const el of Array.from(c.sourceNode.children)) {
          if (skip.has(el.localName)) continue;
          extra += ser.serializeToString(el).replace(/ xmlns(:\w+)?="[^"]*"/g, '');
        }
      }
      chDims += `<Channel Id="Channel:${i}" Name="${xmlEsc(c.name)}"><PixelType>${o.pixelType}</PixelType><ComponentBitCount>${o.bitCount}</ComponentBitCount><Color>${argb(c.color)}</Color>${extra}</Channel>`;
      const range = o.pixelType === 'Gray8' ? '<BitCountRange>8</BitCountRange>' : o.pixelType === 'Gray16' ? '<BitCountRange>16</BitCountRange>' : '';
      chDisp += `<Channel Id="Channel:${i}" Name="${xmlEsc(c.name)}">${range}<Color>${argb(c.color)}</Color><ColorMode>Color</ColorMode><Gamma>${num(c.gamma, 1)}</Gamma><High>${num(c.high, 1)}</High><Low>${num(c.low, 0)}</Low><IsSelected>${i === 0 ? 'true' : 'false'}</IsSelected><PixelType>${o.pixelType}</PixelType><ShortName>${xmlEsc(c.name.slice(0, 12))}</ShortName></Channel>`;
    });
    let instrument = '';
    if (o.sourceDoc && ser) {
      const inst = walk(walk(o.sourceDoc.documentElement, 'Metadata'), 'Information/Instrument');
      if (inst) instrument = ser.serializeToString(inst).replace(/ xmlns(:\w+)?="[^"]*"/g, '');
    }
    const dist = (id, v) => `<Distance Id="${id}"><Value>${(v * 1e-6).toExponential(12)}</Value><DefaultUnitFormat>µm</DefaultUnitFormat></Distance>`;
    const now = new Date().toISOString();
    return '<?xml version="1.0" encoding="utf-8"?>' +
      '<ImageDocument><Metadata>' +
      '<Information>' +
      `<Application><Name>SynaptoSnap</Name><Version>1.0</Version></Application>` +
      `<Document><Name>${xmlEsc(o.name)}</Name><Title>${xmlEsc(o.name)}</Title><CreationDate>${now}</CreationDate>` +
      `<Comment>Exported from SynaptoSnap</Comment><Description>${xmlEsc(o.description || '')}</Description></Document>` +
      `<Image><PixelType>${o.pixelType}</PixelType><ComponentBitCount>${o.bitCount}</ComponentBitCount>` +
      `<SizeX>${o.width}</SizeX><SizeY>${o.height}</SizeY><SizeZ>${o.depth}</SizeZ><SizeC>${o.channels.length}</SizeC><SizeT>1</SizeT>` +
      `<Dimensions><Channels>${chDims}</Channels></Dimensions></Image>` +
      instrument +
      '</Information>' +
      `<Scaling><Items>${dist('X', o.scaling.x)}${dist('Y', o.scaling.y)}${dist('Z', o.scaling.z)}</Items></Scaling>` +
      `<DisplaySetting><Channels>${chDisp}</Channels></DisplaySetting>` +
      '</Metadata></ImageDocument>';
  }
  function num(v, d) { return isFinite(v) ? +(+v).toFixed(6) : d; }

  return { CZIReader, planCZI, parseMetadata, buildMetadataXML, PIXEL_TYPES, COMPRESSION };
}
