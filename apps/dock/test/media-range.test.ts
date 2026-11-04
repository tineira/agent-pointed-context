/**
 * Byte ranges for the landing's clip (TIN-623): Safari and iOS play a `<video>` only from a server that answers
 * `Range` with `206`, and Workers static assets answer it with the whole file. /media/* runs the Worker first,
 * which cuts the range out of the asset.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Hono } from "hono";
import { ifRangeMatches, MAX_COUNTED, parseRange, sliceStream, withByteRanges } from "../src/worker/range.ts";

const ETAG = '"124963edbe64372348f02f396f07e851"';
const MODIFIED = "Tue, 03 Nov 2026 12:00:00 GMT";
const BODY = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);

/** The asset layer's answer for a 1000-byte video: the whole file, whatever the Range. */
function asset(method = "GET", init: { length?: boolean; headers?: Record<string, string>; status?: number } = {}): Response {
  const headers: Record<string, string> = { "content-type": "video/mp4", etag: ETAG, "last-modified": MODIFIED, "cache-control": "public, max-age=0, must-revalidate", ...init.headers };
  if (init.length !== false) headers["content-length"] = String(BODY.byteLength);
  return new Response(method === "HEAD" ? null : BODY.slice(), { status: init.status ?? 200, headers });
}
const get = (headers: Record<string, string> = {}, method = "GET") => new Request("https://apc.tineira.com/media/apc-hero.mp4", { method, headers });
const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

test("parseRange: one range, open-ended, suffix, and what is ignored", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", 1000), { start: 100, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 }, "a suffix longer than the file is the whole file");
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 }, "an end past the file is cut to it");
  assert.deepEqual(parseRange("bytes=999-999", 1000), { start: 999, end: 999 });
  assert.deepEqual(parseRange(" Bytes = 5 - 9 ", 1000), { start: 5, end: 9 });
  for (const ignored of [null, "items=0-1", "bytes=a-b", "bytes=-", "bytes=0-99,200-299", "bytes=0-1, 5-", "0-99", `bytes=0-${"9".repeat(30)}`]) {
    assert.equal(parseRange(ignored, 1000), null, String(ignored));
  }
});

test("parseRange: what cannot be satisfied", () => {
  for (const header of ["bytes=", "bytes=-0", "bytes=100-99", "bytes=1000-", "bytes=1000-1200", "bytes=5000-"]) {
    assert.equal(parseRange(header, 1000), "unsatisfiable", header);
  }
  for (const header of ["bytes=0-", "bytes=-10", "bytes=0-0"]) assert.equal(parseRange(header, 0), "unsatisfiable", `${header} on an empty file`);
});

test("ifRangeMatches: a strong ETag or the exact date; a weak ETag never", () => {
  const headers = new Headers({ etag: ETAG, "last-modified": MODIFIED });
  assert.equal(ifRangeMatches(null, headers), true);
  assert.equal(ifRangeMatches(ETAG, headers), true);
  assert.equal(ifRangeMatches(MODIFIED, headers), true);
  assert.equal(ifRangeMatches('"other"', headers), false);
  assert.equal(ifRangeMatches(`W/${ETAG}`, headers), false);
  assert.equal(ifRangeMatches("Wed, 04 Nov 2026 12:00:00 GMT", headers), false);
  assert.equal(ifRangeMatches(MODIFIED, new Headers({ etag: ETAG })), false, "no Last-Modified to match");
});

test("a range is answered 206 with Content-Range, Content-Length and the asset's own headers", async () => {
  for (const [range, start, end] of [["bytes=0-99", 0, 99], ["bytes=100-", 100, 999], ["bytes=-100", 900, 999]] as const) {
    const r = await withByteRanges(get({ range }), asset());
    assert.equal(r.status, 206, range);
    assert.equal(r.headers.get("content-range"), `bytes ${start}-${end}/1000`, range);
    assert.equal(r.headers.get("content-length"), String(end - start + 1), range);
    assert.equal(r.headers.get("accept-ranges"), "bytes", range);
    assert.equal(r.headers.get("content-type"), "video/mp4", range);
    assert.equal(r.headers.get("etag"), ETAG, range);
    assert.equal(r.headers.get("last-modified"), MODIFIED, range);
    assert.equal(r.headers.get("cache-control"), "public, max-age=0, must-revalidate", range);
    assert.deepEqual(await bytes(r), BODY.slice(start, end + 1), range);
  }
});

test("no Range, several ranges, or a Range that cannot be parsed: the whole file, 200, Accept-Ranges", async () => {
  for (const headers of [{}, { range: "bytes=0-9,20-29" }, { range: "bytes=x-y" }, { range: "lines=1-2" }] as Record<string, string>[]) {
    const r = await withByteRanges(get(headers), asset());
    assert.equal(r.status, 200, JSON.stringify(headers));
    assert.equal(r.headers.get("accept-ranges"), "bytes");
    assert.equal(r.headers.get("content-range"), null);
    assert.equal(r.headers.get("etag"), ETAG);
    assert.deepEqual(await bytes(r), BODY);
  }
});

test("a range past the end is 416 with Content-Range: bytes */size and no body", async () => {
  for (const range of ["bytes=1000-", "bytes=2000-3000", "bytes=-0", "bytes=50-10"]) {
    const r = await withByteRanges(get({ range }), asset());
    assert.equal(r.status, 416, range);
    assert.equal(r.headers.get("content-range"), "bytes */1000", range);
    assert.equal(r.headers.get("content-length"), "0", range);
    assert.equal(r.headers.get("accept-ranges"), "bytes", range);
    assert.equal((await bytes(r)).byteLength, 0, range);
  }
});

test("HEAD says the same as GET, without a body, whether the asset answered a HEAD or a GET", async () => {
  for (const method of ["HEAD", "GET"]) {
    const ranged = await withByteRanges(get({ range: "bytes=100-199" }, "HEAD"), asset(method));
    assert.equal(ranged.status, 206, method);
    assert.equal(ranged.headers.get("content-range"), "bytes 100-199/1000", method);
    assert.equal(ranged.headers.get("content-length"), "100", method);
    assert.equal(ranged.body, null, method);
    const whole = await withByteRanges(get({}, "HEAD"), asset(method));
    assert.equal(whole.status, 200, method);
    assert.equal(whole.headers.get("accept-ranges"), "bytes", method);
    assert.equal(whole.headers.get("content-length"), "1000", method);
    assert.equal(whole.body, null, method);
    const beyond = await withByteRanges(get({ range: "bytes=1000-" }, "HEAD"), asset(method));
    assert.equal(beyond.status, 416, method);
    assert.equal(beyond.headers.get("content-range"), "bytes */1000", method);
  }
  // The asset layer's own HEAD has no Content-Length: with nothing to count, the HEAD says only what it said.
  const unsized = await withByteRanges(get({ range: "bytes=0-9" }, "HEAD"), asset("HEAD", { length: false }));
  assert.equal(unsized.status, 200);
  assert.equal(unsized.headers.get("accept-ranges"), "bytes");
  assert.equal(unsized.headers.get("content-range"), null);
});

test("If-Range: a match keeps the range, a mismatch sends the whole file", async () => {
  for (const ifRange of [ETAG, MODIFIED]) {
    const r = await withByteRanges(get({ range: "bytes=0-9", "if-range": ifRange }), asset());
    assert.equal(r.status, 206, ifRange);
    assert.deepEqual(await bytes(r), BODY.slice(0, 10));
  }
  for (const ifRange of ['"stale"', `W/${ETAG}`, "Mon, 02 Nov 2026 12:00:00 GMT"]) {
    const r = await withByteRanges(get({ range: "bytes=0-9", "if-range": ifRange }), asset());
    assert.equal(r.status, 200, ifRange);
    assert.equal(r.headers.get("content-range"), null, ifRange);
    assert.deepEqual(await bytes(r), BODY);
  }
});

test("without a Content-Length the body is counted; the asset's other answers pass through untouched", async () => {
  const counted = await withByteRanges(get({ range: "bytes=-10" }), asset("GET", { length: false }));
  assert.equal(counted.status, 206);
  assert.equal(counted.headers.get("content-range"), "bytes 990-999/1000");
  assert.deepEqual(await bytes(counted), BODY.slice(990));
  // A 304 for If-None-Match (the asset layer's own), a 404, the SPA's HTML for a missing file, a compressed body.
  const notModified = new Response(null, { status: 304, headers: { etag: ETAG } });
  assert.equal(await withByteRanges(get({ range: "bytes=0-9", "if-none-match": ETAG }), notModified), notModified);
  const missing = new Response("not found", { status: 404 });
  assert.equal(await withByteRanges(get({ range: "bytes=0-9" }), missing), missing);
  const spa = new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  assert.equal(await withByteRanges(get({ range: "bytes=0-9" }), spa), spa);
  const gzipped = asset("GET", { headers: { "content-encoding": "gzip" } });
  assert.equal(await withByteRanges(get({ range: "bytes=0-9" }), gzipped), gzipped);
});

test("a HEAD that passes through has no body, and the GET the Worker made for it is cancelled", async () => {
  const notFound = synthetic(10_000);
  const missing = await withByteRanges(get({ range: "bytes=0-9" }, "HEAD"), new Response(notFound.stream, { status: 404, statusText: "Not Found", headers: { "x-kept": "yes" } }));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-kept"), "yes");
  assert.equal(missing.body, null);
  assert.equal(notFound.cancelled(), true);
  const spa = synthetic(10_000);
  const html = await withByteRanges(get({}, "HEAD"), new Response(spa.stream, { headers: { "content-type": "text/html" } }));
  assert.equal(html.status, 200);
  assert.equal(html.body, null);
  assert.equal(spa.cancelled(), true);
});

/** A body of `size` bytes, made as it is read (byte i is i % 251), that says how far it was read and whether it was cancelled. */
function synthetic(size: number, chunk = 64 * 1024) {
  let sent = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      const n = Math.min(chunk, size - sent);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (sent + i) % 251;
      sent += n;
      controller.enqueue(out);
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, read: () => sent, cancelled: () => cancelled };
}
const expected = (from: number, to: number) => Uint8Array.from({ length: to - from }, (_, i) => (from + i) % 251);

test("sliceStream skips to the range, stops at its end, and cancels the rest of the source", async () => {
  for (const [from, to] of [[0, 10], [5, 70], [63, 64], [64, 128], [100, 300], [290, 300]] as const) {
    const source = synthetic(300, 64);
    const out = new Uint8Array(await new Response(sliceStream(source.stream, from, to)).arrayBuffer());
    assert.deepEqual(out, expected(from, to), `${from}-${to}`);
    assert.ok(source.read() < to + 64, `${from}-${to} read no further than the chunk holding its end`);
    if (to < 300) assert.equal(source.cancelled(), true, `${from}-${to} cancelled the rest`);
  }
});

test("a large file with a Content-Length: the range is streamed, never the whole file held or read", async () => {
  const size = 48 * 1024 * 1024;
  const source = synthetic(size);
  const big = new Response(source.stream, { headers: { "content-type": "video/mp4", "content-length": String(size) } });
  const from = 20 * 1024 * 1024 + 7;
  const r = await withByteRanges(get({ range: `bytes=${from}-${from + 999}` }), big);
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes ${from}-${from + 999}/${size}`);
  assert.equal(r.headers.get("content-length"), "1000");
  assert.deepEqual(await bytes(r), expected(from, from + 1000));
  assert.ok(source.read() < from + 1000 + 64 * 1024, "nothing past the range is read");
  assert.equal(source.cancelled(), true);
});

test("a file with no Content-Length over the counting limit is sent whole, 200, without Accept-Ranges", async () => {
  const unsized = (size: number) => {
    const source = synthetic(size, 256);
    return { source, response: new Response(source.stream, { headers: { "content-type": "video/mp4", etag: ETAG } }) };
  };
  const over = unsized(5000);
  const whole = await withByteRanges(get({ range: "bytes=0-9" }), over.response, 1000);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), null);
  assert.equal(whole.headers.get("content-range"), null);
  assert.equal(whole.headers.get("etag"), ETAG);
  assert.deepEqual(await bytes(whole), expected(0, 5000), "the bytes read to count come first, then the rest");
  const head = unsized(5000);
  const headOver = await withByteRanges(get({ range: "bytes=0-9" }, "HEAD"), head.response, 1000);
  assert.equal(headOver.status, 200);
  assert.equal(headOver.headers.get("accept-ranges"), null);
  assert.equal(headOver.body, null);
  assert.equal(head.source.cancelled(), true);
  assert.ok(head.source.read() <= 1000 + 256, "a HEAD stops counting at the limit");
  // Under the limit, the counted body is sliced as before.
  const under = await withByteRanges(get({ range: "bytes=4990-" }), unsized(5000).response, 10_000);
  assert.equal(under.status, 206);
  assert.equal(under.headers.get("content-range"), "bytes 4990-4999/5000");
  assert.deepEqual(await bytes(under), expected(4990, 5000));
  assert.equal(MAX_COUNTED, 16 * 1024 * 1024);
});

// The Worker itself: Node has no Workers runtime; importing the app must not construct a Durable Object.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const app: Hono = await import(new URL("../src/worker/index.ts", import.meta.url).href).then((m) => m.default).finally(() => hooks.deregister());

test("the Worker answers /media/apc-hero.mp4 with byte ranges, and the clip runs the Worker first", async () => {
  const mp4 = new Uint8Array(readFileSync(new URL("../public/media/apc-hero.mp4", import.meta.url)));
  const size = mp4.byteLength;
  // What Workers static assets do with a Range: ignore it.
  const env = {
    ASSETS: {
      fetch: async (req: Request) => {
        assert.equal(new URL(req.url).pathname, "/media/apc-hero.mp4");
        // Its HEAD has no Content-Length: the Worker asks with GET, even for a HEAD.
        assert.equal(req.method, "GET");
        return new Response(mp4, { headers: { "content-type": "video/mp4", "content-length": String(size), etag: ETAG } });
      },
    },
  };
  const url = "https://apc.tineira.com/media/apc-hero.mp4";
  const cases = [["bytes=0-99", 0, 99], ["bytes=100-", 100, size - 1], ["bytes=-100", size - 100, size - 1]] as const;
  for (const [range, start, end] of cases) {
    const r = await app.request(url, { headers: { range } }, env);
    assert.equal(r.status, 206, range);
    assert.equal(r.headers.get("content-range"), `bytes ${start}-${end}/${size}`, range);
    assert.equal(r.headers.get("content-length"), String(end - start + 1), range);
    assert.equal(r.headers.get("content-type"), "video/mp4", range);
    assert.equal(r.headers.get("etag"), ETAG, range);
    assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'none'", "still never framed");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), mp4.slice(start, end + 1), range);
  }
  const beyond = await app.request(url, { headers: { range: `bytes=${size}-` } }, env);
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), `bytes */${size}`);
  const whole = await app.request(url, {}, env);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal((await whole.arrayBuffer()).byteLength, size);
  const head = await app.request(url, { method: "HEAD", headers: { range: "bytes=0-1" } }, env);
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("content-range"), `bytes 0-1/${size}`);
  assert.equal(head.headers.get("content-length"), "2");
  assert.equal(head.body, null);

  // Without run_worker_first the asset layer would serve /media/* itself, and ignore the Range.
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const first = JSON.parse(wrangler.match(/"run_worker_first":\s*(\[[^\]]*\])/)![1]!) as string[];
  assert.ok(first.includes("/media/*") && first.includes("/media"), "/media and /media/* run the Worker first");
});
