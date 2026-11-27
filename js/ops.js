/* SynaptoSnap — processing operation catalogue (UI definitions).
 * Each op: id (matches Proc OPS), name, desc, inputs [{label, kinds, optional, show}], params [...], short(p) for the output name.
 * Param: { k, label, type:'num'|'select'|'check'|'text', def (value or fn(ctx, layer)), options, step, min, max, show(p), hint }
 * ctx = { sx, sy, sz, W, H, D, meta }.
 */
const r3 = (v) => +(+v).toPrecision(3);

function psfDefaults(ctx) {
  const info = (ctx.meta && ctx.meta.info) || {};
  const ch = (ctx.meta && ctx.meta.channels && ctx.meta.channels[0]) || {};
  const na = info.na || 1.0;
  const lam = (parseFloat(ch.emission) || 520) / 1000;
  const imm = String(info.immersion || '').toLowerCase();
  const n = imm.includes('oil') ? 1.518 : imm.includes('water') ? 1.333 : imm.includes('glyc') ? 1.47 : imm.includes('sil') ? 1.406 : na > 1 ? 1.518 : 1.0;
  const xy = 0.51 * lam / na;
  const z = 0.88 * lam / (n - Math.sqrt(Math.max(0, n * n - Math.min(na, n * 0.999) ** 2)));
  return { xy: r3(xy), z: r3(z) };
}

/* Default ridge scale for tracing: 1.5 pixels, but not below 0.375 × the widefield lateral PSF σ
 * (i.e. 0.75 σ of a PSF up to 2× sharper than widefield, as in SIM / Airyscan). Pixel size is chosen
 * to match the resolution, so this follows it. On SIM-like test nuclei 1.5 pixels (0.047 µm) beat
 * the widefield-based 0.07 µm for every PSF width tried; coarser pixels give the same value as before. */
function ridgeSigmaDefault(ctx, L) {
  const info = (ctx.meta && ctx.meta.info) || {};
  const em = L && L.source && L.source.meta && parseFloat(L.source.meta.emission);
  const na = info.na || 0;
  if (!na) return r3(Math.max(1.5 * ctx.sx, 0.035));
  const sigma = 0.51 * ((em || 550) / 1000) / na / 2.3548;
  return r3(Math.max(1.5 * ctx.sx, 0.375 * sigma));
}

/* Axial/lateral PSF ratio, used to un-stretch filaments in Z for Hessian filters. */
function zElongationDefault(ctx) {
  if (!ctx.D || ctx.D < 2) return 1;
  const info = (ctx.meta && ctx.meta.info) || {};
  if (!info.na) return 2.5;
  const p = psfDefaults(ctx);
  return r3(Math.max(1, Math.min(5, p.z / p.xy)));
}

const INTENSITY = ['intensity'], ANY_IMG = ['intensity', 'mask'], MASKY = ['mask', 'labels'];

const OP_GROUPS = [
  {
    group: 'Denoise & smooth', items: [
      {
        id: 'gaussian', name: 'Gaussian blur', desc: 'Suppresses noise and fine detail smaller than σ. Use a smaller σ in Z when Z steps are coarser.',
        inputs: [{ label: 'Input', kinds: ANY_IMG }],
        params: [{ k: 'sigmaXY', label: 'σ XY (µm)', def: (c) => r3(c.sx * 1.5), step: 0.01, min: 0 }, { k: 'sigmaZ', label: 'σ Z (µm)', def: (c) => r3(c.sz), step: 0.01, min: 0 }],
        short: (p) => 'Gauss ' + p.sigmaXY,
      },
      {
        id: 'median', name: 'Median filter', desc: 'Removes shot / salt-and-pepper noise while keeping edges sharp. Radius in voxels; large radii are slow.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [{ k: 'radiusXY', label: 'Radius XY (px)', def: 1, step: 1, min: 0, max: 6 }, { k: 'radiusZ', label: 'Radius Z (px)', def: 1, step: 1, min: 0, max: 4 }],
        short: (p) => 'Median ' + p.radiusXY,
      },
      {
        id: 'mean', name: 'Mean (box) filter', desc: 'Fast moving-average smoothing.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [{ k: 'radiusXY', label: 'Radius XY (µm)', def: (c) => r3(c.sx), step: 0.01, min: 0 }, { k: 'radiusZ', label: 'Radius Z (µm)', def: 0, step: 0.01, min: 0 }],
        short: () => 'Mean',
      },
      {
        id: 'unsharp', name: 'Unsharp mask (sharpen)', desc: 'Boosts detail by adding back the difference between the image and a blurred copy.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [{ k: 'sigmaXY', label: 'σ XY (µm)', def: (c) => r3(c.sx * 3), step: 0.01 }, { k: 'sigmaZ', label: 'σ Z (µm)', def: (c) => r3(c.sz), step: 0.01 }, { k: 'amount', label: 'Amount', def: 1, step: 0.1, min: 0 }],
        short: () => 'Sharpened',
      },
      {
        id: 'deconv', name: 'Deconvolution (Richardson–Lucy)', desc: 'Iterative deblurring with a Gaussian approximation of the point-spread function. Defaults estimate the FWHM from the objective NA and emission wavelength in the metadata. 10–30 iterations is typical.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [{ k: 'fwhmXY', label: 'PSF FWHM XY (µm)', def: (c) => psfDefaults(c).xy, step: 0.01 }, { k: 'fwhmZ', label: 'PSF FWHM Z (µm)', def: (c) => psfDefaults(c).z, step: 0.01 }, { k: 'iterations', label: 'Iterations', def: 15, step: 1, min: 1, max: 200 }],
        short: (p) => 'Deconv ' + p.iterations + 'it',
      },
    ],
  },
  {
    group: 'Background & intensity', items: [
      {
        id: 'background', name: 'Background subtraction', desc: 'Removes slowly varying background. Top-hat (rolling-ball style) keeps objects smaller than the radius; Gaussian subtracts a heavily blurred copy.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [
          { k: 'method', label: 'Method', type: 'select', options: [['tophat', 'Rolling ball (top-hat)'], ['gaussian', 'Gaussian low-pass']], def: 'tophat' },
          { k: 'radius', label: 'Radius (µm)', def: (c) => r3(c.sx * 25), step: 0.1, min: 0, hint: 'Larger than the biggest object you want to keep' },
          { k: 'mode', label: 'Geometry', type: 'select', options: [['3d', '3D'], ['2d', 'Each slice (2D)']], def: '3d' },
          { k: 'output', label: 'Output', type: 'select', options: [['corrected', 'Corrected image'], ['background', 'Background estimate']], def: 'corrected' },
        ],
        short: (p) => (p.output === 'background' ? 'Background' : 'BG-sub'),
      },
      {
        id: 'clahe', name: 'Local contrast (CLAHE)', desc: 'Contrast-limited adaptive histogram equalisation per slice. Evens out bright and dim regions; output is 0–1.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [{ k: 'tiles', label: 'Tiles across', def: 8, step: 1, min: 1, max: 64 }, { k: 'clip', label: 'Clip limit', def: 2.5, step: 0.1, min: 1 }],
        short: () => 'CLAHE',
      },
      {
        id: 'zcorrect', name: 'Depth attenuation correction', desc: 'Compensates signal loss deeper into the sample by equalising a bright-percentile intensity across Z slices.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [
          { k: 'method', label: 'Model', type: 'select', options: [['exp', 'Exponential fit'], ['perslice', 'Per slice (smoothed)']], def: 'exp' },
          { k: 'percentile', label: 'Reference percentile', def: 99, step: 0.5, min: 50, max: 100 },
          { k: 'maxGain', label: 'Max gain', def: 8, step: 0.5, min: 1 },
        ],
        short: () => 'Z-corrected',
      },
      {
        id: 'intensity', name: 'Intensity transform', desc: 'Point-wise transforms: invert, log, square root, gamma, percentile normalisation, clipping or linear scaling.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [
          { k: 'op', label: 'Transform', type: 'select', options: [['invert', 'Invert'], ['log', 'Log'], ['sqrt', 'Square root'], ['gamma', 'Gamma'], ['normalize', 'Normalise (percentiles → 0–1)'], ['clip', 'Clip'], ['scale', 'Scale × + offset']], def: 'invert' },
          { k: 'value', label: 'Gamma / scale', def: 0.5, step: 0.05, show: (p) => p.op === 'gamma' || p.op === 'scale' },
          { k: 'offset', label: 'Offset', def: 0, step: 1, show: (p) => p.op === 'scale' },
          { k: 'low', label: 'Low (percentile / value)', def: 0.1, step: 0.1, show: (p) => p.op === 'normalize' || p.op === 'clip' },
          { k: 'high', label: 'High (percentile / value)', def: 99.9, step: 0.1, show: (p) => p.op === 'normalize' || p.op === 'clip' },
        ],
        short: (p) => p.op[0].toUpperCase() + p.op.slice(1),
      },
    ],
  },
  {
    group: 'Feature enhancement', items: [
      {
        id: 'dog', name: 'Difference of Gaussians (band-pass)', desc: 'Keeps structures between σ1 and σ2 in size — ideal for periodic spot or stripe patterns. Set σ1 ≈ spot radius / 2 and σ2 ≈ 2× spot radius.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [{ k: 'sigma1', label: 'σ1 small (µm)', def: (c) => r3(c.sx), step: 0.01 }, { k: 'sigma2', label: 'σ2 large (µm)', def: (c) => r3(c.sx * 5), step: 0.01 }, { k: 'positive', label: 'Keep positive part only', type: 'check', def: true }],
        short: () => 'DoG',
      },
      {
        id: 'log', name: 'Laplacian of Gaussian (blobs)', desc: 'Scale-normalised blob detector response. Bright blobs of radius ≈ σ·√3 (3D) give the strongest response.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [{ k: 'sigma', label: 'σ (µm)', def: (c) => r3(c.sx * 2), step: 0.01 }, { k: 'positive', label: 'Keep positive part only', type: 'check', def: true }],
        short: (p) => 'LoG ' + p.sigma,
      },
      {
        id: 'hessian', name: 'Hessian shape filter', desc: 'Enhances filaments (tubes), blobs or sheets/membranes using the eigenvalues of the Hessian. Several scales can be combined, e.g. "0.3, 0.6, 1".',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [
          { k: 'kind', label: 'Structure', type: 'select', options: [['tube', 'Filaments / tubes'], ['blob', 'Blobs'], ['sheet', 'Sheets / membranes']], def: 'tube' },
          { k: 'sigmas', label: 'Scales σ (µm)', type: 'text', def: (c) => r3(c.sx * 1.5) + ', ' + r3(c.sx * 3) },
          { k: 'zAniso', label: 'Z elongation (PSF z/xy)', def: (c, L, p) => (p && p.kind === 'tube' ? zElongationDefault(c) : 1), recalcOn: ['kind'], step: 0.1, min: 0.2, max: 8, hint: 'Axial blur relative to lateral blur. For filaments/tubes it is set from the objective NA so they look round again; 1 = no correction (the default for blobs and sheets).' },
          { k: 'polarity', label: 'Structures are', type: 'select', options: [['bright', 'Bright on dark'], ['dark', 'Dark on bright']], def: 'bright' },
        ],
        short: (p) => ({ tube: 'Tubeness', blob: 'Blobness', sheet: 'Sheetness' })[p.kind],
      },
      {
        id: 'edges', name: 'Edges (gradient magnitude)', desc: 'Highlights boundaries; σ pre-smooths to suppress noise.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [{ k: 'sigma', label: 'σ (µm)', def: (c) => r3(c.sx), step: 0.01, min: 0 }],
        short: () => 'Edges',
      },
      {
        id: 'localstd', name: 'Local variance (texture)', desc: 'Local standard deviation — highlights textured or patterned regions.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [{ k: 'radius', label: 'Radius (µm)', def: (c) => r3(c.sx * 3), step: 0.01 }],
        short: () => 'Local SD',
      },
      {
        id: 'distance', name: 'Distance transform', desc: 'Euclidean distance in µm to the mask boundary (inside) or to the nearest object (outside), using true voxel spacing.',
        inputs: [{ label: 'Mask', kinds: MASKY }],
        params: [{ k: 'side', label: 'Measure', type: 'select', options: [['inside', 'Inside objects'], ['outside', 'Outside objects']], def: 'inside' }],
        short: () => 'Distance',
      },
    ],
  },
  {
    group: 'Segmentation', items: [
      {
        id: 'threshold', name: 'Threshold (global)', desc: 'Creates a binary mask. Automatic methods pick the level from the histogram; turn on Preview to see the result on the slices before applying. For SIM reconstructions (many voxels clipped to zero) use Otsu, IsoData or Yen — Triangle and Mean choose far too low a level there.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        preview: 'threshold',
        params: [
          { k: 'method', label: 'Method', type: 'select', options: [['otsu', 'Otsu'], ['li', 'Li'], ['triangle', 'Triangle'], ['yen', 'Yen'], ['isodata', 'IsoData'], ['maxentropy', 'Max entropy'], ['mean', 'Mean'], ['percentile', 'Percentile'], ['manual', 'Manual']], def: 'otsu' },
          { k: 'value', label: 'Level', def: 0, step: 1, show: (p) => p.method === 'manual', slider: true },
          { k: 'percentile', label: 'Percentile', def: 99, step: 0.1, min: 0, max: 100, show: (p) => p.method === 'percentile' },
          { k: 'invert', label: 'Select dark regions', type: 'check', def: false },
        ],
        short: (p) => 'Mask ' + p.method,
      },
      {
        id: 'hysteresis', name: 'Hysteresis threshold', desc: 'Keeps voxels above Low only if they connect to a voxel above High — good for spots and filaments with uneven brightness. Preview: red ≥ high, yellow ≥ low.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        preview: 'hysteresis',
        params: [{ k: 'low', label: 'Low', def: (c, L) => L ? r3(L.pct(90)) : 0, step: 1, slider: true }, { k: 'high', label: 'High', def: (c, L) => L ? r3(L.pct(99.5)) : 1, step: 1, slider: true }],
        short: () => 'Mask hyst',
      },
      {
        id: 'localthreshold', name: 'Local (adaptive) threshold', desc: 'Compares each voxel with its neighbourhood — handles uneven illumination. Sauvola is robust for textured backgrounds.',
        inputs: [{ label: 'Input', kinds: INTENSITY }],
        params: [
          { k: 'method', label: 'Method', type: 'select', options: [['mean', 'Local mean'], ['sauvola', 'Sauvola']], def: 'mean' },
          { k: 'radius', label: 'Radius (µm)', def: (c) => r3(c.sx * 8), step: 0.1 },
          { k: 'offset', label: 'Offset', def: 0, step: 1, hint: 'Added to the local threshold' },
          { k: 'k', label: 'Sauvola k', def: 0.2, step: 0.05, show: (p) => p.method === 'sauvola' },
          { k: 'mode', label: 'Neighbourhood', type: 'select', options: [['3d', '3D'], ['2d', 'Each slice (2D)']], def: '3d' },
        ],
        short: () => 'Mask local',
      },
      {
        id: 'morph', name: 'Binary morphology', desc: 'Erode, dilate, open (removes thin protrusions / specks) or close (bridges gaps) with a true spherical element in µm.',
        inputs: [{ label: 'Mask', kinds: ['mask'] }],
        params: [{ k: 'op', label: 'Operation', type: 'select', options: [['open', 'Open'], ['close', 'Close'], ['erode', 'Erode'], ['dilate', 'Dilate']], def: 'open' }, { k: 'radius', label: 'Radius (µm)', def: (c) => r3(Math.max(c.sx, c.sz) * 1.01), step: 0.01 }],
        short: (p) => p.op[0].toUpperCase() + p.op.slice(1),
      },
      {
        id: 'fillholes', name: 'Fill holes', desc: 'Fills enclosed background inside objects (3D, or each slice separately).',
        inputs: [{ label: 'Mask', kinds: ['mask'] }],
        params: [{ k: 'mode', label: 'Mode', type: 'select', options: [['3d', '3D'], ['2d', 'Each slice (2D)']], def: '2d' }],
        short: () => 'Filled',
      },
      {
        id: 'sizefilter', name: 'Remove small / large objects', desc: 'Discards connected objects outside a size range.',
        inputs: [{ label: 'Mask or labels', kinds: MASKY }],
        params: [
          { k: 'unit', label: 'Unit', type: 'select', options: [['um3', 'µm³'], ['voxels', 'voxels']], def: 'um3' },
          { k: 'min', label: 'Minimum size', def: (c) => r3(c.sx * c.sy * c.sz * 20), step: 0.01 },
          { k: 'max', label: 'Maximum size (blank = none)', type: 'text', def: '' },
          { k: 'connectivity', label: 'Connectivity', type: 'select', options: [['26', '26 (corners)'], ['18', '18 (edges)'], ['6', '6 (faces)']], def: '26' },
        ],
        short: () => 'Size filtered',
      },
      {
        id: 'skeletonize', name: 'Skeletonise (centre lines)', desc: 'Thins a mask to 1-voxel-wide centre lines while preserving its topology (3D simple-point thinning). Useful for filaments, synaptonemal complexes and networks.',
        inputs: [{ label: 'Mask', kinds: ['mask'] }],
        params: [{ k: 'prune', label: 'Remove spurs shorter than (µm)', def: (c) => r3(c.sx * 5), step: 0.01, min: 0 }],
        short: () => 'Skeleton',
      },
      {
        id: 'label', name: 'Label objects (connected components)', desc: 'Gives each connected object in a mask a unique ID, ready for measurement.',
        inputs: [{ label: 'Mask', kinds: ['mask'] }],
        params: [{ k: 'connectivity', label: 'Connectivity', type: 'select', options: [['26', '26 (corners)'], ['18', '18 (edges)'], ['6', '6 (faces)']], def: '26' }],
        short: () => 'Labels',
      },
      {
        id: 'watershed', name: 'Split touching objects (watershed)', desc: 'Separates merged objects. Seeds are maxima of the distance map (or of the intensity), at least the minimum distance apart.',
        inputs: [{ label: 'Mask', kinds: ['mask'] }, { label: 'Intensity', kinds: INTENSITY, show: (p) => p.landscape === 'intensity' }],
        params: [
          { k: 'landscape', label: 'Split using', type: 'select', options: [['distance', 'Shape (distance map)'], ['intensity', 'Intensity peaks']], def: 'distance' },
          { k: 'minDistance', label: 'Min seed distance (µm)', def: (c) => r3(c.sx * 6), step: 0.05 },
          { k: 'smooth', label: 'Smoothing σ (µm)', def: (c) => r3(c.sx), step: 0.05 },
        ],
        short: () => 'Watershed',
      },
    ],
  },
  {
    group: 'Combine & convert', items: [
      {
        id: 'math', name: 'Layer arithmetic / logic', desc: 'Combine two layers voxel by voxel. Logical operations treat any non-zero voxel as true and output a mask.',
        inputs: [{ label: 'Layer A', kinds: ['intensity', 'mask', 'labels'] }, { label: 'Layer B', kinds: ['intensity', 'mask', 'labels'] }],
        params: [
          { k: 'op', label: 'Operation', type: 'select', options: [['subtract', 'A − k·B'], ['add', 'A + k·B'], ['multiply', 'A × k·B'], ['divide', 'A ÷ k·B'], ['ratio', 'A / (A + k·B)'], ['min', 'min(A, k·B)'], ['max', 'max(A, k·B)'], ['absdiff', '|A − k·B|'], ['and', 'A AND B'], ['or', 'A OR B'], ['xor', 'A XOR B'], ['andnot', 'A AND NOT B']], def: 'subtract' },
          { k: 'factor', label: 'k', def: 1, step: 0.1, show: (p) => !['and', 'or', 'xor', 'andnot'].includes(p.op) },
          { k: 'clip', label: 'Clip negatives to 0', type: 'check', def: true, show: (p) => !['and', 'or', 'xor', 'andnot'].includes(p.op) },
        ],
        short: (p) => p.op,
      },
      {
        id: 'applymask', name: 'Apply mask', desc: 'Keeps intensities inside the mask (or outside, if inverted) and sets the rest to zero.',
        inputs: [{ label: 'Image', kinds: ['intensity', 'labels'] }, { label: 'Mask', kinds: MASKY }],
        params: [{ k: 'invert', label: 'Keep outside instead', type: 'check', def: false }],
        short: () => 'Masked',
      },
      {
        id: 'labelsToMask', name: 'Labels → mask', desc: 'Converts labelled objects into a binary mask, or into a mask of their boundaries.',
        inputs: [{ label: 'Labels', kinds: ['labels'] }],
        params: [{ k: 'what', label: 'Output', type: 'select', options: [['all', 'Whole objects'], ['boundaries', 'Object boundaries']], def: 'all' }],
        short: (p) => (p.what === 'boundaries' ? 'Boundaries' : 'Mask'),
      },
    ],
  },
];

const OP_INDEX = {};
OP_GROUPS.forEach((g) => g.items.forEach((o) => { OP_INDEX[o.id] = o; }));

const ANALYSIS_DEFS = {
  spots: {
    id: 'spots', name: 'Spot detection', roi: true,   // roi: only inside the clipping box (App.runOp)
    inputs: [{ label: 'Input', kinds: INTENSITY }],
    params: [
      { k: 'diameter', label: 'Spot diameter (µm)', def: (c) => r3(c.sx * 6), step: 0.05 },
      { k: 'thresholdMode', label: 'Threshold', type: 'select', options: [['auto', 'Auto (σ above mean)'], ['absolute', 'Absolute response']], def: 'auto' },
      { k: 'threshold', label: 'Threshold value', def: 3, step: 0.1 },
      { k: 'minDistance', label: 'Min distance (µm)', def: (c) => r3(c.sx * 4.5), step: 0.05 },
      { k: 'makeLabels', label: 'Also create a labels layer (spheres)', type: 'check', def: false },
    ],
  },
  measure: {
    id: 'measure', name: 'Measure objects', roi: true,
    inputs: [{ label: 'Labels', kinds: ['labels', 'mask'] }, { label: 'Intensity', kinds: INTENSITY, optional: true }],
    params: [],
  },
  trace: {
    id: 'trace', name: 'Chromosome tracing', roi: true,
    // both default to the SC (ZYP1) channel: the most line-like channel (App.traceSCChannel), not the first
    inputs: [{ label: 'Image or mask', kinds: ['intensity', 'mask'], prefer: 'sc' }, { label: 'Intensity (for stats)', kinds: INTENSITY, optional: true, prefer: 'sc' }],
    params: [
      { k: 'n', label: 'Number of chromosomes (N)', def: 4, step: 1, min: 1, max: 60 },
      { k: 'deconvZ', label: 'Sharpen along Z first (deconvolution)', type: 'check', def: true, hint: 'Image input only: Richardson–Lucy deconvolution along Z, with the axial blur measured from the data, before the tracks are detected. Tracks stacked 0.3–0.6 µm apart then come apart instead of merging into one thick track. On SIM-like test nuclei: about 5 % more of each chromosome traced, ~18 % fewer clicks to assemble, no more wrong joins. Adds a few seconds.' },
      { k: 'deconvSigma', label: 'Axial blur σ for sharpening (µm)', type: 'text', def: '', hint: 'Blank = measured from the data (0.9 × the σ of the sharpest bright Z-profiles; ≈ 0.2 µm for 3D-SIM). Too large a value over-sharpens and adds wrong joins.' },
      { k: 'ridgeSigma', label: 'Ridge scale σ (µm)', def: (c, L) => ridgeSigmaDefault(c, L), step: 0.005, min: 0, hint: 'Image input only: tracks are enhanced with Z-corrected tubeness at this scale (default 1.5 pixels, not below 0.375 × the widefield PSF σ). Smaller keeps neighbouring tracks apart; larger closes breaks along tracks.' },
      { k: 'ridgeFactor', label: 'Ridge threshold (× Otsu)', def: 1.1, step: 0.05, min: 0.2, hint: 'Image input only: higher = thinner tracks and fewer false contacts but more breaks; lower = fewer breaks but neighbours merge' },
      { k: 'zAniso', label: 'Z elongation (PSF z/xy)', def: (c) => zElongationDefault(c), step: 0.1, min: 0.2, max: 8, hint: 'Image input only: compensates axial blur so filaments look round to the ridge filter' },
      { k: 'maxBend', label: 'Max bend at crossings (°)', type: 'text', def: '', hint: 'How sharply a track may turn where it is continued through a junction or across a gap. Blank = automatic: 60° when the chromosomes are separated automatically (sparse nuclei), 75° for dense nuclei (since version 2026-11-24f; on two hand-traced real SIM nuclei the looser limit left fewer pieces to assemble with no more wrong joins). A number you enter is used for both.' },
      { k: 'zThin', label: 'Thin tracks in Z (layered data)', type: 'check', def: false, hint: 'Keeps only a thin band (±0.12 µm) around each intensity peak along Z. Off by default: on SIM-like test nuclei it doubled the number of wrong joins without separating stacked tracks.' },
      { k: 'zPenalty', label: 'Keep tracks in their Z layer', def: 1.5, step: 0.1, min: 0, max: 5, hint: 'Tracks mostly run within xy layers with occasional Z steps. > 0: continuations are judged by their bend in xy plus a penalty for changing Z level (≈ per 0.3 µm), so at a crossing of stacked tracks each track keeps its layer. 0 = plain 3D bend angle (for tracks that genuinely wander in Z).' },
      { k: 'maxGap', label: 'Max gap to bridge (µm)', type: 'text', def: '', hint: 'Blank = automatic (≈ 4 × track width)' },
      { k: 'linkGaps', label: 'Link longer gaps along faint ridges (dense data)', type: 'check', def: true, hint: 'Image input, dense nuclei: after the normal joins, a free track end may be joined to another free end up to 2.5 × the max gap away, if at least one is a tip, they point at each other, lie at the same Z level, and a faint ridge (¼ of the detection threshold) links them without touching another track. Shown dash-dotted. On SIM-like test nuclei: 17 % fewer pieces to assemble, about 1 extra wrong join per nucleus.' },
      { k: 'brightGaps', label: 'Link gaps where the image stays bright (dense data)', type: 'check', def: true, hint: 'Image input, dense nuclei: a last joining pass. A track end still free may be joined to another free end up to 2.5 × the max gap away when the raw image stays bright across the gap (its dimmest point is a large fraction of the dimmer end) and both ends lie at the same depth. Fitted on two hand-traced real SIM nuclei: about 93 % of these links were right, and the pieces to assemble fell by a fifth.' },
      { k: 'minBranch', label: 'Ignore spurs below (µm)', type: 'text', def: '', hint: 'Blank = automatic (≈ 2.5 × track width)' },
      { k: 'minLen', label: 'Min chromosome length (µm)', type: 'text', def: '', hint: 'Shorter pieces count as fragments. Blank = automatic' },
      { k: 'close', label: 'Close mask first (µm)', def: 0, step: 0.01, min: 0, hint: 'Morphological closing radius to bridge tiny breaks and holes before skeletonising (0 = off)' },
      { k: 'skeletonLayer', label: 'Also add the skeleton as a layer', type: 'check', def: false },
    ],
  },
  spectrum: {
    id: 'spectrum', name: 'Pattern spectrum', roi: true,
    roiParams: (p, r) => Object.assign({}, p, { z: Math.min(r.d - 1, Math.max(0, (p.z | 0) - r.z0)) }),   // current slice, within the box
    inputs: [{ label: 'Input', kinds: ANY_IMG }],
    params: [
      { k: 'source', label: 'Image', type: 'select', options: [['mip', 'Max projection (Z)'], ['mean', 'Mean projection (Z)'], ['slice', 'Current XY slice']], def: 'mip' },
      { k: 'minWavelength', label: 'Min wavelength (µm, 0 = auto)', def: 0, step: 0.1 },
      { k: 'maxWavelength', label: 'Max wavelength (µm, 0 = auto)', def: 0, step: 0.1 },
    ],
  },
};
