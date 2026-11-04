import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Hono } from "hono";

// Node has no Workers runtime; importing the app must not construct a Durable Object.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject { constructor() { throw new Error('Unexpected Durable Object'); } }", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const app: Hono = await import(new URL("../src/worker/index.ts", import.meta.url).href).then((m) => m.default).finally(() => hooks.deregister());

test("health is public, uncached and reads no bindings or env vars", async () => {
  const env = new Proxy({}, {
    get(_target, key) {
      assert.fail(`Unexpected env access: ${String(key)}`);
    },
  });
  for (const cookie of ["", `apc_dock=${"a".repeat(32)}.${"b".repeat(32)}`]) {
    const response = await app.request("https://example.com/api/health", {
      headers: { cookie, origin: "https://other.example" },
    }, env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.clone().text(), '{"ok":true}');
    assert.deepEqual(await response.json(), { ok: true });
  }
});

test("the dock is never framed: every Worker response and every asset says frame-ancestors 'none' and DENY (TIN-581)", async () => {
  const framing = (r: Response, what: string) => {
    assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'none'", what);
    assert.equal(r.headers.get("x-frame-options"), "DENY", what);
  };
  framing(await app.request("https://example.com/api/health"), "the API");
  framing(await app.request("https://example.com/api/d/" + "a".repeat(32) + "/state"), "a refused owner call");
  framing(await app.request("https://example.com/v1"), "a redirect");
  framing(await app.request("https://example.com/apc/nothing", { method: "POST" }), "a 404");
  // Assets the Worker hands out: the landing at /, and anything else; their headers may be immutable, as a fetched response's are.
  const env = { ASSETS: { fetch: async () => Response.redirect("https://example.com/dock", 302) } };
  framing(await app.request("https://example.com/", {}, env), "the landing");
  framing(await app.request("https://example.com/dock/agents/ag_1", {}, env), "the dock page through the Worker");
  // And the assets served without the Worker (/dock): public/_headers, for every path.
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.match(headers, /^\/\*\r?\n  Content-Security-Policy: frame-ancestors 'none'\r?\n  X-Frame-Options: DENY\r?$/m);
});

test("a request for /v1 that reaches the dock is sent on or refused, never the dock page (TIN-605)", async () => {
  const env = new Proxy({}, { get(_target, key) { assert.fail(`Unexpected env access: ${String(key)}`); } });
  for (const [path, location] of [["/v1", "/v1/"], ["/v1?ref=paper", "/v1/?ref=paper"]] as const) {
    const response = await app.request(`https://example.com${path}`, {}, env);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), location, path);
  }
  for (const path of ["/v1/", "/v1/overview", "/v1/api/health"]) {
    const response = await app.request(`https://example.com${path}`, {}, env);
    assert.equal(response.status, 404, path);
  }
});

test("the root is always the landing; /api/dock/mine says whether the visitor has a dock (TIN-610)", async () => {
  const live = `apc_dock=${"a".repeat(32)}.${"b".repeat(32)}`;
  const expired = `apc_dock=${"c".repeat(32)}.${"d".repeat(32)}`;
  const env = {
    HUB: { idFromName: (name: string) => name, get: (name: string) => ({ isOwner: async (secret: string) => name === "a".repeat(32) && secret === "b".repeat(32) }) },
    ASSETS: { fetch: async (req: Request) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { "content-type": "text/html" } }) },
  };
  // The landing, for a visitor with a dock, an expired one and none: 200, never a redirect.
  for (const cookie of [live, expired, ""]) {
    const response = await app.request("https://example.com/", { headers: { cookie } }, env);
    assert.equal(response.status, 200, cookie);
    assert.equal(await response.text(), "asset /", cookie);
    assert.equal(response.headers.get("location"), null, cookie);
  }
  // The flag the landing reads: a yes or no behind the cookie, uncached, with nothing else in it.
  const mine = async (cookie: string) => {
    const response = await app.request("https://example.com/api/dock/mine", { headers: { cookie } }, env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    return response.json();
  };
  assert.deepEqual(await mine(live), { has_dock: true });
  assert.deepEqual(await mine(expired), { has_dock: false });
  assert.deepEqual(await mine(""), { has_dock: false });
  assert.deepEqual(await mine("apc_dock=not-a-session"), { has_dock: false });
  // ?start_over=1 (a link from another site's dialog) still reaches the dock for a visitor who has one, query kept.
  const startOver = await app.request("https://example.com/?start_over=1", { headers: { cookie: live } }, env);
  assert.equal(startOver.status, 302);
  assert.equal(startOver.headers.get("location"), "/dock?start_over=1");
  // Without a dock there is nothing to start over: the landing.
  assert.equal((await app.request("https://example.com/?start_over=1", {}, env)).status, 200);
  // /dock is untouched: the static page, as before.
  const dock = await app.request("https://example.com/dock", { headers: { cookie: live } }, env);
  assert.equal(dock.status, 200);
  assert.equal(await dock.text(), "asset /dock");
  // The frame protection holds for all of it.
  assert.equal(startOver.headers.get("x-frame-options"), "DENY");
  assert.equal((await app.request("https://example.com/api/dock/mine", {}, env)).headers.get("x-frame-options"), "DENY");
});
