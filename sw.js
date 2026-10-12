// Service worker: la app funciona sin conexión (cache primero, se actualiza en segundo plano).
// Al cambiar cualquier fichero de la app, sube VERSION para que los móviles recojan la nueva versión.
const VERSION = 'v1.1.1';
const CACHE = 'agroservicios-' + VERSION;
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'seed.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('agroservicios-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const net = fetch(e.request)
        .then((r) => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return r;
        })
        .catch(() => null);
      return hit || net.then((r) => r || caches.match('index.html'));
    })
  );
});
