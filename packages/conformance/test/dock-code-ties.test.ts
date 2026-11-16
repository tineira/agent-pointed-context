import assert from "node:assert/strict";
import { test } from "node:test";
import { apcConformance, ConformanceError } from "../src/index.ts";
import { dockFixture, type FixtureBreak } from "./dock-fixture.ts";

const regressions: Array<[FixtureBreak, string]> = [
  ["consent_code_wrong", "the pairing code goes only"],
  ["consent_code_invalid", "the pairing code goes only"],
  ["consent_code_wrong", "well-formed code"],
  ["pair_code_reused", "every consent"],
  ["reconsent_code_reused", "not_paired from"],
  ["reconsent_code_reused", "stored expiry has passed"],
  ["reconsent_waiting_code_wrong", "not_paired from"],
  ["reconsent_waiting_code_wrong", "stored expiry has passed"],
  ["transmitted_code_in_confirm", "the pairing code goes only"],
  ["transmitted_code_in_mcp", "the pairing code goes only"],
  ["replacement_code_reused", "the stale Allow gets consent_expired"],
];
for (const [brk, part] of regressions) {
  test(`code tie regression (${brk}): ${part}`, async () => {
    const { adapter } = dockFixture({ break: brk });
    // Gate setup stays conforming; only the check's grants exercise the fault.
    adapter.connect = dockFixture().adapter.connect;
    const checks = apcConformance(adapter).filter((c) => c.name.includes(part));
    assert.equal(checks.length, 1);
    await assert.rejects(checks[0]!.run(), ConformanceError);
  });
}

test("a displayed replaced code is compared even when the replacement withholds its code until Allow", async () => {
  const { adapter } = dockFixture({ break: "replacement_code_reused" });
  adapter.connect = dockFixture().adapter.connect;
  const life = adapter.dock!.lifecycle!;
  let consents = 0;
  const observe = (outcome: Awaited<ReturnType<typeof life.dropAgent>>) => {
    if (outcome.page === "consent" && ++consents > 1) {
      const { code: _code, ...withoutCode } = outcome;
      return withoutCode;
    }
    return outcome;
  };
  const dropAgent = life.dropAgent.bind(life);
  const connectDock = life.connectDock!.bind(life);
  life.dropAgent = async (drop) => observe(await dropAgent(drop));
  life.connectDock = async (url, target) => observe(await connectDock(url, target));
  const check = apcConformance(adapter).find((c) => c.name.includes("the stale Allow gets consent_expired"))!;
  await assert.rejects(check.run(), ConformanceError);
});
