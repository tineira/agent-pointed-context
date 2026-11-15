/**
 * Reference hub conformance tests (TIN-919): runs `@tineira/apc-conformance`'s
 * `hubConformance` suite against the real `apps/dock` Hono worker + `Hub` DO.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hubConformance, type ApcHubAdapter } from "@tineira/apc-conformance";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";

installWorkersStandIn();
const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);
const { default: dockWorker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const HUB_ORIGIN = "https://dock.test";
const DID = "a".repeat(32);

async function makeReferenceHubAdapter(t: import("node:test").TestContext): Promise<ApcHubAdapter> {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const envBase = { APP_ORIGINS: "https://app.example" };
  let hub!: InstanceType<typeof Hub>;
  let agentId = "";
  let agentMcpUrl = "";

  async function initHub(): Promise<void> {
    const room = durableObjectRoom();
    hub = new Hub(room.ctx, envBase);
    await hub.init(DID);
    const state = await hub.state(HUB_ORIGIN);
    agentId = state.agents[0]!.id;
    agentMcpUrl = state.agents[0]!.mcp_url;
  }

  await initHub();

  const workerEnv = {
    ...envBase,
    HUB: {
      idFromName: () => DID,
      get: () => hub,
    },
  };

  async function rpcAgent(url: string, method: string, params: Record<string, unknown> = {}): Promise<void> {
    const res = await dockWorker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      workerEnv as never,
    );
    await res.text();
  }

  return {
    name: "apps/dock reference hub",
    origin: HUB_ORIGIN,
    requiresPairingCode: true,
    get agent() {
      return agentId;
    },
    async reset() {
      await initHub();
    },
    advance(ms: number) {
      t.mock.timers.tick(ms);
    },
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      return Promise.resolve(dockWorker.fetch(request, workerEnv as never));
    },
    async ticket(agent: string): Promise<string> {
      const { ticket } = await hub.ticket(agent);
      return ticket;
    },
    // Pre-0.13: /apc/pair takes a drop ticket; in 0.13+ this seam swaps to /apc/connect + approve -> connect ticket.
    async pairingTicket(agent: string, _origin: string): Promise<string> {
      const { ticket } = await hub.ticket(agent);
      return ticket;
    },
    async approve(id: string, code?: string) {
      const first = await hub.decide(id, "approve", code);
      if (!first.ok && first.error === "warning_required") {
        return await hub.decide(id, "approve_unverified", code);
      }
      return first;
    },
    async deny(id: string) {
      return await hub.decide(id, "deny");
    },
    async exerciseAgent(agent: string) {
      const state = await hub.state(HUB_ORIGIN);
      const agents = state.agents as Array<{ id: string; mcp_url: string }>;
      const url = agents.find((a) => a.id === agent)?.mcp_url ?? agentMcpUrl;
      await rpcAgent(url, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "conformance-agent", version: "0.1.0" },
      });
      await rpcAgent(url, "tools/list");
      await rpcAgent(url, "tools/call", { name: "get_current_view", arguments: {} });
      await rpcAgent(url, "tools/call", { name: "list_app_tools", arguments: {} });
    },
  };
}

// Run a dummy adapter only to obtain the static check descriptors for per-check test registration.
const descriptors = hubConformance({
  name: "apps/dock",
  origin: HUB_ORIGIN,
  agent: "agent",
  fetch: () => Promise.reject(new Error("unused")),
  ticket: () => "",
  pairingTicket: () => "",
  approve: () => Promise.resolve({ ok: false }),
  deny: () => Promise.resolve({ ok: false }),
  advance: () => {},
});

for (const descriptor of descriptors) {
  test(`reference hub conformance: ${descriptor.id} — ${descriptor.name}`, async (t) => {
    const adapter = await makeReferenceHubAdapter(t);
    const checks = hubConformance(adapter);
    const check = checks.find((c) => c.id === descriptor.id);
    assert.ok(check, `missing check ${descriptor.id}`);
    await check.run();
    assert.equal(check.note, undefined, `unexpected policy or skip note on ${descriptor.id}: ${check.note}`);
  });
}
