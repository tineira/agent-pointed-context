import assert from "node:assert/strict";
import { test } from "node:test";
import { apcManifest, requestConnect } from "../src/index.ts";
import { HUB_ANSWER_MAX_BYTES } from "@tineira/apc-protocol";
import { createServer } from "node:http";

const HUB = "https://dock.test";
const body = { ticket: "a".repeat(32) + "." + "b".repeat(32), agent: "ag_1", app: { origin: "https://app.test" } };
const success = { ok: true, status: "connect_requested" };
const responding = (answer: () => Response | Promise<Response>) => (async () => answer()) as typeof fetch;
test("requestConnect keeps M1 to M4 fail-closed guards", async () => {
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

test("requestConnect marks only the exact legacy 404 as legacyAbsent", async (t) => {
  const cases = [
    { name: "exact legacy body", status: 404, body: { error: "not_found" }, legacy: true },
    { name: "extra detail", status: 404, body: { error: "not_found", detail: "missing route" } },
    { name: "extra ok", status: 404, body: { ok: false, error: "not_found" } },
    { name: "400 refusal", status: 400, body: { ok: false, error: "not_found" }, error: "not_found" },
    ...[400, 409, 429, 500].map((status) => ({ name: `${status} not_found`, status, body: { error: "not_found" } })),
    { name: "409 refusal", status: 409, body: { ok: false, error: "not_found" } },
    { name: "429 refusal", status: 429, body: { ok: false, error: "not_found" } },
    { name: "500 refusal", status: 500, body: { ok: false, error: "not_found" } },
    { name: "non-JSON body", status: 404, body: "not JSON" },
    { name: "followed redirect", status: 404, body: { error: "not_found" }, redirected: true },
  ];
  for (const c of cases) await t.test(c.name, async () => {
    const response = typeof c.body === "string" ? new Response(c.body, { status: c.status }) : Response.json(c.body, { status: c.status });
    if ("redirected" in c) Object.defineProperty(response, "redirected", { value: true });
    const result = await requestConnect(HUB, body, { fetch: responding(() => response) });
    assert.deepEqual(result, "legacy" in c
      ? { ok: false, error: "not_found", legacyAbsent: true }
      : { ok: false, error: "error" in c ? c.error : "hub_refused" });
  });
});

test("requestConnect refuses a redirect chain ending in the exact legacy 404 even if a transport follows it", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/apc/connect" || req.url === "/hop") {
      res.writeHead(307, { location: req.url === "/hop" ? "/missing" : "/hop" }).end();
    } else {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const follows = ((input, init) => fetch(input, { ...init, redirect: "follow" })) as typeof fetch;
    assert.deepEqual(await requestConnect(`http://127.0.0.1:${address.port}`, body, { fetch: follows }), { ok: false, error: "hub_refused" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
