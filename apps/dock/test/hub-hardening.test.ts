/**
 * Hardening of the reference hub from the APC 1.0 review (TIN-911): no app's redirect is followed, a pin dated ahead
 * of the hub's clock is never taken, a grant the app did not take back is tried again and every grant goes back
 * before the dock's data does, secrets stay out of the logs, the dock's socket answers on its own path only, a
 * reader request alone never unpairs a browser, and a join request carries a number both screens show.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { durableObjectRoom } from "@tineira/apc-conformance/workers";
import { fakeApp, PULSE, world, type FakeApp, type Json } from "./hostile-world.ts";
import { loggable, redactSecrets } from "../src/worker/redact.ts";
import { LIMITS } from "../src/worker/trust.ts";

const { Hub } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);
const { JoinCodes } = await import(new URL("../src/worker/join-codes.ts", import.meta.url).href);
const { default: app } = await import(new URL("../src/worker/index.ts", import.meta.url).href);

const SHOP = "https://shop.example";
const MARKET = "https://market.example";
const ELSEWHERE = "https://elsewhere.example";
const EXTENSION = `chrome-extension://${"a".repeat(32)}`;
const CODE = "K7M4P2";
const grantUrl = (a: FakeApp) => `${a.origin}/mcp/${"c".repeat(32)}`;
const redirect = () => new Response(null, { status: 307, headers: { location: `${ELSEWHERE}/caught` } });

/** Shop and Market as verified apps, and an origin a redirect would lead to, whose every request is counted. */
async function verifiedWorld(t: TestContext) {
  const w = await world(t, { APP_ORIGINS: `${PULSE},${SHOP},${MARKET}`, READER_ORIGINS: EXTENSION });
  const shop = fakeApp(SHOP, "Shop");
  const market = fakeApp(MARKET, "Market");
  const elsewhere = fakeApp(ELSEWHERE, "Elsewhere");
  for (const a of [shop, market, elsewhere]) w.apps.set(a.origin, a);
  const pair = async (a: FakeApp) => {
    const who = await w.agent();
    const { ticket } = await w.hub.ticket(who.id);
    const answer = await w.hub.pair({ ticket, agent: who.id, app: { name: a.name, origin: a.origin }, mcp_url: grantUrl(a), pairing_code: CODE });
    assert.equal(answer.ok, true, answer.error);
    assert.deepEqual(await w.hub.decide(answer.pairing_id, "approve", CODE), { ok: true });
    return answer.pairing_id as string;
  };
  const givebacks = () => w.hubRoom.db.prepare("select * from givebacks").all() as Json[];
  /** Every give-back due now, as the alarm finds them. */
  const due = () => w.hubRoom.db.prepare("update givebacks set next_at = 0").run();
  const revokes = (a: FakeApp) => a.calls.filter((c) => c === "/apc/revoke").length;
  return { ...w, shop, market, elsewhere, pair, givebacks, due, revokes };
}

// ---- F8: secrets stay out of the logs ----

test("the dock's Workers keep no invocation logs, and what the dock logs carries no secret", () => {
  for (const name of ["dock", "demo", "signals"]) {
    const config = readFileSync(new URL(`../../${name}/wrangler.jsonc`, import.meta.url), "utf8");
    assert.match(config, /"observability": \{ "enabled": true, "logs": \{ "invocation_logs": false \} \}/, `${name}: invocation logs record each request URL`);
  }
  const did = "d".repeat(32);
  const secret = "e".repeat(32);
  const said = loggable(new TypeError(`fetch failed: https://apc.example/mcp/${did}/${secret} and https://shop.example/mcp/${secret}?x=1, ticket ${did}.${secret}`));
  assert.equal(said.includes(secret), false, said);
  assert.match(said, /fetch failed: https:\/\/apc\.example\/mcp\/\[redacted\] and https:\/\/shop\.example\/mcp\/\[redacted\]\?x=1, ticket \[redacted\]/);
  assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
  assert.equal(redactSecrets(`"https://signals.example/mcp/grant_Ab-9xYz" failed`), `"https://signals.example/mcp/[redacted]" failed`, "a grant secret in any alphabet");
});
