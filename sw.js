/* Service worker for "My Planner".
   Strategy: NETWORK-FIRST for everything.
   This is the important part for Abdullah's use case — when he pushes a new
   version to GitHub and a friend opens/refreshes the app, the browser tries
   the network FIRST and always gets the newest file if there's a connection.
   The cache is only a fallback for when there's no internet at all, so it
   never causes a stale/old version to be shown while online.

   BUMP APP_VERSION every time you deploy a real update — it changes the cache
   name, which makes the old cache get deleted automatically on activate. */
const APP_VERSION = 'v1.60.0';
const CACHE_NAME = `my-planner-${APP_VERSION}`;
const STATIC_CACHE = 'my-planner-static-v1'; // libraries/fonts with versioned URLs — kept across deploys
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];
const LIBS = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js'
];
const STATIC_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activate the new SW immediately, don't wait for old tabs to close
  event.waitUntil(Promise.all([
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(()=>{}),
    // the app can't start offline without these, so keep them from the first visit on
    caches.open(STATIC_CACHE).then((cache) => Promise.all(LIBS.map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(()=>{}))))).catch(()=>{})
  ]));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // delete caches from older app versions (the library cache stays)
      caches.keys().then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME && n !== STATIC_CACHE).map((n) => caches.delete(n)))
      ),
      self.clients.claim() // take control of any already-open tabs immediately
    ])
  );
});

/* App files: network first, but never wait more than 3s — a weak connection
   used to keep the splash up until the request finally failed. Libraries and
   fonts: cache first (their URLs are versioned). Everything else (Firestore,
   sign-in, AI, weather) is left alone: Firebase keeps its own offline copy and
   uploads queued changes by itself when the connection is back. */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch (e) { return; }
  // versioned data files (?v=hash) never change under the same URL: cache first
  if (url.origin === self.location.origin && url.searchParams.has('v')) { event.respondWith(cacheFirst(req)); return; }
  if (url.origin === self.location.origin) { event.respondWith(networkFirst(req, 3000)); return; }
  if (STATIC_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(req)); return; }
});
async function networkFirst(req, ms) {
  const cache = await caches.open(CACHE_NAME);
  const net = fetch(req).then((r) => { if (r && r.ok) cache.put(req, r.clone()).catch(()=>{}); return r; });
  const cached = (await cache.match(req, { ignoreSearch: req.mode === 'navigate' })) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
  if (!cached) return net.catch(() => caches.match('./index.html'));
  return Promise.race([net, new Promise((res) => setTimeout(() => res(cached), ms))]).catch(() => cached);
}
async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone()).catch(()=>{});
  return r;
}

/* ---- Reminders (Firebase Cloud Messaging, data-only web push) ----
   The sender (GitHub Action in .github/workflows/reminders.yml) sends
   {title, body, url, tag}; we always show a notification for every push
   (iOS revokes the subscription if a push shows nothing). */
self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) { msg = { data: { body: event.data && event.data.text() } }; }
  const d = msg.data || {};
  const n = msg.notification || {};
  const title = d.title || n.title || 'My Planner';
  const options = {
    body: d.body || n.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.navigate && c.navigate(url).catch(()=>{}); return c.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});
