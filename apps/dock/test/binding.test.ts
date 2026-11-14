/**
 * The binding at the reference hub (APC 0.12, TIN-910): every initialize names the pairing (H8), pairing ids hold
 * 128 random bits, a Direct grant handed to /apc/pair never goes live at Pulse, and a verified app's name and tool
 * prefix come from the operator's pin or its own apc.json, never from the request (F10).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { APC_AGENT_META, APC_PAIRING_ID_META, PAIRING_ENDED_ERROR, PAIRING_ID_RE } from "@tineira/apc-protocol";
import { appPins, LIMITS, verifiedName } from "../src/worker/trust.ts";
import { fakeApp, manifestOf, PULSE, SID, world, type Json } from "./hostile-world.ts";

const meta = (params: Json) => (params._meta ?? {}) as Record<string, unknown>;

test("H8: every initialize names the pairing and its agent, to a verified and an unverified app alike; ids hold 128 bits", async (t) => {
  const w = await world(t);
  const agentId = (await w.agent()).id as string;
  const seen: Json[] = [];
  const evil = fakeApp("https://evil.example", "Evil", { respond: (method, params) => (method === "initialize" ? void seen.push(params) : undefined) });
  const answer = await w.pairApp(evil);
  assert.equal(answer.ok, true);
  assert.match(answer.pairing_id!, PAIRING_ID_RE);
  assert.equal(answer.pairing_id!.length, 35, "pr_ and 32 hex");
  assert.equal((answer as Json).binding, "pairing_id", "the acknowledgement declares the binding");
  assert.equal(seen.length, 1);
  assert.equal(meta(seen[0]!)[APC_PAIRING_ID_META], answer.pairing_id);
  assert.equal(meta(seen[0]!)[APC_AGENT_META], agentId);
  // A re-introduction (a new badge for the agent) carries the same pairing and agent.
  await w.hub.setBadge(agentId, `data:image/png;base64,${"A".repeat(40)}`);
  assert.ok(seen.length >= 2, "the hub introduced itself again");
  for (const params of seen) assert.deepEqual([meta(params)[APC_PAIRING_ID_META], meta(params)[APC_AGENT_META]], [answer.pairing_id, agentId]);
  // Two pairings never share an id.
  const other = await w.pairApp(fakeApp("https://other.example", "Other"));
  assert.notEqual(other.pairing_id, answer.pairing_id);
});

test("an unverified app's pairing_mismatch is never kept as a reason: its words never reach the dock's line", async (t) => {
  const w = await world(t);
  const app = fakeApp("https://evil.example", "Evil", { respond: (method) => (method === "initialize" ? Response.json({ error: "pairing_mismatch" }, { status: 404 }) : undefined) });
  const answer = await w.pairApp(app, { approve: false });
  assert.deepEqual(await w.hub.decide(answer.pairing_id!, "approve_unverified"), { ok: false, error: PAIRING_ENDED_ERROR });
  const line = await w.pairingOf(app.origin);
  assert.equal(line.status, "ended");
  assert.equal(line.ended_reason, undefined);
});

test("F10: a verified app is named by the operator's pin, else its own apc.json, never by the request; its prefix survives a rename", async (t) => {
  const SHOP = "https://shop.example";
  let name = "Shop";
  const w = await world(t, { APP_ORIGINS: `${PULSE}/#id=pulse&name=Pulse,${SHOP}` });
  const shop = fakeApp(SHOP, "Shop", { apcJson: () => Response.json(manifestOf(SHOP, name)) });
  w.apps.set(SHOP, shop);
  const agentId = (await w.agent()).id as string;
  const ask = async (origin: string, body: string, url: string) => {
    const { ticket } = await w.hub.ticket(agentId);
    return w.hub.pair({ ticket, agent: agentId, app: { name: body, origin }, mcp_url: url, pairing_code: "K7M4P2" });
  };
  // Pinned: the request says "Your bank"; the dock says Pulse, and the prefix is the pin.
  await ask(PULSE, "Your bank", `${PULSE}/mcp/${SID}/${"d".repeat(32)}`);
  const pulse = await w.pairingOf(PULSE);
  assert.deepEqual([pulse.app.name, pulse.app.id], ["Pulse", "pulse"]);
  // Unpinned: the name in its own apc.json, cleaned, whatever the request says.
  name = "Shop   Online";
  await ask(SHOP, "Your bank", `${SHOP}/mcp/${"e".repeat(32)}`);
  let line = await w.pairingOf(SHOP);
  assert.deepEqual([line.app.name, line.app.id], ["Shop Online", "shoponline"]);
  // It renames itself and pairs again (its apc.json read anew): the dock shows the new name, the agent keeps the prefix it knew.
  await w.hub.decide(line.id, "deny");
  const fresh = LIMITS.apcJsonFreshMs;
  LIMITS.apcJsonFreshMs = 0;
  t.after(() => void (LIMITS.apcJsonFreshMs = fresh));
  name = "Boutique";
  await ask(SHOP, "Shop", `${SHOP}/mcp/${"f".repeat(32)}`);
  line = await w.pairingOf(SHOP);
  assert.deepEqual([line.app.name, line.app.id], ["Boutique", "shoponline"]);
});

test("F10: an unpinned app never takes another origin's pinned prefix, nor one the agent holds", async (t) => {
  const SHOP = "https://shop.example";
  const w = await world(t, { APP_ORIGINS: `${PULSE}/#id=pulse&name=Pulse,${SHOP}` });
  w.apps.set(SHOP, fakeApp(SHOP, "Pulse"));
  const agentId = (await w.agent()).id as string;
  const { ticket } = await w.hub.ticket(agentId);
  assert.equal((await w.hub.pair({ ticket, agent: agentId, app: { name: "Pulse", origin: SHOP }, mcp_url: `${SHOP}/mcp/${"e".repeat(32)}`, pairing_code: "K7M4P2" })).ok, true);
  const line = await w.pairingOf(SHOP);
  assert.equal(line.app.name, "Pulse", "the name it gives itself");
  assert.equal(line.app.id, "pulse2", "never Pulse's pinned prefix");
});

test("appPins: the pin rides in the fragment, so a reader of the origin alone sees the same list; a bad pin is ignored", () => {
  const pins = appPins([
    "https://pulse.apc.tineira.com/#id=pulse&name=Pulse",
    "https://a.example/#id=Page&name=A",
    "https://b.example/#id=page",
    "https://c.example/#id=pulse&name=Copy",
    "https://d.example/#name=%0AEvil",
    "https://e.example/#name=Caf%C3%A9%2C%20Inc",
    "https://f.example",
  ]);
  assert.deepEqual(pins.get("https://pulse.apc.tineira.com"), { id: "pulse", name: "Pulse" });
  assert.deepEqual(pins.get("https://a.example"), { id: null, name: "A" }, "an id out of form");
  assert.equal(pins.has("https://b.example"), false, "page is the extension's");
  assert.deepEqual(pins.get("https://c.example"), { id: null, name: "Copy" }, "a second pin of one id");
  assert.equal(pins.has("https://d.example"), false, "a name with a control character");
  assert.deepEqual(pins.get("https://e.example"), { id: null, name: "Café, Inc" }, "form-encoded, a comma included");
  assert.equal(pins.has("https://f.example"), false);
  // The production list parses whole.
  const wrangler = "https://pulse.apc.tineira.com/#id=pulse&name=Pulse,https://signals.apc.tineira.com/#id=signals&name=Signals,https://pfa.tineira.com/#id=surplus&name=Surplus";
  assert.deepEqual([...appPins(wrangler.split(",")).values()].map((p) => p.id), ["pulse", "signals", "surplus"]);
});

test("verifiedName: separators go, spaces fold, at most 40 code points and never half a surrogate pair", () => {
  assert.equal(verifiedName(" A B​C\t D "), "ABC D");
  const emoji = "😀".repeat(45);
  assert.equal(Array.from(verifiedName(emoji)).length, 40);
  assert.equal(verifiedName(`${"a".repeat(39)}😀😀`), `${"a".repeat(39)}😀`);
  assert.equal(verifiedName("  "), "");
});

