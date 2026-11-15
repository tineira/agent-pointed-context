#!/usr/bin/env node
/** APC 0.13 hub boundary in the same real workerd setup as dock-pairing.mjs; never production. */
import { startWorkerd } from "./lib/dock-workerd.mjs";

const DOCK = "https://apc.tineira.com";
const PULSE = "https://pulse.apc.tineira.com";
const runtime = await startWorkerd({ connectManifestFixture: true });
const jar = new Map();
let dock;
let pulse;
let checks = 0;
let passed = false;
const must = (condition, message) => {
  if (!condition) throw new Error(message);
  checks++;
  console.log(`ok - ${message}`);
};
const call = async (url, body, extra = {}) => {
  const origin = new URL(url).origin;
  const headers = { "content-type": "application/json", origin, cookie: jar.get(origin) ?? "", ...extra };
  const response = await runtime.send(url, { method: body === undefined ? "GET" : "POST", headers, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: "manual" });
  for (const cookie of response.headers.getSetCookie()) jar.set(origin, cookie.split(";")[0]);
  return { status: response.status, body: await response.json().catch(() => null) };
};
try {
  const opened = await call(DOCK + "/api/dock/new", {});
  must(opened.status === 200, "a new victim dock opens in workerd");
  dock = `${DOCK}/api/d/${opened.body.did}`;
  const state = () => call(dock + "/state");
  const agent = (await state()).body.agents[0];
  const account = await call(PULSE + "/api/session", {});
  must(account.status === 200, "a real Pulse account opens in workerd");
  pulse = `${PULSE}/api/s/${account.body.sid}`;
  const dataset = (await call(pulse + "/dataset")).body;
  const target = { kind: "customer", id: dataset.customers[0].id };
  const dropTicket = (await call(`${dock}/agents/${agent.id}/ticket`, null)).body.ticket;
  const drop = { hub: DOCK, agent: agent.id, ticket: dropTicket, target };
  const consent = await call(pulse + "/hub/pair", drop);
  must(consent.body.error === "consent_required", "the real app account can obtain app consent for the victim's drop");
  const relay = await call(pulse + "/hub/pair", { ...drop, consent: consent.body.consent });
  must(relay.body?.error === "ticket_not_for_pairing", "the real app's relay of the victim drop ticket fails as ticket_not_for_pairing");
  must((await state()).body.agents[0].pairings.length === 0, "the relay creates no pending pairing");
  const requested = await call(DOCK + "/apc/connect", { ticket: dropTicket, agent: agent.id, app: { origin: PULSE } });
  must(requested.status === 200 && requested.body.status === "connect_requested", "the refused relay did not spend the drop: it requests Connect");
  const request = (await state()).body.connects[0];
  const approveUrl = `${dock}/connects/${request.id}/approve`;
  must((await call(approveUrl, null, { origin: "https://evil.example" })).status === 403, "cross-site Connect approval is refused");
  const approved = await call(approveUrl, {});
  must(approved.status === 200 && typeof approved.body.url === "string", "the owner alone obtains the connect URL");
  const url = new URL(approved.body.url);
  const fragment = JSON.parse(Buffer.from(url.hash.slice("#apc_connect=".length), "base64url").toString("utf8"));
  must(url.origin === PULSE && !url.search && fragment.agent === agent.id, "the connect URL uses the declared origin and a fragment only");
  const mismatch = await call(DOCK + "/apc/pair", { ticket: fragment.ticket, agent: agent.id, app: { name: "Other", origin: "https://signals.apc.tineira.com" }, mcp_url: "https://signals.apc.tineira.com/mcp/" + "a".repeat(32), pairing_code: "K7M4P2" });
  must(mismatch.status === 400 && mismatch.body.error === "ticket_origin_mismatch", "another origin cannot use the connect ticket in workerd");
  must((await call(approveUrl, {})).body.error === "not_found", "double approve cannot mint another ticket");
  // The app branch owns /connect/dock. Until it lands, its existing consent endpoint consumes the same fragment body.
  const handoff = { ...drop, ticket: fragment.ticket };
  const ownConsent = await call(pulse + "/hub/pair", handoff);
  const paired = await call(pulse + "/hub/pair", { ...handoff, consent: ownConsent.body.consent });
  must(paired.body.ok === true && paired.body.status === "pending", "the matching real app account pairs with the owner-issued connect ticket");
  const pending = (await state()).body.agents[0].pairings.find((p) => p.status === "pending");
  const code = paired.body.pairing?.code ?? ownConsent.body.pairing_code;
  const allowed = await call(`${dock}/pairings/${pending.id}`, { action: "approve", code });
  must(allowed.body.ok === true, "the existing pairing-code and binding steps complete in workerd");
  const reuse = await call(DOCK + "/apc/pair", { ticket: fragment.ticket, agent: agent.id, app: { name: "Pulse", origin: PULSE }, mcp_url: `${PULSE}/mcp/${account.body.sid}/${"a".repeat(32)}`, pairing_code: "K7M4P2" });
  must(reuse.status === 400 && reuse.body.error === "ticket_expired", "the connect ticket is single use in workerd");
  passed = true;
} catch (error) {
  console.error(`not ok - ${error instanceof Error ? error.message : "workerd check failed"}`);
} finally {
  if (dock) await call(dock + "/reset", null).catch(() => { passed = false; });
  if (pulse) await call(pulse + "/reset", null).catch(() => { passed = false; });
  await runtime.stop();
}
console.log(`APC 0.13 hub (workerd): ${passed ? "PASS" : "FAIL"} (${checks} checks completed)`);
process.exitCode = passed ? 0 : 1;
