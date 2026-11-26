/* CZI Volume Studio — colour maps (256-entry RGB lookup tables) and label colours. */
const Colormaps = (() => {
  'use strict';
  const SOLID = {
    gray: [1, 1, 1], red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], cyan: [0, 1, 1],
    magenta: [1, 0, 1], yellow: [1, 1, 0], orange: [1, 0.5, 0],
  };
  const STOPS = {
    fire: [[0, 0, 0, 0], [0.12, 0.02, 0, 0.38], [0.25, 0.35, 0, 0.6], [0.38, 0.65, 0.03, 0.42], [0.5, 0.88, 0.18, 0.12], [0.65, 1, 0.45, 0], [0.8, 1, 0.72, 0], [0.92, 1, 0.93, 0.35], [1, 1, 1, 1]],
    ice: [[0, 0, 0, 0], [0.3, 0.05, 0.1, 0.5], [0.55, 0.1, 0.45, 0.9], [0.8, 0.4, 0.85, 1], [1, 0.95, 1, 1]],
  };
  // Polynomial fits of the matplotlib perceptual maps and Google's Turbo.
  const POLY = {
    viridis: [[0.2777273272234177, 0.005407344544966578, 0.3340998053353061], [0.1050930431085774, 1.404613529898575, 1.384590162594685], [-0.3308618287255563, 0.214847559468213, 0.09509516302823659], [-4.634230498983486, -5.799100973351585, -19.33244095627987], [6.228269936347081, 14.17993336680509, 56.69055260068105], [4.776384997670288, -13.74514537774601, -65.35303263337234], [-5.435455855934631, 4.645852612178535, 26.3124352495832]],
    plasma: [[0.05873234392399702, 0.02333670892565664, 0.5433401826748754], [2.176514634195958, 0.2383834171260182, 0.7539604599784036], [-2.689460476458034, -7.455851135738909, 3.110799939717086], [6.130348345893603, 42.3461881477227, -28.51885465332158], [-11.10743619062271, -82.66631109428045, 60.13984767418263], [10.02306557647065, 71.41361770095349, -54.07218655560067], [-3.658713842777788, -22.93153465461149, 18.19190778539828]],
    magma: [[-0.002136485053939582, -0.000749655052795221, -0.005386127855323933], [0.2516605407371642, 0.6775232436837668, 2.494026599312351], [8.353717279216625, -3.577719514958484, 0.3144679030132573], [-27.66873308576866, 14.26473078096533, -13.64921318813922], [52.17613981234068, -27.94360607168351, 12.94416944238394], [-50.76852536473588, 29.04658282127291, 4.23415299384598], [18.65570506591883, -11.48977351997711, -5.601961508734096]],
    inferno: [[0.0002189403691192265, 0.001651004631001012, -0.01948089843709184], [0.1065134194856116, 0.5639564367884091, 3.932712388889277], [11.60249308247187, -3.972853965665698, -15.9423941062914], [-41.70399613139459, 17.43639888205313, 44.35414519872813], [77.162935699427, -33.40235894210092, -81.80730925738993], [-71.31942824499214, 32.62606426397723, 73.20951985803202], [25.13112622477341, -12.24266895238567, -23.07032500287172]],
  };
  function turbo(t) {
    const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
    const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
    const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
    return [r, g, b];
  }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function hexToRgb(hex) {
    const h = (hex || '#ffffff').replace('#', '');
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
  }

  /** Returns Uint8Array(256*3) */
  function lut(name, colorHex) {
    const out = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let c;
      if (name === 'custom') { const k = hexToRgb(colorHex); c = [k[0] * t, k[1] * t, k[2] * t]; }
      else if (SOLID[name]) { const k = SOLID[name]; c = [k[0] * t, k[1] * t, k[2] * t]; }
      else if (name === 'hilo') c = i === 0 ? [0, 0, 1] : i === 255 ? [1, 0, 0] : [t, t, t];
      else if (name === 'invgray') c = [1 - t, 1 - t, 1 - t];
      else if (name === 'turbo') c = turbo(t);
      else if (POLY[name]) {
        const P = POLY[name];
        c = [0, 1, 2].map((k) => { let v = P[6][k]; for (let j = 5; j >= 0; j--) v = v * t + P[j][k]; return v; });
      } else if (STOPS[name]) {
        const S = STOPS[name];
        let j = 1;
        while (j < S.length - 1 && S[j][0] < t) j++;
        const a = S[j - 1], b = S[j], f = (t - a[0]) / ((b[0] - a[0]) || 1);
        c = [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
      } else c = [t, t, t];
      out[i * 3] = Math.round(clamp01(c[0]) * 255);
      out[i * 3 + 1] = Math.round(clamp01(c[1]) * 255);
      out[i * 3 + 2] = Math.round(clamp01(c[2]) * 255);
    }
    return out;
  }

  /** CSS gradient preview for a colour map. */
  function gradientCSS(name, colorHex) {
    const L = lut(name, colorHex), stops = [];
    for (let i = 0; i <= 8; i++) { const k = Math.min(255, Math.round(i * 255 / 8)) * 3; stops.push(`rgb(${L[k]},${L[k + 1]},${L[k + 2]}) ${i * 12.5}%`); }
    return `linear-gradient(90deg, ${stops.join(',')})`;
  }

  /** Deterministic label colour; mirrors labelColor() in the 3D shader. */
  function labelColor(id) {
    const f = (x) => x - Math.floor(x);
    const h = f(id * 0.618033988749895), s = 0.55 + 0.45 * f(id * 0.3819660113), v = 0.8 + 0.2 * f(id * 0.7548776662);
    const k = (n) => { const kk = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1)); };
    return [k(5), k(3), k(1)];
  }

  const NAMES = [
    ['gray', 'Gray'], ['custom', 'Channel colour'], ['green', 'Green'], ['magenta', 'Magenta'], ['red', 'Red'], ['blue', 'Blue'],
    ['cyan', 'Cyan'], ['yellow', 'Yellow'], ['orange', 'Orange'], ['hilo', 'HiLo (saturation check)'], ['fire', 'Fire'], ['ice', 'Ice'],
    ['viridis', 'Viridis'], ['magma', 'Magma'], ['inferno', 'Inferno'], ['plasma', 'Plasma'], ['turbo', 'Turbo'], ['invgray', 'Inverted gray'],
  ];
  const DEFAULT_COLORS = ['#00ff00', '#ff00ff', '#00ffff', '#ff0000', '#ffff00', '#0080ff', '#ff8000', '#ffffff'];

  return { lut, gradientCSS, labelColor, hexToRgb, rgbToHex, NAMES, DEFAULT_COLORS };
})();
