const CACHE = "wt-v68";
const SHELL = [
  "./",
  "./index.html",
  "./auth.html",
  "./profile.html",
  "./room.html",
  "./owner.html",
  "./assets/css/style.css",
  "./assets/css/owner.css",
  "./assets/data/site-config.json",
  "./assets/js/site-config.js",
  "./assets/js/feature-flags.js",
  "./assets/js/api.js",
  "./assets/js/modlog.js",
  "./assets/js/owner.js",
  "./assets/js/owner-registry.js",
  "./assets/js/owner-audit.js",
  "./assets/js/owner-center.js",
  "./assets/js/entitlements.js",
  "./assets/js/billing-model.js",
  "./assets/js/payment-providers.js",
  "./assets/js/charts.js",
  "./assets/js/pricing.js",
  "./assets/js/core.js",
  "./assets/js/i18n.js",
  "./assets/js/auth.js",
  "./assets/js/avatars.js",
  "./assets/js/landing.js",
  "./assets/js/profile.js",
  "./assets/js/room.js",
  "./assets/js/net.js",
  "./assets/js/player.js",
  "./assets/js/hls.min.js",
  "./assets/js/voice.js",
  "./assets/js/transcode.js",
  "./assets/avatars/girl-1.webp",
  "./assets/avatars/girl-2.webp",
  "./assets/avatars/girl-3.webp",
  "./assets/avatars/girl-4.webp",
  "./assets/avatars/girl-5.webp",
  "./assets/avatars/girl-6.webp",
  "./assets/avatars/boy-1.webp",
  "./assets/avatars/boy-2.webp",
  "./assets/avatars/boy-3.webp",
  "./assets/avatars/boy-4.webp",
  "./assets/avatars/boy-5.webp",
  "./assets/avatars/boy-6.webp",
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
    await self.skipWaiting();
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
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
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
