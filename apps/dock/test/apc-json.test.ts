/**
 * apc.json at pairing (APC 0.5, DESIGN.md section 17), in one process: the real hub (hub.ts) on Node's
 * SQLite, the real Pulse sandbox and Pulse's Worker for the apc.json it serves, and simulated apps for
 * what Pulse would never serve. fetch is routed by origin and counted.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@apc/conformance/workers";
import { APC_JSON_PATH, APC_STANDARD_VERSION, parseApcManifest } from "@apc/protocol";
import { generateDataset } from "../../demo/src/model/seed.ts";
import { LIMITS } from "../src/worker/trust.ts";

installWorkersStandIn();
const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);
const { Sandbox } = await import(new URL("../../demo/src/worker/sandbox.ts", import.meta.url).href);
const { default: pulseWorker } = await import(new URL("../../demo/src/worker/index.ts", import.meta.url).href);
const { default: dockWorker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);
const { default: signalsWorker } = await import(new URL("../../signals/src/worker/index.ts", import.meta.url).href);

const DOCK = "https://dock.test";
const PULSE = "https://pulse.test";
const SHOP = "https://shop.example";
const DID = "e".repeat(32);
const SID = "f".repeat(32);
const SEED = 33;
const PULSE_ENV = { APC_V2: "1", APC_PROFILES: "direct,dock" };

type Json = Record<string, unknown>;
/** What an origin answers to GET /.well-known/apc.json: a Response, or a thrown network error. */
type Serve = (init?: RequestInit) => Response | Promise<Response>;

async function world(t: TestContext, env: Json = {}) {
  const hub = new Hub(durableObjectRoom().ctx, { APP_ORIGINS: PULSE, ...env });
  await hub.init(DID);
  const pulse = new Sandbox(durableObjectRoom().ctx, { ...PULSE_ENV, HUB_ORIGINS: DOCK });
  await pulse.init(SEED);
  const customers = generateDataset(SEED).customers;
  /** Each origin's apc.json, when a test replaces what it serves; Pulse's Worker otherwise. */
  const apcJson = new Map<string, Serve>();
  /** apc.json reads per origin, and every request the hub made with how it asked. */
  const reads = new Map<string, number>();
  const redirects: Array<string | undefined> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === APC_JSON_PATH) {
      reads.set(url.origin, (reads.get(url.origin) ?? 0) + 1);
      redirects.push(init?.redirect);
      const own = apcJson.get(url.origin);
      if (own) return own(init);
      if (url.origin === PULSE) return pulseWorker.fetch(request, PULSE_ENV);
    }
    if (url.origin === PULSE && url.pathname.startsWith("/mcp/")) return pulse.fetch(request);
    if (url.origin === PULSE && url.pathname === "/apc/revoke") {
      const secret = new URL(((await request.json()) as { mcp_url: string }).mcp_url).pathname.split("/").at(-1);
      const r = await pulse.revokeHubGrant(secret);
      return Response.json(r, { status: r.ok ? 200 : 404 });
    }
    if (url.origin === DOCK && url.pathname === "/apc/pair") return Response.json(await hub.pair(await request.json()));
    if (url.origin === SHOP) return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    throw new TypeError(`no network in this test: ${url}`);
  });
  const agent = (await hub.state(DOCK)).agents[0];
  /** The person drops the agent on Pulse and allows it there: Pulse makes a grant and asks the hub to pair it. */
  const dropOnPulse = async () => {
    const { ticket } = await hub.ticket(agent.id);
    return (await pulse.pairHub(SID, PULSE, { hub: DOCK, agent: agent.id, ticket, target: { kind: "customer", id: customers[0]!.id } })) as { ok: boolean; error?: string };
  };
  /** An app outside APP_ORIGINS asks to pair (it pairs only with OPEN_PAIRING, as unverified). */
  const shopPairs = async (mcpUrl = `${SHOP}/mcp/${"c".repeat(32)}`) => {
    const { ticket } = await hub.ticket(agent.id);
    return (await hub.pair({ ticket, agent: agent.id, app: { name: "Shop", origin: SHOP }, mcp_url: mcpUrl })) as { ok: boolean; error?: string };
  };
  const pairings = async () => (await hub.state(DOCK)).agents[0].pairings as Array<{ id: string; app: { origin: string }; status: string }>;
  return { hub, pulse, agent, apcJson, reads, redirects, dropOnPulse, shopPairs, pairings };
}

const manifest = (origin: string, over: Json = {}): Json => ({ name: "Pulse", standard: "0.5.0", origin, profiles: ["direct", "dock"], mcp: { path: "/mcp/" }, direct: { connect: `${origin}/agents` }, ...over });

test("Pulse and Signals serve a valid apc.json; the dock serves one that says it is a hub", async () => {
  const pulse = await (await pulseWorker.fetch(new Request(`${PULSE}${APC_JSON_PATH}`), PULSE_ENV)).json();
  const parsed = parseApcManifest(pulse, PULSE);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(pulse, { name: "Pulse", standard: APC_STANDARD_VERSION, origin: PULSE, profiles: ["direct", "dock"], mcp: { path: "/mcp/" }, direct: { connect: `${PULSE}/agents` } });

  const directOnly = await (await pulseWorker.fetch(new Request(`${PULSE}${APC_JSON_PATH}`), { APC_V2: "1", APC_PROFILES: "direct" })).json();
  assert.deepEqual(directOnly.profiles, ["direct"], "a Pulse that offers only Direct says so");

  const SIGNALS = "https://signals.test";
  const signals = await (await signalsWorker.fetch(new Request(`${SIGNALS}${APC_JSON_PATH}`), { APC_PROFILES: "direct,dock" })).json();
  assert.equal(parseApcManifest(signals, SIGNALS).ok, true);
  assert.deepEqual(signals, { name: "Signals", standard: APC_STANDARD_VERSION, origin: SIGNALS, profiles: ["direct", "dock"], mcp: { path: "/mcp/" }, direct: { connect: `${SIGNALS}/?connect` } });

  const response = await dockWorker.fetch(new Request(`${DOCK}${APC_JSON_PATH}`), {});
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const dock = await response.json();
  assert.deepEqual(dock, { name: "APC dock", standard: APC_STANDARD_VERSION, origin: DOCK, profiles: ["hub"], mcp: { path: "/mcp/" }, dock: { pair: `${DOCK}/apc/pair`, confirm: `${DOCK}/apc/confirm` } });
  assert.equal(parseApcManifest(dock, DOCK).ok, true);
  assert.equal((await dockWorker.fetch(new Request(`${DOCK}/.well-known/oauth-authorization-server`), {})).status, 404, "the rest of /.well-known stays 404");
});

test("Pulse pairs once the hub has read its apc.json; a ticket that does not pass reads nothing", async (t) => {
  const w = await world(t);
  assert.deepEqual(await w.hub.pair({ ticket: `${DID}.${"0".repeat(32)}`, agent: w.agent.id, app: { name: "Pulse", origin: PULSE }, mcp_url: `${PULSE}/mcp/${SID}/x` }), { ok: false, error: "ticket_expired" });
  assert.equal(w.reads.get(PULSE) ?? 0, 0, "nobody makes the hub fetch an app's file without a live ticket");
  assert.equal((await w.dropOnPulse()).ok, true);
  assert.equal(w.reads.get(PULSE), 1);
  assert.deepEqual((await w.pairings()).map((p) => [p.app.origin, p.status]), [[PULSE, "pending"]]);
});

test("the hub refuses a pairing whose apc.json is missing, even from a verified app", async (t) => {
  const w = await world(t);
  w.apcJson.set(PULSE, () => Response.json({ error: "not_found" }, { status: 404 }));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "apc_json_missing" });
  assert.deepEqual(await w.pairings(), []);
});

test("the hub refuses an apc.json that names another origin", async (t) => {
  const w = await world(t);
  w.apcJson.set(PULSE, () => Response.json(manifest("https://pulse.other.example")));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "apc_json_wrong_origin" });
  assert.deepEqual(await w.pairings(), []);
});

test("the hub refuses an app whose apc.json does not list the Dock profile", async (t) => {
  const w = await world(t);
  w.apcJson.set(PULSE, () => pulseWorker.fetch(new Request(`${PULSE}${APC_JSON_PATH}`), { APC_V2: "1", APC_PROFILES: "direct" }));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "dock_not_offered" });
  assert.deepEqual(await w.pairings(), []);
});

test("the hub refuses an apc.json it cannot read as one: not JSON, a field missing, too large", async (t) => {
  for (const serve of [
    () => new Response("<html>hello</html>", { headers: { "content-type": "text/html" } }),
    () => Response.json({ name: "Pulse", standard: "0.5.0", origin: PULSE, profiles: ["dock"] }),
    () => Response.json(manifest(PULSE, { profiles: ["direct", "dock"], direct: { connect: "https://elsewhere.example/connect" } })),
    () => Response.json(manifest(PULSE, { standard: "five" })),
    () => Response.json({ ...manifest(PULSE), padding: "x".repeat(20_000) }),
  ] satisfies Serve[]) {
    const w = await world(t);
    w.apcJson.set(PULSE, serve);
    assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "apc_json_invalid" });
    assert.deepEqual(await w.pairings(), []);
  }
});

test("the hub refuses an MCP URL outside the path the app's apc.json declares", async (t) => {
  const w = await world(t);
  w.apcJson.set(PULSE, () => Response.json(manifest(PULSE, { mcp: { path: "/agents/mcp/" } })));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "mcp_url_not_declared" });
  assert.deepEqual(await w.pairings(), []);
});

test("a verified app keeps pairing while its apc.json is briefly unreachable: against the copy read last, or on the operator's word", async (t) => {
  const w = await world(t);
  const saved = { ...LIMITS };
  t.after(() => Object.assign(LIMITS, saved));
  // No copy yet, the file times out: Pulse is in APP_ORIGINS, so it pairs.
  LIMITS.apcJsonMs = 100;
  w.apcJson.set(PULSE, () => new Promise<Response>(() => {}));
  assert.equal((await w.dropOnPulse()).ok, true, "a time limit on a verified app's file does not block it");
  // A copy that says Direct only, read and then unreachable once it is old: the copy still counts.
  const w2 = await world(t);
  w2.apcJson.set(PULSE, () => Response.json(manifest(PULSE, { profiles: ["direct"] })));
  assert.deepEqual(await w2.dropOnPulse(), { ok: false, error: "dock_not_offered" });
  LIMITS.apcJsonFreshMs = 0;
  w2.apcJson.set(PULSE, () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await w2.dropOnPulse(), { ok: false, error: "dock_not_offered" }, "the last copy read is checked, not skipped");
  w2.apcJson.set(PULSE, () => new Response("busy", { status: 503 }));
  assert.deepEqual(await w2.dropOnPulse(), { ok: false, error: "dock_not_offered" }, "a 5xx is unreachable too");
  // The app serves Dock again: read anew, it pairs.
  w2.apcJson.delete(PULSE);
  assert.equal((await w2.dropOnPulse()).ok, true);
});

test("the hub keeps a copy for ten minutes, then reads the file again", async (t) => {
  const w = await world(t);
  // The person says no in the dock: the hub gives Pulse its grant back, so the next drop pairs anew.
  const deny = async () => assert.equal((await w.hub.decide((await w.pairings())[0]!.id, "deny")).ok, true);
  assert.equal((await w.dropOnPulse()).ok, true);
  await deny();
  assert.equal((await w.dropOnPulse()).ok, true);
  assert.equal(w.reads.get(PULSE), 1, "the second pairing used the copy");
  const saved = LIMITS.apcJsonFreshMs;
  t.after(() => (LIMITS.apcJsonFreshMs = saved));
  LIMITS.apcJsonFreshMs = 0;
  await deny();
  assert.equal((await w.dropOnPulse()).ok, true);
  assert.equal(w.reads.get(PULSE), 2, "an old copy is read again");
});

test("the hub follows no redirect for a verified app's apc.json either: the target's body is never kept as the origin's file", async (t) => {
  const w = await world(t);
  const saved = LIMITS.apcJsonFreshMs;
  t.after(() => (LIMITS.apcJsonFreshMs = saved));
  LIMITS.apcJsonFreshMs = 0;
  const deny = async () => assert.equal((await w.hub.decide((await w.pairings())[0]!.id, "deny")).ok, true);
  // A fetch that follows the redirect unless told not to; the target says Pulse is Direct-only.
  w.apcJson.set(PULSE, (init) => (init?.redirect === "manual" ? new Response(null, { status: 301, headers: { location: "https://elsewhere.example/apc.json" } }) : Response.json(manifest(PULSE, { profiles: ["direct"] }))));
  assert.equal((await w.dropOnPulse()).ok, true, "a verified app's redirect counts as unreachable: it pairs on the operator's word");
  assert.equal(w.redirects.at(-1), "manual");
  // Had the target's body been kept, the next pairing would read "Direct only" from the copy.
  await deny();
  w.apcJson.set(PULSE, () => {
    throw new TypeError("fetch failed");
  });
  assert.equal((await w.dropOnPulse()).ok, true, "no copy of the redirect's target was kept");
  // A redirect after a good copy: the copy counts, as for any unreachable file.
  await deny();
  w.apcJson.set(PULSE, () => Response.json(manifest(PULSE, { profiles: ["direct"] })));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "dock_not_offered" });
  w.apcJson.set(PULSE, () => new Response(null, { status: 302, headers: { location: `${PULSE}/elsewhere` } }));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "dock_not_offered" }, "checked against the last copy read");
});

test("an unverified app pairs only with a valid apc.json it serves itself: unreachable, a redirect or another origin refuse it", async (t) => {
  const w = await world(t, { OPEN_PAIRING: "1" });
  // Every answer below is read anew: no copy is kept between them.
  const saved = LIMITS.apcJsonFreshMs;
  t.after(() => (LIMITS.apcJsonFreshMs = saved));
  LIMITS.apcJsonFreshMs = 0;
  const shop =(over: Json = {}) => manifest(SHOP, { name: "Shop", profiles: ["dock"], direct: undefined, ...over });
  w.apcJson.set(SHOP, () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await w.shopPairs(), { ok: false, error: "apc_json_unreachable" }, "no operator's word for an unverified app");
  // A fetch that follows the redirect unless told not to: the target serves a valid file for this origin.
  w.apcJson.set(SHOP, (init) => (init?.redirect === "manual" ? new Response(null, { status: 302, headers: { location: "https://elsewhere.example/apc.json" } }) : Response.json(shop())));
  assert.deepEqual(await w.shopPairs(), { ok: false, error: "apc_json_missing" }, "a redirect is not followed, so it is no file");
  assert.equal(w.redirects.at(-1), "manual");
  w.apcJson.set(SHOP, () => Response.json(shop()));
  for (const sneaky of ["%2e%2e%2fadmin", "..%2f..%2fadmin", "%252e%252e%252fadmin", "abc%2f..%2fdef"]) {
    assert.deepEqual(await w.shopPairs(`${SHOP}/mcp/${sneaky}`), { ok: false, error: "mcp_url_not_declared" }, `encoded traversal: ${sneaky}`);
  }
  w.apcJson.set(SHOP, () => Response.json(shop({ origin: "https://pulse.test" })));
  assert.deepEqual(await w.shopPairs(), { ok: false, error: "apc_json_wrong_origin" }, "it cannot borrow another app's file");
  w.apcJson.set(SHOP, () => Response.json(shop({ profiles: ["hub"], dock: { pair: `${SHOP}/apc/pair`, confirm: `${SHOP}/apc/confirm` } })));
  assert.deepEqual(await w.shopPairs(), { ok: false, error: "dock_not_offered" }, "a hub is not an app");
  w.apcJson.set(SHOP, () => Response.json(shop({ mcp: { path: "/tenant-a/mcp/" } })));
  assert.deepEqual(await w.shopPairs(), { ok: false, error: "mcp_url_not_declared" }, "a path the domain did not declare");
  w.apcJson.set(SHOP, () => Response.json(shop()));
  assert.equal((await w.shopPairs()).ok, true);
  assert.deepEqual((await w.pairings()).map((p) => p.app.origin), [SHOP]);
});
