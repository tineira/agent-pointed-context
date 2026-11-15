/**
 * Reference hub conformance tests (TIN-919): runs `@tineira/apc-conformance`'s
 * `hubConformance` suite against the real `apps/dock` Hono worker + `Hub` DO.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeApcConnect } from "@tineira/apc-protocol";
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
  let room!: ReturnType<typeof durableObjectRoom>;
  let ownerSecret = "";
  let agentId = "";
  let agentMcpUrl = "";

  async function initHub(): Promise<void> {
    room = durableObjectRoom();
    room.openPage();
    hub = new Hub(room.ctx, envBase);
    const initialized = await hub.init(DID);
    ownerSecret = initialized.owner;
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

  const approveConnect = async (id: string) => {
    const sendApprove = async (action?: string) => {
      const res = await dockWorker.fetch(
        new Request(`${HUB_ORIGIN}/api/d/${DID}/connects/${id}/approve`, {
          method: "POST",
          headers: {
            cookie: `apc_dock=${DID}.${ownerSecret}`,
            origin: HUB_ORIGIN,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          body: JSON.stringify(action ? { action } : {}),
        }),
        workerEnv as never,
      );
      return (await res.json()) as { ok: boolean; url?: string; error?: string };
    };
    const first = await sendApprove();
    if (!first.ok && first.error === "warning_required") {
      return await sendApprove("approve_unverified");
    }
    return first;
  };

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
    ownerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      request.headers.set("cookie", `apc_dock=${DID}.${ownerSecret}`);
      return Promise.resolve(dockWorker.fetch(request, workerEnv as never));
    },
    async ticket(agent: string): Promise<string> {
      const { ticket } = await hub.ticket(agent);
      return ticket;
    },
    approveConnect,
    async pendingConnects() {
      const state = (await hub.state(HUB_ORIGIN, ownerSecret)) as { connects: Array<{ id: string; agent?: string; origin: string }> };
      return state.connects.map((c) => ({ id: c.id, ...(c.agent ? { agent: c.agent } : {}), origin: c.origin }));
    },
    connectApproveEndpoint(id: string) {
      return { path: `/api/d/${DID}/connects/${id}/approve`, method: "POST", body: {} };
    },
    async observeState() {
      return { state: await hub.state(HUB_ORIGIN, ownerSecret), broadcasts: room.takeMessages() };
    },
    async pairingTicket(agent: string, origin: string): Promise<string> {
      const { ticket } = await hub.ticket(agent);
      const res = await dockWorker.fetch(
        new Request(`${HUB_ORIGIN}/apc/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket, agent, app: { origin } }),
        }),
        workerEnv as never,
      );
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(`pairingTicket /apc/connect failed: ${res.status} ${JSON.stringify(body)}`);
      const pending = ((await hub.state(HUB_ORIGIN, ownerSecret)) as { connects: Array<{ id: string; agent?: string; origin: string }> }).connects.find((c) => c.agent === agent && c.origin === origin);
      if (!pending) throw new Error(`pairingTicket found no pending connect request for (${agent}, ${origin})`);
      const approved = await approveConnect(pending.id);
      if (!approved.ok || !approved.url) throw new Error(`pairingTicket approveConnect failed: ${JSON.stringify(approved)}`);
      const payload = decodeApcConnect(new URL(approved.url).hash);
      if (!payload) throw new Error(`pairingTicket approveConnect URL lacked #apc= fragment: ${approved.url}`);
      return payload.ticket;
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
