import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalTarget, focusAttrs, parseFocusAttrs, parseParams, parseTarget } from "../src/index.ts";

test("a row, a part of a row, and a figure named by its keys", () => {
  assert.deepEqual(parseTarget({ kind: "customer", id: "cus_0042" }), { kind: "customer", id: "cus_0042", part: null, params: null });
  assert.equal(parseTarget({ kind: "customer", id: "cus_0042", part: "seats" })?.part, "seats");
  assert.deepEqual(parseTarget({ kind: "figure", params: { key: "customer_bridge", month: "2026-03" }, part: "step:new" })?.params, { key: "customer_bridge", month: "2026-03" });
});

test("a target names something: a row or a computation", () => {
  assert.equal(parseTarget({ kind: "figure" }), null);
  assert.equal(parseTarget({ kind: "Figure", params: { key: "x" } }), null);
  assert.equal(parseTarget({ kind: "customer", id: "cus 42" }), null);
});

test("keys only: amounts, free text and nested objects are refused", () => {
  assert.equal(parseParams({ mrr: 1234.57 }), null, "a number is an amount");
  assert.equal(parseParams({ mrr: "1234.57" }), null, "a numeric string is an amount too");
  assert.equal(parseParams({ name: "Blue Harbor Labs" }), null, "free text has spaces");
  assert.equal(parseParams({ nested: { a: "b" } } as never), null);
  assert.equal(parseParams({ Key: "x" }), null, "keys are lower snake case");
  assert.deepEqual(parseParams({ month: "2026-03", lens: ["latam", "na"] }), { month: "2026-03", lens: ["latam", "na"] });
  assert.equal(parseParams({ big: Array.from({ length: 20 }, (_, i) => `${"x".repeat(70)}${i}`) }), null, "at most 1 KB");
});

test("the part grammar of the specification", () => {
  for (const part of ["seats", "step:new", "cell:team|2026-03", "mark:h:0011aabbccddeeff"]) assert.ok(parseTarget({ kind: "figure", params: { key: "k" }, part }), part);
  for (const part of ["Seats", "step:", "step: new", "9x"]) assert.equal(parseTarget({ kind: "figure", params: { key: "k" }, part }), null, part);
});

test("DOM attributes round-trip, and order of params does not change the canonical key", () => {
  const target = { kind: "figure", id: null, part: "step:churned", params: { month: "2026-03", key: "customer_bridge" } };
  const attrs = focusAttrs(target);
  assert.equal(attrs["data-focus"], "figure:");
  const back = parseFocusAttrs(attrs["data-focus"], attrs["data-focus-part"] ?? null, attrs["data-focus-params"] ?? null);
  assert.ok(back);
  assert.equal(canonicalTarget(back), canonicalTarget({ ...target, params: { key: "customer_bridge", month: "2026-03" } }));
  assert.equal(parseFocusAttrs("figure:", null, "{not json"), null);
});
