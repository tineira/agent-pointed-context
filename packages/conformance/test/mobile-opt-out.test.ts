/**
 * A desktop-only app (APC 1.4, TIN-1166): with `"mobile": false` in `apc.json` and a claim of 1.4.0 or later, the
 * suite needs no `page.mobile` and says so in a note. Every other case still fails without the adapter: the key
 * left out or `true`, or a claim before 1.4.0 (that version's rules include Mobile). With the adapter given, the
 * mobile checks run whatever the key says.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { APC_JSON_PATH } from "@tineira/apc-protocol";
import { apcConformance, ConformanceError, type ApcAppAdapter, type ConformanceCheck } from "../src/index.ts";
import { CORE_ORIGIN, coreFixture } from "./core-fixture.ts";

/** The core fixture, with its `apc.json` replaced by `file` and its phone adapter kept or left out. */
function app(file: Record<string, unknown>, withMobile: boolean): ApcAppAdapter {
  const { adapter } = coreFixture();
  const inner = adapter.fetch!;
  const manifest = { name: "Core", origin: CORE_ORIGIN, profiles: ["direct"], mcp: { path: "/mcp/", endpoints: [{ path: "/mcp/{secret}", profiles: ["direct"] }] }, direct: { connect: `${CORE_ORIGIN}/agents` }, ...file };
  return {
    ...adapter,
    fetch: async (request: Request) => (new URL(request.url).pathname === APC_JSON_PATH ? Response.json(manifest) : inner(request)),
    page: withMobile ? adapter.page : { ...adapter.page, mobile: undefined },
  };
}
const mobileChecks = (a: ApcAppAdapter) => apcConformance(a).filter((c) => c.name.includes(": mobile 375x812: "));
const given = (checks: ConformanceCheck[]) => checks.find((c) => c.name.includes("adapter for a phone is given"))!;

test("a desktop-only app that claims 1.4.0 with mobile: false passes without page.mobile, and every mobile check says it was not checked", async () => {
  const checks = mobileChecks(app({ standard: "1.4.0", mobile: false }, false));
  assert.equal(checks.length, 3);
  for (const check of checks) {
    await check.run();
    assert.match(check.note ?? "", /^not checked: /, `${check.name} says it was not checked`);
  }
  assert.match(given(checks).note!, /desktop-only app \("mobile": false, APC 1\.4\)/);
});

test("a later minor with mobile: false is a desktop-only app too", async () => {
  const check = given(mobileChecks(app({ standard: "1.9.0", mobile: false }, false)));
  await check.run();
  assert.match(check.note ?? "", /desktop-only/);
});

for (const [label, file] of [
  ["a claim of 1.3.0 with mobile: false (1.3's rules include Mobile)", { standard: "1.3.0", mobile: false }],
  ["a claim of 1.4.0 with the key left out", { standard: "1.4.0" }],
  ["a claim of 1.4.0 with mobile: true", { standard: "1.4.0", mobile: true }],
  ["a claim of 1.4.0 with mobile: \"false\" (not a boolean)", { standard: "1.4.0", mobile: "false" }],
  ["a claim of 0.6.0 with mobile: false", { standard: "0.6.0", mobile: false }],
] as const) {
  test(`without page.mobile, ${label} still fails`, async () => {
    await assert.rejects(given(mobileChecks(app(file, false))).run(), (error: unknown) => {
      assert.ok(error instanceof ConformanceError);
      assert.match(error.message, /requires the mobile rule to be checked: give page\.mobile/);
      return true;
    });
  });
}

test("the hint names the opt-out, and why a claim before 1.4.0 cannot use it", async () => {
  await assert.rejects(given(mobileChecks(app({ standard: "1.4.0" }, false))).run(), /declare a desktop-only app with "mobile": false in apc\.json and a claim of 1\.4\.0 or later/);
  await assert.rejects(given(mobileChecks(app({ standard: "1.3.0", mobile: false }, false))).run(), /takes an app out of the rule only from a claim of 1\.4\.0/);
});

test("a claim before 0.6.0 still needs no page.mobile, with no note on the first check", async () => {
  const check = given(mobileChecks(app({ standard: "0.5.0" }, false)));
  await check.run();
  assert.equal(check.note, undefined);
});

test("with page.mobile given, the mobile checks run even when apc.json says mobile: false", async () => {
  for (const check of mobileChecks(app({ standard: "1.4.0", mobile: false }, true))) {
    await check.run();
    assert.equal(check.note, undefined, `${check.name} ran`);
  }
});
