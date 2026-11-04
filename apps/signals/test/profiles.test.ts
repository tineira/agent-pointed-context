/**
 * Signals' profile declaration (TIN-607): a typo in APC_PROFILES fails closed instead of turning on
 * both profiles; unset still means both.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import { APC_JSON_PATH } from "@tineira/apc-protocol";

installWorkersStandIn();
const { Feed } = await import(new URL("../src/worker/feed.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const ORIGIN = "https://signals.test";
const HUB = "https://dock.test";
const SID = "7".repeat(32);
const DEPLOY = { HUB_ORIGINS: HUB, APC_PROFILES: "direct,dock" };

test("a typo in APC_PROFILES serves no agent path, and does not turn on both", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => void errors.push(message));
  const typo = { HUB_ORIGINS: HUB, APC_PROFILES: "dirct" };
  const feed = new Feed(durableObjectRoom().ctx, typo);
  await feed.init(4242);
  assert.deepEqual((await feed.state()).profiles, [], "the page offers nothing");
  assert.deepEqual(await feed.addDirectGrant(), { ok: false, error: "dock_only" }, "and makes no Direct agent");
  for (const path of [APC_JSON_PATH, `/mcp/${SID}/${"a".repeat(32)}`, "/apc/revoke"]) {
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: path === "/apc/revoke" ? "POST" : "GET" }), typo);
    assert.equal(response.status, 503, path);
    assert.equal(((await response.json()) as { error: string }).error, "profiles_misconfigured");
    assert.equal(response.headers.get("access-control-allow-origin"), "*", "apc.json is read cross-origin, so the refusal must be too");
  }
  assert.equal(errors.length, 3, "each refusal is logged");
  assert.match(errors[0]!, /^Signals refuses its agent paths: APC_PROFILES has "dirct"/);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}${APC_JSON_PATH}`), DEPLOY)).status, 200, "a right value still serves");
  const unset = await worker.fetch(new Request(`${ORIGIN}${APC_JSON_PATH}`), {});
  assert.equal(unset.status, 200, "unset still means both");
  assert.deepEqual(((await unset.json()) as { profiles: string[] }).profiles, ["direct", "dock"]);
});
