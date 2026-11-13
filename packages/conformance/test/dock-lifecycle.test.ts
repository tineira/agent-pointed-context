/**
 * The suite's Dock checks of APC 0.10 (TIN-884), tested: a minimal conforming app (`dock-fixture.ts`) passes every
 * one, and for every check an app broken in one way fails it. A check that passes a broken app is worse than none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apcConformance, ConformanceError, type ConformanceCheck } from "../src/index.ts";
import { dockFixture, type FixtureBreak } from "./dock-fixture.ts";

const ours = (checks: ConformanceCheck[]) => checks.filter((c) => c.name.includes("(dock): 0.10: "));
const named = (checks: ConformanceCheck[], part: string) => {
  const found = ours(checks).filter((c) => c.name.includes(part));
  assert.equal(found.length, 1, `one 0.10 check named "${part}", found ${found.length}`);
  return found[0]!;
};

{
  const { adapter } = dockFixture();
  const checks = ours(apcConformance(adapter));
  test("the suite has the 0.10 Dock checks", () => assert.equal(checks.length, 27));
  for (const check of checks) {
    test(`the conforming fixture passes: ${check.name}`, async () => {
      await check.run();
      if (check.name.includes("M5")) assert.match(check.note ?? "", /new drop of the agent whose Allow was held answered: refused \(pairing_in_progress\)/, "the M5 probe says what it saw");
      else assert.equal(check.note, undefined, `no note: ${check.note}`);
    });
  }
}

test("an app that does not sleep passes, and the dormant checks say why they did not run", async () => {
  const { adapter } = dockFixture({ idle: false });
  for (const part of ["the answer table: dormant", "T_idle", "agent traffic"]) {
    const check = named(apcConformance(adapter), part);
    await check.run();
    assert.match(check.note ?? "", /does not sleep/);
  }
});

test("an app that claims 0.10 on the Dock profile without dock.lifecycle fails every 0.10 check", async () => {
  const { adapter } = dockFixture();
  const { lifecycle: _lifecycle, ...dock } = adapter.dock!;
  for (const check of ours(apcConformance({ ...adapter, dock }))) await assert.rejects(check.run(), /give dock\.lifecycle/, check.name);
});

test("an app that claims a standard before 0.10 passes the 0.10 checks with a note, not checked", async () => {
  const { adapter } = dockFixture();
  const inner = adapter.fetch!;
  const older = {
    ...adapter,
    fetch: async (request: Request) => {
      if (!request.url.endsWith("/.well-known/apc.json")) return inner(request);
      const body = (await (await inner(request)).json()) as Record<string, unknown>;
      return Response.json({ ...body, standard: "0.9.0" });
    },
  };
  for (const check of ours(apcConformance(older))) {
    await check.run();
    assert.match(check.note ?? "", /before 0\.10\.0/);
  }
});

/** Each broken app, and the check that must fail it, with what the failure says. */
const broken: Array<[FixtureBreak, string, RegExp]> = [
  ["in_flight_serves", "the answer table: in flight", /in in_flight answers HTTP 404/],
  ["handoff_serves_data", "the answer table: handoff", /tool error/],
  ["attention_in_handoff", "the answer table: handoff", /carries attention/],
  ["tool_error_text_only", "the answer table: handoff", /structuredContent too/],
  ["initialize_no_commit", "the answer table: live", /serves app data/],
  ["idle_without_flag", "the answer table: dormant", /idle: true/],
  ["ended_answers_revoked", "the answer table: ended", /in ended answers HTTP 404/],
  ["revoked_answers_404", "the answer table: revoked", /in revoked answers HTTP 403/],
  ["initialize_swallows_write_error", "initialize fails closed", /HTTP 500 or JSON-RPC -32603/],
  ["cancel_live", "a commit racing Cancel", /Cancel/],
  ["ack_unconditional", "the acknowledgement's move is conditional", /give-back/],
  ["t_ack_ignored", "the acknowledgement's move is conditional", /T_ack/],
  ["t_ack_ignored", "across a restart", /pairing_in_progress/],
  ["t_connect_ignored", "T_connect", /expected 404 \(ended\)/],
  ["heartbeat_does_not_wake", "T_idle", /after the page's heartbeat/],
  ["traffic_wakes", "agent traffic", /must not extend/],
  ["allowlist_by_origin_only", "M1", /hub_not_allowed/],
  ["follows_redirects", "M2", /redirect/],
  ["no_deadline_on_body", "M3", /still waiting/],
  ["trusts_content_length", "M4", /must refuse the answer/],
  ["lock_across_call", "M5", /no lock may be held/],
  ["raw_hub_string", "M9", /expected https:\/\/dock\.test\/apc\/pair/],
  ["no_origin_check", "M6", /is refused \(4xx\)/],
  ["revoke_404_unknown", "M7", /expected 200/],
  ["dock_always_listed", "M8", /still lists dock/],
  ["max_age_300", "M8", /more than 60/],
  ["new_code_on_pending", "a second drop on a pending pairing", /waiting card/],
  ["keeps_grant_on_not_paired", "not_paired", /answers 404/],
  ["confirm_paired_goes_live", "paired before the app saw initialize", /pairing error \(handoff\)/],
  ["stale_allow_accepted", "the stale Allow gets consent_expired", /consent_expired/],
];

for (const [brk, part, message] of broken) {
  test(`a broken app (${brk}) fails: ${part}`, async () => {
    const { adapter } = dockFixture({ break: brk });
    await assert.rejects(named(apcConformance(adapter), part).run(), (error: unknown) => {
      assert.ok(error instanceof ConformanceError, `a ConformanceError, not ${String(error)}`);
      assert.match(error.message, message);
      return true;
    });
  });
}

test("every 0.10 check has a broken app that fails it", () => {
  const { adapter } = dockFixture();
  const covered = new Set(broken.map(([, part]) => named(apcConformance(adapter), part).name));
  const gate = ours(apcConformance(adapter)).find((c) => c.name.includes("the lifecycle adapter is given"))!.name;
  covered.add(gate); // failed by the adapter without dock.lifecycle, above
  assert.deepEqual(ours(apcConformance(adapter)).map((c) => c.name).filter((n) => !covered.has(n)), []);
});
