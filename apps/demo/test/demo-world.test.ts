/**
 * The demo's one shared world (TIN-621): every Pulse sandbox serves DEMO_SEED's data, whatever seed an older
 * sandbox kept or an old dock link sends, and the question across Pulse and Signals that the how-to names holds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { CROSS_APP, demoDataset, demoMarket, pulseCustomerPath, signalsPostPath } from "../src/model/demo-world.ts";
import { DEMO_SEED, generateDataset, MONTHS } from "../src/model/seed.ts";
import { buildMarket } from "../src/model/market.ts";
import { figureAnswer, type Grant } from "../src/worker/domain.ts";

installWorkersStandIn();
const { Sandbox } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const DEPLOY = { APC_V2: "1", HUB_ORIGINS: "https://dock.test", APC_PROFILES: "direct,dock" };
const FULL: Grant = { id: "g", secret: "s", label: "Agent", client_name: null, regions: null, created_at: "", last_active_at: null };

test("the demo world is DEMO_SEED's, built once, and the market is built from it", () => {
  assert.deepEqual(demoDataset(), generateDataset(DEMO_SEED));
  assert.equal(demoDataset(), demoDataset());
  assert.deepEqual(demoMarket().posts, buildMarket(generateDataset(DEMO_SEED)).posts);
});

test("the question across apps holds: the competitor's post, and the Pulse customers it took", () => {
  const post = demoMarket().posts.find((p) => p.id === CROSS_APP.post);
  assert.ok(post && post.kind === "competitor_offer", "the post is a competitor's offer");
  assert.equal(post.author, CROSS_APP.competitor);
  assert.equal(post.offer, CROSS_APP.offer);
  assert.deepEqual(post.audience, { region: CROSS_APP.region, plan: CROSS_APP.plan });
  assert.equal(post.ends_month, CROSS_APP.month, "it runs into the month of the churn");
  // No other competitor targets that segment around then: the answer is not ambiguous.
  const near = demoMarket().posts.filter((p) => p.kind === "competitor_offer" && p.audience.region === CROSS_APP.region && p.audience.plan === CROSS_APP.plan && Math.abs(MONTHS.indexOf(p.month) - MONTHS.indexOf(post.month)) <= 3);
  assert.deepEqual(near.map((p) => p.id), [CROSS_APP.post]);

  // What the agent reads in Pulse: the churned step of that month's bridge in that region, on that plan.
  const bridge = figureAnswer(demoDataset(), FULL, "customer_bridge", { month: CROSS_APP.month, region: CROSS_APP.region }, "https://pulse.test");
  assert.ok(!("error" in bridge), "error" in bridge ? bridge.message : "");
  const churned = (bridge.breakdown.churned ?? []).filter((c) => c.plan === CROSS_APP.plan).map((c) => c.customer_id).sort();
  assert.deepEqual(churned, [...CROSS_APP.churned].sort());
  const customer = demoDataset().customers.find((c) => c.id === CROSS_APP.customer)!;
  assert.equal(customer.name, CROSS_APP.customerName);
  // The largest of them, by the seats it had the month before.
  const before = MONTHS[MONTHS.indexOf(CROSS_APP.month) - 1];
  const seats = (id: string) => demoDataset().activity.find((a) => a.customer_id === id && a.month === before)!.seats;
  assert.equal([...CROSS_APP.churned].sort((a, b) => seats(b) - seats(a))[0], CROSS_APP.customer);
});

test("the deep links are stable paths", () => {
  assert.equal(pulseCustomerPath(CROSS_APP.customer), "/customers/cus_0048");
  assert.equal(signalsPostPath(CROSS_APP.post), "/?post=post_013");
});

test("a sandbox made before TIN-621, with a seed of its own, shows the demo world", async () => {
  const room = durableObjectRoom();
  const sandbox = new Sandbox(room.ctx, DEPLOY);
  await sandbox.init();
  room.db.exec("insert into meta (key, value) values ('seed', '12345') on conflict(key) do update set value = excluded.value");
  const fresh = new Sandbox(room.ctx, DEPLOY);
  assert.deepEqual(await fresh.dataset(), demoDataset());
  assert.equal("seed" in (await fresh.state()), false, "the state names no world");
});

test("an old dock link's seed opens Pulse and changes nothing", async () => {
  const inits: unknown[][] = [];
  const owners = new Map<string, string>();
  const stub = (sid: string) => ({
    async init(...args: unknown[]) {
      inits.push(args);
      if (!owners.has(sid)) owners.set(sid, "a".repeat(32));
      return { owner: owners.get(sid)! };
    },
    async isOwner(secret: string) {
      return owners.get(sid) === secret;
    },
  });
  const env = { ...DEPLOY, SANDBOX: { idFromName: (name: string) => name, get: (id: string) => stub(id) } };
  const opened = await worker.request("https://pulse.test/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed: 7 }) }, env);
  assert.equal(opened.status, 200);
  const { sid, created } = (await opened.json()) as { sid: string; created: boolean };
  assert.equal(created, true);
  assert.deepEqual(inits, [[]], "a sandbox is made with no world of its own");
  // The same visitor again, with another seed: the same sandbox, nothing moved.
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const again = await worker.request("https://pulse.test/api/session", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ seed: 8 }) }, env);
  assert.deepEqual(await again.json(), { sid, created: false });
  assert.equal(inits.length, 1);
});
