/**
 * The dock's service worker (TIN-609): a new version takes over at once and reloads every dock page the old
 * worker served, so a page left open from before a deploy (one that sends a plain approve for an unverified
 * app and ignores the hub's warning_required) runs this deploy's code. A first install reloads nothing. The
 * worker runs here in a vm with stand-ins for the browser's.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

/** The worker, installed and activated: over an older one (`replacing`) or as the first. */
async function run(o: { replacing: boolean; pages: string[] }) {
  const handlers = new Map<string, (event: unknown) => void>();
  const navigated: string[] = [];
  const steps: string[] = [];
  const clients = o.pages.map((url) => ({ url, navigate: async (to: string) => void navigated.push(to) }));
  const self = {
    registration: { active: o.replacing ? { scriptURL: "/sw.js" } : null },
    skipWaiting: () => void steps.push("skipWaiting"),
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
  vm.runInNewContext(source, { self, fetch: offline, Response });
  handlers.get("install")!({});
  let done: Promise<unknown> = Promise.resolve();
  handlers.get("activate")!({ waitUntil: (p: Promise<unknown>) => void (done = p) });
  await done;
  return { navigated, steps, handlers };
}

test("a new version of the dock's service worker reloads every dock page the old one served", async () => {
  const { navigated, steps } = await run({ replacing: true, pages: ["https://apc.example/dock", "https://apc.example/dock?agent=ag_1"] });
  assert.deepEqual(steps, ["skipWaiting", "claim"], "it takes over at once");
  assert.deepEqual(navigated, ["https://apc.example/dock", "https://apc.example/dock?agent=ag_1"], "each page reloads where it was");
});

test("the first install of the dock's service worker reloads nothing", async () => {
  const { navigated } = await run({ replacing: false, pages: ["https://apc.example/dock"] });
  assert.deepEqual(navigated, []);
});

test("the service worker carries a version, so a deploy that must reach open pages changes the file", () => {
  assert.match(source, /const VERSION = "[^"]+";/);
  assert.match(source, /2026-11-04\.tin-609/);
});

test("the service worker still caches nothing: only navigations are answered, offline with a note", async () => {
  const { handlers } = await run({ replacing: false, pages: [] });
  const answered: Array<Promise<Response>> = [];
  handlers.get("fetch")!({ request: { mode: "cors" }, respondWith: () => assert.fail("a non-navigation is left to the network") });
  handlers.get("fetch")!({ request: { mode: "navigate", url: "https://apc.example/dock" }, respondWith: (p: Promise<Response>) => void answered.push(p) });
  assert.equal(answered.length, 1);
  assert.match(await (await answered[0]!).text(), /needs a connection/);
});
