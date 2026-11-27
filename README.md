# SynaptoSnap

Visualise and annotate synaptonemal complexes of Arabidopsis male meiocytes at pachytene in 3D-SIM `.czi` files.

SynaptoSnap runs in Edge (or Chrome) on your own computer. It needs no internet connection, and your files are never uploaded.

## Getting started

1. Double-click **`SynaptoSnap.bat`**.
2. The first time, SynaptoSnap opens in an Edge tab. Click **Install app** in its header. It then has its own window and a Start-menu entry; right-click its taskbar icon to pin it. From then on `SynaptoSnap.bat` opens the installed app, and the pinned app also starts on its own, offline.
3. Click **Open CZI…** or drag a `.czi` file onto the window. To try things out, **Demo volume** makes synthetic test stacks: a dense SIM-like pachytene nucleus, a sparse one, or a Turing pattern.

**Online:** the same app runs at <https://morgangroup-jic.github.io/SynaptoSnap/>. Open it in Edge to use it without the files, or click **Install app** there to install that copy instead; it then updates by itself whenever a new version is published. It still runs on your computer, and files you open are never uploaded.

Press **H** in the app for the quick guide and all keyboard shortcuts.

Opening `index.html` directly in Edge also works, but it can't be installed that way (and its taskbar icon is blurry).

## What it reads

| | Supported |
|---|---|
| Compression | uncompressed, zstd, zstd with hi/lo byte packing, JPEG |
| Pixel types | Gray 8/16-bit, Gray 32-bit int/float, Gray64, BGR 24/48/96 (split into R, G, B layers) |
| Dimensions | Z-stacks, channels, scenes, time points, tiled mosaics (stitched by stage position) |
| Metadata | voxel size, channel names/colours/wavelengths, objective & NA, display settings |

Files with several scenes or time points, or very large files, open a dialog where you pick the scene, time point, channels, a Z range and optional XY binning (with a memory estimate).

**Not supported:** JPEG-XR and LZW compression. Re-save from ZEN with compression *None* or *Zstd*.

## Viewing

- **Views:** 3D, Slice (with a Z slider) and Ortho (XY/XZ/YZ + 3D). Keys `1` `2` `3`. In Ortho the three slice panes move together: one scale, XY and XZ lined up in x, XY and YZ in y, so zooming or panning one moves the others.
- **Channels** (left panel): a histogram with draggable min/max, the **Auto**, **Auto+** and **Min–max** buttons, gamma, opacity and colour maps. Channels of an opened file start at Min–max (their full data range); layers made by processing start at Auto.
- **3D rendering** (Render tab): MIP, attenuated MIP, translucent blending, iso-surfaces, MinIP or average, with up to 6 layers plus one labels layer. Very large stacks are reduced for the 3D display only; slices, processing and export always use the full data.
- **Clipping:** a box (X/Y/Z min/max) and a clipping plane, in the Render tab. The box hides everything outside it in every view: 3D, Slice, Ortho and the max projection (which then covers only the box's Z range); traces and spots outside it are hidden too. Slice and Ortho frame the box (double-click a view to frame it again), and the slice cursor moves into the box when it would fall outside. It also sets the region the Analyze tab works on (see [Analysis](#analysis-analyze-tab)).
- **Mouse:** drag rotates (3D) or pans (slices); `Shift`- or right-drag pans 3D; the wheel zooms 3D or changes the slice; `Ctrl`+wheel zooms slices; double-click resets the view. `Space` turns auto-rotate on and off.
- **Pictures and movies:** PNG snapshots at 1×, 2× or 4× resolution, and a 360° turntable video (WebM).
- **Arranging the window:** drag the thin line between a side panel and the views to resize the panel, or click the small arrow tab on that line to hide it. In Ortho, drag the lines between the panes (or the dot where they cross) to resize them. Double-click a line to go back to the default. The layout is remembered.

## Processing (Process tab)

Every operation makes a **new layer**, so your original data is never changed. Each layer keeps a record of how it was made, and the session log can be copied or saved.

| Group | Operations |
|---|---|
| Denoise & smooth | Gaussian (σ in µm), median, mean, unsharp mask, Richardson–Lucy deconvolution |
| Background & intensity | rolling-ball/top-hat or Gaussian background subtraction, CLAHE, depth-attenuation correction, invert/log/sqrt/gamma/normalise/clip/scale |
| Feature enhancement | difference of Gaussians, Laplacian of Gaussian, Hessian filter for filaments, blobs or sheets (with Z-elongation correction), edges, local variance, distance transform |
| Segmentation | global threshold with **live preview** (Otsu, Li, Triangle, Yen, IsoData, MaxEntropy, Mean, percentile, manual), hysteresis, local/Sauvola, morphology in µm, fill holes, size filter, 3D skeletonisation, labelling, watershed splitting |
| Combine | layer arithmetic & logic (A−B, ratio, AND/OR/XOR…), apply mask, labels → mask/boundaries |
| Whole volume | crop to the clipping box, 2×2 or 2×2×2 binning |

Long operations show a progress bar; **Esc** or **Cancel** stops them.

**Thresholding SIM data:** most voxels of a SIM reconstruction sit at the floor value, so *Triangle* and *Mean* pick far too low a level (they select most of the nucleus). Use *Otsu*, *IsoData* or *Yen*, ideally on a ridge-filtered image.

## Analysis (Analyze tab)

**Region:** analyses look only inside the clipping box, and their results stay in whole-image coordinates. The top of the Analyze tab shows which region is in use; **Use whole image** resets the box. (Process › **Crop to clipping box** is different: it cuts every layer down to the box for good.)

- **Chromosome tracing:** see [Tracing chromosomes](#tracing-chromosomes).
- **Spot detection:** finds bright, roughly round spots. Reports the count, nearest-neighbour distances and the Clark–Evans regularity index R (≈ 1 random, > 1 regular). Can also make a labels layer of spheres.
- **Object measurements:** volume, surface, size, shape, centroid, bounding box, edge contact, nearest-neighbour distance and intensity statistics for every labelled object. Sort and filter the table, click a row to go to the object, and keep only the filtered objects as a new layer.
- **Pattern spectrum:** the dominant spacing of a pattern (in µm) and whether it is stripes (orientation ≈ 1) or spots/labyrinths (≈ 0).
- **Line profile:** drag on the XY slice (`Shift` for a straight line) to sample every visible channel.

Every result table exports as CSV.

## Tracing chromosomes

### The automatic trace

1. In the Analyze tab, under **Chromosome tracing**, choose the input: the **raw SC (ZYP1) channel**. It defaults to the most line-like channel, which is ZYP1 on the test files, but check it.
2. Set **N**, the number of bivalents, and click **Trace chromosomes**.

Each chromosome gets a colour and a number, and a table lists its length, share of the total, number of segments and gaps, ends, and a status (`ok`, `branched`, `loop`, `2 pieces`). In sparse nuclei the chromosomes are usually separated automatically. In dense nuclei the N longest confident pieces are numbered and you assemble the rest (below).

**If the result looks wrong:**

- Neighbouring tracks merge: raise *Ridge threshold* or lower *Ridge scale*.
- Tracks break into many pieces: lower *Ridge threshold* slightly, or raise *Ridge scale* a little.
- One track is traced twice, one copy above the other: set a smaller *Axial blur σ for sharpening*, or untick *Sharpen along Z first*.
- Dash-dotted links are the less certain joins across gaps. Check them first: select one and press `B` to turn it off, or untick *Link longer gaps along faint ridges* / *Link gaps where the image stays bright*.
- The results warn that the mask is thick or fills its bounding box: the threshold selected the nucleus rather than the tracks.

### Editing traces

Click **✎ Edit traces**. To start by hand without waiting for the automatic trace, click **✎ Edit by hand now**. You can still run the automatic trace while you work; your hand-drawn traces keep their numbers, and the automatic pieces come in unassigned.

Pick the chromosome you are working on with the number buttons or keys `1`–`9`. Then choose a click action:

| Click action | What it does |
|---|---|
| **Trace** (default) | Click points along a chromosome; the stretch between clicks follows the image. See below. |
| **Erase** | Drag to erase the part of a trace under the brush, or click to erase a whole trace. The `Delete` key picks Erase. |
| **Paint** | Gives a whole automatic piece to the current chromosome (`Alt`+click: one segment only). |
| **Select** | Selects a segment or gap: `1`–`9` assigns it, `0` unassigns it, `Delete` removes it, `B` turns a gap link on or off. |
| **Route** (More tools) | Click along a chromosome every few µm; the straightest path through crossings between clicks is assigned. |
| **Link** (More tools) | Joins any two pieces with a straight link: click near the end of one, then near the end of the other. |
| **Guide** (More tools) | Drag along the true course of the current chromosome in an XY view; it is re-traced from the image within the shaded band. |

`Esc` first drops what you are in the middle of; the next `Esc` leaves Edit mode. `Ctrl+Z` undoes in every mode.

**Tracing by clicking (Trace).** This works like Fiji's SNT.

- **New trace:** click along a chromosome. The first click sets the start; each further click adds a stretch. New traces get the chromosome picked in the number row.
- **Extend a trace:** click near one of its ends (shown as dots), then click where it should go.
- **Join two traces:** click near an end of one, then near an end of the other. They are joined along a path through the image, and the result takes the number of the trace you clicked first. `Shift`+click selects a trace anywhere along it.
- **Finish:** `Esc`, `Enter`, a right-click, or **✓ Done with this trace**. While drawing, `Backspace` takes back the last stretch.
- `Alt`+click always places a point, even on another trace's end.
- **Where to click:** single slices are more accurate than the max projection, because on a projection a click can't say which of two stacked tracks you mean. Where chromosomes are crowded, click every 2–3 µm and at sharp turns. If a stretch cuts across to a neighbour, press `Backspace` and click a point in between.
- **Trace on:** the channel the path follows is shown under the click actions. It must be the ZYP1 channel.

**Suggestions.** While you trace, SynaptoSnap may suggest the way on as a dashed yellow line from the end of your trace. It appears only where your trace runs along the automatic trace and the way on is clear. It stops before uncertain places: gaps, ambiguous junctions and sharp changes in depth.

- Press `1` to take it, or click on it to take it up to that point. To ignore it, just keep clicking.
- `Shift`+scroll over the view makes it longer or shorter before you take it. The faint dotted line beyond shows how the automatic trace carries on.
- The **Suggestions** setting in the tracing panel sets the longest suggestion (3, 5, 8 or 12 µm) or turns them off.
- If you haven't run the automatic trace, one is made in the background (about 10 s); the hint at the bottom of the view says *suggestions: preparing* until then.
- While a trace is in progress, the number keys only take suggestions. Finish the trace before picking another chromosome. The line at the bottom of the XY view always says what the keys do.

**Unassign or delete?**

- **Unassign** (`0`): takes a segment off its chromosome but keeps it in the trace, muted, so you can use it later. Use it for real SC you haven't sorted out yet.
- **Erase / Delete:** removes it from the trace altogether. Use it for junk: background, duplicates, wrong joins (erase the bad stretch and the trace splits there).

**Two chromosomes on one track.** Where two SCs run together as one track, hold `Shift` in Paint, Route or Select to add a segment as a shared stretch, or use Guide or `Alt`+click in Trace to draw the second chromosome along it.

**Seeing what you are doing.**

- On slices, trace parts near the current slice are solid and parts further away fade out (*Solid within ± µm* sets the distance); only the solid parts can be clicked.
- Untick a chromosome in the table to hide it, use **Show only chromosome N** / **Show all**, or **Hide unassigned**. `T` hides or shows all trace lines.
- The **Segs** number in each table row opens a list of that chromosome's segments in order. Pick one to go to it; `[` and `]` step to the previous and next segment.
- **Clear chromosome** and **Unassign all** start a chromosome over; **Renumber by length** orders chromosomes from longest to shortest.

### Saving traces

Traces are saved as SNT `.traces` files, which open in Fiji: start SNT on the same `.czi` and use *File › Load Tracings*. Each chromosome is one path, named `Chromosome N`.

- **Save as…** creates a new file. In Chrome and Edge you choose its name and folder; afterwards **Save** keeps writing to that file. Tick *Save as… includes unassigned pieces* to save the pieces without a chromosome too.
- **Save** writes your changes back into the file the trace came from. This works for a `.traces` file you opened in Chrome or Edge, with **Open**, **Import .traces (SNT)…**, or by dropping it on the window. Save always includes the unassigned pieces, so nothing still in the trace is dropped from the file.
  - The first time, it asks before replacing the original file: SynaptoSnap writes the file in its own way, so anything else SNT kept in it (its own path names, tags, fitted paths) is lost. Use Save as… instead to keep the original as it is.
  - Edge or Chrome may also ask once for permission to change the file.
- **Keys:** `Ctrl+S` saves (as the Save button) and `Ctrl+Shift+S` is Save as…; on a Mac, `Cmd+S` and `Cmd+Shift+S`. Without a trace, `Ctrl+S` opens the Export tab.
- The line above the buttons names the file the trace is saved to and shows **● unsaved changes** when there are edits since the last save. Closing the window with unsaved changes asks first.
- **Safari and Firefox** don't let web pages write to files. There, Save and Save as… ask for a file name, and the file goes to your downloads.
- **CSV:** **Lengths CSV…** and **Trace coordinates CSV…** (µm) also ask where to save, in the same way.
- **Labels:** the *Chromosomes* labels layer can be exported as a channel of a new `.czi` (Export tab).
- **Opening SNT traces:** path names such as `Chr 2`, `Chromosome 2` or `SC2` set the chromosome number. The file must come from the same image (same crop); a warning says if the sizes differ.
- `.traces` files exported before 2026-11-25 don't open in SNT 5. Open them here and save them again.

## Exporting a new .czi (Export tab)

Choose which layers become channels, then:

- **Region:** the whole volume or only the clipping box.
- **Values:** the raw data, or with the current display contrast and gamma applied.
- **Pixel type:** 8-bit, 16-bit, 32-bit float, or automatic (use 16-bit for up to 65,535 labelled objects).

The file is an uncompressed CZI with the voxel size, channel names and colours, the original instrument metadata, and the processing history. Exported files have not yet been checked in ZEN or Fiji, so open one there before relying on it.

## Turing-pattern stacks

1. If the signal dims with depth: Process › Depth attenuation correction.
2. Process › Difference of Gaussians with σ1 ≈ spot radius / 2 and σ2 ≈ 2 × spot radius, to isolate the pattern scale.
3. Analyze › Pattern spectrum for the wavelength and whether it is spots or stripes.
4. Analyze › Spot detection (diameter ≈ spot size, min distance ≈ 0.7 × spacing) for spacing statistics and regularity.
5. For segmented spots: Threshold → Fill holes → Size filter → Label (or Watershed) → Measure objects.

## Limits

- One scene and one time point are loaded at a time.
- Every layer is held in memory. A few GB is fine; for bigger files, use the Z range and binning in the load dialog.
- 3D shows up to 6 visible intensity or mask layers plus 1 labels layer.
- Exported files are uncompressed, so they can be larger than zstd originals.

## Updates and versions

- After updating the files, start SynaptoSnap with `SynaptoSnap.bat` so the installed app picks up the new version, or reload with `Ctrl+R`.
- The version is shown next to the title; hover over it for the tracing engine version. The tracing panel warns when a trace was made by an older engine.
- SynaptoSnap was called CZI Volume Studio until 26 November 2026.

How the tracer works, how well it does on test and real nuclei, how it was tested, and the source files are described in [docs/TECHNICAL.md](docs/TECHNICAL.md).
