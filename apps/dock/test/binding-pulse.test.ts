/**
 * The binding end to end, the reference hub and the real Pulse (APC 0.12, TIN-910): Pulse's own pairing goes live
 * through the binding, and a Direct grant of the same Pulse handed to /apc/pair never does (M12).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAIRING_ENDED_ERROR } from "@tineira/apc-protocol";
import { PULSE, SID, world } from "./hostile-world.ts";

test("Pulse's own pairing goes live through the binding; Pulse's Direct grant handed to /apc/pair never does (M12)", async (t) => {
  const w = await world(t);
  await w.pairPulse();
  const line = await w.pairingOf(PULSE);
  assert.equal(line.status, "paired", "the honest pairing is live");
  // The attack: a Direct agent of the same Pulse, sent to /apc/pair as Pulse with a code the sender chose.
  const direct = await w.pulse.addAgentGrant();
  const agentId = (await w.agent()).id as string;
  await w.hub.decide(line.id, "unpair");
  const { ticket } = await w.hub.ticket(agentId);
  const answer = await w.hub.pair({ ticket, agent: agentId, app: { name: "Pulse", origin: PULSE }, mcp_url: `${PULSE}/mcp/${SID}/${direct.secret}`, pairing_code: "K7M4P2" });
  assert.equal(answer.ok, true, "the hub cannot tell: it takes the request");
  assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve", "K7M4P2"), { ok: false, error: PAIRING_ENDED_ERROR }, "Pulse refuses the hub's introduction on a Direct grant");
  const ended = await w.pairingOf(PULSE);
  assert.equal(ended.status, "ended");
  assert.equal(ended.ended_reason, "pairing_mismatch", "a verified app's exact token is kept, for the dock's line");
  // The Direct agent is untouched: its own initialize is served.
  const own = await w.pulse.fetch(new Request(`${PULSE}/mcp/${SID}/${direct.secret}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } }) }));
  assert.equal(own.status, 200);
});
