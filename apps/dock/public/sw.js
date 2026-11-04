// The dock's service worker (TIN-392): it makes the dock installable. The dock is live state (its
// hub), so nothing is cached; a dock page opened offline gets a short note instead of the browser's error.
//
// VERSION changes when open dock pages must not keep running the code they loaded (TIN-609): a page
// left open from before a deploy may send what the hub now refuses (a plain approve for an unverified
// app, before TIN-581) and ignore the answer. Any change to this file makes the browser install it on
// its next update check (every navigation in its scope, and the dock page asks on becoming visible);
// the new worker then takes over and reloads the dock's own pages (/dock and /dock/…) that the old
// worker served. Never another page of this origin: not the landing, not /extension, and never V1 at
// /v1, which is another Worker on the same host. A first install reloads nothing.
const VERSION = "2026-11-04.tin-609";

/**
 * Whether this worker replaces an older one is learned at install (the old one is still active then)
 * and kept in Cache Storage, not in a variable: the browser may stop the worker between install and
 * activate, and start a fresh one for activate. The entry holds no page or response of the dock.
 */
const FLAG_CACHE = "apc-dock-sw-flags";
const REPLACING = "/__apc-dock-sw/replacing";

/** The dock's own pages: the list at /dock, an agent's page at /dock/agents/<id>. */
const isDockPage = (url) => {
  const path = new URL(url).pathname;
  return path === "/dock" || path.startsWith("/dock/");
};
/** V1 (apps/v1, the paper's demo) shares this host; this worker never answers or reloads it. */
const isV1 = (url) => {
  const path = new URL(url).pathname;
  return path === "/v1" || path.startsWith("/v1/");
};

self.addEventListener("install", (event) =>
  event.waitUntil(
    (async () => {
      if (self.registration.active) await (await caches.open(FLAG_CACHE)).put(REPLACING, new Response(VERSION));
      await self.skipWaiting();
    })(),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const replacing = !!(await (await caches.open(FLAG_CACHE)).match(REPLACING));
      await caches.delete(FLAG_CACHE);
      if (!replacing) return;
      for (const client of await self.clients.matchAll({ type: "window" })) {
        // Reload a dock page onto the code of this deploy; a page that cannot be navigated keeps running.
        if (isDockPage(client.url) && "navigate" in client) await client.navigate(client.url).catch(() => undefined);
      }
    })(),
  ),
);
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || isV1(event.request.url)) return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response("<!doctype html><meta charset=utf-8><title>Agent dock</title><p style=\"font:15px system-ui;padding:16px\">The agent dock needs a connection. It will come back when you are online.</p>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    ),
  );
});
