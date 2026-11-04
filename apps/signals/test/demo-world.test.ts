/**
 * Signals shows the demo's one world (TIN-621): the same posts as Pulse's market for everyone, whatever seed an
 * older feed kept or an old dock link sends, so it opens on its own, before or after Pulse.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { durableObjectRoom, installWorkersStandIn } from "@tineira/apc-conformance/workers";
import type { Post } from "../../demo/src/model/market.ts";
import { CROSS_APP, demoMarket } from "../../demo/src/model/demo-world.ts";

installWorkersStandIn();
const { Feed } = await import(new URL("../src/worker/feed.ts", import.meta.url).href);
const { default: worker } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const DEPLOY = { HUB_ORIGINS: "https://dock.test", APC_PROFILES: "direct,dock" };

test("a feed made before TIN-621, with a seed of its own, shows the demo world's posts", async () => {
  const room = durableObjectRoom();
  const feed = new Feed(room.ctx, DEPLOY);
  await feed.init();
  room.db.exec("insert into meta (key, value) values ('seed', '12345') on conflict(key) do update set value = excluded.value");
  const fresh = new Feed(room.ctx, DEPLOY) as { posts(): Post[]; state(): Promise<Record<string, unknown>> };
  assert.deepEqual(fresh.posts(), demoMarket().posts);
  assert.equal("seed" in (await fresh.state()), false, "the state names no world");
  // The post the how-to names can be pointed at.
  const made = await (fresh as unknown as { addDirectGrant(): Promise<{ grant_id: string }> }).addDirectGrant();
  assert.deepEqual(await (fresh as unknown as { pin(g: string, t: unknown): Promise<{ ok: boolean }> }).pin(made.grant_id, { kind: "post", id: CROSS_APP.post }), { ok: true });
});

test("an old dock link's seed opens Signals and changes nothing", async () => {
  const inits: unknown[][] = [];
  const owners = new Map<string, string>();
  const stub = (sid: string) => ({
    async init(...args: unknown[]) {
      inits.push(args);
      if (!owners.has(sid)) owners.set(sid, "b".repeat(32));
      return { owner: owners.get(sid)! };
    },
    async isOwner(secret: string) {
      return owners.get(sid) === secret;
    },
  });
  const env = { ...DEPLOY, FEED: { idFromName: (name: string) => name, get: (id: string) => stub(id) } };
  const opened = await worker.request("https://signals.test/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed: 7 }) }, env);
  assert.equal(opened.status, 200);
  const { sid, created } = (await opened.json()) as { sid: string; created: boolean };
  assert.equal(created, true);
  assert.deepEqual(inits, [[]], "a feed is made with no world of its own");
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const again = await worker.request("https://signals.test/api/session", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ seed: 8 }) }, env);
  assert.deepEqual(await again.json(), { sid, created: false });
  assert.equal(inits.length, 1);
});
