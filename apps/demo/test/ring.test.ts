/**
 * Pulse rings its hub after a pin (TIN-962, experimental): it keeps the ring address the hub gave it, keyed with SHA-256
 * of the exact MCP URL it sent, and each pin on that dock grant sends a ring the hub can verify. The page never sees it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { ringKey, ringSignature } from "@tineira/apc-server";
import { demoDataset } from "../src/model/demo-world.ts";
import { HUB, SID } from "./dock-lifecycle.ts";

installWorkersStandIn();
const { Sandbox } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);

const ORIGIN = "https://pulse.test";
const DEPLOY = { APC_V2: "1", HUB_ORIGINS: HUB, PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };
const RING = { url: `${HUB}/apc/ring/${"a".repeat(32)}`, id: "pr_ring0123456789" };
const ACK = { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Grok bot via dock", icon: null }, pairing_code: "required" };
const customers = demoDataset().customers;

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("Pulse keeps the hub's ring address and rings it after a pin, signed with the grant's own MCP URL", async (t) => {
  const paired: Array<{ mcp_url: string }> = [];
  const rings: Array<Record<string, unknown>> = [];
  let ring: unknown = RING;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    if (request.url === `${HUB}/apc/pair`) {
      paired.push(body as { mcp_url: string });
      return Response.json({ ...ACK, ring });
    }
    if (request.url === RING.url) {
      rings.push(body);
      return Response.json({ ok: true });
    }
    return new Response("no", { status: 500 });
  });
  const room = durableObjectRoom();
  const sandbox = new Sandbox(room.ctx, DEPLOY);
  await sandbox.init();
  const drop = { hub: HUB, agent: "ag_grok", ticket: `${"d".repeat(32)}.${"3".repeat(16)}`, target: { kind: "customer", id: customers[0]!.id, part: null, params: null } };
  const asked = await sandbox.pairHub(SID, ORIGIN, drop, true);
  const done = await sandbox.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent }, true);
  assert.equal(done.ok, true, done.error);
  await settle();

  // The drop's own pin rang, signed with the key of the exact URL sent in /apc/pair.
  assert.equal(rings.length, 1);
  const key = await ringKey(paired[0]!.mcp_url);
  const r = rings[0] as { id: string; at: number; n: string; sig: string };
  assert.equal(r.id, RING.id);
  assert.equal(r.sig, await ringSignature(key, r.id, r.at, r.n));
  const stored = room.db.prepare("select ring_url, ring_id, ring_key from hub_links where grant_id = ?").get(done.grant_id) as Record<string, string>;
  assert.deepEqual({ ...stored }, { ring_url: RING.url, ring_id: RING.id, ring_key: key });
  // The page never sees the ring's address or key.
  assert.ok(!JSON.stringify(await sandbox.state()).includes(key));
  assert.ok(!JSON.stringify(await sandbox.state()).includes("/apc/ring/"));

  // Another pin rings again; a hub that sent a ring on another origin is never rung.
  await sandbox.pin(done.grant_id, { kind: "customer", id: customers[1]!.id, part: null, params: null });
  await settle();
  assert.equal(rings.length, 2);
  ring = { ...RING, url: `https://evil.test/apc/ring/${"a".repeat(32)}` };
  const other = { hub: HUB, agent: "ag_other", ticket: `${"d".repeat(32)}.${"4".repeat(16)}`, target: drop.target };
  const asked2 = await sandbox.pairHub(SID, ORIGIN, other, true);
  const done2 = await sandbox.pairHub(SID, ORIGIN, { ...other, consent: asked2.consent }, true);
  assert.equal(done2.ok, true, done2.error);
  await settle();
  assert.equal(rings.length, 2);
  assert.equal((room.db.prepare("select ring_url from hub_links where grant_id = ?").get(done2.grant_id) as { ring_url: string | null }).ring_url, null);
});
