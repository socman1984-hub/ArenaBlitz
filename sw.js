// Offline cache so the game works without a connection once installed.
const CACHE = 'arena-blitz-v9';
const FILES = ['./', 'index.html', 'game.js', 'manifest.json', 'icon.svg', 'version.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Network first (so updates show up), fall back to cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    // 'no-cache' asks the server whether files changed, so updates show up right away.
    fetch(e.request.url, { cache: 'no-cache' }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
