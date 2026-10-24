import assert from "node:assert/strict";
import { test } from "node:test";
import type { FocusRow } from "@apc/protocol";
import { generateDataset } from "../src/model/seed.ts";
import { checkPin, customerAnswer, figureAnswer, listCustomers, resolveFocus, sanitizeView, trimView, type Grant } from "../src/worker/domain.ts";

const data = generateDataset(7);
const ORIGIN = "https://demo.example";
const full: Grant = { id: "g_full", secret: "a", label: "Your agent", client_name: "Claude Code", regions: null, created_at: "", last_active_at: null };
const latam: Grant = { ...full, id: "g_latam", secret: "b", label: "Restricted", regions: ["latam"] };
const inLatam = data.customers.find((c) => c.region === "latam")!;
const inNa = data.customers.find((c) => c.region === "na")!;

const pin = (target: Partial<FocusRow>): FocusRow => ({ grant_id: "g", kind: "figure", id: null, part: null, params: null, pinned_at: "2026-10-15T12:00:00.000Z", seen_at: null, ...target });

test("the view keeps allowlisted keys only and drops the rest before it is stored", () => {
  const view = sanitizeView({ screen: "customers", params: { month: "2026-03", plan: "team", search: "Blue Harbor", mrr: "1234.57" }, selection: null }, data);
  assert.deepEqual(view?.params, { month: "2026-03", plan: "team" });
  assert.equal(sanitizeView({ screen: "billing", params: {} }, data), null);
  assert.equal(sanitizeView({ screen: "customer", params: {}, selection: { kind: "customer", id: "Robert'); drop" } }, data)?.selection, null);
});

test("a by-id screen outside the grant is null, the same as no view; a region outside it is cut", () => {
  const onNa = sanitizeView({ screen: "customer", params: { month: "2026-03" }, selection: { kind: "customer", id: inNa.id } }, data);
  assert.equal(trimView(onNa, latam, data, ORIGIN), null);
  assert.equal(trimView(onNa, full, data, ORIGIN)?.next, "get_customer");
  const overview = sanitizeView({ screen: "overview", params: { month: "2026-03", region: "na" } }, data);
  const trimmed = trimView(overview, latam, data, ORIGIN);
  assert.deepEqual(trimmed?.params, { month: "2026-03" });
  assert.equal(trimmed?.app_url, `${ORIGIN}/overview?month=2026-03`, "the deep link is rebuilt from what survived, never copied");
});

test("a restricted agent cannot be pointed outside its regions", () => {
  assert.deepEqual(checkPin({ kind: "customer", id: inNa.id }, latam, data), { error: "out_of_grant" });
  assert.ok("target" in checkPin({ kind: "customer", id: inLatam.id, part: "seats" }, latam, data));
  assert.deepEqual(checkPin({ kind: "figure", params: { key: "active_customers", month: "2026-03", region: "emea" } }, latam, data), { error: "out_of_grant" });
  assert.ok("target" in checkPin({ kind: "figure", params: { key: "active_customers", month: "2026-03" } }, latam, data), "a figure over all regions may be pointed: it is answered trimmed");
  assert.deepEqual(checkPin({ kind: "figure", params: { key: "active_customers", month: "2026-03", amount: "100" } }, full, data), { error: "invalid_target" });
  assert.deepEqual(checkPin({ kind: "figure", params: { key: "customer_bridge", month: "2026-03" }, part: "step:refunds" }, full, data), { error: "invalid_target" });
});

test("each kind keeps only its own params: a customer pin none, a figure pin the keys its spec reads", () => {
  for (const params of [{ note: "SECRET-1234.57" }, { month: "2026-03" }, {}]) {
    assert.deepEqual(checkPin({ kind: "customer", id: "cus_0001", params }, full, data), { error: "invalid_target" }, JSON.stringify(params));
  }
  assert.ok("target" in checkPin({ kind: "customer", id: inLatam.id, params: null }, full, data), "null params is the same as none");
  assert.deepEqual(checkPin({ kind: "figure", params: { key: "active_customers", month: "2026-09", mrr: "1234.57" } }, full, data), { error: "invalid_target" });
  assert.deepEqual(checkPin({ kind: "figure", params: { key: "active_customers", month: "2026-09", note: "SECRET-1234.57" } }, full, data), { error: "invalid_target" }, "a key that passes the token grammar is still not one the spec reads");
  assert.deepEqual(checkPin({ kind: "figure", params: { key: "customer_bridge", month: "2026-03", plan: "team" } }, full, data), { error: "invalid_target" }, "plan is a key of active_customers, not of the bridge");
  assert.ok("target" in checkPin({ kind: "customer", id: inLatam.id, part: "seats" }, full, data));
  assert.ok("target" in checkPin({ kind: "figure", params: { key: "active_customers", month: "2026-03", plan: "team", region: "na" } }, full, data));
  assert.ok("target" in checkPin({ kind: "figure", params: { key: "customer_bridge", month: "2026-03" }, part: "step:churned" }, full, data));
});

test("the focus names the tool and the exact arguments that read the pointed thing", () => {
  const step = resolveFocus(pin({ part: "step:churned", params: { key: "customer_bridge", month: "2026-03" } }), full, data, ORIGIN);
  assert.equal(step?.next, "get_figure");
  assert.deepEqual(step?.next_args, { key: "customer_bridge", params: { month: "2026-03", step: "churned" } });
  assert.match(step?.part_note ?? "", /breakdown\.churned/);
  assert.equal(step?.trimmed, null);

  const row = resolveFocus(pin({ kind: "customer", id: inLatam.id, part: "seats" }), full, data, ORIGIN);
  assert.deepEqual(row && { next: row.next, next_args: row.next_args, app_url: row.app_url }, { next: "get_customer", next_args: { id: inLatam.id }, app_url: `${ORIGIN}/customers/${inLatam.id}` });

  assert.equal(resolveFocus(pin({ kind: "customer", id: inNa.id }), latam, data, ORIGIN), null, "a pin outside the grant reads as no pin");
  assert.deepEqual(resolveFocus(pin({ params: { key: "active_customers", month: "2026-03" } }), latam, data, ORIGIN)?.trimmed, { hidden_entities: 2 });
});

test("a figure over all regions, read by a restricted agent, is cut to its region and says how many it hid", () => {
  const whole = figureAnswer(data, full, "active_customers", { month: "2026-03" }, ORIGIN);
  const cut = figureAnswer(data, latam, "active_customers", { month: "2026-03" }, ORIGIN);
  assert.ok(!("error" in whole) && !("error" in cut));
  assert.deepEqual(cut.trimmed, { hidden_entities: 2 });
  assert.equal(whole.trimmed, null);
  assert.ok(cut.values.active! < whole.values.active!);
  assert.ok(cut.breakdown.customers!.every((c) => c.region === "latam"));
  assert.ok(!JSON.stringify(cut).includes(inNa.id), "no id outside the grant leaks");
});

test("keys only on the read side too, and a hidden customer is the same not_found as an unknown one", () => {
  assert.equal((figureAnswer(data, full, "active_customers", { month: "2026-03", mrr: "1234.57" }, ORIGIN) as { error?: string }).error, "invalid_params");
  assert.equal((figureAnswer(data, full, "revenue", { month: "2026-03" }, ORIGIN) as { error?: string }).error, "unknown_figure");
  assert.deepEqual(customerAnswer(data, latam, inNa.id, ORIGIN), customerAnswer(data, latam, "cus_9999", ORIGIN));
  assert.ok(listCustomers(data, latam, {}).rows.every((r) => r.region === "latam"));
});

test("a whole-chart pin (part series) is accepted and tells the agent it is the trend (TIN-357)", () => {
  const target = { kind: "figure", id: null, part: "series", params: { key: "active_customers", month: "2026-03" } };
  assert.ok("target" in checkPin(target, full, data));
  assert.deepEqual(checkPin({ ...target, part: "trend" }, full, data), { error: "invalid_target" });
  const focus = resolveFocus(pin({ part: "series", params: { key: "active_customers", month: "2026-03" } }), full, data, ORIGIN);
  assert.equal(focus?.next, "get_figure");
  assert.deepEqual(focus?.next_args, { key: "active_customers", params: { month: "2026-03" } });
  assert.match(focus?.part_note ?? "", /whole chart/);
  const bridge = { kind: "figure", id: null, part: null, params: { key: "customer_bridge", month: "2026-03" } };
  assert.ok("target" in checkPin(bridge, full, data), "the whole bridge is its card");
});
