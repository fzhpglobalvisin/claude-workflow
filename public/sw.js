// Service worker: caches the app shell so the PWA opens offline. API data is cached by the
// app itself (localStorage) and mutations are queued in an outbox that syncs on reconnect.
const CACHE = 'wfh-shell-v1';
const SHELL = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // navigations: network first, fall back to cached shell
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); return r; })
      .catch(() => caches.match('/index.html')));
    return;
  }
  // static assets: cache first, then network (and remember)
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok && (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.svg'))) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  })));
});
