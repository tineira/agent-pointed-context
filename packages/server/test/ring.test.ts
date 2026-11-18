/**
 * The doorbell (TIN-962, experimental): the hub's ring address is believed only on the hub's own origin and path, a
 * ring is signed with the grant's ring key, and a ring goes out with the hub calls' hardening and never throws.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmWithHub, pairWithHub, parseRing, RING_NONCE, RING_SIG, ringBody, ringHub, ringKey, ringSignature } from "../src/index.ts";

const HUB = "https://dock.test";
const DID = "a".repeat(32);
const RING = { url: `${HUB}/apc/ring/${DID}`, id: "pr_0123456789abcdef" };
const ACK = { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Grok bot via dock", icon: null }, pairing_code: "required" };
const BODY = { ticket: "t".repeat(40), agent: "ag_1", app: { name: "Orders", origin: "https://orders.test" }, mcp_url: "https://orders.test/mcp/abc", pairing_code: "K7M4P2" };

test("a ring address is believed only on the hub's own origin, at /apc/ring/<32 hex>, with a plain id", () => {
  assert.deepEqual(parseRing(HUB, RING), RING);
  for (const raw of [
    { ...RING, url: `https://evil.test/apc/ring/${DID}` },
    { ...RING, url: `${HUB}/apc/ring/${DID}?x=1` },
    { ...RING, url: `${HUB}/apc/ring/${DID}#x` },
    { ...RING, url: `${HUB}/apc/ring/xyz` },
    { ...RING, url: `${HUB}/apc/pair` },
    { ...RING, url: `https://user@dock.test/apc/ring/${DID}` },
    { ...RING, url: `${HUB}//apc/ring/${DID}` },
    { ...RING, id: "pr|1" },
    { ...RING, id: "" },
    { url: RING.url },
    null,
    "ring",
  ]) {
    assert.equal(parseRing(HUB, raw), null, JSON.stringify(raw));
  }
  assert.equal(parseRing(null, RING), null);
});

test("pair and confirm pass a good ring address on, leave a bad one out, and refuse nothing for it", async () => {
  const answering = (body: unknown) => (async () => Response.json(body)) as typeof fetch;
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: answering({ ...ACK, ring: RING }) }), { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Grok bot via dock", icon: null }, binding: null, ring: RING });
  assert.deepEqual(await pairWithHub(HUB, BODY, { fetch: answering({ ...ACK, ring: { ...RING, url: "https://evil.test/x" } }) }), { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Grok bot via dock", icon: null }, binding: null });
  const confirmed = { ok: true, status: "paired", agent: { name: "Grok bot via dock", icon: null } };
  assert.deepEqual(await confirmWithHub(HUB, { ticket: "t", agent: "ag_1", mcp_url: "u" }, { fetch: answering({ ...confirmed, ring: RING }) }), { ...confirmed, ring: RING });
  assert.deepEqual(await confirmWithHub(HUB, { ticket: "t", agent: "ag_1", mcp_url: "u" }, { fetch: answering(confirmed) }), confirmed);
});

test("the ring key is SHA-256 of the exact MCP URL, and the signature covers the id, the time and the nonce", async () => {
  const key = await ringKey("https://orders.test/mcp/abc");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(await ringKey("https://orders.test/mcp/abc/"), key);
  const body = await ringBody(RING, key, 1_700_000_000_000);
  assert.deepEqual(Object.keys(body).sort(), ["at", "id", "n", "sig"]);
  assert.match(body.n, RING_NONCE);
  assert.match(body.sig, RING_SIG);
  assert.equal(body.sig, await ringSignature(key, RING.id, body.at, body.n));
  assert.notEqual(body.sig, await ringSignature(key, RING.id, body.at + 1, body.n));
  assert.notEqual(body.sig, await ringSignature(key, "pr_other", body.at, body.n));
  assert.notEqual(body.n, (await ringBody(RING, key)).n);
  await assert.rejects(ringSignature("nothex", RING.id, 1, body.n));
});

test("a ring goes to the address only, without following redirects, and never throws", async () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  const key = await ringKey("https://orders.test/mcp/abc");
  await ringHub(RING, key, { fetch });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, RING.url);
  assert.equal(sent[0]!.init.redirect, "manual");
  assert.deepEqual(Object.keys(JSON.parse(String(sent[0]!.init.body))).sort(), ["at", "id", "n", "sig"]);

  // A bad address or key sends nothing; a failing hub throws nothing.
  await ringHub({ ...RING, url: "https://evil.test/apc/ring/x" }, key, { fetch });
  await ringHub(RING, "nothex", { fetch });
  assert.equal(sent.length, 1);
  await ringHub(RING, key, { fetch: (async () => { throw new Error("down"); }) as typeof globalThis.fetch });
});
