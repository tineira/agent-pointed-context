import test from "node:test";
import assert from "node:assert/strict";
import { ConformanceError, hubConformance, runHubConformance } from "../src/index.ts";
import { hubFixture, type HubBreak } from "./hub-fixture.ts";

test("conforming fixture hub passes every hub conformance check without policy notes", async () => {
  const report = await runHubConformance(hubFixture());
  assert.equal(report.ok, true, JSON.stringify(report.failed));
  assert.equal(report.passed, hubConformance(hubFixture()).length);
  assert.equal(report.notes, undefined);
});

test("conforming fixture using redirect: error passes every hub conformance check", async () => {
  const report = await runHubConformance(hubFixture({ redirectPolicy: "error" }));
  assert.equal(report.ok, true, JSON.stringify(report.failed));
});

test("hub accepting codeless /apc/pair passes with declared policy note when requiresPairingCode is false", async () => {
  const report = await runHubConformance(
    hubFixture({
      broken: "accepts-codeless",
      requiresPairingCode: false,
      codelessPolicyNote: "Hub allows codeless pairing under its own test policy.",
    }),
  );
  assert.equal(report.ok, true, JSON.stringify(report.failed));
  assert.ok(report.notes?.some((n) => n.id === "hub.pairing-code" && n.note.includes("test policy")));
});

const brokenChecks: Array<[HubBreak, string]> = [
  ["accepts-bad-apc-json", "hub.apc-json"],
  ["ignores-mcp-path", "hub.apc-json"],
  ["ignores-mcp-endpoints", "hub.apc-json"],
  ["stale-apc-json", "hub.apc-json-freshness"],
  ["stale-apc-json-network", "hub.apc-json-freshness"],
  ["spends-ticket-on-malformed-body", "hub.pair-body-ticket-unspent"],
  ["accepts-codeless", "hub.pairing-code"],
  ["returns-201-on-pair", "hub.pair-body-ticket-unspent"],
  ["returns-201-on-confirm", "hub.pairing-code"],
  ["echoes-pairing-code", "hub.pairing-code"],
  ["echoes-code-in-pending-confirm", "hub.pairing-code"],
  ["no-owner-code-normalization", "hub.pairing-code"],
  ["no-revoke-on-fifth-wrong", "hub.give-back"],
  ["mcp-before-approval", "hub.no-mcp-before-approval"],
  ["mcp-on-agent-call-before-approval", "hub.no-mcp-before-approval"],
  ["counts-code-while-approving", "hub.no-mcp-before-approval"],
  ["confirm-does-not-expire", "hub.confirm-expires-overdue"],
  ["does-not-replace-pending", "hub.replace-pending"],
  ["replaces-approving", "hub.replace-pending"],
  ["sync-revoke-on-replace", "hub.replace-pending"],
  ["deletes-ended-tombstone", "hub.ended-pairing"],
  ["follows-redirects", "hub.no-redirects"],
  ["accepts-drop-ticket-on-pair", "hub.pair-ticket"],
  ["spends-drop-ticket-on-pair", "hub.pair-ticket"],
  ["ignores-connect-ticket-origin", "hub.pair-ticket"],
  ["spends-mismatched-connect-ticket", "hub.pair-ticket"],
  ["unauth-approve-exposes-ticket", "hub.connect-ticket-containment"],
  ["no-owner-csrf", "hub.connect-ticket-containment"],
  ["preapproval-ticket-leak", "hub.connect-ticket-containment"],
  ["preapproval-ticket-leak-nested", "hub.connect-ticket-containment"],
  ["preapproval-ticket-leak-fragment", "hub.connect-ticket-containment"],
  ["state-exposes-connect-ticket", "hub.connect-ticket-containment"],
  ["double-approve-mints-ticket", "hub.connect-ticket-containment"],
];

for (const [broken, checkId] of brokenChecks) {
  test(`broken fixture "${broken}" fails check "${checkId}" with ConformanceError`, async () => {
    const checks = hubConformance(hubFixture({ broken }));
    const check = checks.find((c) => c.id === checkId);
    assert.ok(check, `missing check ${checkId}`);
    await assert.rejects(check.run, ConformanceError);
  });
}

test("H10 detects removed CSRF protection and independent leaked tickets for the intended reason", async () => {
  for (const broken of ["no-owner-csrf", "preapproval-ticket-leak", "preapproval-ticket-leak-nested", "preapproval-ticket-leak-fragment"] as const) {
    const check = hubConformance(hubFixture({ broken })).find((c) => c.id === "hub.connect-ticket-containment")!;
    await assert.rejects(check.run, broken === "no-owner-csrf" ? /authenticated cross-site approve succeeded/ : /candidate can pair before owner approval/);
  }
});

test("H10 cannot pass without both owner-route probes or with an unauthenticated owner transport", async () => {
  for (const missing of ["ownerFetch", "connectApproveEndpoint"] as const) {
    const adapter = hubFixture();
    delete adapter[missing];
    const report = await runHubConformance(adapter);
    assert.ok(report.failed.some((c) => c.id === "hub.connect-ticket-containment" && c.error.includes(missing)));
  }
  const adapter = hubFixture();
  adapter.ownerFetch = adapter.fetch;
  await assert.rejects(hubConformance(adapter).find((c) => c.id === "hub.connect-ticket-containment")!.run, /authenticated same-origin approve failed/);
});

test("waitForRevoke and async revoke timeouts still fail promptly when Date is frozen", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  for (const [broken, checkId] of [
    ["no-revoke-on-fifth-wrong", "hub.give-back"],
    ["sync-revoke-on-replace", "hub.replace-pending"],
  ] as const) {
    const checks = hubConformance(hubFixture({ broken }));
    const check = checks.find((c) => c.id === checkId);
    assert.ok(check, `missing check ${checkId}`);
    await assert.rejects(check.run, ConformanceError);
  }
});
