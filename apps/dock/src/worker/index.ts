/**
 * The dock's Worker (TIN-382): the dock page's API (owner only, by cookie), the public pairing
 * endpoint apps call server to server, and each agent's MCP URL (the secret in it is the agent's).
 * The page is static assets: the APC v2 landing at / (TIN-420), the hub dock at /dock, the TIN-370
 * bridge dock at /bridge.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DOCK_TTL_MS, type Env, type Hub } from "./hub.ts";

export { Hub } from "./hub.ts";

const COOKIE = "apc_dock";
type Stub = DurableObjectStub<Hub>;
type Vars = { did: string; owner: string };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const stubFor = (env: Env, did: string): Stub => env.HUB.get(env.HUB.idFromName(did));

function session(cookie: string | undefined): { did: string; owner: string } | null {
  const m = cookie?.match(/^([0-9a-f]{32})\.([0-9a-f]{32})$/);
  return m ? { did: m[1]!, owner: m[2]! } : null;
}

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

app.all("/mcp/:did/:secret", async (c) => {
  if (!/^[0-9a-f]{32}$/.test(c.req.param("did"))) return c.json({ error: "not_found" }, 404);
  return stubFor(c.env, c.req.param("did")).fetch(c.req.raw);
});

/** No OAuth yet: the secret in the MCP URL is the agent's. A 404 here tells a client to connect directly. */
app.all("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/apc/*", (c) => c.json({ error: "not_found" }, 404));
/** The landing, or straight to the dock for a visitor who has one (TIN-420), keeping the query (?start_over=1). */
app.get("/", async (c) => {
  const current = session(getCookie(c, COOKIE));
  if (current && (await stubFor(c.env, current.did).isOwner(current.owner))) return c.redirect(`/dock${new URL(c.req.url).search}`, 302);
  return c.env.ASSETS.fetch(c.req.raw);
});
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
