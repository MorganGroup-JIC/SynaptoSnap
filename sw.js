/* SynaptoSnap — service worker. When the app is served over https (GitHub Pages), this lets it start without a
   network connection once it has been opened online, and lets the browser install it as an app.
   Network first: online, every start gets the current version from the server; the cache is only the fallback.
   Microscopy files are opened from disk by the page and never pass through here.
   When a file is added to the page, add it to FILES too (files fetched later are cached as they are used). */
importScripts('js/version.js');
const CACHE = 'synaptosnap-' + APP_VERSION;
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg',
  'js/version.js', 'js/layout.js', 'js/vendor/fzstd.js', 'js/czi.js', 'js/processing.js', 'js/tracing.js',
  'js/colormaps.js', 'js/renderer.js', 'js/slices.js', 'js/ops.js', 'js/ui.js', 'js/app.js', 'js/exporter.js',
  'js/demo.js', 'js/demo-dense.js', 'js/tracepath.js', 'js/tracer-ui.js', 'js/traces-io.js',
  'icons/icon-16.png', 'icons/icon-24.png', 'icons/icon-30.png', 'icons/icon-32.png', 'icons/icon-36.png',
  'icons/icon-48.png', 'icons/icon-64.png', 'icons/icon-192.png', 'icons/icon-256.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('synaptosnap-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req)
    .then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })
    .catch(() => caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
