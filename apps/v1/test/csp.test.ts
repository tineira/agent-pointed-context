import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Hono } from "hono";
import { V1_CSP } from "../src/worker/csp.ts";

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

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const directives = new Map(V1_CSP.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1)]));

test("public/_headers carries V1_CSP and DENY for every path", () => {
  const lines = read("../public/_headers").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  assert.deepEqual(lines.map((l) => l.trim()), ["/*", `Content-Security-Policy: ${V1_CSP}`, "X-Frame-Options: DENY"]);
});

test("the policy blocks scripts from anywhere but V1's files, and framing", () => {
  assert.deepEqual(directives.get("default-src"), ["'self'"]);
  const scripts = directives.get("script-src")!;
  assert.equal(scripts[0], "'self'");
  for (const source of scripts.slice(1)) assert.match(source, /^'sha256-[A-Za-z0-9+/]{43}='$/, "only hashes beside 'self'");
  for (const [name, values] of directives) {
    for (const bad of ["'unsafe-eval'", "*", "https:", "http:", "blob:"]) assert.ok(!values.includes(bad), `${name} must not allow ${bad}`);
    if (name !== "style-src") assert.ok(!values.includes("'unsafe-inline'"), `${name} must not allow 'unsafe-inline'`);
  }
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.deepEqual(directives.get("base-uri"), ["'none'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'"]);
});

test("every inline script of v1/index.html is allowed by its hash, and nothing else inline runs", () => {
  const html = read("../v1/index.html");
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1]!));
  assert.ok(inline.length >= 1, "the theme script is still inline");
  const hashes = directives.get("script-src")!.slice(1);
  for (const [, , body] of inline) {
    const hash = `'sha256-${createHash("sha256").update(body!, "utf8").digest("base64")}'`;
    assert.ok(hashes.includes(hash), `an inline script's hash ${hash} is missing from V1_CSP's script-src (and public/_headers)`);
  }
  assert.equal(hashes.length, inline.length, "no hash for a script that is gone");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline event handler");
  assert.doesNotMatch(html, /javascript:/i, "no javascript: URL");
});

/** ASSETS as the platform answers: the page at /v1/, a file at /v1/favicon.svg, a 404 for the rest. */
const assets = {
  async fetch(input: Request) {
    const { pathname } = new URL(input.url);
    if (pathname === "/v1/") return new Response("<!doctype html><title>V1</title>", { headers: { "content-type": "text/html" } });
    if (pathname === "/v1/favicon.svg") return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
    return new Response("not found", { status: 404 });
  },
};

test("the page the Worker serves for an app route, and what it passes through, carry the CSP", async () => {
  for (const path of ["/v1/how-to", "/v1/customers/cus_0001", "/v1/favicon.svg", "/v1/assets/gone.js"]) {
    const response = await app.request(`https://apc.tineira.com${path}`, {}, { ASSETS: assets });
    assert.equal(response.headers.get("content-security-policy"), V1_CSP, path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
  }
  const page = await app.request("https://apc.tineira.com/v1/how-to", {}, { ASSETS: assets });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>V1<\/title>/);
});
