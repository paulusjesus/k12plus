/* K12Plus service worker - offline-first PWA */
var VERSION = 'k12plus-v1';
var PRECACHE = [
  '/', '/index.html', '/about.html', '/pricing.html', '/contact.html',
  '/signup.html', '/app.html', '/support.js', '/k12plus-bridge.js',
  '/manifest.webmanifest', '/assets/k12plus-logo.png',
  '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(PRECACHE); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // never cache the AI proxy
  if (url.hostname.indexOf('run.app') !== -1) return;

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
    // network-first for pages, cache fallback for offline
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
