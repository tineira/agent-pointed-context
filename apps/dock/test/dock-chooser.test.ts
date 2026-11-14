/**
 * No dock is created until the person chooses (TIN-879). The Worker with a stub HUB that counts `init`: opening
 * the dock only resumes, creating is explicit and only from the dock's own page, and the pets still only resume.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Hono } from "hono";

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
  assert.equal(response.headers.get("set-cookie"), null);
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
