/**
 * An app's calls to a dock's hub fail closed (APC 0.9, TIN-859): a grant is kept only on a non-redirected
 * HTTP 200 with the acknowledgement; a hub's own 400 refusal is passed on; anything else is a refusal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmWithHub, pairWithHub } from "../src/index.ts";

const HUB = "https://dock.test";
const BODY = { ticket: "t".repeat(40), agent: "ag_1", app: { name: "Orders", origin: "https://orders.test" }, mcp_url: "https://orders.test/mcp/abc", pairing_code: "K7M4P2" };
const ACK = { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Claude via dock", icon: null }, pairing_code: "required" };

/** A hub that answers one way, and what the app sent it. */
function hubAnswering(answer: (init: RequestInit) => Response | Promise<Response>) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return answer(init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

test("the acknowledgement on a 200 pairs; the call never follows a redirect and carries the code in the body only", async () => {
  const hub = hubAnswering(() => Response.json(ACK));
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hub.fetch }), { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Claude via dock", icon: null } });
  assert.equal(hub.sent[0]!.url, `${HUB}/apc/pair`);
  assert.equal(hub.sent[0]!.init.redirect, "manual");
  assert.ok(hub.sent[0]!.init.signal, "a time limit");
  assert.equal(JSON.parse(String(hub.sent[0]!.init.body)).pairing_code, "K7M4P2");
});

test("every answer but the acknowledgement on a 200 is a refusal", async () => {
  const followed = () => {
    const r = Response.json(ACK);
    Object.defineProperty(r, "redirected", { value: true });
    return r;
  };
  const cases: Array<[string, () => Response | Promise<Response>, string]> = [
    ["a 200 with no acknowledgement (a hub from before 0.9)", () => Response.json({ ...ACK, pairing_code: undefined }), "hub_ignores_pairing_code"],
    ["a 200 with pairing_code: true", () => Response.json({ ...ACK, pairing_code: true }), "hub_ignores_pairing_code"],
    ["a 200 with no pairing_id", () => Response.json({ ...ACK, pairing_id: undefined }), "hub_refused"],
    ["a 500 that says ok: true", () => Response.json(ACK, { status: 500 }), "hub_refused"],
    ["a 201 with the acknowledgement", () => Response.json(ACK, { status: 201 }), "hub_refused"],
    ["a redirect given back as is", () => new Response(null, { status: 307, headers: { location: "https://evil.test/apc/pair" } }), "hub_refused"],
    ["a redirect the fetch followed anyway", followed, "hub_refused"],
    ["bad JSON on a 200", () => new Response("not json", { status: 200 }), "hub_refused"],
    ["an array", () => Response.json([ACK]), "hub_refused"],
    ["a 400 whose error is not the hub's word", () => Response.json({ ok: false, error: "<script>" }, { status: 400 }), "hub_refused"],
    ["a 400 that says ok: true", () => Response.json(ACK, { status: 400 }), "hub_refused"],
  ];
  for (const [what, answer, error] of cases) {
    assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(answer).fetch }), { ok: false, error }, what);
  }
});

test("a hub's own 400 refusal is passed on; no answer is hub_unreachable", async () => {
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => Response.json({ ok: false, error: "ticket_expired" }, { status: 400 })).fetch }), { ok: false, error: "ticket_expired" });
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: down }), { ok: false, error: "hub_unreachable" });
  // A runtime that refuses the call before sending it (any thrown fetch) is no answer.
  const refusing = (async () => {
    throw new TypeError("unexpected redirect");
  }) as typeof fetch;
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: refusing }), { ok: false, error: "hub_unreachable" });
  // The time limit.
  const slow = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: slow, timeoutMs: 20 }), { ok: false, error: "hub_unreachable" });
});

test("a confirm is believed on a 200 with ok and a known status only", async () => {
  const confirm = { ticket: BODY.ticket, agent: "ag_1", mcp_url: BODY.mcp_url };
  assert.deepEqual(await confirmWithHub(HUB, confirm, { fetch: hubAnswering(() => Response.json({ ok: true, status: "paired", agent: { name: "A", icon: "data:x" } })).fetch }), { ok: true, status: "paired", agent: { name: "A", icon: "data:x" } });
  assert.deepEqual(await confirmWithHub(HUB, confirm, { fetch: hubAnswering(() => Response.json({ ok: true, status: "pending" })).fetch }), { ok: true, status: "pending", agent: { name: null, icon: null } });
  assert.deepEqual(await confirmWithHub(HUB, confirm, { fetch: hubAnswering(() => Response.json({ ok: false, error: "not_paired" }, { status: 400 })).fetch }), { ok: false, error: "not_paired" });
  assert.deepEqual(await confirmWithHub(HUB, confirm, { fetch: hubAnswering(() => Response.json({ ok: true, status: "revoked" })).fetch }), { ok: false, error: "hub_refused" });
  assert.deepEqual(await confirmWithHub(HUB, confirm, { fetch: hubAnswering(() => Response.json({ ok: true, status: "paired" }, { status: 500 })).fetch }), { ok: false, error: "hub_refused" });
  const sent = hubAnswering(() => Response.json({ ok: true, status: "paired" }));
  await confirmWithHub(HUB, confirm, { fetch: sent.fetch });
  assert.equal(sent.sent[0]!.url, `${HUB}/apc/confirm`);
  assert.equal(sent.sent[0]!.init.redirect, "manual");
});

// #region APC 0.10: M2, M3, M4 and M9 on the hub call (TIN-883)

/** A body that hands out `chunks` one read at a time and counts the reads; `hang` keeps it open after them. */
function streamed(chunks: string[], o: { hang?: boolean } = {}) {
  const state = { pulls: 0, cancelled: false };
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls++;
        const next = chunks.shift();
        if (next !== undefined) controller.enqueue(encoder.encode(next));
        else if (!o.hang) controller.close();
        else return new Promise(() => {});
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

const ackText = JSON.stringify(ACK);
const CONFIRM = { ticket: BODY.ticket, agent: "ag_1", mcp_url: BODY.mcp_url };

test("M9: the call goes to the parsed origin, never the raw string; a hub that is not a bare origin sends nothing", async () => {
  const slash = hubAnswering(() => Response.json(ACK));
  assert.equal((await pairWithHub(`${HUB}/`, BODY, { fetch: slash.fetch })).ok, true);
  assert.equal(slash.sent[0]!.url, `${HUB}/apc/pair`, "no //apc/pair");
  const asUrl = hubAnswering(() => Response.json(ACK));
  assert.equal((await pairWithHub(new URL(HUB), BODY, { fetch: asUrl.fetch })).ok, true);
  assert.equal(asUrl.sent[0]!.url, `${HUB}/apc/pair`);
  const port = hubAnswering(() => Response.json(ACK));
  assert.equal((await pairWithHub("https://dock.test:8443", BODY, { fetch: port.fetch })).ok, true);
  assert.equal(port.sent[0]!.url, "https://dock.test:8443/apc/pair", "a port of its own is part of the origin");
  // Anything new URL would normalize away is refused, as parseDockDrop refuses it (the bare-origin rule).
  for (const hub of ["https://dock.test/.", "https://dock.test/..", "https://dock.test/./", "https://dock.test/%2e", "https://dock.\x00test", "https://dock.test\x00", "https://dock.test\t", "https://dock.test:443", "HTTPS://DOCK.TEST", "https://dock.test//"]) {
    const hubFor = hubAnswering(() => Response.json(ACK));
    assert.deepEqual(await pairWithHub(hub, BODY, { fetch: hubFor.fetch }), { ok: false, error: "hub_not_allowed" }, JSON.stringify(hub));
    assert.equal(hubFor.sent.length, 0);
  }
  // http: only on a loopback host (local development): the secret URL and the code never go out in clear text.
  for (const hub of ["http://dock.test", "http://apc.tineira.com", "http://10.0.0.1:8787", "http://[::1]:8787", "http://localhost.evil.example"]) {
    const hubFor = hubAnswering(() => Response.json(ACK));
    assert.deepEqual(await pairWithHub(hub, BODY, { fetch: hubFor.fetch }), { ok: false, error: "hub_not_allowed" }, hub);
    assert.equal(hubFor.sent.length, 0, `nothing sent in clear text to ${hub}`);
  }
  for (const hub of ["http://localhost:8787", "http://127.0.0.1:8787", "http://dock.localhost:8787"]) {
    const hubFor = hubAnswering(() => Response.json(ACK));
    assert.equal((await pairWithHub(hub, BODY, { fetch: hubFor.fetch })).ok, true, hub);
    assert.equal(hubFor.sent[0]!.url, `${hub}/apc/pair`);
  }
  for (const hub of ["https://dock.test/x", "https://dock.test/apc", "https://u:p@dock.test", "https://@dock.test", "https://dock.test?x=1", "https://dock.test#f", "https:\\\\dock.test", "dock.test", "not a url", "", "ftp://dock.test", "javascript:alert(1)", "https://dock.test/ "]) {
    const hubFor = hubAnswering(() => Response.json(ACK));
    assert.deepEqual(await pairWithHub(hub, BODY, { fetch: hubFor.fetch }), { ok: false, error: "hub_not_allowed" }, hub);
    assert.deepEqual(await confirmWithHub(hub, CONFIRM, { fetch: hubFor.fetch }), { ok: false, error: "hub_not_allowed" }, hub);
    assert.equal(hubFor.sent.length, 0, `nothing sent to ${hub}`);
  }
});

test("M4: a content-length that is not digits, or is over 8 KiB, is refused before a byte is read", async () => {
  for (const declared of ["8193", "99999999999999999999", "", "abc", "-1", "1e3", "0x10", "10, 10", "+10"]) {
    const { body, state } = streamed([ackText]);
    const hub = hubAnswering(() => new Response(body, { status: 200, headers: { "content-length": declared } }));
    assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hub.fetch }), { ok: false, error: "hub_refused" }, JSON.stringify(declared));
    assert.equal(state.pulls, 0, `nothing read for content-length ${JSON.stringify(declared)}`);
  }
  // The hub's own 400 is capped the same way.
  const refusing = hubAnswering(() => new Response(JSON.stringify({ ok: false, error: "ticket_expired" }), { status: 400, headers: { "content-length": "9000" } }));
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: refusing.fetch }), { ok: false, error: "hub_refused" });
});

test("M4: a lying content-length is never compared; the decoded stream is what is cut at the cap", async () => {
  // Says less than it sends (as with gzip, where it is the compressed length), all of it under the cap: fine.
  const low = streamed([ackText.slice(0, 20), ackText.slice(20)]);
  assert.equal((await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(low.body, { headers: { "content-length": "5", "content-encoding": "gzip" } })).fetch })).ok, true);
  // Says more than it sends, under the cap: fine.
  const high = streamed([ackText]);
  assert.equal((await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(high.body, { headers: { "content-length": "8192" } })).fetch })).ok, true);
  // Says little and sends past the cap: cut, and the rest is never read.
  const big = streamed([`{"pad":"${"x".repeat(5000)}`, "x".repeat(5000), "x".repeat(5000), `","ok":true}`]);
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(big.body, { headers: { "content-length": "100" } })).fetch }), { ok: false, error: "hub_refused" });
  assert.equal(big.state.cancelled, true, "the stream is cancelled at the cap");
  assert.ok(big.state.pulls <= 3, `read ${big.state.pulls} chunks, not all four`);
  // The cap itself: exactly 8192 bytes is read, 8193 is not.
  const exact = JSON.stringify({ ...ACK, pad: "" });
  const at = JSON.stringify({ ...ACK, pad: "x".repeat(8192 - exact.length) });
  assert.equal(new TextEncoder().encode(at).length, 8192);
  assert.equal((await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(at)).fetch })).ok, true, "8192 bytes");
  const over = JSON.stringify({ ...ACK, pad: "x".repeat(8193 - exact.length) });
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(over)).fetch }), { ok: false, error: "hub_refused" }, "8193 bytes");
});

test("M4: an absent content-length (chunked) is not refused, and is still capped", async () => {
  const chunks = streamed([ackText.slice(0, 10), ackText.slice(10, 30), ackText.slice(30)]);
  const response = new Response(chunks.body);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal((await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => response).fetch })).ok, true);
  const endless = streamed(Array.from({ length: 50 }, () => "x".repeat(1000)));
  assert.deepEqual(await confirmWithHub(HUB, CONFIRM, { fetch: hubAnswering(() => new Response(endless.body)).fetch }), { ok: false, error: "hub_refused" });
  assert.ok(endless.state.pulls <= 10, `stopped after ${endless.state.pulls} reads`);
});

test("M3: one deadline covers the headers and the whole body; a slow body is hub_unreachable", async () => {
  const slowBody = streamed(['{"ok":true,'], { hang: true });
  const started = Date.now();
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(slowBody.body)).fetch, timeoutMs: 50 }), { ok: false, error: "hub_unreachable" });
  assert.ok(Date.now() - started < 2000, "the deadline, not the body, ended it");
  assert.equal(slowBody.state.cancelled, true, "the body is cancelled");
  // The headers and the body share the one deadline: headers that take most of it leave the body the rest.
  const late = (() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(streamed(['{"ok":'], { hang: true }).body)), 30))) as typeof fetch;
  const before = Date.now();
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: late, timeoutMs: 60 }), { ok: false, error: "hub_unreachable" });
  assert.ok(Date.now() - before < 1000);
  // A fetch that ignores the signal is still cut off by the deadline.
  const deaf = (() => new Promise<Response>(() => {})) as typeof fetch;
  assert.deepEqual(await confirmWithHub(HUB, CONFIRM, { fetch: deaf, timeoutMs: 20 }), { ok: false, error: "hub_unreachable" });
  // The signal handed to fetch is aborted at the deadline.
  let signal: AbortSignal | undefined;
  const watching = ((_url: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  await pairWithHub(HUB, BODY, { fetch: watching, timeoutMs: 20 });
  assert.equal(signal?.aborted, true);
});

test("M2: a redirect in any form is refused, and its body is not read", async () => {
  for (const status of [300, 301, 302, 303, 307, 308]) {
    const { body, state } = streamed([ackText]);
    assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(body, { status, headers: { location: "https://evil.test/apc/pair" } })).fetch }), { ok: false, error: "hub_refused" }, String(status));
    assert.equal(state.pulls, 0);
  }
  const opaque = () => {
    const r = new Response(null, { status: 200 });
    Object.defineProperty(r, "type", { value: "opaqueredirect" });
    return r;
  };
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(opaque).fetch }), { ok: false, error: "hub_refused" });
  const followed = () => {
    const r = Response.json({ ok: true, status: "paired" });
    Object.defineProperty(r, "redirected", { value: true });
    return r;
  };
  assert.deepEqual(await confirmWithHub(HUB, CONFIRM, { fetch: hubAnswering(followed).fetch }), { ok: false, error: "hub_refused" });
  // Any status but 200 and 400: refused, the body never read.
  const { body, state } = streamed([ackText]);
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(body, { status: 500 })).fetch }), { ok: false, error: "hub_refused" });
  assert.equal(state.pulls, 0);
});

test("a body that is not UTF-8, or is empty, is not an answer", async () => {
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]))).fetch }), { ok: false, error: "hub_refused" });
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response(null)).fetch }), { ok: false, error: "hub_refused" });
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: hubAnswering(() => new Response("", { headers: { "content-length": "0" } })).fetch }), { ok: false, error: "hub_refused" });
});

test("against a real HTTP server: gzip is decoded and capped, a slow body hits the deadline, a redirect is refused", async () => {
  const { createServer } = await import("node:http");
  const { gzipSync } = await import("node:zlib");
  const padded = JSON.stringify({ ...ACK, pad: "x".repeat(6000) });
  const bomb = JSON.stringify({ ok: true, status: "paired", pad: "x".repeat(200_000) });
  const gzipping = createServer((req, res) => {
    req.resume();
    const zipped = gzipSync(req.url === "/apc/pair" ? padded : bomb);
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(zipped.length) });
    res.end(zipped);
  });
  const slow = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"ok":true,');
  });
  const redirecting = createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: "https://evil.test/apc/pair" });
    res.end();
  });
  const servers = [gzipping, slow, redirecting];
  const listen = (s: (typeof servers)[number]) => new Promise<string>((resolve) => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
  const [gz, slowHub, redirectHub] = [await listen(gzipping), await listen(slow), await listen(redirecting)];
  try {
    assert.ok(gzipSync(padded).length < 300, "small on the wire");
    assert.equal((await pairWithHub(gz!, BODY)).ok, true, "a gzip answer under the cap once decoded, its content-length the compressed one");
    assert.deepEqual(await confirmWithHub(gz!, CONFIRM), { ok: false, error: "hub_refused" }, "a gzip bomb: small on the wire, cut at 8 KiB decoded");
    const started = Date.now();
    assert.deepEqual(await pairWithHub(slowHub!, BODY, { timeoutMs: 200 }), { ok: false, error: "hub_unreachable" }, "headers in time, the body never ends");
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(await pairWithHub(redirectHub!, BODY), { ok: false, error: "hub_refused" }, "redirect: manual hands the 307 back, and it is refused");
  } finally {
    for (const s of servers) s.closeAllConnections();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  }
});

// #endregion

// Cloudflare Workers does not implement redirect: "error": `fetch` throws a TypeError before anything is sent
// (developers.cloudflare.com/workers/runtime-apis/request). This fetch behaves like the Workers runtime, so a hub
// call that asked for "error" never reached the dock in production (APC 0.11.1). "manual" hands the 3xx back,
// and the client refuses it (M2).
function workersFetch(answer: () => Response) {
  const sent: RequestInit[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const mode = init?.redirect ?? "follow";
    if (mode !== "follow" && mode !== "manual") {
      throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual" ("error" won't be implemented since it does not make sense at the edge; use "manual" and check the response status code).`);
    }
    sent.push(init ?? {});
    return answer();
  }) as typeof fetch;
  return { fetch: f, sent };
}

test("on the Workers runtime the hub call is sent, never follows a redirect, and refuses the 3xx (M2)", async () => {
  const ok = workersFetch(() => Response.json(ACK));
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: ok.fetch }), { ok: true, pairing_id: ACK.pairing_id, status: "pending", agent: ACK.agent });
  assert.equal(ok.sent.length, 1, "the pairing was sent");
  assert.equal(ok.sent[0]!.redirect, "manual", "redirects are never followed");
  const confirm = { ticket: BODY.ticket, agent: "ag_1", mcp_url: BODY.mcp_url };
  const okConfirm = workersFetch(() => Response.json({ ok: true, status: "paired", agent: { name: "A", icon: null } }));
  assert.equal((await confirmWithHub(HUB, confirm, { fetch: okConfirm.fetch })).ok, true, "the confirm was sent");
  assert.equal(okConfirm.sent[0]!.redirect, "manual");
  const moved = workersFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/apc/pair" } }));
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: moved.fetch }), { ok: false, error: "hub_refused" });
  assert.deepEqual(await confirmWithHub(HUB, confirm, { fetch: moved.fetch }), { ok: false, error: "hub_refused" });
});
