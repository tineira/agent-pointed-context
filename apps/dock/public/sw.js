// The dock's service worker (TIN-392): it makes the dock installable. The dock is live state (its
// hub), so nothing is cached; a page opened offline gets a short note instead of the browser's error.
//
// VERSION changes when open dock pages must not keep running the code they loaded (TIN-609): a page
// left open from before a deploy may send what the hub now refuses (a plain approve for an unverified
// app, before TIN-581) and ignore the answer. Any change to this file makes the browser install it on
// its next update check (every navigation in its scope, and the dock page asks on becoming visible);
// the new worker then takes over and reloads every dock page it replaced the old worker for. A first
// install reloads nothing.
const VERSION = "2026-11-04.tin-609";

/** Whether this worker replaces an older one: only then do the open pages reload. */
let replacing = false;

self.addEventListener("install", () => {
  replacing = !!self.registration.active;
  self.skipWaiting();
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      if (!replacing) return;
      for (const client of await self.clients.matchAll({ type: "window" })) {
        // Reload the page onto the code of this deploy; a page that cannot be navigated keeps running.
        if ("navigate" in client) await client.navigate(client.url).catch(() => undefined);
      }
    })(),
  ),
);
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response("<!doctype html><meta charset=utf-8><title>Agent dock</title><p style=\"font:15px system-ui;padding:16px\">The agent dock needs a connection. It will come back when you are online.</p>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    ),
  );
});
