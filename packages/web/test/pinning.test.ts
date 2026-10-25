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
  const text = agentDragPayload("ag_1a2b3c4d", { hub: "https://v2.apc.tineira.com", ticket: "0123456789abcdef.0123456789abcdef" });
  assert.deepEqual(parseAgentDrag(text), { v: 1, agent: "ag_1a2b3c4d", hub: "https://v2.apc.tineira.com", ticket: "0123456789abcdef.0123456789abcdef" });
  assert.equal(parseAgentDragPayload(text), "ag_1a2b3c4d", "a v1 reader still gets the handle");
  const odd = (hub: string, ticket = "0123456789abcdef0") => parseAgentDrag(JSON.stringify({ v: 1, agent: "ag_1", hub, ticket }));
  assert.deepEqual(odd("https://v2.apc.tineira.com/mcp/x"), { v: 1, agent: "ag_1" }, "a hub with a path is not an origin");
  assert.deepEqual(odd("javascript:alert(1)"), { v: 1, agent: "ag_1" });
  assert.deepEqual(odd("https://v2.apc.tineira.com", "short"), { v: 1, agent: "ag_1" }, "no usable ticket, no pairing");
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
