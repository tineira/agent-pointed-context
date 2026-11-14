/**
 * The dock's Worker (TIN-382): the dock page's API (owner only, by cookie), the public pairing
 * endpoint apps call server to server, and each agent's MCP URL (the secret in it is the agent's).
 * The page is static assets: the landing of the APC standard at / (TIN-420; always, whoever asks, TIN-610) and the hub dock at /dock. /v1 belongs to V1
 * (apc-demo, by zone routes); if a request for it still gets here, it is sent on or refused, never the dock page (TIN-605).
 */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { APC_STANDARD_VERSION, type ApcManifest } from "@tineira/apc-protocol";
import { apcJsonResponse } from "@tineira/apc-server";
import { DOCK_TTL_MS, NOT_OWNER, OWNER_HEADER, type Env, type Hub, type OwnerMethod } from "./hub.ts";
import { deviceLabel, normalizeJoinCode } from "./devices.ts";
import { DIRECTORY } from "./join-codes.ts";
import { withByteRanges } from "./range.ts";
import { loggable } from "./redact.ts";

/** The dock's own apc.json (APC 0.5). Not exported: a Worker's named exports are its entrypoints. */
function hubManifest(origin: string): ApcManifest {
  return { name: "APC dock", standard: APC_STANDARD_VERSION, origin, profiles: ["hub"], mcp: { path: "/mcp/" }, dock: { pair: `${origin}/apc/pair`, confirm: `${origin}/apc/confirm` } };
}

export { Hub } from "./hub.ts";
export { JoinCodes } from "./join-codes.ts";

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

/** A computer removed while its request ran (Hub.asOwner, TIN-909) is answered as one whose cookie no longer opens the dock. */
app.onError((err, c) => {
  if (err instanceof Error && err.message.includes(NOT_OWNER)) return c.json({ error: "dock_expired" }, 404);
  // Nothing from an agent's MCP request (TIN-911): the platform stamps the record with the request URL, which holds the
  // secret. Elsewhere, never the secret an error may quote: an MCP URL, a grant URL, a ticket or a token.
  if (!new URL(c.req.url).pathname.startsWith("/mcp/")) console.error(loggable(err));
  return c.text("Internal Server Error", 500);
});

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const stubFor = (env: Env, did: string): Stub => env.HUB.get(env.HUB.idFromName(did));
const directory = (env: Env) => env.JOIN_CODES.get(env.JOIN_CODES.idFromName(DIRECTORY));
/** How the dock names the computer asking (TIN-838): its browser and system, or the desktop app (it says so in the body). */
const labelOf = (c: Context, desktop?: unknown) => deviceLabel(c.req.header("user-agent"), desktop === true);

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
 * The cookie that names the dock lives as long as the dock: DOCK_TTL_MS after its last use (TIN-823). The hub
 * slides its own end on every use (touch); the cookie is sent again on every resume and every state read, so
 * a dock used daily, or a desktop dock left open for days, never loses its cookie while the dock lives on.
 */
function keepCookie(c: Context, did: string, owner: string): void {
  setCookie(c, COOKIE, `${did}.${owner}`, { path: "/", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", maxAge: Math.floor(DOCK_TTL_MS / 1000) });
}

/**
 * Resume the visitor's dock. It never makes one (TIN-879): with no dock that opens it answers 404 no_dock, and
 * the page asks the person whether to create a new dock or join one on another computer. `replaced` says the
 * cookie named a dock that no longer opens (removed on another computer, Start over there, or the dock ended,
 * TIN-838). { resume: true } (the desktop dock's pets, #84) gets the same answer and only needs the 404.
 */
app.post("/api/dock", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { desktop?: unknown } | null;
  const current = session(getCookie(c, COOKIE));
  if (current && (await stubFor(c.env, current.did).isOwner(current.owner, labelOf(c, body?.desktop)))) {
    keepCookie(c, current.did, current.owner);
    return c.json({ did: current.did, created: false });
  }
  // A cookie for a dock that is gone goes, so the next visits (the pets poll) carry none and wake no object.
  if (current) deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ error: "no_dock", ...(current ? { replaced: true } : {}) }, 404, { "cache-control": "no-store" });
});

/**
 * Join a dock you already have (TIN-838), on a computer that may have no dock or its own: the code the
 * other computer shows, typed or from its link. The directory gives the dock it belongs to, once; that
 * dock asks its computers for a yes. The answer comes with the claim (POST /api/dock/join/status).
 */
/**
 * Only the dock's own page may join (TIN-838). A join hands this browser a cookie for another dock with no
 * cookie of its own to check, so a page on another site must never be able to start or finish one: it
 * would move the person into a dock someone else holds, and their drops to that dock's agents.
 */
function fromThisSite(c: Context): boolean {
  const origin = c.req.header("origin");
  if (origin) return origin === new URL(c.req.url).origin;
  return ["same-origin", "none", undefined].includes(c.req.header("sec-fetch-site"));
}
app.use("/api/dock/new", async (c, next) => (fromThisSite(c) ? next() : c.json({ ok: false, error: "forbidden" }, 403)));
/**
 * Create a dock (TIN-879): only when the person chose Create a new dock, and only from the dock's own page (a
 * page on another site must not be able to mint docks in the visitor's browser). A visitor whose dock still
 * opens gets that one back, so a second Create after the first returned makes no second dock. Two Creates in flight at once, from two tabs with no cookie, can still make two: the last cookie wins and the other dock ends by itself.
 */
app.post("/api/dock/new", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { desktop?: unknown } | null;
  const current = session(getCookie(c, COOKIE));
  const label = labelOf(c, body?.desktop);
  if (current && (await stubFor(c.env, current.did).isOwner(current.owner, label))) {
    keepCookie(c, current.did, current.owner);
    return c.json({ did: current.did, created: false });
  }
  const did = randomHex(16);
  const { owner } = await stubFor(c.env, did).init(did, label);
  keepCookie(c, did, owner);
  return c.json({ did, created: true }, 200, { "cache-control": "no-store" });
});
app.use("/api/dock/join", async (c, next) => (fromThisSite(c) ? next() : c.json({ ok: false, error: "forbidden" }, 403)));
app.use("/api/dock/join/status", async (c, next) => (fromThisSite(c) ? next() : c.json({ ok: false, error: "forbidden" }, 403)));
app.post("/api/dock/join", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { code?: unknown; desktop?: unknown } | null;
  const code = normalizeJoinCode(body?.code);
  if (!code) return c.json({ ok: false, error: "bad_code" }, 400);
  const found = await directory(c.env).take(code, c.req.header("cf-connecting-ip") ?? "");
  if ("error" in found) return c.json({ ok: false, error: found.error }, found.error === "busy" ? 429 : 400);
  const label = labelOf(c, body?.desktop);
  const asked = await stubFor(c.env, found.did).askJoin(code, label);
  if (!asked.ok) return c.json(asked, 400);
  return c.json({ ok: true, claim: `${found.did}.${asked.claim}`, label, check: asked.check }, 200, { "cache-control": "no-store" });
});

/**
 * The answer for a computer waiting to join (TIN-838). Joined: its cookie now opens that dock, and the
 * dock it had before (if any, and another) is left: deleted when nothing was in it, otherwise kept for
 * its other computers and agents until it expires.
 */
app.post("/api/dock/join/status", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { claim?: unknown } | null;
  const m = typeof body?.claim === "string" ? body.claim.match(/^([0-9a-f]{32})\.([0-9a-f]{32})$/) : null;
  if (!m) return c.json({ status: "expired" }, 200, { "cache-control": "no-store" });
  const answer = await stubFor(c.env, m[1]!).joinStatus(m[2]!);
  if (answer.status !== "joined") return c.json({ status: answer.status }, 200, { "cache-control": "no-store" });
  const before = session(getCookie(c, COOKIE));
  if (before && before.did !== m[1]) await stubFor(c.env, before.did).leave(before.owner);
  keepCookie(c, m[1]!, answer.secret);
  return c.json({ status: "joined", did: m[1] }, 200, { "cache-control": "no-store" });
});

app.use("/api/d/:did/*", async (c, next) => {
  // The owner's API answers only the dock's own page (TIN-865). The cookie is SameSite=Lax, so a page on any
  // sibling subdomain would otherwise send it: approve its own pairing, remove agents, reset the dock, or open
  // the socket and read the state. A browser sends Origin on every cross-origin POST and on a WebSocket, and
  // Sec-Fetch-Site on a same-origin GET.
  if (!fromThisSite(c)) return c.json({ error: "forbidden" }, 403);
  const current = session(getCookie(c, COOKIE));
  if (!current || current.did !== c.req.param("did")) return c.json({ error: "forbidden" }, 403);
  if (!(await stubFor(c.env, current.did).isOwner(current.owner, labelOf(c)))) return c.json({ error: "dock_expired" }, 404);
  c.set("did", current.did);
  c.set("owner", current.owner);
  await next();
});

/**
 * An owner method of the dock the cookie opens. The middleware's isOwner ran in a call of its own; asOwner checks
 * the computer again in the same step as the method (TIN-909), so one removed meanwhile reads and does nothing.
 */
const owned = <M extends OwnerMethod>(c: { env: Env; var: Vars }, method: M, ...args: Parameters<Hub[M]>): Promise<Awaited<ReturnType<Hub[M]>>> =>
  (stubFor(c.env, c.var.did) as unknown as Pick<Hub, "asOwner">).asOwner(c.var.owner, method, args);
app.get("/api/d/:did/state", async (c) => {
  keepCookie(c, c.var.did, c.var.owner);
  return c.json(await owned(c, "state", new URL(c.req.url).origin, c.var.owner));
});
/** Link another computer (TIN-838): a new code, kept in the directory for as long as it lives. */
app.post("/api/d/:did/link", async (c) => {
  const made = await owned(c, "newLink");
  if (!made.ok) return c.json(made, 400);
  if (made.dropped.length) await directory(c.env).drop(made.dropped);
  // A code already someone's (45 bits: next to never) is let go and the person asks again.
  if (!(await directory(c.env).put(made.code, c.var.did, made.expires_at))) {
    await owned(c, "cancelLink", made.code);
    return c.json({ ok: false, error: "try_again" }, 400);
  }
  return c.json({ ok: true, code: made.code, expires_at: made.expires_at }, 200, { "cache-control": "no-store" });
});
app.post("/api/d/:did/link/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
  const result = await owned(c, "cancelLink", body.code);
  if (result.ok && typeof body.code === "string") await directory(c.env).drop([body.code]);
  return c.json(result);
});
app.post("/api/d/:did/joins/:jid", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { action?: unknown };
  const result = await owned(c, "decideJoin", c.req.param("jid"), body.action);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/d/:did/devices/:id/remove", async (c) => {
  const result = await owned(c, "removeDevice", c.req.param("id"), c.var.owner);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/d/:did/agents", async (c) => c.json(await owned(c, "addAgent")));
app.post("/api/d/:did/kept", async (c) => c.json(await owned(c, "keptAtHand")));
/** Start over (TIN-411): the dock gives its grants back and forgets everything, and its cookie goes. */
app.post("/api/d/:did/reset", async (c) => {
  await owned(c, "reset");
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});
app.post("/api/d/:did/agents/:aid/ticket", async (c) => {
  const t = await owned(c, "ticket", c.req.param("aid"));
  return t ? c.json(t) : c.json({ error: "unknown_agent" }, 404);
});
app.post("/api/d/:did/agents/:aid/badge", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { badge?: unknown };
  const result = await owned(c, "setBadge", c.req.param("aid"), body.badge);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/d/:did/agents/:aid/remove", async (c) => {
  const result = await owned(c, "removeAgent", c.req.param("aid"));
  return c.json(result, result.ok ? 200 : 404);
});
/** What an agent did (TIN-419), for its page in the dock. */
app.get("/api/d/:did/agents/:aid/calls", async (c) => {
  const result = await owned(c, "calls", c.req.param("aid"));
  return result ? c.json(result) : c.json({ error: "unknown_agent" }, 404);
});
app.post("/api/d/:did/agents/:aid/clear", async (c) => {
  await owned(c, "clearFocus", c.req.param("aid"));
  return c.json({ ok: true });
});
/** Clear on the agent's page (TIN-422): its list of readings, and what the hub still keeps of them. */
app.post("/api/d/:did/agents/:aid/readings/clear", async (c) => {
  const result = await owned(c, "clearReadings", c.req.param("aid"));
  return c.json(result, result.ok ? 200 : 404);
});
app.post("/api/d/:did/pairings/:pid", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { action?: unknown; code?: unknown };
  // The pairing code (APC 0.9): what the dock owner typed, compared in the hub and then dropped.
  const result = await owned(c, "decide", c.req.param("pid"), body.action, body.code);
  return c.json(result, result.ok ? 200 : 400);
});
app.get("/api/d/:did/ws", async (c) => {
  const headers = new Headers(c.req.raw.headers);
  headers.set(OWNER_HEADER, c.var.owner);
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
  // An agent's MCP URL and nothing else (TIN-911): never a path the dock's own object answers otherwise, such as its socket.
  if (!/^[0-9a-f]{32}$/.test(c.req.param("did")) || !/^[0-9a-f]{32}$/.test(c.req.param("secret"))) return c.json({ error: "not_found" }, 404);
  // The header the owner's socket carries is the Worker's word alone: never one a caller sent.
  const headers = new Headers(c.req.raw.headers);
  headers.delete(OWNER_HEADER);
  // A failure here is a bare 500, logged nowhere (TIN-911): any log record of this invocation carries the URL, and its secret.
  try {
    return await stubFor(c.env, c.req.param("did")).fetch(new Request(c.req.raw, { headers }));
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } }, 500);
  }
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
/**
 * The landing's clip and poster (TIN-623): the asset layer ignores Range, and Safari will not play a video
 * without 206 answers, so the Worker serves /media/* and cuts the byte range itself (src/worker/range.ts).
 */
app.on(["GET", "HEAD"], "/media/*", async (c) => {
  const req = c.req.raw;
  // The asset layer's HEAD has no Content-Length, so a HEAD asks it with GET and sends none of the body.
  const asset = await c.env.ASSETS.fetch(req.method === "HEAD" ? new Request(req, { method: "GET" }) : req);
  return withByteRanges(req, asset);
});
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
