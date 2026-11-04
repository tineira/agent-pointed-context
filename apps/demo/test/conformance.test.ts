/**
 * Pulse against the APC conformance suite (APC 0.2, TIN-577), on both profiles: Direct (a grant made in
 * Pulse, the agent on its own MCP URL) and Dock (a grant handed to a dock's hub at pairing). The sandbox
 * runs for real, on Node's SQLite (@apc/conformance/workers); the MCP calls go through its own fetch, as
 * an agent's or a hub's do. No network: the hub's side of pairing is a stand-in here (the dock's own
 * tests run the real hub against this sandbox).
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { apcConformance, runConformance, type ApcAppAdapter } from "@apc/conformance";
import { durableObjectRoom, installWorkersStandIn } from "@apc/conformance/workers";
import { APC_JSON_PATH, type FocusTarget, type PresenceEvent } from "@apc/protocol";
import { generateDataset, LAST_MONTH } from "../src/model/seed.ts";

installWorkersStandIn();
const { Sandbox } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const ORIGIN = "https://pulse.test";
const HUB = "https://dock.test";
const SID = "5".repeat(32);
const SEED = 4242;

/** A real dock pairs through /apc/pair; here a stand-in hub says yes, and nothing else leaves the process. */
function standInHub(t: TestContext | null): { calls: string[] } {
  const calls: string[] = [];
  const fake = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === `${HUB}/apc/pair`) return Response.json({ ok: true, pairing_id: "pr_test", status: "pending", agent: { name: "Agent via dock", icon: null } });
    throw new Error(`no network in this test: ${url}`);
  };
  if (t) t.mock.method(globalThis, "fetch", fake);
  else globalThis.fetch = fake as typeof fetch;
  return { calls };
}

/** Pulse's deploy (wrangler.jsonc): the standard's, with both profiles. */
const DEPLOY = { APC_V2: "1", HUB_ORIGINS: HUB, APC_PROFILES: "direct,dock" };

/** Pulse as the suite sees it: its MCP endpoint, and the page through the sandbox's own methods. */
async function pulse(profile: "direct" | "dock", options: { revoke?: boolean; env?: Record<string, string>; link?: boolean; apcJson?: (request: Request) => Promise<Response> } = {}) {
  const room = durableObjectRoom();
  const sandbox = new Sandbox(room.ctx, options.env ?? DEPLOY);
  await sandbox.init(SEED);
  const data = generateDataset(SEED);
  const targets: [FocusTarget, FocusTarget] = [
    { kind: "customer", id: data.customers[0]!.id, part: null, params: null },
    { kind: "customer", id: data.customers[1]!.id, part: null, params: null },
  ];
  let agents = 0;
  const secretOf = async (grantId: string): Promise<string> => ((await sandbox.state()).grants as Array<{ id: string; secret: string }>).find((g) => g.id === grantId)!.secret;
  const connectOn = async (path: "direct" | "dock") => {
    let grantId: string;
    if (path === "direct") {
      grantId = (await sandbox.addAgentGrant()).id;
    } else {
      // A dock agent dropped on Pulse, the person said yes: Pulse makes the grant and hands it to the hub.
      agents++;
      const paired = await sandbox.pairHub(SID, ORIGIN, { hub: HUB, agent: `ag_${agents}`, ticket: `${"d".repeat(32)}.${agents.toString().padStart(16, "0")}`, target: targets[0] });
      assert.equal(paired.ok, true, `pairing: ${paired.error}`);
      grantId = paired.grant_id!;
      await sandbox.unpin(grantId);
    }
    return { grantId, mcpUrl: `${ORIGIN}/mcp/${SID}/${await secretOf(grantId)}` };
  };
  const app: ApcAppAdapter = {
    name: "Pulse",
    profile,
    // The MCP endpoint is the sandbox's; apc.json is the Worker's, for the whole origin (APC 0.5).
    fetch: (request) => (new URL(request.url).pathname === APC_JSON_PATH ? options.apcJson?.(request) ?? worker.fetch(request, options.env ?? DEPLOY) : sandbox.fetch(request)),
    connect: () => connectOn(profile),
    // apc_link (APC 0.4): Pulse's deploy offers both profiles.
    ...(options.link
      ? {
          link: {
            connect: (path) => connectOn(path),
            async agents() {
              const state = await sandbox.state();
              const second = new Set((state.links as Array<[string, string]>).map(([, dock]) => dock));
              return (state.grants as Array<{ id: string }>).filter((g) => !second.has(g.id)).map((g) => ({ grants: [g.id, ...(state.links as Array<[string, string]>).filter(([d]) => d === g.id).map(([, k]) => k)] }));
            },
            unlink: async (grantId) => (await sandbox.unlinkGrant(grantId)).ok,
            async expireCodes() {
              room.db.exec("update apc_kv set value = json_set(value, '$.expires_at', 0) where key like 'code:%'");
            },
          },
        }
      : {}),
    targets,
    probe: { tool: "list_customers", args: { limit: 1 } },
    page: {
      setOpen(open) {
        if (!open) room.closePages();
        else if (!room.pages.some((p) => p.readyState === 1)) room.openPage();
      },
      async showView() {
        await sandbox.reportView({ screen: "customer", params: { month: LAST_MONTH }, selection: { kind: "customer", id: targets[0].id } });
      },
      pin: async (grantId, target) => (await sandbox.pin(grantId, target)).ok,
      takePresence: () => room.takeMessages().filter((m) => m.type === "presence").map((m) => m.event as PresenceEvent),
      revoke: async (grantId) => (options.revoke === false ? true : (await sandbox.revokeGrant(grantId)).ok),
    },
  };
  return { app, sandbox, room };
}

standInHub(null);
for (const profile of ["direct", "dock"] as const) {
  // The apc_link checks once, with the Direct run: they make agents on both paths themselves.
  const { app } = await pulse(profile, { link: profile === "direct" });
  for (const check of apcConformance(app)) test(check.name, check.run);
}
// The direct-only setup (no dock, the agent of its own at start) still passes the core.
{
  const { app } = await pulse("direct", { env: { APC_PROFILES: "direct" } });
  for (const check of apcConformance({ ...app, name: "Pulse direct-only" })) test(check.name, check.run);
}

test("a Pulse that offers one profile refuses the other", async () => {
  const dockOnly = await pulse("dock", { env: { ...DEPLOY, APC_PROFILES: "dock" } });
  assert.equal((await dockOnly.sandbox.resolveConflict("g_nobody", "split")).ok, false);
  assert.deepEqual((await dockOnly.sandbox.state()).profiles, ["dock"]);
  const directOnly = await pulse("direct", { env: { APC_V2: "1", HUB_ORIGINS: HUB, APC_PROFILES: "direct" } });
  assert.deepEqual(await directOnly.sandbox.pairHub(SID, ORIGIN, { hub: HUB, agent: "ag_1", ticket: "d".repeat(32), target: null }), { ok: false, error: "not_available" });
});

test("a link code is never written to the sandbox's log or kept in clear", async () => {
  const { app, sandbox, room } = await pulse("direct", { link: true });
  const check = apcConformance(app).find((c) => c.name.includes("the code links them"))!;
  const codes: string[] = [];
  const original = sandbox.fetch.bind(sandbox);
  app.fetch = async (request) => {
    const response = await original(request);
    const text = await response.clone().text();
    for (const m of text.matchAll(/lk_[0-9a-f]{24}/g)) codes.push(m[0]);
    return response;
  };
  await check.run();
  assert.ok(codes.length > 0, "an offer was made");
  const everything = (await sandbox.eventsJsonl()) + JSON.stringify(room.db.prepare("select * from apc_kv").all());
  for (const code of codes) assert.equal(everything.includes(code), false, "only its hash is kept, and the log hides it");
  assert.match(await sandbox.eventsJsonl(), /"type":"linked"/);
});

test("the suite catches an apc.json that leaves out a profile the app serves, names another origin, or another MCP path", async () => {
  const served = (manifest: Record<string, unknown>) => async () => Response.json(manifest);
  const base = { name: "Pulse", standard: "0.5.0", origin: ORIGIN, profiles: ["direct", "dock"], mcp: { path: "/mcp/" }, direct: { connect: `${ORIGIN}/agents` } };
  const checkOf = (app: ApcAppAdapter) => apcConformance(app).find((c) => c.name.includes("apc.json"))!;
  await assert.rejects(checkOf((await pulse("dock", { apcJson: served({ ...base, profiles: ["direct"] }) })).app).run(), /leave out dock/);
  await assert.rejects(checkOf((await pulse("direct", { link: true, apcJson: served({ ...base, profiles: ["direct"] }) })).app).run(), /offers both/);
  await assert.rejects(checkOf((await pulse("direct", { apcJson: served({ ...base, origin: "https://pulse.example" }) })).app).run(), /apc_json_wrong_origin/);
  await assert.rejects(checkOf((await pulse("direct", { apcJson: served({ ...base, mcp: { path: "/agents/" } }) })).app).run(), /mcp\.path/);
  await assert.rejects(checkOf((await pulse("direct", { apcJson: served({ ...base, standard: "9.0.0" }) })).app).run(), /standard is 9\.0\.0/);
  await assert.rejects(checkOf((await pulse("direct", { apcJson: async () => Response.json({ error: "not_found" }, { status: 404 }) })).app).run(), /HTTP 404/);
});

test("the suite catches an app whose Revoke does nothing", async () => {
  const { app } = await pulse("direct", { revoke: false });
  const check = apcConformance(app).find((c) => c.name.includes("revoke from the app"))!;
  await assert.rejects(check.run(), /HTTP 200, expected 403/);
});

test("runConformance reports each check", async () => {
  const { app } = await pulse("direct");
  const quick = { ...app, name: "Pulse" };
  const report = await runConformance(quick);
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter((r) => !r.ok)));
  assert.equal(report.passed, apcConformance(app).length);
});

test("revoking a dock agent in Pulse calls nobody, and its URL answers revoked with Pulse's host", async (t) => {
  const { app, sandbox, room } = await pulse("dock");
  const hub = standInHub(t);
  const { grantId, mcpUrl } = await app.connect();
  const before = hub.calls.length;
  // The hub is down from here on: every fetch throws.
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("the hub is down");
  });
  assert.deepEqual(await sandbox.revokeGrant(grantId), { ok: true });
  assert.equal(hub.calls.length, before, "no call to the hub");
  const state = await sandbox.state();
  assert.equal(state.grants.some((g: { id: string }) => g.id === grantId), false, "the grant is gone");
  assert.equal(state.hub_links.length, 0, "and so is the dock link: a new drop asks the person again");

  const response = await sandbox.fetch(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_customers", arguments: {} } }) }));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "revoked");
  assert.equal(body.revoked_by, "pulse.test");

  // The secret itself is not kept: only its hash, to answer "revoked".
  const secret = new URL(mcpUrl).pathname.split("/").at(-1)!;
  const everything = JSON.stringify(room.db.prepare("select name from sqlite_master where type = 'table'").all().map((r) => room.db.prepare(`select * from ${String(r.name)}`).all()));
  assert.equal(everything.includes(secret), false);
  // The page's event log says what happened, without the secret.
  assert.match(await sandbox.eventsJsonl(), /"type":"revoked".*"via":"dock"/);
});

test("revoking an unknown grant changes nothing", async () => {
  const { sandbox } = await pulse("direct");
  assert.deepEqual(await sandbox.revokeGrant("g_nobody"), { ok: false, error: "unknown_grant" });
});
