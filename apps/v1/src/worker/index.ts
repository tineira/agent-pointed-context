/**
 * The Worker routes, all under /v1 (TIN-604): a visitor's session to their sandbox, the browser API
 * (owner only: the session cookie carries the owner secret), and each agent's MCP URL (the secret in
 * the URL is the grant). The page and its files are static assets under v1/ in the assets directory, so
 * the platform serves them before the Worker runs; a request that matches none reaches the Worker. Under
 * /v1/, an app route ("/v1/how-to") gets the page, v1/index.html. Outside /v1, / redirects to /v1/ and
 * everything else is a 404.
 */
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { BASE } from "../base.ts";
import { REGIONS, type Region } from "../model/seed.ts";
import { SANDBOX_TTL_MS, type Env } from "./sandbox.ts";

export { Sandbox } from "./sandbox.ts";

const COOKIE = "apc_session";
type Stub = DurableObjectStub<import("./sandbox.ts").Sandbox>;
type Vars = { sid: string; owner: string };

const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath(BASE);

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

/** Public uptime probe without opening a sandbox. */
app.get("/api/health", (c) => c.json({ ok: true }, 200, { "cache-control": "no-store" }));

/** Resume the visitor's sandbox, or open a new one. */
app.post("/api/session", async (c) => {
  const current = session(getCookie(c, COOKIE));
  if (current && (await rpc(c.env, current.sid, (s) => s.isOwner(current.owner)))) {
    return c.json({ sid: current.sid, created: false });
  }
  const loadTest = !!c.env.LOADTEST_KEY && c.req.header("x-apc-loadtest") === c.env.LOADTEST_KEY;
  if (!loadTest && !(await allowed(c.env.NEW_SANDBOX, `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`))) return tooMany(c);
  const sid = randomHex(16);
  const { owner } = await rpc(c.env, sid, (s) => s.init());
  setCookie(c, COOKIE, `${sid}.${owner}`, {
    path: BASE,
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
/** A new direct agent. */
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

/** An agent's endpoint: the sandbox checks the grant secret. */
app.all("/mcp/:sid/:secret", async (c) => {
  const sid = c.req.param("sid");
  if (!/^[0-9a-f]{32}$/.test(sid)) return c.json({ error: "not_found" }, 404);
  if (!(await allowed(c.env.SANDBOX_CALLS, `s:${sid}`))) return tooMany(c);
  return stubFor(c.env, sid).fetch(c.req.raw);
});

/**
 * No OAuth: the secret in the MCP URL is the grant, and a 404 under /.well-known tells a client to connect
 * directly. Anything else under these prefixes, with or without a trailing slash (a malformed MCP URL with
 * one or three segments included), is a JSON 404, never the page.
 */
for (const prefix of ["/.well-known", "/api", "/apc", "/mcp"]) {
  app.all(prefix, (c) => c.json({ error: "not_found" }, 404));
  app.all(`${prefix}/*`, (c) => c.json({ error: "not_found" }, 404));
}
/**
 * An app route: a GET or HEAD whose last segment has no file extension ("/v1/how-to", "/v1/customers/cus_0001"),
 * not a missing file ("/v1/assets/gone.js", "/v1/robots.txt").
 */
function isAppRoute(method: string, pathname: string): boolean {
  return (method === "GET" || method === "HEAD") && !/\.[^/]*$/.test(pathname);
}

/**
 * The page. A file under /v1 is normally served before the Worker runs; this sees the rest. An app route gets
 * the page (v1/index.html, fetched as /v1/ since the assets' auto-trailing-slash redirects /v1/index.html),
 * and anything else keeps the assets' 404. There is no index.html at the assets' root, so nothing outside
 * /v1 can fall back to the page.
 */
app.all("*", async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404 || !isAppRoute(c.req.method, new URL(c.req.url).pathname)) return asset;
  return c.env.ASSETS.fetch(new Request(new URL(`${BASE}/`, c.req.url), { method: c.req.method, headers: c.req.raw.headers }));
});

/** The host's root, until phase 0c puts the standard's landing there: V1 is the only thing served. */
const host = new Hono<{ Bindings: Env }>();
host.get("/", (c) => c.redirect(`${BASE}/`, 302));
host.get(BASE, (c) => c.redirect(`${BASE}/`, 302));
host.route("/", app);
host.all("*", (c) => c.json({ error: "not_found" }, 404));

export default host;
