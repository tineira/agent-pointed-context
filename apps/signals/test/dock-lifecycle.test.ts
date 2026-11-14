/**
 * Signals on the Dock profile as built (APC 0.10, TIN-892): the shared checks of apps/demo/test/dock-lifecycle.ts
 * on Signals' real feed and Worker, and what is Signals' alone (it stores the pending code and its expiry now).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { demoMarket } from "../../demo/src/model/demo-world.ts";
import { dockLifecycleTests, HUB, SID, type DockAppUnderTest } from "../../demo/test/dock-lifecycle.ts";

installWorkersStandIn();
const { Feed } = await import(new URL("../src/worker/feed.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const ORIGIN = "https://signals.test";
const DEPLOY = { HUB_ORIGINS: HUB, PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };
const posts = demoMarket().posts;
type Grant = { id: string; path: string; secret: string | null; connected: boolean; state?: string; pairing?: { code: string; expires_at: string } | null; pin: { id: string | null } | null };
type State = { grants: Grant[] };

const signals: DockAppUnderTest = {
  name: "Signals",
  origin: ORIGIN,
  cookie: "apc_signals",
  binding: "FEED",
  env: DEPLOY,
  create: (ctx, env) => new Feed(ctx, env),
  worker,
  targets: [
    { kind: "post", id: posts[0]!.id, part: null },
    { kind: "post", id: posts[1]!.id, part: null },
  ],
  probe: { tool: "list_posts", args: {} },
  row: { table: "grants", id: "id" },
  link: (state, grantId) => (state as unknown as State).grants.find((g) => g.id === grantId && g.path === "dock"),
  pinned: (state, grantId) => (state as unknown as State).grants.find((g) => g.id === grantId)?.pin?.id ?? null,
  grantIds: (state) => (state as unknown as State).grants.map((g) => g.id),
  direct: async (object, room) => {
    const made = await (object as unknown as { addDirectGrant(): Promise<{ grant_id: string }> }).addDirectGrant();
    const row = room.db.prepare("select secret from grants where id = ?").get(made.grant_id) as { secret: string };
    return { id: made.grant_id, secret: row.secret };
  },
};

dockLifecycleTests(signals);

test("Signals stores the pending code and its expiry: the waiting card survives a reload, and the grant is connected only once live", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Agent via dock", icon: null }, pairing_code: "required" }));
  const room = durableObjectRoom();
  const feed = new Feed(room.ctx, DEPLOY);
  await feed.init();
  const direct = await feed.addDirectGrant();
  const drop = { hub: HUB, agent: "ag_1", ticket: `${"d".repeat(32)}.${"1".repeat(16)}`, target: signals.targets[0] };
  const asked = await feed.pairHub(SID, ORIGIN, drop);
  const before = Date.now();
  const paired = await feed.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent });
  assert.equal(paired.ok, true, paired.error);
  assert.equal(paired.status, "pending");
  assert.equal(paired.pairing.code, asked.pairing_code);
  const until = Date.parse(paired.pairing.expires_at);
  assert.ok(until >= before + 120_000 && until <= Date.now() + 120_000, "two minutes from the acknowledgement");
  // A reload (a new object on the same storage) shows the same card.
  const reloaded = new Feed(room.ctx, DEPLOY);
  const grant = ((await reloaded.state()) as State).grants.find((g) => g.id === paired.grant_id)!;
  assert.equal(grant.state, "handoff");
  assert.deepEqual(grant.pairing, paired.pairing);
  assert.equal(grant.connected, false, "handed to the dock, not connected");
  assert.equal(grant.secret, null, "the dock grant's secret is its hub's alone");
  const own = ((await reloaded.state()) as State).grants.find((g) => g.id === direct.grant_id)!;
  assert.equal(own.state, undefined, "a Direct agent has no dock state");
  assert.match(own.secret ?? "", /^[0-9a-f]{32}$/);
  // The code is on the page's state only: the feed's WebSocket messages say only that something changed.
  const page = room.openPage();
  await reloaded.cancelDockGrant(paired.grant_id);
  assert.ok(page.sent.length > 0 && page.sent.every((m) => !m.includes(asked.pairing_code)));
});

test("Signals: a dock grant from before APC 0.10 whose hub never acknowledged it (no agent, no state) is ended at the upgrade, never read as live", async (t) => {
  let sent: { mcp_url?: string } = {};
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    sent = (await (input instanceof Request ? input : new Request(input, init)).json()) as { mcp_url?: string };
    return Response.json({ ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Agent via dock", icon: null }, pairing_code: "required" });
  });
  const room = durableObjectRoom();
  const before = new Feed(room.ctx, DEPLOY);
  await before.init();
  const drop = { hub: HUB, agent: "ag_old", ticket: `${"d".repeat(32)}.${"2".repeat(16)}`, target: signals.targets[0] };
  const asked = await before.pairHub(SID, ORIGIN, drop);
  const paired = await before.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent });
  assert.equal(paired.ok, true, paired.error);
  // As Signals 0.9 left an Allow its hub never answered: the hub set, the agent not yet, and none of the 0.10 columns.
  room.db.prepare("update grants set agent = null, state = null, secret_hash = null, allowed_at = null, acked_at = null, pairing_code = null, pairing_expires_at = null where id = ?").run(paired.grant_id);
  const feed = new Feed(room.ctx, DEPLOY);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(((await feed.state()) as State).grants.some((g) => g.id === paired.grant_id), false);
  const response = await feed.fetch(new Request(sent.mcp_url!, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_posts", arguments: {} } }) }));
  assert.equal(response.status, 404);
});
