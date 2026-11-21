/**
 * The hero's one grant (TIN-1070, B-2 and B-5 of PR #245's review), against the real Worker and the real Sandbox: the
 * sandbox makes its one hero grant on the first `POST /api/s/:sid/grants/embed` and returns it on every later one. So a
 * lost answer, a reload, two tabs at once or blocked storage never commits a second grant. Two tabs are two instances
 * of the page's module (grant.ts), sharing one browser (one cookie, one sandbox), with their calls overlapping.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import * as tabA from "../src/web/embed/grant.ts";

installWorkersStandIn();
const { Sandbox, MAX_DIRECT_GRANTS } = await import(new URL("../src/worker/sandbox.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);
const tabB: typeof tabA = await import(new URL("../src/web/embed/grant.ts?tab=b", import.meta.url).href);
const reloaded: typeof tabA = await import(new URL("../src/web/embed/grant.ts?tab=reload", import.meta.url).href);

const ORIGIN = "https://pulse.test";
const SID = "7".repeat(32);
const DEPLOY = { APC_V2: "1", HUB_ORIGINS: "https://dock.test", PUBLIC_ORIGIN: ORIGIN, APC_PROFILES: "direct,dock" };

type Grant = { id: string; secret: string; regions: unknown };

/** One visitor's browser on one sandbox: the page's POST, as the hero's api.ts sends it, through the real Worker. */
async function browser(env: Record<string, string> = DEPLOY) {
  const room = durableObjectRoom();
  const sandbox = new Sandbox(room.ctx, env);
  const { owner } = await sandbox.init();
  const before = ((await sandbox.state()) as { grants: Grant[] }).grants.map((g) => g.id);
  const workerEnv = { ...env, SANDBOX: { idFromName: (name: string) => name, get: () => sandbox } };
  const headers = { "content-type": "application/json", cookie: `apc_session=${SID}.${owner}`, origin: ORIGIN, "sec-fetch-site": "same-origin" };
  const send = async () => {
    const response = (await worker.fetch(new Request(`${ORIGIN}/api/s/${SID}/grants/embed`, { method: "POST", headers, body: "{}" }), workerEnv)) as Response;
    return { status: response.status, json: (await response.json().catch(() => null)) as { id?: string; made?: boolean; error?: string } | null };
  };
  /** The hero grants the sandbox holds (made by the hero: not there before the first open). */
  const committed = async () => ((await sandbox.state()) as { grants: Grant[] }).grants.filter((g) => !before.includes(g.id));
  return { sandbox, room, send, committed };
}

test("the sandbox makes the hero's grant once and returns the same one on every later open", async () => {
  const { send, committed } = await browser();
  const first = await send();
  assert.equal(first.status, 200);
  assert.equal(first.json?.made, true);
  const again = await send();
  assert.equal(again.status, 200);
  assert.equal(again.json?.id, first.json?.id);
  assert.equal(again.json?.made, false);
  const grants = await committed();
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.regions, null, "unrestricted");
});

test("an answer lost on the way does not make a second grant on reload (committed: 2 before the fix, 1 now)", async () => {
  const { send, committed } = await browser();
  // The reviewer's case: the sandbox commits the grant, then the answer never reaches the page (a dropped connection,
  // the tab unloading). The page sees a network error; its first open fails into the inline message.
  const lost = async () => {
    await send();
    throw new TypeError("Failed to fetch");
  };
  assert.deepEqual(await tabA.ensureEmbedGrant(SID, lost), { ok: false, error: "failed" });
  assert.equal((await committed()).length, 1, "the sandbox did commit one");
  // The visitor reloads: a fresh page (its own module instance), nothing remembered in the browser.
  const after = await reloaded.ensureEmbedGrant(SID, send);
  assert.ok(after.ok);
  assert.equal(after.made, false, "the reload gets the grant the lost answer carried");
  assert.deepEqual((await committed()).map((g) => g.id), [after.grantId]);
  assert.equal((await committed()).length, 1, "committed: 1");
});

test("two tabs opening at once, each its own page, make one grant", async () => {
  const { send, committed } = await browser();
  // Overlapping: both calls are in flight before either answers. Each tab is its own module (its own in-flight map).
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = async () => {
    await gate;
    return send();
  };
  const both = Promise.all([tabA.ensureEmbedGrant(SID, slow), tabB.ensureEmbedGrant(SID, slow)]);
  await new Promise((r) => setTimeout(r, 5));
  release();
  const [a, b] = await both;
  assert.ok(a.ok && b.ok);
  assert.equal(a.grantId, b.grantId, "both tabs show the same agent");
  assert.deepEqual([a.made, b.made].sort(), [false, true], "one made it, the other got it");
  assert.equal((await committed()).length, 1);
});

test("blocked storage in the browser cannot make a second grant: the page remembers nothing", async (t) => {
  // A browser whose storage throws on every access (blocked site data): the hero never touches it.
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("SecurityError"); } });
  t.after(() => void delete (globalThis as { localStorage?: unknown }).localStorage);
  const { send, committed } = await browser();
  for (let open = 0; open < 3; open++) assert.ok((await tabA.ensureEmbedGrant(SID, send)).ok);
  assert.equal((await committed()).length, 1);
});

test("the hero's grant keeps the rules: revoked it is gone (a new one next open), the Direct cap, no hero grant without Direct", async () => {
  const { sandbox, send, committed } = await browser();
  const first = (await send()).json!.id!;
  assert.deepEqual(await sandbox.revokeGrant(first), { ok: true });
  const next = await send();
  assert.equal(next.json?.made, true);
  assert.notEqual(next.json?.id, first);
  assert.equal((await committed()).length, 1, "the revoked one is gone, one hero grant again");
  // Agents made on the Agents page are never the hero's, and the cap counts the hero's with them.
  const agents = await sandbox.addAgentGrant();
  assert.equal((await send()).json?.id, next.json?.id, "an Agents-page grant is never returned as the hero's");
  assert.notEqual(agents.id, next.json?.id);
  await sandbox.revokeGrant(next.json!.id!);
  const direct = ((await sandbox.state()) as { grants: Grant[] }).grants.length;
  for (let n = direct; n < MAX_DIRECT_GRANTS; n++) await sandbox.addAgentGrant();
  const full = await send();
  assert.equal(full.status, 400);
  assert.equal(full.json?.error, "too_many");
  // Dock only (no Direct profile): the hero cannot have an agent.
  const dockOnly = await browser({ ...DEPLOY, APC_PROFILES: "dock" });
  assert.equal((await dockOnly.send()).status, 404);
});

test("the hero's route is the owner's only (M6): another site, no cookie, not JSON", async () => {
  const room = durableObjectRoom();
  const sandbox = new Sandbox(room.ctx, DEPLOY);
  const { owner } = await sandbox.init();
  const env = { ...DEPLOY, SANDBOX: { idFromName: (name: string) => name, get: () => sandbox } };
  const page = { "content-type": "application/json", cookie: `apc_session=${SID}.${owner}`, origin: ORIGIN, "sec-fetch-site": "same-origin" };
  const post = async (headers: Record<string, string>) => ((await worker.fetch(new Request(`${ORIGIN}/api/s/${SID}/grants/embed`, { method: "POST", headers, body: "{}" }), env)) as Response).status;
  const before = ((await sandbox.state()) as { grants: Grant[] }).grants.length;
  assert.equal(await post({ ...page, origin: "https://evil.test" }), 403);
  assert.equal(await post({ ...page, "sec-fetch-site": "cross-site" }), 403);
  assert.equal(await post({ ...page, cookie: "" }), 403);
  assert.equal(await post({ ...page, "content-type": "text/plain" }), 415);
  assert.equal(((await sandbox.state()) as { grants: Grant[] }).grants.length, before, "no refused call made a grant");
});
