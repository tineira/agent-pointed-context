// /try's examples (TIN-1094) are Pulse's real numbers, without coupling the apps: the site may not import apps/demo
// (site-boundaries.test.mjs), so apps/site/src/web/try-examples.ts writes them down, and this test recomputes each one
// with Pulse's own code from the demo's one shared world (DEMO_SEED), as pulse.apc.tineira.com computes it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { demoDataset, pulseCustomerPath } from "../../apps/demo/src/model/demo-world.ts";
import { activeCustomers, customerBridge, FIGURES, FULL_SCOPE } from "../../apps/demo/src/model/figures.ts";
import { LAST_MONTH, MONTHS } from "../../apps/demo/src/model/seed.ts";
import { customerAnswer } from "../../apps/demo/src/worker/domain.ts";
import { TRY_BAR, TRY_BRIDGE, TRY_CUSTOMER_ROW } from "../../apps/site/src/web/try-examples.ts";

const data = demoDataset();
const ORIGIN = "https://pulse.apc.tineira.com";
/** A connected agent that may read every region, as the examples assume. */
const GRANT = { id: "g", secret: "s", label: "Your agent", client_name: "Claude", regions: null, created_at: "", last_active_at: null };

test("the bar: March 2026 is 123 active customers, and the drawing is the chart's eighteen bars", () => {
  const figure = activeCustomers(data, { month: TRY_BAR.month }, FULL_SCOPE);
  assert.equal(TRY_BAR.month, "2026-03");
  assert.equal(TRY_BAR.active, 123);
  assert.equal(figure.values.active, TRY_BAR.active);
  assert.deepEqual(TRY_BAR.series, figure.series.map((s) => s.value), "the bars, Apr 2025 to Sep 2026");
  assert.equal(TRY_BAR.firstMonth, MONTHS[0]);
  assert.equal(figure.series[TRY_BAR.series.indexOf(TRY_BAR.active)].month, TRY_BAR.month, "the accented bar is March");
  assert.equal(MONTHS.indexOf(TRY_BAR.month), 11, "try.tsx's BAR_ON");
  // Each active customer has the plan and seats the questions ask about.
  for (const c of figure.breakdown.customers) assert.ok(c.plan && Number.isInteger(c.seats), c.customer_id);
  assert.equal(TRY_BAR.path, FIGURES.active_customers.path({ month: TRY_BAR.month }), "the chart's own deep link");
});

test("the customer: cus_0109 is Lumen Delta Systems, business, latam, 281 seats in the month Customers opens on", () => {
  const answer = customerAnswer(data, GRANT, TRY_CUSTOMER_ROW.id, ORIGIN);
  assert.ok(!("error" in answer), "Pulse knows the customer");
  assert.equal(TRY_CUSTOMER_ROW.id, "cus_0109");
  assert.equal(answer.customer.name, TRY_CUSTOMER_ROW.name);
  assert.equal(answer.customer.plan, TRY_CUSTOMER_ROW.plan);
  assert.equal(answer.customer.region, TRY_CUSTOMER_ROW.region);
  assert.equal(TRY_CUSTOMER_ROW.month, LAST_MONTH, "Customers opens on the last month");
  assert.equal(answer.activity.find((a) => a.month === LAST_MONTH)?.seats, TRY_CUSTOMER_ROW.seats);
  assert.equal(TRY_CUSTOMER_ROW.seats, 281);
  // What the two questions ask: a signup month, and one activity entry per month with active and seats.
  assert.match(answer.customer.signup_month, /^\d{4}-\d{2}$/);
  assert.deepEqual(answer.activity.map((a) => a.month), MONTHS.slice(MONTHS.indexOf(answer.customer.signup_month)));
  for (const a of answer.activity) assert.ok(typeof a.active === "boolean" && Number.isInteger(a.seats), a.month);
  assert.equal(TRY_CUSTOMER_ROW.path, pulseCustomerPath(TRY_CUSTOMER_ROW.id));
  assert.equal(`${ORIGIN}${TRY_CUSTOMER_ROW.path}`, answer.app_url, "the customer's own deep link");
});

test("the bridge: September 2026 is 146, +13, +1, −8, 152, and the churned step lists who left with their seats", () => {
  const bridge = customerBridge(data, { month: TRY_BRIDGE.month }, FULL_SCOPE);
  assert.equal(TRY_BRIDGE.month, "2026-09");
  assert.deepEqual(bridge.values, { start: 146, new: 13, reactivated: 1, churned: 8, end: 152 });
  const sign = { start: "", new: "+", reactivated: "+", churned: "−", end: "" };
  assert.deepEqual(TRY_BRIDGE.steps.map((s) => s.value), TRY_BRIDGE.steps.map((s) => `${sign[s.step]}${bridge.values[s.step]}`));
  assert.deepEqual(TRY_BRIDGE.steps.map((s) => s.step), ["start", "new", "reactivated", "churned", "end"]);
  assert.equal(TRY_BRIDGE.pointed, "churned");
  // "Who are these customers?" and "How many seats left with them?": the churned step names each, with seats_prev.
  const churned = customerBridge(data, { month: TRY_BRIDGE.month, step: "churned" }, FULL_SCOPE).breakdown.churned;
  assert.equal(churned.length, 8);
  for (const c of churned) assert.ok(c.customer_id && Number.isInteger(c.seats_prev) && c.seats_prev > 0, c.customer_id);
  assert.equal(TRY_BRIDGE.path, FIGURES.customer_bridge.path({ month: TRY_BRIDGE.month }), "the bridge's own deep link");
});
