#!/usr/bin/env node
// Read the split site's real assets and root dispatch in workerd. No production writes or credentials.
import assert from "node:assert/strict";
import { startWorkerd } from "./lib/dock-workerd.mjs";

const ORIGIN = "https://apc.tineira.com";
const runtime = await startWorkerd();
const rows = [];
async function check(path, { status = 200, type = /text\/html/, body = /Agent Pointed Context/, ...init } = {}) {
  const response = await runtime.send(`${ORIGIN}${path}`, { redirect: "manual", ...init });
  assert.equal(response.status, status, path);
  assert.match(response.headers.get("content-type") ?? "", type, path);
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'", path);
  assert.equal(response.headers.get("x-frame-options"), "DENY", path);
  const text = await response.text();
  assert.match(text, body, path);
  rows.push(`| ${init.method ?? "GET"} ${path} | ${response.status} | ${response.headers.get("content-type")} | checked |`);
  return { response, text };
}
try {
  const landing = await check("/");
  await check("/?start_over=1");
  await check("/?utm=site");
  for (const path of ["/try", "/try?ref=test", "/build", "/build/direct", "/build/dock", "/build/both"]) await check(path);
  for (const path of ["/docs", "/docs?ref=test", "/docs/spec"]) await check(path, { body: /<article class="docs-body"><h1/ });
  await check("/docs/spec.md", { type: /markdown|text\/plain/, body: /^# The APC specification/ });
  await check("/llms.txt", { type: /text\/plain/, body: /\(\/docs\/spec\.md\)/ });
  await check("/llms.txt?ref=test", { type: /text\/plain/, body: /\(\/docs\/spec\.md\)/ });

  // Every script/style/icon/manifest referenced by the actual landing resolves at the same public origin.
  const refs = [...landing.text.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]);
  assert.ok(refs.some((p) => p.startsWith("/site-assets/")), "landing names its own asset directory");
  for (const path of new Set(refs)) {
    const response = await runtime.send(`${ORIGIN}${path}`, { redirect: "manual" });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    const type = response.headers.get("content-type") ?? "";
    assert.ok(!type.includes("text/html"), `${path} must be its own asset, never an SPA fallback`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 0, path);
    if (path.endsWith(".js")) assert.match(new TextDecoder().decode(bytes), /Point your AI agent at what you see/);
    rows.push(`| GET ${path} | ${response.status} | ${type} | file bytes, no SPA fallback |`);
  }

  const range = await runtime.send(`${ORIGIN}/media/apc-hero.mp4`, { headers: { range: "bytes=0-99" } });
  assert.equal(range.status, 206);
  assert.match(range.headers.get("content-range"), /^bytes 0-99\/\d+$/);
  assert.equal(range.headers.get("content-type"), "video/mp4");
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  rows.push("| GET /media/apc-hero.mp4 (Range bytes=0-99) | 206 | video/mp4 | 100 bytes, Content-Range checked |");
  const head = await runtime.send(`${ORIGIN}/media/apc-hero.mp4`, { method: "HEAD", headers: { range: "bytes=0-99" } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("content-length"), "100");
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  await check("/dock", { body: /<title>Agent dock<\/title>/ });
  await check("/.well-known/apc.json", { type: /application\/json/, body: /"profiles":\["hub"\]/ });
  await check("/sw.js", { type: /javascript/, body: /path === "\/dock" \|\| path.startsWith\("\/dock\/"\)/ });
  const unknown = await runtime.send(`${ORIGIN}/apc/not-a-route`, { redirect: "manual" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("location"), null);
  await unknown.body?.cancel();

  // A real synthetic dock in SQLite; its cookie never reaches logs or the site Worker.
  const created = await runtime.send(`${ORIGIN}/api/dock/new`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
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
    const head = await check("/", { method: "HEAD", body: /^$/ });
    assert.equal(head.response.headers.get("etag"), landing.response.headers.get("etag"));
    const conditional = await runtime.send(`${ORIGIN}/`, { headers: { "if-none-match": landing.response.headers.get("etag") } });
    assert.equal(conditional.status, 304);
    await conditional.body?.cancel();
    const post = await runtime.send(`${ORIGIN}/`, { method: "POST", body: "site", redirect: "manual" });
    assert.equal(post.status, 405);
    await post.body?.cancel();
  } finally {
    const reset = await runtime.send(`${ORIGIN}/api/d/${did}/reset`, { method: "POST", headers: { cookie, origin: ORIGIN } });
    assert.equal(reset.status, 200);
    await reset.body?.cancel();
  }
  console.log("| Request | Status | Content type | Body/result |\n| --- | --- | --- | --- |\n" + rows.join("\n"));
  console.log("Site routes in workerd: passed (pages, referenced assets, ranges, root dispatch, HEAD/304/405, M2)");
} finally {
  await runtime.stop();
}
