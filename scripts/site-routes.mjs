#!/usr/bin/env node
// Read the split site's real assets and root dispatch in workerd. No production writes or credentials.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { startWorkerd } from "./lib/dock-workerd.mjs";

const ORIGIN = "https://apc.tineira.com";
const dock = existsSync(new URL("../apps/dock/package.json", import.meta.url));
// The landing uses Dock's root-level icons and PWA manifest on the shared origin.
const dockAssets = new Set(["/icon.svg", "/favicon-32.png", "/manifest.webmanifest", "/icon-192.png"]);
const runtime = await startWorkerd({ site: true, dock });
const rows = [];
const send = (path, init) => runtime.send(`${ORIGIN}${path}`, { signal: AbortSignal.timeout(20_000), ...init });
async function check(path, { status = 200, type = /text\/html/, body = /Agent Pointed Context/, navigate = false, ...init } = {}) {
  const response = await send(path, { redirect: "manual", ...init, headers: { ...init.headers, "x-workerd-report-fetch-mode": "1" } });
  assert.equal(response.status, status, path);
  assert.match(response.headers.get("content-type") ?? "", type, path);
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'", path);
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
  for (const path of ["/try", "/try?ref=test", "/build", "/build/direct", "/build/dock", "/build/both"]) await check(path);
  for (const path of ["/docs", "/docs?ref=test", "/docs/spec"]) await check(path, { body: /<article class="docs-body"><h1/ });
  await check("/docs/spec.md", { type: /markdown|text\/plain/, body: /^# The APC specification/ });
  await check("/llms.txt", { type: /text\/plain/, body: /\(\/docs\/spec\.md\)/ });
  await check("/llms.txt?ref=test", { type: /text\/plain/, body: /\(\/docs\/spec\.md\)/ });

  // Every landing asset resolves at the shared origin when Dock is mounted.
  const refs = [...landing.text.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]);
  assert.ok(refs.some((p) => p.startsWith("/site-assets/")), "landing names its own asset directory");
  for (const path of new Set(refs)) {
    if (!dock && dockAssets.has(path)) continue;
    const response = await send(path, { redirect: "manual" });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
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

  if (dock) await checkDock();
  else console.log("Dock route checks skipped: apps/dock not in this repo");
  console.log("| Request | Status | Content type | Body/result |\n| --- | --- | --- | --- |\n" + rows.join("\n"));
  console.log("Site routes in workerd: passed (pages, referenced assets, ranges, HEAD/304/405, M2)");
} finally {
  await runtime.stop();
}

async function checkDock() {
  await check("/dock", { body: /<title>Agent dock<\/title>/ });
  await check("/.well-known/apc.json", { type: /application\/json/, body: /"profiles":\["hub"\]/ });
  await check("/sw.js", { type: /javascript/, body: /path === "\/dock" \|\| path.startsWith\("\/dock\/"\)/ });
  const unknown = await send("/apc/not-a-route", { redirect: "manual" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("location"), null);
  await unknown.body?.cancel();

  // A real synthetic dock in SQLite; its cookie never reaches logs or the site Worker.
  const created = await send("/api/dock/new", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
  assert.equal(created.status, 200);
  const cookie = created.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const { did } = await created.json();
  assert.equal(typeof did, "string");
  try {
    const owned = await check("/?start_over=1", { headers: { cookie }, status: 302, type: /.*/, body: /.*/ });
    assert.equal(owned.response.headers.get("location"), "/dock?start_over=1");
    assert.equal(owned.response.headers.get("cache-control"), "no-store");
    assert.equal(owned.response.headers.get("vary"), "Cookie");
    await check("/", { headers: { cookie } });
  } finally {
    const reset = await send(`/api/d/${did}/reset`, { method: "POST", headers: { cookie, origin: ORIGIN } });
    assert.equal(reset.status, 200);
    await reset.body?.cancel();
  }
}
