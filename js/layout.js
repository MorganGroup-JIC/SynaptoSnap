/* CZI Volume Studio: window layout.
   - Side panels: drag the thin handle between a panel and the views to resize it (180-600 px, the views keep at
     least 300 px); double-click the handle for the default width; the small tab on the handle hides / shows the panel.
   - Ortho view: drag the line between the panes (or the dot where the lines cross) to change the pane sizes;
     double-click to go back to the automatic split (App.layoutViews, which follows the stack's X/Y/Z proportions).
   Widths, hidden panels and the Ortho split are kept in localStorage (when the browser allows it for file:// pages).

   Everything works through CSS variables and classes on <html>, so this file is loaded from <head> and the saved
   layout applies before the first paint. The handles are added once the DOM is ready. The only app state it touches:
   slice views that were showing the whole slice are re-fitted when their pane changes size (zoomed-in views keep
   their zoom and position). */
(function () {
  'use strict';
  const KEY = 'cziVolumeStudio.layout';
  const MIN_W = 180, MAX_W = 600, MIN_MAIN = 300, SNAP_CLOSE = 90, MIN_PANE = 80;
  const SIDES = ['left', 'right'];
  const root = document.documentElement;

  // ------------------------------------------------------------------ saved state
  const state = { left: { w: null, collapsed: false }, right: { w: null, collapsed: false }, orthoC: null, orthoR: null };
  (function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { s = null; }
    if (!s || typeof s !== 'object') return;
    for (const side of SIDES) {
      const v = s[side];
      if (!v || typeof v !== 'object') continue;
      if (Number.isFinite(v.w)) state[side].w = Math.min(MAX_W, Math.max(MIN_W, Math.round(v.w)));
      state[side].collapsed = v.collapsed === true;
    }
    for (const k of ['orthoC', 'orthoR']) if (Number.isFinite(s[k]) && s[k] > 0 && s[k] < 1) state[k] = s[k];
  })();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* storage unavailable (file://, private mode) */ }
  }

  // ------------------------------------------------------------------ side panels
  const handles = {}, toggles = {};
  // default width from the stylesheet (the @media rule changes --left-def / --right-def on narrow windows)
  function defaultWidth(side) {
    let v = NaN;
    try { v = parseFloat(getComputedStyle(root).getPropertyValue(side === 'left' ? '--left-def' : '--right-def')); } catch (_) { /* no style yet */ }
    return Number.isFinite(v) && v > 0 ? v : side === 'left' ? 300 : 340;
  }
  function wantedWidth(side) {
    return state[side].collapsed ? 0 : state[side].w != null ? state[side].w : defaultWidth(side);
  }
  // widths actually used: the wanted ones, narrowed (not below MIN_W) when the window cannot keep MIN_MAIN for the views
  function widths() {
    const w = { left: wantedWidth('left'), right: wantedWidth('right') };
    const over = w.left + w.right - Math.max(0, window.innerWidth - MIN_MAIN);
    if (over > 0) {
      const room = { left: Math.max(0, w.left - MIN_W), right: Math.max(0, w.right - MIN_W) };
      const total = room.left + room.right;
      if (total > 0) for (const side of SIDES) w[side] -= Math.min(room[side], over * room[side] / total);
    }
    return w;
  }
  function applyPanels() {
    const w = widths();
    root.style.setProperty('--left-w', Math.round(w.left) + 'px');
    root.style.setProperty('--right-w', Math.round(w.right) + 'px');
    for (const side of SIDES) {
      root.classList.toggle(side + '-collapsed', state[side].collapsed);
      const hd = handles[side];
      if (hd) {
        hd.classList.toggle('collapsed', state[side].collapsed);
        hd.firstChild.title = (state[side].collapsed ? 'Show the ' : 'Hide the ') + (side === 'left' ? 'layers panel' : 'tools panel');
      }
    }
  }

  // ------------------------------------------------------------------ ortho split
  // fr values scaled by 1000: when one pane sits at its minimum, the other's flex factor must stay >= 1 or CSS
  // gives it only that fraction of the remaining space
  const tracks = (f) => `minmax(${MIN_PANE}px, ${(f * 1000).toFixed(2)}fr) minmax(${MIN_PANE}px, ${((1 - f) * 1000).toFixed(2)}fr)`;
  // Only used by CSS rules scoped to body[data-view="ortho"], so the 3D and Slice layouts never see them.
  function applySplit() {
    for (const [k, cls, prop] of [['orthoC', 'ortho-c', '--ortho-cols'], ['orthoR', 'ortho-r', '--ortho-rows']]) {
      if (state[k] != null) root.style.setProperty(prop, tracks(state[k])); else root.style.removeProperty(prop);
      root.classList.toggle(cls, state[k] != null);
    }
  }

  applyPanels();
  applySplit();

  // ------------------------------------------------------------------ helpers
  // Slice views that show the whole slice (zoom = fit) at the start of a change are re-fitted as their pane changes;
  // views the user zoomed or panned are left alone.
  function fittedSlices() {
    const app = window.app, out = [];
    if (!app || !app.dims || !app.sliceViews) return out;
    for (const s of Object.values(app.sliceViews)) {
      try {
        if (!s.host || !s.host.clientWidth || !s.host.clientHeight) continue; // hidden
        if (!s.zoom) { out.push(s); continue; }
        const z = s.zoom, cx = s.cx, cy = s.cy;
        s.fit();
        const same = Math.abs(s.zoom - z) <= 1e-6 * z && Math.abs(s.cx - cx) <= 1e-6 * (Math.abs(cx) + 1e-3) && Math.abs(s.cy - cy) <= 1e-6 * (Math.abs(cy) + 1e-3);
        s.zoom = z; s.cx = cx; s.cy = cy;
        if (same) out.push(s);
      } catch (_) { /* slice view changed: leave it alone */ }
    }
    return out;
  }
  function refit(list) {
    for (const s of list) {
      try { const z = s.zoom; s.zoom = 0; s.resize(); if (!s.zoom) s.zoom = z; } catch (_) { /* ignore */ }
    }
  }
  // histogram widgets size their bitmap when they draw; redraw the ones a panel resize has stretched
  function redrawPanelHistograms() {
    const dpr = window.devicePixelRatio || 1;
    document.querySelectorAll('#left canvas.hist, #right canvas.hist').forEach((c) => {
      if (c.clientWidth && Math.abs(c.width - c.clientWidth * dpr) > 1) {
        try { c.dispatchEvent(new PointerEvent('pointerleave')); } catch (_) { /* old browser */ }
      }
    });
  }
  // pointer drag with capture, coalesced to one update per frame
  function dragger(el, { start, move, end, cls }) {
    let d = null;
    const step = () => { if (!d) return; d.raf = 0; move(d); };
    const finish = (e) => {
      if (!d) return;
      if (d.raf) { cancelAnimationFrame(d.raf); step(); }
      const done = d; d = null;
      done.endType = e ? e.type : 'cancel';
      root.classList.remove(done.cls);
      try { if (el.hasPointerCapture(done.id)) el.releasePointerCapture(done.id); } catch (_) { /* already released */ }
      end(done);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || d) return;
      const s = start(e);
      if (!s) return;
      e.preventDefault(); e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
      d = Object.assign(s, { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, raf: 0, cls });
      root.classList.add(d.cls);
    });
    el.addEventListener('pointermove', (e) => {
      if (!d || e.pointerId !== d.id) return;
      d.x = e.clientX; d.y = e.clientY;
      if (!d.moved && Math.abs(d.x - d.x0) < 3 && Math.abs(d.y - d.y0) < 3) return;
      d.moved = true;
      if (!d.raf) d.raf = requestAnimationFrame(step);
    });
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('lostpointercapture', finish);
    return { cancel: () => finish(null) };
  }

  // ------------------------------------------------------------------ DOM
  const CHEVRON = '<svg viewBox="0 0 7 12" aria-hidden="true"><path d="M5.5 1 L1.5 6 L5.5 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function makePanelHandle(side, main) {
    const panel = document.getElementById(side);
    if (!panel) return;
    const hd = document.createElement('div');
    hd.className = 'pane-handle ' + side;
    hd.title = 'Drag to resize the panel. Double-click: default width.';
    const tab = document.createElement('div');
    tab.className = 'pane-tab';
    tab.setAttribute('role', 'button');
    tab.innerHTML = CHEVRON;
    hd.appendChild(tab);
    main.appendChild(hd);
    handles[side] = hd;

    const other = side === 'left' ? 'right' : 'left';
    const toggle = () => {
      const fit = fittedSlices();
      state[side].collapsed = !state[side].collapsed;
      applyPanels(); refit(fit); save();
      if (!state[side].collapsed) redrawPanelHistograms();
    };
    toggles[side] = toggle;
    // the tab is part of the handle: a click on it hides / shows the panel, a drag from it resizes like the handle
    let downOnTab = false;
    dragger(hd, {
      cls: 'lay-drag-col',
      start: (e) => {
        downOnTab = tab.contains(e.target);
        hd.classList.add('active');
        return { w0: state[side].collapsed ? 0 : panel.getBoundingClientRect().width, wPrev: state[side].w, fit: fittedSlices() };
      },
      move: (d) => {
        const dx = d.x - d.x0, w = side === 'left' ? d.w0 + dx : d.w0 - dx;
        if (w < SNAP_CLOSE) { // dragged almost shut: hide the panel; the tab brings it back at its width before the drag
          state[side].collapsed = true; state[side].w = d.wPrev;
        } else {
          const max = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - MIN_MAIN - wantedWidth(other)));
          state[side].collapsed = false;
          state[side].w = Math.round(Math.min(max, Math.max(MIN_W, w)));
        }
        applyPanels(); refit(d.fit);
        if (!state[side].collapsed) redrawPanelHistograms();
      },
      end: (d) => {
        hd.classList.remove('active');
        if (d.moved) save();
        else if (downOnTab && d.endType === 'pointerup') toggle();
      },
    });
    hd.addEventListener('dblclick', () => {
      if (downOnTab) return; // double-click on the tab: just two toggles
      const fit = fittedSlices();
      state[side].w = null; state[side].collapsed = false;
      applyPanels(); refit(fit); save();
      redrawPanelHistograms();
    });
  }

  function makeOrthoSplitters(views, vxy) {
    const mk = (cls, title) => {
      const el = document.createElement('div');
      el.className = 'ortho-split ' + cls; el.title = title;
      views.appendChild(el);
      return el;
    };
    const sC = mk('col', 'Drag to change the pane widths. Double-click: automatic split.');
    const sR = mk('row', 'Drag to change the pane heights. Double-click: automatic split.');
    const sB = mk('both', 'Drag to resize all four panes. Double-click: automatic split.');
    const isOrtho = () => document.body.dataset.view === 'ortho';
    const gap = (prop) => { const v = parseFloat(getComputedStyle(views)[prop]); return Number.isFinite(v) ? v : 0; };

    // the splitters sit on the gaps around the XY pane (top left)
    function place() {
      if (!isOrtho()) return;
      const r = views.getBoundingClientRect(), a = vxy.getBoundingClientRect();
      if (!a.width || !a.height) return;
      const x = a.right - r.left + gap('columnGap') / 2, y = a.bottom - r.top + gap('rowGap') / 2;
      sC.style.left = sB.style.left = x.toFixed(1) + 'px';
      sR.style.top = sB.style.top = y.toFixed(1) + 'px';
    }
    const frac = (px, total) => (total <= 2 * MIN_PANE ? 0.5 : Math.min(total - MIN_PANE, Math.max(MIN_PANE, px)) / total);

    const drags = [[sC, true, false], [sR, false, true], [sB, true, true]].map(([el, doC, doR]) => {
      const lit = doC && doR ? [sC, sR, sB] : [el];
      const dr = dragger(el, {
        cls: doC && doR ? 'lay-drag-move' : doC ? 'lay-drag-col' : 'lay-drag-row',
        start: () => {
          if (!isOrtho()) return null;
          const r = views.getBoundingClientRect(), a = vxy.getBoundingClientRect();
          lit.forEach((x) => x.classList.add('active'));
          return { w0: a.width, h0: a.height, W: r.width - gap('columnGap'), H: r.height - gap('rowGap'), fit: fittedSlices() };
        },
        move: (d) => {
          if (doC) state.orthoC = frac(d.w0 + d.x - d.x0, d.W);
          if (doR) state.orthoR = frac(d.h0 + d.y - d.y0, d.H);
          applySplit(); refit(d.fit); place();
        },
        end: (d) => { lit.forEach((x) => x.classList.remove('active')); if (d.moved) save(); },
      });
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const fit = fittedSlices();
        if (doC) state.orthoC = null;
        if (doR) state.orthoR = null;
        applySplit(); refit(fit); place(); save();
      });
      return dr;
    });

    // keep the splitters on the gaps whatever changes the pane sizes (window, side panels, App.layoutViews)
    if (window.ResizeObserver) { const ro = new ResizeObserver(place); ro.observe(views); ro.observe(vxy); }
    // they only show in Ortho (CSS); leaving Ortho ends a drag in progress
    new MutationObserver(() => {
      if (isOrtho()) place(); else drags.forEach((d) => d.cancel());
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    place();
  }

  function init() {
    const main = document.getElementById('viewport'), views = document.getElementById('views'), vxy = document.getElementById('vxy');
    if (main) SIDES.forEach((side) => makePanelHandle(side, main));
    applyPanels();
    if (views && vxy) makeOrthoSplitters(views, vxy);
    window.addEventListener('resize', applyPanels);
  }
  // for the app: show a hidden panel when something needs it (e.g. Ctrl+S opens the Export tab)
  window.AppLayout = { show(side) { if (state[side] && state[side].collapsed && toggles[side]) toggles[side](); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
