import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { canDrag, dragTitle, fillAgentDrag, startAgentDrag, type DragSink } from "../src/web/agent-drag.ts";

/** A DataTransfer that keeps what was put on it. */
function sink(): DragSink & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, effectAllowed: "none", setData: (type, value) => void data.set(type, value) };
}

const MCP_URL = "https://apc.tineira.com/mcp/d_0123456789abcdef/s3cr3t-0123456789abcdef";
const unconnected = { id: "ag_0a", name: "Agent 1", client_name: null, mcp_url: MCP_URL };
const connected = { ...unconnected, client_name: "Claude" };

test("An agent not connected yet puts nothing on a drag, never its MCP URL (TIN-908)", () => {
  for (const fresh of [undefined, { hub: "https://apc.tineira.com", ticket: "t_0123456789abcdef" }]) {
    const dt = sink();
    assert.equal(fillAgentDrag(dt, unconnected, fresh), false);
    const all = [...dt.data.entries()].flat().join("\n");
    assert.ok(!all.includes("/mcp/"), `the drag held an MCP URL: ${all}`);
    assert.ok(!all.includes("s3cr3t"));
    assert.equal(dt.data.size, 0);
  }
  assert.equal(canDrag(unconnected), false);
  // Its tooltip points to the explicit way to connect it, not to a drag.
  assert.doesNotMatch(dragTitle(unconnected), /drag/i);
  assert.match(dragTitle(unconnected), /Connect this agent/);
});

test("A connected agent drags as the APC payload only: a handle, the hub and a ticket, no URL", () => {
  const dt = sink();
  assert.equal(fillAgentDrag(dt, connected, { hub: "https://apc.tineira.com", ticket: "t_0123456789abcdef" }), true);
  assert.deepEqual([...dt.data.keys()], ["application/x-apc-agent"]);
  assert.deepEqual(JSON.parse(dt.data.get("application/x-apc-agent")!), { v: 1, agent: "ag_0a", hub: "https://apc.tineira.com", ticket: "t_0123456789abcdef" });
  assert.ok(![...dt.data.values()].join("").includes("/mcp/"));
  assert.equal(dt.effectAllowed, "link");
});

test("An agent gone from the dock does not drag", () => {
  const dt = sink();
  assert.equal(fillAgentDrag(dt, undefined, undefined), false);
  assert.equal(dt.data.size, 0);
});

test("A dragstart on an agent not connected yet is cancelled with nothing on it", () => {
  for (const agent of [unconnected, undefined]) {
    const dt = sink();
    const e = { dataTransfer: dt, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    assert.equal(startAgentDrag(e, agent, { hub: "https://apc.tineira.com", ticket: "t_0123456789abcdef" }), false);
    assert.equal(e.defaultPrevented, true);
    assert.equal(dt.data.size, 0);
  }
  // A connected agent's goes ahead, not prevented.
  const dt = sink();
  const e = { dataTransfer: dt, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(startAgentDrag(e, connected, undefined), true);
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual([...dt.data.keys()], ["application/x-apc-agent"]);
});

/** Every source file of the dock's page, at any depth. */
const WEB = new URL("../src/web/", import.meta.url);
const webFiles = (readdirSync(WEB, { recursive: true }) as string[]).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => f.replaceAll("\\", "/"));

test("No file of the dock's page writes a drag of its own: every drag goes through agent-drag.ts", () => {
  assert.ok(webFiles.includes("hub.tsx") && webFiles.includes("pet.tsx"), "the scan found the dock's page");
  for (const file of webFiles) {
    if (file === "agent-drag.ts") continue;
    const src = readFileSync(new URL(file, WEB), "utf8");
    assert.ok(!/\bsetData\s*\(/.test(src), `${file} writes a drag itself`);
    assert.ok(!/\bitems\s*\.\s*add\s*\(/.test(src), `${file} adds an item to a drag itself`);
    assert.ok(!/DownloadURL/.test(src), `${file} puts a DownloadURL on a drag`);
    assert.ok(!/askYourAgentPrompt/.test(src) || file === "setup.tsx" || file === "qr.tsx", `${file} builds the connect prompt`);
    assert.ok(!/drag[^.\n]*into (your|the) agent.s chat/i.test(src), `${file} still says to drag into the chat`);
    // A `draggable` that is always true would start a drag for an agent not connected yet.
    assert.ok(!/^\s*draggable\s*$/m.test(src) && !/<[A-Za-z][^>]*\sdraggable(?=\s*\/?>|\s+[A-Za-z-]+=)/.test(src), `${file} has a bare draggable`);
    assert.ok(!/draggable\s*=\s*(\{\s*true\s*\}|"true"|'true')/.test(src), `${file} has draggable set to true`);
    assert.ok(!/draggable\s*:\s*true\b/.test(src), `${file} has draggable: true`);
  }
});

test("the drag image is the dragged agent's own pet, never the first pet on the page (TIN-969)", async () => {
  const { dragImageOf } = await import("../src/web/agent-drag.ts");
  // React's root holds every tile: its first pet is the first agent's (Claude's).
  const claudePet = { name: "claude-pet" };
  const grokPet = { name: "grok-pet" };
  const el = (pet: object, closest: object | null = null) => ({ querySelector: (s: string) => (s === ".apc-pet" ? pet : null), closest: (s: string) => (s === ".apc-pet" ? closest : null) });
  const root = el(claudePet);
  const grokTile = el(grokPet);
  // The native event React hands the handler: currentTarget is the root, target the tile that was dragged.
  const native = { target: grokTile, currentTarget: root } as unknown as { target: EventTarget };
  assert.equal(dragImageOf(native), grokPet);
  // A drag that starts on the pet itself shows that pet.
  assert.equal(dragImageOf({ target: el({ name: "inner" }, grokPet) as unknown as EventTarget }), grokPet);
  assert.equal(dragImageOf({ target: null }), null);
  // A drag that starts on a child with no pet below it (an image): the pet of the draggable element it sits in.
  const draggable = el(grokPet);
  const child = { querySelector: () => null, closest: (s: string) => (s === '[draggable="true"]' ? draggable : null) };
  assert.equal(dragImageOf({ target: child as unknown as EventTarget }), grokPet);
  // A drag that starts on text: its parent element stands for it.
  assert.equal(dragImageOf({ target: { parentElement: grokTile } as unknown as EventTarget }), grokPet);
  // Something with no DOM methods gives no image, never another agent's.
  assert.equal(dragImageOf({ target: {} as unknown as EventTarget }), null);
  assert.equal(dragImageOf({ target: { querySelector: () => claudePet } as unknown as EventTarget }), null);
});

test("every drag start in the dock takes its image through dragImageOf, never from the event's currentTarget (TIN-969)", () => {
  const hub = readFileSync(new URL("../src/web/hub.tsx", import.meta.url), "utf8");
  assert.match(hub, /const pet = dragImageOf\(e\);/);
  for (const name of readdirSync(new URL("../src/web/", import.meta.url)).filter((f) => f.endsWith(".tsx"))) {
    const source = readFileSync(new URL(`../src/web/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /currentTarget[^;\n]*querySelector\(\s*["']\.apc-pet/, `${name} picks the drag image from currentTarget`);
  }
});
