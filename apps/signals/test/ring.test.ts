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
const RING = { url: `${HUB}/apc/ring/${"b".repeat(32)}`, id: "pr_ring_signals01" };
const ACK = { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Grok bot via dock", icon: null }, pairing_code: "required" };
const posts = demoMarket().posts;

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("Signals keeps the hub's ring address and rings it after a pin, signed with the grant's own MCP URL", async (t) => {
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
  await settle();

  assert.equal(rings.length, 1);
  const key = await ringKey(paired[0]!.mcp_url);
  assert.equal(rings[0]!.id, RING.id);
  assert.equal(rings[0]!.sig, await ringSignature(key, rings[0]!.id, rings[0]!.at, rings[0]!.n));
  const stored = room.db.prepare("select ring_url, ring_id, ring_key from grants where id = ?").get(done.grant_id) as Record<string, string>;
  assert.deepEqual({ ...stored }, { ring_url: RING.url, ring_id: RING.id, ring_key: key });
  assert.ok(!JSON.stringify(await feed.state()).includes(key));

  await feed.pin(done.grant_id, { kind: "post", id: posts[1]!.id, part: null });
  await settle();
  assert.equal(rings.length, 2);
});
