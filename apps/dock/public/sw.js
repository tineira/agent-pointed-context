// The dock's service worker (TIN-392): it makes the dock installable. The dock is live state (its
// hub), so nothing is cached; a page opened offline gets a short note instead of the browser's error.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response("<!doctype html><meta charset=utf-8><title>Agent dock</title><p style=\"font:15px system-ui;padding:16px\">The agent dock needs a connection. It will come back when you are online.</p>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    ),
  );
});
