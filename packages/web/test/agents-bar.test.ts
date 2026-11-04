import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLabels, barCanCollapse, pathLabel, readingSummary, REVOKE_CONFIRM_MS, showDockHint, type BarAgent } from "../src/agents-bar.ts";
import { connectPrompt, directAgentStatus } from "../src/direct-agents.ts";

const direct: BarAgent = { id: "g_d", name: "Claude", state: "idle", paths: ["direct"] };
const dock: BarAgent = { id: "g_k", name: "Gemini via dock", state: "busy", paths: ["dock"] };

test("each agent shows which path it came by; a linked agent shows both", () => {
  assert.equal(pathLabel(["direct"])?.text, "direct");
  assert.equal(pathLabel(["dock"])?.text, "via dock");
  assert.equal(pathLabel(["direct", "dock"])?.text, "direct + dock");
  assert.match(pathLabel(["dock", "direct"])!.title, /Revoke cuts both/);
  assert.equal(pathLabel(undefined), null, "an app that does not say shows nothing");
  assert.match(agentLabels({ ...direct, paths: ["direct", "dock"] }).revoke, /directly or through the dock/);
});

test("the bar is always in full with a Direct agent; with only dock agents it may collapse, to who is reading", () => {
  assert.equal(barCanCollapse([direct, dock]), false, "any agent that came directly keeps the bar in full");
  assert.equal(barCanCollapse([{ ...direct, paths: ["direct", "dock"] }]), false, "a linked agent came directly too");
  assert.equal(barCanCollapse([dock]), true);
  assert.equal(barCanCollapse([{ ...dock, paths: undefined }]), false, "an app that does not say keeps the bar as it was");
  assert.equal(barCanCollapse([]), false);
  assert.equal(readingSummary([dock, { ...dock, id: "x", name: "Codex", state: "off" }]), "Gemini via dock is reading");
  assert.equal(readingSummary([dock, { ...dock, id: "y", name: "Codex" }, { ...dock, id: "z", name: "Grok" }]), "Gemini via dock, Codex and Grok are reading");
  assert.equal(readingSummary([{ ...dock, state: "off" }]), "No agent is reading");
});

test("the dock hint: for a connected Direct-only agent, on by default, until dismissed", () => {
  assert.equal(showDockHint([direct], { enabled: true, dismissed: false }), true);
  assert.equal(showDockHint([direct], { enabled: true, dismissed: true }), false, "once dismissed, never again in this browser");
  assert.equal(showDockHint([direct], { enabled: false, dismissed: false }), false, "an app can turn it off");
  assert.equal(showDockHint([{ ...direct, state: "off" }], { enabled: true, dismissed: false }), false, "not before the agent connects");
  assert.equal(showDockHint([{ ...direct, paths: ["direct", "dock"] }, dock], { enabled: true, dismissed: false }), false, "an agent already on the dock needs no hint");
});

test("the connect instructions: the URL, and a prompt that names the app and keeps the URL out of a browser", () => {
  const url = "https://signals.example/mcp/abc/def";
  const prompt = connectPrompt(url, "Signals");
  assert.match(prompt, /named "Signals"/);
  assert.ok(prompt.includes(url));
  assert.match(prompt, /Do not open the URL in a browser/);
  assert.equal(directAgentStatus({ id: "g", name: "A", url, connected: false }), "not connected yet");
  assert.equal(directAgentStatus({ id: "g", name: "A", url, connected: true, client: "claude-code", linked: true }), "connected as claude-code, also through your dock");
});

const agent: BarAgent = { id: "g_1", name: "Claude via dock", state: "idle" };

test("every agent in the bar can be revoked, and the button says what it does (APC 0.2)", () => {
  const labels = agentLabels(agent);
  assert.match(labels.revoke, /^Revoke Claude via dock: it can no longer read this app, at once\./);
  assert.equal(labels.revokeArmed, "Click again to revoke Claude via dock.");
  // With or without a pin, connected or not.
  assert.equal(agentLabels({ ...agent, state: "off", pin: { label: "cus_0001", seen: false, here: true } }).revoke, labels.revoke);
  assert.ok(REVOKE_CONFIRM_MS >= 2000, "the second click has time to come");
});

test("on mobile the bar never collapses, whatever the agents' paths (APC 0.6)", () => {
  assert.equal(barCanCollapse([dock], true), false, "a bar of dock agents only can collapse on a desktop, never on a phone");
  assert.equal(barCanCollapse([dock, { ...dock, id: "k2" }], true), false);
  assert.equal(barCanCollapse([direct], true), false);
  assert.equal(barCanCollapse([dock], false), true, "the desktop rule is unchanged");
  assert.equal(barCanCollapse([dock]), true, "mobile is off by default");
});
