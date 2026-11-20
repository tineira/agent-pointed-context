#!/usr/bin/env node
// Read V1's built Worker and assets back in workerd, and check its CSP (TIN-1038) on the page, an app route the
// Worker serves, the bundles and the public files. No production writes or credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { V1_CSP } from "../apps/v1/src/worker/csp.ts";
import { startWorkerd } from "./lib/dock-workerd.mjs";

const client = new URL("../apps/v1/dist/client/", import.meta.url);
const html = readFileSync(new URL("v1/index.html", client), "utf8");
const headersFile = readFileSync(new URL("_headers", client), "utf8");
assert.ok(headersFile.includes(`Content-Security-Policy: ${V1_CSP}\n`), "the built _headers carries V1_CSP");

// The built page: every inline script allowed by its hash, every script file V1's own.
const hashes = V1_CSP.split("; ").find((d) => d.startsWith("script-src "))?.split(" ").slice(2) ?? [];
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
for (const [, attrs, body] of scripts) {
  const src = /\bsrc="([^"]*)"/.exec(attrs)?.[1];
  if (src) assert.match(src, /^\/v1\/assets\/[\w.-]+\.js$/, `a built script comes from V1's own files: ${src}`);
  else assert.ok(hashes.includes(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`), "a built inline script's hash is in V1_CSP");
}
assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline event handler in the built page");

const runtime = await startWorkerd({ v1: true });
const rows = [];
async function check(path, type) {
  const response = await runtime.send(`https://apc.tineira.com${path}`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get("content-type") ?? "", type, path);
  assert.equal(response.headers.get("content-security-policy"), V1_CSP, `${path}: CSP`);
  assert.equal(response.headers.get("x-frame-options"), "DENY", `${path}: X-Frame-Options`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${path}: X-Content-Type-Options`);
  rows.push(`| GET ${path} | ${response.status} | ${response.headers.get("content-type")} |`);
  return response.text();
}
try {
  // /v1/ is an asset served before the Worker runs; /v1/how-to is the page the Worker serves. Local workerd applies
  // public/_headers to both, so this proves the _headers half; apps/v1/test/csp.test.ts proves the Worker's (csp.ts).
  for (const path of ["/v1/", "/v1/how-to", "/v1/customers/cus_0001"]) assert.match(await check(path, /text\/html/), /<div id="root"><\/div>/, path);
  const bundle = /src="(\/v1\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(bundle, "the page names its bundle");
  await check(bundle, /javascript/);
  await check("/v1/favicon.svg", /svg/);
  console.log("| Request | Status | Content type |\n| --- | --- | --- |\n" + rows.join("\n"));
  console.log("V1 routes in workerd: passed (CSP and X-Frame-Options on the page, app routes, a bundle and a public file)");
} finally {
  await runtime.stop();
}
