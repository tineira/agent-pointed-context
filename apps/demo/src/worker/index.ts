/**
 * The Worker routes: a visitor's session to their sandbox, the browser API
 * (owner only: the session cookie carries the owner secret), and each
 * agent's MCP URL (the secret in the URL is the grant). The page itself is
 * served as static assets.
 */
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { REGIONS, type Region } from "../model/seed.ts";
import { SANDBOX_TTL_MS, type Env } from "./sandbox.ts";

export { Sandbox } from "./sandbox.ts";

const COOKIE = "apc_session";
type Stub = DurableObjectStub<import("./sandbox.ts").Sandbox>;
type Vars = { sid: string; owner: string };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const stubFor = (env: Env, sid: string): Stub => env.SANDBOX.get(env.SANDBOX.idFromName(sid));

/**
 * Call a sandbox, retrying a retryable failure with a fresh stub (a stub is
 * broken after one). Every RPC method of the sandbox is idempotent: init
 * returns the existing owner, reads only read, a pin replaces the pin.
 */
async function rpc<T>(env: Env, sid: string, call: (stub: Stub) => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(stubFor(env, sid));
    } catch (error) {
      const retryable = (error as { retryable?: boolean }).retryable === true || /Network connection lost/i.test(String(error));
      if (!retryable || attempt >= tries) throw error;
    }
  }
}

function session(cookie: string | undefined): { sid: string; owner: string } | null {
  const m = cookie?.match(/^([0-9a-f]{32})\.([0-9a-f]{32})$/);
  return m ? { sid: m[1]!, owner: m[2]! } : null;
}

/** A rate limit that fails open: no binding (local tests) or a limiter error never blocks a visitor. */
async function allowed(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}
const tooMany = (c: { json: (body: unknown, status: 429, headers: Record<string, string>) => Response }) =>
  c.json({ error: "rate_limited", message: "Too many requests; try again in a minute." }, 429, { "retry-after": "60" });

/** Resume the visitor's sandbox, or open a new one. */
app.post("/api/session", async (c) => {
  // On Pulse's v2 deploy, the world a dock opened it on (TIN-393). Ignored on apc.tineira.com.
  const body = (await c.req.json().catch(() => ({}))) as { seed?: unknown };
  const seed = c.env.APC_V2 === "1" && typeof body.seed === "number" && Number.isInteger(body.seed) && body.seed >= 0 && body.seed < 2 ** 32 ? body.seed : undefined;
  const current = session(getCookie(c, COOKIE));
  if (current && (await rpc(c.env, current.sid, (s) => s.isOwner(current.owner)))) {
    if (seed !== undefined) await rpc(c.env, current.sid, (s) => s.useSeed(seed));
    return c.json({ sid: current.sid, created: false });
  }
  const loadTest = !!c.env.LOADTEST_KEY && c.req.header("x-apc-loadtest") === c.env.LOADTEST_KEY;
  if (!loadTest && !(await allowed(c.env.NEW_SANDBOX, `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`))) return tooMany(c);
  const sid = randomHex(16);
  const { owner } = await rpc(c.env, sid, (s) => s.init(seed));
  setCookie(c, COOKIE, `${sid}.${owner}`, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: Math.floor(SANDBOX_TTL_MS / 1000),
  });
  return c.json({ sid, created: true });
});

/** Everything under /api/s/:sid is the owner's: the cookie must name this sandbox and its owner secret. */
app.use("/api/s/:sid/*", async (c, next) => {
  const current = session(getCookie(c, COOKIE));
  if (!current || current.sid !== c.req.param("sid")) return c.json({ error: "forbidden" }, 403);
  if (!(await allowed(c.env.SANDBOX_CALLS, `s:${current.sid}`))) return tooMany(c);
  if (!(await rpc(c.env, current.sid, (s) => s.isOwner(current.owner)))) return c.json({ error: "sandbox_expired" }, 404);
  c.set("sid", current.sid);
  c.set("owner", current.owner);
  await next();
});

app.get("/api/s/:sid/state", async (c) => c.json(await rpc(c.env, c.var.sid, (s) => s.state())));
app.post("/api/s/:sid/view", async (c) => {
  const view = await c.req.json().catch(() => null);
  return c.json(await rpc(c.env, c.var.sid, (s) => s.reportView(view)));
});
app.post("/api/s/:sid/settings", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; on?: boolean };
  const { name, on } = body;
  if ((name !== "share_view" && name !== "show_activity") || typeof on !== "boolean") return c.json({ error: "invalid" }, 400);
  await rpc(c.env, c.var.sid, (s) => s.setSetting(name, on));
  return c.json({ ok: true });
});
app.post("/api/s/:sid/pin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { grant_id?: string; target?: unknown };
  const grantId = body.grant_id;
  if (typeof grantId !== "string") return c.json({ error: "invalid" }, 400);
  const result = await rpc(c.env, c.var.sid, (s) => s.pin(grantId, body.target));
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/s/:sid/unpin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { grant_id?: string };
  const grantId = body.grant_id;
  if (typeof grantId !== "string") return c.json({ error: "invalid" }, 400);
  await rpc(c.env, c.var.sid, (s) => s.unpin(grantId));
  return c.json({ ok: true });
});
app.post("/api/s/:sid/grants/restricted", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { region?: string };
  const region = (REGIONS as readonly string[]).includes(body.region ?? "") ? (body.region as Region) : "latam";
  return c.json(await rpc(c.env, c.var.sid, (s) => s.addRestrictedGrant(region)));
});
app.post("/api/s/:sid/grants/:id/name", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  return c.json(await rpc(c.env, c.var.sid, (s) => s.renameGrant(c.req.param("id"), body.name ?? null)));
});
app.post("/api/s/:sid/grants/:id/conflict", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { action?: unknown };
  return c.json(await rpc(c.env, c.var.sid, (s) => s.resolveConflict(c.req.param("id"), body.action)));
});
app.post("/api/s/:sid/tour", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { action?: unknown };
  return c.json(await rpc(c.env, c.var.sid, (s) => s.tourAction(body.action)));
});
/** APC v2 (TIN-382): pair an agent dropped from a dock; the sandbox refuses it outside Pulse's v2 deploy. */
app.post("/api/s/:sid/hub/pair", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await rpc(c.env, c.var.sid, (s) => s.pairHub(c.var.sid, new URL(c.req.url).origin, body), 1);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/s/:sid/grants/agent", async (c) => c.json(await rpc(c.env, c.var.sid, (s) => s.addAgentGrant())));
app.get("/api/s/:sid/compat.json", async (c) => c.json(await rpc(c.env, c.var.sid, (s) => s.compat())));
app.get("/api/s/:sid/events.jsonl", async (c) =>
  c.body(await rpc(c.env, c.var.sid, (s) => s.eventsJsonl()), 200, { "content-type": "application/x-ndjson" }),
);
app.get("/api/s/:sid/ws", async (c) => {
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-apc-owner", c.var.owner);
  return stubFor(c.env, c.var.sid).fetch(new Request(c.req.raw, { headers }));
});

/**
 * APC v2 (TIN-388): a dock's hub gives back a grant Pulse made for it. The MCP URL is the proof;
 * it must be this origin's. Only on Pulse's v2 deploy.
 */
app.post("/apc/revoke", async (c) => {
  if (c.env.APC_V2 !== "1") return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { mcp_url?: unknown } | null;
  let m: RegExpMatchArray | null = null;
  try {
    const url = new URL(typeof body?.mcp_url === "string" ? body.mcp_url : "");
    if (url.origin === new URL(c.req.url).origin) m = url.pathname.match(/^\/mcp\/([0-9a-f]{32})\/([0-9a-f]{32})$/);
  } catch {
    m = null;
  }
  if (!m) return c.json({ ok: false, error: "invalid" }, 400);
  const result = await rpc(c.env, m[1]!, (s) => s.revokeHubGrant(m![2]!), 1);
  return c.json(result, result.ok ? 200 : 404);
});

/** An agent's endpoint: the sandbox checks the grant secret. */
app.all("/mcp/:sid/:secret", async (c) => {
  const sid = c.req.param("sid");
  if (!/^[0-9a-f]{32}$/.test(sid)) return c.json({ error: "not_found" }, 404);
  if (!(await allowed(c.env.SANDBOX_CALLS, `s:${sid}`))) return tooMany(c);
  return stubFor(c.env, sid).fetch(c.req.raw);
});

/** No OAuth: the secret in the MCP URL is the grant. A 404 here tells a client to connect directly. */
app.all("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/apc/*", (c) => c.json({ error: "not_found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
