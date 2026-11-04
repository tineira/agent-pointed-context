/**
 * The dock's service worker (TIN-609): a new version takes over at once and reloads the dock's own pages
 * the old worker served, so a dock page left open from before a deploy (one that sends a plain approve for
 * an unverified app and ignores the hub's warning_required) runs this deploy's code. It never reloads
 * another page of the origin (the landing, /extension, V1 at /v1), and a first install reloads nothing.
 * The worker runs here in vm contexts, with stand-ins for the browser's.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://apc.example";

/** Cache Storage as the browser keeps it across worker restarts: one store per test. */
function cacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  return {
    stores,
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return { put: async (key: string, value: Response) => void store.set(key, value), match: async (key: string) => store.get(key) };
    },
    delete: async (name: string) => stores.delete(name),
  };
}

/** One start of the worker: a fresh global scope, as the browser gives after stopping it. */
function start(o: { replacing: boolean; pages: string[]; caches: ReturnType<typeof cacheStorage> }) {
  const handlers = new Map<string, (event: unknown) => void>();
  const navigated: string[] = [];
  const steps: string[] = [];
  const clients = o.pages.map((url) => ({ url, navigate: async (to: string) => void navigated.push(to) }));
  const self = {
    registration: { active: o.replacing ? { scriptURL: "/sw.js" } : null },
    skipWaiting: async () => void steps.push("skipWaiting"),
    clients: {
      claim: async () => void steps.push("claim"),
      matchAll: async (q: { type?: string }) => (q.type === "window" ? clients : []),
    },
    addEventListener: (type: string, handler: (event: unknown) => void) => void handlers.set(type, handler),
  };
  // Offline: the network refuses every request.
  const offline = async () => {
    throw new TypeError("offline");
  };
  vm.runInNewContext(source, { self, caches: o.caches, fetch: offline, Response, URL });
  const fire = async (type: string) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
  };
  return { navigated, steps, handlers, fire };
}

const PAGES = [`${ORIGIN}/dock`, `${ORIGIN}/dock/agents/ag_1a2b`, `${ORIGIN}/`, `${ORIGIN}/extension`, `${ORIGIN}/v1/`, `${ORIGIN}/v1/s/abc`, `${ORIGIN}/v1`];

test("a new version of the dock's service worker reloads the dock's own pages, and never V1, the landing or /extension", async () => {
  const caches = cacheStorage();
  const worker = start({ replacing: true, pages: PAGES, caches });
  await worker.fire("install");
  await worker.fire("activate");
  assert.deepEqual(worker.steps, ["skipWaiting", "claim"], "it takes over at once");
  assert.deepEqual(worker.navigated, [`${ORIGIN}/dock`, `${ORIGIN}/dock/agents/ag_1a2b`], "each dock page reloads where it was");
  assert.equal(worker.navigated.some((u) => new URL(u).pathname.startsWith("/v1")), false, "a /v1 page is never navigated");
  assert.equal(caches.stores.size, 0, "the flag is gone once used");
});

test("the reload survives the browser restarting the worker between install and activate", async () => {
  const caches = cacheStorage();
  await start({ replacing: true, pages: PAGES, caches }).fire("install");
  // A fresh start for activate: nothing of the first one's variables is left, only Cache Storage.
  const fresh = start({ replacing: false, pages: PAGES, caches });
  await fresh.fire("activate");
  assert.deepEqual(fresh.navigated, [`${ORIGIN}/dock`, `${ORIGIN}/dock/agents/ag_1a2b`]);
});

test("the first install of the dock's service worker reloads nothing", async () => {
  const caches = cacheStorage();
  const worker = start({ replacing: false, pages: PAGES, caches });
  await worker.fire("install");
  await worker.fire("activate");
  assert.deepEqual(worker.navigated, []);
});

test("the service worker carries a version, so a deploy that must reach open pages changes the file", () => {
  assert.match(source, /const VERSION = "[^"]+";/);
  assert.match(source, /2026-11-04\.tin-609/);
});

test("the service worker caches nothing of the dock and leaves V1 alone: only the dock's navigations are answered, offline with a note", async () => {
  const { handlers } = start({ replacing: false, pages: [], caches: cacheStorage() });
  const answered: Array<Promise<Response>> = [];
  const respondWith = (p: Promise<Response>) => void answered.push(p);
  handlers.get("fetch")!({ request: { mode: "cors", url: `${ORIGIN}/api/d/x/state` }, respondWith });
  handlers.get("fetch")!({ request: { mode: "navigate", url: `${ORIGIN}/v1/` }, respondWith });
  assert.equal(answered.length, 0, "a non-navigation, and any V1 page, is left to the network");
  handlers.get("fetch")!({ request: { mode: "navigate", url: `${ORIGIN}/dock` }, respondWith });
  assert.equal(answered.length, 1);
  assert.match(await (await answered[0]!).text(), /needs a connection/);
});
