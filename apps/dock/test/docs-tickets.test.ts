/**
 * The docs' complete Direct app with a bearer token (TIN-914): tickets-app.ts, shown whole at /docs/integrate,
 * passes the conformance suite in process, and the command line's checks over HTTP with a live token and a
 * revoked one. Its unknown and revoked tokens answer as the bearer binding says (APC 0.8).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runHttpConformance } from "@tineira/apc-conformance";
import { TicketsApp } from "../src/docs/examples/tickets-app.ts";
import { ticketsChecks, ticketsUnderTest } from "../src/docs/examples/tickets-conformance.ts";

for (const check of ticketsChecks()) test(check.name, check.run);

const ORIGIN = "https://tickets.test";
const session = { cookie: "tickets_session=owner", "content-type": "application/json", origin: ORIGIN };
const rpc = (token: string | null, method = "POST") =>
  new Request(`${ORIGIN}/mcp`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
    ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}),
  });

test("Tickets: no token or an unknown one is a plain 401; a revoked one is 401 with the RevokedAnswer, to every method", async () => {
  const { app } = ticketsUnderTest();
  for (const token of [null, "0123456789abcdef0123456789abcdef"]) {
    const r = await app.fetch(rpc(token));
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), token ? 'Bearer error="invalid_token"' : "Bearer");
    assert.notEqual(((await r.json()) as { error?: string }).error, "revoked");
  }
  const made = (await (await app.fetch(new Request(`${ORIGIN}/api/agents`, { method: "POST", headers: session, body: "{}" }))).json()) as { id: string; url: string; token: string };
  assert.equal(made.url, `${ORIGIN}/mcp`, "one URL for every grant");
  assert.equal((await app.fetch(rpc(made.token))).status, 200);
  await app.fetch(new Request(`${ORIGIN}/api/agents/${made.id}/revoke`, { method: "POST", headers: session, body: "{}" }));
  for (const method of ["POST", "GET", "DELETE"]) {
    const r = await app.fetch(rpc(made.token, method));
    assert.equal(r.status, 401, method);
    assert.equal(r.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
    const body = (await r.json()) as { error: string; revoked_by: string };
    assert.deepEqual([body.error, body.revoked_by], ["revoked", "tickets.test"], method);
  }
});

test("Tickets passes the command line's checks: a live bearer grant, then the same token revoked", async () => {
  const { app } = ticketsUnderTest();
  const made = (await (await app.fetch(new Request(`${ORIGIN}/api/agents`, { method: "POST", headers: session, body: "{}" }))).json()) as { id: string; url: string; token: string };
  const fetch = (request: Request) => app.fetch(request);
  const live = await runHttpConformance({ origin: ORIGIN, grant: made.url, bearer: made.token, fetch });
  assert.equal(live.failed, 0, JSON.stringify(live.results.filter((r) => r.status === "fail")));
  await app.fetch(new Request(`${ORIGIN}/api/agents/${made.id}/revoke`, { method: "POST", headers: session, body: "{}" }));
  const revoked = await runHttpConformance({ origin: ORIGIN, revoked: made.url, revokedBearer: made.token, fetch });
  assert.equal(revoked.failed, 0, JSON.stringify(revoked.results.filter((r) => r.status === "fail")));
  assert.ok(revoked.results.some((r) => r.status === "pass" && /revoked/i.test(r.name)), "the revoked check ran");
});

test("Tickets: no token gets the bare Bearer challenge; a revoked token gets the RevokedAnswer even with a body over the cap (TIN-914 review)", async () => {
  const { app } = ticketsUnderTest();
  const none = await app.fetch(rpc(null));
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("www-authenticate"), "Bearer", "no error code when no token was sent (RFC 6750)");
  const made = (await (await app.fetch(new Request(`${ORIGIN}/api/agents`, { method: "POST", headers: session, body: "{}" }))).json()) as { id: string; token: string };
  await app.fetch(new Request(`${ORIGIN}/api/agents/${made.id}/revoke`, { method: "POST", headers: session, body: "{}" }));
  const big = await app.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json" }, body: "x".repeat(2_000_000) }));
  assert.equal(big.status, 401);
  assert.equal(((await big.json()) as { error: string }).error, "revoked");
  const unknown = await app.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: "Bearer 0123456789abcdef0123456789abcdef" }, body: "x".repeat(2_000_000) }));
  assert.equal(unknown.status, 401, "an unknown token is refused before its body is read");
});

test("Tickets has no open default: without signedIn it does not start, and a request without the session is refused (TIN-914 review)", async () => {
  assert.throws(() => new TicketsApp(ORIGIN, {} as never), /give signedIn/);
  const { app } = ticketsUnderTest();
  const r = await app.fetch(new Request(`${ORIGIN}/api/agents`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: "{}" }));
  assert.equal(r.status, 401);
});
