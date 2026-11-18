/**
 * The wake engine (TIN-973; Wake on pin, experimental): the state machine the dock's hub and an app run, over
 * `kvWakeStore` and a host stand-in, with the webhook stubbed at fetch and the clock mocked.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ApcLinks, DockConsent, kvWakeStore, memoryKv, WAKE_DAY_MAX, wakeAppPlace, WakeEngine, type ApcKv, type WakeHost } from "../src/index.ts";

const WEBHOOK = "https://api2.cursor.sh/automations/webhook/99c9ef5d-fff0-4abc-9def-0123456789ab";
const KEY = "test-key-0123456789abcdef";
const ID = "g_0a1b2c3d";
const OTHER = "g_4e5f6071";

/** An engine over a memory kv, a host whose answers the test sets, and the webhook stubbed: `hold` keeps it from answering. */
function engine(t: TestContext, options: { shared?: string } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-17T12:00:00.000Z") });
  const kv = memoryKv();
  const store = kvWakeStore(kv);
  const host = {
    alive: true,
    live: true,
    covered: false,
    offered: true,
    deferred: false,
    throws: false,
    arms: 0,
    changes: 0,
  };
  const hostImpl: WakeHost = {
    alive: () => host.alive,
    live: () => {
      if (host.throws) throw new Error("host failed");
      return host.live;
    },
    covered: () => host.covered,
    offered: () => host.offered,
    deferred: () => host.deferred,
    arm: async () => void host.arms++,
    changed: () => void host.changes++,
  };
  const e = new WakeEngine(store, hostImpl, { place: wakeAppPlace("Orders"), ...(options.shared ? { sharedScope: options.shared } : {}) });
  const sent: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const hook = { answer: 202, hold: false, aborted: 0, release: () => {} };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    if (hook.hold) {
      await new Promise<void>((resolve, reject) => {
        hook.release = resolve;
        init?.signal?.addEventListener("abort", () => {
          hook.aborted++;
          reject(new Error("aborted"));
        });
      });
    }
    return new Response(null, { status: hook.answer });
  });
  const pass = async (ms: number) => {
    t.mock.timers.tick(ms);
    await e.idle();
    await e.idle();
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { e, kv, store, host, sent, hook, pass, flush };
}

test("kvWakeStore keeps a webhook, its budget, hint and decline under their own keys, never on apc_link's or consent's", async () => {
  const kv: ApcKv = memoryKv();
  const store = kvWakeStore(kv);
  const links = new ApcLinks(kv, { appName: "Orders", grants: () => [{ id: ID, path: "direct" }, { id: OTHER, path: "dock" }] });
  const consent = new DockConsent(kv);
  consent.ask("https://dock.test", "ag_1 t connect");
  kv.put(`link:${ID}`, OTHER);
  kv.put(`link:${OTHER}`, ID);
  links.arrived(ID, "Cursor");
  const row = { gen: "g1", url: WEBHOOK, key: KEY, created_at: "x", sent_at: null, status: null, status_at: null, pending_at: 5, pending_kind: "pin", pending_source: ID, due: 7, delivered_at: null, delivered_event: null, delivered_outcome: null, delivered_code: null };
  store.put(ID, row);
  store.setBudget(ID, { day: "2026-11-17", count: 3 });
  store.setHint(ID, 11);
  store.setDeclined(ID, 12);
  assert.deepEqual(store.get(ID), row);
  assert.deepEqual(store.pending(), [{ id: ID, due: 7 }]);
  assert.deepEqual([store.hint(ID), store.declined(ID)], [11, 12]);
  const others = () => kv.list("").filter(([k]) => !k.startsWith("wake")).map(([k]) => k);
  const before = others();
  assert.ok(before.length >= 4, "links, session and consent keys are there");
  // A grant's end in apc_link leaves the wake keys; the wake's purge leaves apc_link's and consent's.
  links.forget(OTHER);
  assert.deepEqual(store.get(ID), row);
  store.purge(ID);
  assert.equal(store.get(ID), null);
  assert.equal(store.hint(ID), null);
  assert.equal(store.declined(ID), null);
  assert.deepEqual(store.budget(ID), { day: "2026-11-17", count: 3 }, "an app keeps the budget: the shared scope bounds it");
  assert.ok(others().includes(`session:${ID}`));
  assert.ok(others().some((k) => k.startsWith("consent:")));
  store.put(OTHER, row);
  store.removeAll();
  assert.equal(store.get(OTHER), null);
  assert.ok(others().includes(`session:${ID}`), "removeAll touches only webhooks");
});

test("a pin makes a wake due after it settles; a second pin keeps that due and becomes the one to cover", async (t) => {
  const { e, store, sent, pass } = engine(t);
  assert.deepEqual(e.set(ID, { url: WEBHOOK, key: KEY }), { ok: true });
  const t0 = Date.now();
  e.demand(ID, "pin", "first");
  assert.equal(store.get(ID)!.due, t0 + 2_000);
  t.mock.timers.tick(500);
  e.demand(ID, "page_reading", "second");
  const w = store.get(ID)!;
  assert.equal(w.due, t0 + 2_000, "not pushed out");
  assert.equal(w.pending_at, t0 + 500);
  assert.equal(w.pending_source, "second");
  assert.equal(e.nextDue(), t0 + 2_000);
  await pass(1_500);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.authorization, `Bearer ${KEY}`);
  assert.deepEqual({ ...sent[0]!.body, at: null }, { v: 1, event: "pin", kind: "page_reading", at: null });
  // The next pin waits for the 15 s gap since that wake.
  e.demand(ID, "pin", "third");
  assert.equal(store.get(ID)!.due, store.get(ID)!.sent_at! + 15_000);
});

test("a pin during the POST keeps its pending wake: the outcome is written on the row read again, by gen", async (t) => {
  const { e, store, hook, sent, flush } = engine(t);
  e.set(ID, { url: WEBHOOK, key: KEY });
  hook.hold = true;
  e.demand(ID, "pin", ID);
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(sent.length, 1);
  // The person points again while the POST is in flight.
  e.demand(ID, "pin", ID);
  const pending = store.get(ID)!;
  assert.ok(pending.pending_at);
  hook.release();
  await e.idle();
  const after = store.get(ID)!;
  assert.equal(after.status, "ok");
  assert.equal(after.delivered_outcome, "ok");
  assert.equal(after.pending_at, pending.pending_at, "the pin that came during the POST is not lost");
  assert.equal(after.due, pending.due);
  // Set again during a POST: the old POST is cut, and its outcome lands on nothing.
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(sent.length, 2);
  e.set(ID, { url: WEBHOOK, key: `${KEY}2` });
  await e.idle();
  assert.equal(hook.aborted, 1);
  assert.equal(store.get(ID)!.status, null);
  assert.equal(store.get(ID)!.delivered_at, null);
});

test("Turn off keeps the day's budget, the hint and the decline; setting it again starts the webhook clean", async (t) => {
  const { e, store, sent } = engine(t);
  e.set(ID, { url: WEBHOOK, key: KEY });
  assert.deepEqual(await e.test(ID), { ok: true, status: "ok" });
  store.setHint(ID, 1);
  e.clear(ID);
  assert.equal(store.get(ID), null);
  assert.equal(store.budget(ID)!.count, 1);
  assert.equal(store.hint(ID), 1);
  e.set(ID, { url: WEBHOOK, key: KEY });
  assert.equal(store.get(ID)!.delivered_at, null);
  store.setBudget(ID, { day: "2026-11-17", count: WAKE_DAY_MAX });
  t.mock.timers.tick(10_000);
  assert.deepEqual(await e.test(ID), { ok: false, error: "limit" });
  assert.equal(sent.length, 1);
});

test("purge ends what a grant held: its webhook, hint and decline, its POST in flight and its last test's time", async (t) => {
  const { e, store, hook, flush } = engine(t);
  e.set(ID, { url: WEBHOOK, key: KEY });
  store.setHint(ID, 1);
  e.setup(ID, "https://orders.test/agents#wake", {});
  hook.hold = true;
  const testing = e.test(ID);
  await flush();
  e.purge(ID);
  assert.deepEqual(await testing, { ok: true, status: "error" });
  assert.equal(hook.aborted, 1);
  assert.equal(store.get(ID), null);
  assert.equal(store.hint(ID), null);
  // A grant that takes the id later starts with no webhook and no test gap; the budget is still counted.
  hook.hold = false;
  e.set(ID, { url: WEBHOOK, key: KEY });
  assert.deepEqual(await e.test(ID), { ok: true, status: "ok" });
  assert.equal(store.budget(ID)!.count, 2);
});

test("while Start over is under way no webhook is set and no wake is made due", async (t) => {
  const { e, store, sent, pass } = engine(t);
  e.set(ID, { url: WEBHOOK, key: KEY });
  e.beginReset();
  assert.deepEqual(e.set(OTHER, { url: WEBHOOK, key: KEY }), { ok: false, error: "unknown" });
  e.demand(ID, "pin", ID);
  assert.equal(store.get(ID)!.pending_at, null);
  e.endReset();
  e.demand(ID, "pin", ID);
  await pass(3_000);
  assert.equal(sent.length, 1);
});

test("deliverDue leaves no due in the past, whatever each wake comes to", async (t) => {
  const cases: Array<[string, (h: ReturnType<typeof engine>["host"], s: ReturnType<typeof engine>["store"]) => void, number]> = [
    ["covered", (h) => void (h.covered = true), 0],
    ["source gone", (h) => void (h.live = false), 0],
    ["not offered", (h) => void (h.offered = false), 0],
    ["deferred", (h) => void (h.deferred = true), 0],
    ["over budget", (_h, s) => s.setBudget(ID, { day: "2026-11-17", count: WAKE_DAY_MAX }), 0],
    ["host threw", (h) => void (h.throws = true), 0],
    ["sent", () => {}, 1],
  ];
  for (const [name, arrange, posts] of cases) {
    await t.test(name, async (tt) => {
      const { e, store, host, sent } = engine(tt);
      e.set(ID, { url: WEBHOOK, key: KEY });
      e.demand(ID, "pin", ID);
      // The object was evicted: its timer is gone, the alarm rings once the wake is due.
      e.stopAll();
      tt.mock.timers.tick(5_000);
      arrange(host, store);
      e.deliverDue();
      const next = e.nextDue();
      assert.ok(next === null || next > Date.now(), `${name}: next due ${next} at ${Date.now()}`);
      await e.idle();
      assert.equal(sent.length, posts, name);
    });
  }
});

test("a shared scope caps every id together: a new id gets no fresh budget beyond it", async (t) => {
  const { e, store } = engine(t, { shared: "sandbox" });
  store.setBudget("sandbox", { day: "2026-11-17", count: WAKE_DAY_MAX - 1 });
  e.set(ID, { url: WEBHOOK, key: KEY });
  e.set(OTHER, { url: WEBHOOK, key: KEY });
  assert.deepEqual(await e.test(ID), { ok: true, status: "ok" });
  assert.deepEqual(await e.test(OTHER), { ok: false, error: "limit" });
  assert.equal(store.budget(OTHER), null, "a refusal spends nothing");
});

test("only Grok Bot's trigger is ever called, and the key never shows in the view or the setup", async (t) => {
  const { e, store, sent } = engine(t);
  e.set(ID, { url: WEBHOOK, key: KEY });
  // A row that holds something else (written by hand, or by a bug) is never called.
  store.put(ID, { ...store.get(ID)!, url: "https://evil.test/automations/webhook/99c9ef5d" });
  assert.deepEqual(await e.test(ID), { ok: true, status: "error" });
  assert.equal(sent.length, 0);
  store.put(ID, { ...store.get(ID)!, url: WEBHOOK });
  const said = JSON.stringify([e.view(ID), e.setup(ID, "https://orders.test/agents#wake-x")]);
  assert.ok(!said.includes(KEY));
  assert.ok(!said.includes("99c9ef5d-fff0"));
  assert.equal(e.view(ID)!.url_tail, "6789ab");
});
