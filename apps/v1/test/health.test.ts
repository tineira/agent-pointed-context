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

test("wrangler.jsonc runs the Worker first on /v1 and on the API prefixes with and without a trailing slash", async () => {
  const { readFileSync } = await import("node:fs");
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const rules = JSON.parse(/"run_worker_first":\s*(\[[^\]]*\])/.exec(config)![1]!) as string[];
  // /v1 itself, so the Worker's 302 to /v1/ wins over the assets' 307 for the v1/ folder.
  assert.ok(rules.includes("/v1"), "/v1");
  for (const prefix of ["/v1/api", "/v1/mcp", "/v1/apc", "/v1/.well-known"]) {
    assert.ok(rules.includes(prefix), prefix);
    assert.ok(rules.includes(`${prefix}/*`), `${prefix}/*`);
  }
});

test("wrangler.jsonc keeps to generally available assets options: no base_path, no SPA fallback, the ASSETS binding", async () => {
  const { readFileSync } = await import("node:fs");
  // Comments stripped: the explanation in wrangler.jsonc names base_path.
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const assets = /"assets":\s*\{([^}]*)\}/.exec(config)![1]!;
  assert.doesNotMatch(assets, /base_path/);
  assert.doesNotMatch(assets, /not_found_handling/);
  assert.match(assets, /"binding":\s*"ASSETS"/);
});

test("every file of the page sits under v1/ (TIN-604): the HTML, the bundles and the public files", async () => {
  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  assert.ok(existsSync(new URL("../v1/index.html", import.meta.url)), "v1/index.html");
  assert.ok(!existsSync(new URL("../index.html", import.meta.url)), "no index.html at the root");
  assert.deepEqual(readdirSync(new URL("../public", import.meta.url)), ["v1"]);
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /assetsDir:\s*"v1\/assets"/);
  assert.match(vite, /input:\s*"v1\/index\.html"/);
  const html = readFileSync(new URL("../v1/index.html", import.meta.url), "utf8");
  const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(hrefs.length, 3);
  for (const href of hrefs) assert.match(href, /^\/v1\//, href);
});

/** A fake assets binding: these files, auto-trailing-slash for index.html, and a null-body 404 for anything else. */
function assetsEnv(files: Record<string, string>) {
  const seen: string[] = [];
  const ASSETS = {
    async fetch(input: Request) {
      const { pathname } = new URL(input.url);
      seen.push(`${input.method} ${pathname}`);
      if (pathname.endsWith("/index.html")) return new Response(null, { status: 307, headers: { location: pathname.slice(0, -"index.html".length) } });
      const body = files[pathname.endsWith("/") ? `${pathname}index.html` : pathname];
      return body === undefined ? new Response(null, { status: 404 }) : new Response(input.method === "HEAD" ? null : body, { status: 200 });
    },
  };
  return { env: { ASSETS } as Record<string, unknown>, seen };
}

test("under /v1/, an app route that matches no file gets the page; a missing file stays a 404", async () => {
  const files = { "/v1/index.html": "<!doctype html>V1", "/v1/favicon.svg": "<svg/>" };
  for (const path of ["/v1/", "/v1/how-to", "/v1/how-to/", "/v1/overview", "/v1/customers/cus_0001", "/v1/connect?x=1"]) {
    for (const method of ["GET", "HEAD"]) {
      const { env } = assetsEnv(files);
      const response = await app.request(`https://example.com${path}`, { method }, env);
      assert.equal(response.status, 200, `${method} ${path}`);
      if (method === "GET") assert.equal(await response.text(), "<!doctype html>V1", path);
    }
  }
  {
    const { env } = assetsEnv(files);
    const response = await app.request("https://example.com/v1/favicon.svg", {}, env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<svg/>");
  }
  for (const path of ["/v1/assets/gone-1234.js", "/v1/robots.txt", "/v1/favicon.png"]) {
    const { env, seen } = assetsEnv(files);
    const response = await app.request(`https://example.com${path}`, {}, env);
    assert.equal(response.status, 404, path);
    assert.deepEqual(seen, [`GET ${path}`], path);
  }
  {
    // Only a GET or HEAD gets the page.
    const { env } = assetsEnv(files);
    const response = await app.request("https://example.com/v1/how-to", { method: "POST" }, env);
    assert.equal(response.status, 404);
  }
});

test("outside /v1 nothing falls back to the page, and the assets are never asked", async () => {
  const { env, seen } = assetsEnv({ "/v1/index.html": "<!doctype html>V1" });
  for (const path of ["/how-to", "/overview/", "/index.html", "/v10/how-to", "/v1-old/"]) {
    const response = await app.request(`https://example.com${path}`, {}, env);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "not_found" }, path);
  }
  assert.deepEqual(seen, []);
});
