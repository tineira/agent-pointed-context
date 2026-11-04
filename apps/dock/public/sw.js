// The dock's service worker (TIN-392): it makes the dock installable. The dock is live state (its
// hub), so nothing is cached; a dock page opened offline gets a short note instead of the browser's error.
//
// VERSION changes when open dock pages must not keep running the code they loaded (TIN-609): a page
// left open from before a deploy may send what the hub now refuses and ignore the answer. Any change to
// this file makes the browser install it on its next update check (every navigation in its scope, and a
// dock page asks on becoming visible). The new worker takes over at once (skipWaiting, clients.claim);
// the dock's own pages hear the change of controller and reload themselves (sw-reload.ts). The worker
// never navigates a client: a navigation's fetch waits for the worker to finish activating, so awaiting
// one in activate would hold every fetch of the origin, V1's at /v1 included.
const VERSION = "2026-11-04.tin-609";

/** V1 (apps/v1, the paper's demo) shares this host; this worker never answers its navigations. */
const isV1 = (url) => {
  const path = new URL(url).pathname;
  return path === "/v1" || path.startsWith("/v1/");
};

self.addEventListener("install", () => {
  void self.skipWaiting();
});
// Nothing here waits on a client.
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || isV1(event.request.url)) return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response("<!doctype html><meta charset=utf-8><title>Agent dock</title><p style=\"font:15px system-ui;padding:16px\">The agent dock needs a connection. It will come back when you are online.</p>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    ),
  );
});
