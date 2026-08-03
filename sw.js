/* LOCKED service worker — conservative network-first strategy.
   The app head registers /sw.js and, on every load, compares the deploy
   version from the Worker; on a new deploy it clears all caches before hard
   reloading. (It must NOT unregister this worker: a push subscription belongs
   to its service worker registration and dies with it, which silently switched
   notifications off on every deploy.) So this cache can never pin users to a
   stale build — it only serves as an offline fallback.

   Strategy:
   • HTML/navigation: network first, cache fallback (offline support).
   • Same-origin static + pinned CDN libs: network first, cache fallback.
   • Everything else (worker API, Supabase, Groq): network only, never cached. */

var CACHE = "locked-v1";

var CACHEABLE_HOSTS = [
  self.location.host,
  "unpkg.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com"
];

self.addEventListener("install", function (e) {
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (CACHEABLE_HOSTS.indexOf(url.host) === -1) return; /* API traffic: untouched */
  /* vercel.json rewrites /api/* to the Worker, so a same-origin /api request
     is API traffic wearing this origin's hostname. It is only safe today
     because the build calls the Worker directly; the moment anything uses the
     rewrite, responses would be cached. Exclude it now, while it is free. */
  if (url.host === self.location.host && /^\/api(\/|$)/.test(url.pathname)) return;

  e.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          /* offline navigation with no cache → fall back to cached shell */
          if (req.mode === "navigate") return caches.match("/");
          return Response.error();
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
