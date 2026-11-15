import assert from "node:assert/strict";
import { test } from "node:test";
import { apcConformance, ConformanceError, type ApcDockDropOutcome, type ConformanceCheck } from "../src/index.ts";
import { dockFixture, type FixtureBreak } from "./dock-fixture.ts";

const named = (checks: ConformanceCheck[], part: string) => {
  const found = checks.filter((c) => c.name.includes(part));
  assert.equal(found.length, 1, `one check named ${part}`);
  return found[0]!;
};

// A trap on the old fields proves that neither drop nor connectDock is asked for a code before Allow.
test("Dock code checks consume only Allow results, including a formatted code", async () => {
  const { adapter } = dockFixture();
  const dock = adapter.dock!;
  const drop = dock.drop.bind(dock);
  dock.drop = async (agent, ticket) => {
    const consent = await drop(agent, ticket);
    Object.defineProperty(consent, "shown", { get() { throw new Error("code read before Allow"); } });
    const allow = consent.allow;
    consent.allow = async () => {
      const answer = await allow();
      if (answer.code) answer.code = answer.code.slice(0, 3).toLowerCase() + "-" + answer.code.slice(3).toLowerCase();
      return answer;
    };
    return consent;
  };
  const life = dock.lifecycle!;
  const trap = (outcome: ApcDockDropOutcome) => {
    if (outcome.page === "consent") Object.defineProperty(outcome, "code", { get() { throw new Error("code read before Allow"); } });
    return outcome;
  };
  const dropAgent = life.dropAgent.bind(life);
  const connectDock = life.connectDock!.bind(life);
  life.dropAgent = async (d) => trap(await dropAgent(d));
  life.connectDock = async (url, target) => trap(await connectDock(url, target));
  const checks = apcConformance(adapter);
  for (const check of checks.filter((c) => c.name.includes("(dock): pairing code:"))) await check.run();
  for (const part of ["the pairing code goes only", "a second drop on a pending pairing", "not_paired from", "stored expiry has passed", "the stale Allow gets consent_expired"]) {
    await named(checks, part).run();
  }
});

const broken: Array<[FixtureBreak, string, RegExp]> = [
  ["allow_code_missing", "after Allow the app shows a well-formed code", /not a pairing code/],
  ["allow_code_wrong", "after Allow the app shows a well-formed code", /another code/],
  ["allow_code_reused", "every consent shows a new code", /same code/],
  ["allow_code_missing", "the pairing code goes only", /not a pairing code/],
];
for (const [brk, part, message] of broken) {
  test(`a correct stored code cannot hide a broken Allow response (${brk}): ${part}`, async () => {
    const { adapter } = dockFixture({ break: brk });
    // Keep unrelated setup conforming: only the checks' Allow responses are under test.
    const { adapter: good } = dockFixture();
    adapter.connect = good.connect;
    await assert.rejects(named(apcConformance(adapter), part).run(), (error: unknown) => {
      assert.ok(error instanceof ConformanceError);
      assert.match(error.message, message);
      return true;
    });
  });
}
