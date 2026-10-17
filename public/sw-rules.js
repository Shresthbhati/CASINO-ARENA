/*
 * CASINO ARENA - what the service worker may keep.
 *
 * The rule is deliberately narrow: only PUBLIC, STATIC, SAME-ORIGIN files (the app's own JavaScript, CSS,
 * icons and the page shell) are ever cached. Nothing else: not an API response, not an event stream, not
 * anything carrying a party token or other credentials, not another site's files. A live party table, a
 * player's hole cards and the shared state are therefore always fetched from the server and never served
 * from a cache that may be stale or readable by another page.
 *
 * It is a plain script (no modules) so the service worker can `importScripts` it and the unit tests can
 * `require` it: the same code runs in both places.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.casinoArenaSwRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {{ method: string, url: string, origin: string, mode?: string, hasCredentials?: boolean }} req
   * @returns {'never' | 'shell' | 'immutable' | 'static'}
   *   never     - not handled by the worker at all: the browser goes to the network, nothing is stored
   *   shell     - a page navigation: network first, the cached shell only when offline
   *   immutable - a content-hashed build asset: cache first
   *   static    - an icon, the manifest or the offline page: cache first
   */
  function classify(req) {
    if (req.method !== 'GET') return 'never';
    var url;
    try {
      url = new URL(req.url);
    } catch (e) {
      return 'never';
    }
    if (url.origin !== req.origin) return 'never';
    if (req.hasCredentials) return 'never';
    var path = url.pathname;
    if (path.indexOf('/api/') !== -1) return 'never';
    if (req.mode === 'navigate') return 'shell';
    if (/\/assets\/[^/]+\.(?:js|css|woff2?|png|svg|webp|jpe?g|gif)$/.test(path)) return 'immutable';
    if (/\/icons\/[^/]+\.(?:png|svg)$/.test(path) || /\/manifest\.webmanifest$/.test(path) || /\/offline\.html$/.test(path)) return 'static';
    return 'never';
  }

  /** Whether a response may be stored: a successful, same-origin, non-opaque answer that did not ask not to be. */
  function storable(res) {
    if (!res || !res.ok || res.type !== 'basic') return false;
    var cc = (res.headers && res.headers.get && res.headers.get('cache-control')) || '';
    return !/no-store|private/i.test(cc);
  }

  /** Cache names this app owns, so an update can remove old ones and nothing else. */
  var PREFIX = 'casino-arena-';

  return { classify: classify, storable: storable, PREFIX: PREFIX };
});
