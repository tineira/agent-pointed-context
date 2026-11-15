import {
  APC_JSON_PAIRING_MAX_AGE_S,
  PAIRING_CODE_ACK,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_TTL_MS,
  PAIRING_ENDED_ERROR,
} from "@tineira/apc-protocol";
import { standInApp, type StandInApp, type StandInApcJsonMode } from "./app.ts";
import { ConformanceError, expect, isObject } from "./shared.ts";

export interface ApcHubApproveResult {
  ok: boolean;
  error?: string;
  attempt?: number;
  remaining?: number;
}

export interface ApcHubAdapter {
  /** Human-readable hub name for reports. */
  name: string;
  /** Hub base URL (origin), e.g. `"https://hub.example"`. */
  origin: string;
  /** Default agent identifier used when requesting tickets. */
  agent: string;
  /** Dispatches HTTP requests to the hub (`/apc/pair`, `/apc/confirm`, ...). */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Issues a drop ticket for `agent` (used on `/apc/confirm`). */
  ticket(agent: string): Promise<string> | string;
  /**
   * Issues the ticket passed to `/apc/pair` for `(agent, origin)`.
   * Pre-0.13 this delegates to `ticket(agent)`; in 0.13+ it runs
   * `/apc/connect`, approves it, and returns the connect ticket.
   */
  pairingTicket(agent: string, origin: string): Promise<string> | string;
  /** Simulates the dock owner approving pairing request `id` with `code`. */
  approve(id: string, code?: string): Promise<ApcHubApproveResult>;
  /** Simulates the dock owner denying pairing request `id`. */
  deny(id: string): Promise<{ ok: boolean; error?: string }>;
  /** Advances the hub's clock by `ms` milliseconds. */
  advance(ms: number): Promise<void> | void;
  /** Optional reset run before each check to isolate hub state. */
  reset?(): Promise<void> | void;
  /** Optional hook waiting for background hub tasks (e.g. `/apc/revoke`) to settle. */
  idle?(): Promise<void> | void;
}

export interface HubConformanceCheck {
  id: string;
  name: string;
  rules: readonly string[];
  run(): Promise<void>;
}

export interface HubConformanceReport {
  name: string;
  ok: boolean;
  passed: number;
  failed: Array<{ id: string; name: string; error: string }>;
}

interface HttpJsonResult {
  ok: boolean;
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

const VALID_CODE_A = "ABCD12";
const VALID_CODE_A_DASHED = "ab-cd-12";
const VALID_CODE_B = "EFGH34";

function requestOrigin(input: RequestInfo | URL): string | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

async function withApp(
  adapter: ApcHubAdapter,
  fn: (app: StandInApp) => Promise<void>,
): Promise<void> {
  await adapter.reset?.();
  const app = standInApp();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const reqOrigin = requestOrigin(input);
    if (reqOrigin === app.origin || reqOrigin === app.redirectOrigin) {
      return await app.fetch(input, init);
    }
    return await originalFetch(input, init);
  };
  try {
    await fn(app);
  } finally {
    app.releaseRevoke();
    globalThis.fetch = originalFetch;
  }
}

async function postHub(adapter: ApcHubAdapter, path: string, body: unknown): Promise<HttpJsonResult> {
  const url = new URL(path, adapter.origin).toString();
  const res = await adapter.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed)) json = parsed;
  } catch {
    json = null;
  }
  const ok = res.ok && json?.ok === true;
  return { ok, status: res.status, text, json };
}

async function pairApp(
  adapter: ApcHubAdapter,
  app: StandInApp,
  opts: { ticket?: string; mcpUrl?: string; code?: unknown; omitCode?: boolean; appName?: unknown } = {},
): Promise<HttpJsonResult> {
  const ticket = opts.ticket ?? (await adapter.pairingTicket(adapter.agent, app.origin));
  const payload: Record<string, unknown> = {
    ticket,
    agent: adapter.agent,
    app: { name: opts.appName !== undefined ? opts.appName : app.name, origin: app.origin },
    mcp_url: opts.mcpUrl ?? app.mintGrantUrl(),
  };
  if (!opts.omitCode) {
    payload.pairing_code = opts.code !== undefined ? opts.code : VALID_CODE_A;
  }
  return await postHub(adapter, "/apc/pair", payload);
}

async function confirmApp(
  adapter: ApcHubAdapter,
  mcpUrl: string,
  ticket?: string,
): Promise<HttpJsonResult> {
  return await postHub(adapter, "/apc/confirm", {
    ticket: ticket ?? (await adapter.ticket(adapter.agent)),
    agent: adapter.agent,
    mcp_url: mcpUrl,
  });
}

function pairingIdOf(res: HttpJsonResult, context: string): string {
  expect(res.ok, `${context}: expected /apc/pair to succeed, got ${res.status} ${res.text}`);
  const id = res.json?.pairing_id;
  expect(typeof id === "string" && id.length > 0, `${context}: /apc/pair missing pairing_id in ${res.text}`);
  return id as string;
}

function isNotPaired(res: HttpJsonResult): boolean {
  return !res.ok && res.json?.error === "not_paired";
}

function mcpCalls(app: StandInApp, url?: string) {
  return app.calls.filter((c) => {
    if (c.url === app.revokeUrl) return false;
    return url ? c.url === url : true;
  });
}

async function waitForRevoke(adapter: ApcHubAdapter, app: StandInApp, mcpUrl: string, context: string): Promise<void> {
  await adapter.idle?.();
  const deadline = Date.now() + 400;
  while (!app.revokes.includes(mcpUrl) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
    await adapter.idle?.();
  }
  expect(app.revokes.includes(mcpUrl), `${context}: expected /apc/revoke for ${mcpUrl}, got [${app.revokes.join(", ")}]`);
}

function pairCodeWrong(index: number): string {
  return `ZZZZ0${index + 1}`;
}

/**
 * Minimal hub conformance suite (TIN-919, part 1: H1 to H7 app-visible rules).
 * Runs in-process against any `ApcHubAdapter` using `standInApp`.
 */
export function hubConformance(adapter: ApcHubAdapter): HubConformanceCheck[] {
  return [
    {
      id: "hub.apc-json",
      name: "refuses bad, redirected, cross-origin, dockless or uncovered apc.json",
      rules: ["apc.json"],
      run: async () => {
        await withApp(adapter, async (app) => {
          const badModes: StandInApcJsonMode[] = [
            "missing",
            "redirect",
            "opaque_redirect",
            "not_json",
            "missing_fields",
            "too_large",
            "wrong_origin",
            "no_dock",
            "bad_mcp_path",
            "endpoints_no_dock",
          ];
          for (const mode of badModes) {
            app.apcJsonMode = mode;
            const url = app.mintGrantUrl();
            const res = await pairApp(adapter, app, { mcpUrl: url });
            expect(!res.ok, `apc.json mode "${mode}" must be refused, got ${res.text}`);
            expect(app.redirectHits.length === 0, `apc.json mode "${mode}" followed a redirect`);
            const c = await confirmApp(adapter, url);
            expect(isNotPaired(c), `apc.json mode "${mode}" created a pairing: ${c.text}`);
          }
        });
      },
    },

    {
      id: "hub.apc-json-freshness",
      name: "apc.json expires after 60 s and unreachable/5xx never falls back to stale cache (H7)",
      rules: ["H7"],
      run: async () => {
        await withApp(adapter, async (app) => {
          const url1 = app.mintGrantUrl();
          const first = await pairApp(adapter, app, { mcpUrl: url1 });
          pairingIdOf(first, "H7 warmup pair");

          await adapter.advance(APC_JSON_PAIRING_MAX_AGE_S * 1000 + 1000);

          for (const mode of ["error_503", "network_error", "no_dock"] as const) {
            app.apcJsonMode = mode;
            const url2 = app.mintGrantUrl();
            const res = await pairApp(adapter, app, { mcpUrl: url2 });
            expect(!res.ok, `H7: apc.json mode "${mode}" after 60s must be refused rather than using stale cache, got ${res.text}`);
            const c = await confirmApp(adapter, url2);
            expect(isNotPaired(c), `H7: refused apc.json "${mode}" left a pairing behind`);
          }
        });
      },
    },

    {
      id: "hub.pair-body-ticket-unspent",
      name: "refuses malformed /apc/pair bodies before spending the ticket and fetches no apc.json on bad ticket",
      rules: ["pair-body"],
      run: async () => {
        await withApp(adapter, async (app) => {
          const t = await adapter.pairingTicket(adapter.agent, app.origin);
          const readsBefore = app.apcJsonReads;

          const nonObject = await postHub(adapter, "/apc/pair", null);
          expect(!nonObject.ok, "null /apc/pair body must be refused");

          const malformedBodies: Array<Record<string, unknown>> = [
            { ticket: t, agent: adapter.agent, app: { name: app.name, origin: app.origin }, mcp_url: app.mintGrantUrl(), pairing_code: null },
            { ticket: t, agent: adapter.agent, app: { name: app.name, origin: app.origin }, mcp_url: app.mintGrantUrl(), pairing_code: "" },
            { ticket: t, agent: adapter.agent, app: { name: app.name, origin: app.origin }, mcp_url: app.mintGrantUrl(), pairing_code: 123456 },
            { ticket: t, agent: adapter.agent, app: { name: app.name, origin: app.origin }, mcp_url: app.mintGrantUrl(), pairing_code: "ABC" },
            { ticket: t, agent: adapter.agent, app: { origin: app.origin }, mcp_url: app.mintGrantUrl(), pairing_code: VALID_CODE_A },
            { ticket: t, agent: adapter.agent, app: { name: app.name, origin: app.origin }, pairing_code: VALID_CODE_A },
          ];

          for (const bad of malformedBodies) {
            const res = await postHub(adapter, "/apc/pair", bad);
            expect(!res.ok, `malformed /apc/pair body must be refused: ${JSON.stringify(bad)}`);
            expect(app.apcJsonReads === readsBefore, "malformed /apc/pair body must not fetch apc.json");
          }

          // The same ticket must still be unspent and succeed with a well-formed request.
          const good = await pairApp(adapter, app, { ticket: t, mcpUrl: app.mintGrantUrl(), code: VALID_CODE_A });
          pairingIdOf(good, "well-formed pair after malformed attempts");

          // Reusing the spent ticket must be refused.
          const reused = await pairApp(adapter, app, { ticket: t, mcpUrl: app.mintGrantUrl(), code: VALID_CODE_A });
          expect(!reused.ok, `reused ticket must be refused, got ${reused.text}`);

          // Invalid ticket must be refused without fetching apc.json.
          const readsBeforeBadTicket = app.apcJsonReads;
          const badTicket = `${"0".repeat(32)}.${"0".repeat(32)}`;
          const invalid = await pairApp(adapter, app, { ticket: badTicket, mcpUrl: app.mintGrantUrl(), code: VALID_CODE_A });
          expect(!invalid.ok, `invalid ticket must be refused, got ${invalid.text}`);
          expect(app.apcJsonReads === readsBeforeBadTicket, "invalid ticket must not fetch apc.json");
        });
      },
    },

    {
      id: "hub.pairing-code",
      name: "requires pairing code, normalizes it, and never echoes it (PAIR-2, CODE-2)",
      rules: ["PAIR-2", "CODE-2"],
      run: async () => {
        await withApp(adapter, async (app) => {
          const codeless = await pairApp(adapter, app, { omitCode: true });
          expect(!codeless.ok, `codeless /apc/pair must be refused, got ${codeless.text}`);

          const url = app.mintGrantUrl();
          const res = await pairApp(adapter, app, { mcpUrl: url, code: VALID_CODE_A_DASHED });
          const id = pairingIdOf(res, "coded /apc/pair");
          expect(res.json?.pairing_code === PAIRING_CODE_ACK, `expected pairing_code: "${PAIRING_CODE_ACK}", got ${res.text}`);
          expect(!res.text.toUpperCase().includes(VALID_CODE_A), `pairing code leaked in /apc/pair response: ${res.text}`);
          expect(!res.text.toLowerCase().includes(VALID_CODE_A_DASHED), `raw pairing code leaked in /apc/pair response: ${res.text}`);

          // Missing or malformed code on approve must fail without consuming one of the 5 attempts.
          const missingApprove = await adapter.approve(id);
          expect(!missingApprove.ok, "approve without code must fail");
          const malformedApprove = await adapter.approve(id, "bad!");
          expect(!malformedApprove.ok, "approve with malformed code must fail");

          for (let i = 0; i < PAIRING_CODE_MAX_ATTEMPTS - 1; i += 1) {
            const wrong = await adapter.approve(id, pairCodeWrong(i));
            expect(!wrong.ok, `wrong code #${i + 1} must fail`);
          }

          // Normalized code still matches on the 5th real code attempt (because missing/malformed did not count).
          const approved = await adapter.approve(id, VALID_CODE_A.toLowerCase());
          expect(approved.ok, `normalized pairing code should approve, got ${JSON.stringify(approved)}`);

          const confirmed = await confirmApp(adapter, url);
          expect(confirmed.ok && confirmed.json?.status === "paired", `expected paired /apc/confirm, got ${confirmed.text}`);
          expect(!confirmed.text.toUpperCase().includes(VALID_CODE_A), `pairing code leaked in /apc/confirm: ${confirmed.text}`);
          for (const b of app.bodies) {
            expect(!b.text.toUpperCase().includes(VALID_CODE_A), `pairing code leaked to app request ${b.url}: ${b.text}`);
          }
        });
      },
    },

    {
      id: "hub.give-back",
      name: "gives grant back on 5th wrong code, expiry, or deny (PAIR-2)",
      rules: ["PAIR-2"],
      run: async () => {
        await withApp(adapter, async (app) => {
          // 5th wrong code gives back the grant.
          const url1 = app.mintGrantUrl();
          const id1 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "5th-wrong pair");
          for (let i = 0; i < PAIRING_CODE_MAX_ATTEMPTS - 1; i += 1) {
            const wrong = await adapter.approve(id1, pairCodeWrong(i));
            expect(!wrong.ok, `wrong attempt #${i + 1} must fail`);
            expect(app.revokes.length === 0, `must not revoke before 5th wrong code (got ${app.revokes.length} on #${i + 1})`);
          }
          const fifth = await adapter.approve(id1, pairCodeWrong(PAIRING_CODE_MAX_ATTEMPTS - 1));
          expect(!fifth.ok, "5th wrong code must fail");
          await waitForRevoke(adapter, app, url1, "5th wrong code");
          const afterLockout = await adapter.approve(id1, VALID_CODE_A);
          expect(!afterLockout.ok, "pairing must be gone after 5th wrong code");
          expect(isNotPaired(await confirmApp(adapter, url1)), "confirm after 5th wrong code must answer not_paired");

          // Expiry gives back the grant.
          const url2 = app.mintGrantUrl();
          const id2 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_A }), "expiry pair");
          await adapter.advance(PAIRING_CODE_TTL_MS + 1000);
          const lateApprove = await adapter.approve(id2, VALID_CODE_A);
          expect(!lateApprove.ok, "approve after pairing code TTL must fail");
          await waitForRevoke(adapter, app, url2, "pairing expiry");

          // Deny gives back the grant.
          const url3 = app.mintGrantUrl();
          const id3 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url3, code: VALID_CODE_A }), "deny pair");
          const denied = await adapter.deny(id3);
          expect(denied.ok, `deny must succeed, got ${JSON.stringify(denied)}`);
          await waitForRevoke(adapter, app, url3, "deny");
          expect(isNotPaired(await confirmApp(adapter, url3)), "confirm after deny must answer not_paired");
        });
      },
    },

    {
      id: "hub.no-mcp-before-approval",
      name: "sends no MCP calls before owner approves with the code; initialize is first after (H1)",
      rules: ["H1"],
      run: async () => {
        await withApp(adapter, async (app) => {
          const url1 = app.mintGrantUrl();
          const id1 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "H1 pending");
          expect(mcpCalls(app, url1).length === 0, "H1: hub called MCP immediately on /apc/pair");

          const pendingConfirm = await confirmApp(adapter, url1);
          expect(pendingConfirm.ok && pendingConfirm.json?.status === "pending", `expected pending confirm, got ${pendingConfirm.text}`);
          expect(mcpCalls(app, url1).length === 0, "H1: hub called MCP on /apc/confirm while pending");

          await adapter.approve(id1, pairCodeWrong(0));
          expect(mcpCalls(app, url1).length === 0, "H1: hub called MCP after wrong code");

          const denied = await adapter.deny(id1);
          expect(denied.ok, "deny failed");
          expect(mcpCalls(app, url1).length === 0, "H1: hub called MCP on deny");

          const url2 = app.mintGrantUrl();
          const id2 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_A }), "H1 approve");
          expect(mcpCalls(app, url2).length === 0, "H1: hub called MCP before approve");

          const ok = await adapter.approve(id2, VALID_CODE_A);
          expect(ok.ok, `H1: approve with valid code failed: ${JSON.stringify(ok)}`);
          const calls = mcpCalls(app, url2);
          expect(calls.length >= 1, "H1: hub never sent initialize after approval");
          expect(calls[0]?.rpcMethod === "initialize", `H1: first MCP call must be initialize, got ${calls[0]?.rpcMethod}`);
        });
      },
    },

    {
      id: "hub.confirm-expires-overdue",
      name: "/apc/confirm expires overdue pending requests before answering and leaves ticket unspent (H2)",
      rules: ["H2"],
      run: async () => {
        await withApp(adapter, async (app) => {
          const url1 = app.mintGrantUrl();
          pairingIdOf(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "H2 pair");

          const before = await confirmApp(adapter, url1);
          expect(before.ok && before.json?.status === "pending", `expected pending before expiry, got ${before.text}`);

          // Take the drop ticket before advancing; PAIRING_CODE_TTL_MS < TICKET_TTL_MS.
          const confirmTicket = await adapter.ticket(adapter.agent);
          await adapter.advance(PAIRING_CODE_TTL_MS + 1000);

          const overdue = await confirmApp(adapter, url1, confirmTicket);
          expect(isNotPaired(overdue), `H2: overdue /apc/confirm must answer not_paired, got ${overdue.text}`);
          await waitForRevoke(adapter, app, url1, "H2 overdue confirm");

          // Verify confirmTicket remained unspent when /apc/confirm returned not_paired.
          const url2 = app.mintGrantUrl();
          const id2 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_B }), "H2 re-pair");
          const approved = await adapter.approve(id2, VALID_CODE_B);
          expect(approved.ok, `H2: approve url2 failed: ${JSON.stringify(approved)}`);

          const reusedConfirm = await confirmApp(adapter, url2, confirmTicket);
          expect(reusedConfirm.ok && reusedConfirm.json?.status === "paired", `H2: not_paired /apc/confirm must leave ticket unspent, got ${reusedConfirm.text}`);
        });
      },
    },

    {
      id: "hub.replace-pending",
      name: "/apc/pair replaces unapproved pending pairing for (agent, origin), resets attempts, revokes diff URL async, keeps paired (H3)",
      rules: ["H3"],
      run: async () => {
        await withApp(adapter, async (app) => {
          // 1. Replacing a pending request with a different URL starts attempts at 0 and revokes asynchronously.
          const url1 = app.mintGrantUrl();
          const id1 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "H3 first pending");
          for (let i = 0; i < PAIRING_CODE_MAX_ATTEMPTS - 1; i += 1) {
            const wrong = await adapter.approve(id1, pairCodeWrong(i));
            expect(!wrong.ok, "wrong attempt on id1 should fail");
          }

          app.revokeMode = "slow";
          const url2 = app.mintGrantUrl();
          const id2 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_B }), "H3 replacement");
          expect(id2 !== id1, "H3: replacement pairing should get a new pairing_id");

          // /apc/pair must not have blocked on slow /apc/revoke; now release it and wait for url1 revoke.
          app.revokeMode = "ok";
          app.releaseRevoke();
          await waitForRevoke(adapter, app, url1, "H3 async revoke of replaced URL");

          const oldApprove = await adapter.approve(id1, VALID_CODE_A);
          expect(!oldApprove.ok, "H3: replaced pairing id1 must not approve");

          // Attempts on id2 started at 0 (4 wrong codes + 1 right code still succeeds).
          for (let i = 0; i < PAIRING_CODE_MAX_ATTEMPTS - 1; i += 1) {
            const wrong = await adapter.approve(id2, pairCodeWrong(i));
            expect(!wrong.ok, `H3: wrong attempt #${i + 1} on replacement failed unexpectedly`);
          }
          const right = await adapter.approve(id2, VALID_CODE_B);
          expect(right.ok, `H3: replacement wrong-code counter did not reset to 0: ${JSON.stringify(right)}`);

          // 2. A paired pairing is never replaced when another /apc/pair arrives for the same (agent, origin).
          const url3 = app.mintGrantUrl();
          await pairApp(adapter, app, { mcpUrl: url3, code: VALID_CODE_A });
          const confirmUrl2 = await confirmApp(adapter, url2);
          expect(confirmUrl2.ok && confirmUrl2.json?.status === "paired", `H3: /apc/pair replaced an already-paired pairing: ${confirmUrl2.text}`);
          expect(!app.revokes.includes(url2), "H3: already-paired URL must not be revoked");

          // 3. Re-pairing pending request with the SAME URL does not revoke that URL.
          const sameUrl = app.mintGrantUrl("same");
          pairingIdOf(await pairApp(adapter, app, { mcpUrl: sameUrl, code: VALID_CODE_A }), "H3 same URL #1");
          await adapter.idle?.();
          pairingIdOf(await pairApp(adapter, app, { mcpUrl: sameUrl, code: VALID_CODE_B }), "H3 same URL #2");
          await adapter.idle?.();
          await new Promise((r) => setTimeout(r, 40));
          expect(!app.revokes.includes(sameUrl), `H3: re-pairing with same URL must not /apc/revoke it, got ${JSON.stringify(app.revokes)}`);
        });
      },
    },

    {
      id: "hub.ended-pairing",
      name: "404 on initialize ends pairing without /apc/revoke, answers not_paired on /apc/confirm, allows re-pair (H5)",
      rules: ["H5"],
      run: async () => {
        await withApp(adapter, async (app) => {
          app.mcpMode = "not_found";
          const url1 = app.mintGrantUrl();
          const id1 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "H5 pair");

          const res = await adapter.approve(id1, VALID_CODE_A);
          expect(!res.ok, `H5: approve on 404 grant must fail, got ${JSON.stringify(res)}`);
          expect(res.error === PAIRING_ENDED_ERROR, `H5: expected error "${PAIRING_ENDED_ERROR}", got ${JSON.stringify(res)}`);
          await adapter.idle?.();
          expect(app.revokes.length === 0, `H5: ended grant must not trigger /apc/revoke, got ${JSON.stringify(app.revokes)}`);

          const confirm1 = await confirmApp(adapter, url1);
          expect(isNotPaired(confirm1), `H5: /apc/confirm on ended pairing must answer not_paired, got ${confirm1.text}`);

          app.mcpMode = "ok";
          const url2 = app.mintGrantUrl();
          const id2 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_B }), "H5 re-pair");
          const approved2 = await adapter.approve(id2, VALID_CODE_B);
          expect(approved2.ok, `H5: re-pair after ended pairing failed: ${JSON.stringify(approved2)}`);
        });
      },
    },

    {
      id: "hub.no-redirects",
      name: "never follows redirects on apc.json, MCP initialize, or /apc/revoke",
      rules: ["redirects"],
      run: async () => {
        await withApp(adapter, async (app) => {
          app.apcJsonMode = "redirect";
          const res1 = await pairApp(adapter, app, { mcpUrl: app.mintGrantUrl(), code: VALID_CODE_A });
          expect(!res1.ok, "redirected apc.json must be refused");
          expect(app.redirectHits.length === 0, `hub followed redirect on apc.json: ${app.redirectHits.join(", ")}`);

          app.apcJsonMode = "ok";
          app.mcpMode = "redirect";
          const url2 = app.mintGrantUrl();
          const id2 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_A }), "MCP redirect pair");
          await adapter.approve(id2, VALID_CODE_A);
          expect(app.redirectHits.length === 0, `hub followed redirect on MCP initialize: ${app.redirectHits.join(", ")}`);

          app.mcpMode = "ok";
          app.revokeMode = "redirect";
          const url3 = app.mintGrantUrl();
          const id3 = pairingIdOf(await pairApp(adapter, app, { mcpUrl: url3, code: VALID_CODE_B }), "revoke redirect pair");
          await adapter.deny(id3);
          await adapter.idle?.();
          expect(app.redirectHits.length === 0, `hub followed redirect on /apc/revoke: ${app.redirectHits.join(", ")}`);
        });
      },
    },
  ];
}

export async function runHubConformance(adapter: ApcHubAdapter): Promise<HubConformanceReport> {
  const checks = hubConformance(adapter);
  const failed: HubConformanceReport["failed"] = [];
  let passed = 0;
  for (const check of checks) {
    try {
      await check.run();
      passed += 1;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failed.push({ id: check.id, name: check.name, error: msg });
    }
  }
  return {
    name: adapter.name,
    ok: failed.length === 0,
    passed,
    failed,
  };
}

export { ConformanceError };
