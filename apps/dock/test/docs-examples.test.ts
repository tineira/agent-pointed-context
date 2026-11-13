/**
 * The docs' Orders example (apps/dock/src/docs/examples, shown at /docs/integrate and /docs/conformance) is a
 * conforming APC app: the conformance suite runs against it on both profiles, the apc_link checks with Direct.
 * The samples type-check through apps/dock/tsconfig.docs.json (`pnpm typecheck`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { OrdersApp } from "../src/docs/examples/orders-app.ts";
import { apcConformance } from "@tineira/apc-conformance";
import { ordersChecks, ordersUnderTest } from "../src/docs/examples/orders-conformance.ts";

/**
 * The suite's Dock checks of APC 0.10 (TIN-884) that the Orders example does not meet yet: they run, as todo, until
 * TIN-892 brings Orders to 0.10 and removes this list. Only these.
 */
const PENDING_TIN_892_ORDERS = [
  "the lifecycle adapter is given (required of an app that claims 0.10.0 or later on the Dock profile)",
  "the answer table: in flight (from the Allow to the hub's acknowledgement), and a 404 leaves the state unchanged",
  "the answer table: handoff (the pairing error, no attention, then or apc_link), and initialize commits it",
  "the answer table: live",
  "the answer table: dormant (the idle shapes and the idle error, no attention, then or apc_link)",
  "the answer table: ended (a give-back on a grant in handoff)",
  "the answer table: revoked (Cancel on a grant in handoff)",
  "initialize fails closed: a commit that cannot persist returns no result, and the grant stays in handoff",
  "a commit racing Cancel ends by the state that won, and Cancel never revokes a live grant",
  "the acknowledgement's move is conditional: a give-back or T_ack while in flight ends the grant for good",
  "T_ack: a grant whose Allow never heard back ends within 30 s, across a restart of the app",
  "T_connect: a grant with no committed initialize ends within 10 minutes of the acknowledgement",
  "T_idle: a live grant with no wake action sleeps, and a wake action (the page's heartbeat) wakes it",
  "agent traffic (initialize, ping, tools/list, tools/call) never wakes a grant or extends it",
  "M1: the drop's hub is parsed and compared by origin with the allowlist, on the drop and again on the Allow",
  "M2: a hub that redirects, answers a 3xx, an opaqueredirect or a redirected answer holds no grant",
  "M3: a hub whose body stalls trips the one deadline (10 s at most, headers and body)",
  "M4: the byte cap and the content-length rules",
  "M5: no lock across the hub call: owner requests answer while it is held, and a second Allow of the same agent gets pairing_in_progress",
  "M9: hub requests go to the parsed origin, never to the raw hub string",
  "M6: the owner endpoints refuse a foreign Origin, Sec-Fetch-Site cross-site and same-site, a non-JSON media type, a GET and no session; a request with neither header is taken on the session",
  "M7: /apc/revoke answers the same 200 to any input, ends a matching grant (then 404), and leaves revoked and ended grants as they are",
  "M8: apc.json lists dock only while the app can pair, cached 60 s at most",
  "one pending pairing: a second drop on a pending pairing shows the same code, with no new consent and no new /apc/pair",
  "one pending pairing: not_paired from /apc/confirm ends the grant and starts a fresh consent",
  "one pending pairing: paired before the app saw initialize stays in handoff, and only initialize makes it live",
  "one pending pairing: before the acknowledgement a new drop replaces the consent, and the stale Allow gets consent_expired",
];
const pending = (name: string) => PENDING_TIN_892_ORDERS.some((p) => name.endsWith(`(dock): 0.10: ${p}`));

for (const profile of ["direct", "dock"] as const) {
  for (const check of ordersChecks(profile, { link: profile === "direct" })) test(check.name, pending(check.name) ? { todo: "TIN-892: Orders meets APC 0.10" } : {}, check.run);
}

test("a page whose stream died is dropped, and the tool call that published to it still answers", async () => {
  const origin = "https://orders.test";
  const app = new OrdersApp({ origin, profiles: ["direct"] });
  // A page whose stream closed without the server hearing of it: sending to it throws, as enqueue on a closed stream does.
  const pages = (app as unknown as { pages: Set<(message: unknown) => void> }).pages;
  pages.add(() => {
    throw new TypeError("Invalid state: ReadableStream is closed");
  });
  const made = (await (await app.fetch(new Request(`${origin}/api/agents`, { method: "POST", body: "{}" }))).json()) as { url: string };
  const response = await app.fetch(
    new Request(made.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_orders", arguments: {} } }),
    }),
  );
  const body = (await response.json()) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> }; error?: unknown };
  assert.equal(response.status, 200);
  assert.equal(body.error, undefined);
  assert.notEqual(body.result?.isError, true);
  assert.ok(Array.isArray(body.result?.structuredContent?.orders), "the tool's own result");
  assert.equal(pages.size, 0, "the dead page is gone");
  assert.equal(body.result?.structuredContent?.then, undefined, "with no page open, no then");
});

/** Orders with its server's calls to the hub rewritten: a broken app, as the pairing-code checks must catch it. */
function brokenOrders(rewrite: (send: typeof fetch) => typeof fetch) {
  const { app, adapter } = ordersUnderTest("dock");
  const inner = app as unknown as { send: typeof fetch };
  inner.send = rewrite(inner.send);
  return apcConformance(adapter);
}
const named = (checks: ReturnType<typeof apcConformance>, part: string) => checks.find((c) => c.name.includes(part))!;

test("the pairing-code checks fail an app that claims 0.9 on the Dock profile without the dock adapter", async () => {
  const { adapter } = ordersUnderTest("dock");
  const { dock: _dock, ...without } = adapter;
  await assert.rejects(named(apcConformance(without), "the dock adapter is given").run(), /requires the pairing code to be checked/);
});

test("the pairing-code checks fail an app that sends the hub no code", async () => {
  const checks = brokenOrders((send) => (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    delete body.pairing_code;
    return send(url, { ...init, body: JSON.stringify(body) });
  }) as typeof fetch);
  // Its own pairWithHub then refuses the hub that took no code (no acknowledgement), so the check fails either way.
  await assert.rejects(named(checks, "sends that code").run(), /without pairing_code|hub_ignores_pairing_code/);
});

test("the pairing-code checks fail an app that keeps a grant the hub did not acknowledge", async () => {
  const ack = { ok: true, pairing_id: "pr_x", status: "pending", agent: { name: "A", icon: null }, pairing_code: "required" };
  const checks = brokenOrders((send) => (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await send(url, { ...init, redirect: "follow" });
    // As if the app believed any yes: an unacknowledged one, a redirected one, a 500.
    return String(url).endsWith("/apc/pair") && response.status !== 400 ? Response.json(ack) : response;
  }) as typeof fetch);
  await assert.rejects(named(checks, "holds no grant").run(), /the Allow says it paired/);
});

test("Orders: a drop that pairs but cannot pin its target answers ok with the waiting code and pin_error, which its page shows", async () => {
  const { app, adapter } = ordersUnderTest("dock");
  const hub = adapter.dock!.hub;
  const call = async (body: unknown) => (await app.fetch(new Request("https://orders.test/api/drop", { method: "POST", body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;
  const drop = { hub: hub.origin, agent: "ag_pin", ticket: hub.ticket("ag_pin"), target: { kind: "order", id: "ord_9999" } };
  const asked = await call(drop);
  const paired = await call({ ...drop, consent: asked.consent });
  assert.equal(paired.ok, true);
  assert.equal(paired.status, "pending");
  assert.equal((paired.pairing as { code: string }).code, asked.pairing_code);
  assert.equal(paired.pin_error, "invalid_target");
  assert.deepEqual(app.agents().find((a) => a.id === paired.grant_id)?.pairing, paired.pairing, "the page's waiting row has the code");
});
