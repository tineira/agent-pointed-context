import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { APC_AGENT_CLIENT_META, APC_LINK_TTL_S } from "@apc/protocol";
import { ApcLinks, attachApcLink, cleanAgentName, directMcpUrl, initializeOf, linkClient, memoryKv, newDirectGrant, parseProfiles, sqlKv, toolResult, type LinkGrant } from "../src/index.ts";

function world(now = { t: 1_000_000 }) {
  const grants: LinkGrant[] = [
    { id: "d1", path: "direct" },
    { id: "d2", path: "direct" },
    { id: "k1", path: "dock" },
    { id: "k2", path: "dock" },
  ];
  const links = new ApcLinks(memoryKv(), { appName: "Pulse", grants: () => grants, now: () => now.t });
  return { grants, links, now };
}

test("profiles are declared in one string; nothing valid means both", () => {
  assert.deepEqual(parseProfiles("direct,dock"), ["direct", "dock"]);
  assert.deepEqual(parseProfiles(" dock "), ["dock"]);
  assert.deepEqual(parseProfiles("Direct"), ["direct"]);
  assert.deepEqual(parseProfiles(undefined), ["direct", "dock"]);
  assert.deepEqual(parseProfiles("v1"), ["direct", "dock"]);
});

test("a Direct grant: an id, 128 random bits of secret, and its MCP URL", () => {
  const a = newDirectGrant();
  const b = newDirectGrant();
  assert.match(a.id, /^g_[0-9a-f]{8}$/);
  assert.match(a.secret, /^[0-9a-f]{32}$/);
  assert.notEqual(a.secret, b.secret);
  assert.equal(directMcpUrl("https://signals.example", "s".repeat(4), a.secret), `https://signals.example/mcp/ssss/${a.secret}`);
  assert.equal(cleanAgentName("  Ada\u0000 \n Lovelace  "), "Ada Lovelace");
  assert.equal(cleanAgentName("   "), null);
  assert.equal(cleanAgentName("x".repeat(60))?.length, 40);
});

test("the client of an arriving connection: its own on Direct, the one its hub names on Dock", () => {
  const direct = initializeOf({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.1" } } })!;
  assert.equal(linkClient(direct, "direct"), "claude-code");
  const hub = initializeOf([{ jsonrpc: "2.0", method: "notifications/x" }, { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "apc-hub", title: "Claude via dock" }, _meta: { [APC_AGENT_CLIENT_META]: "claude-code" } } }])!;
  assert.equal(hub.name, "apc-hub");
  assert.equal(linkClient(hub, "dock"), "claude-code");
  assert.equal(linkClient(direct, "dock"), null, "on Dock, only the hub's word counts");
  assert.equal(initializeOf({ method: "tools/list" }), null);
});

test("an offer goes to the connection that arrives second, once per session, and links on the other path", async () => {
  const { links } = world();
  links.arrived("d1", "claude-code");
  assert.equal(await links.offer("d1", "get_current_view"), null, "nobody on the other path yet");
  links.arrived("k1", "claude-code");
  assert.equal(await links.offer("k1", "get_current_view"), null, "on Dock the offer waits for one of the app's own tools");
  const offer = (await links.offer("k1", "list_customers"))!;
  assert.match(offer.code, /^lk_[0-9a-f]{24}$/);
  assert.equal(offer.expires_in, APC_LINK_TTL_S);
  assert.match(offer.note, /on your direct connection to Pulse/);
  assert.equal(await links.offer("k1", "list_customers"), null, "asked once per session");

  assert.deepEqual(await links.redeem("k1", offer.code), { ok: false, reason: "same_connection" });
  assert.deepEqual(await links.redeem("d1", offer.code), { ok: true, partner: "k1" });
  assert.equal(links.partnerOf("d1"), "k1");
  assert.equal(links.partnerOf("k1"), "d1");
  assert.deepEqual(links.links(), [["d1", "k1"]]);
  assert.deepEqual(await links.redeem("d1", offer.code), { ok: false, reason: "used" });

  // A new session of a linked connection is asked nothing.
  links.arrived("k1", "claude-code");
  assert.equal(await links.offer("k1", "list_customers"), null);
});

test("refused: another client, the same path, an expired or unknown code, an already linked connection", async () => {
  const { links, now } = world();
  links.arrived("d1", "claude-code");
  links.arrived("d2", "codex");
  links.arrived("k2", "claude-code");
  links.arrived("k1", "claude-code");
  const offer = (await links.offer("k1", "get_post"))!;
  assert.deepEqual(await links.redeem("k2", offer.code), { ok: false, reason: "same_path" });
  assert.deepEqual(await links.redeem("d2", offer.code), { ok: false, reason: "not_offered" }, "another client");
  assert.deepEqual(await links.redeem("d1", "lk_000000000000000000000000"), { ok: false, reason: "unknown_code" });
  assert.deepEqual(await links.redeem("d1", 42), { ok: false, reason: "unknown_code" });
  now.t += APC_LINK_TTL_S * 1000 + 1;
  assert.deepEqual(await links.redeem("d1", offer.code), { ok: false, reason: "expired" });
  // A new session asks again; a code for an already linked connection is refused.
  links.arrived("k2", "claude-code");
  const second = (await links.offer("k2", "get_post"))!;
  links.arrived("k1", "claude-code");
  const third = (await links.offer("k1", "get_post"))!;
  assert.deepEqual(await links.redeem("d1", second.code), { ok: true, partner: "k2" });
  assert.deepEqual(await links.redeem("d1", third.code), { ok: false, reason: "already_linked" });
});

test("unlink removes the link only; a forgotten grant takes its link and codes with it", async () => {
  const { links, grants } = world();
  links.arrived("d1", "claude-code");
  links.arrived("k1", "claude-code");
  const offer = (await links.offer("k1", "get_post"))!;
  await links.redeem("d1", offer.code);
  assert.equal(links.unlink("k1"), "d1");
  assert.equal(links.partnerOf("d1"), null);

  links.arrived("d1", "claude-code");
  const again = (await links.offer("d1", "get_current_view"))!;
  assert.ok(again, "on Direct a core tool carries it");
  assert.match(again.note, /through your agent dock/);
  links.forget("d1");
  grants.splice(0, 1);
  assert.deepEqual(await links.redeem("k1", again.code), { ok: false, reason: "unknown_code" }, "the code of a revoked grant is gone");
});

test("an offer rides on the result like attention, and the kv works on SQLite", () => {
  const result = attachApcLink(toolResult({ rows: [] }), { code: "lk_x", expires_in: 120, note: "n" });
  assert.deepEqual((result.structuredContent as { apc_link: unknown }).apc_link, { code: "lk_x", expires_in: 120, note: "n" });
  assert.equal((JSON.parse(result.content[0]!.text) as { apc_link: { code: string } }).apc_link.code, "lk_x");

  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (q: string, ...p: Array<string | number | null>) => {
      const statement = db.prepare(q);
      const rows = statement.columns().length ? statement.all(...p) : (statement.run(...p), []);
      return { toArray: () => rows };
    },
  };
  const kv = sqlKv(sql);
  kv.put("code:a", "1");
  kv.put("code:b", "2");
  kv.put("link:a", "3");
  kv.put("code:a", "4");
  assert.equal(kv.get("code:a"), "4");
  assert.deepEqual(kv.list("code:"), [["code:a", "4"], ["code:b", "2"]]);
  kv.delete("code:a");
  assert.equal(kv.get("code:a"), null);
});
