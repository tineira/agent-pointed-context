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
const ringFor = (ch: string, id: string) => ({ url: `${HUB}/apc/ring/${ch.repeat(32)}`, id });
// Each test has its own ring address: a ring that arrives late from an earlier test is not the later test's ring.
const ACK = { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Grok bot via dock", icon: null }, pairing_code: "required" };
const customers = demoDataset().customers;

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

test("Pulse keeps the hub's ring address and rings it after a pin, signed with the grant's own MCP URL", async (t) => {
  const RING = ringFor("a", "pr_ring01234567891");
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
  await until("the drop's ring", () => rings.length >= 1);

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
  await until("the second pin's ring", () => rings.length >= 2);
  assert.equal(rings.length, 2);
  ring = { ...RING, url: `https://evil.test/apc/ring/${"a".repeat(32)}` };
  const other = { hub: HUB, agent: "ag_other", ticket: `${"d".repeat(32)}.${"4".repeat(16)}`, target: drop.target };
  const asked2 = await sandbox.pairHub(SID, ORIGIN, other, true);
  const done2 = await sandbox.pairHub(SID, ORIGIN, { ...other, consent: asked2.consent }, true);
  assert.equal(done2.ok, true, done2.error);
  await quiet();
  assert.equal(rings.length, 2);
  assert.equal((room.db.prepare("select ring_url from hub_links where grant_id = ?").get(done2.grant_id) as { ring_url: string | null }).ring_url, null);
});

test("a grant paired before the ring learns it from the hub's /apc/confirm answer on its next drop, and rings from then on", async (t) => {
  const RING = ringFor("c", "pr_ring01234567892");
  const paired: Array<{ mcp_url: string }> = [];
  const confirmed: Array<{ mcp_url: string }> = [];
  const rings: Array<Record<string, unknown>> = [];
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
      rings.push(body);
      return Response.json({ ok: true });
    }
    return new Response("no", { status: 500 });
  });
  const room = durableObjectRoom();
  const sandbox = new Sandbox(room.ctx, DEPLOY);
  await sandbox.init();
  const drop = { hub: HUB, agent: "ag_legacy", ticket: `${"d".repeat(32)}.${"5".repeat(16)}`, target: { kind: "customer", id: customers[0]!.id, part: null, params: null } };
  const asked = await sandbox.pairHub(SID, ORIGIN, drop, true);
  const done = await sandbox.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent }, true);
  assert.equal(done.ok, true, done.error);
  await quiet();
  const ringOf = () => ({ ...(room.db.prepare("select ring_url, ring_id, ring_key from hub_links where grant_id = ?").get(done.grant_id) as Record<string, string | null>) });
  assert.deepEqual(ringOf(), { ring_url: null, ring_id: null, ring_key: null });
  assert.equal(rings.length, 0, "a legacy grant rings nobody");

  // The next drop of the same agent confirms the pairing: the answer's ring is kept, for this same grant.
  const again = await sandbox.pairHub(SID, ORIGIN, { ...drop, ticket: `${"d".repeat(32)}.${"6".repeat(16)}`, target: { kind: "customer", id: customers[1]!.id, part: null, params: null } });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.grant_id, done.grant_id);
  await until("the confirmed grant's ring", () => rings.length >= 1);
  assert.equal(confirmed[0]!.mcp_url, paired[0]!.mcp_url);
  const key = await ringKey(confirmed[0]!.mcp_url);
  assert.deepEqual(ringOf(), { ring_url: RING.url, ring_id: RING.id, ring_key: key });
  assert.equal(rings.length, 1, "the drop's pin rang");
  const r = rings[0] as { id: string; at: number; n: string; sig: string };
  assert.equal(r.sig, await ringSignature(key, r.id, r.at, r.n));
});
