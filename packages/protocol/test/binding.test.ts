import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APC_AGENT_META,
  APC_PAIRING_ID_META,
  DOCK_GRANT_STATES,
  bindingVerdict,
  declaredBinding,
  dockGrantAnswer,
  hasBindingKey,
  isInitializeMessage,
  readBindingKey,
  rpcMessages,
  type DockBinding,
} from "../src/index.ts";

const ID = "pr_0123456789abcdef0123456789abcdef";
const OTHER = "pr_fedcba9876543210fedcba9876543210";
const init = (meta?: unknown) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", ...(meta === undefined ? {} : { _meta: meta }) } });
const bound: DockBinding = { pairing_id: ID, agent: "ag_1a2b3c4d", declared: true };

test("readBindingKey: absent, invalid and valid are three outcomes", () => {
  assert.deepEqual(readBindingKey(init(), APC_PAIRING_ID_META), { kind: "absent" });
  assert.deepEqual(readBindingKey({ method: "initialize", params: null }, APC_PAIRING_ID_META), { kind: "absent" });
  assert.deepEqual(readBindingKey(init({ other: 1 }), APC_PAIRING_ID_META), { kind: "absent" });
  assert.deepEqual(readBindingKey(init(Object.create({ [APC_PAIRING_ID_META]: ID })), APC_PAIRING_ID_META), { kind: "absent" }, "only an own property counts");
  for (const junk of [7, ["x"], { a: 1 }, "", null, "x".repeat(129), "has space", "tab\t"]) {
    assert.deepEqual(readBindingKey(init({ [APC_PAIRING_ID_META]: junk }), APC_PAIRING_ID_META), { kind: "invalid" }, `pairing_id ${JSON.stringify(junk)}`);
    assert.deepEqual(readBindingKey(init({ [APC_AGENT_META]: junk }), APC_AGENT_META), { kind: "invalid" }, `agent ${JSON.stringify(junk)}`);
  }
  assert.deepEqual(readBindingKey(init({ [APC_PAIRING_ID_META]: ID }), APC_PAIRING_ID_META), { kind: "valid", value: ID });
  assert.deepEqual(readBindingKey(init({ [APC_AGENT_META]: "ag_1a2b3c4d" }), APC_AGENT_META), { kind: "valid", value: "ag_1a2b3c4d" });
});

test("hasBindingKey keys on presence, whatever the value", () => {
  assert.equal(hasBindingKey(init()), false);
  assert.equal(hasBindingKey(init({ "apc.tineira.com/agent_client": "x" })), false);
  assert.equal(hasBindingKey(init({ [APC_PAIRING_ID_META]: 7 })), true);
  assert.equal(hasBindingKey(init({ [APC_AGENT_META]: null })), true);
});

test("rpcMessages and isInitializeMessage: a batch element by element, an initialize without an id", () => {
  assert.equal(rpcMessages([1, 2]).length, 2);
  assert.deepEqual(rpcMessages({ a: 1 }), [{ a: 1 }]);
  assert.equal(isInitializeMessage({ method: "initialize" }), true);
  assert.equal(isInitializeMessage({ method: "ping", id: 1 }), false);
  assert.equal(isInitializeMessage([{ method: "initialize" }]), false);
});

test("bindingVerdict: a declared grant holds only on its own pairing and agent", () => {
  const ok = init({ [APC_PAIRING_ID_META]: ID, [APC_AGENT_META]: "ag_1a2b3c4d" });
  for (const state of ["handoff", "live", "dormant"] as const) assert.equal(bindingVerdict(ok, bound, state), "holds", state);
  const wrong = [
    init({ [APC_PAIRING_ID_META]: OTHER }),
    init({ [APC_PAIRING_ID_META]: ID.slice(0, -1) + "0" }),
    init({ [APC_PAIRING_ID_META]: ID.slice(0, -1) }),
    init({ [APC_PAIRING_ID_META]: `${ID}0` }),
    init({ [APC_PAIRING_ID_META]: ID.toUpperCase() }),
    init({ [APC_PAIRING_ID_META]: 7 }),
    init({ [APC_PAIRING_ID_META]: ID, [APC_AGENT_META]: "ag_ffffffff" }),
    init({ [APC_PAIRING_ID_META]: ID, [APC_AGENT_META]: [] }),
  ];
  for (const state of ["handoff", "live", "dormant"] as const) for (const m of wrong) assert.equal(bindingVerdict(m, bound, state), "mismatch", `${state} ${JSON.stringify(m.params)}`);
  // Absent: a mismatch only in handoff on a declared grant (or in every state for an app with several hubs).
  assert.equal(bindingVerdict(init(), bound, "handoff"), "mismatch");
  assert.equal(bindingVerdict(init(), bound, "live"), "holds");
  assert.equal(bindingVerdict(init(), bound, "dormant"), "holds");
  assert.equal(bindingVerdict(init(), bound, "live", { multiHub: true }), "mismatch");
  assert.equal(bindingVerdict(init({ [APC_AGENT_META]: "ag_1a2b3c4d" }), bound, "handoff"), "mismatch", "the agent alone does not commit a declared grant");
});

test("bindingVerdict: a legacy grant is mismatch-only, on its stored id or, without one, on its agent", () => {
  const legacy: DockBinding = { pairing_id: "pr_0123456789ab", agent: "ag_1a2b3c4d", declared: false };
  assert.equal(bindingVerdict(init(), legacy, "handoff"), "holds", "a 0.11 hub sends neither key");
  assert.equal(bindingVerdict(init({ [APC_PAIRING_ID_META]: "pr_0123456789ab", [APC_AGENT_META]: "ag_1a2b3c4d" }), legacy, "live"), "holds");
  assert.equal(bindingVerdict(init({ [APC_PAIRING_ID_META]: ID, [APC_AGENT_META]: "ag_1a2b3c4d" }), legacy, "live"), "mismatch", "a new 128-bit id never equals a legacy one");
  const noId: DockBinding = { pairing_id: null, agent: "ag_1a2b3c4d", declared: false };
  assert.equal(bindingVerdict(init({ [APC_PAIRING_ID_META]: ID, [APC_AGENT_META]: "ag_1a2b3c4d" }), noId, "live"), "holds");
  assert.equal(bindingVerdict(init({ [APC_PAIRING_ID_META]: ID, [APC_AGENT_META]: "ag_99999999" }), noId, "live"), "mismatch", "another agent's pairing");
});

test("dockGrantAnswer: a mismatched initialize is a 404 where it would be served; other states answer first", () => {
  for (const state of DOCK_GRANT_STATES) {
    const answer = dockGrantAnswer(state, "initialize", { binding: "mismatch" });
    if (state === "revoked") assert.deepEqual(answer, { kind: "revoked" });
    else assert.deepEqual(answer, { kind: "not_found" }, state);
    assert.deepEqual(dockGrantAnswer(state, "ping", { binding: "mismatch" }), dockGrantAnswer(state, "ping"), "only initialize is gated on the binding");
  }
  assert.deepEqual(dockGrantAnswer("handoff", "initialize", { binding: "holds" }), { kind: "serve", commits: true, wakes: false });
});

test("declaredBinding: none, pairing_id, and anything else refused", () => {
  assert.equal(declaredBinding({ pairing_id: "pr_1" }), null);
  assert.equal(declaredBinding({ pairing_id: ID, binding: "pairing_id" }), "pairing_id");
  assert.equal(declaredBinding({ pairing_id: "pr_0123456789ab", binding: "pairing_id" }), "refused", "a declared id under 128 bits");
  assert.equal(declaredBinding({ pairing_id: ID, binding: "hmac-v9" }), "refused");
  assert.equal(declaredBinding({ pairing_id: ID, binding: null }), "refused");
  assert.equal(declaredBinding({ pairing_id: ID, binding: ["pairing_id"] }), "refused");
});
