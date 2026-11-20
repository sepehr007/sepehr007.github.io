const CACHE = "wt-v113";
const SHELL = [
  "./",
  "./index.html",
  "./auth.html",
  "./profile.html",
  "./room.html",
  "./rooms.html",
  "./social.html",
  "./owner.html",
  "./offline.html",
  "./assets/css/design-system.css",
  "./assets/css/style.css",
  "./assets/css/landing-v8.css",
  "./assets/css/auth-v8.css",
  "./assets/css/profile-v8.css",
  "./assets/css/owner.css",
  "./assets/css/nebula.css",
  "./assets/img/nx-hero.webp",
  "./assets/img/nx-auth.webp",
  "./assets/img/nx-empty.webp",
  "./assets/img/ambient-night.webp",
  "./assets/img/ambient-night-vivid.webp",
  "./assets/fonts/vazirmatn-var.woff2",
  "./assets/js/fx.js",
  "./assets/js/theme-boot.js",
  "./assets/css/social.css",
  "./assets/css/rooms.css",
  "./assets/css/room-mgmt.css",
  "./assets/css/device-compat.css",
  "./assets/data/site-config.json",
  "./assets/data/help.json",
  "./assets/js/site-config.js",
  "./assets/js/feature-flags.js",
  "./assets/js/api.js",
  "./assets/js/core.js",
  "./assets/js/i18n.js",
  "./assets/js/db.js",
  "./assets/js/lobbies.js",
  "./assets/js/plans.js",
  "./assets/js/auth.js",
  "./assets/js/avatars.js",
  "./assets/js/landing.js",
  "./assets/js/profile.js",
  "./assets/js/room.js",
  "./assets/js/rooms.js",
  "./assets/js/room-mgmt.js",
  "./assets/js/livefeed.js",
  "./assets/js/net.js",
  "./assets/js/player.js",
  "./assets/js/voice.js",
  "./assets/js/transcode.js",
  "./assets/js/capabilities.js",
  "./assets/js/notifications.js",
  "./assets/js/social.js",
  "./assets/icon.svg",
  "./assets/img/icon-192.png",
  "./assets/img/icon-512.png",
  "./assets/img/icon-maskable-512.png",
  "./assets/img/apple-touch-icon.png",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: "reload" });
        if (res.ok) await cache.put(url, res);
      } catch {}
    }));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || "./";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const sameRoom = data.roomId
      ? windows.find((c) => {
          try { return new URL(c.url).searchParams.get("room") === data.roomId; } catch { return false; }
        })
      : null;
    const anyRoom = windows.find((c) => {
      try { return new URL(c.url).pathname.endsWith("/room.html") || new URL(c.url).pathname.endsWith("room.html"); } catch { return false; }
    });
    const client = sameRoom || anyRoom;
    if (client) {
      try { await client.focus(); } catch {}
      if (!sameRoom && "navigate" in client) {
        try { await client.navigate(target); } catch {}
      }
      return;
    }
    try { await self.clients.openWindow(target); } catch {}
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (/\/assets\/data\/(?:site-config|runtime-config)\.json$/.test(url.pathname)) {
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: "no-cache" });
        /* URLs carrying query strings (room codes, reset tokens) are never
           written to the cache — a shared device must not leak them. */
        if (res.ok && !url.search) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch {
        if (!url.search) {
          const cached = await caches.match(req);
          if (cached) return cached;
        }
        const shell = await caches.match(url.pathname.replace(/^\//, "./"));
        if (shell && !url.search) return shell;
        const offline = await caches.match("./offline.html");
        if (offline) return offline;
        return new Response(
          "<!doctype html><meta charset=utf-8><title>Offline</title><p style=\"font-family:system-ui;padding:32px\">You are offline.</p>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    })());
    return;
  }

  if (
    req.destination === "script" || req.destination === "style" ||
    /\.(?:js|css)$/i.test(url.pathname)
  ) {
    event.respondWith(
      fetch(req, { cache: "no-cache" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
