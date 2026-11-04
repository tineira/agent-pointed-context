/**
 * Concurrent first entries open one sandbox (TIN-490): the page's openSession against the real Worker,
 * with the sandboxes stood in for and a cookie jar playing the browser. Two tabs are two instances of
 * the page's module, ordered by the Web Locks API Node shares with browsers.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import type { Hono } from "hono";
import * as tabA from "../src/web/session.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject { constructor() { throw new Error('Unexpected Durable Object'); } }", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const app: Hono = await import(new URL("../src/worker/index.ts", import.meta.url).href).then((m) => m.default).finally(() => hooks.deregister());
const tabB: typeof tabA = await import(new URL("../src/web/session.ts?tab=b", import.meta.url).href);

const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Sandboxes, stood in for: opening one takes a moment, so racing requests overlap as they do on Cloudflare. */
function sandboxes() {
  const owners = new Map<string, string>();
  const stub = (sid: string) => ({
    async init() {
      await later();
      if (!owners.has(sid)) owners.set(sid, hex());
      return { owner: owners.get(sid)! };
    },
    async isOwner(secret: string) {
      await later();
      return owners.get(sid) === secret;
    },
    async state() {
      return { ok: true };
    },
  });
  return { owners, env: { SANDBOX: { idFromName: (name: string) => name, get: (id: string) => stub(id) } } };
}

/** One browser: its cookie jar in front of the Worker, installed as fetch. */
function browser(env: unknown) {
  let cookie = "";
  let opens = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://example.com");
    if (url.pathname === "/v1/api/session") opens++;
    const response = await app.request(url.href, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } }, env);
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return response;
  };
  return {
    cookie: () => cookie,
    opens: () => opens,
    state: (sid: string) => app.request(`https://example.com/v1/api/s/${sid}/state`, { headers: { cookie } }, env),
  };
}

/** The page's next session request never settles and ignores its abort: lost before the Worker, or its answer lost after (the cookie set). */
function stallNextOpen(reachesWorker: boolean) {
  const through = globalThis.fetch;
  let stalled = false;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (stalled || !String(input).endsWith("/api/session")) return through(input, init);
    stalled = true;
    if (reachesWorker) await through(input, init);
    return new Promise<never>(() => {});
  };
}

/** Limits short enough for a test: one request 50 ms, an open 150 ms, a wait for another tab 2 s. */
const quick = () => {
  for (const tab of [tabA, tabB]) Object.assign(tab.sessionLimits, { requestMs: 50, openMs: 150, waitMs: 2000 });
};

const realFetch = globalThis.fetch;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
const limits = { ...tabA.sessionLimits };
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(globalThis, "navigator", realNavigator);
  for (const tab of [tabA, tabB]) Object.assign(tab.sessionLimits, limits);
});

test("two opens on one page (StrictMode's second effect) share one request and one sandbox", async () => {
  const { owners, env } = sandboxes();
  const b = browser(env);
  const [first, second] = await Promise.all([tabA.openSession(), tabA.openSession()]);
  assert.equal(first, second);
  assert.equal(b.opens(), 1);
  assert.equal(owners.size, 1);
  assert.equal(b.cookie(), `apc_session=${first}.${owners.get(first)}`);
  assert.equal((await b.state(first)).status, 200);
});

test("two tabs entering at once end on one sandbox: the second resumes the one the first opened", async () => {
  const { owners, env } = sandboxes();
  const b = browser(env);
  const [a, other] = await Promise.all([tabA.openSession(), tabB.openSession()]);
  assert.equal(a, other);
  assert.equal(b.opens(), 2);
  assert.equal(owners.size, 1);
  assert.equal(b.cookie(), `apc_session=${a}.${owners.get(a)}`);
  assert.equal((await b.state(a)).status, 200);
});

test("without the lock, two tabs would race: two sandboxes, and the page the cookie does not name gets 403", async () => {
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  const { owners, env } = sandboxes();
  const b = browser(env);
  const sids = await Promise.all([tabA.openSession(), tabB.openSession()]);
  assert.equal(owners.size, 2);
  assert.deepEqual((await Promise.all(sids.map(async (sid) => (await b.state(sid)).status))).sort(), [200, 403]);
});

test("a tab whose open never settles lets go of the lock after openMs, and the waiting tab opens its own sandbox", async () => {
  quick();
  const { owners, env } = sandboxes();
  const b = browser(env);
  stallNextOpen(false);
  const stuck = tabA.openSession();
  const waiting = tabB.openSession();
  await assert.rejects(stuck, /timed out/);
  const sid = await waiting;
  assert.equal(owners.size, 1);
  assert.equal(b.cookie(), `apc_session=${sid}.${owners.get(sid)}`);
  assert.equal((await b.state(sid)).status, 200);
});

test("when the stuck open did reach the Worker, the waiting tab resumes the sandbox its cookie names", async () => {
  quick();
  const { owners, env } = sandboxes();
  const b = browser(env);
  stallNextOpen(true);
  const stuck = tabA.openSession();
  const waiting = tabB.openSession();
  await assert.rejects(stuck, /timed out/);
  const sid = await waiting;
  assert.equal(b.opens(), 2);
  assert.equal(owners.size, 1);
  assert.equal(b.cookie(), `apc_session=${sid}.${owners.get(sid)}`);
  assert.equal((await b.state(sid)).status, 200);
});

test("an open given up at the deadline sends no request after it, even when its pause between attempts wakes late", async () => {
  quick();
  for (const tab of [tabA, tabB]) Object.assign(tab.sessionLimits, { openMs: 300 });
  const { owners, env } = sandboxes();
  const b = browser(env);
  // The first tab's first attempt fails at once; its 250 ms pause, throttled as in a background tab,
  // would wake at 1 s, long after the 300 ms deadline let the second tab in.
  const through = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/api/session")) return through(input, init);
    if (++posts === 1) return new Response("{}", { status: 503 });
    return through(input, init);
  };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(fn, ms === 250 ? 1000 : ms)) as typeof setTimeout;
  try {
    const stuck = tabA.openSession();
    const waiting = tabB.openSession();
    await assert.rejects(stuck);
    const sid = await waiting;
    await new Promise((resolve) => realSetTimeout(resolve, 1200));
    assert.equal(posts, 2, "the first tab sent nothing after its deadline");
    assert.equal(owners.size, 1);
    assert.equal(b.cookie(), `apc_session=${sid}.${owners.get(sid)}`);
    assert.equal((await b.state(sid)).status, 200);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("a tab that waits longer than waitMs for another's open gives up with an error instead of hanging", async () => {
  let release = () => {};
  const held = navigator.locks.request("apc-v1-session", () => new Promise<void>((resolve) => (release = resolve)));
  Object.assign(tabB.sessionLimits, { waitMs: 50 });
  const { env } = sandboxes();
  const b = browser(env);
  await assert.rejects(tabB.openSession(), (error: Error) => error.name === "TimeoutError" || error.name === "AbortError");
  assert.equal(b.opens(), 0);
  release();
  await held;
});

test("the Worker resumes the sandbox a create's cookie names (set by a parallel request), and opens none", async () => {
  const { owners, env } = sandboxes();
  const b = browser(env);
  const sid = await tabA.openSession();
  const response = await app.request("https://example.com/v1/api/session", { method: "POST", headers: { cookie: b.cookie(), "content-type": "application/json" }, body: "{}" }, env);
  assert.deepEqual(await response.json(), { sid, created: false });
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(owners.size, 1);

  // A cookie whose sandbox is gone (expired) opens a new one and names it.
  const stale = await app.request("https://example.com/v1/api/session", { method: "POST", headers: { cookie: `apc_session=${hex()}.${hex()}` }, body: "{}" }, env);
  const opened = (await stale.json()) as { sid: string; created: boolean };
  assert.equal(opened.created, true);
  assert.match(stale.headers.get("set-cookie") ?? "", new RegExp(`^apc_session=${opened.sid}\\.${owners.get(opened.sid)};`));
});
