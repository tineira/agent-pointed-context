/**
 * The binding on the app's side (APC 0.12, TIN-910): `pairWithHub` reads the declared binding and refuses an
 * unknown one; `dockGrantGate` checks every initialize against the grant's binding (M11); `directGrantGate`
 * refuses a hub's introduction on a grant that is not a Dock grant, before anything else (M12).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { APC_AGENT_META, APC_PAIRING_ID_META, type DockBinding, type DockGrantState } from "@tineira/apc-protocol";
import { directGrantGate, dockGrantGate, pairWithHub } from "../src/index.ts";

const HUB = "https://dock.test";
const BODY = { ticket: "t".repeat(40), agent: "ag_1a2b3c4d", app: { name: "Orders", origin: "https://orders.test" }, mcp_url: "https://orders.test/mcp/abc", pairing_code: "K7M4P2" };
const ID = "pr_0123456789abcdef0123456789abcdef";
const OTHER = "pr_fedcba9876543210fedcba9876543210";
const ACK = { ok: true, pairing_id: ID, status: "pending", agent: { name: "Claude via dock", icon: null }, pairing_code: "required" };
const hub = (body: unknown) => ({ fetch: (async () => Response.json(body)) as typeof fetch });

test("pairWithHub: binding is pairing_id when declared, null from a hub that does not bind", async () => {
  assert.deepEqual(await pairWithHub(HUB, BODY, hub({ ...ACK, binding: "pairing_id" })), { ok: true, pairing_id: ID, status: "pending", agent: { name: "Claude via dock", icon: null }, binding: "pairing_id" });
  assert.deepEqual(await pairWithHub(HUB, BODY, hub({ ...ACK, pairing_id: "pr_1" })), { ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Claude via dock", icon: null }, binding: null });
});

test("pairWithHub: an unknown binding, a declared id out of form, or an id that is not printable ASCII is hub_refused", async () => {
  for (const [what, body] of [
    ["an unknown scheme", { ...ACK, binding: "hmac-v9" }],
    ["binding null", { ...ACK, binding: null }],
    ["a declared 48-bit id", { ...ACK, pairing_id: "pr_0123456789ab", binding: "pairing_id" }],
    ["a declared id with a space", { ...ACK, pairing_id: `${ID.slice(0, -1)} `, binding: "pairing_id" }],
    ["an id with a control character", { ...ACK, pairing_id: "pr_1\n" }],
    ["an id that is a number", { ...ACK, pairing_id: 7 }],
  ] as const) assert.deepEqual(await pairWithHub(HUB, BODY, hub(body)), { ok: false, error: "hub_refused" }, what);
});

const init = (meta?: Record<string, unknown>, id: number | undefined = 1) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", version: "0" }, ...(meta ? { _meta: meta } : {}) } });
const own = { [APC_PAIRING_ID_META]: ID, [APC_AGENT_META]: "ag_1a2b3c4d" };
const declared: DockBinding = { pairing_id: ID, agent: "ag_1a2b3c4d", declared: true };
const gate = (state: DockGrantState, message: unknown, binding: DockBinding = declared) => dockGrantGate(state, message, { host: "orders.test", binding });

test("M11: in handoff a declared grant commits only on its own pairing and agent; anything else is a 404 with the token", async () => {
  const ok = gate("handoff", init(own));
  assert.equal(ok.serve, true);
  assert.equal(ok.serve && ok.commits, true);
  for (const meta of [undefined, { [APC_PAIRING_ID_META]: OTHER, [APC_AGENT_META]: "ag_1a2b3c4d" }, { [APC_PAIRING_ID_META]: ID, [APC_AGENT_META]: "ag_ffffffff" }, { [APC_PAIRING_ID_META]: 1 }, { [APC_PAIRING_ID_META]: ID.toUpperCase() }]) {
    const g = gate("handoff", init(meta));
    assert.equal(g.serve, false, JSON.stringify(meta));
    if (g.serve) continue;
    assert.equal(g.response.status, 404);
    assert.deepEqual(await g.response.json(), { error: "pairing_mismatch" });
  }
});

test("M11: live and dormant refuse another pairing and serve a missing value; revoked, ended and in flight answer first", async () => {
  for (const state of ["live", "dormant"] as const) {
    assert.equal(gate(state, init({ [APC_PAIRING_ID_META]: OTHER })).serve, false, state);
    assert.equal(gate(state, init()).serve, true, `${state}: a hub rolled back to 0.11 sends none`);
    assert.equal(gate(state, init(own)).serve, true, state);
  }
  const revoked = gate("revoked", init({ [APC_PAIRING_ID_META]: OTHER }));
  assert.equal(!revoked.serve && revoked.answer.kind, "revoked");
  for (const state of ["ended", "in_flight"] as const) {
    const g = gate(state, init({ [APC_PAIRING_ID_META]: OTHER }));
    assert.equal(!g.serve && g.answer.kind, "not_found");
    assert.deepEqual(!g.serve && (await g.response.json()), { error: "not_found" }, "the state's own 404, not the binding's");
  }
  assert.equal(dockGrantGate("live", init(), { host: "orders.test", binding: declared, multiHub: true }).serve, false, "several hubs: missing is a mismatch");
});

test("M11: every initialize in the request counts: a batch, and one without an id", () => {
  assert.equal(gate("live", [{ jsonrpc: "2.0", id: 2, method: "ping" }, init({ [APC_PAIRING_ID_META]: OTHER })]).serve, false, "a batch");
  assert.equal(gate("live", init({ [APC_PAIRING_ID_META]: OTHER }, undefined)).serve, false, "no id");
  assert.equal(gate("handoff", init(undefined, undefined)).serve, false, "no id, no value, declared, handoff");
  assert.equal(gate("live", { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { [APC_PAIRING_ID_META]: OTHER } } }).serve, true, "only initialize is gated on the binding");
});

test("M11: a legacy grant (no id stored, not declared) is checked on its agent alone", () => {
  const legacy: DockBinding = { pairing_id: null, agent: "ag_1a2b3c4d", declared: false };
  assert.equal(gate("live", init(own), legacy).serve, true);
  assert.equal(gate("live", init(), legacy).serve, true);
  assert.equal(gate("handoff", init(), legacy).serve, true, "a 0.11 hub's introduction still commits");
  assert.equal(gate("live", init({ [APC_PAIRING_ID_META]: ID, [APC_AGENT_META]: "ag_99999999" }), legacy).serve, false);
});

test("M12: on a grant that is not a Dock grant, an initialize with either key is a 404, any value; without one, nothing", async () => {
  for (const meta of [{ [APC_PAIRING_ID_META]: ID }, { [APC_AGENT_META]: "ag_1" }, { [APC_PAIRING_ID_META]: null }, { [APC_PAIRING_ID_META]: [] }]) {
    const r = directGrantGate(init(meta));
    assert.equal(r?.status, 404, JSON.stringify(meta));
    assert.deepEqual(await r?.json(), { error: "pairing_mismatch" });
  }
  assert.equal(directGrantGate([{ jsonrpc: "2.0", id: 1, method: "ping" }, init({ [APC_PAIRING_ID_META]: ID }, undefined)])?.status, 404, "a batch, without an id");
  assert.equal(directGrantGate(init()), null, "the agent's own initialize");
  assert.equal(directGrantGate(init({ "apc.tineira.com/agent_client": "x" })), null);
  assert.equal(directGrantGate({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", _meta: { [APC_PAIRING_ID_META]: ID } } }), null, "only an introduction");
  assert.equal(directGrantGate(null), null);
});
