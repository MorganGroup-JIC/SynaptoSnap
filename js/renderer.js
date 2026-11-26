/* CZI Volume Studio — WebGL2 ray-marching volume renderer with a 2D overlay. */
const M4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  inv(m) {
    const inv = new Float32Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    det = det ? 1 / det : 0;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  },
  persp(fovy, aspect, n, f) {
    const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
    o[0] = t / aspect; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f);
    return o;
  },
  ortho(l, r, b, t, n, f) {
    const o = new Float32Array(16);
    o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n);
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1;
    return o;
  },
  apply(m, p) {
    const x = p[0], y = p[1], z = p[2], w = p.length > 3 ? p[3] : 1;
    return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w];
  },
};

/* Orbit camera: R = rows are the camera x/y/z axes expressed in world coordinates. */
class Camera {
  constructor() { this.reset(); }
  reset(view = 'oblique') {
    this.target = [0, 0, 0];
    this.dist = 2.4;
    this.fov = 30;
    this.R = Camera.preset('xy');
    if (view === 'oblique') { this.rotate(0.55, 0); this.rotate(0, 0.6); }
    else this.R = Camera.preset(view);
  }
  static preset(v) {
    if (v === 'xz') return [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
    if (v === 'yz') return [[0, 1, 0], [0, 0, -1], [-1, 0, 0]];
    return [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  }
  // rotate about the camera's own y (horizontal drag) and x (vertical drag) axes
  rotate(ax, ay) {
    const rot = (R, axis, ang) => {
      const c = Math.cos(ang), s = Math.sin(ang);
      const a = axis === 'y' ? [0, 2] : [1, 2];
      const out = R.map((r) => r.slice());
      // rotate rows a[0], a[1] in their plane (camera-space rotation)
      for (let k = 0; k < 3; k++) {
        const u = R[a[0]][k], v = R[a[1]][k];
        out[a[0]][k] = c * u + (axis === 'y' ? -s : s) * v;
        out[a[1]][k] = (axis === 'y' ? s : -s) * u + c * v;
      }
      return out;
    };
    let R = this.R;
    if (ax) R = rot(R, 'y', ax);
    if (ay) R = rot(R, 'x', ay);
    this.R = Camera.orthonormalize(R);
  }
  roll(a) {
    const c = Math.cos(a), s = Math.sin(a), R = this.R;
    const x = R[0].map((v, k) => c * v + s * R[1][k]), y = R[1].map((v, k) => -s * R[0][k] + c * v);
    this.R = Camera.orthonormalize([x, y, R[2]]);
  }
  static orthonormalize(R) {
    const n = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((x) => x / l); };
    const z = n(R[2]);
    let x = n(R[0]);
    const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
    x = n(x.map((v, k) => v - d * z[k]));
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return [x, y, z];
  }
  pan(dx, dy, viewHeightWorld) {
    const R = this.R;
    for (let k = 0; k < 3; k++) this.target[k] -= (R[0][k] * dx - R[1][k] * dy) * viewHeightWorld;
  }
  eye() { return this.target.map((t, k) => t + this.dist * this.R[2][k]); }
  view() {
    const R = this.R, e = this.eye(), V = new Float32Array(16);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) V[c * 4 + r] = R[r][c];
      V[12 + r] = -(R[r][0] * e[0] + R[r][1] * e[1] + R[r][2] * e[2]);
    }
    V[15] = 1;
    return V;
  }
  viewHeight() { return 2 * this.dist * Math.tan(this.fov * Math.PI / 360); }
  proj(aspect, ortho) {
    const near = Math.max(0.001, this.dist - 4), far = this.dist + 4;
    if (ortho) { const h = this.viewHeight() / 2; return M4.ortho(-h * aspect, h * aspect, -h, h, near, far); }
    return M4.persp(this.fov * Math.PI / 180, aspect, Math.max(0.01, this.dist * 0.05), far);
  }
}

class VolumeRenderer {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available. Use a recent Edge or Chrome with hardware acceleration enabled.');
    this.gl = gl;
    this.maxTex3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    this.textures = new Map(); // layerId -> {tex, dims, factor, kind}
    this.programs = new Map();
    this.camera = new Camera();
    this.dims = [1, 1, 1];
    this.spacing = [1, 1, 1];
    this.scale = 1;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.vao = gl.createVertexArray();
    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = null; this.fboTex = null; this.fboSize = [0, 0];
    this.blitProg = this._link(VolumeRenderer.VS, `#version 300 es
      precision highp float; in vec2 v_ndc; out vec4 o; uniform sampler2D u_img;
      void main(){ o = texture(u_img, v_ndc*0.5+0.5); }`);
    this.dummy3D = this._makeTex3D(gl.R8, gl.RED, gl.UNSIGNED_BYTE, [1, 1, 1], new Uint8Array(1), false);
    this.dummyU3D = this._makeTex3D(gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, [1, 1, 1], new Uint16Array(1), true);
  }

  setGeometry(dims, spacing) {
    this.dims = dims.slice();
    this.spacing = spacing.slice();
    const ext = dims.map((d, i) => d * spacing[i]);
    const m = Math.max(...ext);
    this.extent = ext.map((e) => e / m);
    this.maxExtentUm = m;
  }

  // -------------------------------------------------------------- textures
  _makeTex3D(internal, format, type, dims, data, integer) {
    const gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    const f = integer ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, f);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_3D, 1, internal, dims[0], dims[1], dims[2]);
    if (data) gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, dims[0], dims[1], dims[2], format, type, data);
    return tex;
  }

  /** Downsampling factors so that the texture fits limits. budget = max voxels per texture. */
  textureFactors(budget) {
    const [W, H, D] = this.dims, max = this.maxTex3D;
    let fz = Math.max(1, Math.ceil(D / max)), fxy = Math.max(1, Math.ceil(Math.max(W, H) / max));
    while ((Math.ceil(W / fxy) * Math.ceil(H / fxy) * Math.ceil(D / fz)) > budget) fxy++;
    return [fxy, fz];
  }

  uploadLayer(layer, budget) {
    const gl = this.gl;
    this.deleteLayer(layer.id);
    const [W, H, D] = this.dims;
    const [fxy, fz] = this.textureFactors(budget);
    const tw = Math.ceil(W / fxy), th = Math.ceil(H / fxy), td = Math.ceil(D / fz);
    const src = layer.data, P = W * H;
    let tex;
    if (layer.kind === 'labels') {
      const u32 = src instanceof Uint32Array;
      tex = this._makeTex3D(u32 ? gl.R32UI : gl.R16UI, gl.RED_INTEGER, u32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, [tw, th, td], null, true);
      const slice = u32 ? new Uint32Array(tw * th) : new Uint16Array(tw * th);
      for (let z = 0; z < td; z++) {
        const sz = Math.min(D - 1, z * fz);
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) slice[y * tw + x] = src[sz * P + Math.min(H - 1, y * fxy) * W + Math.min(W - 1, x * fxy)];
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, tw, th, 1, gl.RED_INTEGER, u32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, slice);
      }
    } else {
      // 8-bit data -> R8; everything else -> R16F, converted to half floats here (letting the driver
      // convert FLOAT data is extremely slow on some Windows/ANGLE setups).
      const [lo, hi] = layer.range;
      const sc = 1 / ((hi - lo) || 1);
      const use8 = layer.dtype === 'uint8';
      const type = use8 ? gl.UNSIGNED_BYTE : gl.HALF_FLOAT;
      tex = this._makeTex3D(use8 ? gl.R8 : gl.R16F, gl.RED, type, [tw, th, td], null, false);
      const slice = new (use8 ? Uint8Array : Uint16Array)(tw * th);
      const HALF = VolumeRenderer.halfTable();
      let rawTab = null;
      if (layer.dtype === 'uint16') {
        rawTab = new Uint16Array(65536);
        for (let r = 0; r < 65536; r++) { let v = (r - lo) * sc; v = v < 0 ? 0 : v > 1 ? 1 : v; rawTab[r] = HALF[Math.round(v * 65535)]; }
      }
      const enc = use8 ? (v) => v * 255 : (v) => { let q = (v * 65535 + 0.5) | 0; q = q < 0 ? 0 : q > 65535 ? 65535 : q; return HALF[q]; };
      for (let z = 0; z < td; z++) {
        if (fxy === 1 && fz === 1) {
          const o = z * P;
          if (rawTab) for (let i = 0; i < P; i++) slice[i] = rawTab[src[o + i]];
          else if (use8) { const m = 255 * sc; for (let i = 0; i < P; i++) slice[i] = (src[o + i] - lo) * m; }
          else { const m = 65535 * sc; for (let i = 0; i < P; i++) { let q = ((src[o + i] - lo) * m + 0.5) | 0; q = q < 0 ? 0 : q > 65535 ? 65535 : q; slice[i] = HALF[q]; } }
        } else {
          for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
            let s = 0, c = 0;
            for (let dz = 0; dz < fz; dz++) {
              const zz = z * fz + dz; if (zz >= D) break;
              for (let dy = 0; dy < fxy; dy++) {
                const yy = y * fxy + dy; if (yy >= H) break;
                const row = zz * P + yy * W;
                for (let dx = 0; dx < fxy; dx++) { const xx = x * fxy + dx; if (xx >= W) break; s += src[row + xx]; c++; }
              }
            }
            slice[y * tw + x] = enc(((c ? s / c : 0) - lo) * sc);
          }
        }
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, tw, th, 1, gl.RED, type, slice);
      }
    }
    this.textures.set(layer.id, { tex, dims: [tw, th, td], factor: [fxy, fz], kind: layer.kind, range: layer.range.slice() });
    return { dims: [tw, th, td], factor: [fxy, fz] };
  }

  /** Lookup: q in 0..65535 (value q/65535) -> IEEE half-float bits, round-to-nearest. */
  static halfTable() {
    if (VolumeRenderer._half) return VolumeRenderer._half;
    const t = new Uint16Array(65536), f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
    for (let q = 0; q < 65536; q++) {
      f32[0] = q / 65535;
      const x = u32[0], e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
      if (q === 0) t[q] = 0;
      else if (e <= 0) t[q] = e < -10 ? 0 : (((m | 0x800000) >> (1 - e)) + 0x1000) >> 13;
      else t[q] = (e << 10) + ((m + 0x1000) >> 13);
    }
    VolumeRenderer._half = t;
    return t;
  }

  deleteLayer(id) {
    const t = this.textures.get(id);
    if (t) { this.gl.deleteTexture(t.tex); this.textures.delete(id); }
  }
  clear() { for (const id of Array.from(this.textures.keys())) this.deleteLayer(id); }

  // -------------------------------------------------------------- shaders
  static get VS() {
    return `#version 300 es
      out vec2 v_ndc;
      void main(){ vec2 p = vec2((gl_VertexID==1)?3.0:-1.0, (gl_VertexID==2)?3.0:-1.0); v_ndc = p; gl_Position = vec4(p,0.0,1.0); }`;
  }

  _link(vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile error: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link error: ' + gl.getProgramInfoLog(p));
    p.loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const u = gl.getActiveUniform(p, i), name = u.name.replace(/\[0\]$/, '');
      p.loc[name] = gl.getUniformLocation(p, u.name);
    }
    return p;
  }

  _program(n, mode, labels) {
    const key = n + '|' + mode + '|' + labels;
    if (this.programs.has(key)) return this.programs.get(key);
    const p = this._link(VolumeRenderer.VS, VolumeRenderer.fragment(n, mode, labels));
    this.programs.set(key, p);
    return p;
  }

  static fragment(n, mode, labels) {
    const N = Math.max(1, n);
    const R = (f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
    let decl = R((i) => `uniform sampler3D u_v${i};`);
    let body = '';
    const sample = (i, p = 'p') => `texture(u_v${i}, ${p}).r`;
    const norm = (i, v) => `clamp((${v} - u_clim[${i}].x) / max(u_clim[${i}].y - u_clim[${i}].x, 1e-6), 0.0, 1.0)`;
    const lut = (i, v) => `texture(u_lut, vec2(${v}, (float(${i}) + 0.5) / u_lutRows)).rgb`;
    const labStep = labels ? `
        if (!labHit) { uint id = texture(u_lab, p).r; if (id != 0u && !labHidden(id) && (u_labSel == 0u || id == u_labSel || u_labOnlySel == 0)) { labHit = true; labId = id; labT = t; LABINLINE } }` : '';
    const inlineLab = `vec4 lc = labelShade(labId, ro + rd * labT, rdw); acc.rgb += (1.0 - acc.a) * lc.rgb * lc.a; acc.a += (1.0 - acc.a) * lc.a;`;
    if (mode === 'mip' || mode === 'minip' || mode === 'avg' || mode === 'amip') {
      const init = mode === 'minip' ? '1.0' : '0.0';
      body += R((i) => `float m${i} = ${init}; float s${i} = 0.0;`) + '\nfloat cnt = 0.0;\n';
      body += `for (int it = 0; it < 8192; it++) { if (t > tb.y) break; vec3 p = ro + rd * t;\n`;
      body += R((i) => {
        if (mode === 'mip') return `m${i} = max(m${i}, ${sample(i)});`;
        if (mode === 'minip') return `m${i} = min(m${i}, ${sample(i)});`;
        if (mode === 'avg') return `m${i} += ${sample(i)};`;
        return `{ float v = ${norm(i, sample(i))}; s${i} += v * stepLen * u_atten; m${i} = max(m${i}, v * exp(-s${i})); }`;
      });
      body += `cnt += 1.0; ${labStep.replace('LABINLINE', '')}\n`;
      if (mode === 'mip') body += `if (${R((i) => `m${i} >= u_clim[${i}].y`).split('\n').join(' && ')}) { ${labels ? 'if (labHit) break;' : 'break;'} }\n`;
      body += `t += dt; }\nvec3 col = vec3(0.0);\n`;
      body += R((i) => {
        const v = mode === 'amip' ? `m${i}` : mode === 'avg' ? norm(i, `m${i} / max(cnt, 1.0)`) : norm(i, `m${i}`);
        return `{ float v = pow(${v}, u_gamma[${i}]); col += ${lut(i, 'v')} * u_opac[${i}]; }`;
      });
      body += `\nvec4 acc = vec4(min(col, vec3(1.0)), 1.0);\n`;
      if (labels) body += `if (labHit) { vec4 lc = labelShade(labId, ro + rd * labT, rdw); acc.rgb = mix(acc.rgb, lc.rgb, lc.a); }\n`;
      body += `o = vec4(acc.rgb, 1.0);`;
    } else if (mode === 'dvr') {
      body += `vec4 acc = vec4(0.0); float sv = stepLen * u_refVox;\n`;
      body += `for (int it = 0; it < 8192; it++) { if (t > tb.y) break; vec3 p = ro + rd * t; vec3 cs = vec3(0.0); float as = 0.0; float trans = 1.0;\n`;
      body += R((i) => `{ float v = pow(${norm(i, sample(i))}, u_gamma[${i}]); float a = clamp(v * u_opac[${i}] * u_density, 0.0, 1.0); cs += ${lut(i, 'v')} * a; as += a; trans *= (1.0 - a); }`);
      body += `\nfloat alpha = 1.0 - pow(trans, sv); if (alpha > 0.0001) { vec3 c = cs / max(as, 1e-6); acc.rgb += (1.0 - acc.a) * c * alpha; acc.a += (1.0 - acc.a) * alpha; }\n`;
      body += labStep.replace('LABINLINE', inlineLab);
      body += `if (acc.a > 0.995) break; t += dt; }\n`;
      body += `o = vec4(acc.rgb + (1.0 - acc.a) * u_bg, 1.0);`;
    } else if (mode === 'iso') {
      body += `vec4 acc = vec4(0.0);\n` + R((i) => `bool in${i} = false;`) + '\n';
      body += `for (int it = 0; it < 8192; it++) { if (t > tb.y) break; vec3 p = ro + rd * t;\n`;
      body += R((i) => `{ float v = ${sample(i)};
          if (!in${i} && v >= u_iso[${i}] && u_opac[${i}] > 0.0) {
            float ta = max(t - dt, tb.x), tc = t;
            for (int k = 0; k < 6; k++) { float tm = 0.5 * (ta + tc); if (texture(u_v${i}, ro + rd * tm).r >= u_iso[${i}]) tc = tm; else ta = tm; }
            vec3 q = ro + rd * tc; vec3 h = 1.0 / u_tdims;
            vec3 g = vec3(texture(u_v${i}, q + vec3(h.x,0,0)).r - texture(u_v${i}, q - vec3(h.x,0,0)).r,
                          texture(u_v${i}, q + vec3(0,h.y,0)).r - texture(u_v${i}, q - vec3(0,h.y,0)).r,
                          texture(u_v${i}, q + vec3(0,0,h.z)).r - texture(u_v${i}, q - vec3(0,0,h.z)).r) / u_ext;
            vec3 c = ${lut(i, '1.0')} * shade(-g, rdw);
            float a = u_opac[${i}];
            acc.rgb += (1.0 - acc.a) * c * a; acc.a += (1.0 - acc.a) * a; in${i} = true;
          } else if (in${i} && v < u_iso[${i}]) in${i} = false; }`);
      body += labStep.replace('LABINLINE', inlineLab);
      body += `\nif (acc.a > 0.99) break; t += dt; }\n`;
      body += `o = vec4(acc.rgb + (1.0 - acc.a) * u_bg, 1.0);`;
    }
    if (n === 0) {
      decl = '';
      body = `vec4 acc = vec4(0.0);
        for (int it = 0; it < 8192; it++) { if (t > tb.y) break; vec3 p = ro + rd * t; ${labStep.replace('LABINLINE', inlineLab)} if (acc.a > 0.99) break; t += dt; }
        o = vec4(acc.rgb + (1.0 - acc.a) * u_bg, 1.0);`;
    }
    return `#version 300 es
precision highp float; precision highp int; precision highp sampler3D; precision highp usampler3D;
in vec2 v_ndc; out vec4 o;
uniform mat4 u_inv; uniform vec3 u_boxMin, u_boxMax; uniform vec4 u_plane; uniform int u_planeOn;
uniform vec3 u_tdims; uniform vec3 u_ext; uniform float u_quality; uniform vec3 u_bg; uniform float u_refVox;
uniform sampler2D u_lut; uniform float u_lutRows;
uniform vec2 u_clim[${N}]; uniform float u_gamma[${N}]; uniform float u_opac[${N}]; uniform float u_iso[${N}];
uniform float u_density; uniform float u_atten;
${decl}
${labels ? 'uniform usampler3D u_lab; uniform float u_labOpac; uniform uint u_labSel; uniform int u_labOnlySel; uniform uint u_labHide; uniform vec3 u_ldims;' : ''}
vec2 hitBox(vec3 o, vec3 d, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / d; vec3 t0 = (bmin - o) * inv, t1 = (bmax - o) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}
float shade(vec3 nrm, vec3 rdw) {
  float l = length(nrm); if (l < 1e-8) return 0.85;
  vec3 N = nrm / l; vec3 L = -normalize(rdw);
  float d = abs(dot(N, L)); vec3 H = normalize(L + L);
  float s = pow(abs(dot(N, H)), 40.0);
  return 0.28 + 0.72 * d + 0.25 * s;
}
${labels ? `
vec3 labelColor(uint id) {
  float f = float(id);
  float h = fract(f * 0.618033988749895), s = 0.55 + 0.45 * fract(f * 0.3819660113), v = 0.8 + 0.2 * fract(f * 0.7548776662);
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + h * 6.0, 6.0);
  return v - v * s * clamp(min(k, 4.0 - k), 0.0, 1.0);
}
float occ(uint id, vec3 q) { return texture(u_lab, q).r == id ? 1.0 : 0.0; }
bool labHidden(uint id) { return id <= 32u && (u_labHide & (1u << (id - 1u))) != 0u; } // chromosomes hidden in the trace panel
vec4 labelShade(uint id, vec3 q, vec3 rdw) {
  vec3 h = 1.0 / u_ldims;
  vec3 g = vec3(occ(id, q + vec3(h.x,0,0)) - occ(id, q - vec3(h.x,0,0)), occ(id, q + vec3(0,h.y,0)) - occ(id, q - vec3(0,h.y,0)), occ(id, q + vec3(0,0,h.z)) - occ(id, q - vec3(0,0,h.z))) / u_ext;
  vec3 c = labelColor(id);
  float a = u_labOpac;
  if (u_labSel != 0u) { if (id == u_labSel) { c = mix(c, vec3(1.0), 0.35); a = 1.0; } else a *= 0.25; }
  return vec4(c * shade(-g, rdw), a);
}` : ''}
void main() {
  vec4 a = u_inv * vec4(v_ndc, -1.0, 1.0); vec4 b = u_inv * vec4(v_ndc, 1.0, 1.0);
  vec3 ro = a.xyz / a.w; vec3 rd = b.xyz / b.w - ro;
  rd += 1e-7 * vec3(equal(rd, vec3(0.0)));
  vec3 rdw = rd * u_ext;
  vec2 tb = hitBox(ro, rd, u_boxMin, u_boxMax);
  tb.x = max(tb.x, 0.0);
  if (u_planeOn == 1) {
    float dn = dot(u_plane.xyz, rd), s0 = dot(u_plane.xyz, ro) + u_plane.w;
    if (abs(dn) < 1e-12) { if (s0 < 0.0) tb = vec2(1.0, 0.0); }
    else { float tp = -s0 / dn; if (dn > 0.0) tb.x = max(tb.x, tp); else tb.y = min(tb.y, tp); }
  }
  if (tb.x >= tb.y) { o = vec4(u_bg, 1.0); return; }
  vec3 vd = abs(rd * u_tdims);
  float dt = 1.0 / (u_quality * max(max(vd.x, vd.y), vd.z));
  dt = max(dt, (tb.y - tb.x) / 8000.0);
  float stepLen = length(rdw) * dt;
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float t = tb.x + dt * jit;
  ${labels ? 'bool labHit = false; uint labId = 0u; float labT = 0.0;' : ''}
  ${body}
  ${mode === 'mip' || mode === 'avg' || mode === 'amip' || mode === 'minip' ? '' : ''}
}`;
  }

  // ---------------------------------------------------------------- render
  _ensureFBO(w, h) {
    const gl = this.gl;
    if (this.fbo && this.fboSize[0] === w && this.fboSize[1] === h) return;
    if (this.fbo) { gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.fboTex); }
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fboSize = [w, h];
  }

  matrices() {
    const w = this.canvas.width, h = this.canvas.height;
    const ext = this.extent || [1, 1, 1];
    const Mm = new Float32Array(16);
    Mm[0] = ext[0]; Mm[5] = ext[1]; Mm[10] = ext[2]; Mm[15] = 1;
    Mm[12] = -0.5 * ext[0]; Mm[13] = -0.5 * ext[1]; Mm[14] = -0.5 * ext[2];
    const P = this.camera.proj(w / h, this.ortho);
    const V = this.camera.view();
    const MVP = M4.mul(P, M4.mul(V, Mm));
    return { MVP, inv: M4.inv(MVP), P, V };
  }

  /**
   * s = { layers:[{id, clim:[lo,hi] (data units), gamma, opacity, iso (data units), lut:Uint8Array(768)}],
   *       labels: {id, opacity, selected, onlySelected} | null, mode, quality, density, attenuation,
   *       bg:[r,g,b], box:[x0,y0,z0,x1,y1,z1] (0..1), plane:{on, normal:[..], offset}, scale (render scale) }
   */
  render(s) {
    const gl = this.gl, cw = this.canvas.width, ch = this.canvas.height;
    const scale = s.scale || 1;
    const rw = Math.max(1, Math.round(cw * scale)), rh = Math.max(1, Math.round(ch * scale));
    const layers = s.layers.filter((l) => this.textures.has(l.id)).slice(0, 6);
    const lab = s.labels && this.textures.has(s.labels.id) ? s.labels : null;
    if (!layers.length && !lab) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(s.bg[0], s.bg[1], s.bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
      this.lastMatrices = this.matrices();
      return;
    }
    const prog = this._program(layers.length, s.mode, !!lab);
    this._ensureFBO(rw, rh); // before binding the LUT: creating the target texture rebinds unit 0
    // LUT atlas
    const rows = Math.max(1, layers.length);
    const atlas = new Uint8Array(256 * rows * 4);
    layers.forEach((l, r) => { for (let i = 0; i < 256; i++) { const o = (r * 256 + i) * 4; atlas[o] = l.lut[i * 3]; atlas[o + 1] = l.lut[i * 3 + 1]; atlas[o + 2] = l.lut[i * 3 + 2]; atlas[o + 3] = 255; } });
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, rw, rh);
    gl.useProgram(prog);
    const L = prog.loc;
    const M = this.matrices();
    this.lastMatrices = M;
    gl.uniformMatrix4fv(L.u_inv, false, M.inv);
    const box = s.box || [0, 0, 0, 1, 1, 1];
    gl.uniform3f(L.u_boxMin, box[0], box[1], box[2]);
    gl.uniform3f(L.u_boxMax, box[3], box[4], box[5]);
    const pl = s.plane || { on: false };
    gl.uniform1i(L.u_planeOn, pl.on ? 1 : 0);
    if (pl.on) gl.uniform4f(L.u_plane, pl.normal[0], pl.normal[1], pl.normal[2], pl.offset);
    const ref = layers.length ? this.textures.get(layers[0].id) : this.textures.get(lab.id);
    gl.uniform3fv(L.u_tdims, ref.dims);
    gl.uniform1f(L.u_refVox, Math.max(...ref.dims));
    gl.uniform3fv(L.u_ext, this.extent);
    gl.uniform1f(L.u_quality, (s.quality || 1));
    gl.uniform3fv(L.u_bg, s.bg);
    gl.uniform1i(L.u_lut, 0);
    gl.uniform1f(L.u_lutRows, rows);
    if (L.u_density) gl.uniform1f(L.u_density, s.density || 1);
    if (L.u_atten) gl.uniform1f(L.u_atten, s.attenuation || 1);
    const clim = [], gam = [], opa = [], iso = [];
    layers.forEach((l, i) => {
      const t = this.textures.get(l.id), [lo, hi] = t.range, r = (hi - lo) || 1;
      clim.push((l.clim[0] - lo) / r, (l.clim[1] - lo) / r);
      gam.push(l.gamma); opa.push(l.opacity); iso.push((l.iso - lo) / r);
      gl.activeTexture(gl.TEXTURE1 + i);
      gl.bindTexture(gl.TEXTURE_3D, t.tex);
      gl.uniform1i(L['u_v' + i], 1 + i);
    });
    if (layers.length) {
      gl.uniform2fv(L.u_clim, clim); gl.uniform1fv(L.u_gamma, gam); gl.uniform1fv(L.u_opac, opa);
      if (L.u_iso) gl.uniform1fv(L.u_iso, iso);
    }
    if (lab) {
      const t = this.textures.get(lab.id);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_3D, t.tex);
      gl.uniform1i(L.u_lab, 7);
      gl.uniform1f(L.u_labOpac, lab.opacity);
      gl.uniform1ui(L.u_labSel, lab.selected || 0);
      gl.uniform1i(L.u_labOnlySel, lab.onlySelected ? 1 : 0);
      if (L.u_labHide) gl.uniform1ui(L.u_labHide, lab.hide >>> 0);
      gl.uniform3fv(L.u_ldims, t.dims);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // blit
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.useProgram(this.blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(this.blitProg.loc.u_img, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Project texture-space point (0..1) to canvas CSS pixels. Returns [x,y,depth] or null. */
  project(p, M) {
    const c = M4.apply(M.MVP, [p[0], p[1], p[2], 1]);
    if (c[3] <= 0) return null;
    const dpr = this.canvas.width / this.overlay.clientWidth || 1;
    return [(c[0] / c[3] * 0.5 + 0.5) * this.canvas.width / dpr, (1 - (c[1] / c[3] * 0.5 + 0.5)) * this.canvas.height / dpr, c[2] / c[3]];
  }

  drawOverlay(o) {
    const ctx = this.octx, W = this.overlay.width, H = this.overlay.height;
    const dpr = W / (this.overlay.clientWidth || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const M = this.lastMatrices || this.matrices();
    const box = o.box || [0, 0, 0, 1, 1, 1];
    if (o.showBox) {
      const C = [];
      for (let i = 0; i < 8; i++) C.push(this.project([i & 1 ? box[3] : box[0], i & 2 ? box[4] : box[1], i & 4 ? box[5] : box[2]], M));
      const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
      ctx.strokeStyle = o.boxColor || 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [a, b] of E) if (C[a] && C[b]) { ctx.moveTo(C[a][0], C[a][1]); ctx.lineTo(C[b][0], C[b][1]); }
      ctx.stroke();
    }
    if (o.points && o.points.visible && o.points.list.length) {
      const [W3, H3, D3] = this.dims;
      ctx.fillStyle = o.points.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      const r = o.points.size;
      const list = o.points.list;
      const pl = o.plane && o.plane.on ? o.plane : null;
      for (let i = 0; i < list.length; i++) {
        const q = list[i];
        const tp = [(q.x + 0.5) / W3, (q.y + 0.5) / H3, (q.z + 0.5) / D3];
        if (tp[0] < box[0] || tp[0] > box[3] || tp[1] < box[1] || tp[1] > box[4] || tp[2] < box[2] || tp[2] > box[5]) continue;
        if (pl && pl.normal[0] * tp[0] + pl.normal[1] * tp[1] + pl.normal[2] * tp[2] + pl.offset < 0) continue;
        const s = this.project(tp, M);
        if (!s) continue;
        ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, 6.2832); ctx.fill();
        if (r > 2) ctx.stroke();
      }
    }
    if (o.lines && o.lines.length) {
      const [W3, H3, D3] = this.dims, [sx, sy, sz] = this.spacing;
      const pl = o.plane && o.plane.on ? o.plane : null;
      const toTex = (p) => [(p[0] / sx + 0.5) / W3, (p[1] / sy + 0.5) / H3, (p[2] / sz + 0.5) / D3];
      const inside = (t) => t[0] >= box[0] && t[0] <= box[3] && t[1] >= box[1] && t[1] <= box[4] && t[2] >= box[2] && t[2] <= box[5] &&
        (!pl || pl.normal[0] * t[0] + pl.normal[1] * t[1] + pl.normal[2] * t[2] + pl.offset >= 0);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const proj = (p) => { const t = toTex(p); return inside(t) ? this.project(t, M) : null; };
      for (const l of o.lines) {
        ctx.globalAlpha = l.alpha != null ? l.alpha : 1;
        ctx.strokeStyle = l.color; ctx.lineWidth = l.width; ctx.setLineDash(l.dash || []);
        ctx.beginPath();
        let prev = null;
        for (const p of l.pts) {
          const s = proj(p);
          if (s && prev) ctx.lineTo(s[0], s[1]); else if (s) ctx.moveTo(s[0], s[1]);
          prev = s;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const e of o.ends || []) {
        const s = proj(e.p);
        if (!s) continue;
        if (e.label && window.drawNumberBadge) { window.drawNumberBadge(ctx, s[0], s[1], e.color, e.label); continue; }
        ctx.fillStyle = e.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(s[0], s[1], 4.5, 0, 6.2832); ctx.fill(); ctx.stroke();
      }
    }
    if (o.showAxes) {
      const R = this.camera.R, x0 = 46, y0 = this.overlay.clientHeight - 46, L = 30;
      const axes = [['X', [1, 0, 0], '#ff6b6b'], ['Y', [0, 1, 0], '#6bff8a'], ['Z', [0, 0, 1], '#6bb5ff']];
      axes.map(([n, v, c]) => ({ n, c, sx: R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], sy: R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], sz: R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2] }))
        .sort((a, b) => a.sz - b.sz)
        .forEach((a) => {
          ctx.strokeStyle = a.c; ctx.fillStyle = a.c; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + a.sx * L, y0 - a.sy * L); ctx.stroke();
          ctx.font = '600 11px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(a.n, x0 + a.sx * (L + 9), y0 - a.sy * (L + 9));
        });
    }
    if (o.showScale && this.ortho && this.maxExtentUm) {
      const pxWorld = this.camera.viewHeight() / this.overlay.clientHeight; // world units per CSS px
      const umPerPx = pxWorld * this.maxExtentUm;
      const target = 110 * umPerPx;
      const p10 = Math.pow(10, Math.floor(Math.log10(target)));
      const nice = [1, 2, 5, 10].map((k) => k * p10).filter((v) => v <= target).pop() || p10;
      const len = nice / umPerPx, x1 = this.overlay.clientWidth - 24, y1 = this.overlay.clientHeight - 24;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillRect(x1 - len, y1 - 4, len, 4);
      ctx.font = '12px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(fmtLen(nice), x1 - len / 2, y1 - 7);
    }
  }
}

function fmtLen(um) {
  if (um >= 1000) return (um / 1000) + ' mm';
  if (um < 1) return Math.round(um * 1000) + ' nm';
  return (+um.toPrecision(3)) + ' µm';
}
