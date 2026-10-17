/*
 * CASINO ARENA - service worker.
 *
 * What it does: keeps the app's own static files so the casino floor and the single-player tables (whose
 * engines run in the page) open without a connection, and shows a clear offline page when nothing is
 * cached. What it never does: touch the network for the Party server. Party Mode, its event stream, tokens
 * and every other API call go straight to the server and are never stored (see sw-rules.js), so
 * multiplayer is never presented as working offline and no private card or session is ever cached.
 *
 * Updates are never forced mid-game: a new worker waits until the page asks it to take over.
 */
importScripts('./sw-rules.js');

var rules = self.casinoArenaSwRules;
// Bump when the worker itself changes behaviour; old caches are removed on activation.
var VERSION = 'v1';
var CACHE = rules.PREFIX + 'static-' + VERSION;
var SHELL = ['./', './offline.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL).then(function () {
        // Also keep the build's entry scripts and styles named by the page, so the very first visit
        // is already enough for the casino floor to open offline. (Table screens load on demand and
        // are stored the first time they are opened.)
        return cache
          .match('./')
          .then(function (page) { return page ? page.text() : ''; })
          .then(function (html) {
            var found = html.match(/(?:src|href)="(\.\/assets\/[^"]+)"/g) || [];
            var urls = found.map(function (m) { return m.replace(/^(?:src|href)="/, '').replace(/"$/, ''); });
            return Promise.all(urls.map(function (u) { return cache.add(u).catch(function () {}); }));
          });
      });
    }),
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.filter(function (k) { return k.indexOf(rules.PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function cacheFirst(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (res) {
        if (rules.storable(res)) cache.put(request, res.clone());
        return res;
      });
    });
  });
}

/** Pages: the network when there is one (so a deploy is seen at once), the stored shell when there is not. */
function networkFirstShell(request) {
  return fetch(request)
    .then(function (res) {
      if (rules.storable(res)) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put('./', copy); });
      }
      return res;
    })
    .catch(function () {
      return caches.open(CACHE).then(function (cache) {
        return cache.match('./').then(function (shell) {
          return shell || cache.match('./offline.html');
        });
      });
    });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var kind = rules.classify({
    method: request.method,
    url: request.url,
    origin: self.location.origin,
    mode: request.mode,
    // Not `request.credentials`: every page navigation is 'include' by definition. The app uses no cookies;
    // anything that carries an explicit credential header is handed back to the network untouched.
    hasCredentials: request.headers.has('authorization') || request.headers.has('x-party-token') || request.headers.has('x-party-session'),
  });
  if (kind === 'never') return; // not ours: the browser handles it, nothing is stored
  if (kind === 'shell') event.respondWith(networkFirstShell(request));
  else event.respondWith(cacheFirst(request));
});
