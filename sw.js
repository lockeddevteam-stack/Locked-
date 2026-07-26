/* LOCKED service worker
 *
 * Strategy:
 *  - App shell (navigations / index.html): network-first, cache fallback.
 *    The app has its own deploy-version check that clears caches and
 *    reloads when a new build ships, so the cache never goes stale for long.
 *  - Static assets (icons, manifest): cache-first.
 *  - /api/* (Cloudflare Worker proxy) and any cross-origin request:
 *    never intercepted — always straight to the network.
 *
 * It also handles push: rest-timer alerts and the daily training / check-in
 * reminders arrive here from the Worker and are shown even when the app is
 * closed. See worker/push.js for the sending side.
 */
var CACHE = "locked-shell-v2";
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

/* ------------------------------------------------------------------ *
 * Push notifications
 * ------------------------------------------------------------------ */

/* iOS revokes a subscription that receives a push without showing a
   notification, so every push must end in showNotification — including one
   with an unreadable payload. */
self.addEventListener("push", function (e) {
  var data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = { title: "LOCKED", body: e.data ? e.data.text() : "" };
  }

  var title = data.title || "LOCKED";
  var isRest = data.type === "rest";

  var options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "locked",
    renotify: !!data.renotify,
    /* A finished rest timer is the one alert that should cut through: it is
       useless a minute late, and the phone is usually face-down on a bench. */
    requireInteraction: isRest,
    vibrate: isRest ? [200, 100, 200, 100, 200] : [120],
    timestamp: Date.now(),
    data: { url: data.url || "/", type: data.type || "generic" }
  };

  if (data.type === "checkin") {
    options.actions = [{ action: "checkin", title: "Check in" }];
  } else if (data.type === "training") {
    options.actions = [{ action: "start", title: "Start workout" }];
  } else if (data.type === "idle") {
    /* Answer the "still training?" question straight from the lock screen. */
    options.actions = [
      { action: "continue", title: "Keep going" },
      { action: "end", title: "End workout" }
    ];
    options.requireInteraction = true;
  }

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();

  var data = e.notification.data || {};
  var target = data.url || "/";
  if (e.action === "checkin") target = "/?open=checkin";
  else if (e.action === "start") target = "/?open=workout";
  else if (e.action === "end") target = "/?open=endworkout";
  else if (e.action === "continue") target = "/?open=workout";

  /* "Keep going" is an answer, not a request to open the app — tell any open
     window and leave the phone alone. */
  var quiet = e.action === "continue";

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      if (quiet) {
        list.forEach(function (c) {
          c.postMessage({ source: "locked-push", type: "idle-continue", url: target });
        });
        return;
      }
      /* Reuse an open app window rather than stacking duplicates — the page
         listens for this message and routes itself. */
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if (new URL(client.url).origin === self.location.origin) {
          client.postMessage({ source: "locked-push", type: data.type, url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

/* A push subscription can be rotated by the browser; tell the app so it can
   re-register with the Worker next time it runs. */
self.addEventListener("pushsubscriptionchange", function (e) {
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      list.forEach(function (client) {
        client.postMessage({ source: "locked-push", type: "resubscribe" });
      });
    })
  );
});
