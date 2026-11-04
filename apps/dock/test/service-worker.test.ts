/**
 * The dock's service worker and the dock page's reload onto a new deploy (TIN-609). The worker takes over
 * at once (skipWaiting, clients.claim) and never touches a client: a navigation's fetch waits for the worker
 * to finish activating (the service worker spec's Handle Fetch), so a worker that awaited one in activate
 * would hold every fetch of the origin. The dock's own pages reload themselves on `controllerchange`, once;
 * the landing, /extension and V1 at /v1 never do. The worker runs in a vm with a model of the browser in
 * which fetches wait for activation, so a regression shows as a hang.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { keepDockCurrent, RELOAD_GUARD_MS } from "../src/web/sw-reload.ts";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://apc.example";

/**
 * The browser around the worker: every fetch (a client's navigation included) waits until activate's
 * waitUntil has settled, as Handle Fetch does while the active worker is "activating".
 */
function browser(pages: string[]) {
  let activated!: () => void;
  const activation = new Promise<void>((resolve) => (activated = resolve));
  const touched: string[] = [];
  const steps: string[] = [];
  const network = async (url: string) => {
    await activation;
    return new Response(`page ${url}`);
  };
  const clients = pages.map((url) => ({
    url,
    navigate: async (to: string) => {
      touched.push(`navigate ${to}`);
      return network(to);
    },
    postMessage: (message: unknown) => void touched.push(`message ${url} ${JSON.stringify(message)}`),
  }));
  const handlers = new Map<string, (event: unknown) => void>();
  const self = {
    registration: { active: { scriptURL: "/sw.js" } },
    skipWaiting: async () => void steps.push("skipWaiting"),
    clients: {
      claim: async () => void steps.push("claim"),
      matchAll: async () => {
        touched.push("matchAll");
        return clients;
      },
    },
    addEventListener: (type: string, handler: (event: unknown) => void) => void handlers.set(type, handler),
  };
  vm.runInNewContext(source, { self, fetch: (request: { url: string }) => network(request.url), Response, URL });
  return { handlers, touched, steps, activated, network };
}

test("activating the dock's service worker waits on no client, so no fetch of the origin is held (V1's included)", async () => {
  const b = browser([`${ORIGIN}/dock`, `${ORIGIN}/dock/agents/ag_1a2b`, `${ORIGIN}/`, `${ORIGIN}/extension`, `${ORIGIN}/v1/`]);
  b.handlers.get("install")!({ waitUntil: () => undefined });
  let activating: Promise<unknown> = Promise.resolve();
  b.handlers.get("activate")!({ waitUntil: (p: Promise<unknown>) => void (activating = p) });
  // V1 asks for a page while the worker activates: held until activation ends, as browsers do.
  const v1 = b.network(`${ORIGIN}/v1/`);
  const settled = await Promise.race([activating.then(() => "activated"), new Promise((resolve) => setTimeout(() => resolve("hung"), 1_000))]);
  assert.equal(settled, "activated", "activate settles without waiting for any fetch");
  b.activated();
  assert.match(await (await v1).text(), /page/, "the held fetch goes on once activated");
  assert.deepEqual(b.steps, ["skipWaiting", "claim"], "it takes over at once");
  assert.deepEqual(b.touched, [], "it never lists, navigates or messages a client");
});

test("the service worker carries a version, so a deploy that must reach open pages changes the file", () => {
  assert.match(source, /const VERSION = "[^"]+";/);
  assert.match(source, /2026-11-04\.tin-609/);
});

test("the service worker caches nothing and leaves V1 alone: only the dock's navigations are answered, offline with a note", async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  // Offline: the network refuses every request.
  const offline = async () => {
    throw new TypeError("offline");
  };
  vm.runInNewContext(source, { self: { addEventListener: (type: string, h: (e: unknown) => void) => void handlers.set(type, h) }, fetch: offline, Response, URL });
  const answered: Array<Promise<Response>> = [];
  const respondWith = (p: Promise<Response>) => void answered.push(p);
  handlers.get("fetch")!({ request: { mode: "cors", url: `${ORIGIN}/api/d/x/state` }, respondWith });
  handlers.get("fetch")!({ request: { mode: "navigate", url: `${ORIGIN}/v1/` }, respondWith });
  handlers.get("fetch")!({ request: { mode: "navigate", url: `${ORIGIN}/v1` }, respondWith });
  assert.equal(answered.length, 0, "a non-navigation, and any V1 page, is left to the network");
  handlers.get("fetch")!({ request: { mode: "navigate", url: `${ORIGIN}/dock` }, respondWith });
  assert.equal(answered.length, 1);
  assert.match(await (await answered[0]!).text(), /needs a connection/);
});

/** A page's view of `navigator.serviceWorker`, with a worker in control at load or not. */
function page(path: string, o: { controlled?: boolean; storage?: Map<string, string> | null; now?: { t: number } } = {}) {
  const listeners: Array<() => void> = [];
  const visible: Array<() => void> = [];
  let reloads = 0;
  let updates = 0;
  const now = o.now ?? { t: 1_000_000 };
  const storage = o.storage === null ? null : (o.storage ?? new Map<string, string>());
  keepDockCurrent({
    path,
    sw: {
      controller: o.controlled === false ? null : {},
      addEventListener: (_type, listener) => void listeners.push(listener),
      register: async () => ({ update: async () => void updates++ }),
    },
    onVisible: (listener) => void visible.push(listener),
    reload: () => void reloads++,
    storage: storage && { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
    now: () => now.t,
  });
  return {
    takeOver: () => listeners.forEach((l) => l()),
    show: () => visible.forEach((l) => l()),
    reloads: () => reloads,
    updates: () => updates,
    now,
    storage,
  };
}

test("a dock page reloads once when a new worker takes over; the landing, /extension and V1 never do", async () => {
  for (const path of ["/dock", "/dock/agents/ag_1a2b"]) {
    const p = page(path);
    p.takeOver();
    p.takeOver();
    assert.equal(p.reloads(), 1, path);
  }
  for (const path of ["/", "/extension", "/v1", "/v1/", "/v1/s/abc", "/dockyard"]) {
    const p = page(path);
    p.takeOver();
    assert.equal(p.reloads(), 0, `${path} never reloads`);
  }
});

test("a dock page with no worker at load (the first install) does not reload when the worker claims it", () => {
  const p = page("/dock", { controlled: false });
  p.takeOver();
  assert.equal(p.reloads(), 0);
});

test("no reload loop: a dock page reloaded moments ago does not reload again, whatever the worker does", () => {
  const storage = new Map<string, string>();
  const now = { t: 5_000_000 };
  const first = page("/dock", { storage, now });
  first.takeOver();
  assert.equal(first.reloads(), 1);
  // The reloaded page, a new worker again at once: no second reload within the guard.
  const second = page("/dock", { storage, now });
  second.takeOver();
  assert.equal(second.reloads(), 0);
  now.t += RELOAD_GUARD_MS;
  const later = page("/dock", { storage, now });
  later.takeOver();
  assert.equal(later.reloads(), 1, "a later deploy reloads it again");
  // Without storage, still once per page.
  const bare = page("/dock", { storage: null });
  bare.takeOver();
  bare.takeOver();
  assert.equal(bare.reloads(), 1);
});

test("every page asks for a new worker when it comes back into view", async () => {
  for (const path of ["/dock", "/"]) {
    const p = page(path);
    await new Promise((resolve) => setTimeout(resolve, 0));
    p.show();
    assert.equal(p.updates(), 1, path);
  }
});
