// The site's page views (TIN-1040), through the real Worker (apps/site/src/worker/index.ts and views.ts): one Analytics Engine point per page view, nothing that identifies a person.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { default: app } = await import("../../apps/site/src/worker/index.ts");
import { deviceClass, referrerHost, viewPoint } from "../../apps/site/src/worker/views.ts";

const ORIGIN = "https://apc.tineira.com";
const html = (status = 200) => new Response(status === 304 ? null : "<!doctype html><title>x</title>", { status, headers: { "content-type": "text/html; charset=utf-8" } });
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function visit(path, init = {}, asset = () => html()) {
  const points = [];
  const env = { ASSETS: { fetch: async () => asset() }, SITE_VIEWS: { writeDataPoint: (p) => points.push(p) } };
  const response = await app.fetch(new Request(`${ORIGIN}${path}`, init), env);
  await response.arrayBuffer();
  return { response, points };
}

test("a page view writes one point: path, referrer host, country, device class, how it was fetched", async () => {
  const { response, points } = await visit("/docs/spec?utm_source=x&email=a@b.c", {
    headers: { "user-agent": CHROME, referer: "https://news.ycombinator.com/item?id=1", "cf-ipcountry": "cl", "sec-fetch-dest": "document", "cf-connecting-ip": "203.0.113.7", cookie: "apc_dock=secret" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(points, [{ indexes: ["/docs/spec"], blobs: ["/docs/spec", "news.ycombinator.com", "CL", "desktop", "document"], doubles: [1] }]);
  const all = JSON.stringify(points);
  for (const clear of ["203.0.113.7", "Chrome", "utm_source", "a@b.c", "secret", "item?id"]) assert.ok(!all.includes(clear), `the point holds no ${clear}`);
});

test("assets, media, Markdown, HEAD, errors and redirects are not page views", async () => {
  const cases = [
    ["/site-assets/index.js", {}, () => new Response("x", { headers: { "content-type": "text/javascript" } })],
    ["/docs/spec.md", {}, () => new Response("# x", { headers: { "content-type": "text/markdown" } })],
    ["/llms.txt", {}, () => new Response("x", { headers: { "content-type": "text/plain" } })],
    ["/docs/spec", { method: "HEAD" }, () => html()],
    ["/docs/x", {}, () => html(404)],
    ["/try", {}, () => Response.redirect(`${ORIGIN}/try/`, 307)],
    ["/site-assets/page.html", {}, () => html()],
  ];
  for (const [path, init, asset] of cases) {
    const { response, points } = await visit(path, init, asset);
    assert.notEqual(response.status, 500, `${path}: the stub answered`);
    assert.deepEqual(points, [], `${init.method ?? "GET"} ${path}`);
  }
});

test("only the site's own pages are named; any other path is (other), never the visitor's text (review of #235)", async () => {
  for (const [path, page] of [["/docs/zzz-not-a-page", "(other)"], ["/tryXYZ-secret", "(other)"], ["/build/x/y/z", "(other)"], ["/docs/%E2%9C%93", "(other)"], ["/docs/" + "a".repeat(5000), "(other)"], ["/try/", "/try"], ["/docs/spec/", "/docs/spec"], ["/", "/"], ["/build/dock", "/build/dock"], ["/docs/changelog", "/docs/changelog"]]) {
    const { points } = await visit(path, { headers: { "user-agent": CHROME } });
    assert.deepEqual(points.map((p) => [p.indexes[0], p.blobs[0]]), [[page, page]], path.slice(0, 40));
  }
});

test("a returning browser's 304 on a page is a view; a 304 elsewhere is not", async () => {
  assert.equal((await visit("/docs/spec", { headers: { "if-none-match": '"x"' } }, () => html(304))).points.length, 1);
  assert.equal((await visit("/docs/nope", { headers: { "if-none-match": '"x"' } }, () => html(304))).points.length, 0);
});

test("a page still loads when the dataset is missing or writing fails", async () => {
  const env = { ASSETS: { fetch: async () => html() }, SITE_VIEWS: { writeDataPoint: () => { throw new Error("quota"); } } };
  assert.equal((await app.fetch(new Request(`${ORIGIN}/`), env)).status, 200);
  assert.equal((await app.fetch(new Request(`${ORIGIN}/`), { ASSETS: env.ASSETS })).status, 200);
});

test("device classes: bots (our own checks included), phones, tablets, desktops", () => {
  assert.equal(deviceClass(CHROME), "desktop");
  assert.equal(deviceClass(IPHONE), "mobile");
  assert.equal(deviceClass("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36"), "mobile");
  assert.equal(deviceClass("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"), "tablet");
  for (const ua of ["Googlebot/2.1 (+http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; bingbot/2.0)", "curl/8.4.0", "python-requests/2.32", "Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1", "apc-deploy-smoke/1.0 (+https://github.com/tineira/agent-pointed-context, TIN-900)", "", null]) {
    assert.equal(deviceClass(ua), "bot", String(ua));
  }
});

test("the referrer is its host only, and nothing for non-web schemes", () => {
  assert.equal(referrerHost("https://GitHub.com/tineira/agent-pointed-context?tab=readme"), "github.com");
  assert.equal(referrerHost("http://localhost:5173/x"), "localhost", "no port");
  assert.equal(referrerHost("android-app://com.google.android.gm/"), "");
  assert.equal(referrerHost("not a url"), "");
  assert.equal(referrerHost(null), "");
});

test("a prefetch is told apart from a page load, and the country falls back to cf-ipcountry", () => {
  const request = new Request(`${ORIGIN}/build`, { headers: { "sec-purpose": "prefetch;prerender", "sec-fetch-dest": "document", "cf-ipcountry": "AR" } });
  assert.deepEqual(viewPoint(request, html()).blobs.slice(2), ["AR", "bot", "prefetch"]);
  const odd = new Request(`${ORIGIN}/build`, { headers: { "sec-fetch-dest": "anything-the-client-says" } });
  assert.equal(viewPoint(odd, html()).blobs[4], "other", "a client-chosen value is not stored as sent");
});

test("wrangler.jsonc runs the Worker first for every page path and binds SITE_VIEWS", () => {
  const config = JSON.parse(readFileSync(new URL("../../apps/site/wrangler.jsonc", import.meta.url), "utf8"));
  for (const path of ["/", "/try*", "/build*", "/docs*", "/media*"]) assert.ok(config.assets.run_worker_first.includes(path), path);
  assert.deepEqual(config.analytics_engine_datasets, [{ binding: "SITE_VIEWS", dataset: "apc_site_views" }]);
});
