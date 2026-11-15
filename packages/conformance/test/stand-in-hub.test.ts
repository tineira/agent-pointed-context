import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKET_TTL_MS } from "@tineira/apc-protocol";
import { standInHub, type StandInHub } from "../src/hub.ts";

const AGENT = "ag_owner";
const ORIGIN = "https://shop.test";
const post = (hub: StandInHub, path: string, body: unknown) => hub.fetch(`${hub.origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const pairBody = (ticket: string, agent = AGENT, origin = ORIGIN) => ({
  ticket, agent, app: { name: "Shop", origin }, mcp_url: `${origin}/mcp/grant`, pairing_code: "K7M4P2",
});
async function connectTicket(hub: StandInHub) {
  const requested = await post(hub, "/apc/connect", { ticket: hub.ticket(AGENT), agent: AGENT, app: { origin: ORIGIN } });
  assert.equal(requested.status, 200);
  assert.deepEqual(await requested.json(), { ok: true, status: "connect_requested" });
  assert.equal(hub.pairings.length, 0, "Connect waits for the owner without pairing");
  const approved = await hub.approveConnect(AGENT);
  assert.equal(approved.ok, true);
  assert.ok(approved.ticket);
  return approved.ticket;
}

test("stand-in H9 (P2): /apc/pair refuses a drop ticket without spending it on /apc/connect", async () => {
  const hub = standInHub();
  const ticket = hub.ticket(AGENT);
  const refused = await post(hub, "/apc/pair", pairBody(ticket));
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { ok: false, error: "ticket_not_for_pairing" });
  assert.equal(hub.pairings.length, 0);
  const requested = await post(hub, "/apc/connect", { ticket, agent: AGENT, app: { origin: ORIGIN } });
  assert.equal(requested.status, 200);
  assert.deepEqual(await requested.json(), { ok: true, status: "connect_requested" });
  assert.equal(hub.connects.length, 1);
});

for (const mismatch of ["agent", "origin"] as const) {
  test(`stand-in H9 (P3): a connect ticket for another ${mismatch} is ticket_origin_mismatch and stays usable`, async () => {
    const hub = standInHub();
    const ticket = await connectTicket(hub);
    const refused = await post(hub, "/apc/pair", pairBody(ticket, mismatch === "agent" ? "ag_other" : AGENT, mismatch === "origin" ? "https://other.test" : ORIGIN));
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { ok: false, error: "ticket_origin_mismatch" });
    assert.equal(hub.pairings.length, 0);
    const paired = await post(hub, "/apc/pair", pairBody(ticket));
    assert.equal(paired.status, 200);
    assert.equal((await paired.json()).ok, true);
    assert.equal(hub.pairings.length, 1);
    const reused = await post(hub, "/apc/pair", pairBody(ticket));
    assert.equal(reused.status, 400);
    assert.deepEqual(await reused.json(), { ok: false, error: "ticket_expired" });
  });
}

test("stand-in validates the code before spending a bound connect ticket", async () => {
  const hub = standInHub();
  const ticket = await connectTicket(hub);
  const refused = await post(hub, "/apc/pair", { ...pairBody(ticket), pairing_code: null });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { ok: false, error: "invalid_pairing_code" });
  assert.equal((await post(hub, "/apc/pair", pairBody(ticket))).status, 200);
});

test("stand-in answers ticket_expired before checking an expired connect ticket's agent or origin", async () => {
  let now = 0;
  const hub = standInHub({ now: () => now });
  const ticket = await connectTicket(hub);
  now += TICKET_TTL_MS;
  const refused = await post(hub, "/apc/pair", pairBody(ticket, "ag_other", "https://other.test"));
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { ok: false, error: "ticket_expired" });
  assert.equal(hub.pairings.length, 0);
});

test("only explicit legacy 0.12 mode has exact 404 Connect fallback and pairs with a drop ticket", async () => {
  const hub = standInHub({ legacy: "0.12" });
  const ticket = hub.ticket(AGENT);
  const requested = await post(hub, "/apc/connect", { ticket, agent: AGENT, app: { origin: ORIGIN } });
  assert.equal(requested.status, 404);
  assert.equal(await requested.text(), '{"error":"not_found"}');
  assert.equal(hub.connects.length, 0);
  const paired = await post(hub, "/apc/pair", pairBody(ticket));
  assert.equal(paired.status, 200);
  assert.equal((await paired.json()).ok, true);
});
