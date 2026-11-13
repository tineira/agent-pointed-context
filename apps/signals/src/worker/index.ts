/**
 * Signals' Worker (TIN-384): the page's API (owner only, by cookie), pairing with a dock's hub,
 * and each grant's MCP URL (the secret in it is the grant). The page is static assets.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { apcJsonResponse, apcManifest, handleDockGiveBack, profilesRefusal } from "@tineira/apc-server";
import { givenBack, isOwnerStateRequest, ownerRequestRefusal, publicOrigin } from "../../../demo/src/worker/dock-app.ts";
import { FEED_TTL_MS, servedProfiles, type Env, type Feed } from "./feed.ts";

export { Feed } from "./feed.ts";

const COOKIE = "apc_signals";
type Vars = { sid: string; owner: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// A typo in APC_PROFILES serves no agent path at all, with the reason in the log and in the answer
// (never both profiles by default). Registered first: Hono runs middleware in registration order.
app.use("/mcp/*", async (c, next) => profilesRefusal(c.env.APC_PROFILES, "Signals") ?? next());
app.use("/apc/*", async (c, next) => profilesRefusal(c.env.APC_PROFILES, "Signals") ?? next());
app.use("/.well-known/apc.json", async (c, next) => profilesRefusal(c.env.APC_PROFILES, "Signals") ?? next());

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const stubFor = (env: Env, sid: string): DurableObjectStub<Feed> => env.FEED.get(env.FEED.idFromName(sid));

function session(cookie: string | undefined): { sid: string; owner: string } | null {
  const m = cookie?.match(/^([0-9a-f]{32})\.([0-9a-f]{32})$/);
  return m ? { sid: m[1]!, owner: m[2]! } : null;
}

async function allowed(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

/**
 * The owner's endpoints (M6, APC 0.10): every state change under /api (the drop, the Allow, Cancel, Revoke, a pin,
 * opening the session) and the page's WebSocket handshake, which is its heartbeat. On top of the session cookie:
 * an `Origin` that is sent must be Signals' configured public origin (PUBLIC_ORIGIN, never this request's own
 * URL), `Sec-Fetch-Site` must not be cross-site or same-site, and a POST must be `application/json`. A request
 * with neither header is a non-browser client and is taken on its session.
 */
app.use("/api/*", async (c, next) => {
  if (!isOwnerStateRequest(c.req.raw)) return next();
  const refusal = ownerRequestRefusal(c.req.raw, publicOrigin(c.env, c.req.url));
  if (refusal) return c.json({ error: refusal }, refusal === "json_required" ? 415 : 403);
  return next();
});

/**
 * Resume the visitor's feed, or open one. Every feed shows the demo's one world (TIN-621): a `seed` in
 * the body, which docks and old links sent, is ignored.
 */
app.post("/api/session", async (c) => {
  // The body is read and dropped: the page still sends one, and an unread body leaves the connection in a state
  // the local runtime answers the next request on with "fetch failed" (TIN-621, mobile-e2e).
  await c.req.text().catch(() => "");
  const current = session(getCookie(c, COOKIE));
  if (current && (await stubFor(c.env, current.sid).isOwner(current.owner))) {
    return c.json({ sid: current.sid, created: false });
  }
  if (!(await allowed(c.env.NEW_FEED, `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`))) return c.json({ error: "rate_limited" }, 429);
  const sid = randomHex(16);
  const { owner } = await stubFor(c.env, sid).init();
  setCookie(c, COOKIE, `${sid}.${owner}`, { path: "/", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", maxAge: Math.floor(FEED_TTL_MS / 1000) });
  return c.json({ sid, created: true });
});

app.use("/api/s/:sid/*", async (c, next) => {
  const current = session(getCookie(c, COOKIE));
  if (!current || current.sid !== c.req.param("sid")) return c.json({ error: "forbidden" }, 403);
  if (!(await allowed(c.env.FEED_CALLS, `s:${current.sid}`))) return c.json({ error: "rate_limited" }, 429);
  if (!(await stubFor(c.env, current.sid).isOwner(current.owner))) return c.json({ error: "expired" }, 404);
  c.set("sid", current.sid);
  c.set("owner", current.owner);
  await next();
});

const stub = (c: { env: Env; var: Vars }) => stubFor(c.env, c.var.sid);
app.get("/api/s/:sid/state", async (c) => c.json(await stub(c).state()));
/** Start over (TIN-411): this feed's data and cookie go. */
app.post("/api/s/:sid/reset", async (c) => {
  await stub(c).reset();
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});
app.post("/api/s/:sid/view", async (c) => c.json(await stub(c).reportView(await c.req.json().catch(() => null))));
app.post("/api/s/:sid/pin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { grant_id?: unknown; target?: unknown };
  if (typeof body.grant_id !== "string") return c.json({ error: "invalid" }, 400);
  const result = await stub(c).pin(body.grant_id, body.target, true);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/s/:sid/unpin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { grant_id?: unknown };
  if (typeof body.grant_id !== "string") return c.json({ error: "invalid" }, 400);
  await stub(c).unpin(body.grant_id);
  return c.json({ ok: true });
});
/** Revoke from the app (APC 0.2, TIN-577): the person cuts an agent at once; the dock's hub is not called. */
app.post("/api/s/:sid/grants/:id/revoke", async (c) => {
  const result = await stub(c).revokeGrant(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 400);
});
/** The Direct profile (TIN-578): the person makes an agent with its own MCP URL, names it, unlinks it. */
app.post("/api/s/:sid/grants/agent", async (c) => {
  const result = await stub(c).addDirectGrant();
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/s/:sid/grants/:id/name", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  return c.json(await stub(c).renameGrant(c.req.param("id"), body.name ?? null));
});
app.post("/api/s/:sid/grants/:id/unlink", async (c) => {
  const result = await stub(c).unlinkGrant(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/s/:sid/hub/pair", async (c) => {
  // The MCP URL Signals hands the hub lives on its configured origin, never on this request's (APC 0.10).
  const origin = publicOrigin(c.env, c.req.url);
  if (!origin) return c.json({ ok: false, error: "not_available" }, 400);
  const result = await stub(c).pairHub(c.var.sid, origin, await c.req.json().catch(() => null));
  return c.json(result, result.ok ? 200 : 400);
});
/** Cancel on the waiting card (APC 0.10): revokes a dock grant the dock has not connected to yet, and only then. */
app.post("/api/s/:sid/hub/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { grant_id?: unknown } | null;
  const grantId = body?.grant_id;
  if (typeof grantId !== "string") return c.json({ ok: false, error: "invalid" }, 400);
  const result = await stub(c).cancelDockGrant(grantId);
  return c.json(result, result.ok ? 200 : 400);
});
app.get("/api/s/:sid/ws", async (c) => {
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-apc-owner", c.var.owner);
  return stubFor(c.env, c.var.sid).fetch(new Request(c.req.raw, { headers }));
});

/**
 * A dock's hub gives back a grant (TIN-388). The MCP URL, on Signals' configured origin, is the proof. Public, so it
 * answers the same HTTP 200 to anything (M7, APC 0.10: a matching URL, an unknown one, junk, another method, a
 * Signals that pairs with no dock), and tells no one whether a grant matched. The grant is found by its secret's
 * hash and ends in any state but revoked or ended.
 */
app.all("/apc/revoke", async (c) => {
  const origin = publicOrigin(c.env, c.req.url);
  if (!origin || !servedProfiles(c.env).includes("dock")) return givenBack();
  return handleDockGiveBack(c.req.raw, {
    origin,
    endGrantBySecretHash: async (hash, url) => {
      const m = url.pathname.match(/^\/mcp\/([0-9a-f]{32})\/[0-9a-f]{32}$/);
      if (m) await stubFor(c.env, m[1]!).endDockGrantBySecretHash(hash);
    },
  });
});

app.all("/mcp/:sid/:secret", async (c) => {
  const sid = c.req.param("sid");
  if (!/^[0-9a-f]{32}$/.test(sid)) return c.json({ error: "not_found" }, 404);
  if (!(await allowed(c.env.FEED_CALLS, `s:${sid}`))) return c.json({ error: "rate_limited" }, 429);
  return stubFor(c.env, sid).fetch(c.req.raw);
});

/**
 * What Signals is, for a dock and any tool (APC 0.5): its name, the standard, its origin, the profiles
 * it offers (APC_PROFILES), where its MCP URLs live, and its Connect panel (?connect).
 */
app.get("/.well-known/apc.json", (c) => apcJsonResponse(apcManifest({ name: "Signals", origin: new URL(c.req.url).origin, profiles: servedProfiles(c.env), connect: "/?connect" })));

app.all("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/apc/*", (c) => c.json({ error: "not_found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
