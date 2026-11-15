import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKET_TTL_MS } from "@tineira/apc-protocol";
import { standInHub, type StandInHub, type StandInHubMode } from "../src/hub.ts";

const AGENT = "ag_owner";
const ORIGIN = "https://shop.test";
const post = (hub: StandInHub, path: string, body: unknown) => hub.fetch(`${hub.origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const pairBody = (ticket: string, agent = AGENT, origin = ORIGIN) => ({
  ticket, agent, app: { name: "Shop", origin }, mcp_url: `${origin}/mcp/grant`, pairing_code: "K7M4P2",
});
async function connectTicket(hub: StandInHub) {
  const before = hub.pairings.length;
  const requested = await post(hub, "/apc/connect", { ticket: hub.ticket(AGENT), agent: AGENT, app: { origin: ORIGIN } });
  assert.equal(requested.status, 200);
  assert.deepEqual(await requested.json(), { ok: true, status: "connect_requested" });
  assert.equal(hub.pairings.length, before, "Connect waits for the owner without pairing");
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

const manifest = (origin = ORIGIN) => ({ name: "Shop", origin, standard: "0.12.0", profiles: ["dock"], mcp: { path: "/mcp/" }, dock_connect: `${origin}/connect/dock` });
const connectBody = (ticket: string) => ({ ticket, agent: AGENT, app: { origin: ORIGIN } });
async function refusal(response: Response, error: string) {
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error });
}

test("Connect without dock_connect answers apc_json_invalid and preserves the drop ticket", async () => {
  let missing = true;
  const hub = standInHub({ app: async () => {
    const { dock_connect, ...rest } = manifest();
    return Response.json(missing ? rest : { ...rest, dock_connect });
  } });
  const body = connectBody(hub.ticket(AGENT));
  await refusal(await post(hub, "/apc/connect", body), "apc_json_invalid");
  assert.equal(hub.connects.length, 0);
  missing = false;
  assert.equal((await post(hub, "/apc/connect", body)).status, 200);
});

for (const path of ["/apc/connect", "/apc/confirm"]) {
  test(`${path} refuses a live connect ticket before agent lookup and leaves it usable for pairing`, async () => {
    const hub = standInHub();
    const ticket = await connectTicket(hub);
    await refusal(await post(hub, path, { ...pairBody(ticket), agent: "ag_other" }), "ticket_not_for_pairing");
    assert.equal((await post(hub, "/apc/pair", pairBody(ticket))).status, 200);
  });
  test(`${path} answers ticket_expired for an expired connect ticket`, async () => {
    let now = 0;
    const hub = standInHub({ now: () => now });
    const ticket = await connectTicket(hub);
    now += TICKET_TTL_MS;
    await refusal(await post(hub, path, pairBody(ticket)), "ticket_expired");
  });
}

test("Connect validates app input before looking up or spending a ticket", async () => {
  let reads = 0;
  const hub = standInHub({ app: async () => { reads++; return Response.json(manifest()); } });
  const body = connectBody(hub.ticket(AGENT));
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ agent: "" }, "invalid"], [{ agent: "bad agent" }, "invalid"], [{ agent: "a".repeat(129) }, "invalid"],
    [{ app: undefined }, "invalid"], [{ app: { origin: 42 } }, "invalid"], [{ app: { origin: "" } }, "invalid"],
    [{ app: { origin: "not a URL" } }, "invalid"], [{ app: { origin: `${ORIGIN}/` } }, "app_not_allowed"],
    [{ app: { origin: `${ORIGIN}/path` } }, "app_not_allowed"], [{ app: { origin: "http://shop.test" } }, "https_required"],
    [{ app: { origin: "http://localhost" } }, "https_required"], [{ app: { origin: "ftp://shop.test" } }, "app_not_allowed"],
    [{ reader: false }, "invalid"], [{ label: "Shop" }, "invalid"],
  ];
  for (const [change, error] of cases) {
    await refusal(await post(hub, "/apc/connect", { ...body, ...change }), error);
    await refusal(await post(hub, "/apc/connect", { ...body, ticket: "unknown", ...change }), error);
  }
  assert.equal(reads, 0);
  assert.equal(hub.connects.length, 0);
  assert.equal((await post(hub, "/apc/connect", body)).status, 200);
  assert.equal(reads, 1);
});

test("Connect allows HTTP loopback only with explicit development mode", async () => {
  const hub = standInHub({ development: true });
  for (const origin of ["http://localhost", "http://127.0.0.1:8080", "http://[::1]"]) {
    assert.equal((await post(hub, "/apc/connect", { ...connectBody(hub.ticket(AGENT)), app: { origin } })).status, 200);
  }
  await refusal(await post(hub, "/apc/connect", { ...connectBody(hub.ticket(AGENT)), app: { origin: "http://shop.test" } }), "https_required");
});

test("Connect rechecks after awaiting the manifest: one drop ticket cannot mint two requests", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const bothReading = new Promise<void>((resolve) => { entered = resolve; });
  let reads = 0;
  const hub = standInHub({ app: async () => {
    if (++reads === 2) entered();
    await held;
    return Response.json(manifest());
  } });
  const body = connectBody(hub.ticket(AGENT));
  const first = post(hub, "/apc/connect", body);
  const second = post(hub, "/apc/connect", body);
  await bothReading;
  release();
  const answers = await Promise.all([first, second]);
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 400]);
  await refusal(answers.find((r) => r.status === 400)!, "ticket_expired");
  assert.equal(hub.connects.length, 1);
});

test("Connect rechecks ticket expiry after awaiting the manifest", async () => {
  let now = 0;
  const hub = standInHub({ now: () => now, app: async () => {
    now += TICKET_TTL_MS;
    return Response.json(manifest());
  } });
  await refusal(await post(hub, "/apc/connect", connectBody(hub.ticket(AGENT))), "ticket_expired");
  assert.equal(hub.connects.length, 0);
});

test("Pair checks name, ticket kind, expiry and binding before the missing origin or code", async () => {
  let now = 0;
  const hub = standInHub({ now: () => now });
  const drop = hub.ticket(AGENT);
  for (const origin of [undefined, 42, "not a URL"]) {
    await refusal(await post(hub, "/apc/pair", { ...pairBody(drop), app: { name: "Shop", origin } }), "ticket_not_for_pairing");
    await refusal(await post(hub, "/apc/pair", { ...pairBody("unknown"), app: { name: "Shop", origin } }), "ticket_expired");
  }
  const ticket = await connectTicket(hub);
  for (const origin of [undefined, 42, "not a URL"]) {
    await refusal(await post(hub, "/apc/pair", { ...pairBody(ticket), app: { name: "Shop", origin }, pairing_code: undefined }), "ticket_origin_mismatch");
  }
  for (const name of ["   ", " ".repeat(40) + "Shop"]) {
    await refusal(await post(hub, "/apc/pair", { ...pairBody(ticket), app: { name, origin: ORIGIN } }), "app_not_allowed");
    await refusal(await post(hub, "/apc/pair", { ...pairBody(drop), app: { name, origin: ORIGIN } }), "app_not_allowed");
  }
  assert.equal((await post(hub, "/apc/pair", { ...pairBody(ticket), app: { name: " Shop ", origin: ORIGIN } })).status, 200);
  const expired = await connectTicket(hub);
  now += TICKET_TTL_MS;
  await refusal(await post(hub, "/apc/pair", { ...pairBody(expired), app: { name: "Shop" } }), "ticket_expired");
});

for (const legacy of [undefined, "0.12"] as const) {
  test(`Pair requires a code by default (${legacy ?? "0.13"}), with explicit pre-0.9 opt-in only`, async () => {
    const hub = standInHub({ legacy });
    const ticket = legacy ? hub.ticket(AGENT) : await connectTicket(hub);
    await refusal(await post(hub, "/apc/pair", { ...pairBody(ticket), pairing_code: undefined }), "pairing_code_required");
    assert.equal(hub.pairings.length, 0);
    assert.equal((await post(hub, "/apc/pair", pairBody(ticket))).status, 200);
    const oldHub = standInHub({ legacy, pairingCode: "when_sent" });
    const oldTicket = legacy ? oldHub.ticket(AGENT) : await connectTicket(oldHub);
    assert.equal((await post(oldHub, "/apc/pair", { ...pairBody(oldTicket), pairing_code: undefined })).status, 200);
    assert.equal(oldHub.pairings[0]!.pairing_code, null);
  });
}

for (const mcpUrl of ["not a URL", "https://other.test/mcp/grant", "https://user:pass@shop.test/mcp/grant"]) {
  test(`Pair refuses disallowed mcp_url ${mcpUrl} after spending the connect ticket`, async () => {
    const hub = standInHub();
    const ticket = await connectTicket(hub);
    await refusal(await post(hub, "/apc/pair", { ...pairBody(ticket), mcp_url: mcpUrl }), "app_not_allowed");
    assert.equal(hub.pairings.length, 0);
    await refusal(await post(hub, "/apc/pair", pairBody(ticket)), "ticket_expired");
  });
}

test("Pair checks HTTPS after code validation and ticket consumption, as the reference appVerdict does", async () => {
  const options = { development: true };
  const hub = standInHub(options);
  const origin = "http://localhost";
  assert.equal((await post(hub, "/apc/connect", { ...connectBody(hub.ticket(AGENT)), app: { origin } })).status, 200);
  const approved = await hub.approveConnect(AGENT);
  assert.ok(approved.ticket);
  options.development = false;
  const body = pairBody(approved.ticket, AGENT, origin);
  await refusal(await post(hub, "/apc/pair", { ...body, pairing_code: null }), "invalid_pairing_code");
  await refusal(await post(hub, "/apc/pair", body), "https_required");
  await refusal(await post(hub, "/apc/pair", body), "ticket_expired");
});

test("Pair deliberately accepts an uncovered same-origin mcp_url for M12's app-side isolation probe", async () => {
  const hub = standInHub({ app: async () => Response.json(manifest()) });
  const ticket = await connectTicket(hub);
  assert.equal((await post(hub, "/apc/pair", { ...pairBody(ticket), mcp_url: `${ORIGIN}/direct/uncovered` })).status, 200);
});

const faults: StandInHubMode[] = ["no_ack", "redirect", "error_500", "status_3xx", "opaque_redirect", "redirected", "slow_body", "length_over_cap", "length_not_digits", "body_over_cap", "slow_headers", "slow_headers_then_body", "slow_headers_then_stall"];
for (const mode of faults) {
  test(`Connect fault ${mode} leaves the ticket usable and creates no request`, async () => {
    let reads = 0;
    const hub = standInHub({ app: async () => { reads++; return Response.json(manifest()); } });
    const body = connectBody(hub.ticket(AGENT));
    hub.mode = mode;
    hub.delayMs = 0;
    const pending = post(hub, "/apc/connect", body);
    await new Promise<void>((resolve) => setImmediate(resolve));
    hub.releaseStalls();
    const response = await pending;
    hub.releaseStalls();
    await response.body?.cancel();
    assert.equal(reads, 0, "a simulated fault does not contact the app");
    assert.equal(hub.connects.length, 0);
    hub.mode = "ack";
    assert.equal((await post(hub, "/apc/connect", body)).status, 200);
    assert.equal(hub.connects.length, 1);
    await refusal(await post(hub, "/apc/connect", body), "ticket_expired");
  });
}

for (const mode of ["length_mismatch", "ack_with_length"] as const) {
  test(`Connect's accepted ${mode} response creates one request and spends the ticket`, async () => {
    const hub = standInHub();
    hub.mode = mode;
    const body = connectBody(hub.ticket(AGENT));
    const response = await post(hub, "/apc/connect", body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: "connect_requested" });
    assert.equal(hub.connects.length, 1);
    await refusal(await post(hub, "/apc/connect", body), "ticket_expired");
  });
}
