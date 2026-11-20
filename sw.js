// Офлайн-режим: всё приложение лежит в кэше телефона. Новая версия с GitHub подтягивается в фоне
// и включается при следующем запуске. При обновлении файлов меняй номер версии ниже.
const CACHE = 'billiard-v11';
const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'fonts/onest-cyrillic-400-normal.woff2',
  'fonts/onest-cyrillic-500-normal.woff2',
  'fonts/onest-cyrillic-600-normal.woff2',
  'fonts/onest-cyrillic-700-normal.woff2',
  'fonts/onest-latin-400-normal.woff2',
  'fonts/onest-latin-500-normal.woff2',
  'fonts/onest-latin-600-normal.woff2',
  'fonts/onest-latin-700-normal.woff2',
  'fonts/unbounded-cyrillic-600-normal.woff2',
  'fonts/unbounded-cyrillic-700-normal.woff2',
  'fonts/unbounded-latin-600-normal.woff2',
  'fonts/unbounded-latin-700-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // запросы к GitHub API идут мимо кэша

  if (req.mode === 'navigate') {
    e.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match('index.html');
      const fresh = fetch(url.origin + url.pathname.replace(/[^/]*$/, '') + 'index.html', { cache: 'no-cache' })
        .then(r => { if (r.ok) cache.put('index.html', r.clone()); return r; })
        .catch(() => null);
      if (cached) { e.waitUntil(fresh); return cached; }
      return (await fresh) || new Response('Нет сети', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }));
    return;
  }

  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return r;
  })));
});
