/**
 * The dock's Worker (TIN-382): the dock page's API (owner only, by cookie), the public pairing
 * endpoint apps call server to server, and each agent's MCP URL (the secret in it is the agent's).
 * The page is static assets: the landing of the APC standard at / (TIN-420; always, whoever asks, TIN-610) and the hub dock at /dock. /v1 belongs to V1
 * (apc-demo, by zone routes); if a request for it still gets here, it is sent on or refused, never the dock page (TIN-605).
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { APC_STANDARD_VERSION, type ApcManifest } from "@apc/protocol";
import { apcJsonResponse } from "@apc/server";
import { DOCK_TTL_MS, type Env, type Hub } from "./hub.ts";

/** The dock's own apc.json (APC 0.5). Not exported: a Worker's named exports are its entrypoints. */
function hubManifest(origin: string): ApcManifest {
  return { name: "APC dock", standard: APC_STANDARD_VERSION, origin, profiles: ["hub"], mcp: { path: "/mcp/" }, dock: { pair: `${origin}/apc/pair`, confirm: `${origin}/apc/confirm` } };
}

export { Hub } from "./hub.ts";

const COOKIE = "apc_dock";
type Stub = DurableObjectStub<Hub>;
type Vars = { did: string; owner: string };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * The dock is never framed (Review round 1 on #120): a page on a same-site host (pulse.apc.tineira.com) would
 * get the owner's cookie in an iframe of the dock, and could lay its own content over the warning's Approve.
 * Every response from the Worker says so, the assets it hands out included; public/_headers says it for the
 * assets served without it (/dock). A WebSocket upgrade keeps its own headers.
 */
const NO_FRAMING ={ "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" } as const;
app.use("*", async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  const res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(NO_FRAMING)) res.headers.set(k, v);
  c.res = res;
});

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const stubFor = (env: Env, did: string): Stub => env.HUB.get(env.HUB.idFromName(did));

function session(cookie: string | undefined): { did: string; owner: string } | null {
  const m = cookie?.match(/^([0-9a-f]{32})\.([0-9a-f]{32})$/);
  return m ? { did: m[1]!, owner: m[2]! } : null;
}

/** Whether the cookie holds a dock that is still live (its owner secret matches). */
async function ownsDock(env: Env, cookie: string | undefined): Promise<boolean> {
  const current = session(cookie);
  return !!current && (await stubFor(env, current.did).isOwner(current.owner));
}

/**
 * Whether this visitor already has a dock, for the landing's "Open your dock" (TIN-610). A yes or no and
 * nothing else: no id and no secret. Never cached, since the answer depends on the cookie.
 */
app.get("/api/dock/mine", async (c) => c.json({ has_dock: await ownsDock(c.env, getCookie(c, COOKIE)) }, 200, { "cache-control": "no-store", vary: "cookie" }));

/** Public uptime probe without opening a dock. */
app.get("/api/health", (c) => c.json({ ok: true }, 200, { "cache-control": "no-store" }));

/**
 * Resume the visitor's dock, or open a new one. With { resume: true } (the desktop dock's pets, #84,
 * which open beside the dock's own window and must not make a second dock), only resume: 404 without one.
 */
app.post("/api/dock", async (c) => {
  const current = session(getCookie(c, COOKIE));
  if (current && (await stubFor(c.env, current.did).isOwner(current.owner))) return c.json({ did: current.did, created: false });
  const body = (await c.req.json().catch(() => null)) as { resume?: unknown } | null;
  if (body?.resume === true) return c.json({ error: "no_dock" }, 404);
  const did = randomHex(16);
  const { owner } = await stubFor(c.env, did).init(did);
  setCookie(c, COOKIE, `${did}.${owner}`, { path: "/", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", maxAge: Math.floor(DOCK_TTL_MS / 1000) });
  return c.json({ did, created: true });
});

app.use("/api/d/:did/*", async (c, next) => {
  const current = session(getCookie(c, COOKIE));
  if (!current || current.did !== c.req.param("did")) return c.json({ error: "forbidden" }, 403);
  if (!(await stubFor(c.env, current.did).isOwner(current.owner))) return c.json({ error: "dock_expired" }, 404);
  c.set("did", current.did);
  c.set("owner", current.owner);
  await next();
});

const stub = (c: { env: Env; var: Vars }) => stubFor(c.env, c.var.did);
app.get("/api/d/:did/state", async (c) => c.json(await stub(c).state(new URL(c.req.url).origin)));
app.post("/api/d/:did/agents", async (c) => c.json(await stub(c).addAgent()));
app.post("/api/d/:did/kept", async (c) => c.json(await stub(c).keptAtHand()));
/** Start over (TIN-411): the dock gives its grants back and forgets everything, and its cookie goes. */
app.post("/api/d/:did/reset", async (c) => {
  await stub(c).reset();
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});
app.post("/api/d/:did/world", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { seed?: unknown };
  const result = await stub(c).setWorld(body.seed);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/d/:did/agents/:aid/ticket", async (c) => {
  const t = await stub(c).ticket(c.req.param("aid"));
  return t ? c.json(t) : c.json({ error: "unknown_agent" }, 404);
});
app.post("/api/d/:did/agents/:aid/badge", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { badge?: unknown };
  const result = await stub(c).setBadge(c.req.param("aid"), body.badge);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/d/:did/agents/:aid/remove", async (c) => {
  const result = await stub(c).removeAgent(c.req.param("aid"));
  return c.json(result, result.ok ? 200 : 404);
});
/** What an agent did (TIN-419), for its page in the dock. */
app.get("/api/d/:did/agents/:aid/calls", async (c) => {
  const result = await stub(c).calls(c.req.param("aid"));
  return result ? c.json(result) : c.json({ error: "unknown_agent" }, 404);
});
app.post("/api/d/:did/agents/:aid/clear", async (c) => {
  await stub(c).clearFocus(c.req.param("aid"));
  return c.json({ ok: true });
});
/** Clear on the agent's page (TIN-422): its list of readings, and what the hub still keeps of them. */
app.post("/api/d/:did/agents/:aid/readings/clear", async (c) => {
  const result = await stub(c).clearReadings(c.req.param("aid"));
  return c.json(result, result.ok ? 200 : 404);
});
app.post("/api/d/:did/pairings/:pid", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { action?: unknown };
  const result = await stub(c).decide(c.req.param("pid"), body.action);
  return c.json(result, result.ok ? 200 : 400);
});
app.get("/api/d/:did/ws", async (c) => {
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-apc-owner", c.var.owner);
  return stubFor(c.env, c.var.did).fetch(new Request(c.req.raw, { headers }));
});

/**
 * An app pairs with an agent (DESIGN.md 12.1), server to server: the ticket came from the agent's
 * drag and names the dock; the hub checks it, the app's origin, and waits for the person's yes.
 */
app.post("/apc/pair", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ticket?: unknown } | null;
  const did = typeof body?.ticket === "string" ? body.ticket.match(/^([0-9a-f]{32})\.[0-9a-f]{32}$/)?.[1] : undefined;
  if (!did) return c.json({ ok: false, error: "ticket_expired" }, 400);
  const result = await stubFor(c.env, did).pair(body);
  return c.json(result, result.ok ? 200 : 400);
});

/** An app checks that the hub still pairs an agent with its grant, on a drop (TIN-389). */
app.post("/apc/confirm", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ticket?: unknown } | null;
  const did = typeof body?.ticket === "string" ? body.ticket.match(/^([0-9a-f]{32})\.[0-9a-f]{32}$/)?.[1] : undefined;
  if (!did) return c.json({ ok: false, error: "ticket_expired" }, 400);
  const result = await stubFor(c.env, did).confirm(body);
  return c.json(result, result.ok ? 200 : 400);
});

/** The dock a ticket, claim or reader token belongs to: each starts with the dock's id. */
const dockOf = (value: unknown) => (typeof value === "string" ? value.match(/^([0-9a-f]{32})\.[0-9a-f]{32}$/)?.[1] : undefined);

/**
 * The browser extension asks to send an agent page readings (TIN-421, DESIGN.md 13.5), with the
 * ticket from the agent's drag. Only an allowed extension origin is taken: a page cannot send one.
 */
app.post("/apc/reader", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ticket?: unknown } | null;
  const did = dockOf(body?.ticket);
  if (!did) return c.json({ ok: false, error: "ticket_expired" }, 400);
  const result = await stubFor(c.env, did).reader(body, c.req.header("origin") ?? null);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/apc/reader/status", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { claim?: unknown } | null;
  const did = dockOf(body?.claim);
  if (!did) return c.json({ ok: true, status: "denied" });
  const result = await stubFor(c.env, did).readerStatus(body, c.req.header("origin") ?? null);
  return c.json(result, result.ok ? 200 : 400);
});
/** A page reading, pushed on a drop with the reader's token. */
app.post("/apc/reading", async (c) => {
  const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? null;
  const did = dockOf(token);
  if (!did) return c.json({ ok: false, error: "not_paired" }, 401);
  const result = await stubFor(c.env, did).reading(await c.req.json().catch(() => null), token, c.req.header("origin") ?? null);
  return c.json(result, result.ok ? 200 : result.error === "not_paired" ? 401 : 400);
});

/** The pin's state, and × on it (TIN-469), with the reader's token. */
const bearer = (h: string | undefined) => h?.match(/^Bearer (\S+)$/)?.[1] ?? null;
app.post("/apc/reading/state", async (c) => {
  const token = bearer(c.req.header("authorization"));
  const did = dockOf(token);
  if (!did) return c.json({ ok: false, error: "not_paired" }, 401);
  const result = await stubFor(c.env, did).readingState(token, c.req.header("origin") ?? null);
  return c.json(result, result.ok ? 200 : 401);
});
app.post("/apc/reading/clear", async (c) => {
  const token = bearer(c.req.header("authorization"));
  const did = dockOf(token);
  if (!did) return c.json({ ok: false, error: "not_paired" }, 401);
  const result = await stubFor(c.env, did).readingClear(token, c.req.header("origin") ?? null);
  return c.json(result, result.ok ? 200 : 401);
});
/** The popup's list of readings, and Clear on it (TIN-422), with the reader's token. */
app.post("/apc/reading/log", async (c) => {
  const token = bearer(c.req.header("authorization"));
  const did = dockOf(token);
  if (!did) return c.json({ ok: false, error: "not_paired" }, 401);
  const result = await stubFor(c.env, did).readingLog(token, c.req.header("origin") ?? null);
  return c.json(result, result.ok ? 200 : 401);
});
app.post("/apc/reading/log/clear", async (c) => {
  const token = bearer(c.req.header("authorization"));
  const did = dockOf(token);
  if (!did) return c.json({ ok: false, error: "not_paired" }, 401);
  const result = await stubFor(c.env, did).readingLogClear(token, c.req.header("origin") ?? null);
  return c.json(result, result.ok ? 200 : 401);
});

app.all("/mcp/:did/:secret", async (c) => {
  if (!/^[0-9a-f]{32}$/.test(c.req.param("did"))) return c.json({ error: "not_found" }, 404);
  return stubFor(c.env, c.req.param("did")).fetch(c.req.raw);
});

/**
 * What this origin is (APC 0.5): a dock's hub, not an app (`profiles: ["hub"]`), with where agents'
 * MCP URLs live and where apps pair, so apps and tools can tell a dock from an app.
 */
app.get("/.well-known/apc.json", (c) => apcJsonResponse(hubManifest(new URL(c.req.url).origin)));

/** No OAuth yet: the secret in the MCP URL is the agent's. A 404 here tells a client to connect directly. */
app.all("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/apc/*", (c) => c.json({ error: "not_found" }, 404));
/** V1 lives at /v1/ on this host, served by another Worker. A request that reaches this one anyway is not the dock's. */
app.all("/v1", (c) => c.redirect(`/v1/${new URL(c.req.url).search}`, 302));
app.all("/v1/*", (c) => c.json({ error: "not_found" }, 404));
/**
 * The landing is always the root (TIN-610): a visitor with a dock sees it too, and its "Open your dock" button
 * (GET /api/dock/mine) leads on. The one redirect left is ?start_over=1, the link from another site's Start over
 * dialog (TIN-412), which the dock page answers: a visitor who has a dock goes to /dock?start_over=1.
 */
app.get("/", async (c) => {
  const url = new URL(c.req.url);
  if (url.searchParams.has("start_over") && (await ownsDock(c.env, getCookie(c, COOKIE)))) return c.redirect(`/dock${url.search}`, 302);
  return c.env.ASSETS.fetch(c.req.raw);
});
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
