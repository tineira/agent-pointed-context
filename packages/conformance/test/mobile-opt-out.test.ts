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

const MANIFEST = { name: "Core", origin: CORE_ORIGIN, profiles: ["direct"], mcp: { path: "/mcp/", endpoints: [{ path: "/mcp/{secret}", profiles: ["direct"] }] }, direct: { connect: `${CORE_ORIGIN}/agents` } };

/** The core fixture, with its `apc.json` answered by `answer` (or replaced by `file`) and its phone adapter kept or left out. */
function app(file: Record<string, unknown> | ((request: Request) => Response), withMobile: boolean): ApcAppAdapter {
  const { adapter } = coreFixture();
  const inner = adapter.fetch!;
  const answer = typeof file === "function" ? file : () => Response.json({ ...MANIFEST, ...file });
  return {
    ...adapter,
    fetch: async (request: Request) => (new URL(request.url).pathname === APC_JSON_PATH ? answer(request) : inner(request)),
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
  await assert.rejects(given(mobileChecks(app({ standard: "1.3.0", mobile: false }, false))).run(), /takes an app out of the rule only with a claim from 1\.4\.0 within 1\.x/);
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

/** Fails closed (review of #259): only an apc.json the suite reads as a manifest of this major can waive the adapter. */
const desktop = { standard: "1.4.0", mobile: false };
for (const [label, answer] of [
  ["a newer major (2.0.0) with mobile: false", () => Response.json({ ...MANIFEST, standard: "2.0.0", mobile: false })],
  ["a standard that is not a version (\"1.5.invalid\") with mobile: false", () => Response.json({ ...MANIFEST, standard: "1.5.invalid", mobile: false })],
  ["a standard that is not a version (\"1.4\") with mobile: false", () => Response.json({ ...MANIFEST, standard: "1.4", mobile: false })],
  ["an empty standard, with no mobile key", () => Response.json({ ...MANIFEST, standard: "" })],
  ["no standard, with mobile: false", () => Response.json({ ...MANIFEST, mobile: false })],
  ["a hub's file with mobile: false", () => Response.json({ name: "Dock", standard: "1.4.0", origin: CORE_ORIGIN, profiles: ["hub"], mcp: { path: "/mcp/" }, dock: { pair: `${CORE_ORIGIN}/apc/pair`, confirm: `${CORE_ORIGIN}/apc/confirm` }, mobile: false })],
  ["a file that names another origin", () => Response.json({ ...MANIFEST, ...desktop, origin: "https://elsewhere.test" })],
  ["an HTTP 404 whose body says mobile: false", () => Response.json({ ...MANIFEST, ...desktop }, { status: 404 })],
  ["an HTTP 500 whose body says mobile: false", () => Response.json({ ...MANIFEST, ...desktop }, { status: 500 })],
  ["a redirect to a file that says mobile: false", () => new Response(null, { status: 302, headers: { location: `${CORE_ORIGIN}/elsewhere.json` } })],
  ["a body that is JSON null", () => new Response("null", { headers: { "content-type": "application/json" } })],
  ["a body that is not JSON", () => new Response("mobile: false", { headers: { "content-type": "application/json" } })],
] as const) {
  test(`without page.mobile, ${label} fails closed with a ConformanceError`, async () => {
    await assert.rejects(given(mobileChecks(app(answer, false))).run(), (error: unknown) => {
      assert.ok(error instanceof ConformanceError, `a ConformanceError, not ${String(error)}`);
      return true;
    });
  });
}

test("the fetch for apc.json does not follow redirects", async () => {
  let seen: RequestRedirect | undefined;
  const a = app((request) => {
    seen = request.redirect;
    return Response.json({ ...MANIFEST, ...desktop });
  }, false);
  await given(mobileChecks(a)).run();
  assert.equal(seen, "manual");
});
