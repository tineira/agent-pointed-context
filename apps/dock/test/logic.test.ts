import assert from "node:assert/strict";
import { test } from "node:test";
import { appAllowed, appIdFor, combineAttendance, detachKeys, errorOf, focusLabel, hubFocus, newest, readsPin } from "../src/worker/logic.ts";

test("an app's id: short, from its name, numbered on a collision (TIN-382)", () => {
  assert.equal(appIdFor("Pulse", new Set()), "pulse");
  assert.equal(appIdFor("Pulse", new Set(["pulse"])), "pulse2");
  assert.equal(appIdFor("Pulse", new Set(["pulse", "pulse2"])), "pulse3");
  assert.equal(appIdFor("My CRM: (beta)", new Set()), "mycrmbeta");
  assert.equal(appIdFor("!!!", new Set()), "app");
  assert.match(appIdFor("x".repeat(40), new Set()), /^[a-z0-9]{1,16}$/);
});

test("the hub's focus reads through call_app_tool and says which app", () => {
  const focus = { kind: "figure", id: null, part: null, params: { key: "active_customers", month: "2026-03" }, app_url: "https://p/overview", pinned_at: "2026-10-25T10:00:00.000Z", next: "get_figure", next_args: { key: "active_customers", params: { month: "2026-03" } } };
  const app = { id: "pulse", name: "Pulse", origin: "https://pulse.v2.apc.tineira.com" };
  const f = hubFocus(focus, app);
  assert.equal(f.next, "call_app_tool");
  assert.deepEqual(f.next_args, { app: "pulse", tool: "get_figure", args: focus.next_args });
  assert.deepEqual(f.app, app);
  assert.equal(focusLabel(f), "active_customers 2026-03");
  const p = hubFocus(focus, app, true);
  assert.equal(p.next, "pulse__get_figure", "the prefixed tool once the client listed it (TIN-384)");
  assert.deepEqual(p.next_args, focus.next_args, "with the app's own arguments");
  assert.equal(focusLabel({ kind: "customer", id: "cus_0042", part: "seats", params: null }), "cus_0042 seats");
});

test("newest pin wins across apps", () => {
  const a = { pinned_at: "2026-10-25T10:00:00.000Z", n: "a" };
  const b = { pinned_at: "2026-10-25T10:00:05.000Z", n: "b" };
  assert.equal(newest([a, null, b])?.n, "b");
  assert.equal(newest([]), null);
});

test("an app's attention and then come off a relayed result, in both forms", () => {
  const result = { content: [{ type: "text", text: JSON.stringify({ values: [1], attention: { x: 1 }, then: "wait" }) }], structuredContent: { values: [1], attention: { x: 1 }, then: "wait" } };
  const { result: clean, had } = detachKeys(result, ["attention", "then"]);
  assert.deepEqual(clean.structuredContent, { values: [1] });
  assert.deepEqual(JSON.parse(clean.content[0]!.text!), { values: [1] });
  assert.deepEqual([...had].sort(), ["attention", "then"]);
  assert.deepEqual(detachKeys({ content: [{ type: "text", text: "plain" }] }, ["then"]).result.content[0], { type: "text", text: "plain" });
});

test("attendance across apps: any page open, none known, or closed", () => {
  assert.equal(combineAttendance([false, true]), true);
  assert.equal(combineAttendance([null, null]), null);
  assert.equal(combineAttendance([false, null]), false);
  assert.equal(combineAttendance([]), null);
});

test("the hub pairs only with allowed app origins, and the MCP URL must be on that origin", () => {
  const allowed = ["https://pulse.v2.apc.tineira.com"];
  assert.ok(appAllowed("https://pulse.v2.apc.tineira.com", "https://pulse.v2.apc.tineira.com/mcp/a/b", allowed, false));
  assert.equal(appAllowed("https://pulse.v2.apc.tineira.com", "https://evil.example/mcp", allowed, false), false, "URL on another origin");
  assert.equal(appAllowed("https://evil.example", "https://evil.example/mcp", allowed, false), false);
  assert.equal(appAllowed("http://localhost:5199", "http://localhost:5199/mcp/a/b", allowed, false), false, "localhost only in dev");
  assert.ok(appAllowed("http://localhost:5199", "http://localhost:5199/mcp/a/b", allowed, true));
  assert.equal(appAllowed("https://pulse.v2.apc.tineira.com", "https://u:p@pulse.v2.apc.tineira.com/mcp", allowed, false), false);
  assert.equal(appAllowed("https://pulse.v2.apc.tineira.com", "not a url", allowed, false), false);
});

test("an agent's call reads the pin only when it is the call the focus names (TIN-419)", () => {
  const focus = { app: "pulse", next: "get_figure", next_args: { key: "mrr", params: { month: "2026-03" } } };
  assert.equal(readsPin(focus, "pulse", "get_figure", { params: { month: "2026-03" }, key: "mrr" }), true);
  assert.equal(readsPin(focus, "pulse", "get_figure", { key: "mrr", params: { month: "2026-04" } }), false);
  assert.equal(readsPin(focus, "signals", "get_figure", focus.next_args), false);
  assert.equal(readsPin(focus, "pulse", "get_customer", focus.next_args), false);
  assert.equal(readsPin(null, "pulse", "get_figure", focus.next_args), false);
});

test("a failed call logs its error code, never its message (TIN-419)", () => {
  assert.equal(errorOf({ content: [{ type: "text", text: "{}" }] }), null);
  assert.equal(errorOf({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: "unknown_app", message: "No paired app" }) }] }), "unknown_app");
  assert.equal(errorOf({ isError: true, structuredContent: { error: "not_found" } }), "not_found");
  assert.equal(errorOf({ isError: true, content: [{ type: "text", text: "boom" }] }), "error");
});
