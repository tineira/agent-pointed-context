/**
 * A dock page left open reloads onto a new deploy's code (TIN-609): when a new service worker takes over
 * (public/sw.js: skipWaiting and clients.claim, no navigation from the worker), the dock's own pages hear
 * `controllerchange` and reload themselves, once. Only pages under /dock: the landing, /extension and V1 at
 * /v1 share the origin and the worker's scope, and never reload. A page that had no worker when it loaded
 * (the first install) does not reload either: the worker taking it over changes nothing it runs. An open
 * page also asks for a new worker whenever it comes back into view.
 */

/** What this needs of `navigator.serviceWorker` and the page, so a test can stand in for them. */
export interface SwReloadHost {
  path: string;
  sw: {
    controller: unknown;
    addEventListener(type: "controllerchange", listener: () => void): void;
    register(url: string): Promise<{ update(): Promise<unknown> }>;
  };
  onVisible(listener: () => void): void;
  reload(): void;
  /** sessionStorage, or nothing: a reload within `RELOAD_GUARD_MS` of the last one is skipped. */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  now?: () => number;
}

/** No second reload within this long of one, whatever happens: a worker that kept changing could not loop the page. */
export const RELOAD_GUARD_MS = 30_000;
const KEY = "apc-dock-sw-reload";

export const isDockPath = (path: string) => path === "/dock" || path.startsWith("/dock/");

export function keepDockCurrent(host: SwReloadHost): void {
  const now = host.now ?? Date.now;
  const registered = host.sw.register("/sw.js");
  registered
    .then((registration) => host.onVisible(() => void registration.update().catch(() => undefined)))
    .catch(() => undefined);
  if (!isDockPath(host.path) || !host.sw.controller) return;
  let reloaded = false;
  host.sw.addEventListener("controllerchange", () => {
    if (reloaded) return;
    try {
      const last = Number(host.storage?.getItem(KEY) ?? 0);
      if (now() - last < RELOAD_GUARD_MS) return;
      host.storage?.setItem(KEY, String(now()));
    } catch {
      // no storage: the flag above still allows one reload per page
    }
    reloaded = true;
    host.reload();
  });
}
