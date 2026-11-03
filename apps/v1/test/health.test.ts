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
  const paths = [
    "/v1/.well-known/oauth-protected-resource", "/v1/api/nope", "/v1/apc/revoke", "/v1/mcp/not-a-sid/x",
    // A malformed MCP URL with one or three segments (TIN-604 review): a JSON 404, not the page.
    `/v1/mcp/${"a".repeat(32)}`, `/v1/mcp/${"a".repeat(32)}/${"b".repeat(32)}/extra`,
    // The prefixes themselves, without a trailing slash.
    "/v1/api", "/v1/mcp", "/v1/apc", "/v1/.well-known", "/v1/mcp/",
  ];
  for (const path of paths) {
    for (const method of ["GET", "POST"]) {
      const response = await app.request(`https://example.com${path}`, { method }, noEnv());
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "not_found" }, `${method} ${path}`);
    }
  }
});

test("wrangler.jsonc runs the Worker first on the API prefixes with and without a trailing slash", async () => {
  const { readFileSync } = await import("node:fs");
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const rules = JSON.parse(/"run_worker_first":\s*(\[[^\]]*\])/.exec(config)![1]!) as string[];
  for (const prefix of ["/v1/api", "/v1/mcp", "/v1/apc", "/v1/.well-known"]) {
    assert.ok(rules.includes(prefix), prefix);
    assert.ok(rules.includes(`${prefix}/*`), `${prefix}/*`);
  }
});
