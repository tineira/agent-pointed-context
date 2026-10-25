import assert from "node:assert/strict";
import { test } from "node:test";
import { appOriginAllowed, dockOriginAllowed, parseAgents } from "../src/web/dock-protocol.ts";

const agent = { handle: "g_1", name: "Claude", client_name: "claude-ai", client_ua: null, client_icon: null, motion: "idle", pin: { label: "active_customers 2026-03", seen: false } };
const message = (agents: unknown[], app: unknown = { name: "Pulse", origin: "https://apc.tineira.com" }) => ({ type: "apc-dock:agents", v: 1, app, agents });

test("the dock takes Pulse's agents as sent (TIN-370)", () => {
  assert.deepEqual(parseAgents(message([agent]))?.agents, [agent]);
  assert.deepEqual(parseAgents(message([{ ...agent, pin: null, motion: "off" }]))?.agents[0]?.pin, null);
});

test("the dock refuses anything else", () => {
  assert.equal(parseAgents(null), null);
  assert.equal(parseAgents({ ...message([agent]), v: 2 }), null);
  assert.equal(parseAgents(message([{ ...agent, handle: "https://evil.example/x" }])), null, "a handle is never a URL");
  assert.equal(parseAgents(message([{ ...agent, motion: "dance" }])), null);
  assert.equal(parseAgents(message([{ ...agent, client_icon: "data:image/svg+xml;base64,PHN2Zz4=" }])), null, "no SVG icon");
  assert.equal(parseAgents(message([{ ...agent, client_icon: "https://example.com/a.png" }])), null);
  assert.equal(parseAgents(message([{ ...agent, pin: { label: "x" } }])), null);
  assert.equal(parseAgents(message(Array(33).fill(agent))), null);
  assert.equal(parseAgents(message([agent], null)), null);
});

test("only the known origins talk", () => {
  assert.ok(dockOriginAllowed("https://v2.apc.tineira.com"));
  assert.ok(dockOriginAllowed("http://localhost:5200"));
  assert.equal(dockOriginAllowed("https://apc.tineira.com"), false);
  assert.equal(dockOriginAllowed("https://v2.apc.tineira.com.evil.example"), false);
  assert.ok(appOriginAllowed("https://apc.tineira.com"));
  assert.equal(appOriginAllowed("http://localhost.evil.example:80"), false);
});
