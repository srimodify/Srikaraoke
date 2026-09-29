const CACHE_NAME = 'sri-karaoke-v7';
const APP_SHELL = [
  './index.html',
  './remote.html',
  './screen2.html',
  './app.js',
  './remote.js',
  './screen2.js',
  './manifest.json',
  './manifest-remote.json',
  './manifest-screen2.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/please-select-song.mp3',
  './sound-effects/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle same-origin GET requests; let cross-origin (YouTube, PeerJS, APIs) pass through.
  if(req.method !== 'GET' || new URL(req.url).origin !== self.location.origin){
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if(cached){
      // Serve the cached copy immediately, and refresh the cache in the background for next time —
      // cloned right away, before anything else can touch the body, to avoid "body already used".
      fetch(req).then((res) => {
        if(res && res.ok){
          const freshCopy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, freshCopy)).catch(() => {});
        }
      }).catch(() => {});
      return cached;
    }
    try{
      const res = await fetch(req);
      if(res && res.ok){
        const freshCopy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, freshCopy)).catch(() => {});
      }
      return res;
    }catch(e){
      return cached || Response.error();
    }
  })());
});
