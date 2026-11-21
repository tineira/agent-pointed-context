#!/usr/bin/env node
/**
 * Dock pairing through the app's consent, the owner's code, and the MCP introduction (TIN-900).
 *
 *   the dock opens → its agent connects → the owner requests Connect → opens Pulse with the connect ticket → Allow → Pulse calls the
 *   hub's /apc/pair (pairWithHub) → the dock owner approves with the pairing code → the hub's `initialize` to
 *   Pulse → the agent reads Pulse through its dock → a second drop (confirmWithHub, /apc/confirm) → the dock
 *   removes the agent and gives the grant back (/apc/revoke) → Pulse ends the grant.
 *
 * Two places to run it:
 *
 * - **In workerd** (the default; CI's `check` job, after `pnpm build`; `pnpm test:workerd`): built Pulse and
 *   Signals use their shipped Worker configs and SQLite Durable Objects. Their outbound fetches to the hub go
 *   through workerd to a local Worker running the conformance suite's standInHub. It calls the apps back through
 *   workerd on their public origins. A local router handles these hosts and refuses outside network calls.
 *   `pnpm test` runs this code on Node, which accepts options Workers rejects: `fetch(..., { redirect: "error" })`
 *   broke every Dock pairing in production from APC 0.9 to 0.11.0 while CI stayed green. This catches what the
 *   runtime's APIs reject. It does not cover the network or the edge (DNS, TLS, Cloudflare's own routing between
 *   Workers, WAF): the production run does.
 * - **`--production`** (after "Deploy the APC standard"): the same steps against apc.tineira.com and
 *   pulse.apc.tineira.com, with a new dock and a new sandbox (synthetic data), sent as `apc-deploy-smoke`. It tries
 *   twice, 20 s apart. Each try ends by starting its dock and sandbox over, whether the steps passed or not, and the
 *   whole run has its own deadline (TOTAL_MS), shorter than the CI step's, so that cleanup always gets to run. A
 *   failed Start over after a pairing that passed is a warning, not a failure. No secret.
 *
 * Before the pairing, once and before any try: the docs read with a plain GET, no JavaScript (TIN-914), and Pulse's
 * and Signals' framing headers (TIN-1070, TIN-1093). A failure there fails the run without making a dock or a sandbox.
 *
 * Exit code 0 only when the pairing passed; the last line is the summary. On a failure in GitHub Actions the first
 * failing step is also an `::error::` annotation.
 */

import { SITE_CSP } from "../apps/site/src/worker/csp.ts";
import { EMBED_HERO_MARKER, effectiveFrameAncestors, embedHeroCsp } from "../apps/demo/src/worker/embed.ts";
import { startWorkerd } from "./lib/dock-workerd.mjs";

const PRODUCTION = process.argv.includes("--production");
const DOCK = "https://apc.tineira.com";
const PULSE = "https://pulse.apc.tineira.com";
const SIGNALS = "https://signals.apc.tineira.com";
/** One request; the pairing steps of one try; the whole run, cleanup included (the CI step allows 6 minutes). */
const STEP_MS = 15_000;
const TRY_MS = PRODUCTION ? 75_000 : 60_000;
const TOTAL_MS = 300_000;
const TRIES = PRODUCTION ? 2 : 1;
const RETRY_AFTER_MS = 20_000;
/** The agent's MCP client name: the dock's session counts leave a deploy's check out by it (scripts/lib/mcp-sessions.mjs). */
const CLIENT = { name: PRODUCTION ? "apc-deploy-smoke" : "apc-workerd-pairing", version: "1.0.0" };
/** The user agent of every request: the dock names the smoke's computer after it, and its logs show it. */
const USER_AGENT = `${CLIENT.name}/1.0 (+https://github.com/tineira/agent-pointed-context, TIN-900)`;
const where = PRODUCTION ? "production" : "workerd";
const CI = !!process.env.GITHUB_ACTIONS;

/** What a failure prints of an answer: its status and its error word, never its body (codes, nonces, URLs). */
const brief = (r) => (r && typeof r === "object" && "status" in r ? `HTTP ${r.status}${r.json?.error ? ` ${r.json.error}` : ""}` : String(r ?? ""));

function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms)))]).finally(() => clearTimeout(timer));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const started = Date.now();
let runtime = { send: (url, init) => fetch(url, init), stop: async () => {} };

/** One try: its own cookies, what it made (to start over), and its result. */
function newTry(n, label = TRIES > 1 ? `[try ${n}] ` : "") {
  const t = { n, failed: 0, firstFailure: null, warnings: [], jar: new Map(), made: { dock: null, pulse: null }, cleaned: false };
  t.check = (ok, what, detail) => {
    if (ok) console.log(`${label}ok - ${what}`);
    else {
      t.failed++;
      t.firstFailure ??= what;
      console.log(`${label}not ok - ${what}${detail === undefined ? "" : ` (${typeof detail === "string" ? detail.slice(0, 200) : brief(detail)})`}`);
    }
    return ok;
  };
  t.must = (ok, what, detail) => {
    if (!t.check(ok, what, detail)) throw Object.assign(new Error(`stopped at: ${what}`), { counted: true });
  };
  t.warn = (what) => {
    t.warnings.push(what);
    console.log(`${label}warning - ${what}`);
  };

  /** A browser, as far as these calls need one: a cookie per site, and Pulse's owner headers (M6). */
  t.call = async (url, { method = "GET", body, ms = STEP_MS } = {}) => {
    const { origin, pathname } = new URL(url);
    const headers = { accept: "application/json", "user-agent": USER_AGENT };
    if (t.jar.has(origin)) headers.cookie = t.jar.get(origin);
    if (method !== "GET") Object.assign(headers, { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" });
    // A POST the Worker does not read is sent without a body: workerd answers the next request on a connection whose
    // body was left unread with a reset (local only).
    const response = await withDeadline(runtime.send(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }), ms, `${method} ${pathname.replace(/[0-9a-f]{32}/g, ":id")}`);
    for (const c of response.headers.getSetCookie()) t.jar.set(origin, c.split(";")[0]);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };

  /** One JSON-RPC message to an agent's MCP URL, as an agent sends it. */
  t.rpc = async (url, method, params, id = 1) => {
    const response = await withDeadline(
      runtime.send(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": USER_AGENT }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }),
      STEP_MS,
      `rpc ${method}`,
    );
    const text = await response.text();
    if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status}`);
    const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
    return JSON.parse(line);
  };

  /** Production: both Start overs, each tried twice; a failure here is a warning, never the run's result. */
  t.cleanup = async () => {
    if (!PRODUCTION || t.cleaned) return;
    t.cleaned = true;
    for (const [what, base] of [["the dock", t.made.dock], ["the sandbox", t.made.pulse]]) {
      if (!base) continue;
      let last = null;
      for (let i = 0; i < 2; i++) {
        last = await t.call(`${base}/reset`, { method: "POST", ms: 10_000 }).catch((e) => e?.message ?? String(e));
        if (last?.status === 200) break;
      }
      if (last?.status === 200) console.log(`${label}ok - ${what} starts over`);
      else t.warn(`${what} did not start over (${brief(last)}); it ends by itself (the dock 7 days after its last use, the sandbox after 6 h idle)`);
    }
  };
  return t;
}

/** A well-formed code that is not this one: its first character changed (codes are digits and capitals). */
const wrongCode = (code) => (code[0] === "0" ? "1" : "0") + code.slice(1);

/**
 * The docs read with a plain GET and no JavaScript (TIN-914): a crawler or an agent with only HTTP gets the page's
 * text in its HTML, the page as Markdown beside it, and /llms.txt naming every page.
 */
async function readDocs(t) {
  const get = async (path) => {
    const response = await withDeadline(runtime.send(`${DOCK}${path}`, { headers: { "user-agent": USER_AGENT }, redirect: "manual" }), STEP_MS, `GET ${path}`);
    return { status: response.status, type: response.headers.get("content-type") ?? "", csp: response.headers.get("content-security-policy"), frame: response.headers.get("x-frame-options"), text: await response.text() };
  };
  const html = await get("/docs/spec");
  t.check(html.status === 200 && /<article class="docs-body"><h1 id="[^"]+">[^<]/.test(html.text) && html.text.includes('<link rel="alternate" type="text/markdown" href="/docs/spec.md"'), "a plain GET of /docs/spec has the spec's text, and names its Markdown", `HTTP ${html.status}`);
  // The site's strict CSP (TIN-1013, TIN-1036) as served: a site page runs as the dock's owner on this origin.
  t.check(html.csp === SITE_CSP && html.frame === "DENY", "/docs/spec carries the site's CSP and X-Frame-Options: DENY", `CSP ${html.csp}; X-Frame-Options ${html.frame}`);
  if (PRODUCTION) {
    // The landing reaches the site through the hub's / proxy, which tineira/agent-dock deploys; it keeps the site's CSP.
    const landing = await get("/");
    t.check(landing.status === 200 && landing.csp === SITE_CSP && landing.frame === "DENY", "the landing (/) carries the site's CSP through the hub", `HTTP ${landing.status}; CSP ${landing.csp}`);
  }
  const md = await get("/docs/spec.md");
  t.check(md.status === 200 && /^# \S/.test(md.text) && !md.text.includes("<div id=") && /markdown|text\/plain/.test(md.type), "/docs/spec.md is the spec as Markdown", `HTTP ${md.status} ${md.type}`);
  const llms = await get("/llms.txt");
  t.check(llms.status === 200 && llms.text.includes("(/docs/spec.md)") && llms.text.includes("(/docs/integrate.md)"), "/llms.txt names the docs' Markdown", `HTTP ${llms.status}`);
}

/**
 * Pulse's framing headers as served (TIN-1070, design TIN-1063 § 6.3 item 5): no Pulse page can be framed by any site
 * (the assets' answers through public/_headers, the Worker's through its middleware), and the one view the landing may
 * frame, /embed/hero, is framed only by https://apc.tineira.com. Plain GETs: nothing is made (no sandbox, no grant).
 * The TIN-1071 landing frames the hero only once this passes on production.
 */
async function readFraming(t) {
  const get = async (path, headers = {}) => {
    const response = await withDeadline(runtime.send(`${PULSE}${path}`, { headers: { "user-agent": USER_AGENT, ...headers }, redirect: "manual" }), STEP_MS, `GET ${PULSE}${path}`);
    const body = await response.text();
    const h = (name) => response.headers.get(name);
    return { status: response.status, body, csp: h("content-security-policy"), frame: h("x-frame-options"), sniff: h("x-content-type-options"), referrer: h("referrer-policy"), location: h("location") };
  };
  // The effective directive, the first one, as a browser reads it (CSP3): a later 'none' would not forbid anything.
  const deny = (r) => effectiveFrameAncestors(r.csp) === "'none'" && r.frame === "DENY" && r.sniff === "nosniff";
  const shown = (r) => `HTTP ${r.status}; CSP ${r.csp}; X-Frame-Options ${r.frame}; nosniff ${r.sniff}`;
  for (const path of ["/", "/agents", "/connect/dock", "/api/health", "/zzz-probe"]) {
    const r = await get(path);
    t.check(r.status === 200 && deny(r), `Pulse ${path} cannot be framed (frame-ancestors 'none', DENY, nosniff)`, shown(r));
  }
  const other = await get("/embed/other", { "sec-fetch-dest": "iframe" });
  t.check(other.status === 404 && deny(other), "Pulse /embed/other is a 404 that cannot be framed", shown(other));
  const top = await get("/embed/hero", { "sec-fetch-dest": "document" });
  t.check(top.status === 302 && new URL(top.location ?? "x:", PULSE).href === `${PULSE}/` && deny(top), "Pulse /embed/hero opened top level redirects to / (302)", `${shown(top)}; Location ${top.location}`);
  const hero = await get("/embed/hero", { "sec-fetch-dest": "iframe" });
  t.check(hero.status === 200 && hero.csp === embedHeroCsp([DOCK]) && hero.frame === "DENY" && hero.sniff === "nosniff" && hero.referrer === "no-referrer",
    "Pulse /embed/hero in a frame carries its policy (frame-ancestors https://apc.tineira.com only), DENY, nosniff, no-referrer", shown(hero));
  // The body proves it is the hero (B-1 of PR #245's review): its marker, its parent filled in, its own entry, and not the
  // full app's entry (an SPA fallback would carry the hero's policy otherwise).
  const isHero = hero.body.includes(EMBED_HERO_MARKER) && hero.body.includes(`<meta name="apc-embed-parent" content="${DOCK}" />`) && /src="\/assets\/embedHero-[A-Za-z0-9_-]+\.js"/.test(hero.body) && !/src="\/assets\/main-[A-Za-z0-9_-]+\.js"/.test(hero.body);
  t.check(hero.status === 200 && isHero, "Pulse /embed/hero serves the hero's own page (its marker, its parent and its entry; not the full app's)", `HTTP ${hero.status}; ${hero.body.length} bytes`);
}

/**
 * Signals' framing headers as served (TIN-1093, closing TIN-1074): no Signals answer can be framed by any site, and
 * Signals has no exception (the assets' answers through public/_headers, the Worker's through its middleware). Plain
 * GETs: nothing is made (a feed opens only on the page's POST /api/session, a connect grant only on its POST).
 */
async function readSignalsFraming(t) {
  const get = async (path) => {
    const response = await withDeadline(runtime.send(`${SIGNALS}${path}`, { headers: { "user-agent": USER_AGENT }, redirect: "manual" }), STEP_MS, `GET ${SIGNALS}${path}`);
    await response.text();
    const h = (name) => response.headers.get(name);
    return { status: response.status, csp: h("content-security-policy"), frame: h("x-frame-options"), sniff: h("x-content-type-options"), referrer: h("referrer-policy") };
  };
  const deny = (r) => effectiveFrameAncestors(r.csp) === "'none'" && r.frame === "DENY" && r.sniff === "nosniff" && r.referrer === "no-referrer";
  const shown = (r) => `HTTP ${r.status}; CSP ${r.csp}; X-Frame-Options ${r.frame}; nosniff ${r.sniff}; Referrer-Policy ${r.referrer}`;
  // The page, the page arrived to connect, the SPA fallback, an asset, the dock's connect page, apc.json, and the Worker's 404s.
  for (const [path, status] of [["/", 200], ["/?connect", 200], ["/zzz-probe", 200], ["/favicon.svg", 200], ["/connect/dock", 200], ["/.well-known/apc.json", 200], ["/api/zzz-probe", 404], ["/connect/zzz-probe", 200], ["/mcp/zz/zz", 404]]) {
    const r = await get(path);
    t.check(r.status === status && deny(r), `Signals ${path} cannot be framed (frame-ancestors 'none', DENY, nosniff, no-referrer; HTTP ${status})`, shown(r));
  }
}

/**
 * Signals' `?connect` in workerd (TIN-1093): the page's calls, as a browser sends them. The feed's one connect grant is
 * made on the first POST and returned on the next; a real MCP initialize on its address shows the agent connected; after
 * a revoke the next visit makes a new one. Not on production: it would make a feed and grants there.
 */
async function signalsConnectInWorkerd(t) {
  const { call, rpc, must } = t;
  const session = await call(`${SIGNALS}/api/session`, { method: "POST" });
  must(session.status === 200 && /^[0-9a-f]{32}$/.test(session.json?.sid ?? ""), "Signals: the page opens a feed", session);
  const base = `${SIGNALS}/api/s/${session.json.sid}`;
  const direct = async () => (await call(`${base}/state`)).json?.grants?.filter((g) => g.path === "direct") ?? [];
  must((await direct()).length === 0, "Signals: opening the feed makes no agent (a plain visit)");
  const first = await call(`${base}/grants/connect`, { method: "POST" });
  must(first.status === 200 && first.json?.made === true && typeof first.json?.grant_id === "string", "Signals: ?connect makes the feed's connect grant", first);
  const again = await call(`${base}/grants/connect`, { method: "POST" });
  must(again.status === 200 && again.json?.made === false && again.json?.grant_id === first.json.grant_id, "Signals: a reload returns the same connect grant", again);
  const grants = await direct();
  must(grants.length === 1 && grants[0].id === first.json.grant_id && /^[0-9a-f]{32}$/.test(grants[0].secret ?? ""), "Signals: still one Direct agent, with its MCP address");
  const init = await rpc(`${SIGNALS}/mcp/${session.json.sid}/${grants[0].secret}`, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: CLIENT.name, version: CLIENT.version } });
  must(!!init.result?.serverInfo, "Signals: an MCP initialize on the connect grant's address answers");
  must((await direct())[0]?.connected === true, "Signals: the agent shows connected");
  const revoked = await call(`${base}/grants/${first.json.grant_id}/revoke`, { method: "POST" });
  must(revoked.status === 200 && revoked.json?.ok === true, "Signals: the person revokes it", revoked);
  const next = await call(`${base}/grants/connect`, { method: "POST" });
  must(next.status === 200 && next.json?.made === true && next.json?.grant_id !== first.json.grant_id, "Signals: the next ?connect visit makes a new one", next);
  must((await direct()).length === 1, "Signals: one connect grant again");
  // Start over, so the dock pairing below opens a feed of its own.
  must((await call(`${base}/reset`, { method: "POST" })).status === 200, "Signals: the feed starts over");
}

/** The production smoke's steps, against the real hub. */
async function pair(t) {
  const { call, rpc, check, must } = t;

  // The dock: a new one, as its page makes it when the person presses Create a new dock (TIN-879: POST /api/dock
  // only resumes, and /api/dock/new takes only the dock's own origin), and the agent it opens with, connected.
  const dock = await call(`${DOCK}/api/dock/new`, { method: "POST", body: {} });
  must(dock.status === 200 && dock.json?.created === true && typeof dock.json?.did === "string", "the dock is created (Create a new dock)", dock);
  t.made.dock = `${DOCK}/api/d/${dock.json.did}`;
  const dockState = async () => (await call(`${t.made.dock}/state`)).json;
  const agent = (await dockState())?.agents?.[0];
  must(typeof agent?.id === "string" && typeof agent?.mcp_url === "string", "the dock has an agent");
  const agentUrl = `${DOCK}${new URL(agent.mcp_url).pathname}`;
  const init = await rpc(agentUrl, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: CLIENT });
  must(!!init.result, "the agent connects to its dock", init.error?.message);

  // Pulse: a sandbox, and a customer to drop the agent on.
  const pulse = await call(`${PULSE}/api/session`, { method: "POST", body: {} });
  must(pulse.status === 200 && typeof pulse.json?.sid === "string", "Pulse opens a sandbox", pulse);
  t.made.pulse = `${PULSE}/api/s/${pulse.json.sid}`;
  const dataset = await call(`${t.made.pulse}/dataset`);
  const customer = dataset.json?.customers?.[0]?.id;
  must(typeof customer === "string", "Pulse has a customer to drop on", dataset);
  const target = { kind: "customer", id: customer, part: null, params: null };

  // The drop, and Allow: Pulse asks the hub (pairWithHub) and shows the pairing code.
  const ticket = async () => (await call(`${t.made.dock}/agents/${agent.id}/ticket`, { method: "POST" })).json?.ticket;
  const connectTicket = async () => {
    const checked = await call(`${t.made.dock}/connects`, { method: "POST", body: { agent: agent.id, host: PULSE } });
    must(checked.status === 200 && typeof checked.json?.request?.id === "string", "the owner checks Pulse for Connect", checked);
    const opened = await call(`${t.made.dock}/connects/${checked.json.request.id}/approve`, { method: "POST", body: {} });
    must(opened.status === 200 && typeof opened.json?.url === "string", "the owner approves Connect and gets its app URL", opened);
    const url = new URL(opened.json.url);
    must(url.origin === PULSE && url.hash.startsWith("#apc_connect="), "the connect ticket is in Pulse's declared page fragment");
    const fragment = JSON.parse(Buffer.from(url.hash.slice("#apc_connect=".length), "base64url").toString("utf8"));
    return fragment.ticket;
  };
  // The app-page branch supplies /connect/dock; its existing consent endpoint takes this same handoff here.
  const drop = { hub: DOCK, agent: agent.id, ticket: await connectTicket(), target };
  must(typeof drop.ticket === "string", "the dock gives the owner-approved app handoff a connect ticket");
  const asked = await call(`${t.made.pulse}/connect/dock`, { method: "POST", body: drop });
  must(asked.json?.error === "consent_required" && typeof asked.json?.consent === "string", "the drop asks the person to Allow", asked);
  const allowed = await call(`${t.made.pulse}/connect/dock`, { method: "POST", body: { ...drop, consent: asked.json.consent } });
  must(allowed.status === 200 && allowed.json?.ok === true && allowed.json?.status === "pending", `Allow: Pulse's call to the hub's /apc/pair (pairWithHub, in ${where}) was answered`, allowed);
  const grantId = allowed.json.grant_id;
  const code = allowed.json.pairing?.code ?? asked.json.pairing_code;
  must(typeof code === "string" && code.length > 0, "Pulse shows a pairing code");

  // The dock owner approves with the code: the hub introduces itself to Pulse (initialize, dock → Pulse).
  const pending = (await dockState())?.agents?.[0]?.pairings?.find((p) => p.status === "pending");
  must(typeof pending?.id === "string", "the dock shows the pairing as pending");
  const wrong = await call(`${t.made.dock}/pairings/${pending.id}`, { method: "POST", body: { action: "approve", code: wrongCode(code) } });
  check(wrong.status === 400 && wrong.json?.error === "wrong_pairing_code", "a wrong code is refused as wrong_pairing_code", wrong);
  const approved = await call(`${t.made.dock}/pairings/${pending.id}`, { method: "POST", body: { action: "approve", code } });
  must(approved.status === 200 && approved.json?.ok === true, "the dock owner approves with the code", approved);
  const paired = (await dockState())?.agents?.[0]?.pairings?.find((p) => p.id === pending.id);
  check(paired?.status === "paired", "the dock shows it paired", paired?.status);
  /** Pulse's dock links, read for sure: a state that cannot be read is a failure, never "no link". */
  const pulseLinks = async () => {
    const state = await call(`${t.made.pulse}/state`);
    must(state.status === 200 && Array.isArray(state.json?.hub_links), "Pulse's state reads", state);
    return state.json.hub_links;
  };
  const live = (await pulseLinks()).find((l) => l.grant_id === grantId);
  check(live?.state === "live", "Pulse shows the dock's agent connected (the hub's initialize committed)", live?.state);

  // The agent reads Pulse through its dock.
  const read = await rpc(agentUrl, "tools/call", { name: "pulse__list_customers", arguments: { limit: 1 } }, 2);
  check(read.result && !read.result.isError && JSON.stringify(read.result).includes(customer), "the agent reads Pulse's customers through the dock", read.error?.message ?? (read.result?.isError ? "a tool error" : "no customer in the result"));

  // A second drop of the same agent: Pulse asks the hub whether it still pairs them (confirmWithHub).
  const again = await call(`${t.made.pulse}/hub/pair`, { method: "POST", body: { ...drop, ticket: await ticket() } });
  check(again.status === 200 && again.json?.ok === true && again.json?.grant_id === grantId, `a second drop: the hub's /apc/confirm answered (confirmWithHub, in ${where})`, again);

  // The dock removes the agent and gives the grant back (/apc/revoke, dock → Pulse): Pulse ends it.
  const removed = await call(`${t.made.dock}/agents/${agent.id}/remove`, { method: "POST" });
  check(removed.status === 200 && removed.json?.ok === true, "the dock removes its agent", removed);
  check((await pulseLinks()).every((l) => l.grant_id !== grantId), "Pulse ended the grant the dock gave back");
}

/** Drive the app's public routes. The fixture controls model the owner's actions and the agent's tool call. */
async function pairAppInWorkerd(t, { name, origin, target, linksOf, idOf }) {
  const { call, rpc, must } = t;
  const fixture = (path, body) => call(`${DOCK}/__test/${path}`, body === undefined ? {} : { method: "POST", body });
  const agent = `ag_${name.toLowerCase()}`;
  const mintTicket = async () => {
    const answer = await fixture("ticket", { agent });
    must(answer.status === 200 && typeof answer.json?.ticket === "string", `${name}: the fixture issues a drop ticket`, answer);
    return answer.json.ticket;
  };
  const session = await call(`${origin}/api/session`, { method: "POST", body: {} });
  must(session.status === 200 && typeof session.json?.sid === "string", `${name}: opens a demo in workerd`, session);
  const base = `${origin}/api/s/${session.json.sid}`;
  const links = async () => {
    const state = await call(`${base}/state`);
    const items = linksOf(state.json);
    must(state.status === 200 && Array.isArray(items), `${name}: reads the app's grant state`, state);
    return items;
  };
  const drop = { hub: DOCK, agent, ticket: await mintTicket(), target };
  const dropped = await call(`${base}/hub/pair`, { method: "POST", body: drop });
  must(dropped.status === 200 && dropped.json?.status === "connect_requested", `${name}: the first drop requests Connect (/apc/connect)`, dropped);
  const opened = await fixture("approve-connect", { agent });
  must(opened.status === 200 && typeof opened.json?.url === "string", `${name}: approving Connect yields a handoff`, opened);
  const url = new URL(opened.json.url);
  must(url.origin === origin && url.pathname === "/connect/dock" && !url.search && url.hash.startsWith("#apc_connect="),
    `${name}: the ticket uses the app's declared Connect page and fragment`);
  const get = (path) => runtime.send(`${origin}${path}`, { redirect: "manual", signal: AbortSignal.timeout(STEP_MS) });
  const page = await get(url.pathname);
  must(page.status === 200 && page.headers.get("referrer-policy") === "no-referrer",
    `${name}: GET /connect/dock returns 200 with Referrer-Policy: no-referrer`, `HTTP ${page.status}`);
  const scripts = [...(await page.text()).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const scriptSource = (attrs) => /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)?.slice(1).find((src) => src !== undefined);
  const sources = scripts.map(([, attrs]) => scriptSource(attrs));
  must(scripts.some(([, , body], i) => sources[i] === undefined && body.includes("history.replaceState")),
    `${name}: GET /connect/dock clears the fragment with inline history.replaceState`);
  const asset = "/assets/dock-connect.js";
  must(sources.includes(asset) && sources.every((src) => src === undefined || new URL(src, origin).origin === origin),
    `${name}: GET /connect/dock loads the Dock Connect module and uses only same-origin scripts`);
  const connectJs = await get(asset);
  must(connectJs.status === 200 && (await connectJs.text()).includes("apc_connect"),
    `${name}: built /assets/dock-connect.js returns 200 and contains apc_connect`, `HTTP ${connectJs.status}`);

  const handoff = JSON.parse(Buffer.from(url.hash.slice("#apc_connect=".length), "base64url").toString("utf8"));
  must(handoff.agent === agent && handoff.hub === DOCK && typeof handoff.ticket === "string", `${name}: the handoff names this hub and agent`);
  const body = { ...drop, ticket: handoff.ticket };
  const asked = await call(`${base}/connect/dock`, { method: "POST", body });
  must(asked.json?.error === "consent_required" && typeof asked.json?.consent === "string", `${name}: the app asks the person to Allow`, asked);
  const allowed = await call(`${base}/connect/dock`, { method: "POST", body: { ...body, consent: asked.json.consent } });
  must(allowed.status === 200 && allowed.json?.ok === true && allowed.json?.status === "pending",
    `${name}: Allow called the hub's /apc/pair (pairWithHub, in workerd)`, allowed);
  const grantId = allowed.json.grant_id;
  const code = allowed.json.pairing?.code;
  must(typeof grantId === "string" && typeof code === "string" && code.length > 0, `${name}: the app shows a pairing code`);

  const state = async () => {
    const result = await fixture("state");
    must(result.status === 200 && Array.isArray(result.json?.pairings), `${name}: reads the fixture's pairing state`, result);
    return result.json;
  };
  const pending = (await state()).pairings.find((p) => p.agent === agent);
  must(pending?.status === "pending" && /^pr_[0-9a-f]{32}$/.test(pending.id), `${name}: the hub holds the pending pairing`);
  const wrong = await fixture("decide", { id: pending.id, action: "approve", code: wrongCode(code) });
  must(wrong.status === 400 && wrong.json?.error === "wrong_pairing_code", `${name}: the hub refuses a wrong owner code`, wrong);
  const approved = await fixture("decide", { id: pending.id, action: "approve", code });
  must(approved.status === 200 && approved.json?.ok === true, `${name}: the owner approves with the code`, approved);
  must((await links()).find((link) => idOf(link) === grantId)?.state === "live", `${name}: the app committed the hub's MCP initialize`);

  const mcp = `${DOCK}/__test/mcp/${pending.id}`;
  const listed = await rpc(mcp, "tools/list", {});
  const tools = listed.result?.tools;
  must(Array.isArray(tools) && tools.length > 0, `${name}: tools/list returns a non-empty tool list`);
  const read = await rpc(mcp, "tools/call", { name: "get_current_view", arguments: {} });
  must(!read.result?.isError && read.result?.structuredContent?.focus?.id === target.id,
    `${name}: get_current_view returns the dropped target as the current pin`);
  const before = (await state()).confirmations;
  const again = await call(`${base}/hub/pair`, { method: "POST", body: { ...drop, ticket: await mintTicket() } });
  must(again.status === 200 && again.json?.ok === true && again.json?.grant_id === grantId, `${name}: the second drop keeps the same grant`, again);
  must((await state()).confirmations === before + 1, `${name}: the second drop reached the hub's /apc/confirm`);

  const revoked = await fixture("decide", { id: pending.id, action: "deny" });
  must(revoked.status === 200 && revoked.json?.ok === true, `${name}: the hub gives the grant back`, revoked);
  must((await links()).every((link) => idOf(link) !== grantId), `${name}: the app ended the grant on /apc/revoke`);
}

async function pairInWorkerd(t) {
  await signalsConnectInWorkerd(t);
  // The linked customer and post in the apps' shared demo world.
  const { CROSS_APP } = await import("../apps/demo/src/model/demo-world.ts");
  await pairAppInWorkerd(t, {
    name: "Pulse", origin: PULSE, target: { kind: "customer", id: CROSS_APP.customer },
    linksOf: (state) => state?.hub_links, idOf: (link) => link.grant_id,
  });
  await pairAppInWorkerd(t, {
    name: "Signals", origin: "https://signals.apc.tineira.com", target: { kind: "post", id: CROSS_APP.post },
    linksOf: (state) => state?.grants, idOf: (grant) => grant.id,
  });
}

/** One try: the steps within TRY_MS, then its cleanup, whatever happened. */
async function runTry(t) {
  try {
    await withDeadline(PRODUCTION ? pair(t) : pairInWorkerd(t), TRY_MS, `the pairing's steps (try ${t.n})`);
  } catch (error) {
    if (!error?.counted) t.check(false, error instanceof Error ? error.message : String(error), error?.cause?.message);
  } finally {
    await t.cleanup();
  }
}

const tries = [];
/** Stopped from outside (the CI step's timeout, a cancel, Ctrl+C): start over what this run made, then exit. */
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log(`stopped by ${signal}: starting over what this run made`);
    await Promise.race([Promise.all(tries.map((t) => t.cleanup())), sleep(15_000)]);
    await runtime.stop().catch(() => {});
    process.exit(1);
  });
}

async function main() {
  if (!PRODUCTION) runtime = await startWorkerd({ pairing: true, site: true });
  // The docs first, once: they make nothing, and a failure here never starts a pairing (no dock or sandbox is made).
  const docs = newTry(0, "");
  tries.push(docs);
  try {
    await withDeadline(readDocs(docs), 3 * STEP_MS, "the docs");
    await withDeadline(readFraming(docs), 3 * STEP_MS, "Pulse's framing headers");
    await withDeadline(readSignalsFraming(docs), 3 * STEP_MS, "Signals' framing headers");
  } catch (error) {
    docs.check(false, error instanceof Error ? error.message : String(error));
  }
  if (docs.failed) return docs;
  tries.pop();
  for (let n = 1; n <= TRIES; n++) {
    const t = newTry(n);
    tries.push(t);
    await runTry(t);
    if (!t.failed) return t;
    if (n < TRIES) {
      console.log(`try ${n} failed at: ${t.firstFailure}. Trying again in ${RETRY_AFTER_MS / 1000} s (a new deploy may not have reached every edge yet).`);
      if (CI) console.log(`::warning title=Dock pairing (${where}), try ${n}::${t.firstFailure}`);
      await sleep(RETRY_AFTER_MS);
    }
  }
  return tries.at(-1);
}

let last = null;
try {
  last = await withDeadline(main(), TOTAL_MS, "the whole run");
} catch (error) {
  console.log(`not ok - ${error instanceof Error ? error.message : String(error)}`);
  // Past the whole run's deadline, or the runtime would not start: whatever was made is started over now.
  await Promise.race([Promise.all(tries.map((t) => t.cleanup())), sleep(30_000)]);
} finally {
  await runtime.stop().catch(() => {});
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const passed = !!last && last.failed === 0;
const warnings = tries.flatMap((t) => t.warnings);
if (CI) for (const w of warnings) console.log(`::warning title=Dock pairing (${where}) cleanup::${w}`);
if (!passed && CI) console.log(`::error title=Dock pairing (${where})::${last?.firstFailure ?? "the run did not finish"}`);
const tried = tries.length > 1 ? `, ${tries.length} tries` : "";
console.log(passed ? `dock pairing (${where}): passed${warnings.length ? ` with ${warnings.length} warning(s)` : ""} (${seconds} s${tried})` : `dock pairing (${where}): FAILED at "${last?.firstFailure ?? "the run did not finish"}" (${seconds} s${tried})`);
process.exit(passed ? 0 : 1);
