/**
 * The pairing code in the hub (APC 0.9, TIN-859): an app that sent a code gets its request approved only with
 * that code, typed in the dock. The code never leaves the hub; wrong codes are counted in the row, before any
 * await, and the last one removes the request and gives the grant back; an unapproved coded request goes after
 * two minutes; a malformed body is refused before the ticket is spent. The real hub on Node's SQLite, with
 * simulated apps (hostile-world.ts) whose every request is counted.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PAIRING_CODE_ACK, TICKET_TTL_MS } from "@tineira/apc-protocol";
import { LIMITS } from "../src/worker/trust.ts";
import { fakeApp, PULSE, world, type FakeApp, type Json } from "./hostile-world.ts";

const SHOP = "https://shop.example";
const CODE = "K7M4P2";

/** Shop as a verified app (in APP_ORIGINS), so a plain "approve" is the person's yes. */
async function shopWorld(t: TestContext, env: Json = {}) {
  const w = await world(t, { APP_ORIGINS: `${PULSE},${SHOP}`, ...env });
  const shop = fakeApp(SHOP, "Shop");
  w.apps.set(SHOP, shop);
  /** The app asks to pair with what it would send after its owner's Allow. */
  const ask = async (over: Json = {}, app: FakeApp = shop, agentIndex = 0) => {
    const who = await w.agent(agentIndex);
    const { ticket } = await w.hub.ticket(who.id);
    const body = { ticket, agent: who.id, app: { name: app.name, origin: app.origin }, mcp_url: `${app.origin}/mcp/${"c".repeat(32)}`, pairing_code: CODE, ...over };
    return { ticket, body, answer: (await w.hub.pair(body)) as { ok: boolean; error?: string; pairing_id?: string; pairing_code?: string } };
  };
  const line = async (id: string) => (await w.agent()).pairings.find((p: Json) => p.id === id);
  return { ...w, shop, ask, line };
}

function quick(t: TestContext, key: "pairingCodeMs" | "pendingMs", ms: number) {
  const saved = LIMITS[key];
  LIMITS[key] = ms;
  t.after(() => (LIMITS[key] = saved));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a coded request answers with the acknowledgement, says only code: true in the dock, and the code is never in the state", async (t) => {
  const w = await shopWorld(t);
  const { answer } = await w.ask();
  assert.equal(answer.ok, true, answer.error);
  assert.equal(answer.pairing_code, PAIRING_CODE_ACK);
  const pending = await w.line(answer.pairing_id!);
  assert.equal(pending.status, "pending");
  assert.equal(pending.code, true);
  const state = JSON.stringify(await w.state());
  assert.equal(state.includes(CODE), false, "the code is not in the dock's state");
  assert.equal(state.includes("K7M-4P2"), false);
  // Nor in any answer the hub gives the app, nor in what it sent the app.
  assert.equal(JSON.stringify(answer).includes(CODE), false);
  assert.deepEqual(w.shop.calls, []);
  // The broadcast says only that something changed.
  const sent: string[] = [];
  (w.hubRoom.ctx as unknown as { getWebSockets: () => unknown[] }).getWebSockets = () => [{ send: (m: string) => sent.push(m), readyState: 1 }];
  await w.ask();
  assert.ok(sent.length > 0 && sent.every((m) => m === JSON.stringify({ type: "state" })));
});

test("a missing or malformed code is refused and not counted; the right one pairs, and approving is then as before", async (t) => {
  const w = await shopWorld(t);
  const { answer } = await w.ask();
  const id = answer.pairing_id!;
  assert.deepEqual(await w.hub.decide(id, "approve"), { ok: false, error: "pairing_code_required" });
  assert.deepEqual(await w.hub.decide(id, "approve", ""), { ok: false, error: "pairing_code_required" });
  for (const bad of ["K7M4P", "K7M#P2", 42, { code: CODE }]) assert.deepEqual(await w.hub.decide(id, "approve", bad), { ok: false, error: "invalid_pairing_code" }, String(bad));
  assert.deepEqual(w.shop.calls, [], "nothing reached the app");
  // Uncounted: five wrong codes are still allowed after all that.
  assert.deepEqual(await w.hub.decide(id, "approve", "AAAAAA"), { ok: false, error: "wrong_pairing_code", attempts_left: 4 });
  // Typed the way a person types it.
  assert.deepEqual(await w.hub.decide(id, "approve", "k7m-4p2"), { ok: true });
  assert.equal((await w.line(id)).status, "paired");
  assert.equal((await w.line(id)).code, undefined);
  assert.deepEqual(w.shop.calls.slice(0, 2), ["initialize", "tools/list"]);
});

test("four wrong codes count down; the fifth removes the request and gives the grant back, once", async (t) => {
  const w = await shopWorld(t);
  const id = (await w.ask()).answer.pairing_id!;
  for (const left of [4, 3, 2, 1]) assert.deepEqual(await w.hub.decide(id, "approve", "AAAAAA"), { ok: false, error: "wrong_pairing_code", attempts_left: left });
  assert.equal((await w.line(id)).status, "pending");
  assert.deepEqual(await w.hub.decide(id, "approve", "AAAAAA"), { ok: false, error: "pairing_code_refused" });
  assert.equal(await w.line(id), undefined, "the request is gone");
  assert.deepEqual(w.shop.calls, ["/apc/revoke"], "the grant was given back, and nothing else was called");
  // The right code now finds nothing.
  assert.deepEqual(await w.hub.decide(id, "approve", CODE), { ok: false, error: "unknown_pairing" });
  assert.deepEqual(w.shop.calls, ["/apc/revoke"]);
});

test("six wrong codes at once count at most five and never pair", async (t) => {
  const w = await shopWorld(t);
  const id = (await w.ask()).answer.pairing_id!;
  const answers = await Promise.all(Array.from({ length: 6 }, () => w.hub.decide(id, "approve", "AAAAAA")));
  assert.equal(answers.filter((a) => a.ok).length, 0);
  assert.equal(answers.filter((a) => a.error === "wrong_pairing_code").length, 4);
  assert.equal(answers.filter((a) => a.error === "pairing_code_refused").length, 1);
  assert.equal(answers.filter((a) => a.error === "unknown_pairing").length, 1);
  assert.equal(await w.line(id), undefined);
  assert.equal(w.shop.calls.filter((c) => c === "/apc/revoke").length, 1);
  assert.equal(w.shop.calls.includes("initialize"), false);
});

test("the right code after two minutes finds nothing: the request went and its grant was given back", async (t) => {
  quick(t, "pairingCodeMs", 50);
  const w = await shopWorld(t);
  const id = (await w.ask()).answer.pairing_id!;
  await sleep(80);
  assert.deepEqual(await w.hub.decide(id, "approve", CODE), { ok: false, error: "unknown_pairing" });
  await w.hub.idle();
  assert.deepEqual(w.shop.calls, ["/apc/revoke"]);
});

test("one request's code does not approve another", async (t) => {
  const w = await shopWorld(t);
  await w.hub.addAgent();
  const a = (await w.ask({ pairing_code: "AAAAAA" })).answer.pairing_id!;
  const b = (await w.ask({ pairing_code: "BBBBBB" }, w.shop, 1)).answer.pairing_id!;
  assert.deepEqual(await w.hub.decide(b, "approve", "AAAAAA"), { ok: false, error: "wrong_pairing_code", attempts_left: 4 });
  assert.deepEqual(await w.hub.decide(b, "approve", "BBBBBB"), { ok: true });
  assert.deepEqual(await w.hub.decide(a, "approve", "AAAAAA"), { ok: true });
});

test("an unverified app's warning Approve with a wrong code approves nothing, not even the domain", async (t) => {
  const w = await world(t);
  const shop = fakeApp(SHOP, "Shop");
  w.apps.set(SHOP, shop);
  const who = await w.agent();
  const { ticket } = await w.hub.ticket(who.id);
  const answer = await w.hub.pair({ ticket, agent: who.id, app: { name: "Shop", origin: SHOP }, mcp_url: `${SHOP}/mcp/${"c".repeat(32)}`, pairing_code: CODE });
  assert.equal(answer.ok, true, answer.error);
  assert.equal((await w.pairingOf(SHOP)).warning, true);
  assert.equal((await w.pairingOf(SHOP)).code, true);
  assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve_unverified", "AAAAAA"), { ok: false, error: "wrong_pairing_code", attempts_left: 4 });
  assert.equal(w.hubRoom.db.prepare("select count(*) as n from unverified_ok").get()!.n, 0, "no approval of the domain");
  assert.equal((await w.pairingOf(SHOP)).warning, true, "the warning still shows");
  assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve_unverified", CODE), { ok: true });
  assert.equal((await w.pairingOf(SHOP)).status, "paired");
});

test("a malformed pairing_code is refused before the ticket is spent, and the ticket then pairs", async (t) => {
  const w = await shopWorld(t);
  const { body } = await w.ask({ pairing_code: null });
  for (const bad of [null, "", 7, "K7M4P", true]) assert.deepEqual(await w.hub.pair({ ...body, pairing_code: bad }), { ok: false, error: "invalid_pairing_code" }, String(bad));
  // A request with no app name is refused before the ticket too.
  assert.deepEqual(await w.hub.pair({ ...body, app: { origin: SHOP } }), { ok: false, error: "app_not_allowed" });
  const ok = (await w.hub.pair({ ...body, pairing_code: CODE })) as { ok: boolean; pairing_code?: string };
  assert.equal(ok.ok, true);
  assert.equal(ok.pairing_code, PAIRING_CODE_ACK);
  // Spent now.
  assert.deepEqual(await w.hub.pair({ ...body, pairing_code: CODE }), { ok: false, error: "ticket_expired" });
});

test("a pairing without a code: when_sent pairs it the old way and counts it; required refuses it with the ticket unspent", async (t) => {
  const points: Json[] = [];
  const analytics = { MCP_SESSIONS: { writeDataPoint: (p: Json) => points.push(p) }, ANALYTICS_SALT: "salt" };
  {
    const w = await shopWorld(t, { ...analytics, PAIRING_CODE: "when_sent" });
    const { answer } = await w.ask({ pairing_code: undefined });
    assert.equal(answer.ok, true, answer.error);
    assert.equal(answer.pairing_code, undefined, "no acknowledgement for a code it never got");
    assert.equal((await w.line(answer.pairing_id!)).code, undefined);
    assert.deepEqual(points, [{ indexes: ["pair_codeless"], blobs: ["pair_codeless", "shop.example", "verified", "dock"], doubles: [1] }]);
    assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve"), { ok: true });
    // A coded one is not counted.
    await w.ask();
    assert.equal(points.length, 1);
  }
  {
    const w = await shopWorld(t, { ...analytics, PAIRING_CODE: "required" });
    const { body, answer } = await w.ask({ pairing_code: undefined });
    assert.deepEqual(answer, { ok: false, error: "pairing_code_required" });
    assert.equal((await w.hub.pair({ ...body, pairing_code: CODE })).ok, true, "the ticket still works");
  }
});

test("coded and older requests expire each at its own time, and the alarm rings at the earlier", async (t) => {
  quick(t, "pairingCodeMs", 200);
  quick(t, "pendingMs", 600);
  const w = await shopWorld(t, { PAIRING_CODE: "when_sent" });
  const legacy = (await w.ask({ pairing_code: undefined })).answer.pairing_id!;
  const before = Date.now();
  const coded = (await w.ask()).answer.pairing_id!;
  const alarm = w.hubRoom.alarm!;
  assert.ok(alarm >= before + 150 && alarm <= Date.now() + 210, `the alarm rings for the coded request: ${alarm - before} ms`);
  await sleep(260);
  await w.hub.alarm();
  assert.equal(await w.line(coded), undefined, "the coded request went at its two minutes");
  assert.equal((await w.line(legacy)).status, "pending", "the older one waits its ten minutes");
  assert.ok(w.hubRoom.alarm! > Date.now() + 100, "the alarm now rings for the older request");
  await sleep(400);
  await w.hub.alarm();
  assert.equal(await w.line(legacy), undefined);
  assert.equal(w.shop.calls.filter((c) => c === "/apc/revoke").length, 2, "both grants given back");
});

test("a drag's ticket lives 240 seconds", async (t) => {
  const w = await shopWorld(t);
  const before = Date.now();
  const { expires_at } = await w.hub.ticket((await w.agent()).id);
  assert.equal(TICKET_TTL_MS, 240_000);
  assert.ok(expires_at >= before + TICKET_TTL_MS && expires_at <= Date.now() + TICKET_TTL_MS);
});

test("deny needs no code", async (t) => {
  const w = await shopWorld(t);
  const id = (await w.ask()).answer.pairing_id!;
  assert.deepEqual(await w.hub.decide(id, "deny"), { ok: true });
  assert.deepEqual(w.shop.calls, ["/apc/revoke"]);
});

test("once PAIRING_CODE is required, a request from before (no code) is no longer approved", async (t) => {
  const w = await shopWorld(t, { PAIRING_CODE: "when_sent" });
  const id = (await w.ask({ pairing_code: undefined })).answer.pairing_id!;
  w.hubEnv.PAIRING_CODE = "required";
  assert.deepEqual(await w.hub.decide(id, "approve"), { ok: false, error: "pairing_code_required" });
  assert.deepEqual(await w.hub.decide(id, "deny"), { ok: true });
});

for (const [label, env] of [["required", { PAIRING_CODE: "required" }], ["unset (fails closed)", { PAIRING_CODE: undefined }], ["misspelled (fails closed)", { PAIRING_CODE: "requred" }]] as const) {
  test(`PAIRING_CODE ${label}: a pairing without a code is refused with nothing reached or counted, and the same ticket pairs with a code`, async (t) => {
    const points: Json[] = [];
    const w = await shopWorld(t, { ...env, MCP_SESSIONS: { writeDataPoint: (p: Json) => points.push(p) }, ANALYTICS_SALT: "salt" });
    const { body, answer } = await w.ask({ pairing_code: undefined });
    assert.deepEqual(answer, { ok: false, error: "pairing_code_required" });
    assert.deepEqual((await w.agent()).pairings, [], "no request in the dock");
    assert.deepEqual(w.shop.calls, [], "nothing reached the app");
    assert.deepEqual(points, [], "not counted as a codeless pairing");
    const coded = (await w.hub.pair({ ...body, pairing_code: CODE })) as { ok: boolean; pairing_id?: string; pairing_code?: string };
    assert.equal(coded.ok, true);
    assert.equal(coded.pairing_code, PAIRING_CODE_ACK);
    assert.deepEqual(await w.hub.decide(coded.pairing_id!, "approve"), { ok: false, error: "pairing_code_required" }, "approving still needs the code");
    assert.deepEqual(await w.hub.decide(coded.pairing_id!, "approve", "k7m-4p2"), { ok: true });
    assert.equal((await w.line(coded.pairing_id!)).status, "paired");
  });
}
