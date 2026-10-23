/* K12Plus service worker - offline-first PWA */
var VERSION = 'k12plus-v22';
// Lessons a learner downloads ("Download for offline") live in their own store,
// which app updates never clear.
var LESSONS = 'k12plus-lessons';
// Saved on the phone at install, so the app opens without a signal. The script
// addresses match the pages exactly (with their ?v= numbers); otherwise each file
// would be downloaded twice. Keep them in step with app.html and index.html (the
// item 13 test checks this). The About, Pricing and Contact pages are not saved in
// advance: learners rarely need them offline, and they are cached once visited.
var PRECACHE = [
  '/index.html', '/signup.html', '/app.html',
  '/support.js?v=2', '/k12plus-bridge.js?v=19',
  '/k12plus-syllabus.js?v=2', '/k12plus-arcade.js?v=1', '/k12plus-scenes.js?v=1',
  '/manifest.webmanifest', '/assets/k12plus-logo-128.png',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/favicon.ico', '/icons/favicon-32.png', '/lessons/index.json',
];
// React, saved too so the app can open offline after the first visit. Usually this
// costs nothing: the browser already holds these files from the page that just loaded.
var CDN_PRECACHE = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
];

// ---- data used (2027 pilot) ----
// Files this worker downloads (installing, updating, pages and scripts) are invisible
// to the page, so the worker counts them itself from the browser's own figures (bytes
// actually received, 0 when the file came from the phone's cache) and hands the total
// to the page when asked. Calls to the K12Plus server are counted by the page.
var netBytes = 0;
try {
  new PerformanceObserver(function (list) {
    list.getEntries().forEach(function (e) {
      if (String(e.name).indexOf('supabase.co') === -1) netBytes += e.transferSize || 0;
    });
  }).observe({ type: 'resource', buffered: true });
} catch (e) {}
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'k12-data-used' && e.ports && e.ports[0]) {
    var n = netBytes; netBytes = 0;
    e.ports[0].postMessage({ bytes: n });
  }
});

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      return c.addAll(PRECACHE).then(function () {
        return Promise.all(CDN_PRECACHE.map(function (u) {
          return fetch(u, { mode: 'cors' }).then(function (res) { if (res.ok) return c.put(u, res); }).catch(function () {});
        }));
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== LESSONS; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // never cache the AI proxy or Supabase API calls
  if (url.hostname.indexOf('run.app') !== -1 || url.hostname.indexOf('supabase.co') !== -1) return;

  // The browser reads the page before the app fills it in, and asks for an image at
  // the placeholder address "{{ ... }}". Answer here instead of using data for it.
  if (url.origin === location.origin && url.pathname.indexOf('%7B%7B') !== -1) {
    e.respondWith(new Response(null, { status: 204 }));
    return;
  }

  // CDN scripts (React, Babel) and Google Fonts: cache-first, they are versioned
  var isCdn = url.hostname.indexOf('unpkg.com') !== -1 ||
              url.hostname.indexOf('fonts.googleapis.com') !== -1 ||
              url.hostname.indexOf('fonts.gstatic.com') !== -1;

  if (isCdn) {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        if (hit) return hit;
        return fetch(e.request).then(function (res) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
          return res;
        });
      })
    );
    return;
  }

  if (url.origin === location.origin) {
    // network-first for pages, cache fallback for offline. Unchanged files cost only a
    // short "has this changed?" exchange, because the host sends ETags.
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () {
        return caches.match(e.request).then(function (hit) {
          return hit || caches.match('/index.html');
        });
      })
    );
  }
});
