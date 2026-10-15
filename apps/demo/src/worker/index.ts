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

/** Resume the visitor's sandbox, or open a new one. */
app.post("/api/session", async (c) => {
  const current = session(getCookie(c, COOKIE));
  if (current && (await rpc(c.env, current.sid, (s) => s.isOwner(current.owner)))) return c.json({ sid: current.sid, created: false });
  const sid = randomHex(16);
  const { owner } = await rpc(c.env, sid, (s) => s.init());
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
  if (!(await rpc(c.env, current.sid, (s) => s.isOwner(current.owner)))) return c.json({ error: "sandbox_expired" }, 404);
  c.set("sid", current.sid);
  c.set("owner", current.owner);
  await next();
});

app.get("/api/s/:sid/state", async (c) => c.json(await rpc(c.env, c.var.sid, (s) => s.state())));
app.get("/api/s/:sid/data", async (c) => c.json(await rpc(c.env, c.var.sid, (s) => s.dataset())));
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
  return stubFor(c.env, sid).fetch(c.req.raw);
});

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
