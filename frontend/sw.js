/* SportDB 最小 PWA 离线缓存骨架 */
const CACHE = 'sportdb-v2';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './chat.html', './chat.css', './chat.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
