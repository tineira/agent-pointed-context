/**
 * Removing a computer cuts it off (TIN-909): it saw every agent's MCP URL in the dock, so when a computer is removed
 * or leaves, every agent gets a new secret. The old URLs answer as an unknown agent's, a request still running on
 * one is cut, the agents keep their pairings, and the dock asks the person to reconnect each connected agent. Agent
 * traffic alone no longer keeps a dock alive forever. The real hub and the real Pulse sandbox (hostile-world.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asResult, DOCK, fakeApp, PULSE, rpcAnswer, world, type Json } from "./hostile-world.ts";

const SHOP = "https://shop.example";

const { AGENT_ALONE_TTL_MS, DOCK_TTL_MS } = await import(new URL("../src/worker/hub.ts", import.meta.url).href);

type World = Awaited<ReturnType<typeof world>>;

/** One JSON-RPC message to an MCP URL of the hub, as an agent's client sends it. */
async function post(w: World, mcpUrl: string, method: string, params: Json = {}) {
  const response: Response = await w.hub.fetch(
    new Request(`${DOCK}${new URL(mcpUrl).pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return { status: response.status, json: (await response.json()) as Json };
}
const initialize = (w: World, url: string) => post(w, url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } });
const toolNames = async (w: World, url: string) => ((await post(w, url, "tools/list")).json.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();

/** A dock with its agent connected and paired with Pulse, and a second computer linked to it. */
async function linkedDock(t: Parameters<typeof world>[0], env: Json = {}, pulse = true) {
  const w = await world(t, env);
  if (pulse) await w.pairPulse();
  const before = await w.agent();
  assert.equal((await initialize(w, before.mcp_url)).status, 200);
  const first = w.hubRoom.db.prepare("select id, secret from devices").get() as { id: string; secret: string };
  const second = { id: "dv_second", secret: "5".repeat(32) };
  w.hubRoom.db.prepare("insert into devices (id, secret, label, created_at, last_used_at) values (?, ?, 'Edge on Windows', ?, ?)").run(second.id, second.secret, new Date().toISOString(), new Date().toISOString());
  const tools = await toolNames(w, before.mcp_url);
  if (pulse) assert.ok(tools.some((n) => n.includes("__")), "Pulse's tools are listed through the hub");
  return { w, first, second, oldUrl: before.mcp_url as string, tools };
}

/** What every case checks after the cut: the old URL is an unknown agent's, the new one works, the pairing stayed. */
async function assertCut(w: World, oldUrl: string, tools: string[]) {
  const after = await w.agent();
  assert.notEqual(after.mcp_url, oldUrl, "the agent has a new MCP URL");
  const unknown = await initialize(w, `${DOCK}/mcp/${"a".repeat(32)}/${"0".repeat(32)}`);
  const old = await initialize(w, oldUrl);
  assert.deepEqual([old.status, old.json], [unknown.status, unknown.json], "the old URL answers as an unknown agent's");
  assert.deepEqual(old.json, { error: "unknown_agent" });
  assert.equal(after.reconnect, true, "the dock asks the person to reconnect the agent");
  // The pairing survives: same status, and Pulse's tools are reached through the new URL.
  assert.equal(after.pairings.find((p: Json) => (p.app as Json).origin === "https://pulse.test")?.status, "paired");
  assert.equal((await initialize(w, after.mcp_url)).status, 200);
  assert.deepEqual(await toolNames(w, after.mcp_url), tools, "the same tools, Pulse's included");
  const view = await post(w, after.mcp_url, "tools/call", { name: "get_current_view", arguments: {} });
  assert.equal(view.status, 200);
  assert.equal((view.json.result as Json).isError, undefined, JSON.stringify(view.json));
  assert.equal((await w.agent()).reconnect, false, "connected with its new URL: the dock stops asking");
}

test("after removeDevice, every agent's old MCP URL answers as an unknown agent's, the new one works, pairings stay", async (t) => {
  const { w, first, second, oldUrl, tools } = await linkedDock(t);
  const extra = (await w.hub.addAgent()).id as string;
  const extraBefore = (await w.state()).agents.find((a: Json) => a.id === extra).mcp_url;
  const ticket = (await w.hub.ticket((await w.agent()).id)).ticket;
  assert.deepEqual(await w.hub.removeDevice(second.id, first.secret), { ok: true });
  await assertCut(w, oldUrl, tools);
  // Every agent, not only the connected one; one that never connected is not asked to reconnect.
  const extraAfter = (await w.state()).agents.find((a: Json) => a.id === extra);
  assert.notEqual(extraAfter.mcp_url, extraBefore);
  assert.equal(extraAfter.reconnect, false);
  assert.equal((await initialize(w, extraBefore)).status, 404);
  // A drag's ticket the removed computer may hold is gone too.
  const pair = await w.hub.pair({ ticket, agent: (await w.agent()).id, app: { name: "Shop", origin: "https://shop.example" }, mcp_url: "https://shop.example/mcp/" + "c".repeat(32) });
  assert.deepEqual(pair, { ok: false, error: "ticket_expired" });
  // The removed computer's secret no longer opens the dock; the other's still does.
  assert.equal(await w.hub.isOwner(second.secret), false);
  assert.equal(await w.hub.isOwner(first.secret), true);
});

test("after leave, the same: the computer that left can no longer use the URLs it saw", async (t) => {
  const { w, first, second, oldUrl, tools } = await linkedDock(t);
  assert.deepEqual(await w.hub.leave(second.secret), { ok: true, wiped: false });
  await assertCut(w, oldUrl, tools);
  assert.equal(await w.hub.isOwner(second.secret), false);
  assert.equal(await w.hub.isOwner(first.secret), true);
});

test("a request still running on an old URL is cut when the computer is removed, and delivers nothing", async (t) => {
  const { w, first, second, oldUrl } = await linkedDock(t, { APP_ORIGINS: `${PULSE},${SHOP}` }, false);
  // A second app whose page is open: the hub's wait relayed to it holds 2 s, then finds a pin.
  const shop = fakeApp(SHOP, "Shop");
  w.apps.set(SHOP, shop);
  const who = await w.agent();
  const asked = (await w.hub.pair({ ticket: (await w.hub.ticket(who.id)).ticket, agent: who.id, app: { name: shop.name, origin: shop.origin }, mcp_url: `${SHOP}/mcp/${"c".repeat(32)}`, pairing_code: "K7M4P2" })) as { ok: boolean; pairing_id: string };
  assert.deepEqual(await w.hub.decide(asked.pairing_id, "approve", "K7M4P2"), { ok: true });
  const pin = { app: { id: "shop", name: "Shop" }, target: { kind: "order", id: "o1" }, label: "Order 1", pinned_at: new Date().toISOString(), next: "get_current_view" };
  shop.respond = (method: string, params: Json) =>
    method === "tools/call" && params.name === "wait_for_focus" ? new Promise<Response>((resolve) => setTimeout(() => resolve(rpcAnswer(asResult({ focus: pin, timed_out: false, page_open: true }))), 2000)) : null;
  const waiting = post(w, oldUrl, "tools/call", { name: "wait_for_focus", arguments: { timeout_s: 5 } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await w.agent()).waiting, true, "the wait holds its place");
  assert.deepEqual(await w.hub.removeDevice(second.id, first.secret), { ok: true });
  assert.deepEqual(await waiting, { status: 404, json: { error: "unknown_agent" } });
});

test("agent traffic alone keeps a dock no longer than AGENT_ALONE_TTL_MS after a computer last opened it", async (t) => {
  const w = await world(t);
  const url = (await w.agent()).mcp_url;
  const meta = (key: string) => Number((w.hubRoom.db.prepare("select value from meta where key = ?").get(key) as { value: string }).value);
  const opened = Date.now() - AGENT_ALONE_TTL_MS + 60 * 60_000;
  w.hubRoom.db.prepare("update meta set value = ? where key = 'opened_at'").run(String(opened));
  w.hubRoom.db.prepare("update meta set value = ? where key = 'expires_at'").run(String(Date.now() + 60_000));
  assert.equal((await initialize(w, url)).status, 200);
  assert.equal(meta("expires_at"), opened + AGENT_ALONE_TTL_MS, "an agent's call slides the end only up to the cap");
  // Past the cap, an agent's call never brings the dock back.
  w.hubRoom.db.prepare("update meta set value = ? where key = 'expires_at'").run(String(Date.now() - 1));
  assert.equal((await initialize(w, url)).status, 404);
});

test("a computer's visit still slides the dock's end DOCK_TTL_MS; a dock from before counts its computers' last use", async (t) => {
  const opened = Date.now() - AGENT_ALONE_TTL_MS + 60 * 60_000;
  const w2 = await world(t);
  const secret = (w2.hubRoom.db.prepare("select secret from devices").get() as { secret: string }).secret;
  w2.hubRoom.db.prepare("update meta set value = ? where key = 'opened_at'").run(String(opened));
  const at = Date.now();
  assert.equal(await w2.hub.isOwner(secret), true);
  const end = Number((w2.hubRoom.db.prepare("select value from meta where key = 'expires_at'").get() as { value: string }).value);
  assert.ok(end >= at + DOCK_TTL_MS, "a computer's visit slides the end DOCK_TTL_MS");
  // A dock from before has no mark: its computers' last use stands for it.
  w2.hubRoom.db.prepare("delete from meta where key = 'opened_at'").run();
  w2.hubRoom.db.prepare("update devices set last_used_at = ?").run(new Date(opened).toISOString());
  w2.hubRoom.db.prepare("update meta set value = ? where key = 'expires_at'").run(String(Date.now() + 60_000));
  assert.equal((await initialize(w2, (await w2.agent()).mcp_url)).status, 200);
  assert.equal(Number((w2.hubRoom.db.prepare("select value from meta where key = 'expires_at'").get() as { value: string }).value), opened + AGENT_ALONE_TTL_MS);
});
