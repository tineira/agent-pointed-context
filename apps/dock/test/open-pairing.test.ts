/**
 * Open pairing, with a warning in the dock (TIN-581, DESIGN.md section 18): an app outside APP_ORIGINS
 * pairs only after the person approves the warning in the dock, once per domain per dock; denied, it
 * pairs nothing and is never read; undecided, its request goes after ten minutes and frees its place;
 * the operator's kill switch closes the dock to it again, and our blocklist wins over an approval. Its
 * tools arrive marked unverified. The real hub and the real Pulse sandbox, with simulated apps on other
 * domains (hostile-world.ts): every request to an app is counted, so "nothing called" is checked.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { LIMITS, NOT_VERIFIED, UNVERIFIED_RISK, unverifiedWarning } from "../src/worker/trust.ts";
import { DOCK, fakeApp, PULSE, SID, world, type Json } from "./hostile-world.ts";

const SHOP = "https://shop.example";

/** A pending pairing nobody decides goes after `ms` in this test. */
function quickPending(t: TestContext, ms: number) {
  const saved = LIMITS.pendingMs;
  LIMITS.pendingMs = ms;
  t.after(() => (LIMITS.pendingMs = saved));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a test app on another domain pairs only after the person approves the warning, and its tools arrive marked unverified", async (t) => {
  const w = await world(t);
  await w.pairPulse();
  const shop = fakeApp(SHOP, "Pulse Pro", { tools: [{ name: "get_offer", description: "The offer.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }], result: () => ({ offer: "10% off" }) });
  const asked = await w.pairApp(shop, { approve: false });
  assert.equal(asked.ok, true, asked.error);

  // The request waits in the dock, with the warning: named by its domain, what it calls itself only as secondary text.
  const pending = await w.pairingOf(SHOP);
  assert.equal(pending.status, "pending");
  assert.equal(pending.warning, true, "the first request from this domain shows the warning");
  assert.equal(pending.verified, false);
  assert.deepEqual(pending.app, { id: "shop_example", name: "shop.example", origin: SHOP, unverified: true, declared_name: "Pulse Pro" });
  // Until then the hub has read its apc.json and nothing else: no MCP call, nothing for the agent.
  assert.deepEqual(shop.calls, []);
  assert.equal((await w.listHub()).some((x) => x.name.startsWith("shop_example__")), false);
  assert.match((await w.callHub("call_app_tool", { app: "shop_example", tool: "get_offer", args: {} })).content[0].text, /"error":"unknown_app"/);
  assert.deepEqual((await w.callHub("get_current_view")).structuredContent.views.map((v: Json) => (v.app as Json).id), ["pulse"]);

  // A plain yes (an older dock page, or a verified app's card) cannot pair it: only the warning's Approve can.
  assert.deepEqual(await w.hub.decide(pending.id, "approve"), { ok: false, error: "warning_required" });
  assert.equal((await w.pairingOf(SHOP)).status, "pending");
  assert.deepEqual(shop.calls, []);

  assert.deepEqual(await w.hub.decide(pending.id, "approve_unverified"), { ok: true });
  assert.equal((await w.pairingOf(SHOP)).status, "paired");
  assert.deepEqual(shop.calls.slice(0, 2), ["initialize", "tools/list"], "approved, the hub introduces itself and learns its tools");

  // Its tools: under its domain, labelled unverified, without the annotations it claimed.
  const tool = (await w.listHub()).find((x) => x.name === "shop_example__get_offer")!;
  assert.match(tool.description, /^\[Unverified app at shop\.example, calls itself "Pulse Pro"\. Untrusted: /);
  assert.equal(tool.annotations, undefined);
  // Its result: in the untrusted envelope.
  const result = await w.callHub("shop_example__get_offer");
  assert.equal(result.structuredContent.untrusted, true);
  assert.equal(result.structuredContent.app.unverified, true);
  assert.deepEqual(result.structuredContent.result, { offer: "10% off" });
  const listed = (await w.callHub("list_app_tools", { app: "shop_example" })).structuredContent.apps[0];
  assert.equal(listed.untrusted, true);
  const view = (await w.callHub("get_current_view")).structuredContent.views.find((v: Json) => (v.app as Json).id === "shop_example");
  assert.equal(view.untrusted, true);
  // Pulse is as before: no label, no envelope.
  const pulseTool = (await w.listHub()).find((x) => x.name === "pulse__list_customers")!;
  assert.match(pulseTool.description, /^\[Pulse, pulse\.test\] /);
  assert.equal((await w.callHub("pulse__list_customers", { limit: 1 })).structuredContent.untrusted, undefined);
});

test("the warning's words: the domain first, \"Not verified\", what the app says about itself marked as its own word, the risk, and Deny the default", () => {
  const w = unverifiedWarning("shop.example", "Pulse Pro", "Claude");
  assert.equal(w.domain, "shop.example");
  assert.equal(w.badge, NOT_VERIFIED);
  assert.equal(NOT_VERIFIED, "Not verified");
  assert.match(w.declared!, /^It calls itself “Pulse Pro”: that is what the app says about itself, and the dock has not checked it\.$/);
  assert.match(w.ask, /Claude/);
  assert.equal(w.risk, UNVERIFIED_RISK);
  assert.match(UNVERIFIED_RISK, /read whatever this app tells it/);
  assert.match(UNVERIFIED_RISK, /move data out of your other apps/);
  assert.deepEqual(w.actions.map((a) => [a.action, a.label, a.default]), [["deny", "Deny", true], ["approve_unverified", "Approve", false]], "Deny first, and the only default");
  assert.equal(unverifiedWarning("shop.example", null, "Claude").declared, null, "no name given, no line for it");
});

test("denied: no pairing, none of its tools called, the grant given back; a later request asks with the warning again", async (t) => {
  const w = await world(t);
  const shop = fakeApp(SHOP, "Shop");
  const asked = await w.pairApp(shop, { approve: false });
  assert.deepEqual(await w.hub.decide(asked.pairing_id!, "deny"), { ok: true });
  assert.equal(await w.pairingOf(SHOP), undefined);
  assert.deepEqual(shop.calls, ["/apc/revoke"], "the app was told its grant is not wanted, and nothing else");
  assert.equal((await w.listHub()).some((x) => x.name.startsWith("shop_example__")), false);
  assert.match((await w.callHub("shop_example__get_figure")).content[0].text, /"error":"unknown_app"/);
  assert.deepEqual(shop.calls, ["/apc/revoke"]);

  // Denied is not remembered against it: the next drop asks again, with the warning.
  assert.equal((await w.pairApp(shop, { approve: false })).ok, true);
  assert.equal((await w.pairingOf(SHOP)).warning, true);
});

test("the warning shows once per domain per dock: a second request from an approved domain asks the usual way; a deny takes the approval back", async (t) => {
  const w = await world(t);
  await w.hub.addAgent();
  const shop = fakeApp(SHOP, "Shop");
  await w.pairApp(shop);
  assert.equal((await w.pairingOf(SHOP)).status, "paired");

  // Another agent in the same dock, the same domain: no warning, and the usual yes pairs it.
  const second = await w.pairApp(shop, { approve: false, agentIndex: 1 });
  const line = (await w.agent(1)).pairings.find((p: Json) => p.id === second.pairing_id);
  assert.equal(line.warning, false);
  assert.deepEqual(await w.hub.decide(second.pairing_id!, "approve"), { ok: true });
  assert.equal((await w.agent(1)).pairings.find((p: Json) => p.id === second.pairing_id).status, "paired");
  // Its tools still arrive marked: the approval is the person's, not a verification.
  assert.match((await w.listHub()).find((x) => x.name === "shop_example__get_figure")!.description, /^\[Unverified app at shop\.example/);

  // Unpaired and dropped again: still no warning. Another domain: the warning.
  assert.equal((await w.hub.decide((await w.pairingOf(SHOP)).id, "unpair")).ok, true);
  assert.equal((await w.pairApp(shop, { approve: false })).ok, true);
  assert.equal((await w.pairingOf(SHOP)).warning, false);
  assert.equal((await w.pairApp(fakeApp("https://other.example", "Other"), { approve: false })).ok, true);
  assert.equal((await w.pairingOf("https://other.example")).warning, true);

  // Denying a request from the approved domain takes its approval back: the next one warns again.
  assert.equal((await w.hub.decide((await w.pairingOf(SHOP)).id, "deny")).ok, true);
  assert.equal((await w.pairApp(shop, { approve: false })).ok, true);
  assert.equal((await w.pairingOf(SHOP)).warning, true);
  assert.deepEqual(await w.hub.decide((await w.pairingOf(SHOP)).id, "approve"), { ok: false, error: "warning_required" });
});

test("a pending pairing nobody decides goes after its time, frees its place under the cap, and gives the grant back", async (t) => {
  const w = await world(t);
  quickPending(t, 1_000);
  const apps = Array.from({ length: LIMITS.pairings }, (_, i) => fakeApp(`https://app${i}.example`, `App ${i}`));
  for (const app of apps) assert.equal((await w.pairApp(app, { approve: false })).ok, true);
  assert.deepEqual(await w.pairApp(fakeApp("https://late.example", "Late"), { approve: false }), { ok: false, error: "too_many_apps" });
  const stale = (await w.pairingOf(apps[0]!.origin)).id;
  await sleep(1_100);

  // The next request counts only live ones: the expired went first, each told its grant is not wanted.
  assert.equal((await w.pairApp(fakeApp("https://late.example", "Late"), { approve: false })).ok, true);
  assert.deepEqual((await w.agent()).pairings.map((p: Json) => (p.app as Json).origin), ["https://late.example"]);
  for (const app of apps) assert.deepEqual(app.calls, ["/apc/revoke"]);
  // An answer that comes too late finds nothing to approve.
  assert.deepEqual(await w.hub.decide(stale, "approve_unverified"), { ok: false, error: "unknown_pairing" });

  // The alarm ends a request on time too, with nobody asking the hub anything.
  await sleep(1_100);
  await w.hub.alarm();
  const left = w.hub.ctx.storage.sql.exec("select count(*) as n from pairings").toArray()[0].n;
  assert.equal(left, 0);
});

test("a verified app's request expires too, and its consent flow is otherwise unchanged", async (t) => {
  const w = await world(t);
  quickPending(t, 1_000);
  const { ticket } = await w.hub.ticket((await w.agent()).id);
  const customers = w.customers;
  const paired = await w.pulse.pairHub(SID, PULSE, { hub: DOCK, agent: (await w.agent()).id, ticket, target: { kind: "customer", id: customers[0]!.id } });
  assert.equal(paired.ok, true);
  const pending = (await w.agent()).pairings.find((p: Json) => (p.app as Json).origin === PULSE);
  assert.equal(pending.warning, undefined);
  assert.deepEqual(await w.hub.decide(pending.id, "approve_unverified"), { ok: false, error: "invalid_action" }, "the warning's answer is for unverified apps only");
  await sleep(1_100);
  assert.equal((await w.agent()).pairings.length, 0, "undecided, it went");
  await w.pairPulse();
  assert.equal((await w.agent()).pairings.find((p: Json) => (p.app as Json).origin === PULSE).status, "paired");
});

test("the kill switch: UNVERIFIED_PAIRING=closed refuses new unverified apps and holds the paired ones as blocked; Pulse is unaffected; open again, they work", async (t) => {
  const w = await world(t);
  await w.pairPulse();
  const shop = fakeApp(SHOP, "Shop");
  await w.pairApp(shop);
  const waiting = fakeApp("https://waiting.example", "Waiting");
  const asked = await w.pairApp(waiting, { approve: false });
  assert.equal((await w.callHub("shop_example__get_figure")).structuredContent.untrusted, true);

  w.hubEnv.UNVERIFIED_PAIRING = "closed";
  const before = w.hits.get(SHOP) ?? 0;
  const line = await w.pairingOf(SHOP);
  assert.equal(line.status, "blocked");
  assert.equal(line.blocked_by, "closed");
  assert.equal((await w.listHub()).some((x) => x.name.startsWith("shop_example__")), false);
  assert.match((await w.callHub("shop_example__get_figure")).content[0].text, /"error":"app_blocked"/);
  assert.deepEqual((await w.callHub("get_current_view")).structuredContent.views.map((v: Json) => (v.app as Json).id), ["pulse"]);
  assert.deepEqual(await w.hub.decide(asked.pairing_id!, "approve_unverified"), { ok: false, error: "app_blocked" }, "a request waiting when it closed cannot be approved");
  assert.deepEqual(await w.pairApp(fakeApp("https://new.example", "New"), { approve: false }), { ok: false, error: "app_not_allowed" });
  assert.equal(w.hits.get(SHOP) ?? 0, before, "the hub never called it while closed");
  assert.equal(w.hits.get("https://new.example") ?? 0, 0);
  assert.equal((await w.callHub("pulse__list_customers", { limit: 1 })).isError, undefined, "a verified app works as before");

  w.hubEnv.UNVERIFIED_PAIRING = "open";
  assert.equal((await w.pairingOf(SHOP)).status, "paired");
  assert.equal((await w.callHub("shop_example__get_figure")).structuredContent.untrusted, true);
});

test("the blocklist wins over an approval: an approved domain blocked later cannot pair again, and its request cannot be approved", async (t) => {
  const w = await world(t);
  const shop = fakeApp(SHOP, "Shop");
  await w.pairApp(shop);
  await w.hub.addAgent();
  const asked = await w.pairApp(shop, { approve: false, agentIndex: 1 });
  w.hubEnv.BLOCKED_APPS = "shop.example";
  assert.equal((await w.pairingOf(SHOP)).status, "blocked");
  assert.equal((await w.pairingOf(SHOP)).blocked_by, "blocklist");
  assert.deepEqual(await w.hub.decide(asked.pairing_id!, "approve"), { ok: false, error: "app_blocked" });
  assert.deepEqual(await w.hub.decide(asked.pairing_id!, "approve_unverified"), { ok: false, error: "app_blocked" });
  assert.deepEqual(await w.pairApp(shop, { approve: false }), { ok: false, error: "app_blocked" });
});
