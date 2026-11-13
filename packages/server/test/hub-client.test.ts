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
  assert.equal(hub.sent[0]!.init.redirect, "error");
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
  // A redirect under redirect: "error" throws in a real fetch.
  const redirecting = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.redirect === "error") throw new TypeError("unexpected redirect");
    return Response.json(ACK);
  }) as typeof fetch;
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: redirecting }), { ok: false, error: "hub_unreachable" });
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
  assert.equal(sent.sent[0]!.init.redirect, "error");
});
