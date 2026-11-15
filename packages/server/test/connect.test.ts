import assert from "node:assert/strict";
import { test } from "node:test";
import { apcManifest, requestConnect } from "../src/index.ts";
import { HUB_ANSWER_MAX_BYTES } from "@tineira/apc-protocol";

const HUB = "https://dock.test";
const body = { ticket: "a".repeat(32) + "." + "b".repeat(32), agent: "ag_1", app: { origin: "https://app.test" } };
const success = { ok: true, status: "connect_requested" };
const responding = (answer: () => Response | Promise<Response>) => (async () => answer()) as typeof fetch;
test("requestConnect distinguishes only a real 404, keeping M1 to M4 fail-closed guards", async () => {
  let sent = 0;
  const sender = (async (url: string | URL | Request, init?: RequestInit) => {
    sent++;
    assert.equal(String(url), HUB + "/apc/connect");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return Response.json(success);
  }) as typeof fetch;
  assert.deepEqual(await requestConnect(HUB, body, { fetch: sender }), success);
  assert.deepEqual(await requestConnect(HUB + "/unsafe", body, { fetch: sender }), { ok: false, error: "hub_not_allowed" });
  assert.equal(sent, 1);
  assert.deepEqual(await requestConnect(HUB, body, { fetch: responding(() => Response.json({ error: "not_found" }, { status: 404 })) }), { ok: false, error: "not_found" });
  assert.deepEqual(await requestConnect(HUB, body, { fetch: responding(() => Response.json({ ok: false, error: "not_found" }, { status: 404 })) }), { ok: false, error: "not_found" });
  for (const response of [
    new Response("not JSON", { status: 404 }),
    new Response(null, { status: 404 }),
    Response.json({}, { status: 404 }),
    Response.json([], { status: 404 }),
    Response.json({ error: "other" }, { status: 404 }),
    Response.json({ error: "not_found" }, { status: 404, headers: { "content-length": String(HUB_ANSWER_MAX_BYTES + 1) } }),
    new Response(null, { status: 307, headers: { location: "https://elsewhere.test" } }),
    Response.json(success, { status: 500 }),
    Response.json(success, { headers: { "content-length": String(HUB_ANSWER_MAX_BYTES + 1) } }),
    new Response(" ".repeat(HUB_ANSWER_MAX_BYTES + 1)),
    Response.json({ ok: true, status: "paired" }),
  ]) assert.deepEqual(await requestConnect(HUB, body, { fetch: responding(() => response) }), { ok: false, error: "hub_refused" });
  const followed404 = new Response(null, { status: 404 });
  Object.defineProperty(followed404, "redirected", { value: true });
  assert.deepEqual(await requestConnect(HUB, body, { fetch: responding(() => followed404) }), { ok: false, error: "hub_refused" });
  assert.deepEqual(await requestConnect(HUB, body, { timeoutMs: 15, fetch: responding(() => new Promise(() => {})) }), { ok: false, error: "hub_unreachable" });
  assert.deepEqual(await requestConnect(HUB, body, { fetch: responding(() => Response.json({ ok: false, error: "too_many_requests" }, { status: 400 })) }), { ok: false, error: "too_many_requests" });
});
test("reader connect answers require a claim and a four-digit check", async () => {
  const reader = { ticket: body.ticket, agent: body.agent, reader: true as const };
  assert.deepEqual(await requestConnect(HUB, reader, { fetch: responding(() => Response.json(success)) }), { ok: false, error: "hub_refused" });
  const answer = { ...success, claim: body.ticket, check: "0042" };
  assert.deepEqual(await requestConnect(HUB, reader, { fetch: responding(() => Response.json(answer)) }), answer);
});
test("apcManifest resolves and validates dockConnect", () => {
  const options = { name: "App", origin: "https://app.test", profiles: ["dock" as const] };
  assert.equal(apcManifest({ ...options, dockConnect: "/connect/dock" }).dock_connect, "https://app.test/connect/dock");
  for (const dockConnect of ["https://other.test/connect", "/connect#", "/connect#x"]) assert.throws(() => apcManifest({ ...options, dockConnect }));
});
