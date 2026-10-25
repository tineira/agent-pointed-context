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
  assert.equal(id("zcode"), "zai", "Z.ai's ZCode (TIN-415)");
  assert.equal(id("ZCode"), "zai");
  assert.equal(id("z-code"), "zai");
  assert.equal(id("claude-code"), "claude", "ZCode's match does not take Claude Code");
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

test("every Grok bot shows the same base logo (TIN-365)", async () => {
  const { GROK_BOT_PNG } = await import("../src/web/agent-logos.ts");
  const logo = brandFor("Cursor", "Cursor/1.0.0")?.logo;
  assert.ok(logo && "image" in logo && logo.image === GROK_BOT_PNG);
  assert.match(GROK_BOT_PNG, /^data:image\/png;base64,/);
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

test("one URL, one product: grok.com's two names are one product, the Grok bot and Cursor are not (TIN-358)", async () => {
  const { sameProduct, productName } = await import("../src/model/products.ts");
  assert.ok(sameProduct("grok-validator", "grok-connectors-manager/0.1.0", "connectors-manager", "grok-connectors-manager/0.1.0"));
  assert.ok(sameProduct("claude-ai", null, "claude-code", "Claude-User"));
  assert.equal(sameProduct("connectors-manager", null, "Cursor", "Cursor/1.0.0"), false);
  assert.equal(sameProduct("Cursor", "Cursor/1.0.0", "cursor-vscode", "Cursor/3.27.6 (win32 x64)"), false);
  assert.ok(sameProduct("mcp-inspector", null, "mcp-inspector", null));
  assert.equal(sameProduct("mcp-inspector", null, "other-client", null), false);
  assert.equal(productName("Cursor"), "Grok bot");
  assert.equal(productName("mcp-inspector"), "mcp-inspector");
});

test("Gemini is known by its user agent when it names itself mcp (TIN-364)", async () => {
  const { productOf, sameProduct } = await import("../src/model/products.ts");
  const { brandFor, displayNames } = await import("../src/web/agent-brands.ts");
  assert.equal(productOf("mcp", "Google")?.id, "gemini");
  assert.equal(productOf("Gemini", "Google")?.id, "gemini");
  assert.equal(productOf("mcp", "node"), null, "a client named mcp with another user agent stays unknown");
  assert.ok(sameProduct("mcp", "Google", "Gemini", "Google"), "no shared-URL warning between Gemini's two names");
  assert.equal(brandFor("mcp", "Google")?.id, "gemini");
  assert.deepEqual([...displayNames([{ id: "g", label: "Your agent", client_name: "mcp", client_ua: "Google", regions: null }]).values()], ["Gemini"]);
  assert.equal(productOf("claude-code", "Google")?.id, "claude", "a name match wins over the user agent");
});
