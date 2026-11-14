import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canDrag, dragTitle, fillAgentDrag, type DragSink } from "../src/web/agent-drag.ts";

/** A DataTransfer that keeps what was put on it. */
function sink(): DragSink & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, effectAllowed: "none", setData: (type, value) => void data.set(type, value) };
}

const MCP_URL = "https://apc.tineira.com/mcp/d_0123456789abcdef/s3cr3t-0123456789abcdef";
const unconnected = { id: "ag_0a", name: "Agent 1", client_name: null, mcp_url: MCP_URL };
const connected = { ...unconnected, client_name: "Claude" };

test("An agent not connected yet puts nothing on a drag, never its MCP URL (TIN-908)", () => {
  for (const fresh of [undefined, { hub: "https://apc.tineira.com", ticket: "t_0123456789abcdef" }]) {
    const dt = sink();
    assert.equal(fillAgentDrag(dt, unconnected, fresh), false);
    const all = [...dt.data.entries()].flat().join("\n");
    assert.ok(!all.includes("/mcp/"), `the drag held an MCP URL: ${all}`);
    assert.ok(!all.includes("s3cr3t"));
    assert.equal(dt.data.size, 0);
  }
  assert.equal(canDrag(unconnected), false);
  // Its tooltip points to the explicit way to connect it, not to a drag.
  assert.doesNotMatch(dragTitle(unconnected), /drag/i);
  assert.match(dragTitle(unconnected), /Connect this agent/);
});

test("A connected agent drags as the APC payload only: a handle, the hub and a ticket, no URL", () => {
  const dt = sink();
  assert.equal(fillAgentDrag(dt, connected, { hub: "https://apc.tineira.com", ticket: "t_0123456789abcdef" }), true);
  assert.deepEqual([...dt.data.keys()], ["application/x-apc-agent"]);
  assert.deepEqual(JSON.parse(dt.data.get("application/x-apc-agent")!), { v: 1, agent: "ag_0a", hub: "https://apc.tineira.com", ticket: "t_0123456789abcdef" });
  assert.ok(![...dt.data.values()].join("").includes("/mcp/"));
  assert.equal(dt.effectAllowed, "link");
});

test("An agent gone from the dock does not drag", () => {
  const dt = sink();
  assert.equal(fillAgentDrag(dt, undefined, undefined), false);
  assert.equal(dt.data.size, 0);
});

test("No surface of the dock writes its own drag: every drag goes through agent-drag.ts", () => {
  for (const file of ["hub.tsx", "pet.tsx", "setup.tsx"]) {
    const src = readFileSync(new URL(`../src/web/${file}`, import.meta.url), "utf8");
    assert.ok(!/setData\(/.test(src), `${file} writes a drag itself`);
    assert.ok(!/askYourAgentPrompt/.test(src) || file === "setup.tsx", `${file} builds the connect prompt`);
    assert.ok(!/drag[^.\n]*into (your|the) agent.s chat/i.test(src), `${file} still says to drag into the chat`);
    // A bare `draggable` attribute (always true) would start a drag for an agent not connected yet.
    assert.ok(!/^\s*draggable\s*$/m.test(src), `${file} makes an agent draggable whatever its state`);
  }
});
