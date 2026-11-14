/**
 * apc.json at pairing (APC 0.5, DESIGN.md section 17), in one process: the real hub (hub.ts) on Node's
 * SQLite, the real Pulse sandbox and Pulse's Worker for the apc.json it serves, and simulated apps for
 * what Pulse would never serve. fetch is routed by origin and counted.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { APC_JSON_PAIRING_MAX_AGE_S, APC_JSON_PATH, APC_STANDARD_VERSION, parseApcManifest } from "@tineira/apc-protocol";
import { demoDataset } from "../../demo/src/model/demo-world.ts";
import { LIMITS } from "../src/worker/trust.ts";

installWorkersStandIn();
const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);
const { Sandbox } = await import(new URL("../../demo/src/worker/sandbox.ts", import.meta.url).href);
const { default: pulseWorker } = await import(new URL("../../demo/src/worker/index.ts", import.meta.url).href);
const { default: dockWorker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);
const { default: signalsWorker } = await import(new URL("../../signals/src/worker/index.ts", import.meta.url).href);

/** The hub's answer as its Worker gives it (index.ts): HTTP 400 on a refusal, which the apps read as the hub's own (APC 0.9). */
const answerAs = (r: { ok: boolean }) => Response.json(r, { status: r.ok ? 200 : 400 });
const DOCK = "https://dock.test";
const PULSE = "https://pulse.test";
const SHOP = "https://shop.example";
const DID = "e".repeat(32);
const SID = "f".repeat(32);
/** Pulse as deployed for pairing (APC 0.10, M8): it lists `dock` only with its public origin and its hub allowlist configured. */
const PULSE_ENV = { APC_V2: "1", APC_PROFILES: "direct,dock", HUB_ORIGINS: DOCK, PUBLIC_ORIGIN: PULSE };

type Json = Record<string, unknown>;
/** What an origin answers to GET /.well-known/apc.json: a Response, or a thrown network error. */
type Serve = (init?: RequestInit) => Response | Promise<Response>;

async function world(t: TestContext, env: Json = {}) {
  const hub = new Hub(durableObjectRoom().ctx, { APP_ORIGINS: PULSE, PAIRING_CODE: "when_sent", ...env });
  await hub.init(DID);
  const pulse = new Sandbox(durableObjectRoom().ctx, PULSE_ENV);
  await pulse.init();
  const customers = demoDataset().customers;
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
      return pulseWorker.fetch(request, { ...PULSE_ENV, SANDBOX: { idFromName: (name: string) => name, get: () => pulse } });
    }
    if (url.origin === DOCK && url.pathname === "/apc/pair") return answerAs(await hub.pair(await request.json()));
    if (url.origin === SHOP) return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    throw new TypeError(`no network in this test: ${url}`);
  });
  const agent = (await hub.state(DOCK)).agents[0];
  /** The person drops the agent on Pulse and allows it there: Pulse makes a grant and asks the hub to pair it. */
  const dropOnPulse = async () => {
    const { ticket } = await hub.ticket(agent.id);
    const drop = { hub: DOCK, agent: agent.id, ticket, target: { kind: "customer", id: customers[0]!.id } };
    // Pulse asks the person first (consent in the app, TIN-606); their Allow sends the nonce back.
    const asked = await pulse.pairHub(SID, PULSE, drop);
    return (await pulse.pairHub(SID, PULSE, { ...drop, consent: asked.consent })) as { ok: boolean; error?: string };
  };
  /** An app outside APP_ORIGINS asks to pair (as unverified: the person approves the warning in the dock before it pairs, TIN-581). */
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
  const signals = await (await signalsWorker.fetch(new Request(`${SIGNALS}${APC_JSON_PATH}`), { APC_PROFILES: "direct,dock", HUB_ORIGINS: DOCK, PUBLIC_ORIGIN: SIGNALS })).json();
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

test("H7: an apc.json out of reach refuses the pairing, verified app or not: never the copy the hub kept, never the operator's word", async (t) => {
  const w = await world(t);
  const saved = { ...LIMITS };
  t.after(() => Object.assign(LIMITS, saved));
  // No copy yet, the file times out: Pulse is in APP_ORIGINS, and is refused all the same.
  LIMITS.apcJsonMs = 100;
  w.apcJson.set(PULSE, () => new Promise<Response>(() => {}));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "apc_json_unreachable" }, "a time limit on a verified app's file refuses it");
  assert.deepEqual(await w.pairings(), []);
  // A good copy that lists dock, read and then out of reach once it is old: the copy does not pair Pulse.
  const w2 = await world(t);
  assert.equal((await w2.dropOnPulse()).ok, true, "Pulse's own file, kept as the copy");
  await w2.hub.decide((await w2.pairings())[0]!.id, "deny");
  LIMITS.apcJsonFreshMs = 0;
  w2.apcJson.set(PULSE, () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await w2.dropOnPulse(), { ok: false, error: "apc_json_unreachable" }, "no answer: refused, though the kept copy lists dock");
  w2.apcJson.set(PULSE, () => new Response("busy", { status: 503 }));
  assert.deepEqual(await w2.dropOnPulse(), { ok: false, error: "apc_json_unreachable" }, "a 5xx is unreachable too");
  assert.deepEqual(await w2.pairings(), []);
  // The file is back: read anew, it pairs.
  w2.apcJson.delete(PULSE);
  assert.equal((await w2.dropOnPulse()).ok, true);
});

test("H7: the copy the hub decides a pairing on is a minute old at most", async (t) => {
  assert.equal(LIMITS.apcJsonFreshMs, APC_JSON_PAIRING_MAX_AGE_S * 1000);
  assert.ok(LIMITS.apcJsonFreshMs <= 60_000);
  const w = await world(t);
  const saved = LIMITS.apcJsonFreshMs;
  t.after(() => (LIMITS.apcJsonFreshMs = saved));
  assert.equal((await w.dropOnPulse()).ok, true);
  await w.hub.decide((await w.pairings())[0]!.id, "deny");
  // Pulse stops offering dock: within the copy's life the hub may still pair on it; past it, it reads the file and refuses.
  w.apcJson.set(PULSE, () => Response.json(manifest(PULSE, { profiles: ["direct"] })));
  LIMITS.apcJsonFreshMs = 40;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "dock_not_offered" }, "a copy past its minute is not used");
});

test("the hub keeps a copy for a minute, then reads the file again", async (t) => {
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

test("a verified app whose apc.json redirects is refused: a redirect is the origin answering, not a file out of reach", async (t) => {
  const w = await world(t);
  const saved = LIMITS.apcJsonFreshMs;
  t.after(() => (LIMITS.apcJsonFreshMs = saved));
  LIMITS.apcJsonFreshMs = 0;
  // A fetch that follows the redirect unless told not to; the target serves a valid file for Pulse, so following it would pair.
  w.apcJson.set(PULSE, (init) => (init?.redirect === "manual" ? new Response(null, { status: 301, headers: { location: "https://elsewhere.example/apc.json" } }) : Response.json(manifest(PULSE))));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "apc_json_redirected" }, "refused, never the operator's word");
  assert.equal(w.redirects.at(-1), "manual");
  // A status 0 (the opaque answer some runtimes give for a redirect) is refused the same way.
  w.apcJson.set(PULSE, () => Object.defineProperty(new Response(null), "status", { value: 0 }));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "apc_json_redirected" });
  // A genuine network failure is refused too (H7, APC 0.10), as what it is.
  w.apcJson.set(PULSE, () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "apc_json_unreachable" });
  // A redirect after a good copy refuses too, and forgets the copy.
  w.apcJson.delete(PULSE);
  assert.equal((await w.dropOnPulse()).ok, true, "Pulse's own file, kept as the copy");
  await w.hub.decide((await w.pairings())[0]!.id, "deny");
  w.apcJson.set(PULSE, () => new Response(null, { status: 302, headers: { location: `${PULSE}/elsewhere` } }));
  assert.deepEqual(await w.dropOnPulse(), { ok: false, error: "apc_json_redirected" }, "the last copy does not excuse a redirect");
});

test("a verified app is held to the MCP path its apc.json declares", async (t) => {
  const w = await world(t);
  const pulsePairs = async (mcp_url: string) => {
    const { ticket } = await w.hub.ticket(w.agent.id);
    return (await w.hub.pair({ ticket, agent: w.agent.id, app: { name: "Pulse", origin: PULSE }, mcp_url })) as { ok: boolean; error?: string };
  };
  for (const outside of [`${PULSE}/tenant/mcp/abc`, `${PULSE}/mcp/%2e%2e%2fadmin`, `${PULSE}/mcp/..%2f..%2fadmin`, `${PULSE}/mcp/`]) {
    assert.deepEqual(await pulsePairs(outside), { ok: false, error: "mcp_url_not_declared" }, outside);
  }
  assert.equal((await pulsePairs(`${PULSE}/mcp/${SID}/${"c".repeat(32)}`)).ok, true, "under /mcp/, it pairs");
});

test("an unverified app pairs only with a valid apc.json it serves itself: unreachable, a redirect or another origin refuse it", async (t) => {
  // Open to unverified apps by default (TIN-581): the checks on its apc.json hold before the warning is ever shown.
  const w = await world(t);
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
  assert.deepEqual(await w.shopPairs(), { ok: false, error: "apc_json_redirected" }, "a redirect is not followed, and refused");
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

test("mcp.endpoints (APC 0.11): the hub pairs only a {secret} entry that lists dock, never what mcp.path alone would cover", async (t) => {
  const w = await world(t);
  const saved = LIMITS.apcJsonFreshMs;
  t.after(() => (LIMITS.apcJsonFreshMs = saved));
  LIMITS.apcJsonFreshMs = 0;
  const secret = "c".repeat(32);
  const shop = (mcp: Json, over: Json = {}) => manifest(SHOP, { name: "Shop", profiles: ["direct", "dock"], direct: { connect: `${SHOP}/connect` }, mcp, ...over });
  const split = { path: "/mcp/", endpoints: [{ path: "/mcp", profiles: ["direct"] }, { path: "/mcp/{secret}", profiles: ["dock"] }] };
  w.apcJson.set(SHOP, () => Response.json(shop(split)));
  for (const [url, why] of [
    [`${SHOP}/mcp`, "the shared Direct URL is never a Dock grant"],
    [`${SHOP}/mcp/${secret}/admin`, "under mcp.path, but no entry covers it"],
    [`${SHOP}/mcp/${secret}?x=1`, "a query, which mcp.path alone lets through"],
    [`${SHOP}/mcp/public`, "too short for a secret"],
    [`${SHOP}/Mcp/${secret}`, "the path is case-sensitive"],
  ] as const) {
    assert.deepEqual(await w.shopPairs(url), { ok: false, error: "mcp_url_not_declared" }, why);
  }
  w.apcJson.set(SHOP, () => Response.json(shop({ path: "/mcp/", endpoints: [{ path: "/mcp/{secret}", profiles: ["direct"] }] })));
  assert.deepEqual(await w.shopPairs(`${SHOP}/mcp/${secret}`), { ok: false, error: "mcp_url_not_declared" }, "a Direct-only template");
  w.apcJson.set(SHOP, () => Response.json(shop({ path: "/mcp/", endpoints: [{ path: "/mcp/{secret}", profiles: ["dock"], requires: "x" }] })));
  assert.deepEqual(await w.shopPairs(`${SHOP}/mcp/${secret}`), { ok: false, error: "mcp_url_not_declared" }, "an entry with a key the hub does not know is dropped whole");
  w.apcJson.set(SHOP, () => Response.json(shop(split, { profiles: ["direct"] })));
  assert.deepEqual(await w.shopPairs(`${SHOP}/mcp/${secret}`), { ok: false, error: "dock_not_offered" }, "M8: not pairing right now");
  assert.deepEqual(await w.pairings(), []);
  // A file with endpoints alone (no mcp.path) pairs a grant's secret URL.
  w.apcJson.set(SHOP, () => Response.json(shop({ endpoints: [{ path: "/mcp/{secret}", profiles: ["dock"] }] })));
  assert.equal((await w.shopPairs(`${SHOP}/mcp/${secret}`)).ok, true);
  assert.deepEqual((await w.pairings()).map((p) => p.app.origin), [SHOP]);
});

test("the copy the hub keeps is { v: 2, manifest }: a row an older hub wrote is read again (APC 0.11)", async (t) => {
  const w = await world(t);
  const sql = (w.hub as unknown as { sql: { exec: <T>(q: string, ...a: unknown[]) => { toArray: () => T[] } } }).sql;
  assert.equal((await w.dropOnPulse()).ok, true);
  const row = sql.exec<{ body: string }>("select body from apc_json where origin = ?", PULSE).toArray()[0]!;
  const copy = JSON.parse(row.body) as { v: number; manifest: Json };
  assert.equal(copy.v, 2);
  assert.equal(parseApcManifest(copy.manifest, PULSE).ok, true);
  await w.hub.decide((await w.pairings())[0]!.id, "deny");
  assert.equal((await w.dropOnPulse()).ok, true);
  assert.equal(w.reads.get(PULSE), 1, "a fresh v2 copy is used");
  await w.hub.decide((await w.pairings())[0]!.id, "deny");
  // A row as a 0.10 hub wrote it: the bare manifest. It is no copy for this hub.
  sql.exec("update apc_json set body = ? where origin = ?", JSON.stringify(copy.manifest), PULSE);
  assert.equal((await w.dropOnPulse()).ok, true);
  assert.equal(w.reads.get(PULSE), 2, "the old row was not used: the file was read again");
});
