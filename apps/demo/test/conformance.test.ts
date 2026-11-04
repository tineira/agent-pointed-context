/**
 * Pulse against the APC conformance suite (APC 0.2, TIN-577), on both profiles: Direct (a grant made in
 * Pulse, the agent on its own MCP URL) and Dock (a grant handed to a dock's hub at pairing). The sandbox
 * runs for real, on Node's SQLite (@tineira/apc-conformance/workers); the MCP calls go through its own fetch, as
 * an agent's or a hub's do. No network: the hub's side of pairing is a stand-in here (the dock's own
 * tests run the real hub against this sandbox).
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { apcConformance, runConformance, type ApcAppAdapter } from "@tineira/apc-conformance";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { APC_JSON_PATH, APC_STANDARD_VERSION, type FocusTarget, type PresenceEvent } from "@tineira/apc-protocol";
import { barCanCollapse, createTapPin, type BarAgent } from "@tineira/apc-web";
import { LAST_MONTH } from "../src/model/seed.ts";
import { demoDataset } from "../src/model/demo-world.ts";

installWorkersStandIn();
const { Sandbox } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const ORIGIN = "https://pulse.test";
const HUB = "https://dock.test";
const SID = "5".repeat(32);

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
  await sandbox.init();
  const data = demoDataset();
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
      const drop = { hub: HUB, agent: `ag_${agents}`, ticket: `${"d".repeat(32)}.${agents.toString().padStart(16, "0")}`, target: targets[0] };
      // Pulse asks the person on its page first (TIN-606); their Allow brings the nonce back.
      const asked = await sandbox.pairHub(SID, ORIGIN, drop);
      assert.equal(asked.error, "consent_required");
      const paired = await sandbox.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent });
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
      // The page on a phone (APC 0.6), modelled with @tineira/apc-web's own pieces: the bar's collapse rule on mobile and
      // the tap-to-pin controller `enablePinning` runs, which pins through the sandbox like the page's onPin does.
      // The real page, at 375x812 with a touch pointer, is scripts/mobile-e2e.mjs.
      mobile: {
        async agentBar() {
          const grants = (await sandbox.state()).grants as Array<{ id: string }>;
          const bar: BarAgent[] = grants.map((g) => ({ id: g.id, name: g.id, state: "idle", paths: [profile] }));
          return { visible: bar.map((a) => a.id), collapsible: barCanCollapse(bar, true) };
        },
        async pinByTouch(grantId, target) {
          const pins: Array<Promise<{ ok: boolean }>> = [];
          const tap = createTapPin({ onPin: (id, t) => void pins.push(sandbox.pin(id, t)) });
          tap.toggle(grantId);
          assert.equal(tap.tap({ element: {} as Element, target }), "pinned");
          return pins.length === 1 && (await pins[0]!).ok;
        },
        unpinByTouch: async (grantId) => (await sandbox.unpin(grantId), true),
      },
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
  const [major, minor, patch] = APC_STANDARD_VERSION.split(".").map(Number) as [number, number, number];
  const newerPatch = checkOf((await pulse("direct", { apcJson: served({ ...base, standard: `${major}.${minor}.${patch + 1}` }) })).app);
  await newerPatch.run();
  assert.match(newerPatch.note ?? "", /newer patch .* never changes the contract/, "a newer patch passes, and the note is kept");
  await assert.rejects(checkOf((await pulse("direct", { apcJson: served({ ...base, standard: `${major}.${minor + 1}.0` }) })).app).run(), /newer than/);
  await assert.rejects(checkOf((await pulse("direct", { apcJson: async () => Response.json({ error: "not_found" }, { status: 404 }) })).app).run(), /HTTP 404/);
});

test("Pulse's page, its own checks and its apc.json agree on the profiles it serves, from one source", async () => {
  for (const env of [DEPLOY, { APC_V2: "1", HUB_ORIGINS: HUB, APC_PROFILES: "direct" }, { APC_V2: "1", HUB_ORIGINS: HUB, APC_PROFILES: "dock" }, { APC_PROFILES: "direct,dock" }, { APC_PROFILES: "direct" }]) {
    const { sandbox } = await pulse("direct", { env });
    const file = await (await worker.fetch(new Request(`${ORIGIN}${APC_JSON_PATH}`), env)).json();
    assert.deepEqual((await sandbox.state()).profiles, file.profiles, JSON.stringify(env));
  }
  // Without the standard's deploy Pulse pairs with no dock, so neither says it does.
  const { sandbox } = await pulse("direct", { env: { APC_PROFILES: "direct,dock" } });
  assert.deepEqual((await sandbox.state()).profiles, ["direct"]);
});

test("the suite catches an app whose Revoke does nothing", async () => {
  const { app } = await pulse("direct", { revoke: false });
  const check = apcConformance(app).find((c) => c.name.includes("revoke from the app"))!;
  await assert.rejects(check.run(), /HTTP 200, expected 403/);
});

test("the suite catches a page that collapses its agent bar, hides an agent or cannot pin by touch on a phone (APC 0.6)", async () => {
  const { app } = await pulse("dock");
  const mobile = app.page.mobile!;
  const run = async (over: Partial<typeof mobile>, which: string) => {
    const page = { ...app.page, mobile: { ...mobile, ...over } };
    await apcConformance({ ...app, page }).find((c) => c.name.includes(which))!.run();
  };
  await assert.rejects(run({ agentBar: async () => ({ ...(await mobile.agentBar()), collapsible: true }) }, "cannot be collapsed"), /can be collapsed or hidden on a phone/);
  await assert.rejects(run({ agentBar: async () => ({ visible: [], collapsible: false }) }, "cannot be collapsed"), /is not shown in the page on a phone/);
  await assert.rejects(run({ pinByTouch: async () => false }, "pins with a finger"), /refused a pin made by tapping/);
  await assert.rejects(run({ unpinByTouch: async () => false }, "pins with a finger"), /no way to remove the pin with a finger/);
  // A page that says it removed the pin but did not.
  await assert.rejects(run({ unpinByTouch: async () => true }, "pins with a finger"), /still there after the person removed it by touch/);
  // Left out, an app that claims 0.6.0 or later fails (apc.json says what it claims); the others have nothing to check.
  await assert.rejects(apcConformance({ ...app, page: { ...app.page, mobile: undefined } }).find((c) => c.name.includes("adapter for a phone is given"))!.run(), /requires the mobile rule to be checked: give page.mobile/);
  assert.equal(apcConformance(app).filter((c) => c.name.includes("mobile")).length, 3);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A wait_for_focus on a grant's URL, as an agent sends it: the tool's answer, parsed. */
async function waitOn(sandbox: { fetch(request: Request): Promise<Response> }, mcpUrl: string, timeoutS: number): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
  const response = await sandbox.fetch(new Request(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_focus", arguments: { timeout_s: timeoutS } } }) }));
  const { result } = (await response.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: result.isError, body: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}

test("a running call is cut by its own grant, never by a grant id a later grant reuses (TIN-606)", async () => {
  const { app, sandbox, room } = await pulse("direct");
  room.openPage();
  const { grantId, mcpUrl } = await app.connect();

  // Revoked while it waits, and a new grant takes the same id at once: the wait still ends, revoked, at its next poll.
  const started = Date.now();
  const waiting = waitOn(sandbox, mcpUrl, 8);
  await sleep(100);
  assert.deepEqual(await sandbox.revokeGrant(grantId), { ok: true });
  const reused = "e".repeat(32);
  room.db.prepare("insert into grants (id, secret, label, created_at) values (?, ?, ?, ?)").run(grantId, reused, "Agent 9", new Date().toISOString());
  const cut = await waiting;
  assert.ok(Date.now() - started < 5_000, "it ended at its next poll, not at its timeout");
  assert.equal(cut.isError, true);
  assert.equal(cut.body.error, "revoked");

  // The grant that took the id goes without a revoke (as a dock's give-back drops one) while it waits: its call ends
  // unknown_grant, not "revoked", although a revoked grant once had its id.
  const second = waitOn(sandbox, `${ORIGIN}/mcp/${SID}/${reused}`, 8);
  await sleep(100);
  room.db.prepare("delete from grants where id = ?").run(grantId);
  const gone = await second;
  assert.equal(gone.isError, true);
  assert.equal(gone.body.error, "unknown_grant");
});

test("a double-clicked Allow in Pulse pairs once: the second request changes nothing (Grok on #123)", async (t) => {
  const { sandbox } = await pulse("dock");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let pairAsked!: () => void;
  const asked = new Promise<void>((resolve) => (pairAsked = resolve));
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === `${HUB}/apc/pair`) {
      pairAsked();
      await held;
      return Response.json({ ok: true, pairing_id: "pr_test", status: "pending", agent: { name: "Agent via dock", icon: null } });
    }
    throw new Error(`no network in this test: ${url}`);
  });
  const drop = { hub: HUB, agent: "ag_8", ticket: `${"d".repeat(32)}.${"8".repeat(16)}`, target: { kind: "customer", id: demoDataset().customers[0]!.id } };
  const { consent } = await sandbox.pairHub(SID, ORIGIN, drop);
  const first = sandbox.pairHub(SID, ORIGIN, { ...drop, consent });
  await asked;
  assert.deepEqual(await sandbox.pairHub(SID, ORIGIN, { ...drop, consent }), { ok: false, error: "pairing_in_progress" });
  release();
  const done = await first;
  assert.equal(done.ok, true, done.error);
  assert.deepEqual(calls, [`${HUB}/apc/pair`]);
  const state = await sandbox.state();
  assert.deepEqual(state.grants.map((g: { id: string }) => g.id), [done.grant_id]);
  assert.deepEqual(state.hub_links.map((l: { grant_id: string }) => l.grant_id), [done.grant_id]);
});

test("Pulse makes a grant for a dock agent only with the nonce its consent was shown with (TIN-606)", async (t) => {
  const { sandbox } = await pulse("dock");
  const hub = standInHub(t);
  const drop = { hub: HUB, agent: "ag_9", ticket: `${"d".repeat(32)}.${"9".repeat(16)}`, target: { kind: "customer", id: demoDataset().customers[0]!.id } };
  const asked = await sandbox.pairHub(SID, ORIGIN, drop);
  assert.deepEqual(Object.keys(asked).sort(), ["consent", "error", "ok"]);
  assert.equal(asked.error, "consent_required");
  assert.equal(hub.calls.length, 0, "no grant and no call to the dock without the person's yes");
  assert.equal((await sandbox.state()).grants.length, 0);
  assert.equal((await sandbox.pairHub(SID, ORIGIN, { ...drop, consent: asked.consent })).ok, true);
  assert.deepEqual(hub.calls, [`${HUB}/apc/pair`]);
  assert.equal((await sandbox.state()).grants.length, 1);
});
