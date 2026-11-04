/**
 * Signals against the APC conformance suite (APC 0.2, TIN-577). Signals offers the Dock profile only:
 * every grant is one it handed a dock's hub at pairing. Its Durable Object runs for real on Node's
 * SQLite (@apc/conformance/workers); the hub's side of pairing is a stand-in, so nothing leaves the
 * process.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { apcConformance, type ApcAppAdapter } from "@apc/conformance";
import { durableObjectRoom, installWorkersStandIn } from "@apc/conformance/workers";
import type { FocusTarget, PresenceEvent } from "@apc/protocol";
import { generateDataset } from "../../demo/src/model/seed.ts";
import { buildMarket } from "../../demo/src/model/market.ts";

installWorkersStandIn();
const { Feed } = await import(new URL("../src/worker/feed.ts", import.meta.url).href);

const ORIGIN = "https://signals.test";
const HUB = "https://dock.test";
const SID = "7".repeat(32);
const SEED = 4242;

function standInHub(t: TestContext | null): { calls: string[] } {
  const calls: string[] = [];
  const fake = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === `${HUB}/apc/pair`) return Response.json({ ok: true, pairing_id: "pr_test", status: "pending", agent: { name: "Agent via dock", icon: null } });
    throw new Error(`no network in this test: ${url}`);
  };
  if (t) t.mock.method(globalThis, "fetch", fake);
  else globalThis.fetch = fake as typeof fetch;
  return { calls };
}

async function signals() {
  const room = durableObjectRoom();
  const feed = new Feed(room.ctx, { HUB_ORIGINS: HUB });
  await feed.init(SEED);
  const posts = buildMarket(generateDataset(SEED)).posts;
  const targets: [FocusTarget, FocusTarget] = [
    { kind: "post", id: posts[0]!.id, part: null, params: null },
    { kind: "post", id: posts[1]!.id, part: "offer", params: null },
  ];
  let agents = 0;
  const app: ApcAppAdapter = {
    name: "Signals",
    profile: "dock",
    fetch: (request) => feed.fetch(request),
    async connect() {
      agents++;
      const paired = await feed.pairHub(SID, ORIGIN, { hub: HUB, agent: `ag_${agents}`, ticket: `${"d".repeat(32)}.${agents.toString().padStart(16, "0")}`, target: targets[0] });
      assert.equal(paired.ok, true, `pairing: ${paired.error}`);
      await feed.unpin(paired.grant_id);
      const [row] = room.db.prepare("select secret from grants where id = ?").all(paired.grant_id);
      return { grantId: paired.grant_id as string, mcpUrl: `${ORIGIN}/mcp/${SID}/${String(row!.secret)}` };
    },
    targets,
    probe: { tool: "list_posts", args: {} },
    page: {
      setOpen(open) {
        if (!open) room.closePages();
        else if (!room.pages.some((p) => p.readyState === 1)) room.openPage();
      },
      async showView() {
        await feed.reportView({ screen: "feed", params: { kind: "competitor_offer" }, selection: { kind: "post", id: targets[0].id } });
      },
      pin: async (grantId, target) => (await feed.pin(grantId, target, true)).ok,
      takePresence: () => room.takeMessages().filter((m) => m.type === "presence").map((m) => m.event as PresenceEvent),
      revoke: async (grantId) => (await feed.revokeGrant(grantId)).ok,
    },
  };
  return { app, feed, room };
}

standInHub(null);
{
  const { app } = await signals();
  for (const check of apcConformance(app)) test(check.name, check.run);
}

test("revoking an agent in Signals calls nobody; the URL answers revoked with Signals' host, and the dock link goes", async (t) => {
  const { app, feed } = await signals();
  const hub = standInHub(t);
  const { grantId, mcpUrl } = await app.connect();
  const before = hub.calls.length;
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("the hub is down");
  });
  assert.deepEqual(await feed.revokeGrant(grantId), { ok: true });
  assert.equal(hub.calls.length, before, "no call to the hub");
  assert.equal((await feed.state()).grants.length, 0);
  const response = await feed.fetch(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).revoked_by, "signals.test");
});

test("Signals ends the loop like Pulse: no then on a wait that came back empty", async () => {
  const { app } = await signals();
  const { mcpUrl } = await app.connect();
  await app.page.setOpen(true);
  const response = await app.fetch!(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_focus", arguments: { timeout_s: 1 } } }) }));
  const { result } = (await response.json()) as { result: { structuredContent: Record<string, unknown> } };
  assert.equal(result.structuredContent.timed_out, true);
  assert.equal("then" in result.structuredContent, false);
});
