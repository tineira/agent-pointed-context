/**
 * The hero view (TIN-1070, design TIN-1063): Pulse's framing headers on every answer, the /embed/* routes, the hero's
 * one grant, its message contract with the landing, the build's capability check, and its chart's data. The same
 * headers are read back in workerd and in production by scripts/dock-pairing.mjs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Hono } from "hono";
import { demoDataset } from "../src/model/demo-world.ts";
import type { SandboxState } from "../src/web/api.ts";
import { embedCapabilityProblems, EMBED_FORBIDDEN, type BuiltChunk } from "../src/web/embed/capability.ts";
import { embedGrantKey, ensureEmbedGrant, qualifyingGrant, type EmbedGrantDeps } from "../src/web/embed/grant.ts";
import { createPoster, parentOriginFrom, pulseStatus, themeFrom } from "../src/web/embed/messages.ts";
import { HERO_MONTHS, heroSeries } from "../src/web/embed/months.ts";
import { embedHeroCsp, embedParentOrigin, forbidsFraming } from "../src/worker/embed.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject { constructor() { throw new Error('Unexpected Durable Object'); } }", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const app: Hono = await import(new URL("../src/worker/index.ts", import.meta.url).href).then((m) => m.default).finally(() => hooks.deregister());

const PARENT = "https://apc.tineira.com";
const HERO_HTML = '<!doctype html><html><head><meta name="apc-embed-parent" content="" /></head><body></body></html>';
const HERO_CSP = embedHeroCsp([PARENT]);

/** The Worker's env with a stand-in for the assets: the hero page at /embed-hero, Pulse's SPA everywhere else. */
function envWith(vars: Record<string, string> = {}) {
  const asked: Request[] = [];
  const ASSETS = {
    fetch: async (input: Request | string) => {
      const request = typeof input === "string" ? new Request(input) : input;
      asked.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/embed-hero") return new Response(HERO_HTML, { status: 200, headers: { "content-type": "text/html", etag: '"h"' } });
      // What Workers Assets answers for the .html path under auto-trailing-slash: a redirect to the extensionless one.
      if (path === "/embed-hero.html") return new Response(null, { status: 307, headers: { location: "/embed-hero" } });
      return new Response("<!doctype html><title>Pulse</title>", { status: 200, headers: { "content-type": "text/html" } });
    },
  };
  return { env: { APC_V2: "1", APC_PROFILES: "direct,dock", HUB_ORIGINS: PARENT, PUBLIC_ORIGIN: "https://pulse.apc.tineira.com", EMBED_PARENT_ORIGIN: PARENT, ASSETS, ...vars }, asked };
}

const get = (path: string, headers: Record<string, string> = {}, vars?: Record<string, string>) => {
  const { env, asked } = envWith(vars);
  return Promise.resolve(app.request(`https://pulse.apc.tineira.com${path}`, { headers }, env)).then((response) => ({ response, asked }));
};

function assertNoFraming(response: Response, what: string) {
  const csp = response.headers.get("content-security-policy");
  assert.ok(forbidsFraming(csp), `${what}: frame-ancestors 'none' (got ${csp})`);
  assert.equal(response.headers.get("x-frame-options"), "DENY", `${what}: X-Frame-Options`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${what}: nosniff`);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer", `${what}: Referrer-Policy`);
}

test("no Pulse answer can be framed: pages, the API, a 404, the SPA fallback, other /embed/ paths", async () => {
  for (const path of ["/", "/agents", "/overview", "/connect/dock", "/api/health", "/zzz-probe", "/embed/other", "/embed/hero/", "/embed/", "/api/nope", "/.well-known/apc.json"]) {
    const { response } = await get(path);
    assertNoFraming(response, path);
  }
  assert.equal((await get("/embed/other")).response.status, 404);
  assert.equal((await get("/embed/hero/")).response.status, 404);
  // /connect/dock keeps its own fuller policy, which already forbids framing.
  const dock = (await get("/connect/dock")).response;
  assert.match(dock.headers.get("content-security-policy") ?? "", /^default-src 'self'; script-src 'self' 'unsafe-inline'.*frame-ancestors 'none'/);
  // An owner endpoint's refusal (M6) is covered too: the middleware runs first.
  const { env } = envWith();
  const refused = await app.request("https://pulse.apc.tineira.com/api/session", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }, env);
  assert.equal(refused.status, 403);
  assertNoFraming(refused, "a refused POST");
});

test("/embed/hero opened top level goes to Pulse (302 /), framed it is the hero with its own policy", async () => {
  for (const dest of ["document", "empty", "script"]) {
    const { response } = await get("/embed/hero", { "sec-fetch-dest": dest });
    assert.equal(response.status, 302, dest);
    assert.equal(new URL(response.headers.get("location")!, "https://pulse.apc.tineira.com").pathname, "/");
    assertNoFraming(response, `the ${dest} redirect`);
  }
  const { response, asked } = await get("/embed/hero?anything=1", { "sec-fetch-dest": "iframe", "if-none-match": '"h"', "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT", referer: "http://localhost:4173/" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), HERO_CSP);
  assert.equal(HERO_CSP, "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://apc.tineira.com");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  // The asset is asked for extensionless (a 200 under auto-trailing-slash), without the visitor's conditional headers.
  assert.equal(asked.length, 1);
  assert.equal(new URL(asked[0]!.url).pathname, "/embed-hero");
  assert.equal(asked[0]!.headers.get("if-none-match"), null);
  assert.equal(asked[0]!.headers.get("if-modified-since"), null);
  // The page names its parent; outside `vite dev` a Referer never changes it.
  assert.match(await response.text(), /<meta name="apc-embed-parent" content="https:\/\/apc\.tineira\.com" \/>/);
  // No Sec-Fetch-Dest (an old browser): served, framed only by the parent.
  assert.equal((await get("/embed/hero")).response.headers.get("content-security-policy"), HERO_CSP);
});

test("the hero answers 404 without a valid EMBED_PARENT_ORIGIN, and other methods are not the hero", async () => {
  for (const value of ["", "http://apc.tineira.com", "https://apc.tineira.com/", "https://apc.tineira.com https://evil.example", "*", "'none'"]) {
    const { response } = await get("/embed/hero", { "sec-fetch-dest": "iframe" }, { EMBED_PARENT_ORIGIN: value });
    assert.equal(response.status, 404, JSON.stringify(value));
    assertNoFraming(response, `no parent ${JSON.stringify(value)}`);
  }
  assert.equal(embedParentOrigin({ EMBED_PARENT_ORIGIN: " https://apc.tineira.com " }), PARENT);
  const { env } = envWith();
  const posted = await app.request("https://pulse.apc.tineira.com/embed/hero", { method: "POST", headers: { "sec-fetch-dest": "iframe" } }, env);
  assert.equal(posted.status, 404);
  assertNoFraming(posted, "POST /embed/hero");
});

test("forbidsFraming keeps only a policy that forbids every frame", () => {
  assert.equal(forbidsFraming(null), false);
  assert.equal(forbidsFraming("default-src 'self'"), false);
  assert.equal(forbidsFraming("frame-ancestors https://apc.tineira.com"), false);
  assert.equal(forbidsFraming("frame-ancestors 'none' https://x.example"), false);
  assert.equal(forbidsFraming("default-src 'self'; FRAME-ANCESTORS 'none' ;"), true);
});

test("public/_headers sets the same framing headers on what the assets answer first", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const rules = headers.split("\n").filter((l) => !l.startsWith("#") && l.trim());
  assert.deepEqual(rules, ["/*", "  Content-Security-Policy: frame-ancestors 'none'", "  X-Frame-Options: DENY", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: no-referrer"]);
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(wrangler, /"run_worker_first": \["\/embed\/\*",/);
  // The Worker fetches the hero's page from the assets: without the binding, /embed/hero is a 500 (found in workerd).
  assert.match(wrangler, /"assets": \{[^}]*"binding": "ASSETS"/);
  assert.match(wrangler, /"EMBED_PARENT_ORIGIN": "https:\/\/apc\.tineira\.com"/);
});

// The hero's one grant.

const grant = (id: string, extra: Partial<SandboxState["grants"][number]> = {}) => ({
  id, secret: `s_${id}`, label: id, client_name: null, client_icon: null, client_ua: null, client_title: null, agent_name: null, owner_name: null,
  conflict: null, regions: null, created_at: "2026-11-21T00:00:00Z", last_active_at: null, pin: null, ...extra,
});
const stateOf = (grants: SandboxState["grants"], hubLinks: SandboxState["hub_links"] = []): SandboxState =>
  ({ settings: { share_view: true, show_activity: true }, grants, tour: { step: "off", grant_id: null }, hub_links: hubLinks, expires_at: "" });

function fakeDeps(state: SandboxState, remembered: Record<string, string> = {}) {
  const stored = new Map(Object.entries(remembered));
  let mints = 0;
  let next = 0;
  const deps: EmbedGrantDeps & { mints: () => number; stored: Map<string, string> } = {
    state: async () => state,
    mint: async () => {
      mints++;
      await new Promise((r) => setTimeout(r, 5));
      return { status: 200, json: { id: `g_new${++next}` } };
    },
    storage: { get: (k) => stored.get(k) ?? null, set: (k, v) => void stored.set(k, v) },
    mints: () => mints,
    stored,
  };
  return deps;
}

test("the hero makes one grant per sandbox, shared by concurrent opens, and remembers it", async () => {
  const deps = fakeDeps(stateOf([grant("g_first")]));
  const [a, b] = await Promise.all([ensureEmbedGrant("sid1", deps), ensureEmbedGrant("sid1", deps)]);
  assert.deepEqual(a, { ok: true, grantId: "g_new1", made: true });
  assert.deepEqual(b, a);
  assert.equal(deps.mints(), 1);
  assert.equal(deps.stored.get(embedGrantKey("sid1")), "g_new1");
  assert.equal(embedGrantKey("sid1"), "apc:embed-hero-grant:sid1");
});

test("a remembered grant is reused only while it qualifies; never another grant", async () => {
  const key = embedGrantKey("s");
  const reuse = fakeDeps(stateOf([grant("g_first"), grant("g_mine")]), { [key]: "g_mine" });
  assert.deepEqual(await ensureEmbedGrant("s", reuse), { ok: true, grantId: "g_mine", made: false });
  assert.equal(reuse.mints(), 0);
  for (const [why, state] of [
    ["gone (revoked)", stateOf([grant("g_first")])],
    ["restricted", stateOf([grant("g_mine", { regions: ["latam"] })])],
    ["a dock's", stateOf([grant("g_mine")], [{ hub: PARENT, agent: "ag", grant_id: "g_mine" }])],
    ["no secret", stateOf([grant("g_mine", { secret: "" })])],
  ] as const) {
    const deps = fakeDeps(state, { [key]: "g_mine" });
    const result = await ensureEmbedGrant("s", deps);
    assert.equal(deps.mints(), 1, why);
    assert.ok(result.ok && result.grantId !== "g_mine" && result.grantId !== "g_first", why);
  }
  assert.equal(qualifyingGrant(stateOf([grant("g_first")]), null), null);
});

test("each tab looks again under the lock, so two tabs make one grant", async () => {
  const stored = new Map<string, string>();
  const grants = [grant("g_first")];
  let mints = 0;
  let queue = Promise.resolve();
  const locks = { request: <T>(_name: string, cb: () => Promise<T>) => { const run = queue.then(cb); queue = run.then(() => undefined, () => undefined); return run; } };
  const tab = (): EmbedGrantDeps => ({
    state: async () => stateOf(grants),
    mint: async () => { mints++; const g = grant(`g_tab${mints}`); grants.push(g); return { status: 200, json: { id: g.id } }; },
    storage: { get: (k) => stored.get(k) ?? null, set: (k, v) => void stored.set(k, v) },
    locks,
  });
  // Two tabs are two pages: their in-flight promises are their own, so each calls under a sandbox id of its own here.
  const first = await ensureEmbedGrant("tabs", tab());
  const second = await ensureEmbedGrant("tabs", tab());
  assert.equal(mints, 1);
  assert.ok(first.ok && second.ok && first.grantId === second.grantId);
});

test("making the grant fails into the hero's inline messages: the cap, a rate limit, anything else", async () => {
  const at = (status: number, json: { error?: string } | null) => ({ ...fakeDeps(stateOf([])), mint: async () => ({ status, json }) });
  assert.deepEqual(await ensureEmbedGrant("e1", at(400, { error: "too_many" })), { ok: false, error: "too_many" });
  assert.deepEqual(await ensureEmbedGrant("e2", at(429, { error: "rate_limited" })), { ok: false, error: "rate_limited" });
  assert.deepEqual(await ensureEmbedGrant("e3", at(500, null)), { ok: false, error: "failed" });
  assert.deepEqual(await ensureEmbedGrant("e4", at(404, { error: "dock_only" })), { ok: false, error: "failed" });
  const throwing = { ...fakeDeps(stateOf([])), state: async () => { throw new Error("down"); } };
  assert.deepEqual(await ensureEmbedGrant("e5", { ...throwing, storage: { get: () => "g", set: () => {} } }), { ok: false, error: "failed" });
});

// The message contract (§ 5).

test("the hero posts to its parent's origin only, ready once, status on change, never a secret", () => {
  const sent: Array<[unknown, string]> = [];
  const poster = createPoster(PARENT, { postMessage: (m, o) => sent.push([m, o]) });
  poster.ready();
  poster.ready();
  const g = grant("g_mine", { client_name: "claude-ai" });
  poster.status(pulseStatus(null, null));
  poster.status(pulseStatus(grant("g_mine"), "Your agent"));
  poster.status(pulseStatus(g, "Claude"));
  poster.status(pulseStatus(g, "Claude"));
  poster.resize(612.2);
  poster.resize(613);
  assert.deepEqual(sent, [
    [{ type: "apc:embed-ready" }, PARENT],
    [{ type: "apc:pulse-status", connected: false, agentName: null }, PARENT],
    [{ type: "apc:pulse-status", connected: true, agentName: "Claude" }, PARENT],
    [{ type: "apc:embed-resize", height: 613 }, PARENT],
  ]);
  assert.ok(!JSON.stringify(sent).includes("s_g_mine") && !JSON.stringify(sent).includes("g_mine"));
  // No parent origin: nothing is sent.
  const none: unknown[] = [];
  const silent = createPoster(null, { postMessage: (m) => none.push(m) });
  silent.ready();
  silent.status(pulseStatus(g, "Claude"));
  assert.equal(none.length, 0);
});

test("the agent's name reaches the landing cleaned: one line, no control or bidi characters, 40 characters", () => {
  const g = grant("g", { client_name: "x" });
  assert.equal(pulseStatus(g, "Evil‮gnp.exe\nname").agentName, "Evil gnp.exe name");
  assert.equal(pulseStatus(g, "a".repeat(80)).agentName, "a".repeat(40));
});

test("apc:theme is taken only from the parent's origin and window, light or dark", () => {
  const parent = {};
  const ok = { origin: PARENT, source: parent, data: { type: "apc:theme", scheme: "light" } };
  assert.equal(themeFrom(ok, PARENT, parent), "light");
  assert.equal(themeFrom({ ...ok, data: { type: "apc:theme", scheme: "dark" } }, PARENT, parent), "dark");
  assert.equal(themeFrom({ ...ok, origin: "https://evil.example" }, PARENT, parent), null);
  assert.equal(themeFrom({ ...ok, source: {} }, PARENT, parent), null);
  assert.equal(themeFrom({ ...ok, data: { type: "apc:theme", scheme: "sepia" } }, PARENT, parent), null);
  assert.equal(themeFrom({ ...ok, data: "apc:theme" }, PARENT, parent), null);
  assert.equal(themeFrom(ok, null, parent), null);
});

test("the page's parent origin is one bare origin or nothing", () => {
  assert.equal(parentOriginFrom(PARENT), PARENT);
  assert.equal(parentOriginFrom("http://localhost:4173"), "http://localhost:4173");
  for (const bad of ["", null, undefined, "*", "https://apc.tineira.com/", "javascript:alert(1)", "apc.tineira.com"]) assert.equal(parentOriginFrom(bad), null, String(bad));
});

// The build's capability check.

const chunk = (fileName: string, code: string, extra: Partial<BuiltChunk> = {}): BuiltChunk => ({ fileName, name: fileName, isEntry: false, imports: [], dynamicImports: [], code, ...extra });

test("the build fails when the hero's chunks name an action the hero must not reach", () => {
  const shared = chunk("shared.js", "fetch('/api/s/'+s+'/pin')");
  const entry = chunk("embed.js", "import './shared.js'", { name: "embedHero", isEntry: true, imports: ["shared.js"], dynamicImports: ["lazy.js"] });
  const app = chunk("main.js", "fetch('/grants/'+id+'/revoke'); fetch('/reset')", { name: "main", isEntry: true });
  assert.deepEqual(embedCapabilityProblems([entry, shared, chunk("lazy.js", "x"), app]), []);
  for (const path of EMBED_FORBIDDEN) {
    const problems = embedCapabilityProblems([entry, shared, chunk("lazy.js", `fetch(base + "${path}")`), app]);
    assert.deepEqual(problems, [`lazy.js names "${path}"`]);
  }
  assert.deepEqual(embedCapabilityProblems([app]), ['no "embedHero" entry in the build']);
});

// The chart's data.

test("the hero shows the landing's months, with Pulse's own values", () => {
  const script = readFileSync(new URL("../../../scripts/build-hero-data.mjs", import.meta.url), "utf8");
  const months = JSON.parse(script.match(/export const HERO_MONTHS = (\[[^\]]*\])/)![1]!) as string[];
  assert.deepEqual([...HERO_MONTHS], months);
  const site = JSON.parse(readFileSync(new URL("../../site/src/web/hero-data.json", import.meta.url), "utf8")) as { months: Array<{ month: string; get_figure: { values: { active: number } } }> };
  assert.deepEqual(heroSeries(demoDataset()), site.months.map((m) => ({ month: m.month, value: m.get_figure.values.active })));
});
