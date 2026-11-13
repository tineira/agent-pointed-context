/**
 * The dock's "waiting" (APC 0.11, TIN-886): the hub reads it from the wait events of the agent's place for a wait
 * (`announceWaits`), not by counting the calls in flight. So a wait a newer one took over stops counting at the
 * takeover: when the newer wait ends, the pet stops waiting, even while the old call is still out at an app.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WAIT_CLAIM_GAP_S } from "@tineira/apc-protocol";
import { asResult, fakeApp, PULSE, rpcAnswer, world, type Json } from "./hostile-world.ts";

const SHOP = "https://shop.example";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the dock shows an agent waiting while its wait holds its place, and not past the newer wait that took it over", async (t) => {
  const w = await world(t, { APP_ORIGINS: `${PULSE},${SHOP}` });
  const shop = fakeApp(SHOP, "Shop");
  w.apps.set(SHOP, shop);
  const who = await w.agent();
  const { ticket } = await w.hub.ticket(who.id);
  const asked = (await w.hub.pair({ ticket, agent: who.id, app: { name: shop.name, origin: shop.origin }, mcp_url: `${SHOP}/mcp/${"c".repeat(32)}`, pairing_code: "K7M4P2" })) as { ok: boolean; pairing_id: string };
  assert.equal(asked.ok, true);
  assert.deepEqual(await w.hub.decide(asked.pairing_id, "approve", "K7M4P2"), { ok: true });
  // The first wait's call to the app hangs 4 s; the second's answers at once that the page closed.
  let waits = 0;
  shop.respond = (method: string, params: Json) => {
    if (method !== "tools/call" || params.name !== "wait_for_focus") return null;
    const closed = rpcAnswer(asResult({ focus: null, timed_out: false, page_open: false }));
    return ++waits === 1 ? sleep(4000).then(() => closed) : closed;
  };
  const waiting = async () => (await w.agent()).waiting as boolean;
  assert.equal(await waiting(), false, "no wait, not waiting");
  const older = w.callHub("wait_for_focus", { timeout_s: 10 });
  await sleep(300);
  assert.equal(await waiting(), true, "waiting while the wait holds its place");
  await sleep((WAIT_CLAIM_GAP_S + 0.3) * 1000);
  const newer = await w.callHub("wait_for_focus", { timeout_s: 10 });
  assert.equal(newer.structuredContent.page_open, false);
  assert.equal(await waiting(), false, "the newer wait ended: not waiting, though the older call is still out at the app");
  await older;
  assert.equal(await waiting(), false);
});
