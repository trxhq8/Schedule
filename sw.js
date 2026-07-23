/* Service worker for "My Planner".
   Strategy: NETWORK-FIRST for everything.
   This is the important part for Abdullah's use case — when he pushes a new
   version to GitHub and a friend opens/refreshes the app, the browser tries
   the network FIRST and always gets the newest file if there's a connection.
   The cache is only a fallback for when there's no internet at all, so it
   never causes a stale/old version to be shown while online.

   BUMP APP_VERSION every time you deploy a real update — it changes the cache
   name, which makes the old cache get deleted automatically on activate. */
const APP_VERSION = 'v1.0.0';
const CACHE_NAME = `my-planner-${APP_VERSION}`;
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activate the new SW immediately, don't wait for old tabs to close
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(()=>{})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // delete any caches from older versions
      caches.keys().then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      ),
      self.clients.claim() // take control of any already-open tabs immediately
    ])
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // got a fresh copy from the network: use it, and update the cache for offline fallback
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(()=>{});
        return networkResponse;
      })
      .catch(() =>
        // no internet: fall back to whatever we have cached
        caches.match(event.request).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
