# SynaptoSnap: technical notes

How SynaptoSnap works, how well its tracing does on test and real nuclei, and how it was tested. Instructions for using the app are in the [README](../README.md).

## Source files

```
index.html                 layout & styles
icon.svg, icon.ico         app icon: vector drawing, and a Windows .ico with every size
icons/                     app icon as PNGs, each drawn for its size (tab, header, taskbar, installed app)
tools/make-icons.html      draws all the icon files from one design (open it in a browser and save the files)
manifest.webmanifest       makes the app installable when served over https (GitHub Pages)
sw.js                      offline copy of the app for the online / installed version
tools/launch.ps1           started by SynaptoSnap.bat: serves the app to this computer only, opens or installs it
.nojekyll                  tells GitHub Pages to serve the files unchanged
js/layout.js               resizable / hideable side panels, Ortho pane splitters
js/version.js              app version (date-based)
SynaptoSnap.bat            launcher (Edge app window)
js/czi.js                  CZI reader / writer and metadata
js/processing.js           filters, segmentation, measurements, FFT (runs in a Web Worker)
js/tracing.js              3D skeletonisation, skeleton graph, chromosome tracing solver
js/tracer-ui.js            tracing results panel, overlays, manual correction
js/tracepath.js            click-to-click path search through the image (Trace tool)
js/traces-io.js            SNT (Fiji) .traces import and export
js/renderer.js             WebGL2 volume ray-marcher and camera
js/slices.js               2D slice compositing and views
js/ops.js                  processing catalogue (parameters, defaults, help text)
js/ui.js, js/app.js        interface and application state
js/exporter.js             CZI export, snapshots, video, line profiles
js/demo.js                 synthetic demo volumes (sparse pachytene, Turing pattern)
js/demo-dense.js           dense SIM-like pachytene nucleus with ground truth
js/colormaps.js            colour maps
js/vendor/fzstd.js         zstd decoder (MIT, © Arjun Barrett)
```

## Versions

- **App version:** date-based, `YYYY.MM.DD`, with `.1`, `.2` … for further releases on the same day (first: 2026.11.26). It is shown in the header; hover over it for the tracing engine version too. It is set in `js/version.js`, and each release is tagged in git as `v` + the version, e.g. `v2026.11.26`.
- **Tracing engine version:** separate, date + letter (e.g. `2026-11-24f`), in `js/tracing.js`. It changes only when tracing results would change. Every trace stores the version it was made with, and the trace panel warns when a trace comes from an older engine.
- **Between releases:** git commits record every change.
- **Name:** the app was called CZI Volume Studio until 2026-11-26, when it was renamed SynaptoSnap. Panel sizes saved under the old name are carried over.

## Launcher, installing and GitHub Pages

`SynaptoSnap.bat` runs `tools/launch.ps1`. That script serves the app's own files to this computer only, at `http://localhost:47321/`, and opens SynaptoSnap in Edge. Nothing else can reach it, and it never serves the microscopy data in the folder. It stops by itself after 15 minutes without requests.

- **The first time,** SynaptoSnap opens in an Edge tab. Click **Install app** in its header (or the install icon in Edge's address bar). From then on it has its own window, a Start-menu entry, and a sharp taskbar icon made from the exact-size images in `icons/`. Right-click the taskbar icon to pin it.
- **After that,** `SynaptoSnap.bat` opens the installed app. The installed app also starts on its own (Start menu or taskbar) without the launcher, from its offline copy (`sw.js`). Start it through `SynaptoSnap.bat` to pick up a new version from this folder.
- **Why:** Edge gives an app window that is opened but not installed only its 16-pixel tab icon, which Windows enlarges to fill the taskbar button. Opening `index.html` directly still works, with that blurry icon.

**Online (GitHub Pages):** the same files can also be served by GitHub Pages. In the repository's **Settings → Pages**, choose *Deploy from a branch*, `main`, `/ (root)`. The app is at <https://morgangroup-jic.github.io/SynaptoSnap/> (published from `main` since 2026-11-27), where it can be installed the same way and stays up to date with what is pushed. It still runs entirely in the browser (`.czi` files are opened from your disk and never uploaded), but the site itself is public unless the organisation's plan restricts Pages access.

The icon files in `icons/`, `icon.svg` and `icon.ico` are all drawn by `tools/make-icons.html` from one design; the 16–48 px sizes are pixel-snapped so they stay sharp.

## How the automatic trace works

Choose the **raw image** as input, set **N** (the number of bivalents), and click **Trace chromosomes**. The input defaults to the most line-like channel, which is the SC (ZYP1) channel on the test files; check it says the right channel. The tool then:

1. **Sharpens the image along Z** (*Sharpen along Z first*, on by default since version 2026-11-24b). The axial blur is measured from the data itself, as the width of the sharpest bright Z-profiles (σ ≈ 0.23 µm on the example stack, the same as on the SIM-like test nuclei). Each Z column is then deconvolved with 20 iterations of Richardson–Lucy, using 0.9 × that σ: slightly under-sharpening is safe, over-sharpening adds wrong joins. Tracks stacked 0.3–0.6 µm apart, which the blur merges into one thick ridge with a false junction, come apart. Only the copy used for finding tracks is sharpened; your image is unchanged. *Axial blur σ for sharpening* overrides the measured value. On the example stack this takes about 5 s.
2. **Builds a ridge mask.** It applies tubeness corrected for the Z-elongated PSF at a scale of 1.5 pixels (0.047 µm for these SIM stacks), then thresholds at 1.1 × Otsu. Before version 2026-11-24b the scale was 0.75 × the widefield PSF width (≈ 0.07 µm). That is too coarse for SIM, which resolves about twice as finely: on the test nuclei it merged neighbouring tracks and lost dim stretches. Stacks with pixels of about 0.05 µm or larger (most confocal and widefield data) get the same scale as before. You can also give the tracer a mask you made yourself.
   - *Thin tracks in Z* (off by default) keeps only voxels within about ±0.12 µm of a local intensity peak in their Z column. On the test nuclei it doubled the number of wrong joins without separating stacked tracks; sharpening along Z does that job instead.
3. **Skeletonises** the mask in 3D to 1-voxel centre lines (topology-preserving thinning). Each centre-line point then gets a sub-voxel Z from the ridge-intensity profile in its column, smoothed along the track. Track ends are not snapped to the Z of the junction they meet: snapping made every track dive up or down in its last few points, which was most of the vertical-looking trace length. On the example nucleus, the share of trace length steeper than 45° fell from 19% to 4% after this change, and the over-estimate of track length from 23% to 6%.
4. **Turns the skeleton into a graph and cleans it.** It removes short spurs, fuses the two Y-junctions of an X-crossing into one node, and removes small loops.
5. **Joins the pieces.** Every way of continuing a track, straight through a junction or across a gap, gets a cost. By default (*Keep tracks in their Z layer* = 1.5) the cost is the bend in the xy projection plus a penalty for changing Z level, scaled so that a 0.25 µm level change costs about as much as a 60° bend. Directions and levels are measured on a short stretch of each arm, from 0.5 to 2.5 track widths from the junction. SC tracks curve within a micron, so longer arms point the wrong way. Most junctions in SIM stacks are places where a track in one layer passes over a track in another and the axial blur merges them. A plain 3D bend angle prefers the diagonal from one track down to the other; on the example nucleus it switched layer at 55% of junctions, and the layered model at 0%. Set the option to 0 only for tracks that genuinely wander in Z.
   - **Sparse nuclei (up to ~60 segments):** a branch-and-bound search finds the cheapest set of continuations that gives exactly N linear tracks, with a prior against tracks much shorter than average.
   - **Dense nuclei:** nothing is forced. Each junction gets its locally best arrangement, and gaps are bridged only between tips that are each other's best match. The N longest tracks are numbered as a starting point; you assemble the rest.
   - **Faint-ridge links** (dense nuclei; *Link longer gaps along faint ridges*, on by default since version 2026-11-24c). Ends still free after that may be linked to another free end up to 2.5 max gaps (≈ 1.4 µm) away. At least one of the two must be a tip. The pair is scored on how close the ends are, how well each points at the other, and how well their Z levels agree. It gets a bonus when a faint ridge links them: a path through voxels with at least a quarter of the detection threshold, at most 1.5 × their distance + 0.25 µm long, that never touches another traced track. Links are added best-first while the score is high enough. They are drawn dash-dotted, and the results panel counts them. The score's weights were fitted on SIM-like test nuclei.
   - **Bright-gap links** (dense nuclei; *Link gaps where the image stays bright*, on by default since version 2026-11-24f). A last pass: an end still free may be linked to another free end up to 2.5 max gaps away when the raw image stays bright across the gap and both ends lie at the same depth. The score adds 3.5 × the dimmest point along the straight gap (relative to the dimmer end; each sample is the brightest of 3 × 3 voxels in xy) and subtracts for the Z difference (1.2 per 3 Z steps), the bend at both ends (0.8 at the max bend each) and the distance (0.4 per max gap), with a bonus of 0.6 when both ends are tips. Links scoring above 0 are added best-first. They are drawn dash-dotted like faint-ridge links, and the results panel counts them. The weights were fitted on two hand-traced real nuclei (see *Hand-traced real nuclei* below).
   - **Max bend** is automatic when left blank: 60° for the exact search on sparse nuclei, 75° for dense nuclei (since 2026-11-24f; it was 60° for both). On real SIM data a track that breaks often bends 60–120° at the break.
6. **Labels and measures.** Every mask voxel takes the label of its nearest track. A table shows length, % of total, segments, gaps bridged, number of ends and a status (`ok`, `branched`, `loop`, `2 pieces`).

**Why plain tubeness failed before:** axial blur makes a filament's cross-section 2–3× taller in Z than it is wide, so a standard Hessian sees a sheet. The Hessian shape filter has a *Z elongation* setting that undoes this. It defaults to the PSF ratio for *Filaments / tubes* and to 1 (no correction, the original behaviour) for *Blobs* and *Sheets*.

**Clipping box as region.** Analyze-tab operations (tracing, the suggestions' background trace, spots, measurements, pattern spectrum) run on the clipping box only: the inputs are cropped to the box, and the results are put back in whole-image coordinates (layers pasted into full-size arrays, µm positions and voxel indices shifted by the box corner). Inside the box, a trace of the box matches the whole-image trace (median distance 0.0001 µm on the dense test nucleus).

## Editing: full reference

**Assembling and correcting.** Click **✎ Edit traces**. From 3D, the view switches to an XY max projection with the traces overlaid; you can also work in Slice, Ortho or 3D. Ortho always shows single slices (never the max projection). On slice views, trace parts within ±0.15 µm of the plane are drawn solid and those further away fade out, so you can see which tracks belong to the slice; *Solid within ± µm* in the tracing panel sets that distance, and only the visible parts can be clicked. Choose a click action: **Trace** (the default), **Erase**, **Paint** or **Select**. The earlier tools Route, Link and Guide are under *More tools*. Pick a chromosome number with a number button or key. `Esc` first drops a trace being drawn, a half-made route or link, a stroke, or the selection (in Select mode); the next `Esc` leaves Edit mode. Leaving Edit mode also clears the selection.

A **trace** here means one continuous line: for a chromosome, its connected piece (segments and the gap links between them); for unassigned pieces, a run up to the next junction.

**Trace: tracing by clicking (as in Fiji SNT).** You click points; the stretch between consecutive clicks follows the image.

- **A new trace:** click along a chromosome. The first click sets the start point, and each further click adds a stretch from the last point. This works over existing traces too, including the automatic trace. New traces get the chromosome picked in the number row (*New traces get chromosome*; Unassign = none). Pressing a number while you draw renumbers the trace you're drawing.
- **Extending a trace:** click near one of the trace's ends, then click a point. Ends are marked with dots; in Trace mode, unassigned pieces' ends show as small grey dots. The selected trace is outlined with its ends in white. A stretch is traced from the trace's end nearest that point, and further clicks carry on from there. The new stretches take the trace's chromosome.
- **Joining two traces:** click near an end of one trace, then near an end of another. They are joined between their closest ends, along a path traced through the image. The joined trace stays selected, so you can keep joining the next piece or extending it, until `Esc`. While you draw, a click near another trace's end joins the trace you're drawing to that trace.
- **Shift+click** selects a trace anywhere along it, to extend or join it.
- **Numbers after a join:** the result is one trace, so it gets one chromosome. The trace you clicked first keeps its number and the other takes it. A trace you are drawing from scratch takes the number of the trace it joins, if that has one. The message says what changed.
- **Finishing:** `Esc`, `Enter`, a right-click, or a click on the last point. While you draw, `Backspace` or `Ctrl+Z` takes back the last stretch. Once a trace is finished, `Ctrl+Z` undoes as usual and does not resume drawing.
- **Clicks on traces:** in a slice view, a click counts as a click on a trace only within 8 screen pixels of one of its ends. Anywhere else it places a point, as in SNT. `Alt`+click always places a point, even at an end.
- **Where a click lands, single slice:** it snaps to the brightest voxel within ±3 pixels and ±0.2 µm in depth.
- **Where a click lands, max projection:** the click doesn't say which depth you mean. Every bright layer at that spot is kept as a candidate, and the path search picks the layer the track continues into.
- **Following the mouse:** a dashed line runs from where the next stretch starts.
- **Trace on:** the channel the path follows is shown under the click actions and in the status line, and you can change it there. It must be the SC (ZYP1) channel. It defaults to the channel traced automatically. For **✎ Edit by hand now** it defaults to the tracing form's input.
- **Views:** place points in a slice view (Slice, or any Ortho plane). In 3D you can still join two traces by clicking one and then the other.
- **Kept on re-tracing:** traced stretches count as hand-drawn (*drawn* in the Segs list). Like Guide strokes, they are kept when you run the automatic trace again.

**Erase.** Drag over traces to remove the part under the brush. A trace erased in the middle becomes two pieces, and links the brush crosses go too.

- **Brush size:** 10 screen pixels either side of the stroke. Zoom in to erase finely.
- **Whole traces:** a click (no drag) erases the whole trace you click.
- **Depth:** on a single slice only traces near the slice are erased, the ones you can click; on the max projection, all depths.
- **What is left alone:** hidden traces.
- **Keys and undo:** Shift+drag pans, `Ctrl+Z` restores, and the `Delete` key picks Erase (in Select mode it deletes the selection).

**Showing and hiding traces.** Pieces assigned to a chromosome are drawn about twice as thick as unassigned ones (3 px against 1.3 px), and on top of them. Hiding only changes the view; it is not undone with `Ctrl+Z` and does not affect lengths or exports.

- **One chromosome:** untick it in the first column of the chromosome table. Its lines and ends disappear from every view, and so does its colour in the *Chromosomes* labels layer (slices and 3D; chromosomes 1–32).
- **Unassigned pieces:** untick the *none* row at the bottom of the table, or click **Hide unassigned**.
- **Only one chromosome:** pick it (number key, number button or a click on its row), then click **Show only chromosome N**. **Show all** brings everything back.
- **All trace lines at once:** press `T`, or untick **Show traces**, e.g. to look at the image underneath. The labels layer has its own tick in the Layers panel.

**Looking at a chromosome's segments.** In the trace table, the **Segs** number of each row is a dropdown. Click it to list that chromosome's segments in order along it, from one end through its segments and gap bridges. Each entry shows its place in the list, the segment number (as in the selection line), its length and its depth range, plus *shared with N* or *drawn* where that applies. A chromosome in several pieces is listed piece by piece, longest first. The *none* row lists the unassigned segments, longest first.

- **Picking a segment** highlights it in white and brings it into view. The slice cursor moves to its middle, so Slice shows its Z, and any slice view that doesn't show all of it is panned to it. A segment of a hidden chromosome is shown again. The mode does not change: outside Edit mode this is only for looking.
- **Where you are:** the row's dropdown reads e.g. *4/7* (segment 4 of 7), and the line under the table gives the segment's number, length and depth range.
- **Stepping:** `[` and `]` go to the previous or next segment along that chromosome, in or out of Edit mode. After you reassign a segment to another chromosome, `]` carries on with the segment that came after it.
- **Clearing:** Esc, or *Clear the highlight* at the top of the dropdown.
- **Changing it:** click ✎ **Edit traces**; the highlighted segment stays selected. With Click action on **Select**, `1`–`9` reassigns it, `0` unassigns it and `Delete` removes it. Leaving Edit mode clears the selection.

Hidden parts cannot be clicked, and Trace, Erase, Guide, Paint, Route and Unassign leave them alone. Editing a chromosome shows it again: assigning to a hidden chromosome, or drawing it with Trace or Guide, unhides it and the traces, and unassigning shows the unassigned pieces. A fresh trace or import starts with everything shown.

**Editing before (or instead of) the automatic trace.** **✎ Edit by hand now** in the tracing panel goes straight into Edit mode with an empty trace on the chosen input image, so you can trace chromosomes by clicking (Trace) without waiting. You can start the automatic trace at any time, also while you draw; `Esc` in Edit mode never cancels it. When it finishes, your hand-drawn segments (Trace and Guide) and the hand links between them are kept with their chromosome numbers, and the automatic pieces are added unassigned (muted), so they do not clash with your numbering. Join them to your traces with Trace, or number them with Paint. The same happens when you re-run tracing on a trace that has hand-drawn segments; assignments of earlier automatic pieces are not carried over.

**Unassign or delete.**

| Tool | Key | What happens to the segment | Use it for |
|---|---|---|---|
| **Unassign** | `0` | Taken off its chromosome. It stays in the trace, muted, and can be painted, routed through or linked again. Left out of lengths, labels and the default export (*Include unassigned pieces* exports it). | Pieces that are real SC but belong to a chromosome you haven't done yet, or that you're unsure about. |
| **Erase** (click action) | `Delete` picks it | Removed from the trace altogether, in part (drag) or in whole (click): gone from every view and export, and no tool can use it any more. Links attached to it go too. `Ctrl+Z` restores it. | Junk: background, noise, duplicates, wrong joins (erase the bad stretch and the trace splits there). |

With Unassign picked, Paint, Route and Guide unassign instead of assign: **Paint** the whole automatic piece (`Alt`+click: one segment), **Route** the stretch between two clicks, **Guide** every segment lying mostly inside the band. In **Select** mode the keys act on the selection: `0` unassigns, `Delete` deletes it.

| Click action | What a click does |
|---|---|
| **Trace** (default) | Points along a chromosome, traced through the image between clicks; a trace then a point extends it; a trace then another joins them; `1` takes the suggested way on (see above). |
| **Erase** | Drag: erase the part under the brush; click: erase the whole trace (see above). |
| **Paint** | Gives the whole automatic track piece to the active chromosome. `Alt`+click = that segment only. |
| **Select** | Selects a segment or gap; then `1`–`9` assigns it, `0` unassigns, `Delete` removes it from the trace, `B` toggles a gap bridge. |
| **Route** (More tools) | Click along a chromosome every few µm: the straightest path through crossings between consecutive clicks is assigned. Where there is no path along the trace, or only a long detour, the two clicked pieces are linked directly at their nearest ends instead (a hand-drawn link; `Ctrl+Z` if that was wrong). `Esc` ends a route. |
| **Link** (More tools) | Joins any two pieces with a straight link, with no distance or angle limit. Click near the end of one piece, then near the end of the piece it continues into. Clicking within 0.35 µm of an end uses that end (pieces under 1 µm: the nearer end). Clicking further in cuts the segment there and joins at the cut. An unassigned piece linked by its end joins the active chromosome. Links are drawn with long dashes; `B` turns one off. `Esc` cancels a half-made link. |
| **Guide** (More tools) | Drag along the true course of the active chromosome in an XY view (Slice or Ortho). The shaded band, at least 0.18 µm either side of your stroke, is where it is re-traced from the image. Both ends hook onto the nearest piece of the active chromosome within the band, or onto an unassigned piece if there is none. Segments of the active chromosome lying mostly inside the band are taken off it, since your stroke says it runs elsewhere there. Other chromosomes keep their segments, so a stretch two SCs share stays shared. With Unassign (`0`), a Guide stroke unassigns every segment lying mostly in the band. To pan without leaving Guide, hold Shift while dragging (or drag with the middle or right button). |

In Paint, Route and Select, `Shift` adds the segment as a shared stretch (two SCs lying together); with Trace, `Alt`+click lets you trace a second line on top of another. `Ctrl+Z` undoes in any mode. **Clear chromosome** and **Unassign all** let you start a chromosome over. Lengths and labels update immediately, and any chromosome that isn't a single path with 2 ends is flagged. **Renumber by length** orders chromosomes 1…N from longest to shortest. Lengths and full trace coordinates (µm) export as CSV; the labels layer exports as a CZI channel.

## Default channel for tracing

**Which channel by default (2026-11-26):** the tracing form's inputs no longer default to the first channel. They default to the **most line-like channel**, because SC tracks are long thin lines while foci are spots and DAPI is broad.
- How it is scored: on the max projection, the brightest 10% of pixels are rated by how line-shaped the image is there (from the Hessian). This takes about 0.2 s per file, once.
- Result: on 1804 and 1805 it picks T2 (ZYP1), scoring 0.55 and 0.53 against at most 0.41 for the other channels.
- Why it changed: the first channel is T1 (foci) on 1804 and T4 (DAPI-like) on 1805. Tracing by hand before the automatic trace therefore followed the wrong channel, with only 9–25% of each chromosome's trace on track; on T2 it is 94–100% (single slices).
- A channel you pick in the form or under *Trace on* is kept as long as it is loaded.

## How Trace finds the path, and how well

**How Trace finds the path.** It runs an A* search for the least-cost path between the two points through the image. The image is first sharpened along Z, as the tracer does it: Richardson–Lucy with the measured axial blur. For imported traces the blur is measured the first time you trace.

- **Cost:** each step costs its length × 1 / (0.05 + brightness), with brightness scaled 0–1 inside the search box (median to 99.5th percentile). Z steps count double, so the path stays in its layer unless the image says otherwise.
- **Search box:** 0.8–3 µm beyond the two points in XY, and 1 µm in depth.
- **Speed setting:** the search is weighted 1.5 towards the straight line. That is 2–3× faster than the exact search, at almost no cost in accuracy.

**How well Trace follows the chromosomes.** Clicks were placed along your hand traces of the two real nuclei, then snapped as above. The table gives the share of traced points within 0.1 µm of the hand trace:

| Nucleus | Clicks 2.5 µm apart | Clicks 5 µm apart | Straight lines, clicks 2.5 µm apart |
|---|---|---|---|
| 1804 (4 chromosomes, 198 µm) | 99.6% | 96% | 51% |
| 1805 (dense, 173 µm) | 98% | 84% | 40% |

**Compared with SNT, and why Trace first worked worse (2026-11-25).** SNT's default search (from its source) is the same kind of search. It runs over the whole raw image with cost 1 / intensity, rescaled 0–255 between the min and max of the box spanned by the two clicks. Re-implemented here, it scored *below* Trace's own search: on 1805, with clicks 2.5 µm apart on single slices, 93% against 95.6%. With clicks 5 µm apart, 71% against 78%. The path search was not the problem. Three things around it were:

| Problem (1805, clicks 2.5 µm apart) | Before | Now |
|---|---|---|
| **Clicks on the max projection** (Edit mode from 3D opens on it). The brightest depth was another, stacked track for about 1 click in 5. | 63% on track, 31% on other tracks | 88.5% (single slice: 95.6%) |
| **Clicking along a chromosome the automatic trace already covers.** All clicks counted as clicks on pieces, so whole automatic pieces were joined, wrong stretches included. | 43–86% on track; 112 µm traced for 78 µm | 94–100% on track, 92–98% of the hand trace covered |
| **✎ Edit by hand now** traced on the tracing form's first channel (T1, the foci, on 1804) without saying so. | wrong channel | shown and changeable under *Trace on* |

The last row is from the real interface: a click every 2.5 µm along hand-traced chromosomes 3 and 4.

- **Single slice or max projection:** single slices are still a little more accurate. Clicking chromosomes 3 and 4 by hand on 1805 gave 98–100% on track on single slices, 89–93% on the max projection.

- **Click spacing:** where chromosomes are crowded, click every 2–3 µm and at sharp turns. Clicks further apart sometimes cut across to a neighbouring track. If that happens, take the stretch back with `Backspace` and click a point in between.
- **Caveat:** the hand traces were themselves made with SNT's path search, which also favours bright paths.
- **Speed:** a click 2.5 µm from the last takes about 15–70 ms. Joining ends 8 µm apart takes about 0.5 s.

## Suggestions while tracing

**Suggestions while you trace (key 1).** While you trace, the way on is suggested from the end of your trace as a dashed yellow line with a numbered badge where it stops. It appears only where the app is reasonably sure of it. Press `1` to add it as the next stretch; new suggestions then follow from the new end. To ignore a suggestion, just keep clicking. Suggestions also appear when you select a trace by clicking near one of its ends; they continue from that end.

- **Where they come from:** an automatic trace of the whole image (or of the clipping box, when one is set), made by the same tracer as *Trace chromosomes*. If you have run *Trace chromosomes*, it is that result as it came out; your later edits do not change it. If you haven't, the same tracing runs in the background as soon as you trace by hand. It uses a second worker, so nothing else waits for it. On these nuclei it takes about 9 s, and the hint at the bottom of the view says *suggestions: preparing* until then.
- **When one is shown:** only when the last 1.5 µm of your trace runs along a chain of that automatic trace, with 75% of it within 0.15 µm and its end on the chain. The suggestion carries on along that chain.
- **Where it stops by default:**
  - at the first gap link the chain crosses;
  - at a junction where another branch turns about as well;
  - where the path changes depth sharply (more than 0.25 µm within 0.6 µm);
  - where the chain ends;
  - or at the *Suggestions* limit (5 µm by default; 3, 8, 12 µm or Off).

  Those are where the automatic trace goes wrong most often. If less than 0.5 µm is left before such a place, nothing is suggested.
- **How much to take:** `Shift`+scroll over the view moves where the suggestion stops. Scroll forward for longer, back for shorter, in steps of 0.25 µm. The bold dashed part is what `1` takes; the faint dotted line beyond it is how the automatic trace goes on, up to 15 µm, so you can see where you would be going. You can also click on the suggestion to take it up to that point (`Alt`+click still just places a point).
- **Path:** each suggestion is re-traced through the image as clicks 0.8 µm apart would be. It therefore follows the track, not the tracer's straight gap links.
- **Number keys:**
  - **No trace in progress:** they pick the chromosome for the next trace.
  - **Trace in progress** (being drawn, or selected to extend): they only take suggestions; another number shows a reminder and changes nothing. The number buttons in the panel still renumber the trace in progress.
- **Finishing a trace** before starting another: `Esc`, `Enter`, a right-click, or **✓ Done with this trace** under the chromosome buttons. The line at the bottom of the XY view always says what the keys do at that moment.

How often they are right, from your hand traces. Tips were placed every 2.5 µm along each hand trace, with the trace so far made of Trace-tool clicks; a suggestion counts as right if all of it, up to where it stops, lies within 0.25 µm of the hand trace.

| Nucleus | Tips with a suggestion | Right | Mean length |
|---|---|---|---|
| 1804 | 40 of 74 | 39 (97.5%) | 1.9 µm |
| 1805 | 26 of 65 | 23 (88.5%) | 1.6 µm |

- **Earlier version, for comparison:** the version before this (several suggestions, longer, also where the tracer was unsure) was right 65–79% of the time.
- **Errors left:** the remaining wrong ones take a shortcut where a chromosome touches itself, or follow a track stacked in another layer.
- **Why every gap stops a suggestion:** on 1804, 12 of the 93 gap links that suggestions crossed were wrong. Neither the tracer's own cost nor the image across the gap tells which (gap brightness: AUC 0.73).
- **Speed:** a suggestion takes about 50–100 ms after each click or key press.

## How Guide re-traces, and how well

**How Guide re-traces.** It finds the cheapest 3D path through the band's voxels from one end of the stroke to the other. Bright voxels near the stroke's centre line are cheap and Z steps count double, so the path keeps to one track and layer unless the image says otherwise. It may not jump between stretches of your stroke that pass close together, such as two sides of a tight bend. The band is first sharpened along Z, the same way the tracer sharpens the whole image (Richardson–Lucy with the axial blur measured when tracing; imported .traces have no measured blur, so their bands are not sharpened). Guide re-traces from the trace's own input channel, or, for imported traces, the first visible intensity layer. **Depth.** Drawn on a single slice (Slice with *Max projection* off, or Ortho), the whole path stays within the depth where traces show and can be clicked around that slice: ±3 × *Solid within* (±0.45 µm by default, at least ±0.3 µm). It prefers to stay close to the slice, and its ends only hook onto segments within that range. A track that dives out of that range should be drawn on the slice where it continues. If no track can be followed within the range, Guide still traces, taking depth from the image, and says so. On the real stack, strokes drawn on a slice previously ran up to 0.86 µm away from it (9% of points beyond ±0.45 µm); now 0–5%, the rest being tracks that themselves leave the slice. Drawn on the max projection, the depth comes from the image: the path may start at any bright voxel near each end, in any layer. Lines are smoothed and given sub-voxel Z, as for automatic traces.

**How well Guide works.** Tested on 5 SIM-like test nuclei with 188 strokes, each 3 µm along the true path with ±0.04 µm hand wobble:

| Stroke | Re-traced points within 0.1 µm of the true path | Points nearer another SC |
|---|---|---|
| Starts and ends on pieces of the chromosome being edited | 90% | 6% |
| Ends not on any piece (no hook-up, layer chosen from the image) | 84% | 11% |
| Sloppier hand (±0.12 µm wobble), hooked up | 86% | 9% |

- **No stroke failed.** If keeping to the stroke's order finds no path, Guide tries once more without that rule.
- **Where the errors are.** Points nearer another SC are mostly at crossings and on stacked stretches. The tracer's own confident pieces score 98% on the same measure, but they avoid exactly those hard places.
- **Z sharpening** raised the 0.1 µm share by 4–7 points on every nucleus, with no clear change in wrong-track points.
- **Per stroke:** on average about +1.9 µm correctly assigned and +0.4 µm wrongly assigned.
- **Speed:** 0.1–0.3 s per stroke.
- **Real stack:** strokes along the tracer's long pieces gave back the same track (median 0.03–0.05 µm apart). That includes one whose stroke crosses itself, which failed before the stroke-order rule was refined.

## SNT .traces files

- **Save / Save as… (SNT .traces)** (tracing panel) write one path per chromosome, named `Chromosome N` and coloured as here. A chromosome that branches or is in pieces gets extra paths, `Chromosome N (part 2)` and so on. Unassigned pieces are saved as `Unassigned piece N` (always by Save, by Save as… when ticked). The file is gzip-compressed XML, like SNT's own, with this image's voxel size and dimensions. In Fiji, open the same .czi, start SNT and load the file (File › Load Tracings).
- **Saving back to a file (2026-11-27).** Where the browser has the File System Access API (Chrome, Edge), a `.traces` file opened with Open, Import .traces (SNT)… or a drop comes with a `FileSystemFileHandle` (`showOpenFilePicker`, `DataTransferItem.getAsFileSystemHandle`), kept as `trace.file` together with whether the file was gzip-compressed. Save asks for write permission on the click (`requestPermission`) and writes the file again in the same compression; Save as… uses `showSaveFilePicker` and links the trace to the new file. `trace.edits` counts edits (`traceChanged`) and `trace.savedEdits` the count at the last save, for the "unsaved changes" line and the warning on closing the window. Without the API (Safari, Firefox), Save as… asks for a name in the app and downloads the file. Tested with stand-in dialogs returning files in the browser's private storage (real writable handles): save back (gzip kept, re-read gives the edited chromosomes), the first-save question, Save as… and later saves to the new file, the download fallback, and CSV exports.
- **Import .traces (SNT)…** (tracing panel; or drop the file on the window, or pick it with Open) replaces the current trace with the file's paths. It adds a `Chromosomes · <file>` labels layer and a thin `Trace tube` mask that the labels fill. Earlier label layers stay, so you can compare them. The imported trace can be edited and exported like any other.
  - **Chromosome numbers come from path names.** `Chr 2`, `chr2`, `Chromosome 2`, `Bivalent 2`, `SC2`, a plain `2`, or an SNT tag such as `Path (5) [Chr2]` all mean chromosome 2. Paths named `Unassigned…` belong to none. If the file names no chromosomes at all, each SNT tree (a path plus its branches) becomes its own chromosome.
  - **Branches** (paths that start on another path) are joined at the branch point. Where a path has a fitted version, the fitted one is used if SNT was set to use it.
  - **Placement:** points are placed by voxel position, so the file must come from the same image (same crop). If the file's image size or voxel size differs, a warning says so.

Tested with two files written by SNT (hand traces of the two real nuclei below, one gzip-compressed and one plain XML): all paths import, and their lengths match SNT's own `reallength` to 0.1 µm. Export → import round trips give back the same chromosomes.

**SNT 5 compatibility.** Exports made before 2026-11-25 wrote `spines="false"` on every path. SNT reads that attribute as a whole number and refused those files with *"There was an invalid attribute … NumberFormatException: For input string: "false""*. Passing validation against SNT's DTD had not caught it.

- **What changed:** exports now write the path attributes as SNT itself does (`spines="0"`, colours as `#rrggbbaa`, path ids from 1, units `µm`).
- **Tested:** loaded in SNT 5.0.22 (Fiji, run headless). The 1804 hand traces exported from here load with all 4 paths, and their lengths match the original to 0.01 µm.
- **Older exports:** re-export them, or import them here and export again. Changing `spines="false"` to `spines="0"` in the unzipped XML also repairs them.

## Test nuclei (Demo volume)


- **Dense pachytene — SIM-like** (`js/demo-dense.js`) is modelled on the real stack `Experiment-1805-SIM Processing-09_processed.czi`. Each click makes a new random nucleus with known ground truth.
  - **What's in it:** 4 SCs, about 170 µm in total, packed in a flattened, dome-shaped nucleus of 6.4 µm diameter and ~2 µm depth. The tracks are wavy, with their direction decorrelating over ~0.5 µm. They lie in layers ≥ 0.28 µm apart, climb over each other now and then, and have their telomeres at the envelope. They have beaded intensity, dim stretches and short gaps.
  - **Imaging:** a SIM-like PSF (0.2 µm across a track, 0.6 µm in Z) with weak axial side lobes. Reconstruction ringing leaves a dark halo after clipping. There is grainy noise inside the nucleus only, clipped at 0, and dim nucleoplasmic foci.
  - **Calibration:** it was matched to the real stack on the intensity histogram inside the nucleus, the track profile in xy and Z, nucleus shape, track spacing and overlap, curvature, and how the tracer breaks it up (pieces, free ends, junctions).
  - **Total SC length:** the real nucleus probably holds 160–210 µm of SC (estimated from mask volume and total signal), more than the ~120 µm the tracer recovers.
- **Sparse pachytene** (`makeSCDemo`): 4 short SCs (42 µm) that the tracer can separate fully automatically.

## How well the tracer works

- **Dense SIM-like nuclei** (version 2026-11-24b, 22 random nuclei the settings were not tuned on: 4 default, 3 each with curvier, straighter, more crowded or thicker packing, and 3 each with narrower (0.18 µm) or wider (0.28 µm) axial blur):

  | | Before (form defaults of 2026-11-24a) | Now |
  |---|---|---|
  | Each chromosome's length found in its own pieces, after perfect assembly | 74% | 85% |
  | SC length not traced at all | 18% | 9% |
  | Pieces to click for 90% of each chromosome (4 chromosomes) | 42 | 34 |
  | Wrong joins (junction + gap) | 4.5 | 3.8 |

  - **Where the gain comes from:** the finer ridge scale gives completeness 74% → 80%. Sharpening along Z gives 80% → 85% and most of the drop in clicks, and it improves every one of the 7 kinds of test nucleus.
  - **Scoring:** a join counts as correct when the same true SC runs along both arms and is continuous across the junction or gap. This label also handles merged tracks; the older "majority owner" label reported about twice as many wrong joins as there are.
  - **What did not help** (each tested on the same nuclei; kept out): allowing gap bridges from arms that stop at a junction (8% fewer pieces but as many extra wrong joins); judging gaps by the arms' Z levels; image cues inside junctions (intensity along the candidate path, track brightness, Z-thickness, curvature continuity), none of which added information beyond bend and Z change; choosing the ridge scale from the measured track width; ridge threshold 1.0 or 1.2; stronger *Keep tracks in their Z layer*; longer max gap.
  - **What limits it:** with perfect join decisions (tested with the ground truth) there would be only ~3 wrong joins but about as many pieces, so the remaining pieces come from where tracks break (gaps, dim stretches), not from wrong choices. About 6% of SC length still runs merged with another track and is traced only once; mark such stretches as shared (`Shift`) when assembling.
- **Faint-ridge links** (version 2026-11-24c), on the same 22 held-out nuclei:

  | | Without links | With links |
  |---|---|---|
  | Pieces | 49 | 40 |
  | Pieces to click for 90% of each chromosome | 34 | 29 |
  | Correct gap joins | 20 | 27.6 |
  | Wrong gap joins | 1.5 | 2.3 |

  - **Result:** 7.6 more correct joins per nucleus for 0.8 more wrong ones, so the added links are 90% correct. Every one of the 7 kinds of test nucleus has fewer pieces with links.
  - **How the rule was found:**
    - After the existing joins, each nucleus still has ~26 pairs of free ends that truly continue each other. About half are farther apart than the max gap. Most of the rest fail the angle test because the two ends overshoot side by side.
    - Geometry alone (distance, bend, Z agreement, curvature extrapolation) could add joins at only ~78% precision.
    - The faint-ridge link raised that above 90%. Requiring a tip removed the worst case: two arms stopped at junctions, linked correctly only 2 times in 7.
    - Everything was designed on 12 separate nuclei and only then run on the 22.
  - **Also tried for joining, and left out:**
    - Re-pairing arms left free at the same junction: ~78% correct.
    - Signal along the gap, ridge orientation along the predicted path, and distance from the nuclear edge: they add little once the faint-ridge link is used.
    - "Over/under" completion of a track interrupted where it crosses another: gaps that cross another track are mostly *false*.
    - Vetoing existing short bridges that have no ridge link: fewer wrong joins, but as many extra clicks.
    - A looser threshold (0.4): 2 more joins per nucleus, at 84% precision for the extra ones.
- **Sparse nuclei** (fully automatic separation into 4): 82% mean voxel accuracy over 12 nuclei, against 80% without sharpening. Individual nuclei flip both ways (on the first 8 alone it was 81% against 86%), because one changed decision moves a whole chromosome. Faint-ridge links never run here (only in the dense mode).
- **Real dense nucleus** (`Experiment-1805-SIM Processing-09_processed.czi`, ZYP1 = channel T2): automatic separation into 4 is not reliable; you assemble the pieces with Paint and Route.
  - **Now:** 49 pieces. The measured axial σ is 0.23 µm, so sharpening uses 0.21. Half the traced length is in pieces of 5.3 µm or longer, and 128 µm is traced in total.
  - **Before (2026-11-24a form defaults):** 58 pieces, half the length in pieces of 3.0 µm or longer, 121 µm traced.
  - **What changes on this stack:** sharpening changes the skeleton more here than on the test nuclei. Junctions fall from 34 to 11, and the tracks come apart into separate stretches that are joined across gaps instead: 45 gap bridges against 16. Gap bridges were 93% correct on the test nuclei, but on this stack they can only be checked by eye.
  - **Checks:** sharpening did not create doubled tracks. Trace length with another trace 0.12–0.5 µm directly above or below it fell from 6% to 2%, and no extra trace length comes from dim signal.
  - **Faint-ridge links (2026-11-24c):** 7 links, 0.26–0.69 µm long. Pieces fall from 49 to 42, and half the traced length is now in pieces of 8.1 µm or longer (was 5.9). By eye, two links clearly follow a bright stripe, one probably does, and four sit in crowded spots where I can't tell.
- **Hand-traced real nuclei** (version 2026-11-24f). Two real SIM nuclei with complete hand traces made in SNT, each with 4 chromosomes: `Experiment-1804-SIM Processing-08_processed_crop.czi` (198 µm of SC) and `Experiment-1805-SIM Processing-09_processed.czi` (173 µm, much overlap and doubling back). ZYP1 is channel T2 in both.

  | | 1804 before | 1804 now | 1805 before | 1805 now |
  |---|---|---|---|---|
  | Hand-traced length the tracer covers | 95% | 95% | 95% | 95% |
  | Pieces | 22 | 18 | 42 | 32 |
  | Pieces to click for 90% of each chromosome | 21 | 19 | 28 | 21 |
  | Correct joins | 65 | 69 | 53 | 64 |
  | Wrong joins | 5 | 5 | 4 | 4 |

  - **Scoring:** a trace point covers the hand trace within 0.12 µm in xy and 0.3 µm in Z. A join is correct when the same hand-traced chromosome runs along both arms and continues across the junction or gap (a strand that doubles back counts as a different place). Joins whose arms are not on the hand trace are not judged (0 and 3).
  - **Why chromosomes broke into pieces** (piece ends that are not chromosome ends, before the change): end-to-end gaps of 0.27–0.69 µm (9 and 24), a tip stopping 0.3–0.6 µm short of the side of another piece where the chromosome then runs along that piece for 0.7–8 µm (16 and 25), and junctions where the continuation went to another piece (9 and 11).
  - **Bright-gap links:** at the real gaps the stubs often point 60–120° away from each other, so the angle rule rejected them. Among candidate joins between free ends, the brightness along the gap separated true from false far better (AUC 0.86 and 0.89) than distance (0.73–0.75) or bend (0.59–0.70). Weights fitted on one nucleus and tested on the other added 4 and 11 links with 1 wrong one; the shipped weights (fitted on both) add 2 and 6, all correct. A looser threshold added more links, but on 1804 the extra ones were wrong as often as right.
  - **Max bend 75° for dense nuclei:** fewer pieces on both nuclei with no more wrong joins. On 6 sparse test nuclei the exact search made 3 more wrong joins at 75°, so it keeps 60°.
  - **On 6 dense test nuclei** (synthetic, not used for fitting) both changes together: pieces 230 → 172, clicks for 90% 196 → 157, correct joins 315 → 354, wrong joins 32 → 42. The bright-gap pass is less precise on the synthetic nuclei (about 65% of its links right) than on the real ones; the real data decided.
  - **Checked and kept as before:** Z-sharpening (without it coverage falls from 95% to 89% and the clicks rise by half), faint-ridge links (without them 1804 needs 22 clicks instead of 19), ridge threshold, ridge scale (its effect jumps around from one value to the next on real data), and *Keep tracks in their Z layer* (no effect).
  - **Not solved — shared stretches:** about a quarter of each hand trace lies where two chromosomes run together as one track, and most remaining breaks are where a chromosome joins such a stretch. Pieces cannot share a track, so the tracer stops there; assemble these with Guide (draw along the shared stretch for the second chromosome) or `Shift` (shared).

## Testing done

- Reading: six public Zeiss sample files covering multi-scene, time series, mosaics, RGB, tiled Z-stacks and a 24-tile scene.
- zstd decoding: checked with hand-built zstd and hi/lo-packed subblocks.
- Export: round-tripped bit-exactly for 8-bit, 16-bit and float, including cropped regions. The segment layout matches a ZEN-written file.
- Tracing: benchmarked on 22 dense SIM-like nuclei that were not used for tuning, in 7 variants (see *How well it works*), and 12 sparse ones. Sanity-checked on the real example stack. The axial-blur estimate returned 0.18, 0.22 and 0.29 µm on test nuclei rendered with 0.18, 0.22 and 0.28 µm.
- Tracing on real data: scored against complete hand traces (SNT) of two real SIM nuclei; the 2026-11-24f changes were checked through the app itself (worker and form defaults) on both, and on 6 dense and 6 sparse test nuclei.
- Hand editing: Link (end-to-end and mid-segment cuts, undo) and Guide (scored against ground truth on 5 test nuclei, and on the real stack) were driven both from scripts and with real mouse clicks and drags.
- Showing and hiding traces: checked on the real 1804 nucleus in Slice and 3D, with the table ticks, buttons and `T` key. Hidden pieces could not be clicked or removed by strokes, and assigning to a hidden chromosome showed it again.
- Segment list: on the same nucleus, every consecutive pair in each chromosome's list was joined by a node or gap bridge. The Segs dropdowns in the table were checked:
  - picking stays out of Edit mode and leaves the click mode alone, also from 3D and from hidden unassigned pieces;
  - opening a dropdown doesn't select its row;
  - `[` `]` stepping and Esc work outside Edit mode, and so does the dropdown's clear option;
  - the highlight carries into Edit mode, where Select reassigns it, stepping continues after the reassign, and undo works;
  - leaving Edit mode clears it.
- Trace and Erase (2026-11-25), on 1804 and 1805 with pointer events on the XY slice and some real mouse clicks:
  - **New trace:** 4 clicks along a hand-traced chromosome gave 3 stretches.
  - **Extend:** a stretch started at the clicked trace's nearest end.
  - **Join:** two traces were joined between their closest ends along the image. A chromosome 2 trace took chromosome 1's number; an unassigned automatic piece took chromosome 2's number. A join from 3D worked too.
  - **Erase:** a brush stroke across the middle cut 0.57 µm and split the trace (4 ends); a click erased a whole piece.
  - **Finishing and taking back:** `Backspace` stepped back to the start point and then dropped it. A right-click, `Enter` and `Esc` finished. `Alt`+click placed points on a trace. A number renumbered the trace being drawn.
  - **Undo:** worked after a finish and did not resume drawing.
  - **Older tools:** Guide still works from *More tools*.
  - Path accuracy is in the table above.
- Suggestions while tracing (2026-11-26, second version), on 1804 through the app (pointer events on the XY view, key and wheel events), by hand before any automatic trace:
  - **Background trace:** *Edit by hand now* started it; it was ready after 8.8 s, and the hint said *suggestions: preparing* until then. The main worker stayed free.
  - **Taking part of one:** three Shift+scroll notches forward and one back moved the end from 1.0 to 1.5 µm without changing slice; `1` then added exactly 1.48 µm. A click on a suggestion 1 µm along it added 0.97 µm.
  - **Number keys:** with a trace in progress, `3` changed nothing and showed the reminder. After **Done** (which then hid itself) `3` picked chromosome 3.
  - **Accuracy:** see the table above.
- **Not yet tested:** opening the exported files in ZEN or Fiji. Please check one before relying on them.

## Loading speed

**How a file is loaded (2026-11-27).** After the header is read, the planes of the selected scene, time point, channels and Z range are decoded by a pool of background workers: one fewer than the processor cores, at most 8 (`App.loadPlanes`, `CZIReader.plan` / `decodePlane`). Each worker reads whole planes straight from the file, so reads and zstd decompression run in parallel. While it has a plane in hand, each worker also:

- takes the plane's min and max (the layer's range, so no full min/max pass afterwards);
- counts every value of 8/16-bit data (the layer histogram, exact, instead of sampling the volume afterwards);
- keeps a running max projection along Z per channel (merged at the end; used by Slice's max projection and to pick the ZYP1 channel);
- when the 3D texture has to be reduced to fit the GPU budget, makes a box-averaged copy of the plane for it.

The result is identical to the single-worker loader: checked voxel for voxel on the 1804 and 1805 stacks at full resolution, binned 2×, and for a Z range with two channels. The ranges, histograms and projections were also identical. A reduced 3D texture differs from the old one by at most one half-float step (rounding of the box means).

**GPU upload.** A layer's 3D texture is filled with one call up to 64 M voxels (slabs above that), instead of one call per slice. The uploaded values are bit-identical to before. A channel's ZYP1 score is computed from its max projection; images over 1.5 M pixels are max-pooled first.

**Retina / 2× screens.** The volume is ray-marched at up to 1.5 pixels per CSS pixel (44% fewer pixels than 2×); the overlay with lines and text stays at full density.

**Measured** (cold start in Microsoft Edge, headless, on a PC with Intel UHD 730 graphics and 12 cores):

| File | Before | After | Longest freeze, before → after |
|---|---|---|---|
| 1804 processed crop (51 MB, 361×441×40×4) | 2.6 s | 0.7 s | 1.7 → 0.35 s |
| 1805 processed (46 MB, 294×320×61×4) | 2.7 s | 0.7 s | 1.2 → 0.3 s |
| 1805 SIM (3.2 GB uncompressed, 2560×2560×61×4, full resolution) | 64 s | 13 s | 56 → 3.7 s |

For the 3 GB stack the old time went on reducing the 3D textures (29 s), projecting and scoring channels (19 s) and min/max (7 s), all on the main thread. Now about 8–10 s of the 13 s is reading and copying the 3.2 GB; this machine's browser reads a file at about 0.6 GB/s from one reader and 1 GB/s from eight. Not measured on a Mac.
