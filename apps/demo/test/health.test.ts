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

test("health is public, uncached and reads no bindings or env vars", async () => {
  const env = new Proxy({}, {
    get(_target, key) {
      assert.fail(`Unexpected env access: ${String(key)}`);
    },
  });
  for (const cookie of ["", `apc_session=${"a".repeat(32)}.${"b".repeat(32)}`]) {
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
