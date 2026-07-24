/* LOCKED service worker
 *
 * Strategy:
 *  - App shell (navigations / index.html): network-first, cache fallback.
 *    The app has its own deploy-version check that clears caches and
 *    reloads when a new build ships, so the cache never goes stale for long.
 *  - Static assets (icons, manifest): cache-first.
 *  - /api/* (Cloudflare Worker proxy) and any cross-origin request:
 *    never intercepted — always straight to the network.
 */
var CACHE = "locked-shell-v1";
var PRECACHE = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(PRECACHE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  // Never touch API calls or cross-origin requests (Supabase, fonts, CDN).
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.indexOf("/api/") === 0) return;

  // Navigations + app shell: network-first so new deploys land immediately.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put("/", copy); });
        return res;
      }).catch(function () {
        return caches.match("/");
      })
    );
    return;
  }

  // Everything else same-origin (icons, manifest): cache-first.
  e.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      });
    })
  );
});
