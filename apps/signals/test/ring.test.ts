/**
 * Signals rings its hub after a pin (TIN-962, experimental): it keeps the ring address the hub gave it, keyed with
 * SHA-256 of the exact MCP URL it sent, and each pin on that dock grant sends a ring the hub can verify.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { ringKey, ringSignature } from "@tineira/apc-server";
import { demoMarket } from "../../demo/src/model/demo-world.ts";
import { HUB, SID } from "../../demo/test/dock-lifecycle.ts";

installWorkersStandIn();
const { Feed } = await import(new URL("../src/worker/feed.ts", import.meta.url).href);

const ORIGIN = "https://signals.test";
const DEPLOY = { HUB_ORIGINS: HUB, PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };
const ringFor = (ch: string, id: string) => ({ url: `${HUB}/apc/ring/${ch.repeat(32)}`, id });
// Each test has its own ring address: a ring that arrives late from an earlier test is not the later test's ring.
const ACK = { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Grok bot via dock", icon: null }, pairing_code: "required" };
const posts = demoMarket().posts;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for something that must happen: a ring is signed with WebCrypto, so how many ticks it takes depends on the runner. */
const until = async (what: string, predicate: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(5);
  }
};

/** Waits for something that must NOT happen: settles the pending ticks, then gives a late ring real time to show up. */
const quiet = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  await sleep(100);
};

test("Signals keeps the hub's ring address and rings it after a pin, signed with the grant's own MCP URL", async (t) => {
  const RING = ringFor("b", "pr_ring_signals011");
  const paired: Array<{ mcp_url: string }> = [];
  const rings: Array<{ id: string; at: number; n: string; sig: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    if (request.url === `${HUB}/apc/pair`) {
      paired.push(body as { mcp_url: string });
      return Response.json({ ...ACK, ring: RING });
    }
    if (request.url === RING.url) {
      rings.push(body as { id: string; at: number; n: string; sig: string });
      return Response.json({ ok: true });
    }
    return new Response("no", { status: 500 });
  });
  const room = durableObjectRoom();
  const feed = new Feed(room.ctx, DEPLOY);
  await feed.init();
  const drop = { hub: HUB, agent: "ag_grok", ticket: `${"d".repeat(32)}.${"5".repeat(16)}`, target: { kind: "post", id: posts[0]!.id, part: null } };
  const asked = await feed.pairHub(SID, ORIGIN, drop, true);
  const done = await feed.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent }, true);
  assert.equal(done.ok, true, done.error);
  await until("the drop's ring", () => rings.length >= 1);

  assert.equal(rings.length, 1);
  const key = await ringKey(paired[0]!.mcp_url);
  assert.equal(rings[0]!.id, RING.id);
  assert.equal(rings[0]!.sig, await ringSignature(key, rings[0]!.id, rings[0]!.at, rings[0]!.n));
  const stored = room.db.prepare("select ring_url, ring_id, ring_key from grants where id = ?").get(done.grant_id) as Record<string, string>;
  assert.deepEqual({ ...stored }, { ring_url: RING.url, ring_id: RING.id, ring_key: key });
  assert.ok(!JSON.stringify(await feed.state()).includes(key));

  await feed.pin(done.grant_id, { kind: "post", id: posts[1]!.id, part: null });
  await until("the second pin's ring", () => rings.length >= 2);
  assert.equal(rings.length, 2);
});

test("a grant paired before the ring, even one with no pairing_id, learns it from the hub's /apc/confirm answer on its next drop", async (t) => {
  const RING = ringFor("d", "pr_ring_signals012");
  const paired: Array<{ mcp_url: string }> = [];
  const confirmed: Array<{ mcp_url: string }> = [];
  const rings: Array<{ id: string; at: number; n: string; sig: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    // A hub from before the ring: its /apc/pair answer has none. Today it answers /apc/confirm with one.
    if (request.url === `${HUB}/apc/pair`) {
      paired.push(body as { mcp_url: string });
      return Response.json(ACK);
    }
    if (request.url === `${HUB}/apc/confirm`) {
      confirmed.push(body as { mcp_url: string });
      return Response.json({ ok: true, status: "pending", agent: { name: "Grok bot via dock", icon: null }, ring: RING });
    }
    if (request.url === RING.url) {
      rings.push(body as { id: string; at: number; n: string; sig: string });
      return Response.json({ ok: true });
    }
    return new Response("no", { status: 500 });
  });
  const room = durableObjectRoom();
  const feed = new Feed(room.ctx, DEPLOY);
  await feed.init();
  const drop = { hub: HUB, agent: "ag_legacy", ticket: `${"d".repeat(32)}.${"6".repeat(16)}`, target: { kind: "post", id: posts[0]!.id, part: null } };
  const asked = await feed.pairHub(SID, ORIGIN, drop, true);
  const done = await feed.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent }, true);
  assert.equal(done.ok, true, done.error);
  await quiet();
  // Older still: a grant from before Signals kept the hub's pairing id.
  room.db.prepare("update grants set pairing_id = null where id = ?").run(done.grant_id);
  const ringOf = () => ({ ...(room.db.prepare("select ring_url, ring_id, ring_key from grants where id = ?").get(done.grant_id) as Record<string, string | null>) });
  assert.deepEqual(ringOf(), { ring_url: null, ring_id: null, ring_key: null });
  assert.equal(rings.length, 0, "a legacy grant rings nobody");

  const again = await feed.pairHub(SID, ORIGIN, { ...drop, ticket: `${"d".repeat(32)}.${"7".repeat(16)}`, target: { kind: "post", id: posts[1]!.id, part: null } });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.grant_id, done.grant_id);
  await until("the confirmed grant's ring", () => rings.length >= 1);
  assert.equal(confirmed[0]!.mcp_url, paired[0]!.mcp_url);
  const key = await ringKey(confirmed[0]!.mcp_url);
  assert.deepEqual(ringOf(), { ring_url: RING.url, ring_id: RING.id, ring_key: key });
  assert.equal(rings.length, 1, "the drop's pin rang");
  assert.equal(rings[0]!.sig, await ringSignature(key, rings[0]!.id, rings[0]!.at, rings[0]!.n));
});
