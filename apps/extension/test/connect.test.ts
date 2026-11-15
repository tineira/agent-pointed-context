import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECT_REQUEST_TTL_MS } from "@tineira/apc-protocol";
import {
  ASK_MS,
  askReaderConnect,
  connectErrorStatus,
  NOTE_TEXT,
  POLL_MS,
  pollReaderStatus,
  STATUS_TEXT,
  WAIT_LOST_MS,
  WAITING_TEXT,
  waitingText,
  type DropStatus,
} from "../src/drop.ts";
import { STATUS_KIND, WAIT_STALE_MS } from "../src/popup-state.ts";

const HUB = "https://apc.tineira.com";
const PARAMS = { ticket: "0123456789abcdef0123456789abcdef.fedcba9876543210fedcba9876543210", agent: "ag_1", label: "Chrome on Windows" };

test("APC 0.13 reader pairing: POST /apc/connect, return claim and check, show check in card, and poll /apc/reader/status", async () => {
  const calls: Array<{ url: string; method?: string; redirect?: RequestInit["redirect"]; body: unknown }> = [];
  let statusPolls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: u, method: init?.method, redirect: init?.redirect, body });
    if (u === `${HUB}/apc/connect`) {
      return Response.json({ ok: true, status: "connect_requested", claim: "claim.secret", check: "0482" });
    }
    if (u === `${HUB}/apc/reader/status`) {
      statusPolls++;
      if (statusPolls < 3) return Response.json({ ok: true, status: "pending" });
      return Response.json({ ok: true, status: "paired", token: "tok.123", agent: "ag_1" });
    }
    throw new Error(`unexpected url ${u}`);
  }) as typeof fetch;

  const asked = await askReaderConnect(HUB, PARAMS, fetcher);
  assert.deepEqual(asked, { ok: true, claim: "claim.secret", check: "0482" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: `${HUB}/apc/connect`,
    method: "POST",
    redirect: "manual",
    body: { ticket: PARAMS.ticket, agent: PARAMS.agent, reader: true, label: PARAMS.label },
  });
  assert.equal(waitingText(asked.check), "Confirm in your dock: 0482");

  let ticks = 0;
  const polled = await pollReaderStatus(HUB, asked.claim, {
    fetcher,
    sleep: async () => {},
    tick: async () => { ticks++; },
  });
  assert.deepEqual(polled, { status: "paired", token: "tok.123" });
  assert.equal(statusPolls, 3);
  assert.equal(ticks, 3);
  for (const call of calls.slice(1)) {
    assert.equal(call.url, `${HUB}/apc/reader/status`);
    assert.deepEqual(call.body, { claim: "claim.secret" });
  }
});

test("older hub fallback: HTTP 404 on /apc/connect falls back to /apc/reader without check", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: u, body });
    if (u === `${HUB}/apc/connect`) return new Response("Not Found", { status: 404 });
    if (u === `${HUB}/apc/reader`) return Response.json({ ok: true, claim: "legacy.claim" });
    if (u === `${HUB}/apc/reader/status`) return Response.json({ ok: true, status: "denied" });
    throw new Error(`unexpected url ${u}`);
  }) as typeof fetch;

  const asked = await askReaderConnect(HUB, PARAMS, fetcher);
  assert.deepEqual(asked, { ok: true, claim: "legacy.claim" });
  assert.equal(asked.check, undefined);
  assert.equal(waitingText(asked.check), WAITING_TEXT);
  assert.deepEqual(calls, [
    { url: `${HUB}/apc/connect`, body: { ticket: PARAMS.ticket, agent: PARAMS.agent, reader: true, label: PARAMS.label } },
    { url: `${HUB}/apc/reader`, body: { ticket: PARAMS.ticket, agent: PARAMS.agent, label: PARAMS.label } },
  ]);

  const polled = await pollReaderStatus(HUB, asked.claim, { fetcher, sleep: async () => {} });
  assert.deepEqual(polled, { status: "denied" });
});

test("400 error codes from /apc/connect and /apc/reader/status show accurate messages (never 'Couldn't reach your dock.') and never fall back to /apc/reader", async () => {
  const cases: Array<[string, DropStatus]> = [
    ["ticket_not_for_pairing", "ticket_not_for_pairing"],
    ["ticket_origin_mismatch", "ticket_origin_mismatch"],
    ["too_many_requests", "too_many_requests"],
    ["reader_not_allowed", "reader_not_allowed"],
    ["dock_expired", "dock_expired"],
    ["unknown_agent", "unknown_agent"],
    ["invalid", "invalid"],
    ["ticket_expired", "no_ticket"],
    ["app_not_allowed", "refused"],
    ["future_400_code", "refused"],
  ];

  for (const [code, expectedStatus] of cases) {
    assert.equal(connectErrorStatus(code), expectedStatus);
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({ ok: false, error: code }, { status: 400 });
    }) as typeof fetch;

    const asked = await askReaderConnect(HUB, PARAMS, fetcher);
    assert.deepEqual(asked, { ok: false, status: expectedStatus }, code);
    assert.deepEqual(urls, [`${HUB}/apc/connect`], `400 ${code} must not fall back to /apc/reader`);

    const note = NOTE_TEXT[expectedStatus];
    assert.ok(note && note.failed && note.lead === "Not sent", code);
    assert.notEqual(note.text, NOTE_TEXT.error!.text, `${code} must not say Couldn't reach your dock.`);
    assert.equal(STATUS_KIND[expectedStatus], "failed");
    assert.notEqual(STATUS_TEXT[expectedStatus], STATUS_TEXT.error);
  }

  // Polling /apc/reader/status also surfaces 400 errors accurately instead of reporting "denied".
  const statusDenied = await pollReaderStatus(HUB, "claim.1", {
    sleep: async () => {},
    fetcher: (async () => Response.json({ ok: false, error: "reader_not_allowed" }, { status: 400 })) as typeof fetch,
  });
  assert.deepEqual(statusDenied, { status: "reader_not_allowed" });

  // Network error, 5xx, 3xx redirect, or malformed 200 (missing 4-digit check) produce "error" without falling back.
  for (const broken of [
    (async () => { throw new TypeError("offline"); }) as typeof fetch,
    (async () => new Response("bad gateway", { status: 502 })) as typeof fetch,
    (async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as typeof fetch,
    (async () => Response.json({ ok: true, status: "connect_requested", claim: "c.1" })) as typeof fetch,
    (async () => Response.json({ ok: true, status: "connect_requested", claim: "c.1", check: "evil" })) as typeof fetch,
  ]) {
    const urls: string[] = [];
    const wrapped = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      return broken(url, init);
    }) as typeof fetch;
    assert.deepEqual(await askReaderConnect(HUB, PARAMS, wrapped), { ok: false, status: "error" });
    assert.deepEqual(urls, [`${HUB}/apc/connect`]);
  }
});

test("timing and timeout: ASK_MS and WAIT_LOST_MS are 135 s (CONNECT_REQUEST_TTL_MS + margin), and pollReaderStatus times out after ASK_MS", async () => {
  assert.equal(CONNECT_REQUEST_TTL_MS, 120_000);
  assert.equal(ASK_MS, 135_000);
  assert.equal(WAIT_LOST_MS, 135_000);
  assert.equal(WAIT_STALE_MS, 135_000);
  assert.ok(ASK_MS > CONNECT_REQUEST_TTL_MS);

  let clock = 1_000_000;
  let polls = 0;
  const result = await pollReaderStatus(HUB, "claim.slow", {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetcher: (async () => {
      polls++;
      return Response.json({ ok: true, status: "pending" });
    }) as typeof fetch,
  });
  assert.deepEqual(result, { status: "timeout" });
  assert.equal(polls, Math.ceil(ASK_MS / POLL_MS));
  assert.ok(clock - 1_000_000 >= ASK_MS, "kept polling past 120 s up to 135 s");
});
