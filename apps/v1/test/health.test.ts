import assert from "node:assert/strict";
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

/** An env that fails the test on any binding or variable read. */
const noEnv = () =>
  new Proxy({}, {
    get(_target, key) {
      assert.fail(`Unexpected env access: ${String(key)}`);
    },
  });

test("health is public, uncached and reads no bindings or env vars", async () => {
  for (const cookie of ["", `apc_session=${"a".repeat(32)}.${"b".repeat(32)}`]) {
    const response = await app.request("https://example.com/v1/api/health", {
      headers: { cookie, origin: "https://other.example" },
    }, noEnv());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.clone().text(), '{"ok":true}');
    assert.deepEqual(await response.json(), { ok: true });
  }
});

test("V1 lives under /v1 (TIN-604): / redirects there, and no other root path is served", async () => {
  for (const path of ["/", "/v1"]) {
    const response = await app.request(`https://example.com${path}`, {}, noEnv());
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), "/v1/", path);
  }
  for (const path of ["/api/health", "/api/session", `/mcp/${"a".repeat(32)}/${"b".repeat(32)}`, "/overview", "/how-to", "/favicon.svg", "/.well-known/oauth-authorization-server", "/v10/api/health"]) {
    const response = await app.request(`https://example.com${path}`, { method: path === "/api/session" ? "POST" : "GET" }, noEnv());
    assert.equal(response.status, 404, path);
  }
});

test("under /v1, discovery, unknown API paths and malformed MCP URLs are 404 without touching a sandbox", async () => {
  for (const path of ["/v1/.well-known/oauth-protected-resource", "/v1/api/nope", "/v1/apc/revoke", "/v1/mcp/not-a-sid/x"]) {
    const response = await app.request(`https://example.com${path}`, { method: "POST" }, noEnv());
    assert.equal(response.status, 404, path);
  }
});
