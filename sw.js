// Offline support: serve the saved copy right away, refresh it in the background when online.
// Bump CACHE when you change the app so old files are cleared.
const CACHE = 'liftlog-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const fresh = fetch(req).then(async res => {
    if (res.ok) {
      const c = await caches.open(CACHE);
      await c.put(req, res.clone());
    }
    return res;
  }).catch(() => null);
  e.waitUntil(fresh);
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await caches.match('./index.html') : null);
    return hit || (await fresh) || new Response('Offline', { status: 503 });
  })());
});
