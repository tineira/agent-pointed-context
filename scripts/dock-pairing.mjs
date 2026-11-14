#!/usr/bin/env node
/**
 * One real Dock pairing between the dock and Pulse (TIN-900), the way a person and an agent make one:
 *
 *   the dock opens → its agent connects → the person drops it on a customer in Pulse → Allow → Pulse calls the
 *   hub's /apc/pair (pairWithHub) → the dock owner approves with the pairing code → the hub's `initialize` to
 *   Pulse → the agent reads Pulse through its dock → a second drop (confirmWithHub, /apc/confirm) → the dock
 *   removes the agent and gives the grant back (/apc/revoke) → Pulse ends the grant.
 *
 * Two places to run it:
 *
 * - **In workerd** (the default; CI's `check` job, after `pnpm build`; `pnpm test:workerd`): the built dock (Worker
 *   apc-dock) and the built Pulse (apc-pulse) run in the Workers runtime through Miniflare, each from the
 *   wrangler.json `vite build` wrote (what `wrangler deploy` ships), with real Durable Objects (SQLite), their
 *   deploy's vars and their production origins. They reach each other by `fetch` to the other's public origin:
 *   their outbound fetches go to a third local Worker that stands in for the internet, which hands apc.tineira.com
 *   to the dock and pulse.apc.tineira.com to Pulse over service bindings, and refuses every other host.
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
 * Exit code 0 only when the pairing passed; the last line is the summary. On a failure in GitHub Actions the first
 * failing step is also an `::error::` annotation.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRODUCTION = process.argv.includes("--production");
const DOCK = "https://apc.tineira.com";
const PULSE = "https://pulse.apc.tineira.com";
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

/** The two Workers in workerd, and the fetch that reaches them. */
async function startWorkerd() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // wrangler is the dock's devDependency, and Miniflare is wrangler's: the versions `vite dev` and `wrangler deploy` use.
  const wranglerPath = createRequire(join(root, "apps/dock/package.json")).resolve("wrangler");
  const fileUrl = (p) => new URL(`file:///${p.replaceAll("\\", "/")}`).href;
  const { unstable_getMiniflareWorkerOptions } = await import(fileUrl(wranglerPath));
  const { Miniflare, convertV4MiniflareOptions } = await import(fileUrl(createRequire(wranglerPath).resolve("miniflare")));
  if (typeof unstable_getMiniflareWorkerOptions !== "function" || typeof convertV4MiniflareOptions !== "function" || typeof Miniflare !== "function") {
    throw new Error("wrangler no longer exports unstable_getMiniflareWorkerOptions, or Miniflare convertV4MiniflareOptions: update scripts/dock-pairing.mjs for the new wrangler");
  }

  /** A built Worker as Miniflare runs it: its options from its wrangler.json, its bundle beside it. */
  const builtWorker = (name, configPath) => {
    const path = join(root, configPath);
    if (!existsSync(path)) throw new Error(`${configPath} is missing: run pnpm build first`);
    // The rules wrangler gives are the default ones (ESModule for .js and .mjs); Miniflare 5 takes the modules listed instead.
    const { workerOptions: { modulesRules: _rules, ...workerOptions }, main } = unstable_getMiniflareWorkerOptions(path);
    const dir = dirname(path);
    // Every module of the bundle, entry first, as wrangler deploy uploads them (no_bundle, the ESModule rule): the
    // entry imports its chunks (assets/*.js), some dynamically, which Miniflare would not find by itself.
    const entry = resolve(dir, main ?? "index.js");
    const chunks = readdirSync(dir, { recursive: true })
      .map((f) => resolve(dir, String(f)))
      .filter((f) => /\.m?js$/.test(f) && f !== entry);
    return { ...workerOptions, name, modules: [entry, ...chunks].map((p) => ({ type: "ESModule", path: p })), modulesRoot: dir, outboundService: "internet" };
  };
  const internet = {
    name: "internet",
    modules: true,
    compatibilityDate: "2026-10-01",
    script: `export default {
      fetch(request, env) {
        const host = new URL(request.url).hostname;
        if (host === "apc.tineira.com") return env.DOCK.fetch(request);
        if (host === "pulse.apc.tineira.com") return env.PULSE.fetch(request);
        return new Response("no network in this test: " + host, { status: 502 });
      },
    };`,
    serviceBindings: { DOCK: "apc-dock", PULSE: "apc-pulse" },
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [internet, builtWorker("apc-dock", "apps/dock/dist/apc_dock/wrangler.json"), builtWorker("apc-pulse", "apps/demo/dist/apc_pulse/wrangler.json")],
    }),
  );
  const runtime = { send: (url, init) => mf.dispatchFetch(url, init), stop: () => mf.dispose() };
  try {
    await mf.ready;
  } catch (error) {
    await runtime.stop().catch(() => {});
    throw error;
  }
  return runtime;
}

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
function newTry(n) {
  const t = { n, failed: 0, firstFailure: null, warnings: [], jar: new Map(), made: { dock: null, pulse: null }, cleaned: false };
  const label = TRIES > 1 ? `[try ${n}] ` : "";
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

/** The pairing's steps, on one try. */
async function pair(t) {
  const { call, rpc, check, must } = t;

  // The dock: a new one, and the agent it opens with, connected.
  const dock = await call(`${DOCK}/api/dock`, { method: "POST", body: {} });
  must(dock.status === 200 && typeof dock.json?.did === "string", "the dock opens", dock);
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
  const drop = { hub: DOCK, agent: agent.id, ticket: await ticket(), target };
  must(typeof drop.ticket === "string", "the dock gives the agent's drag a ticket");
  const asked = await call(`${t.made.pulse}/hub/pair`, { method: "POST", body: drop });
  must(asked.json?.error === "consent_required" && typeof asked.json?.consent === "string", "the drop asks the person to Allow", asked);
  const allowed = await call(`${t.made.pulse}/hub/pair`, { method: "POST", body: { ...drop, consent: asked.json.consent } });
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

/** One try: the steps within TRY_MS, then its cleanup, whatever happened. */
async function runTry(t) {
  try {
    await withDeadline(pair(t), TRY_MS, `the pairing's steps (try ${t.n})`);
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
  if (!PRODUCTION) runtime = await startWorkerd();
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
