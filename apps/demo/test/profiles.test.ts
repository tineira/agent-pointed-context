/**
 * Pulse's profile declaration and its Direct cap (TIN-607): a typo in APC_PROFILES fails closed instead
 * of turning on both profiles, and a sandbox holds at most 20 Direct agents, as Signals does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@apc/conformance/workers";
import { APC_JSON_PATH } from "@apc/protocol";

installWorkersStandIn();
const { Sandbox } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const ORIGIN = "https://pulse.test";
const HUB = "https://dock.test";
const SID = "5".repeat(32);
const DEPLOY = { APC_V2: "1", HUB_ORIGINS: HUB, APC_PROFILES: "direct,dock" };

async function sandboxWith(env: Record<string, string>) {
  const room = durableObjectRoom();
  const sandbox = new Sandbox(room.ctx, env);
  await sandbox.init(4242);
  return { room, sandbox };
}

test("a typo in APC_PROFILES serves no agent path, and does not turn on both", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => void errors.push(message));
  const typo = { ...DEPLOY, APC_PROFILES: "dirct,dock" };
  const { sandbox } = await sandboxWith(typo);
  assert.deepEqual((await sandbox.state()).profiles, [], "the page offers nothing");
  for (const path of [APC_JSON_PATH, `/mcp/${SID}/${"a".repeat(32)}`, "/apc/revoke"]) {
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: path === "/apc/revoke" ? "POST" : "GET" }), typo);
    assert.equal(response.status, 503, path);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, "profiles_misconfigured");
    assert.match(body.message, /"dirct"/);
  }
  assert.equal(errors.length, 3, "each refusal is logged");
  assert.match(errors[0]!, /^Pulse refuses its agent paths: APC_PROFILES has "dirct"/);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}${APC_JSON_PATH}`), DEPLOY)).status, 200, "a right value still serves");
  const unset = await worker.fetch(new Request(`${ORIGIN}${APC_JSON_PATH}`), { APC_V2: "1" });
  assert.equal(unset.status, 200, "unset still means both");
  assert.deepEqual(((await unset.json()) as { profiles: string[] }).profiles, ["direct", "dock"]);
});

test("a typo in APC_PROFILES does not delete the Direct agents a sandbox already holds", async () => {
  const { room, sandbox } = await sandboxWith(DEPLOY);
  const made = await sandbox.addAgentGrant();
  const after = new Sandbox(room.ctx, { ...DEPLOY, APC_PROFILES: "dirct" }); // a restart under the typo runs the start-up cleanup
  assert.deepEqual((await after.state()).grants.map((g: { id: string }) => g.id), [made.id]);
  // The cleanup still runs for a right "dock"-only value: that is the owner's choice, not a typo.
  const dockOnly = new Sandbox(room.ctx, { ...DEPLOY, APC_PROFILES: "dock" });
  assert.deepEqual((await dockOnly.state()).grants, []);
});

test("Pulse holds at most 20 Direct agents, as Signals does", async () => {
  const { sandbox } = await sandboxWith(DEPLOY);
  for (let i = 0; i < 20; i++) assert.equal((await sandbox.tryAddAgent()).ok, true, `agent ${i + 1}`);
  assert.deepEqual(await sandbox.tryAddAgent(), { ok: false, error: "too_many" });
  assert.deepEqual(await sandbox.tryAddRestricted("latam"), { ok: false, error: "too_many" }, "a new restricted agent is a Direct agent too");
  const { grants } = (await sandbox.state()) as { grants: Array<{ id: string }> };
  assert.equal(grants.length, 20);
  assert.equal((await sandbox.revokeGrant(grants[0]!.id)).ok, true);
  assert.equal((await sandbox.tryAddAgent()).ok, true, "a revoked agent frees its place");
  assert.equal((await sandbox.tryAddAgent()).ok, false);
});
