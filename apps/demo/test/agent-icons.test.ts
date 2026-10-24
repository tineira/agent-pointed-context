import assert from "node:assert/strict";
import { test } from "node:test";
import { brandFor, colorFor, motionFor } from "../src/web/agent-brands.ts";
import { pickClientIcon } from "../src/worker/client-icon.ts";

test("client names map to their brand", () => {
  const id = (name: string | null) => brandFor(name)?.id ?? null;
  assert.equal(id("grok-validator"), "grok", "grok.com validates the URL");
  assert.equal(id("connectors-manager"), "grok", "then grok.com makes every call");
  assert.equal(id("Cursor"), "grok-bot", "the Grok bot sends exactly Cursor 1.0.0");
  assert.equal(id("grok-cli"), "grok");
  assert.equal(id("claude-duet"), "claude-duet");
  assert.equal(id("dots"), "openai");
  assert.equal(id("claude-ai"), "claude");
  assert.equal(id("claude-code"), "claude");
  assert.equal(id("openai-mcp"), "openai");
  assert.equal(id("Codex"), "openai");
  assert.equal(id("gemini-cli-mcp-client"), "gemini");
  assert.equal(id("antigravity"), "antigravity");
  assert.equal(id("cursor-vscode"), "cursor");
  assert.equal(id("Kimi"), "kimi");
  assert.equal(id("mcp-inspector"), null);
  assert.equal(id(null), null);
});

test("an unknown client's bot color is stable per name", () => {
  assert.equal(colorFor("mcp-inspector"), colorFor("mcp-inspector"));
  assert.notEqual(colorFor("mcp-inspector"), colorFor("some-other-client"));
});

test("the icon's motion: off, then a fresh read pin, then waiting, then busy", () => {
  const base = { connected: true, waiting: false, busy: false, seenAt: undefined, now: 10_000 };
  assert.equal(motionFor({ ...base, connected: false, waiting: true }), "off");
  assert.equal(motionFor({ ...base, waiting: true, seenAt: 9_500 }), "seen");
  assert.equal(motionFor({ ...base, waiting: true, seenAt: 5_000 }), "waiting");
  assert.equal(motionFor({ ...base, busy: true }), "busy");
  assert.equal(motionFor(base), "idle");
});

test("only a small raster data URI is kept from clientInfo.icons", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(pickClientIcon([{ src: png }]), png);
  assert.equal(pickClientIcon([{ src: "https://example.com/a.png" }, { src: png }]), png, "a remote URL is skipped");
  assert.equal(pickClientIcon([{ src: "data:image/svg+xml;base64,PHN2Zz4=" }]), null, "no SVG");
  assert.equal(pickClientIcon([{ src: "data:image/png;base64,<script>" }]), null);
  assert.equal(pickClientIcon([{ src: `data:image/png;base64,${"A".repeat(20_000)}` }]), null, "too big");
  assert.equal(pickClientIcon("nope"), null);
  assert.equal(pickClientIcon(undefined), null);
});

test("a Grok bot gets one character, fixed per agent", async () => {
  const { GROK_BOTS } = await import("../src/web/agent-logos.ts");
  const { pickImage } = await import("../src/web/agent-brands.ts");
  assert.equal(GROK_BOTS.length, 9);
  assert.equal(pickImage(GROK_BOTS, "g_1234"), pickImage(GROK_BOTS, "g_1234"));
  const seen = new Set(Array.from({ length: 40 }, (_, i) => pickImage(GROK_BOTS, `g_${i}`).name));
  assert.ok(seen.size > 4, "different agents get different characters");
});

test("agent names: the person's, then the agent's, then the client title, then the product, numbered (TIN-356)", async () => {
  const { displayNames } = await import("../src/web/agent-brands.ts");
  const { cleanName } = await import("../src/worker/names.ts");
  const g = (id: string, over: Record<string, unknown> = {}) => ({ id, label: `Agent ${id}`, client_name: null, regions: null, ...over });
  const names = displayNames([
    g("1", { client_name: "claude-ai" }),
    g("2", { client_name: "claude-code" }),
    g("3", { client_name: "Cursor", agent_name: "Ani" }),
    g("4", { client_name: "Cursor", agent_name: "Ani", owner_name: "Ani (work)" }),
    g("5", { client_name: "mcp-inspector", client_title: "MCP Inspector" }),
    g("6"),
    g("7", { client_name: "cursor-vscode", regions: ["latam"] }),
  ]);
  assert.deepEqual([...names.values()], ["Claude", "Claude 2", "Ani", "Ani (work)", "MCP Inspector", "Agent 6", "Cursor (LATAM only)"]);
  assert.equal(cleanName("  Ani\n\u0007 the​ bot  "), "Ani the bot");
  assert.equal(cleanName("x".repeat(200))?.length, 40);
  assert.equal(cleanName("<b>Ani</b>"), "<b>Ani</b>", "kept as text; the page never renders it as HTML");
  assert.equal(cleanName("   "), null);
  assert.equal(cleanName(42), null);
});
