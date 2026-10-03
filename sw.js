const CACHE_NAME = 'sri-karaoke-v19';
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
  // Deliberately NOT cache.addAll(APP_SHELL) — addAll() is all-or-nothing: if even one single URL in
  // the list fails (a transient network hiccup, a file temporarily missing right after a fresh
  // deploy, an overzealous ad-blocker, etc.), the WHOLE install event rejects and the service worker
  // never activates at all — breaking the PWA for every page on the site at once, since they all share
  // this one worker. Caching each file independently means one failure can't take down the rest.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(
      APP_SHELL.map((url) => cache.add(url).catch((err) => {
        console.warn('[SW] Failed to pre-cache (skipping, not fatal):', url, err);
      }))
    ))
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
