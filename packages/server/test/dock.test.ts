/**
 * The app's side of the Dock profile (APC 0.10, TIN-883): the drop parser and its hub allowlist (M1), the
 * give-back endpoint (M7), the grant's answer table as a gate, and the derived-secret recipe.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { DOCK_GRANT_STATES, IDLE_MESSAGE, PAIRING_MESSAGE, REVOKED_HTTP_STATUS, revokedAnswer, type DockGrantState } from "@tineira/apc-protocol";
import {
  DOCK_GIVE_BACK_MAX_BYTES,
  deriveDockSecret,
  dockGrantGate,
  dockGrantToolResult,
  dockSecretHash,
  handleDockGiveBack,
  newDockSalt,
  parseDockDrop,
  secretHash,
} from "../src/index.ts";

// #region M1

const HUBS = { hubs: ["https://apc.tineira.com"] };
const DROP = { agent: "ag_1a2b3c4d", ticket: "0123456789abcdef.0123456789abcdef" };
const drop = (hub: unknown, o = HUBS) => parseDockDrop({ ...DROP, hub }, o);

test("M1: an allowlisted https origin is taken, as its parsed origin", () => {
  assert.deepEqual(drop("https://apc.tineira.com"), { ok: true, hub: "https://apc.tineira.com", ...DROP });
  assert.deepEqual(drop("https://apc.tineira.com/"), { ok: true, hub: "https://apc.tineira.com", ...DROP }, "a trailing slash is the empty path");
});

test("M1: anything but the exact allowlisted origin is hub_not_allowed", () => {
  const refused: Array<[unknown, string]> = [
    ["https://apc.tineira.com.evil.example", "a prefix"],
    ["https://evil.example/https://apc.tineira.com", "a suffix in the path"],
    ["https://evilapc.tineira.com", "another subdomain"],
    ["https://tineira.com", "the parent domain"],
    ["https://pulse.apc.tineira.com", "a subdomain"],
    ["http://apc.tineira.com", "http:"],
    ["wss://apc.tineira.com", "another scheme"],
    ["https://apc.tineira.com:8443", "another port"],
    ["https://apc.tineira.com:443", "the default port written out"],
    ["HTTPS://APC.TINEIRA.COM", "not written as its origin"],
    ["https://apc.tineira.com.", "a trailing dot"],
    ["https://apc.tineira.com/apc/pair", "a path"],
    ["https://apc.tineira.com/.", "a dot segment"],
    ["https://apc.tineira.com//", "a double slash"],
    ["https://apc.tineira.com?x=1", "a query"],
    ["https://apc.tineira.com/?", "an empty query"],
    ["https://apc.tineira.com#f", "a fragment"],
    ["https://user:pass@apc.tineira.com", "userinfo"],
    ["https://apc.tineira.com@evil.example", "userinfo, the other way round"],
    ["https://@apc.tineira.com", "empty userinfo"],
    ["https:\\\\apc.tineira.com", "backslashes"],
    ["https://apc.tineira\n.com", "a newline new URL would drop"],
    [" https://apc.tineira.com", "leading space"],
    ["https://apc.tіneira.com", "an IDN homograph (Cyrillic і)"],
    ["https://xn--apc.tneira-1fi.com", "the homograph's punycode"],
    ["https://", "unparsable"],
    ["not a url", "unparsable"],
    ["", "empty"],
    [null, "null"],
    [42, "a number"],
    [undefined, "absent"],
    [`https://${"a".repeat(300)}.com`, "too long"],
  ];
  for (const [hub, what] of refused) assert.deepEqual(drop(hub), { ok: false, error: "hub_not_allowed" }, what);
});

test("M1: an IDN hub is allowlisted and dropped in punycode, as location.origin gives it", () => {
  const o = { hubs: ["https://xn--bcher-kva.example"] };
  assert.deepEqual(drop("https://xn--bcher-kva.example", o), { ok: true, hub: "https://xn--bcher-kva.example", ...DROP });
  assert.deepEqual(drop("https://bücher.example", o), { ok: false, error: "hub_not_allowed" }, "the Unicode spelling is not written as its origin");
  assert.throws(() => parseDockDrop({ ...DROP, hub: "https://xn--bcher-kva.example" }, { hubs: ["https://bücher.example"] }), TypeError, "nor is it an allowlist entry");
});

test("M1: a local-dev origin is allowed over http only when listed, and only on loopback", () => {
  const dev = { hubs: ["https://apc.tineira.com"], localDevHubs: ["http://localhost:8787"] };
  assert.deepEqual(drop("http://localhost:8787", dev), { ok: true, hub: "http://localhost:8787", ...DROP });
  assert.deepEqual(drop("http://localhost:8788", dev), { ok: false, error: "hub_not_allowed" }, "another port");
  assert.deepEqual(drop("http://localhost:8787", HUBS), { ok: false, error: "hub_not_allowed" }, "not listed");
  assert.deepEqual(drop("http://127.0.0.1:8787", dev), { ok: false, error: "hub_not_allowed" }, "another loopback spelling is another origin");
  assert.deepEqual(drop("https://apc.tineira.com", dev), { ok: true, hub: "https://apc.tineira.com", ...DROP });
  for (const entry of ["http://dock.example", "http://localhost.evil.example", "http://10.0.0.1"]) {
    assert.throws(() => parseDockDrop(DROP, { hubs: [], localDevHubs: [entry] }), TypeError, entry);
  }
  assert.doesNotThrow(() => parseDockDrop(DROP, { hubs: [], localDevHubs: ["http://127.0.0.1:5200", "http://[::1]:5200", "http://dock.localhost:5200"] }));
});

test("M1: the allowlist itself must be bare https origins, or the parser throws", () => {
  for (const entry of ["http://apc.tineira.com", "https://apc.tineira.com/x", "apc.tineira.com", "https://APC.tineira.com", "https://u@apc.tineira.com", ""]) {
    assert.throws(() => parseDockDrop({ ...DROP, hub: "https://apc.tineira.com" }, { hubs: [entry] }), TypeError, entry);
  }
  assert.deepEqual(drop("https://apc.tineira.com", { hubs: [] }), { ok: false, error: "hub_not_allowed" }, "an empty allowlist takes nothing");
});

test("M1: the agent and the ticket follow the drag grammar; a body that is not a drop is invalid_drop", () => {
  const hub = "https://apc.tineira.com";
  for (const body of [null, "x", [DROP], 7]) assert.deepEqual(parseDockDrop(body, HUBS), { ok: false, error: "invalid_drop" });
  for (const agent of [undefined, "", "x".repeat(129), "https://apc.tineira.com/mcp/s", "a b", 1]) {
    assert.deepEqual(parseDockDrop({ ...DROP, hub, agent }, HUBS), { ok: false, error: "invalid_drop" }, String(agent));
  }
  for (const ticket of [undefined, "short", "x".repeat(201), "a/b".repeat(10), 1]) {
    assert.deepEqual(parseDockDrop({ ...DROP, hub, ticket }, HUBS), { ok: false, error: "invalid_drop" }, String(ticket));
  }
  assert.deepEqual(parseDockDrop({ hub: "https://evil.example", agent: "", ticket: "" }, HUBS), { ok: false, error: "hub_not_allowed" }, "the hub is checked first");
});

// #endregion

// #region M7

const ORIGIN = "https://orders.test";
const SECRET = "s".repeat(24) + "0123456789abcdef";

/** An app's grants keyed by secret hash, ended the way M7 says: any state but revoked or ended. */
function grants(states: Record<string, DockGrantState>) {
  const byHash = new Map<string, DockGrantState>();
  const calls: string[] = [];
  return {
    byHash,
    calls,
    async seed() {
      for (const [secret, state] of Object.entries(states)) byHash.set(await secretHash(secret), state);
    },
    endGrantBySecretHash(hash: string) {
      calls.push(hash);
      const state = byHash.get(hash);
      if (state && state !== "revoked" && state !== "ended") byHash.set(hash, "ended");
    },
  };
}

const giveBack = (body: BodyInit | null, init: RequestInit = {}) => new Request(`${ORIGIN}/apc/revoke`, { method: "POST", body, ...init });
const json = (value: unknown) => giveBack(JSON.stringify(value), { headers: { "content-type": "application/json" } });

async function same(response: Response): Promise<void> {
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
}

test("M7: a matching give-back ends the grant in any state but revoked or ended, by its secret hash", async () => {
  const live = `${"l".repeat(20)}live0001`;
  const inFlight = `${"f".repeat(20)}flight01`;
  const handoff = `${"h".repeat(20)}handoff1`;
  const dormant = `${"d".repeat(20)}dormant1`;
  const store = grants({ [live]: "live", [inFlight]: "in_flight", [handoff]: "handoff", [dormant]: "dormant" });
  await store.seed();
  for (const secret of [live, inFlight, handoff, dormant]) {
    await same(await handleDockGiveBack(json({ mcp_url: `${ORIGIN}/mcp/${secret}` }), { origin: ORIGIN, endGrantBySecretHash: (h) => store.endGrantBySecretHash(h) }));
    assert.equal(store.byHash.get(await secretHash(secret)), "ended", secret);
  }
  assert.deepEqual(store.calls, await Promise.all([live, inFlight, handoff, dormant].map(secretHash)), "called with secretHash of the URL's secret, never the secret");
});

test("M7: a revoked or ended grant is left as it is: revoked stays revoked", async () => {
  const revoked = `${"r".repeat(20)}revoked1`;
  const ended = `${"e".repeat(20)}ended001`;
  const store = grants({ [revoked]: "revoked", [ended]: "ended" });
  await store.seed();
  for (const secret of [revoked, ended]) await same(await handleDockGiveBack(json({ mcp_url: `${ORIGIN}/mcp/${secret}` }), { origin: ORIGIN, endGrantBySecretHash: (h) => store.endGrantBySecretHash(h) }));
  assert.equal(store.byHash.get(await secretHash(revoked)), "revoked");
  assert.equal(store.byHash.get(await secretHash(ended)), "ended");
});

test("M7: the same 200 to any input, and junk never reaches the store", async () => {
  const called: string[] = [];
  const options = { origin: ORIGIN, endGrantBySecretHash: (h: string) => void called.push(h) };
  const junk: Request[] = [
    giveBack(null),
    giveBack("not json"),
    giveBack("[]"),
    json({}),
    json({ mcp_url: 42 }),
    json({ mcp_url: "not a url" }),
    json({ mcp_url: `https://evil.test/mcp/${SECRET}` }),
    json({ mcp_url: `${ORIGIN}/mcp/short` }),
    json({ mcp_url: `${ORIGIN}/mcp/${SECRET}?x=1` }),
    json({ mcp_url: `https://u:p@orders.test/mcp/${SECRET}` }),
    json({ mcp_url: `${ORIGIN}/mcp/${"x".repeat(3000)}` }),
    giveBack(new Uint8Array([0x7b, 0xff, 0x7d])),
    giveBack(JSON.stringify({ mcp_url: `${ORIGIN}/mcp/${SECRET}`, pad: "x".repeat(DOCK_GIVE_BACK_MAX_BYTES) })),
    giveBack(JSON.stringify({ mcp_url: `${ORIGIN}/mcp/${SECRET}` }), { headers: { "content-length": "abc" } }),
    new Request(`${ORIGIN}/apc/revoke?mcp_url=${encodeURIComponent(`${ORIGIN}/mcp/${SECRET}`)}`),
  ];
  for (const request of junk) await same(await handleDockGiveBack(request, options));
  assert.deepEqual(called, [], "nothing reached the store");
  // An unknown, well-formed URL reaches the store (which finds nothing) and answers the same.
  await same(await handleDockGiveBack(json({ mcp_url: `${ORIGIN}/mcp/${SECRET}` }), options));
  assert.deepEqual(called, [await secretHash(SECRET)]);
});

test("M7: the body is capped as it streams, without a content-length", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
    },
  });
  const called: string[] = [];
  await same(await handleDockGiveBack(new Request(`${ORIGIN}/apc/revoke`, { method: "POST", body, duplex: "half" } as RequestInit), { origin: ORIGIN, endGrantBySecretHash: (h) => void called.push(h) }));
  assert.ok(pulls <= DOCK_GIVE_BACK_MAX_BYTES / 1024 + 2, `read ${pulls} KiB at most`);
  assert.deepEqual(called, []);
});

test("M7: an app's own way to find the secret, and a store failure is a 500 the hub can retry", async () => {
  const seen: Array<[string, string]> = [];
  const pulse = { origin: ORIGIN, secretOf: (url: URL) => url.pathname.match(/^\/mcp\/[0-9a-f]{32}\/([0-9a-f]{32})$/)?.[1] ?? null, endGrantBySecretHash: (h: string, url: URL) => void seen.push([h, url.pathname.split("/")[2]!]) };
  const sid = "a".repeat(32);
  const secret = "b".repeat(32);
  await same(await handleDockGiveBack(json({ mcp_url: `${ORIGIN}/mcp/${sid}/${secret}` }), pulse));
  assert.deepEqual(seen, [[await secretHash(secret), sid]]);
  const failing = await handleDockGiveBack(json({ mcp_url: `${ORIGIN}/mcp/${SECRET}` }), {
    origin: ORIGIN,
    endGrantBySecretHash: () => {
      throw new Error("database down");
    },
  });
  assert.equal(failing.status, 500);
  assert.deepEqual(await failing.json(), { ok: false });
});

test("M7: the URL and the secret are never logged or echoed", async () => {
  const logged: unknown[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(saved) as Array<keyof typeof saved>) console[k] = (...args: unknown[]) => void logged.push(args);
  try {
    for (const end of [() => {}, () => Promise.reject(new Error("db"))]) {
      const response = await handleDockGiveBack(json({ mcp_url: `${ORIGIN}/mcp/${SECRET}` }), { origin: ORIGIN, endGrantBySecretHash: end });
      assert.equal((await response.text()).includes(SECRET), false);
    }
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(logged, []);
});

// #endregion

// #region the state table

const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 7, method, ...(params === undefined ? {} : { params }) });
const notify = (method: string) => ({ jsonrpc: "2.0", method });
const call = (tool: string) => rpc("tools/call", { name: tool, arguments: {} });
const GATE = { host: "orders.test", revokedAt: "2026-11-13T10:00:00.000Z" };

test("the gate: in flight and ended answer 404 to everything, revoked RevokedAnswer, and live serves", async () => {
  const messages = [rpc("initialize", {}), rpc("ping"), rpc("tools/list"), call("get_current_view"), call("list_orders"), rpc("resources/list"), notify("notifications/initialized"), undefined, [rpc("ping")]];
  for (const message of messages) {
    for (const state of ["in_flight", "ended"] as const) {
      const gate = dockGrantGate(state, message, GATE);
      assert.equal(gate.serve, false);
      if (!gate.serve) {
        assert.equal(gate.response.status, 404, `${state} ${JSON.stringify(message)}`);
        assert.deepEqual(await gate.response.json(), { error: "not_found" });
      }
    }
    const revoked = dockGrantGate("revoked", message, GATE);
    assert.equal(revoked.serve, false);
    if (!revoked.serve) {
      assert.equal(revoked.response.status, REVOKED_HTTP_STATUS);
      assert.deepEqual(await revoked.response.json(), revokedAnswer("orders.test", GATE.revokedAt));
    }
    assert.deepEqual(dockGrantGate("live", message, GATE), { serve: true, commits: false, answer: { kind: "serve", commits: false, wakes: false } });
  }
});

test("the gate in handoff: initialize commits, ping and tools/list serve, a tool call is the pairing error, a notification 202", async () => {
  assert.deepEqual(dockGrantGate("handoff", rpc("initialize", {}), GATE), { serve: true, commits: true, answer: { kind: "serve", commits: true, wakes: false } });
  for (const method of ["ping", "tools/list"]) assert.deepEqual(dockGrantGate("handoff", rpc(method), GATE), { serve: true, commits: false, answer: { kind: "serve", commits: false, wakes: false } });
  for (const tool of ["get_current_view", "wait_for_focus", "list_orders"]) {
    const gate = dockGrantGate("handoff", call(tool), GATE);
    assert.equal(gate.serve, false);
    if (gate.serve) continue;
    assert.equal(gate.response.status, 200);
    const body = (await gate.response.json()) as { jsonrpc: string; id: number; result: { isError: boolean; structuredContent: unknown; content: Array<{ text: string }> } };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 7);
    assert.equal(body.result.isError, true);
    assert.deepEqual(body.result.structuredContent, { error: "pairing", message: PAIRING_MESSAGE });
    assert.deepEqual(JSON.parse(body.result.content[0]!.text), body.result.structuredContent, "the same JSON in the text");
  }
  const other = dockGrantGate("handoff", rpc("prompts/list"), GATE);
  assert.equal(other.serve, false);
  if (!other.serve) assert.deepEqual(await other.response.json(), { jsonrpc: "2.0", id: 7, error: { code: -32000, message: PAIRING_MESSAGE, data: { error: "pairing", message: PAIRING_MESSAGE } } });
  const note = dockGrantGate("handoff", notify("notifications/initialized"), GATE);
  assert.equal(note.serve, false);
  if (!note.serve) {
    assert.equal(note.response.status, 202);
    assert.equal(await note.response.text(), "");
  }
});

test("the gate when dormant: initialize serves without committing, core tools answer their idle shapes, other tools idle", async () => {
  assert.deepEqual(dockGrantGate("dormant", rpc("initialize", {}), GATE), { serve: true, commits: false, answer: { kind: "serve", commits: false, wakes: false } });
  assert.deepEqual(dockGrantGate("dormant", notify("notifications/initialized"), GATE), { serve: true, commits: false, answer: { kind: "serve", commits: false, wakes: false } });
  const shapes: Record<string, unknown> = {
    get_current_view: { view: null, focus: null, idle: true, note: IDLE_MESSAGE },
    wait_for_focus: { focus: null, timed_out: false, page_open: false, idle: true, note: IDLE_MESSAGE },
  };
  for (const [tool, shape] of Object.entries(shapes)) {
    const gate = dockGrantGate("dormant", call(tool), GATE);
    assert.equal(gate.serve, false);
    if (gate.serve) continue;
    const body = (await gate.response.json()) as { result: { isError?: boolean; structuredContent: unknown; content: Array<{ text: string }> } };
    assert.equal(body.result.isError, undefined);
    assert.deepEqual(body.result.structuredContent, shape);
    assert.deepEqual(JSON.parse(body.result.content[0]!.text), shape);
  }
  const tool = dockGrantGate("dormant", call("list_orders"), { ...GATE, idleMessage: "Away." });
  assert.equal(tool.serve, false);
  if (!tool.serve) assert.deepEqual(((await tool.response.json()) as { result: { structuredContent: unknown } }).result.structuredContent, { error: "idle", message: "Away." });
  const other = dockGrantGate("dormant", rpc("resources/read", { uri: "x" }), GATE);
  assert.equal(other.serve, false);
  if (!other.serve) assert.equal(((await other.response.json()) as { error: { code: number; data: { error: string } } }).error.data.error, "idle");
});

test("the gate never serves a batch or junk from a grant that is not live, and no answer carries attention, then or apc_link", async () => {
  for (const state of DOCK_GRANT_STATES) {
    for (const message of [[call("list_orders")], "x", null, undefined, call("list_orders"), call("get_current_view")]) {
      const gate = dockGrantGate(state, message, GATE);
      if (gate.serve) {
        assert.equal(state, "live", `only a live grant serves ${JSON.stringify(message)}`);
        continue;
      }
      const text = await gate.response.text();
      for (const key of ['"attention"', '"then"', '"apc_link"']) assert.equal(text.includes(key), false, `${state}: ${key}`);
    }
  }
});

test("dockGrantToolResult: the same answers inside a tool handler, and a throw for states answered before the transport", () => {
  assert.equal(dockGrantToolResult("live", "list_orders"), null);
  assert.deepEqual(dockGrantToolResult("handoff", "get_current_view")?.structuredContent, { error: "pairing", message: PAIRING_MESSAGE });
  assert.deepEqual(dockGrantToolResult("dormant", "wait_for_focus")?.structuredContent, { focus: null, timed_out: false, page_open: false, idle: true, note: IDLE_MESSAGE });
  assert.deepEqual(dockGrantToolResult("dormant", "list_orders", { idleMessage: "Away." })?.structuredContent, { error: "idle", message: "Away." });
  for (const state of ["in_flight", "ended", "revoked"] as const) assert.throws(() => dockGrantToolResult(state, "list_orders"));
});

// #endregion

// #region the recipe

const K = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const SALT = "oKGio6SlpqeoqaqrrK2urw";

test("the recipe: fixed vectors, checked against node:crypto too", async () => {
  assert.equal(await deriveDockSecret(K, "pulse", "g_0123456789abcdef", SALT), "v6IC4OtrU8sKfyi9uGiCRg");
  assert.equal(await dockSecretHash("v6IC4OtrU8sKfyi9uGiCRg"), "8cb275b291f4865f8e4ef427ba2abc102dafbc6a7d410843dd262d82a9c77213");
  assert.equal(await deriveDockSecret(new Uint8Array(32).fill(0x0b).buffer, "surplus", "42", "AAAAAAAAAAAAAAAAAAAAAA"), "ShsBa1P-IbyJF9sMXSzGsg");
  assert.equal(await dockSecretHash("ShsBa1P-IbyJF9sMXSzGsg"), "010b32a9c5b4e403951a34a1c5573fdef0f69f1bd5432280f3458901f7bb55f6");
  for (let i = 0; i < 20; i++) {
    const salt = newDockSalt();
    const key = crypto.getRandomValues(new Uint8Array(48));
    const grantId = `g_${i}`;
    const secret = await deriveDockSecret(key, "orders", grantId, salt);
    const expected = createHmac("sha256", key).update(`orders-dock-v1|${grantId}|${salt}`).digest().subarray(0, 16).toString("base64url");
    assert.equal(secret, expected);
    assert.match(secret, /^[A-Za-z0-9_-]{22}$/, "22 characters, unpadded base64url");
    assert.equal(await dockSecretHash(secret), createHash("sha256").update(secret, "ascii").digest("hex"));
    assert.equal(await dockSecretHash(secret), await secretHash(secret), "the hash the give-back looks up");
  }
});

test("the recipe: a new salt is 16 random bytes, base64url", () => {
  const salts = new Set(Array.from({ length: 50 }, newDockSalt));
  assert.equal(salts.size, 50);
  for (const salt of salts) {
    assert.match(salt, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(salt, "base64url").length, 16);
  }
});

test("the recipe refuses inputs outside it", async () => {
  await assert.rejects(deriveDockSecret(new Uint8Array(31), "pulse", "g", SALT), RangeError, "K under 32 bytes");
  for (const tag of ["Pulse", "pu|lse", "", "pulse app", "x".repeat(65)]) await assert.rejects(deriveDockSecret(K, tag, "g", SALT), TypeError, tag);
  for (const id of ["", "g|1", "x".repeat(257)]) await assert.rejects(deriveDockSecret(K, "pulse", id, SALT), TypeError, id);
  for (const salt of ["", "oKGio6SlpqeoqaqrrK2urw==", "oKGio6SlpqeoqaqrrK2ur", "oKGio6SlpqeoqaqrrK2urx", "oKGio6Slpqeoqaqr+K2urw", "AAAAAAAAAAAAAAAAAAAAAAAA"]) {
    await assert.rejects(deriveDockSecret(K, "pulse", "g", salt), TypeError, salt);
  }
  for (const secret of ["", "é", "a b", "x".repeat(513)]) await assert.rejects(dockSecretHash(secret), TypeError, secret);
});

// #endregion
