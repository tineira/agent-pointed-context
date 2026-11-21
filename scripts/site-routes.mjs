#!/usr/bin/env node
// Read the split site's real assets in workerd, and check its CSP (TIN-1013) on every HTML response and every
// built page. No production writes or credentials.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { SITE_CSP } from "../apps/site/src/worker/csp.ts";
import { startWorkerd } from "./lib/dock-workerd.mjs";
import { cspViolations, headersFileCsp } from "./lib/site-csp.mjs";

const ORIGIN = "https://apc.tineira.com";

// Every built page first: an inline script without its hash, a handler, a javascript: URL, an inline style or a
// file from another origin would be blocked in production (or must never be allowed). Fails before workerd starts.
const client = new URL("../apps/site/dist/client/", import.meta.url);
const pages = readdirSync(client, { recursive: true }).map(String).filter((file) => file.endsWith(".html"));
assert.ok(pages.length >= 8, `the build has its pages (index.html, docs.html, docs/*.html): ${pages.join(", ")}`);
for (const file of pages) {
  const found = cspViolations(readFileSync(new URL(file.replaceAll("\\", "/"), client), "utf8"), SITE_CSP);
  assert.deepEqual(found, [], `apps/site/dist/client/${file} breaks the site's CSP:\n${found.join("\n")}`);
}
assert.equal(headersFileCsp(readFileSync(new URL("_headers", client), "utf8")), SITE_CSP, "the built _headers carries SITE_CSP");

const runtime = await startWorkerd({ site: true });
const rows = [];
const send = (path, init) => runtime.send(`${ORIGIN}${path}`, { signal: AbortSignal.timeout(20_000), ...init });
async function check(path, { status = 200, type = /text\/html/, body = /Agent Pointed Context/, navigate = false, ...init } = {}) {
  const response = await send(path, { redirect: "manual", ...init, headers: { ...init.headers, "x-workerd-report-fetch-mode": "1" } });
  assert.equal(response.status, status, path);
  assert.match(response.headers.get("content-type") ?? "", type, path);
  assert.equal(response.headers.get("content-security-policy"), SITE_CSP, path);
  assert.equal(response.headers.get("x-frame-options"), "DENY", path);
  const text = await response.text();
  assert.match(text, body, path);
  const mode = response.headers.get("x-workerd-fetch-mode");
  assert.ok(mode, `${path}: workerd reported the fetch mode`);
  assert.equal(mode === "navigate", navigate, `${path}: workerd saw Sec-Fetch-Mode: ${mode}`);
  rows.push(`| ${init.method ?? "GET"} ${path} | ${response.status} | ${response.headers.get("content-type")} | workerd saw Sec-Fetch-Mode: ${mode} |`);
  return { response, text };
}
try {
  const landing = await check("/");
  for (const path of ["/", "/try", "/docs"]) {
    // Node's fetch supplies its own Sec-Fetch-Mode. Miniflare reapplies this override inside workerd.
    await check(path, { navigate: true, headers: { "mf-sec-fetch-mode": "navigate" }, body: path === "/docs" ? /<article class="docs-body"><h1/ : /Agent Pointed Context/ });
  }
  await check("/?start_over=1");
  await check("/?utm=site");
  for (const path of ["/try", "/try?ref=test", "/build"]) await check(path);
  // The pages that left with the Dock's profile answer a 301 to /build, with the site's headers (TIN-1061).
  for (const path of ["/build/direct", "/build/dock/", "/build/both?ref=test"]) {
    const { response } = await check(path, { status: 301, type: /.*/, body: /.*/ });
    assert.equal(response.headers.get("location"), path.includes("?") ? "/build?ref=test" : "/build", path);
  }
  for (const path of ["/docs", "/docs?ref=test", "/docs/spec"]) await check(path, { body: /<article class="docs-body"><h1/ });
  await check("/docs/spec.md", { type: /markdown|text\/plain/, body: /^# The APC specification/ });
  await check("/llms.txt", { type: /text\/plain/, body: /\(\/docs\/spec\.md\)/ });
  await check("/llms.txt?ref=test", { type: /text\/plain/, body: /\(\/docs\/spec\.md\)/ });

  // Every landing asset is the site's own: since TIN-1061 it names nothing of the hub's (icons, manifest).
  const refs = [...landing.text.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]);
  assert.ok(refs.some((p) => p.startsWith("/site-assets/")), "landing names its own asset directory");
  for (const path of new Set(refs)) {
    const response = await send(path, { redirect: "manual" });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.equal(response.headers.get("content-security-policy"), SITE_CSP, path);
    const type = response.headers.get("content-type") ?? "";
    assert.ok(!type.includes("text/html"), `${path} must be its own asset, never an SPA fallback`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 0, path);
    if (path.endsWith(".js")) assert.match(new TextDecoder().decode(bytes), /Point your AI agent at what you see/);
    rows.push(`| GET ${path} | ${response.status} | ${type} | file bytes, no SPA fallback |`);
  }

  const range = await send("/media/apc-hero.mp4", { headers: { range: "bytes=0-99" } });
  assert.equal(range.status, 206);
  assert.match(range.headers.get("content-range"), /^bytes 0-99\/\d+$/);
  assert.equal(range.headers.get("content-type"), "video/mp4");
  assert.equal(range.headers.get("content-security-policy"), SITE_CSP, "the Worker's own responses carry the CSP");
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  rows.push("| GET /media/apc-hero.mp4 (Range bytes=0-99) | 206 | video/mp4 | 100 bytes, Content-Range checked |");
  const head = await send("/media/apc-hero.mp4", { method: "HEAD", headers: { range: "bytes=0-99" } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("content-length"), "100");
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const rootHead = await check("/", { method: "HEAD", body: /^$/ });
  assert.equal(rootHead.response.headers.get("etag"), landing.response.headers.get("etag"));
  const conditional = await send("/", { headers: { "if-none-match": landing.response.headers.get("etag") } });
  assert.equal(conditional.status, 304);
  await conditional.body?.cancel();
  const post = await send("/", { method: "POST", body: "site", redirect: "manual" });
  assert.equal(post.status, 405);
  await post.body?.cancel();

  console.log("| Request | Status | Content type | Body/result |\n| --- | --- | --- | --- |\n" + rows.join("\n"));
  console.log(`Site routes in workerd: passed (pages, referenced assets, ranges, HEAD/304/405, M2; CSP on every response and ${pages.length} built pages)`);
} finally {
  await runtime.stop();
}

