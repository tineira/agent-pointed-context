import assert from "node:assert/strict";
import { test } from "node:test";
import { canary, spellings } from "../lib/canary.mjs";

const csv = "customer_id,month,mrr\ncus_0001,2026-09,1234.57\ncus_0002,2026-09,88.13\ncus_0003,2026-09,40.12\ncus_0004,2026-09,2500.00\n";
const line = (event) => JSON.stringify(event) + "\n";
const clean = [
  line({ id: 1, at: "2026-10-19T12:08:40.123Z", type: "inbound", grant_id: "g", tool: "list_customers", args: { month: "2026-09" } }),
  line({ id: 2, at: "2026-10-19T12:08:41.000Z", type: "tool_call", grant_id: "g", tool: "list_customers", ms: 3, args_bytes: 19 }),
].join("");

test("a clean log: nothing found, and a timestamp that contains a value's digits is not a hit", () => {
  const result = canary(clean, csv);
  assert.deepEqual(result.found, [], "40.12 is inside 08:40.123Z but not a number there");
  assert.equal(result.values, 4);
  assert.equal(result.inbound, 1);
  assert.equal(result.args_bytes, new TextEncoder().encode(JSON.stringify({ month: "2026-09" })).length);
});

test("a value the agent sent is found", () => {
  const log = clean + line({ id: 3, at: "2026-10-19T12:09:00.000Z", type: "inbound", grant_id: "g", tool: "get_figure", args: { key: "active_customers", params: { month: "2026-09", note: "88.13" } } });
  assert.deepEqual(canary(log, csv).found, ["88.13"]);
  assert.equal(canary(log, csv).inbound, 2);
});

test("a value written with a thousands separator, or without .00, is found too", () => {
  assert.deepEqual(spellings("1234.57"), ["1234.57", "1,234.57"]);
  assert.deepEqual(spellings("2500.00"), ["2500.00", "2,500.00", "2500", "2,500"]);
  const log = clean + line({ type: "inbound", tool: "list_customers", args: { q: "mrr 1,234.57" } }) + line({ type: "inbound", tool: "list_customers", args: { q: "about 2,500 a month" } });
  assert.deepEqual(canary(log, csv).found, ["1234.57", "2500.00"]);
  assert.deepEqual(canary(clean + line({ type: "inbound", args: { q: "12500" } }), csv).found, [], "2500 inside 12500 is another number");
});
