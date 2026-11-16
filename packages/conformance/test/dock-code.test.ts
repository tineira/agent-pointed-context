import assert from "node:assert/strict";
import { test } from "node:test";
import { apcConformance, ConformanceError, type ConformanceCheck } from "../src/index.ts";
import { dockFixture, type FixtureBreak } from "./dock-fixture.ts";

const named = (checks: ConformanceCheck[], part: string) => {
  const found = checks.filter((c) => c.name.includes(part));
  assert.equal(found.length, 1, `one check named ${part}`);
  return found[0]!;
};

// An app may withhold its code until Allow; optional consent codes stay absent.
test("an app withholding the code until Allow passes all Dock checks, including a formatted code", async () => {
  const { adapter } = dockFixture({ withholdCode: true });
  const dock = adapter.dock!;
  const drop = dock.drop.bind(dock);
  dock.drop = async (agent, ticket) => {
    const consent = await drop(agent, ticket);
    assert.equal(Object.hasOwn(consent, "code"), false);
    const allow = consent.allow;
    consent.allow = async () => {
      const answer = await allow();
      if (answer.code) answer.code = answer.code.slice(0, 3).toLowerCase() + "-" + answer.code.slice(3).toLowerCase();
      return answer;
    };
    return consent;
  };
  const life = dock.lifecycle!;
  const trap = (outcome: Awaited<ReturnType<typeof life.dropAgent>>) => {
    if (outcome.page === "consent") assert.equal(Object.hasOwn(outcome, "code"), false);
    return outcome;
  };
  const dropAgent = life.dropAgent.bind(life);
  const connectDock = life.connectDock!.bind(life);
  life.dropAgent = async (d) => trap(await dropAgent(d));
  life.connectDock = async (url, target) => trap(await connectDock(url, target));
  const checks = apcConformance(adapter);
  for (const check of checks.filter((c) => /\(dock\): (?:pairing code:|consent:|0\.10:|0\.12:|0\.13:)/.test(c.name))) await check.run();
});

const broken: Array<[FixtureBreak, string, RegExp]> = [
  ["allow_code_missing", "well-formed code", /not a pairing code/],
  ["allow_code_wrong", "well-formed code", /another code/],
  ["allow_code_reused", "every consent", /another code/],
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
