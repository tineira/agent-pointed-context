import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLabels, REVOKE_CONFIRM_MS, type BarAgent } from "../src/agents-bar.ts";

const agent: BarAgent = { id: "g_1", name: "Claude via dock", state: "idle" };

test("every agent in the bar can be revoked, and the button says what it does (APC 0.2)", () => {
  const labels = agentLabels(agent);
  assert.match(labels.revoke, /^Revoke Claude via dock: it can no longer read this app, at once\./);
  assert.equal(labels.revokeArmed, "Click again to revoke Claude via dock.");
  // With or without a pin, connected or not.
  assert.equal(agentLabels({ ...agent, state: "off", pin: { label: "cus_0001", seen: false, here: true } }).revoke, labels.revoke);
  assert.ok(REVOKE_CONFIRM_MS >= 2000, "the second click has time to come");
});
