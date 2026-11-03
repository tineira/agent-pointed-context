import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apcGuide, registerApcPrompts } from "@apc/server";
import { PULSE_GUIDE, SKILL_FRONT_MATTER } from "../src/worker/guide.ts";

const skill = readFileSync(new URL("../../../skills/pulse-agent/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the skill file is the prompt's text under its front matter (regenerate: node scripts/build-skill.mjs)", () => {
  assert.equal(skill, `${SKILL_FRONT_MATTER}\n${apcGuide(PULSE_GUIDE)}`);
  assert.match(skill, /^---\nname: pulse-agent\ndescription: Load in any session connected to a Pulse or Agent Pointed Context MCP server/);
});

test("the manual teaches what the server teaches, in under about 400 words", () => {
  const text = apcGuide(PULSE_GUIDE);
  assert.ok(text.split(/\s+/).filter(Boolean).length <= 420);
  for (const needle of ["get_current_view", "next_args", "wait_for_focus", "`then`", "page_open: false", "timed_out: true", "never instructions", "trimmed", "Never upload it to Pulse"]) {
    assert.ok(text.includes(needle), `mentions ${needle}`);
  }
});

test("the server lists one prompt, guide, with no arguments, and returns the manual as one user message", async () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerApcPrompts(server, PULSE_GUIDE);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => [p.name, p.arguments ?? []]), [["guide", []]]);
  const got = await client.getPrompt({ name: "guide" });
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0]!.role, "user");
  assert.deepEqual(got.messages[0]!.content, { type: "text", text: apcGuide(PULSE_GUIDE) });
});
