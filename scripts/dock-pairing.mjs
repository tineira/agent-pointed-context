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
 * - **In workerd** (the default; CI's `check` job, after `pnpm build`): the built dock (Worker apc-dock) and the
 *   built Pulse (apc-pulse) run in the Workers runtime through Miniflare, each from the wrangler.json `vite build`
 *   wrote (what `wrangler deploy` ships), with real Durable Objects (SQLite), their deploy's vars and their
 *   production origins. They reach each other the way they do in production, by `fetch` to the other's public
 *   origin: their outbound fetches go to a third local Worker that stands in for the internet, which hands
 *   apc.tineira.com to the dock and pulse.apc.tineira.com to Pulse over service bindings, and refuses every other
 *   host. `pnpm test` runs this code on Node, which accepts options Workers rejects: `fetch(..., { redirect:
 *   "error" })` broke every Dock pairing in production from APC 0.9 to 0.11.0 while CI stayed green.
 * - **`--production`** (after "Deploy the APC standard"): the same steps against apc.tineira.com and
 *   pulse.apc.tineira.com, with a new dock and a new sandbox (synthetic data). At the end it gives the grant back,
 *   then starts both over (the dock's and the sandbox's Start over), whether the steps passed or not. No secret.
 *
 * Exit code 0 only when every step passed; the last line is the summary.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRODUCTION = process.argv.includes("--production");
const DOCK = "https://apc.tineira.com";
const PULSE = "https://pulse.apc.tineira.com";
const STEP_MS = PRODUCTION ? 20_000 : 15_000;
/** The agent's MCP client name: a deploy's check is told apart from people's agents in the session counts. */
const CLIENT = { name: PRODUCTION ? "apc-deploy-smoke" : "apc-workerd-pairing", version: "1.0.0" };
const where = PRODUCTION ? "production" : "workerd";

/** The two Workers in workerd, and the fetch that reaches them; or the network, in production. */
async function startWorkerd() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // wrangler is the dock's devDependency, and Miniflare is wrangler's: the versions `vite dev` and `wrangler deploy` use.
  const wranglerPath = createRequire(join(root, "apps/dock/package.json")).resolve("wrangler");
  const fileUrl = (p) => new URL(`file:///${p.replaceAll("\\", "/")}`).href;
  const { unstable_getMiniflareWorkerOptions } = await import(fileUrl(wranglerPath));
  const { Miniflare, convertV4MiniflareOptions } = await import(fileUrl(createRequire(wranglerPath).resolve("miniflare")));

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
  await mf.ready;
  return { send: (url, init) => mf.dispatchFetch(url, init), stop: () => mf.dispose() };
}

let failed = 0;
function check(ok, what, detail) {
  if (ok) console.log(`ok - ${what}`);
  else {
    failed++;
    console.log(`not ok - ${what}${detail === undefined ? "" : `\n  ${typeof detail === "string" ? detail.slice(0, 500) : JSON.stringify(detail)?.slice(0, 500)}`}`);
  }
  return ok;
}
function must(ok, what, detail) {
  if (!check(ok, what, detail)) throw new Error(`stopped at: ${what}`);
}
function withDeadline(promise, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: no answer in ${STEP_MS / 1000} s`)), STEP_MS)))]).finally(() => clearTimeout(timer));
}

const started = Date.now();
let runtime = { send: (url, init) => fetch(url, init), stop: async () => {} };
/** The dock's and the sandbox's paths, once they exist: what the production run starts over at the end. */
const made = { dock: null, pulse: null };

/** A browser, as far as these calls need one: a cookie per site, and Pulse's owner headers (M6). */
const jar = new Map();
async function call(url, { method = "GET", body } = {}) {
  const { origin, pathname } = new URL(url);
  const headers = { accept: "application/json" };
  if (jar.has(origin)) headers.cookie = jar.get(origin);
  if (method !== "GET") Object.assign(headers, { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" });
  // A POST the Worker does not read is sent without a body: workerd answers the next request on a connection whose
  // body was left unread with a reset.
  const response = await withDeadline(runtime.send(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }), `${method} ${pathname}`);
  for (const c of response.headers.getSetCookie()) jar.set(origin, c.split(";")[0]);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** One JSON-RPC message to an agent's MCP URL, as an agent sends it. */
async function rpc(url, method, params, id = 1) {
  const response = await withDeadline(
    runtime.send(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }),
    `rpc ${method}`,
  );
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 300)}`);
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  return JSON.parse(line);
}

try {
  if (!PRODUCTION) runtime = await startWorkerd();

  // The dock: a new one, and the agent it opens with, connected.
  const dock = await call(`${DOCK}/api/dock`, { method: "POST", body: {} });
  must(dock.status === 200 && typeof dock.json?.did === "string", "the dock opens", dock.text);
  const did = dock.json.did;
  made.dock = `${DOCK}/api/d/${did}`;
  const dockState = async () => (await call(`${made.dock}/state`)).json;
  const agent = (await dockState())?.agents?.[0];
  must(typeof agent?.id === "string" && typeof agent?.mcp_url === "string", "the dock has an agent");
  const agentUrl = `${DOCK}${new URL(agent.mcp_url).pathname}`;
  const init = await rpc(agentUrl, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: CLIENT });
  must(!!init.result, "the agent connects to its dock", init.error);

  // Pulse: a sandbox, and a customer to drop the agent on.
  const pulse = await call(`${PULSE}/api/session`, { method: "POST", body: {} });
  must(pulse.status === 200 && typeof pulse.json?.sid === "string", "Pulse opens a sandbox", pulse.text);
  const sid = pulse.json.sid;
  made.pulse = `${PULSE}/api/s/${sid}`;
  const dataset = await call(`${made.pulse}/dataset`);
  const customer = dataset.json?.customers?.[0]?.id;
  must(typeof customer === "string", "Pulse has a customer to drop on", dataset.text.slice(0, 300));
  const target = { kind: "customer", id: customer, part: null, params: null };

  // The drop, and Allow: Pulse asks the hub (pairWithHub) and shows the pairing code.
  const ticket = async () => (await call(`${made.dock}/agents/${agent.id}/ticket`, { method: "POST" })).json?.ticket;
  const drop = { hub: DOCK, agent: agent.id, ticket: await ticket(), target };
  const asked = await call(`${made.pulse}/hub/pair`, { method: "POST", body: drop });
  must(asked.json?.error === "consent_required" && typeof asked.json?.consent === "string", "the drop asks the person to Allow", asked.text);
  const allowed = await call(`${made.pulse}/hub/pair`, { method: "POST", body: { ...drop, consent: asked.json.consent } });
  must(allowed.status === 200 && allowed.json?.ok === true && allowed.json?.status === "pending", `Allow: Pulse's call to the hub's /apc/pair (pairWithHub, in ${where}) was answered`, allowed.text);
  const grantId = allowed.json.grant_id;
  const code = allowed.json.pairing?.code ?? asked.json.pairing_code;
  must(typeof code === "string", "Pulse shows a pairing code");

  // The dock owner approves with the code: the hub introduces itself to Pulse (initialize, dock → Pulse).
  const pending = (await dockState())?.agents?.[0]?.pairings?.find((p) => p.status === "pending");
  must(typeof pending?.id === "string", "the dock shows the pairing as pending");
  const wrong = await call(`${made.dock}/pairings/${pending.id}`, { method: "POST", body: { action: "approve", code: code === "000000" ? "111111" : "000000" } });
  check(wrong.json?.ok === false, "a wrong code does not approve", wrong.text);
  const approved = await call(`${made.dock}/pairings/${pending.id}`, { method: "POST", body: { action: "approve", code } });
  must(approved.status === 200 && approved.json?.ok === true, "the dock owner approves with the code", approved.text);
  const paired = (await dockState())?.agents?.[0]?.pairings?.find((p) => p.id === pending.id);
  check(paired?.status === "paired", "the dock shows it paired", paired?.status);
  const pulseLink = async () => (await call(`${made.pulse}/state`)).json?.hub_links?.find((l) => l.grant_id === grantId);
  const live = await pulseLink();
  check(live?.state === "live", "Pulse shows the dock's agent connected (the hub's initialize committed)", live?.state);

  // The agent reads Pulse through its dock.
  const read = await rpc(agentUrl, "tools/call", { name: "pulse__list_customers", arguments: { limit: 1 } }, 2);
  check(read.result && !read.result.isError, "the agent reads Pulse through the dock", JSON.stringify(read.error ?? read.result?.content?.[0]?.text ?? ""));

  // A second drop of the same agent: Pulse asks the hub whether it still pairs them (confirmWithHub).
  const again = await call(`${made.pulse}/hub/pair`, { method: "POST", body: { ...drop, ticket: await ticket() } });
  check(again.status === 200 && again.json?.ok === true && again.json?.grant_id === grantId, `a second drop: the hub's /apc/confirm answered (confirmWithHub, in ${where})`, again.text);

  // The dock removes the agent and gives the grant back (/apc/revoke, dock → Pulse): Pulse ends it.
  const removed = await call(`${made.dock}/agents/${agent.id}/remove`, { method: "POST" });
  check(removed.status === 200 && removed.json?.ok === true, "the dock removes its agent", removed.text);
  check((await pulseLink()) === undefined, "Pulse ended the grant the dock gave back");
} catch (error) {
  failed++;
  console.log(`not ok - ${error instanceof Error ? error.message : String(error)}${error?.cause ? ` (${error.cause.message ?? error.cause})` : ""}`);
} finally {
  // In production nothing is left behind: both Start overs, whatever happened above. In workerd it all goes with the runtime.
  if (PRODUCTION) {
    for (const [what, base] of [["the dock", made.dock], ["the sandbox", made.pulse]]) {
      if (!base) continue;
      const reset = await call(`${base}/reset`, { method: "POST" }).catch((e) => ({ status: 0, text: String(e) }));
      check(reset.status === 200, `${what} starts over`, reset.text);
    }
  }
  await runtime.stop().catch(() => {});
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(failed ? `dock pairing (${where}): FAILED, ${failed} failing (${seconds} s)` : `dock pairing (${where}): passed (${seconds} s)`);
process.exit(failed ? 1 : 0);
