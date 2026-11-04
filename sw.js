const CACHE_NAME = "chatter-app-shell-v3";
const APP_SHELL = ["/app", "/manifest.webmanifest", "/chatter-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith("chatter-app-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.headers.get("accept")?.includes("text/event-stream")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && ["/app", "/app/"].includes(url.pathname)) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/app", response.clone());
        }
        return response;
      } catch {
        const appPath = ["/app", "/app/", "/app.html"].includes(url.pathname);
        return appPath && await caches.match("/app") || new Response("Chatter needs an internet connection to load your account.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    })());
    return;
  }

  if (!["/app", "/app.html", "/manifest.webmanifest", "/chatter-icon.svg", "/favicon.svg"].includes(url.pathname)) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && ["basic", "cors"].includes(response.type)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
