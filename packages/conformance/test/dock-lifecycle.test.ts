/**
 * The suite's Dock checks of APC 0.10 (TIN-884), tested: a minimal conforming app (`dock-fixture.ts`) passes every
 * one, the designs the spec allows pass too, and for every check (and most of the rules inside one) an app or an
 * adapter broken in one way fails it. A check that passes a broken app is worse than none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apcConformance, ConformanceError, type ApcAppAdapter, type ConformanceCheck } from "../src/index.ts";
import { dockFixture, type FixtureBreak, type FixtureOptions } from "./dock-fixture.ts";

const ours = (checks: ConformanceCheck[]) => checks.filter((c) => c.name.includes("(dock): 0.10: "));
const named = (checks: ConformanceCheck[], part: string) => {
  const found = ours(checks).filter((c) => c.name.includes(part));
  assert.equal(found.length, 1, `one 0.10 check named "${part}", found ${found.length}`);
  return found[0]!;
};
const fails = async (check: ConformanceCheck, message: RegExp) =>
  assert.rejects(check.run(), (error: unknown) => {
    assert.ok(error instanceof ConformanceError, `a ConformanceError, not ${String(error)}`);
    assert.match(error.message, message);
    return true;
  });
const NOTE_FREE = /M5/;

{
  const { adapter } = dockFixture();
  const checks = ours(apcConformance(adapter));
  test("the suite has the 0.10 Dock checks", () => assert.equal(checks.length, 31));
  for (const check of checks) {
    test(`the conforming fixture passes: ${check.name}`, async () => {
      await check.run();
      if (NOTE_FREE.test(check.name)) assert.match(check.note ?? "", /refused with pairing_in_progress/, "the M5 probe says what it saw");
      else assert.equal(check.note, undefined, `no note: ${check.note}`);
    });
  }
}

/** Designs the spec allows: each passes the checks it bears on. */
const allowed: Array<[string, FixtureOptions, string[], RegExp?]> = [
  ["an app that does not sleep", { idle: false }, ["the answer table: dormant", "T_idle:", "agent traffic", "precedence"], /does not sleep/],
  ["an app whose Allow carries no hub (bound to the consent on the server)", { hubBoundToConsent: true }, ["M1:", "M5:", "M6:", "the stale Allow"]],
  ["an app that makes a second drop of the same agent wait for the first Allow", { dropWaits: true }, ["M5:"], /waited for the first, then answered: waiting/],
  ["an app whose heartbeat is a WebSocket", { wsHeartbeat: true }, ["M6:"]],
  ["an app that keeps the hub call's deadline with AbortSignal.timeout on the fetch", { abortSignalDeadline: true }, ["M3:"]],
];
for (const [what, options, parts, note] of allowed) {
  test(`${what} passes`, async () => {
    const { adapter } = dockFixture(options);
    for (const part of parts) {
      const check = named(apcConformance(adapter), part);
      await check.run();
      if (note) assert.match(check.note ?? "", note, check.name);
    }
  });
}

test("an app that claims a standard before 0.10 skips the 0.10 checks with a note, and only then", async () => {
  const { adapter } = dockFixture();
  const inner = adapter.fetch!;
  const older: ApcAppAdapter = {
    ...adapter,
    fetch: async (request: Request) => {
      if (!request.url.endsWith("/.well-known/apc.json")) return inner(request);
      const body = (await (await inner(request)).json()) as Record<string, unknown>;
      return Response.json({ ...body, standard: "0.9.0" });
    },
  };
  for (const check of ours(apcConformance(older))) {
    await check.run();
    assert.match(check.note ?? "", /claims 0\.9\.0, before 0\.10\.0/);
  }
});

/** Adapters broken so that the suite cannot classify or run the app: every 0.10 check fails, none skips. */
const unclassifiable: Array<[string, (a: ApcAppAdapter) => ApcAppAdapter, RegExp]> = [
  ["an adapter without dock.lifecycle", (a) => ({ ...a, dock: { hub: a.dock!.hub, drop: a.dock!.drop } }), /give dock\.lifecycle/],
  ["an owner origin with a trailing slash", (a) => a, /not a bare origin/],
  ["an apc.json the suite cannot read", (a) => a, /cannot tell which standard/],
  ["an adapter without restart", (a) => a, /give dock\.lifecycle\.restart/],
];
const unclassifiableBreaks: Record<string, FixtureBreak | undefined> = {
  "an owner origin with a trailing slash": "owner_origin_slash",
  "an apc.json the suite cannot read": "apc_json_unreadable",
  "an adapter without restart": "no_restart",
};
for (const [what, shape, message] of unclassifiable) {
  test(`${what} fails every 0.10 check, closed`, async () => {
    const brk = unclassifiableBreaks[what];
    const { adapter } = dockFixture(brk ? { break: brk } : {});
    for (const check of ours(apcConformance(shape(adapter)))) await fails(check, message);
  });
}

/** Each broken app (or adapter), the check that must fail it, and what the failure says. */
const broken: Array<[FixtureBreak, string, RegExp, FixtureOptions?]> = [
  ["owner_origin_elsewhere", "owner origin is the app's", /grants live at https:\/\/fixture\.test/],
  ["in_flight_serves", "the answer table: in flight", /in in_flight answers HTTP 404/],
  ["any_request_405", "the answer table: in flight", /a GET in in_flight answers HTTP 404/],
  ["any_request_405", "the answer table: ended", /a GET in ended answers HTTP 404/],
  ["notification_by_id_only", "the answer table: handoff", /notifications\/cancelled \(with an id\) in handoff is ignored with HTTP 202/],
  ["handoff_serves_data", "the answer table: handoff", /tool error/],
  ["attention_in_handoff", "the answer table: handoff", /carries attention/],
  ["presence_in_handoff", "the answer table: handoff", /presence event/],
  ["tool_error_text_only", "the answer table: handoff", /structuredContent too/],
  ["initialize_no_commit", "the answer table: live", /serves app data/],
  ["idle_without_flag", "the answer table: dormant", /idle: true/],
  ["attention_in_dormant", "the answer table: dormant", /carries attention/],
  ["ended_answers_revoked", "the answer table: ended", /in ended answers HTTP 404/],
  ["revoked_answers_404", "the answer table: revoked", /in revoked answers HTTP 403/],
  ["initialize_swallows_write_error", "initialize fails closed", /HTTP 500 or JSON-RPC -32603/],
  ["commit_after_cancel", "racing Cancel or a give-back", /Cancel/],
  ["commit_ignores_end", "racing Cancel or a give-back", /after both/],
  ["cancel_live", "Cancel revokes only in handoff", /live grant/],
  ["cancel_unserved_live", "Cancel revokes only in handoff", /has not served a call/],
  ["cancel_ended", "Cancel revokes only in handoff", /ended grant/],
  ["ack_unconditional", "the acknowledgement's move is conditional", /give-back/],
  ["t_ack_ignored", "the acknowledgement's move is conditional", /T_ack/],
  ["t_ack_ignored", "across a restart", /pairing_in_progress/],
  ["t_connect_ignored", "T_connect", /expected 404 \(ended\)/],
  ["heartbeat_does_not_wake", "T_idle:", /after the page's heartbeat/],
  ["drop_does_not_wake", "T_idle:", /confirmed drop/],
  ["traffic_wakes", "agent traffic", /must not extend/],
  ["dormant_over_handoff", "precedence", /in handoff for longer than T_idle/],
  ["dormant_over_revoked", "precedence", /in revoked answers HTTP 403/],
  ["dormant_over_ended", "precedence", /in ended answers HTTP 404/],
  ["allowlist_by_origin_only", "M1:", /hub_not_allowed/],
  ["no_allow_recheck", "M1:", /an Allow sent with hub/],
  ["follows_redirects", "M2:", /redirect/],
  ["follows_then_checks_redirected", "M2:", /reached https:\/\/elsewhere\.example/],
  ["ignores_redirected_flag", "M2:", /answers redirected, the Allow says it paired/],
  ["ignores_opaqueredirect", "M2:", /answers opaque_redirect, the Allow says it paired/],
  ["ignores_3xx", "M2:", /answers status_3xx, the Allow says it paired/],
  ["no_deadline_on_headers", "M3:", /answers slow_headers, the Allow was still waiting/],
  ["no_deadline_on_body", "M3:", /answers slow_body, the Allow was still waiting/],
  ["deadline_per_part", "M3:", /answers slow_headers_then_body, the Allow says it paired/],
  ["trusts_content_length", "M4:", /must refuse the answer/],
  ["content_length_number_parse", "M4:", /answers length_not_digits, the Allow says it paired/],
  ["no_stream_cap", "M4:", /answers body_over_cap, the Allow says it paired/],
  ["compares_lengths", "M4:", /answers length_mismatch, the Allow did not pair/],
  ["lock_across_call", "M5:", /no lock may be held/],
  ["second_consent_while_in_flight", "M5:", /answers pairing_in_progress \(or waits\)/],
  ["double_allow_not_refused", "M5:", /a second Allow while the first waits on the hub answers pairing_in_progress/],
  ["raw_hub_string", "M9:", /the Allow failed .*https:\/\/dock\.test\/\/apc\/pair/],
  ["raw_hub_on_confirm", "M9:", /a second drop shows the waiting card.*https:\/\/dock\.test\/\/apc\/confirm/],
  ["no_origin_check", "M6:", /is refused \(4xx\)/],
  ["origin_from_request_url", "M6:", /Origin https:\/\/apc-conformance-internal\.example, the request's own host/],
  ["heartbeat_no_origin_check", "M6:", /the heartbeat: a request with a foreign Origin is refused/],
  ["ws_no_origin_check", "M6:", /the heartbeat: a WebSocket handshake with a foreign Origin is refused/, { wsHeartbeat: true }],
  ["get_changes_state", "M6:", /after a GET with the owner.s session and the body.s fields as a query \(every state change is a POST\)/],
  ["no_cancel_endpoint", "M6:", /give dock\.lifecycle\.owner\.cancel/],
  ["revoke_404_unknown", "M7:", /expected 200/],
  ["revoke_reads_all", "M7:", /never ends/],
  ["giveback_ends_revoked", "M7:", /revoked stays revoked/],
  ["dock_always_listed", "M8:", /still lists dock/],
  ["max_age_300", "M8:", /more than 60/],
  ["code_in_confirm", "the pairing code goes only", /outside \/apc\/pair/],
  ["new_code_on_pending", "a second drop on a pending pairing", /waiting card/],
  ["keeps_first_pin", "a second drop on a pending pairing", /second drop's target/],
  ["keeps_grant_on_not_paired", "not_paired from", /answers 404/],
  ["ignores_stored_expiry", "stored expiry has passed", /past the stored expiry/],
  ["confirm_paired_goes_live", "paired before the app saw initialize", /pairing error \(handoff\)/],
  ["stale_allow_accepted", "the stale Allow gets consent_expired", /consent_expired/],
];

for (const [brk, part, message, options] of broken) {
  test(`a broken app (${brk}) fails: ${part}`, async () => {
    const { adapter } = dockFixture({ ...options, break: brk });
    await fails(named(apcConformance(adapter), part), message);
  });
}

test("every 0.10 check has a broken app that fails it", () => {
  const { adapter } = dockFixture();
  const covered = new Set(broken.map(([, part]) => named(apcConformance(adapter), part).name));
  assert.deepEqual(ours(apcConformance(adapter)).map((c) => c.name).filter((n) => !covered.has(n)), []);
});
