/**
 * The conformance suite's lifecycle adapter (APC 0.10, `ApcDockLifecycleAdapter`) for Pulse and Signals: both are a
 * Worker in front of one Durable Object, with the same owner routes. The person's actions go through the Worker,
 * as the page sends them (the session cookie, `application/json`, the app's own `Origin`), so M6 and the routes are
 * under test too. Not a test file itself: apps/demo/test/conformance.test.ts and Signals' use it.
 */
import type { ApcDockDropOutcome, ApcDockLifecycleAdapter, StandInHub } from "@tineira/apc-conformance";
import type { DurableObjectRoom } from "@tineira/apc-conformance/workers";

type WorkerFetch = (request: Request, env: unknown) => Promise<Response>;

export interface DockLifecycleOptions {
  /** The app's Worker. */
  worker: { fetch: WorkerFetch };
  /** The Worker's env, with the namespace that holds the object under test (the one now running: see `restart`). */
  workerEnv: () => Record<string, unknown>;
  /** The same deploy with its Dock configuration missing (M8). */
  disabledEnv: Record<string, unknown>;
  /** The app's public origin, the session's id and its cookie (`name=sid.owner`). */
  origin: string;
  sid: string;
  cookie: string;
  hub: StandInHub;
  /** What a drop is dropped on. */
  target: unknown;
  /** A body the page's view report takes. */
  view: unknown;
  room: DurableObjectRoom;
  /** The object now running: its time seam. */
  object: () => { advanceDockClock(ms: number): Promise<void> };
  /** The object dies and a new one starts on the same storage; it is the one `object()` and `workerEnv()` give from then on. */
  restart: () => void;
}

/**
 * The page's WebSocket handshake, in process: Node has no WebSocketPair and no 101 Response, so the request goes to
 * the Worker without its `Upgrade` header. The Worker's rule on the owner's endpoints (M6), its session check and
 * the object's own owner check all run as deployed; an object that then answers 426 ("expected websocket") took
 * the handshake, which here reads as 200. Any refusal is passed on as it is.
 */
export async function inProcessHandshake(worker: { fetch: WorkerFetch }, env: unknown, request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("upgrade");
  const response = await worker.fetch(new Request(request.url, { method: "GET", headers }), env);
  return response.status === 426 ? new Response(null, { status: 200 }) : response;
}

/** Whether a request is a WebSocket handshake. */
export const isHandshake = (request: Request) => request.method === "GET" && (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";

export function dockLifecycle(o: DockLifecycleOptions): ApcDockLifecycleAdapter {
  const session = { cookie: o.cookie };
  const post = async (path: string, body: unknown) => {
    const response = await o.worker.fetch(
      new Request(`${o.origin}/api/s/${o.sid}${path}`, { method: "POST", headers: { ...session, "content-type": "application/json", origin: o.origin, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) }),
      o.workerEnv(),
    );
    return (await response.json()) as Record<string, unknown>;
  };
  const dropAgent = async (d: { agent: string; ticket: string; hub: string; target?: unknown }): Promise<ApcDockDropOutcome> => {
    const drop = { hub: d.hub, agent: d.agent, ticket: d.ticket, target: d.target ?? o.target };
    const r = await post("/hub/pair", drop);
    if (r.error === "consent_required") {
      return {
        page: "consent",
        code: String(r.pairing_code),
        async allow(over) {
          const a = await post("/hub/pair", { ...drop, ...(over?.hub !== undefined ? { hub: over.hub } : {}), consent: r.consent });
          return { ok: a.ok === true, ...(typeof a.error === "string" ? { error: a.error } : {}), ...(typeof a.grant_id === "string" ? { grantId: a.grant_id } : {}) };
        },
      };
    }
    if (r.ok === true && r.status === "pending" && r.pairing) return { page: "waiting", code: String((r.pairing as { code: string }).code) };
    if (r.ok === true && r.status === "connecting") return { page: "connecting" };
    if (r.ok === true) return { page: "pinned" };
    return { page: "refused", error: String(r.error) };
  };
  let agents = 0;
  const newAgent = () => `ag_owner_${++agents}`;
  /** A consent for a new agent: the drop and what its Allow sends. */
  const asked = async () => {
    const agent = newAgent();
    const drop = { hub: o.hub.origin, agent, ticket: o.hub.ticket(agent), target: o.target };
    const r = await post("/hub/pair", drop);
    if (r.error !== "consent_required") throw new Error(`expected a consent, got ${JSON.stringify(r)}`);
    return { ...drop, consent: r.consent, code: String(r.pairing_code) };
  };
  /** A grant in handoff for a new agent: the Allow went through and the hub acknowledged it. */
  const handoff = async () => {
    const { code, ...allow } = await asked();
    const r = await post("/hub/pair", allow);
    if (r.ok !== true) throw new Error(`the Allow did not pair: ${JSON.stringify(r)}`);
    return { agent: allow.agent, code, grantId: String(r.grant_id) };
  };
  // The clock's offset so far, given again to an object that starts after a restart: the app's clock is one clock.
  let skew = 0;
  // While true, every statement that writes fails, as a storage that cannot persist does.
  let failing = false;
  const sql = (o.room.ctx as { storage: { sql: { exec: (query: string, ...params: unknown[]) => unknown } } }).storage.sql;
  const exec = sql.exec.bind(sql);
  sql.exec = (query: string, ...params: unknown[]) => {
    if (failing && /^\s*(insert|update|delete|replace|create|alter|drop)\b/i.test(query)) throw new Error("storage: the write could not be saved");
    return exec(query, ...params);
  };
  return {
    dropAgent,
    cancel: async (grantId) => (await post("/hub/cancel", { grant_id: grantId })).ok === true,
    // The page's heartbeat is its WebSocket (answered by the runtime); the apps do not sleep, so it wakes nothing.
    heartbeat: async () => {},
    async advance(ms) {
      skew += ms;
      await o.object().advanceDockClock(ms);
    },
    failCommits(fail) {
      failing = fail;
    },
    async restart() {
      o.restart();
      await o.object().advanceDockClock(skew);
    },
    // The page's Allow sends the hub again with the nonce (the drop and the Allow are one route), and the app checks it again (M1).
    allowCarriesHub: true,
    owner: {
      origin: o.origin,
      session,
      // A drop the app takes with a 2xx: of an agent it already holds a live grant for, with a new ticket (a first
      // drop answers `consent_required` with HTTP 400, which the page and Pulse for Windows read).
      drop: {
        path: `/api/s/${o.sid}/hub/pair`,
        async body() {
          const g = await handoff();
          const pairing = o.hub.pairings.find((p) => p.agent === g.agent);
          if (!pairing) throw new Error("the stand-in hub holds no pairing for the agent");
          const approved = await o.hub.decide(pairing.id, "approve", g.code);
          if (!approved.ok) throw new Error(`the stand-in hub did not approve: ${JSON.stringify(approved)}`);
          return { hub: o.hub.origin, agent: g.agent, ticket: o.hub.ticket(g.agent), target: o.target };
        },
      },
      allow: {
        path: `/api/s/${o.sid}/hub/pair`,
        async body() {
          const { code: _code, ...allow } = await asked();
          return allow;
        },
      },
      // The page's heartbeat is its WebSocket: the handshake carries the session and is held to the same Origin rule.
      heartbeat: { websocket: `/api/s/${o.sid}/ws` },
      cancel: { path: `/api/s/${o.sid}/hub/cancel`, body: async () => ({ grant_id: (await handoff()).grantId }) },
    },
    pairingDisabled: async () => (request) => o.worker.fetch(request, o.disabledEnv),
  };
}
