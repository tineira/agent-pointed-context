/**
 * No dock is created until the person chooses (TIN-879). The Worker with a stub HUB that counts `init`: opening
 * the dock only resumes, creating is explicit and only from the dock's own page, and the pets still only resume.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Hono } from "hono";
import { openOutcome } from "../src/web/open-outcome.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject { constructor() { throw new Error('Unexpected Durable Object'); } }", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const app: Hono = await import(new URL("../src/worker/index.ts", import.meta.url).href).then((m) => m.default).finally(() => hooks.deregister());

const ORIGIN = "https://dock.test";
const GONE = `apc_dock=${"c".repeat(32)}.${"d".repeat(32)}`;

/** A HUB whose docks are the ones in `docks` (id to owner secret); `init` is counted and makes one. */
function world() {
  const docks = new Map<string, string>();
  const calls = { init: 0 };
  const env = {
    HUB: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        isOwner: async (secret: string) => docks.get(name) === secret,
        state: async () => ({ agents: [] }),
        init: async (did: string) => {
          calls.init++;
          const owner = "e".repeat(32);
          docks.set(did, owner);
          return { owner };
        },
      }),
    },
  };
  return { env, docks, calls };
}
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("opening the dock with no dock creates nothing: 404 no_dock, no cookie, init never called", async () => {
  const { env, calls } = world();
  const response = await app.request(`${ORIGIN}/api/dock`, post({}, { origin: ORIGIN }), env);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "no_dock" });
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(calls.init, 0);
});

test("a cookie naming a dock that no longer opens says replaced, and creates nothing", async () => {
  const { env, calls } = world();
  const response = await app.request(`${ORIGIN}/api/dock`, post({ desktop: true }, { cookie: GONE }), env);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "no_dock", replaced: true });
  assert.match(response.headers.get("set-cookie") ?? "", /^apc_dock=; Max-Age=0/);
  assert.equal(calls.init, 0);
});

test("Create is explicit: POST /api/dock/new makes one dock, and a visitor whose dock opens gets it back", async () => {
  const { env, calls } = world();
  const made = await app.request(`${ORIGIN}/api/dock/new`, post({}, { origin: ORIGIN }), env);
  assert.equal(made.status, 200);
  const body = (await made.json()) as { did: string; created: boolean };
  assert.equal(body.created, true);
  assert.equal(calls.init, 1);
  const cookie = made.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(cookie, new RegExp(`^apc_dock=${body.did}\\.[0-9a-f]{32}$`));
  // Reloading resumes the same dock, and a second Create (a double click, another tab) makes no second one.
  const resumed = await app.request(`${ORIGIN}/api/dock`, post({}, { cookie }), env);
  assert.deepEqual(await resumed.json(), { did: body.did, created: false });
  const again = await app.request(`${ORIGIN}/api/dock/new`, post({}, { cookie, origin: ORIGIN }), env);
  assert.deepEqual(await again.json(), { did: body.did, created: false });
  assert.equal(calls.init, 1);
});

test("Create from another site is refused with 403 and creates nothing", async () => {
  const { env, calls } = world();
  const forged: Array<Record<string, string>> = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { origin: "https://evil.example", "sec-fetch-site": "same-origin" }];
  for (const headers of forged) {
    const response = await app.request(`${ORIGIN}/api/dock/new`, post({}, headers), env);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(calls.init, 0);
});

test("the pets (resume: true) still get 404 with no dock, and still resume an existing one", async () => {
  const { env, docks, calls } = world();
  const none = await app.request(`${ORIGIN}/api/dock`, post({ resume: true, desktop: true }), env);
  assert.equal(none.status, 404);
  assert.equal(((await none.json()) as { error: string }).error, "no_dock");
  assert.equal(calls.init, 0);
  docks.set("a".repeat(32), "b".repeat(32));
  const some = await app.request(`${ORIGIN}/api/dock`, post({ resume: true }, { cookie: `apc_dock=${"a".repeat(32)}.${"b".repeat(32)}` }), env);
  assert.deepEqual(await some.json(), { did: "a".repeat(32), created: false });
});

test("a cookie for a gone dock is cleared by the 404, so the next visit carries none", async () => {
  const { env } = world();
  const response = await app.request(`${ORIGIN}/api/dock`, post({ resume: true }, { cookie: GONE }), env);
  assert.equal(response.status, 404);
  assert.match(response.headers.get("set-cookie") ?? "", /^apc_dock=;.*(Max-Age=0|Expires=)/i);
});

test("Create's guard: Origin null and a different scheme or port are refused; a request with no browser headers is the one let through", async () => {
  const { env, calls } = world();
  for (const origin of ["null", "http://dock.test", "https://dock.test:8443", "https://sub.dock.test"]) {
    const response = await app.request(`${ORIGIN}/api/dock/new`, post({}, { origin }), env);
    assert.equal(response.status, 403, origin);
  }
  assert.equal(calls.init, 0);
  // No Origin and no Sec-Fetch-Site (the e2e script, curl): allowed by design, and pinned so a change to the guard is seen.
  assert.equal((await app.request(`${ORIGIN}/api/dock/new`, post({}), env)).status, 200);
  assert.equal(calls.init, 1);
});

test("the page makes a chooser only from the dock's own no_dock, never from another 404 or a 5xx", () => {
  assert.deepEqual(openOutcome(404, { error: "no_dock" }), { kind: "choose", replaced: false });
  assert.deepEqual(openOutcome(404, { error: "no_dock", replaced: true }), { kind: "choose", replaced: true });
  assert.deepEqual(openOutcome(200, { did: "a".repeat(32), created: false }), { kind: "dock", did: "a".repeat(32) });
  for (const [status, body] of [[404, { error: "not_found" }], [404, null], [404, "no_dock"], [500, { error: "no_dock" }], [403, { error: "no_dock" }], [200, {}], [200, null], [502, null]] as const) {
    assert.deepEqual(openOutcome(status, body), { kind: "error", status }, `${status} ${JSON.stringify(body)}`);
  }
});

test("the owner's API refuses another site on every route, a sibling subdomain included, before it reads the cookie (TIN-865)", async () => {
  const { env, docks } = world();
  const did = "a".repeat(32);
  docks.set(did, "b".repeat(32));
  let ownerChecks = 0;
  const hub = env.HUB.get(did);
  const counted = { ...env, HUB: { ...env.HUB, get: () => ({ ...hub, isOwner: async (s: string) => (ownerChecks++, hub.isOwner(s)) }) } };
  const cookie = `apc_dock=${did}.${"b".repeat(32)}`;
  const forged: Array<Record<string, string>> = [
    { origin: "https://evil.example" },
    { origin: "https://sub.dock.test" },
    { origin: "http://dock.test" },
    { origin: "null" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "cross-site" },
  ];
  const routes = app.routes.filter((r) => r.path.startsWith("/api/d/:did/") && r.method !== "ALL");
  assert.ok(routes.length >= 15, `found ${routes.length} owner routes`);
  for (const route of routes) {
    const path = route.path.replace(":did", did).replace(/:[a-z]+/g, "x");
    for (const headers of forged) {
      const init = route.method === "GET" ? { headers: { cookie, upgrade: "websocket", ...headers } } : post({ action: "allow" }, { cookie, ...headers });
      const response = await app.request(`${ORIGIN}${path}`, init, counted);
      assert.equal(response.status, 403, `${route.method} ${path} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(ownerChecks, 0, "the cookie was checked before the guard");
});

test("the owner's API still answers the dock's own page: same Origin, or a same-origin GET with no Origin", async () => {
  const { env, docks } = world();
  const did = "a".repeat(32);
  docks.set(did, "b".repeat(32));
  const cookie = `apc_dock=${did}.${"b".repeat(32)}`;
  const own: Array<Record<string, string>> = [{ origin: ORIGIN }, { "sec-fetch-site": "same-origin" }, {}];
  for (const headers of own) {
    const response = await app.request(`${ORIGIN}/api/d/${did}/state`, { headers: { cookie, ...headers } }, env);
    assert.equal(response.status, 200, JSON.stringify(headers));
    assert.deepEqual(await response.json(), { agents: [] });
  }
});
