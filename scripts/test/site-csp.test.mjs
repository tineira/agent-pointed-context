// The site's CSP (TIN-1013): one policy in csp.ts and _headers, and a checker that fails a built page carrying
// what the policy would block. The real built pages are checked in scripts/site-routes.mjs, after the build.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SITE_CSP } from "../../apps/site/src/worker/csp.ts";
import { cspViolations, headersFileCsp, inlineHash, scriptHashes } from "../lib/site-csp.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const page = (head, body = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test("the policy allows no inline or eval'd script, and frames, bases and plugins not at all", () => {
  const directives = Object.fromEntries(SITE_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
  assert.deepEqual(directives, {
    "default-src": "'self'",
    "script-src": "'self'",
    "style-src": "'self'",
    "img-src": "'self' data:",
    "media-src": "'self'",
    "font-src": "'self'",
    "connect-src": "'self'",
    "object-src": "'none'",
    "base-uri": "'none'",
    "frame-ancestors": "'none'",
    "form-action": "'self'",
  });
  assert.doesNotMatch(SITE_CSP, /unsafe-inline|unsafe-eval|unsafe-hashes|\*|https?:/);
});

test("_headers gives every asset the same policy as the Worker, and keeps X-Frame-Options", () => {
  const headers = read("apps/site/public/_headers");
  assert.equal(headersFileCsp(headers), SITE_CSP);
  assert.match(headers, /^\/\*\n(?:\s+.+\n)*\s+X-Frame-Options: DENY$/m);
});

test("the Worker's policy wins over whatever the asset answered (TIN-1036: Hono copies old headers on c.res =)", async () => {
  const { default: app } = await import("../../apps/site/src/worker/index.ts");
  const ASSETS = {
    fetch: async () =>
      new Response("<!doctype html><title>x</title>", {
        headers: { "content-type": "text/html", "content-security-policy": "default-src *", "x-frame-options": "SAMEORIGIN" },
      }),
  };
  for (const path of ["/docs/spec", "/media/a.mp4", "/"]) {
    const response = await app.fetch(new Request(`https://apc.tineira.com${path}`), { ASSETS });
    assert.equal(response.headers.get("content-security-policy"), SITE_CSP, path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
  }
});

test("the site's source page passes, and so does a page with only same-origin files", () => {
  assert.deepEqual(cspViolations(read("apps/site/index.html"), SITE_CSP), []);
  const clean = page(
    `<script type="module" crossorigin src="/site-assets/index.js"></script><link rel="stylesheet" href="/site-assets/index.css"><link rel="icon" href="/icon.svg">`,
    `<img src="data:image/png;base64,AAAA" alt=""><video src="/media/a.mp4"></video><a href="https://github.com/tineira">repo</a><pre><code>&lt;script&gt;alert(1)&lt;/script&gt; onclick="x"</code></pre>`,
  );
  assert.deepEqual(cspViolations(clean, SITE_CSP), []);
});

test("an inline script fails without its hash in script-src, and passes with it", () => {
  const code = "window.x = 1;";
  const html = page(`<script>${code}</script>`);
  const [violation, ...rest] = cspViolations(html, SITE_CSP);
  assert.match(violation, /inline <script> without a matching hash/);
  assert.deepEqual(rest, []);
  const hashed = SITE_CSP.replace("script-src 'self'", `script-src 'self' '${inlineHash(code)}'`);
  assert.deepEqual([...scriptHashes(hashed)], [inlineHash(code)]);
  assert.deepEqual(cspViolations(html, hashed), []);
  assert.equal(cspViolations(page(`<script>${code} </script>`), hashed).length, 1, "the hash covers the exact text only");
  assert.equal(cspViolations(page(`<script type="module"></script>`), SITE_CSP).length, 1, "even an empty inline script needs its hash");
});

test("handlers, javascript: URLs, inline styles and other origins fail", () => {
  const cases = [
    [`<button onclick="go()">x</button>`, /inline event handler onclick/],
    [`<body onload='go()'>`, /inline event handler onload/],
    [`<a href="javascript:alert(1)">x</a>`, /javascript: URL in href/],
    [`<a href=" JaVa&#x53;cript&colon;alert(1)">x</a>`, /javascript: URL in href/],
    [`<form action="javascript:void 0"></form>`, /javascript: URL in action/],
    [`<p style="color:red">x</p>`, /inline style attribute/],
    [`<style>p{}</style>`, /inline <style> element/],
    [`<script src="https://cdn.example/x.js"></script>`, /script from another origin/],
    [`<script src="//cdn.example/x.js"></script>`, /script from another origin/],
    [`<script src="/x.js">alert(1)</script>`, /also carries inline text/],
    [`<link rel="stylesheet" href="https://fonts.example/a.css">`, /<link rel="stylesheet"> from another origin/],
    [`<img src="https://img.example/a.png">`, /<img src> from another origin/],
    [`<video poster="https://img.example/a.jpg"></video>`, /<video poster> from another origin/],
    [`<iframe src="https://pulse.apc.tineira.com/"></iframe>`, /<iframe src> from another origin/],
    // TIN-1036: what the old regex missed. A "/" separates attributes as whitespace does.
    [`<svg/onload="go()"></svg>`, /inline event handler onload on <svg>/],
    [`<img src="/a.png"/onclick="go()">`, /inline event handler onclick on <img>/],
    [`<img src="/a.png" / onerror=go()>`, /inline event handler onerror on <img>/],
    [`<script/x>go()</script>`, /inline <script> without a matching hash/],
    [`<SCRIPT\nsrc="https://cdn.example/x.js"></SCRIPT>`, /script from another origin/],
    [`<script src="data:text/javascript,go()"></script>`, /script from another origin or scheme: data:/],
    [`<script src="https&#x3a;//cdn.example/x.js"></script>`, /script from another origin/],
    [`<script src="&#x2f;/cdn.example/x.js"></script>`, /script from another origin/],
    [`<script src="\\\\cdn.example/x.js"></script>`, /script from another origin/],
    [`<link rel="modulepreload" href="https://cdn.example/x.js">`, /<link rel="modulepreload"> from another origin/],
    [`<link rel="preload" as="font" href="//fonts.example/a.woff2">`, /<link rel="preload"> from another origin/],
    [`<link rel="icon" href="https://img.example/i.png">`, /<link rel="icon"> from another origin/],
    [`<img src="/a.png" srcset="/a.png 1x, https://img.example/b.png 2x">`, /<img srcset> from another origin: https:\/\/img\.example\/b\.png/],
    [`<picture><source srcset="https://img.example/b.webp"></picture>`, /<source srcset> from another origin/],
    [`<video src="data:video/mp4;base64,AAAA"></video>`, /<video src> from another origin: data:/],
    [`<base href="/">`, /<base> element/],
    [`<form action="https://collect.example/x"></form>`, /<form action> posts to another origin/],
    [`<button formaction="//collect.example/x">x</button>`, /<button formaction> posts to another origin/],
  ];
  for (const [body, pattern] of cases) {
    const found = cspViolations(page("", body), SITE_CSP);
    assert.equal(found.length, 1, `${body}: ${found.join(" | ")}`);
    assert.match(found[0], pattern, body);
  }
});

test("text that only looks like a tag is not one: comments, raw-text elements and escaped code", () => {
  const html = page(
    `<!-- <script>go()</script> --><title>a <script>go()</script> b</title><script src="/x.js"></script>`,
    `<textarea><img src=x onerror=go()></textarea><pre><code>&lt;svg/onload=go()&gt;</code></pre><p>a < b and a<3</p>` +
      `<img src="data:image/png;base64,AAAA" srcset="/a.png 1x, /b.png 2x" alt=""><link rel="alternate" href="https://example.com/feed">` +
      `<link rel="icon" href="data:image/png;base64,AAAA"><form action="/search"></form>`,
  );
  assert.deepEqual(cspViolations(html, SITE_CSP), []);
});

test("headersFileCsp reads only the /* rule", () => {
  assert.equal(headersFileCsp("/media/*\n  Content-Security-Policy: a\n/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: b\n"), "b");
  assert.equal(headersFileCsp("# comment\n/x\n  Content-Security-Policy: a\n"), null);
});
