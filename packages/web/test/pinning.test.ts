import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDragPayload, APC_AGENT_TYPE, parseAgentDrag, parseAgentDragPayload } from "../src/pinning.ts";

test("an agent's drag carries a public handle only, and reads back (TIN-369)", () => {
  assert.equal(APC_AGENT_TYPE, "application/x-apc-agent");
  assert.equal(parseAgentDragPayload(agentDragPayload("g_1a2b3c4d")), "g_1a2b3c4d");
  assert.deepEqual(JSON.parse(agentDragPayload("g_1")), { v: 1, agent: "g_1" });
});

test("anything that is not an agent payload is refused", () => {
  assert.equal(parseAgentDragPayload("g_1a2b3c4d"), null, "a bare string");
  assert.equal(parseAgentDragPayload(JSON.stringify({ v: 2, agent: "g_1" })), null, "another version");
  assert.equal(parseAgentDragPayload(JSON.stringify({ v: 1, agent: "https://apc.tineira.com/mcp/sid/secret" })), null, "a URL is not a handle");
  assert.equal(parseAgentDragPayload(JSON.stringify({ v: 1, agent: "x".repeat(200) })), null);
  assert.equal(parseAgentDragPayload("{not json"), null);
  assert.equal(parseAgentDragPayload(JSON.stringify({ v: 1 })), null);
});

test("a drag from a hub names the hub and a pairing ticket (TIN-382)", () => {
  const text = agentDragPayload("ag_1a2b3c4d", { hub: "https://apc.tineira.com", ticket: "0123456789abcdef.0123456789abcdef" });
  assert.deepEqual(parseAgentDrag(text), { v: 1, agent: "ag_1a2b3c4d", hub: "https://apc.tineira.com", ticket: "0123456789abcdef.0123456789abcdef" });
  assert.equal(parseAgentDragPayload(text), "ag_1a2b3c4d", "a v1 reader still gets the handle");
  const odd = (hub: string, ticket = "0123456789abcdef0") => parseAgentDrag(JSON.stringify({ v: 1, agent: "ag_1", hub, ticket }));
  assert.deepEqual(odd("https://apc.tineira.com/mcp/x"), { v: 1, agent: "ag_1" }, "a hub with a path is not an origin");
  assert.deepEqual(odd("javascript:alert(1)"), { v: 1, agent: "ag_1" });
  assert.deepEqual(odd("https://apc.tineira.com", "short"), { v: 1, agent: "ag_1" }, "no usable ticket, no pairing");
  assert.deepEqual(odd("http://localhost:5200"), { v: 1, agent: "ag_1", hub: "http://localhost:5200", ticket: "0123456789abcdef0" });
});

test("the agent bar's words: the mark, and the pin's dot (TIN-394)", async () => {
  const { agentLabels } = await import("../src/agents-bar.ts");
  const a = { id: "g_1", name: "Claude", state: "idle" as const };
  assert.equal(agentLabels(a).dot, null);
  assert.match(agentLabels({ ...a, state: "off" }).mark, /not connected yet/);
  assert.equal(agentLabels({ ...a, pin: { label: "active_customers 2026-03", seen: true, here: true } }).dot, "Pinned to active_customers 2026-03: your agent read it");
  assert.match(agentLabels({ ...a, pin: { label: "cus_0042", seen: false, here: false } }).dot!, /waiting for your agent's next call\. Click to open it\.$/);
});

test("tap to pin: tap an agent, then a target; the armed one again lets go (APC 0.6)", async () => {
  const { createTapPin } = await import("../src/pinning.ts");
  const pins: Array<[string, string]> = [];
  const changes: Array<string | null> = [];
  const el = {} as Element;
  const tap = createTapPin({
    canTarget: (grant, target) => !(grant === "g_restricted" && target.id === "cus_9"),
    onPin: (grant, target) => pins.push([grant, `${target.kind}:${target.id}`]),
    onChange: (armed) => changes.push(armed),
  });
  const at = (id: string) => ({ element: el, target: { kind: "customer", id, part: null, params: null } });
  assert.equal(tap.tap(at("cus_1")), "idle", "a tap with no agent armed pins nothing");
  assert.equal(tap.toggle("g_1"), "g_1");
  assert.equal(tap.tap(null), "no_target", "a tap on something that is no target keeps the agent armed");
  assert.equal(tap.armed, "g_1");
  assert.equal(tap.toggle("g_1"), null, "tapping the armed mark again lets go");
  tap.toggle("g_1");
  tap.toggle("g_restricted");
  assert.equal(tap.armed, "g_restricted", "arming another agent replaces the first");
  assert.equal(tap.tap(at("cus_9")), "refused", "a target the agent may not point at is refused, and it stays armed");
  assert.equal(tap.armed, "g_restricted");
  assert.equal(tap.tap(at("cus_2")), "pinned");
  assert.equal(tap.armed, null, "a pin lets go");
  tap.toggle("g_1");
  tap.cancel();
  assert.equal(tap.armed, null);
  assert.deepEqual(pins, [["g_restricted", "customer:cus_2"]]);
  assert.deepEqual(changes, ["g_1", null, "g_1", "g_restricted", null, "g_1", null]);
});

test("a native drop the app answered is placed, or the person is told why not (TIN-756)", async () => {
  const { placeNativeDrop, REFUSED_NOTE, UNKNOWN_AGENT_NOTE } = await import("../src/pinning.ts");
  const hit = { element: {} as Element, target: { kind: "customer", id: "cus_9", part: null, params: null } };
  const pins: string[] = [];
  const unknown: string[] = [];
  const told: string[] = [];
  const options = {
    canTarget: (grant: string, target: { id: string | null }) => !(grant === "g_restricted" && target.id === "cus_9"),
    resolveAgent: (handle: string) => (handle.startsWith("g_") ? handle : null),
    onPin: (grant: string) => pins.push(grant),
    onUnknownAgent: (drag: { agent: string }) => unknown.push(drag.agent),
  };
  const tell = (m: string) => told.push(m);
  assert.equal(placeNativeDrop(options, { v: 1, agent: "g_1" }, hit, tell), "pinned");
  assert.deepEqual(pins, ["g_1"]);
  assert.equal(placeNativeDrop(options, { v: 1, agent: "g_restricted" }, hit, tell), "refused", "canTarget said no after the dragover was answered");
  assert.deepEqual(told, [REFUSED_NOTE]);
  assert.equal(pins.length, 1, "nothing pinned");
  assert.equal(placeNativeDrop(options, { v: 1, agent: "ag_x", hub: "https://apc.tineira.com", ticket: "0123456789abcdef0" }, hit, tell), "unknown_agent");
  assert.deepEqual(unknown, ["ag_x"]);
  assert.equal(told.length, 1, "pairing answers by itself");
  const { onUnknownAgent: _unused, ...noPairing } = options;
  assert.equal(placeNativeDrop(noPairing, { v: 1, agent: "ag_x", hub: "https://apc.tineira.com", ticket: "0123456789abcdef0" }, hit, tell), "refused", "an app without onUnknownAgent still says so");
  assert.equal(told.at(-1), UNKNOWN_AGENT_NOTE);
  assert.equal(placeNativeDrop(options, null, hit, tell), "none");
  assert.equal(placeNativeDrop(options, { v: 1, agent: "g_1" }, null, tell), "none");
});
