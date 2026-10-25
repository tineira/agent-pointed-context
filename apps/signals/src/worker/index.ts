/**
 * Signals' Worker (TIN-384): the page's API (owner only, by cookie), pairing with a dock's hub,
 * and each grant's MCP URL (the secret in it is the grant). The page is static assets.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { FEED_TTL_MS, type Env, type Feed } from "./feed.ts";

export { Feed } from "./feed.ts";

const COOKIE = "apc_signals";
type Vars = { sid: string; owner: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

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

/** Resume the visitor's feed (following the seed of the Pulse they came from), or open one for that seed. */
app.post("/api/session", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { seed?: unknown };
  const seed = typeof body.seed === "number" && Number.isInteger(body.seed) && body.seed >= 0 && body.seed < 2 ** 32 ? body.seed : null;
  const current = session(getCookie(c, COOKIE));
  if (current && (await stubFor(c.env, current.sid).isOwner(current.owner))) {
    if (seed !== null) await stubFor(c.env, current.sid).useSeed(seed);
    return c.json({ sid: current.sid, created: false });
  }
  if (seed === null) return c.json({ error: "no_seed" }, 400);
  if (!(await allowed(c.env.NEW_FEED, `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`))) return c.json({ error: "rate_limited" }, 429);
  const sid = randomHex(16);
  const { owner } = await stubFor(c.env, sid).init(seed);
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
  const result = await stub(c).pin(body.grant_id, body.target);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/s/:sid/unpin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { grant_id?: unknown };
  if (typeof body.grant_id !== "string") return c.json({ error: "invalid" }, 400);
  await stub(c).unpin(body.grant_id);
  return c.json({ ok: true });
});
app.post("/api/s/:sid/hub/pair", async (c) => {
  const result = await stub(c).pairHub(c.var.sid, new URL(c.req.url).origin, await c.req.json().catch(() => null));
  return c.json(result, result.ok ? 200 : 400);
});
app.get("/api/s/:sid/ws", async (c) => {
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-apc-owner", c.var.owner);
  return stubFor(c.env, c.var.sid).fetch(new Request(c.req.raw, { headers }));
});

/** A dock's hub gives back a grant (TIN-388). The MCP URL, on this origin, is the proof. */
app.post("/apc/revoke", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { mcp_url?: unknown } | null;
  let m: RegExpMatchArray | null = null;
  try {
    const url = new URL(typeof body?.mcp_url === "string" ? body.mcp_url : "");
    if (url.origin === new URL(c.req.url).origin) m = url.pathname.match(/^\/mcp\/([0-9a-f]{32})\/([0-9a-f]{32})$/);
  } catch {
    m = null;
  }
  if (!m) return c.json({ ok: false, error: "invalid" }, 400);
  const result = await stubFor(c.env, m[1]!).revoke(m[2]!);
  return c.json(result, result.ok ? 200 : 404);
});

app.all("/mcp/:sid/:secret", async (c) => {
  const sid = c.req.param("sid");
  if (!/^[0-9a-f]{32}$/.test(sid)) return c.json({ error: "not_found" }, 404);
  if (!(await allowed(c.env.FEED_CALLS, `s:${sid}`))) return c.json({ error: "rate_limited" }, 429);
  return stubFor(c.env, sid).fetch(c.req.raw);
});

app.all("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/apc/*", (c) => c.json({ error: "not_found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
