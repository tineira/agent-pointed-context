/**
 * Pulse counts its MCP sessions (TIN-1039). The counting code (TIN-347) lost its dataset when V1 moved to apps/v1
 * (TIN-604), so nothing was written. Now the binding is in wrangler.jsonc, and a Direct agent's initialize writes one
 * point with the source "pulse"; an agent that came through a dock is the hub's to count.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";

installWorkersStandIn();
const { Sandbox } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);

const ORIGIN = "https://pulse.test";
const SID = "7".repeat(32);
const DEPLOY = { APC_V2: "1", HUB_ORIGINS: "https://dock.test", PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };

test("wrangler.jsonc binds MCP_SESSIONS to apc_mcp_sessions, as V1 and the hub do", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const json = JSON.parse(config.replace(/^\s*\/\/.*$/gm, "")) as { analytics_engine_datasets?: Array<{ binding: string; dataset: string }> };
  assert.deepEqual(json.analytics_engine_datasets, [{ binding: "MCP_SESSIONS", dataset: "apc_mcp_sessions" }]);
});

test("a Direct agent's initialize writes one session point, source pulse, with nothing secret in it", async () => {
  const points: Array<{ indexes: string[]; blobs: string[]; doubles: number[] }> = [];
  const env = { ...DEPLOY, ANALYTICS_SALT: "test-salt", MCP_SESSIONS: { writeDataPoint: (p: (typeof points)[number]) => points.push(p) } };
  const sandbox = new Sandbox(durableObjectRoom().ctx, env);
  await sandbox.init();
  const grant = (await sandbox.addAgentGrant()) as { id: string };
  const secret = ((await sandbox.state()).grants as Array<{ id: string; secret: string }>).find((g) => g.id === grant.id)!.secret;
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1.0" } } };
  const response = (await sandbox.fetch(
    new Request(`${ORIGIN}/mcp/${SID}/${secret}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "Claude-User", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify(initialize),
    }),
  )) as Response;
  assert.equal(response.status, 200, await response.clone().text());
  await response.arrayBuffer();
  assert.equal(points.length, 1, "one point per initialize");
  const [point] = points;
  assert.equal(point!.blobs[0], "connected");
  assert.equal(point!.blobs[1], "claude-ai");
  assert.equal(point!.blobs[7], "pulse", "the source tells Pulse apart from V1 and the dock");
  const all = JSON.stringify(point);
  for (const clear of [secret, "203.0.113.7", grant.id, "test-salt"]) assert.ok(!all.includes(clear), `the point holds no ${clear}`);
});
