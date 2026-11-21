// The landing hero's data is Pulse's real output, without coupling the apps: the site may not import apps/demo, so
// apps/site/src/web/hero-data.json is committed, and this test recomputes it with Pulse's own code (scripts/build-hero-data.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HERO_DATA_PATH, HERO_MONTHS, heroData, topTwo } from "../build-hero-data.mjs";
import { FOCUS_EXAMPLE } from "../../apps/site/src/web/landing-example.ts";

const committed = JSON.parse(readFileSync(HERO_DATA_PATH, "utf8"));

test("hero-data.json is what Pulse computes today: run node scripts/build-hero-data.mjs after a change to Pulse's data or reads", () => {
  assert.deepEqual(committed, heroData());
});

test("the hero holds the chart's eight months, each with its focus, its get_figure answer and its two customers with the most seats", () => {
  assert.deepEqual(committed.months.map((m) => m.month), HERO_MONTHS);
  for (const m of committed.months) {
    assert.deepEqual(m.focus.params, { key: "active_customers", month: m.month });
    assert.equal(m.focus.next, "get_figure");
    assert.deepEqual(m.get_figure.params, m.focus.next_args.params, "get_figure is read with the focus's next_args");
    assert.equal(m.get_figure.values.active, m.get_figure.breakdown.customers.length);
    assert.deepEqual(m.get_customer.map((c) => c.customer.id), topTwo(m.get_figure.breakdown.customers).map((c) => c.customer_id));
  }
});

test("March's focus is the one the build page shows", () => {
  assert.deepEqual(committed.months.find((m) => m.month === "2026-03").focus, FOCUS_EXAMPLE);
});
