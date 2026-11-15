import test from "node:test";
import assert from "node:assert/strict";
import { ConformanceError, hubConformance, runHubConformance } from "../src/index.ts";
import { hubFixture, type HubBreak } from "./hub-fixture.ts";

test("conforming fixture hub passes every hub conformance check", async () => {
  const report = await runHubConformance(hubFixture());
  assert.equal(report.ok, true, JSON.stringify(report.failed));
  assert.equal(report.passed, hubConformance(hubFixture()).length);
});

const brokenChecks: Array<[HubBreak, string]> = [
  ["accepts-bad-apc-json", "hub.apc-json"],
  ["stale-apc-json", "hub.apc-json-freshness"],
  ["spends-ticket-on-malformed-body", "hub.pair-body-ticket-unspent"],
  ["echoes-pairing-code", "hub.pairing-code"],
  ["no-revoke-on-fifth-wrong", "hub.give-back"],
  ["mcp-before-approval", "hub.no-mcp-before-approval"],
  ["confirm-does-not-expire", "hub.confirm-expires-overdue"],
  ["does-not-replace-pending", "hub.replace-pending"],
  ["revokes-after-404", "hub.ended-pairing"],
  ["follows-redirects", "hub.no-redirects"],
];

for (const [broken, checkId] of brokenChecks) {
  test(`broken fixture "${broken}" fails check "${checkId}" with ConformanceError`, async () => {
    const checks = hubConformance(hubFixture({ broken }));
    const check = checks.find((c) => c.id === checkId);
    assert.ok(check, `missing check ${checkId}`);
    await assert.rejects(check.run, ConformanceError);
  });
}
