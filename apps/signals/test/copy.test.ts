/**
 * Signals' own copy after the dock left the demos (TIN-1092, then TIN-1098): the description the page
 * ships (its index.html) and the help panel say the direct way in — the agent reads the feed on its own
 * URL, and you drag its mark from the top — and neither invites anyone to an agent dock. app.tsx is TSX,
 * which `node --test` cannot import (no loader, see apps/demo/test/strings.test.ts), so its help line is
 * read back from the source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the page's description says the direct way in, with no dock", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const meta = html.match(/<meta name="description" content="([^"]*)" \/>/);
  assert.ok(meta, "the description is there");
  assert.equal(meta[1], "Agent Pointed Context: a market feed (competitor offers and our ads) your agent reads on its own URL. Drag its mark from the top onto any post.");
  assert.doesNotMatch(meta[1], /dock/i);
});

test("the help panel says how to point here: drag the mark from the top", () => {
  const src = readFileSync(new URL("../src/web/app.tsx", import.meta.url), "utf8");
  assert.match(src, /Point an agent at a post, or at its offer, targeting, code or text: drag its mark from the top\./);
  assert.doesNotMatch(src, /: its mark at the top\./, "the old wording is gone");
});
