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
  /** Optional hook exercising agent-facing tools to verify H1/H5 MCP gating. */
  exerciseAgent?(agent: string): Promise<void> | void;
  /**
   * Set true when the hub's policy forbids codeless `/apc/pair`.
   * When unset or false, codeless acceptance is reported as a declared policy note rather than a failure.
   */
  requiresPairingCode?: boolean;
  /** Optional note recorded when `requiresPairingCode` is not true and codeless `/apc/pair` is accepted. */
  codelessPolicyNote?: string;
}

export interface HubConformanceCheck {
  id: string;
  name: string;
  rules: readonly string[];
  note?: string;
  run(): Promise<void>;
}

export interface HubConformanceReport {
  name: string;
  ok: boolean;
  passed: number;
  failed: Array<{ id: string; name: string; error: string }>;
  notes?: Array<{ id: string; name: string; note: string }>;
}

interface HttpJsonResult {
  ok: boolean;
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

const VALID_CODE_A = "K7M4P2";
const VALID_CODE_A_SUBMITTED = "k7m-4p2";
const VALID_CODE_A_APPROVE = " k7m-4p2 ";
const VALID_CODE_ALIAS_RAW = "K0M1P2";
const VALID_CODE_ALIAS_APPROVE_OI = " kOm-Ip2 ";
const VALID_CODE_ALIAS_APPROVE_L = "K0m Lp2";
const VALID_CODE_B = "Q3N5R7";
const VALID_CODE_B_SUBMITTED = "q3n-5r7";
const WRONG_CODES = ["Z9Z9Z2", "Z9Z9Z3", "Z9Z9Z4", "Z9Z9Z5", "Z9Z9Z6"] as const;

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
    app.releaseInitialize();
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
  const ok = res.status === 200 && json?.ok === true;
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

function expectPairSuccess(res: HttpJsonResult, context: string): string {
  expect(res.ok, `${context}: expected HTTP 200 { ok: true } from /apc/pair, got ${res.status} ${res.text}`);
  const id = res.json?.pairing_id;
  expect(typeof id === "string" && id.length > 0, `${context}: /apc/pair missing pairing_id in ${res.text}`);
  expect(res.json?.status === "pending", `${context}: expected /apc/pair status "pending", got ${res.text}`);
  expect(
    res.json?.pairing_code === PAIRING_CODE_ACK,
    `${context}: expected pairing_code: "${PAIRING_CODE_ACK}", got ${res.text}`,
  );
  return id as string;
}

function expectConfirmSuccess(res: HttpJsonResult, expectedStatus: "pending" | "paired", context: string): void {
  expect(res.ok, `${context}: expected HTTP 200 { ok: true } from /apc/confirm, got ${res.status} ${res.text}`);
  expect(res.json?.status === expectedStatus, `${context}: expected /apc/confirm status "${expectedStatus}", got ${res.text}`);
}

function expectRefusal(res: HttpJsonResult, context: string, expectedError?: string): void {
  expect(res.status === 400, `${context}: expected HTTP 400 refusal, got ${res.status} ${res.text}`);
  expect(!res.ok && res.json?.ok === false, `${context}: expected { ok: false }, got ${res.status} ${res.text}`);
  expect(
    typeof res.json?.error === "string" && res.json.error.length > 0,
    `${context}: expected non-empty error token in ${res.text}`,
  );
  if (expectedError !== undefined) {
    expect(res.json?.error === expectedError, `${context}: expected error "${expectedError}", got ${res.text}`);
  }
}

function expectNotPaired(res: HttpJsonResult, context: string): void {
  expectRefusal(res, context, "not_paired");
}

function expectCodeAbsent(text: string, variants: readonly string[], context: string): void {
  const upper = text.toUpperCase();
  for (const variant of variants) {
    const clean = variant.trim();
    if (!clean) continue;
    expect(!upper.includes(clean.toUpperCase()), `${context}: pairing code "${clean}" leaked in ${text}`);
  }
}

function mcpCalls(app: StandInApp, url?: string) {
  return app.calls.filter((c) => {
    if (c.url === app.revokeUrl) return false;
    return url ? c.url === url : true;
  });
}

async function withRealTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConformanceError(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForRevoke(adapter: ApcHubAdapter, app: StandInApp, mcpUrl: string, context: string): Promise<void> {
  if (!app.revokes.includes(mcpUrl)) {
    await withRealTimeout(Promise.resolve(adapter.idle?.()), 400, `${context}: adapter.idle() timed out`);
  }
  for (let i = 0; i < 20 && !app.revokes.includes(mcpUrl); i += 1) {
    await new Promise<void>((r) => setTimeout(r, 15));
    await withRealTimeout(Promise.resolve(adapter.idle?.()), 400, `${context}: adapter.idle() timed out`);
  }
  expect(app.revokes.includes(mcpUrl), `${context}: expected /apc/revoke for ${mcpUrl}, got [${app.revokes.join(", ")}]`);
}

function pairCodeWrong(index: number): string {
  return WRONG_CODES[index % WRONG_CODES.length]!;
}

/**
 * Minimal hub conformance suite (TIN-919, part 1: app-visible hub MUSTs).
 * Runs in-process against any `ApcHubAdapter` using `standInApp`.
 */
export function hubConformance(adapter: ApcHubAdapter): HubConformanceCheck[] {
  const checks: HubConformanceCheck[] = [
    {
      id: "hub.apc-json",
      name: "refuses bad, redirected, cross-origin, dockless or uncovered apc.json",
      rules: ["apc.json"],
      run: async () => {
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
          await withApp(adapter, async (app) => {
            app.apcJsonMode = mode;
            const url = app.mintGrantUrl();
            const res = await pairApp(adapter, app, { mcpUrl: url });
            expect(app.apcJsonReads > 0, `apc.json mode "${mode}" must actually fetch apc.json`);
            expectRefusal(res, `apc.json mode "${mode}"`);
            expect(app.redirectHits.length === 0, `apc.json mode "${mode}" followed a redirect`);
            const c = await confirmApp(adapter, url);
            expectNotPaired(c, `apc.json mode "${mode}" /apc/confirm`);
          });
        }
      },
    },

    {
      id: "hub.apc-json-freshness",
      name: "apc.json expires after 60 s and unreachable/5xx never falls back to stale cache (H7)",
      rules: ["H7"],
      run: async () => {
        for (const mode of ["error_503", "network_error", "no_dock"] as const) {
          await withApp(adapter, async (app) => {
            const url1 = app.mintGrantUrl();
            const first = await pairApp(adapter, app, { mcpUrl: url1 });
            expectPairSuccess(first, `H7 warmup (${mode})`);

            await adapter.advance(APC_JSON_PAIRING_MAX_AGE_S * 1000 + 1000);

            app.apcJsonMode = mode;
            const readsBefore = app.apcJsonReads;
            const url2 = app.mintGrantUrl();
            const res = await pairApp(adapter, app, { mcpUrl: url2 });
            expect(app.apcJsonReads > readsBefore, `H7: apc.json mode "${mode}" after 60s served cache without re-fetching`);
            const expectedError = mode === "no_dock" ? undefined : "apc_json_unreachable";
            expectRefusal(res, `H7 mode "${mode}"`, expectedError);
            const c = await confirmApp(adapter, url2);
            expectNotPaired(c, `H7 mode "${mode}" /apc/confirm`);
          });
        }
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
          expectRefusal(nonObject, "null /apc/pair body");

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
            expectRefusal(res, `malformed /apc/pair body ${JSON.stringify(bad)}`);
            expect(app.apcJsonReads === readsBefore, "malformed /apc/pair body must not fetch apc.json");
          }

          // The same ticket must still be unspent and succeed with a well-formed request.
          const good = await pairApp(adapter, app, { ticket: t, mcpUrl: app.mintGrantUrl(), code: VALID_CODE_A });
          expectPairSuccess(good, "well-formed pair after malformed attempts");

          // Reusing the spent ticket must be refused.
          const reused = await pairApp(adapter, app, { ticket: t, mcpUrl: app.mintGrantUrl(), code: VALID_CODE_A });
          expectRefusal(reused, "reused /apc/pair ticket");

          // Invalid ticket must be refused without fetching apc.json.
          const readsBeforeBadTicket = app.apcJsonReads;
          const badTicket = `${"0".repeat(32)}.${"0".repeat(32)}`;
          const invalid = await pairApp(adapter, app, { ticket: badTicket, mcpUrl: app.mintGrantUrl(), code: VALID_CODE_A });
          expectRefusal(invalid, "invalid /apc/pair ticket");
          expect(app.apcJsonReads === readsBeforeBadTicket, "invalid ticket must not fetch apc.json");
        });
      },
    },

    {
      id: "hub.pairing-code",
      name: "normalizes pairing code, handles codeless policy, and never echoes code (PAIR-2, CODE-2)",
      rules: ["PAIR-2", "CODE-2"],
      run: async () => {
        const check = checks.find((c) => c.id === "hub.pairing-code")!;
        let policyNote: string | undefined;

        await withApp(adapter, async (app) => {
          const codeless = await pairApp(adapter, app, { omitCode: true });
          if (codeless.ok) {
            expect(
              adapter.requiresPairingCode !== true,
              `hub declares requiresPairingCode: true so codeless /apc/pair must be refused, got ${codeless.text}`,
            );
            policyNote =
              adapter.codelessPolicyNote ??
              "Codeless /apc/pair accepted under hub's declared policy (reference hub refuses codeless pairing).";
          } else {
            expectRefusal(codeless, "codeless /apc/pair");
          }
        });

        await withApp(adapter, async (app) => {
          const codeVariantsA = [VALID_CODE_A, VALID_CODE_A_SUBMITTED, VALID_CODE_A_APPROVE];
          const url = app.mintGrantUrl();
          const res = await pairApp(adapter, app, { mcpUrl: url, code: VALID_CODE_A_SUBMITTED });
          const id = expectPairSuccess(res, "coded /apc/pair");
          expectCodeAbsent(res.text, codeVariantsA, "/apc/pair response");

          // Pending /apc/confirm before any approve must never echo the pairing code.
          const pendingBefore = await confirmApp(adapter, url);
          expectConfirmSuccess(pendingBefore, "pending", "pending /apc/confirm before approve");
          expectCodeAbsent(pendingBefore.text, codeVariantsA, "pending /apc/confirm before approve");

          // Missing or malformed code on approve must fail without consuming one of the 5 attempts.
          const missingApprove = await adapter.approve(id);
          expect(!missingApprove.ok, "approve without code must fail");
          const malformedApprove = await adapter.approve(id, "bad!");
          expect(!malformedApprove.ok, "approve with malformed code must fail");

          for (let i = 0; i < PAIRING_CODE_MAX_ATTEMPTS - 1; i += 1) {
            const wrong = await adapter.approve(id, pairCodeWrong(i));
            expect(!wrong.ok, `wrong code #${i + 1} must fail`);
            expectCodeAbsent(JSON.stringify(wrong), codeVariantsA, `wrong approve #${i + 1}`);
          }

          // Pending /apc/confirm after wrong codes must still never echo the pairing code.
          const pendingAfterWrong = await confirmApp(adapter, url);
          expectConfirmSuccess(pendingAfterWrong, "pending", "pending /apc/confirm after wrong codes");
          expectCodeAbsent(pendingAfterWrong.text, codeVariantsA, "pending /apc/confirm after wrong codes");

          // Normalized code with whitespace/hyphens still matches on the 5th real attempt.
          const approved = await adapter.approve(id, VALID_CODE_A_APPROVE);
          expect(approved.ok, `normalized pairing code should approve, got ${JSON.stringify(approved)}`);
          expectCodeAbsent(JSON.stringify(approved), codeVariantsA, "approve response");

          const confirmed = await confirmApp(adapter, url);
          expectConfirmSuccess(confirmed, "paired", "paired /apc/confirm");
          expectCodeAbsent(confirmed.text, codeVariantsA, "paired /apc/confirm");

          for (const b of app.bodies) {
            expectCodeAbsent(b.text, codeVariantsA, `app request body ${b.url}`);
            expectCodeAbsent(b.url, codeVariantsA, `app request url ${b.url}`);
          }
          for (const c of app.calls) {
            expectCodeAbsent(c.url, codeVariantsA, `app call url ${c.url}`);
          }
        });

        // Verify Crockford O->0 / I->1 / L->1 owner aliases on fresh pairings, plus dashed app submission matching uppercase owner code.
        for (const [label, submitted, approvedWith] of [
          ["Crockford O/I alias", VALID_CODE_ALIAS_RAW, VALID_CODE_ALIAS_APPROVE_OI],
          ["Crockford L alias", VALID_CODE_ALIAS_RAW, VALID_CODE_ALIAS_APPROVE_L],
          ["dashed app code", VALID_CODE_B_SUBMITTED, VALID_CODE_B],
        ] as const) {
          await withApp(adapter, async (app) => {
            const url = app.mintGrantUrl();
            const id = expectPairSuccess(
              await pairApp(adapter, app, { mcpUrl: url, code: submitted }),
              `${label} /apc/pair`,
            );
            const approved = await adapter.approve(id, approvedWith);
            expect(approved.ok, `${label}: expected approve("${approvedWith}") to match "${submitted}", got ${JSON.stringify(approved)}`);
            expectConfirmSuccess(await confirmApp(adapter, url), "paired", `${label} /apc/confirm`);
          });
        }

        check.note = policyNote;
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
          const id1 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "5th-wrong pair");
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
          expectNotPaired(await confirmApp(adapter, url1), "confirm after 5th wrong code");

          // Expiry gives back the grant.
          const url2 = app.mintGrantUrl();
          const id2 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_A }), "expiry pair");
          await adapter.advance(PAIRING_CODE_TTL_MS + 1000);
          const lateApprove = await adapter.approve(id2, VALID_CODE_A);
          expect(!lateApprove.ok, "approve after pairing code TTL must fail");
          await waitForRevoke(adapter, app, url2, "pairing expiry");

          // Deny gives back the grant.
          const url3 = app.mintGrantUrl();
          const id3 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url3, code: VALID_CODE_A }), "deny pair");
          const denied = await adapter.deny(id3);
          expect(denied.ok, `deny must succeed, got ${JSON.stringify(denied)}`);
          await waitForRevoke(adapter, app, url3, "deny");
          expectNotPaired(await confirmApp(adapter, url3), "confirm after deny");
        });
      },
    },

    {
      id: "hub.no-mcp-before-approval",
      name: "sends no MCP calls before owner approves with the code (including while approving); initialize is first after (H1)",
      rules: ["H1"],
      run: async () => {
        const check = checks.find((c) => c.id === "hub.no-mcp-before-approval")!;
        let note: string | undefined;

        await withApp(adapter, async (app) => {
          const url1 = app.mintGrantUrl();
          const id1 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "H1 pending");
          expect(mcpCalls(app, url1).length === 0, "H1: hub called MCP immediately on /apc/pair");

          const pendingConfirm = await confirmApp(adapter, url1);
          expectConfirmSuccess(pendingConfirm, "pending", "H1 pending confirm");
          expect(mcpCalls(app, url1).length === 0, "H1: hub called MCP on /apc/confirm while pending");

          if (adapter.exerciseAgent) {
            await adapter.exerciseAgent(adapter.agent);
            expect(mcpCalls(app, url1).length === 0, "H1: agent call triggered MCP while pending");
          } else {
            note = "adapter.exerciseAgent not provided; skipped agent-triggered pre-approval MCP gating checks.";
          }

          await adapter.approve(id1, pairCodeWrong(0));
          expect(mcpCalls(app, url1).length === 0, "H1: hub called MCP after wrong code");

          if (adapter.exerciseAgent) {
            await adapter.exerciseAgent(adapter.agent);
            expect(mcpCalls(app, url1).length === 0, "H1: agent call triggered MCP after wrong code");
          }

          const denied = await adapter.deny(id1);
          expect(denied.ok, "deny failed");
          expect(mcpCalls(app, url1).length === 0, "H1: hub called MCP on deny");

          // Test the approving window while MCP initialize is still in flight.
          const url2 = app.mintGrantUrl();
          const id2 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_A }), "H1 approve");
          expect(mcpCalls(app, url2).length === 0, "H1: hub called MCP before approve");

          app.mcpMode = "hold_initialize";
          const approvePromise = adapter.approve(id2, VALID_CODE_A);
          let ok: ApcHubApproveResult;
          try {
            await app.waitForInitialize();
            const duringInitCalls = mcpCalls(app, url2);
            expect(
              duringInitCalls.length === 1 && duringInitCalls[0]?.rpcMethod === "initialize",
              `H1: only a single initialize may run while approving, got ${JSON.stringify(duringInitCalls.map((c) => c.rpcMethod))}`,
            );

            expectConfirmSuccess(await confirmApp(adapter, url2), "pending", "H1 /apc/confirm while approving");

            if (adapter.exerciseAgent) {
              await adapter.exerciseAgent(adapter.agent);
              expect(
                mcpCalls(app, url2).length === 1,
                "H1: agent call triggered non-initialize MCP traffic before initialize settled",
              );
            }

            // Extra wrong codes while approving must not consume attempts, trigger extra initialize, or revoke the grant.
            for (let i = 0; i < PAIRING_CODE_MAX_ATTEMPTS; i += 1) {
              const extra = await adapter.approve(id2, pairCodeWrong(i));
              expect(!extra.ok, `H1: approve while approving #${i + 1} must not succeed`);
            }
            expect(mcpCalls(app, url2).length === 1, "H1: extra approve while approving sent duplicate MCP traffic");
            expect(!app.revokes.includes(url2), "H1: wrong codes while approving revoked the grant");

            app.mcpMode = "ok";
            app.releaseInitialize();
            ok = await withRealTimeout(approvePromise, 1000, "H1: approve did not settle after initialize released");
          } finally {
            app.mcpMode = "ok";
            app.releaseInitialize();
          }

          expect(ok.ok, `H1: approve with valid code failed: ${JSON.stringify(ok)}`);
          expectConfirmSuccess(await confirmApp(adapter, url2), "paired", "H1 /apc/confirm after approve");
          const calls = mcpCalls(app, url2);
          expect(calls.length >= 1, "H1: hub never sent initialize after approval");
          expect(calls[0]?.rpcMethod === "initialize", `H1: first MCP call must be initialize, got ${calls[0]?.rpcMethod}`);
        });

        check.note = note;
      },
    },

    {
      id: "hub.confirm-expires-overdue",
      name: "/apc/confirm expires overdue pending requests before answering and leaves ticket unspent (H2)",
      rules: ["H2"],
      run: async () => {
        await withApp(adapter, async (app) => {
          const url1 = app.mintGrantUrl();
          expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "H2 pair");

          const before = await confirmApp(adapter, url1);
          expectConfirmSuccess(before, "pending", "H2 pending confirm before expiry");

          // Take the drop ticket before advancing; PAIRING_CODE_TTL_MS < TICKET_TTL_MS.
          const confirmTicket = await adapter.ticket(adapter.agent);
          await adapter.advance(PAIRING_CODE_TTL_MS + 1000);

          const overdue = await confirmApp(adapter, url1, confirmTicket);
          expectNotPaired(overdue, "H2 overdue /apc/confirm");
          await waitForRevoke(adapter, app, url1, "H2 overdue confirm");

          // Verify confirmTicket remained unspent when /apc/confirm returned not_paired.
          const url2 = app.mintGrantUrl();
          const id2 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_B }), "H2 re-pair");
          const approved = await adapter.approve(id2, VALID_CODE_B);
          expect(approved.ok, `H2: approve url2 failed: ${JSON.stringify(approved)}`);

          const reusedConfirm = await confirmApp(adapter, url2, confirmTicket);
          expectConfirmSuccess(reusedConfirm, "paired", "H2 confirm with unspent ticket");
        });
      },
    },

    {
      id: "hub.replace-pending",
      name: "/apc/pair replaces unapproved pending pairing for (agent, origin), resets attempts, revokes diff URL async, keeps approving and paired (H3)",
      rules: ["H3"],
      run: async () => {
        await withApp(adapter, async (app) => {
          // 1. Replacing a pending request with a different URL starts attempts at 0 and revokes asynchronously.
          const url1 = app.mintGrantUrl();
          const id1 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "H3 first pending");
          for (let i = 0; i < PAIRING_CODE_MAX_ATTEMPTS - 1; i += 1) {
            const wrong = await adapter.approve(id1, pairCodeWrong(i));
            expect(!wrong.ok, "wrong attempt on id1 should fail");
          }

          app.revokeMode = "slow";
          const url2 = app.mintGrantUrl();
          let id2: string;
          try {
            const replacement = await withRealTimeout(
              pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_B }),
              400,
              "H3: /apc/pair blocked synchronously on slow /apc/revoke",
            );
            id2 = expectPairSuccess(replacement, "H3 replacement");
          } finally {
            app.revokeMode = "ok";
            app.releaseRevoke();
          }
          expect(id2 !== id1, "H3: replacement pairing should get a new pairing_id");
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
          expectConfirmSuccess(confirmUrl2, "paired", "H3 paired pairing preservation");
          expect(!app.revokes.includes(url2), "H3: already-paired URL must not be revoked");

          // 3. Re-pairing pending request with the SAME URL does not revoke that URL.
          const sameUrl = app.mintGrantUrl("same000000000001");
          expectPairSuccess(await pairApp(adapter, app, { mcpUrl: sameUrl, code: VALID_CODE_A }), "H3 same URL #1");
          await withRealTimeout(Promise.resolve(adapter.idle?.()), 400, "H3 same URL idle #1");
          expectPairSuccess(await pairApp(adapter, app, { mcpUrl: sameUrl, code: VALID_CODE_B }), "H3 same URL #2");
          await withRealTimeout(Promise.resolve(adapter.idle?.()), 400, "H3 same URL idle #2");
          await new Promise<void>((r) => setTimeout(r, 40));
          expect(!app.revokes.includes(sameUrl), `H3: re-pairing with same URL must not /apc/revoke it, got ${JSON.stringify(app.revokes)}`);
        });

        // 4. An approving pairing (initialize in flight) is never replaced by a new /apc/pair for (agent, origin).
        await withApp(adapter, async (app) => {
          const urlApp = app.mintGrantUrl();
          const idApp = expectPairSuccess(
            await pairApp(adapter, app, { mcpUrl: urlApp, code: VALID_CODE_A }),
            "H3 approving start",
          );
          app.mcpMode = "hold_initialize";
          const approvingPromise = adapter.approve(idApp, VALID_CODE_A);
          let approvedRes: ApcHubApproveResult;
          try {
            await app.waitForInitialize();
            const rivalUrl = app.mintGrantUrl();
            await pairApp(adapter, app, { mcpUrl: rivalUrl, code: VALID_CODE_B });
            expect(!app.revokes.includes(urlApp), "H3: /apc/pair while approving must not revoke approving URL");

            app.mcpMode = "ok";
            app.releaseInitialize();
            approvedRes = await withRealTimeout(approvingPromise, 1000, "H3: approving failed to settle");
          } finally {
            app.mcpMode = "ok";
            app.releaseInitialize();
          }
          expect(approvedRes.ok, `H3: approving approve failed: ${JSON.stringify(approvedRes)}`);
          expectConfirmSuccess(await confirmApp(adapter, urlApp), "paired", "H3: /apc/pair replaced an approving pairing");
          expect(!app.revokes.includes(urlApp), "H3: approving URL must not be revoked after settling");
        });
      },
    },

    {
      id: "hub.ended-pairing",
      name: "404 on MCP ends pairing with pairing_ended tombstone, answers not_paired on /apc/confirm, allows re-pair (H5)",
      rules: ["H5"],
      run: async () => {
        const check = checks.find((c) => c.id === "hub.ended-pairing")!;
        let note: string | undefined;

        await withApp(adapter, async (app) => {
          app.mcpMode = "not_found";
          const url1 = app.mintGrantUrl();
          const id1 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url1, code: VALID_CODE_A }), "H5 pair");

          const res = await adapter.approve(id1, VALID_CODE_A);
          expect(!res.ok, `H5: approve on 404 grant must fail, got ${JSON.stringify(res)}`);
          expect(res.error === PAIRING_ENDED_ERROR, `H5: expected error "${PAIRING_ENDED_ERROR}", got ${JSON.stringify(res)}`);

          // Ended tombstone stays intact until replaced by re-pairing.
          const resAgain = await adapter.approve(id1, VALID_CODE_A);
          expect(
            !resAgain.ok && resAgain.error === PAIRING_ENDED_ERROR,
            `H5: repeated approve on ended pairing must keep "${PAIRING_ENDED_ERROR}" tombstone, got ${JSON.stringify(resAgain)}`,
          );

          const confirm1 = await confirmApp(adapter, url1);
          expectNotPaired(confirm1, "H5 ended /apc/confirm");

          app.mcpMode = "ok";
          const url2 = app.mintGrantUrl();
          const id2 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_B }), "H5 re-pair");
          const approved2 = await adapter.approve(id2, VALID_CODE_B);
          expect(approved2.ok, `H5: re-pair after ended pairing failed: ${JSON.stringify(approved2)}`);
        });

        if (adapter.exerciseAgent) {
          await withApp(adapter, async (app) => {
            const url3 = app.mintGrantUrl();
            const id3 = expectPairSuccess(
              await pairApp(adapter, app, { mcpUrl: url3, code: VALID_CODE_A }),
              "H5 post-pair initial",
            );
            const approved3 = await adapter.approve(id3, VALID_CODE_A);
            expect(approved3.ok, `H5 post-pair approve failed: ${JSON.stringify(approved3)}`);
            expectConfirmSuccess(await confirmApp(adapter, url3), "paired", "H5 post-pair initial confirm");

            app.mcpMode = "not_found";
            await adapter.exerciseAgent!(adapter.agent);
            await withRealTimeout(Promise.resolve(adapter.idle?.()), 400, "H5 post-pair idle");

            expectNotPaired(await confirmApp(adapter, url3), "H5 post-pair 404 /apc/confirm");
            const afterEnd = await adapter.approve(id3, VALID_CODE_A);
            expect(
              !afterEnd.ok && afterEnd.error === PAIRING_ENDED_ERROR,
              `H5: ended pairing after agent 404 must keep "${PAIRING_ENDED_ERROR}" tombstone, got ${JSON.stringify(afterEnd)}`,
            );

            app.mcpMode = "ok";
            const url4 = app.mintGrantUrl();
            const id4 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url4, code: VALID_CODE_B }), "H5 post-pair re-pair");
            const approved4 = await adapter.approve(id4, VALID_CODE_B);
            expect(approved4.ok, `H5 post-pair re-pair approve failed: ${JSON.stringify(approved4)}`);
            expectConfirmSuccess(await confirmApp(adapter, url4), "paired", "H5 post-pair re-pair confirm");
          });
        } else {
          note = "adapter.exerciseAgent not provided; skipped post-approval 404 ending check.";
        }

        check.note = note;
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
          expect(app.apcJsonReads > 0, "apc.json redirect check must fetch apc.json");
          expectRefusal(res1, "redirected apc.json");
          expect(app.redirectHits.length === 0, `hub followed redirect on apc.json: ${app.redirectHits.join(", ")}`);

          app.apcJsonMode = "ok";
          app.mcpMode = "redirect";
          const url2 = app.mintGrantUrl();
          const id2 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url2, code: VALID_CODE_A }), "MCP redirect pair");
          await adapter.approve(id2, VALID_CODE_A);
          expect(mcpCalls(app, url2).length >= 1, "MCP redirect check must attempt initialize");
          expect(app.redirectHits.length === 0, `hub followed redirect on MCP initialize: ${app.redirectHits.join(", ")}`);

          app.mcpMode = "ok";
          app.revokeMode = "redirect";
          const url3 = app.mintGrantUrl();
          const id3 = expectPairSuccess(await pairApp(adapter, app, { mcpUrl: url3, code: VALID_CODE_B }), "revoke redirect pair");
          await adapter.deny(id3);
          await withRealTimeout(Promise.resolve(adapter.idle?.()), 400, "redirect revoke idle");
          expect(
            app.calls.some((c) => c.url === app.revokeUrl),
            "revoke redirect check must attempt /apc/revoke",
          );
          expect(app.redirectHits.length === 0, `hub followed redirect on /apc/revoke: ${app.redirectHits.join(", ")}`);
        });
      },
    },
  ];
  return checks;
}

export async function runHubConformance(adapter: ApcHubAdapter): Promise<HubConformanceReport> {
  const checks = hubConformance(adapter);
  const failed: HubConformanceReport["failed"] = [];
  const notes: NonNullable<HubConformanceReport["notes"]> = [];
  let passed = 0;
  for (const check of checks) {
    try {
      await check.run();
      passed += 1;
      if (check.note) {
        notes.push({ id: check.id, name: check.name, note: check.note });
      }
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
    ...(notes.length > 0 ? { notes } : {}),
  };
}

export { ConformanceError };
