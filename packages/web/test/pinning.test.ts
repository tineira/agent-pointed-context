import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDragPayload, APC_AGENT_TYPE, parseAgentDragPayload } from "../src/pinning.ts";

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
