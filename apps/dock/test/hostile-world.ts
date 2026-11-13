/**
 * The world the hostile-app tests run in (TIN-580, TIN-581), in one process: the real hub (hub.ts) on
 * Node's SQLite, the real Pulse sandbox as a verified app, and simulated apps on other origins that
 * answer the hub's MCP calls the way an attacker would. fetch is routed by origin and counted, and
 * nothing else is reachable, so "the hub never called it" is checked, not assumed. Shared by
 * hostile-app.test.ts and open-pairing.test.ts; not a test file itself.
 */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { demoDataset } from "../../demo/src/model/demo-world.ts";
import { LIMITS } from "../src/worker/trust.ts";

installWorkersStandIn();
const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);
const { Sandbox } = await import(new URL("../../demo/src/worker/sandbox.ts", import.meta.url).href);
/** Pulse's Worker, for the apc.json it serves at /.well-known/apc.json (APC 0.5): the hub reads it when Pulse pairs. */
const { default: pulseWorker } = await import(new URL("../../demo/src/worker/index.ts", import.meta.url).href);

export const DOCK = "https://dock.test";
export const PULSE = "https://pulse.test";
const DID = "a".repeat(32);
export const SID = "b".repeat(32);

export type Json = Record<string, unknown>;
type Answer = Response | Promise<Response> | null | undefined;

/** A simulated app on its own origin: by default a well-behaved MCP server; each hook makes it hostile in one way. */
export interface FakeApp {
  origin: string;
  name: string;
  tools: Json[];
  view: Json | null;
  focus: Json | null;
  /** What a tools/call of one of its own tools gives. */
  result: (tool: string, args: Json) => Json;
  /** Answer a JSON-RPC call in its own way (oversized, slow, never); undefined falls back to the default. */
  respond?: (method: string, params: Json) => Answer;
  /** Every JSON-RPC method or tool it was sent, and every /apc/revoke. */
  calls: string[];
  /** Its /.well-known/apc.json (APC 0.5); by default a valid one that offers the Dock profile. */
  apcJson?: () => Answer;
  /** How it answers /apc/revoke; by default at once, { ok: true }. */
  revoke?: () => Answer;
}

/** A valid apc.json for an app on `origin` that offers the Dock profile. */
export const manifestOf = (origin: string, name: string, over: Json = {}): Json => ({ name, standard: "0.5.0", origin, profiles: ["dock"], mcp: { path: "/mcp/" }, ...over });

/** The hub's answer as its Worker gives it (index.ts): HTTP 400 on a refusal, which the apps read as the hub's own (APC 0.9). */
export const answerAs = (r: { ok: boolean }) => Response.json(r, { status: r.ok ? 200 : 400 });
export const rpcAnswer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
export const asResult = (data: Json) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

export function fakeApp(origin: string, name: string, over: Partial<FakeApp> = {}): FakeApp {
  return {
    origin,
    name,
    tools: [{ name: "get_figure", description: "A figure.", inputSchema: { type: "object", properties: {} } }],
    view: { screen: "home", params: {}, selection: null, app_url: `${origin}/`, updated_at: new Date().toISOString(), age_seconds: 0, stale: false, next: "get_current_view" },
    focus: null,
    result: () => ({ value: 42 }),
    calls: [],
    ...over,
  };
}

async function serve(app: FakeApp, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/.well-known/apc.json") return (await app.apcJson?.()) ?? Response.json(manifestOf(app.origin, app.name));
  if (url.pathname === "/apc/revoke") {
    app.calls.push("/apc/revoke");
    return (await app.revoke?.()) ?? Response.json({ ok: true });
  }
  const body = (await request.json()) as { method: string; params: Json };
  const params = body.params ?? {};
  const tool = body.method === "tools/call" ? String(params.name) : null;
  app.calls.push(tool ?? body.method);
  const own = app.respond?.(body.method, params);
  if (own) return own;
  if (body.method === "initialize") return rpcAnswer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: app.name, version: "1" } });
  if (body.method === "tools/list") return rpcAnswer({ tools: app.tools });
  if (tool === "get_current_view") return rpcAnswer(asResult({ view: app.view, focus: app.focus }));
  if (tool === "wait_for_focus") return rpcAnswer(asResult({ focus: null, timed_out: false, page_open: false }));
  return rpcAnswer(asResult(app.result(tool!, (params.arguments ?? {}) as Json)));
}

/** Open to unverified apps by default (TIN-581); { UNVERIFIED_PAIRING: "closed" } is the operator's kill switch. */
export async function world(t: TestContext, env: Json = {}) {
  // These worlds let a pairing without a code through (the pre-0.9 path most tests here use); the hub's own
  // default is "required" (TIN-885), which pairing-code.test.ts checks with PAIRING_CODE unset.
  const hubEnv: Json = { APP_ORIGINS: PULSE, PAIRING_CODE: "when_sent", ...env };
  const hubRoom = durableObjectRoom();
  const hub = new Hub(hubRoom.ctx, hubEnv);
  await hub.init(DID);
  const pulseRoom = durableObjectRoom();
  const pulse = new Sandbox(pulseRoom.ctx, { APC_V2: "1", HUB_ORIGINS: DOCK });
  await pulse.init();
  const customers = demoDataset().customers;
  const apps = new Map<string, FakeApp>();
  /** Requests per origin, whatever they asked. */
  const hits = new Map<string, number>();

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    hits.set(url.origin, (hits.get(url.origin) ?? 0) + 1);
    if (url.origin === PULSE && url.pathname === "/.well-known/apc.json") return pulseWorker.fetch(request, { APC_V2: "1", APC_PROFILES: "direct,dock" });
    if (url.origin === PULSE && url.pathname.startsWith("/mcp/")) return pulse.fetch(request);
    // Pulse takes its grant back when the hub lets go of a pairing (a deny, an expired request).
    if (url.origin === PULSE && url.pathname === "/apc/revoke") {
      const secret = new URL(((await request.json()) as { mcp_url: string }).mcp_url).pathname.split("/").at(-1);
      const r = await pulse.revokeHubGrant(secret);
      return Response.json(r, { status: r.ok ? 200 : 404 });
    }
    if (url.origin === DOCK && url.pathname === "/apc/pair") return answerAs(await hub.pair(await request.json()));
    if (url.origin === DOCK && url.pathname === "/apc/confirm") return answerAs(await hub.confirm(await request.json()));
    const app = apps.get(url.origin);
    if (app) return serve(app, request);
    throw new TypeError(`no network in this test: ${url}`);
  });

  const state = async () => hub.state(DOCK);
  const agent = async (i = 0) => (await state()).agents[i];
  const first = await agent();

  /** One JSON-RPC call to the hub's MCP endpoint, as the agent's client sends it. */
  const rpcHub = async (method: string, params: Json = {}, who = first) => {
    const response = await hub.fetch(
      new Request(`${DOCK}${new URL(who.mcp_url).pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    return (await response.json()).result;
  };
  const callHub = (name: string, args: Json = {}) => rpcHub("tools/call", { name, arguments: args });
  const listHub = async () => (await rpcHub("tools/list")).tools as Array<{ name: string; description: string; annotations?: Json }>;

  /** The person drops an agent on Pulse and allows it there: Pulse asks first (consent in the app, TIN-606), the Allow sends the nonce back. */
  const dropOnPulse = async (drag: { agent: string; ticket: string }) => {
    const drop = { hub: DOCK, ...drag, target: { kind: "customer", id: customers[0]!.id } };
    const asked = await pulse.pairHub(SID, PULSE, drop);
    assert.equal(asked.error, "consent_required");
    // The code Pulse's consent showed (APC 0.9), for the person to type in the dock.
    return { ...(await pulse.pairHub(SID, PULSE, { ...drop, consent: asked.consent })), code: asked.pairing_code as string };
  };
  /** The person drops the agent on Pulse, allows it there and in the dock. */
  const pairPulse = async () => {
    const { ticket } = await hub.ticket(first.id);
    const paired = await dropOnPulse({ agent: first.id, ticket });
    assert.equal(paired.ok, true, `pairing Pulse: ${paired.error}`);
    const pending = (await agent()).pairings.find((p: Json) => p.status === "pending" && (p.app as Json).origin === PULSE);
    assert.equal(pending.warning, undefined, "a verified app's request carries no warning");
    assert.equal(pending.code, true, "Pulse sent the hub its pairing code");
    assert.equal((await hub.decide(pending.id, "approve", paired.code)).ok, true);
  };

  /** A hostile app asks to pair (POST /apc/pair, with a ticket from a drag), and optionally the person approves the warning in the dock (TIN-581). */
  const pairApp = async (app: FakeApp, o: { approve?: boolean; agentIndex?: number } = {}) => {
    apps.set(app.origin, app);
    const who = await agent(o.agentIndex ?? 0);
    const { ticket } = await hub.ticket(who.id);
    const answer = await hub.pair({ ticket, agent: who.id, app: { name: app.name, origin: app.origin }, mcp_url: `${app.origin}/mcp/${"c".repeat(32)}` });
    if (answer.ok && o.approve !== false) assert.equal((await hub.decide(answer.pairing_id, "approve_unverified")).ok, true);
    return answer as { ok: boolean; error?: string; pairing_id?: string };
  };
  const pairingOf = async (origin: string) => (await agent()).pairings.find((p: { app: { origin: string } }) => p.app.origin === origin);

  return { hub, hubRoom, hubEnv, pulse, pulseRoom, customers, apps, hits, state, agent, rpcHub, callHub, listHub, dropOnPulse, pairPulse, pairApp, pairingOf };
}

/** Shorter time limits for one test. */
export function quickLimits(t: TestContext, ms = 300) {
  const saved = { ...LIMITS };
  Object.assign(LIMITS, { initializeMs: ms, listMs: ms, callMs: ms, lookMs: ms, waitGraceMs: ms });
  t.after(() => Object.assign(LIMITS, saved));
}

export const stream = (chunks: Iterable<string>, opts: { close?: boolean } = {}) => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      if (opts.close !== false) c.close();
    },
  });
};
