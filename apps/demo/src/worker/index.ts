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
type Vars = { stub: DurableObjectStub<import("./sandbox.ts").Sandbox>; owner: string };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const stubFor = (env: Env, sid: string) => env.SANDBOX.get(env.SANDBOX.idFromName(sid));

function session(cookie: string | undefined): { sid: string; owner: string } | null {
  const m = cookie?.match(/^([0-9a-f]{32})\.([0-9a-f]{32})$/);
  return m ? { sid: m[1]!, owner: m[2]! } : null;
}

/** Resume the visitor's sandbox, or open a new one. */
app.post("/api/session", async (c) => {
  const current = session(getCookie(c, COOKIE));
  if (current && (await stubFor(c.env, current.sid).isOwner(current.owner))) return c.json({ sid: current.sid, created: false });
  const sid = randomHex(16);
  const { owner } = await stubFor(c.env, sid).init();
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
  const stub = stubFor(c.env, current.sid);
  if (!(await stub.isOwner(current.owner))) return c.json({ error: "sandbox_expired" }, 404);
  c.set("stub", stub);
  c.set("owner", current.owner);
  await next();
});

app.get("/api/s/:sid/state", async (c) => c.json(await c.var.stub.state()));
app.get("/api/s/:sid/data", async (c) => c.json(await c.var.stub.dataset()));
app.post("/api/s/:sid/view", async (c) => c.json(await c.var.stub.reportView(await c.req.json().catch(() => null))));
app.post("/api/s/:sid/settings", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; on?: boolean };
  if ((body.name !== "share_view" && body.name !== "show_activity") || typeof body.on !== "boolean") return c.json({ error: "invalid" }, 400);
  await c.var.stub.setSetting(body.name, body.on);
  return c.json({ ok: true });
});
app.post("/api/s/:sid/pin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { grant_id?: string; target?: unknown };
  if (typeof body.grant_id !== "string") return c.json({ error: "invalid" }, 400);
  const result = await c.var.stub.pin(body.grant_id, body.target);
  return c.json(result, result.ok ? 200 : 400);
});
app.post("/api/s/:sid/unpin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { grant_id?: string };
  if (typeof body.grant_id !== "string") return c.json({ error: "invalid" }, 400);
  await c.var.stub.unpin(body.grant_id);
  return c.json({ ok: true });
});
app.post("/api/s/:sid/grants/restricted", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { region?: string };
  const region = (REGIONS as readonly string[]).includes(body.region ?? "") ? (body.region as Region) : "latam";
  return c.json(await c.var.stub.addRestrictedGrant(region));
});
app.get("/api/s/:sid/events.jsonl", async (c) => {
  return c.body(await c.var.stub.eventsJsonl(), 200, { "content-type": "application/x-ndjson" });
});
app.get("/api/s/:sid/ws", async (c) => {
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-apc-owner", c.var.owner);
  return c.var.stub.fetch(new Request(c.req.raw, { headers }));
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
