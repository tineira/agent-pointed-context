/**
 * Which connect copy Pulse's v2 deploy shows (TIN-1098): where APC_PROFILES offers Direct — the
 * standard's deploy, "direct,dock" — the data pages' hint and the How-to teach connecting directly (the
 * site's /try walk) and never invite anyone to an agent dock; a dock-only deploy (no Direct) keeps the
 * dock copy until the 2.0 cut (TIN-1011). The choice and the Direct text live in direct-copy.ts, which
 * this imports; dock-only.tsx and the Wake on pin card are TSX, which `node --test` cannot import (no
 * loader, see strings.test.ts), so their branch and their kept dock copy are read back from the source,
 * as strings.test.ts does for the wrappers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DIRECT_HINT, DIRECT_INTRO, DIRECT_STEPS, directOffered } from "../src/web/direct-copy.ts";

/** The standard's deploy (apps/demo/wrangler.jsonc): v2, both profiles; the chooser reads the state's profiles. */
const STANDARD = { profiles: ["direct", "dock"] };
/** A dock-only deploy: v2, no Direct. */
const DOCK_ONLY = { profiles: ["dock"] };

test("the profiles decide: the Direct copy where Direct is offered, the dock copy on a dock-only deploy", () => {
  assert.equal(directOffered(STANDARD), true, "the standard deploy (direct,dock)");
  assert.equal(directOffered({ profiles: ["direct"] }), true, "a Direct-only deploy");
  assert.equal(directOffered(DOCK_ONLY), false, "a dock-only deploy");
  assert.equal(directOffered({}), false, "a broken APC_PROFILES serves no path (profiles.test.ts); the dock copy is the fallback");
});

test("the Direct copy is the /try walk: the Agents page's address, a remote MCP server, the drag from the top, the question", () => {
  assert.equal(DIRECT_STEPS.length, 4, "the four steps");
  assert.match(DIRECT_HINT, /Make one on the Agents page/, "the hint names the Agents page");
  assert.match(DIRECT_HINT, /MCP address, with Copy/);
  assert.match(DIRECT_HINT, /Copy prompt/);
  assert.match(DIRECT_HINT, /remote MCP server/);
  assert.match(DIRECT_HINT, /drag its mark from the top/);
  assert.match(DIRECT_STEPS[0]!, /Agents page/);
  assert.match(DIRECT_STEPS[1]!, /remote MCP server/);
  assert.match(DIRECT_STEPS[2]!, /Drag your agent's mark from the top onto a bar, a step of the bridge or a customer/);
  assert.match(DIRECT_STEPS[3]!, /"what is this\?"/);
  for (const text of [DIRECT_HINT, DIRECT_INTRO, ...DIRECT_STEPS]) {
    assert.doesNotMatch(text, /dock/i, `no dock invitation where Direct is offered: "${text.slice(0, 40)}…"`);
  }
});

test("dock-only.tsx renders by the same choice, and a dock-only deploy keeps its dock copy", () => {
  const src = readFileSync(new URL("../src/web/dock-only.tsx", import.meta.url), "utf8");
  assert.equal((src.match(/directOffered\(props\.state\)/g) ?? []).length, 2, "DockHint and DockHowTo each choose by the profiles");
  assert.match(src, /\{DIRECT_HINT\}/, "the hint's Direct body comes from direct-copy.ts");
  assert.match(src, /direct \? DIRECT_INTRO :/, "the How-to's lead picks by the profiles");
  assert.match(src, /direct \? DIRECT_STEPS : STEPS\(/, "the How-to's steps pick by the profiles");
  assert.match(src, /<AppLink href="\/agents">Agents →<\/AppLink>/, "the hint still links the Agents page");
  // What a dock-only deploy keeps (until the 2.0 cut, TIN-1011): the dock invitation, once each.
  assert.equal((src.match(/Drag your agent from your agent dock/g) ?? []).length, 1, "the hint's dock invitation");
  assert.equal((src.match(/You point it here from your agent dock/g) ?? []).length, 1, "the How-to's dock lead");
  assert.doesNotMatch(src, /Or connect app by app/, "the old Direct add-on section is gone: where Direct is offered, its steps are the How-to");
});

test("Wake on pin mentions the dock only when a dock agent is linked", () => {
  const wake = readFileSync(new URL("../src/web/wake-on-pin.tsx", import.meta.url), "utf8");
  assert.match(wake, /props\.dockLinked && " An agent that also has Wake on pin in your dock/, "the dock sentence sits behind the prop");
  const pages = readFileSync(new URL("../src/web/pages.tsx", import.meta.url), "utf8");
  assert.match(pages, /dockLinked=\{\(state\.hub_links \?\? \[\]\)\.length > 0\}/, "the Agents screen passes whether a dock agent is linked");
});
