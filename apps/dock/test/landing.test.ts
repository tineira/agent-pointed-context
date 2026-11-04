/**
 * The landing at / (TIN-620): the hero says what APC is and plays a silent loop of the drag, self-hosted; two
 * paths follow, Try it and Build it; "Open your dock" appears once, in Try it; the focus Build it shows is Pulse's
 * real output; every docs link names a page and a heading that exist.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { generateDataset } from "../../demo/src/model/seed.ts";
import { resolveFocus, type Grant } from "../../demo/src/worker/domain.ts";
import { headingIds, parseMarkdown } from "../src/docs/markdown.ts";
import { DOC_PAGES } from "../src/docs/pages.ts";
import { FOCUS_EXAMPLE } from "../src/web/landing-example.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const landing = read("apps/dock/src/web/landing.tsx");

test("the hero says what APC is, plays the clip, and links the full video", () => {
  assert.match(landing, /<h1>Point your AI agent at what you see<\/h1>/);
  assert.match(landing, /Drag your agent onto a chart, a row or a paragraph and ask about "this"\. It reads the data underneath, through access it already has\. No screen sharing\./);
  assert.match(landing, /<video[^>]* autoPlay muted loop playsInline /, "a muted loop, inline");
  assert.doesNotMatch(landing, /<video[^>]* controls/, "no player controls");
  assert.match(landing, /href=\{VIDEO\}/);
  assert.match(landing, /const VIDEO = "https:\/\/youtu\.be\/pb46Sd0UOtM"/);
  assert.doesNotMatch(landing, /youtube\.com\/embed|youtube-nocookie|<iframe/, "no YouTube embed: its cookies would break the one-cookie promise");
  for (const agent of ["Claude", "ChatGPT", "Cursor", "Grok"]) assert.match(landing, new RegExp(`name: "${agent}"`));
  assert.match(landing, /any agent that takes an MCP server/);
});

test("the clip is small, silent where it can be checked, and its poster stands in under reduced motion", () => {
  const sizes = ["apc-hero.webm", "apc-hero.mp4", "apc-hero-poster.jpg"].map((f) => statSync(new URL(`apps/dock/public/media/${f}`, root)).size);
  for (const size of sizes.slice(0, 2)) assert.ok(size < 1.5 * 1024 * 1024, `a clip is ${size} bytes, over 1.5 MB`);
  assert.ok(sizes[2]! < 200 * 1024, "the poster stays small");
  for (const path of ["/media/apc-hero.webm", "/media/apc-hero.mp4", "/media/apc-hero-poster.jpg"]) assert.ok(landing.includes(path), path);
  // The MP4 has one track, the video: no audio from the promo's licensed music or voice.
  const mp4 = readFileSync(new URL("apps/dock/public/media/apc-hero.mp4", root));
  assert.equal(mp4.toString("latin1").split("trak").length - 1, 1, "the MP4 has exactly one track");
  assert.ok(!mp4.includes("soun"), "the MP4 has no sound track");
  assert.match(landing, /prefers-reduced-motion: reduce/);
  assert.match(landing, /reduce \|\| failed \? \(\s*<img src=\{CLIP\.poster\}/, "under reduced motion (or with no playable clip) the poster replaces the video");
});

test("two paths: Try it for people using an agent, Build it for people building an app", () => {
  assert.match(landing, /For people using an AI agent<\/span>\s*<h2>Try it<\/h2>/);
  assert.match(landing, /For people building an app<\/span>\s*<h2>Build it<\/h2>/);
  assert.match(landing, /href="#try">Try the demo →</);
  assert.match(landing, /href="#build">Add APC to your app →</);
  assert.match(landing, /<section id="try">/);
  assert.match(landing, /<section id="build">/);
  assert.ok(landing.indexOf('id="try"') < landing.indexOf('id="build"'));
  assert.ok(landing.indexOf('id="build"') < landing.indexOf("What your agent can and cannot see"), "what the agent can see stays at the end");
});

test("Try it opens the dock once and links each demo app; the dock does not launch them", () => {
  assert.equal(landing.match(/Open your dock/g)?.length, 2, "the button's label and its step's title");
  assert.equal(landing.match(/<Cta \/>/g)?.length, 1, "one button");
  const tryIt = landing.slice(landing.indexOf('<section id="try">'), landing.indexOf('<section id="build">'));
  assert.ok(tryIt.includes("<Cta />"));
  assert.match(tryIt, /href=\{PULSE\.url/);
  assert.match(tryIt, /href=\{SIGNALS\.url\}/);
  assert.match(tryIt, /Download for \{d\.label\}/);
  assert.match(tryIt, /href="\/extension"/);
  assert.match(tryIt, /href=\{DIRECT_TRY\}/, "Direct, as a note");
  assert.doesNotMatch(landing, /dock opens Pulse|checklist opens|Open them from your dock|sets up the same world/i, "the dock no longer launches the demo apps (TIN-621)");
});

test("Build it shows a focus that is Pulse's real output for the March bar", () => {
  const grant: Grant = { id: "g", secret: "s", label: "Your agent", client_name: "Claude", regions: null, created_at: "", last_active_at: null };
  const pin = { grant_id: "g", kind: "figure", id: null, part: null, params: { key: "active_customers", month: "2026-03" }, pinned_at: FOCUS_EXAMPLE.pinned_at, seen_at: null };
  assert.deepEqual(resolveFocus(pin, grant, generateDataset(7), "https://pulse.apc.tineira.com"), FOCUS_EXAMPLE);
  assert.match(landing, /JSON\.stringify\(FOCUS_EXAMPLE, null, 2\)/);
});

test("the docs links name pages and headings that exist, and the references are all there", () => {
  const ids = new Map(DOC_PAGES.map((p) => [p.path, new Set(headingIds(parseMarkdown(read(p.file))))]));
  const links = [...landing.matchAll(/\$\{DOCS\}(\/[a-z]+)?(#[a-z0-9-]+)?/g)];
  assert.ok(links.length >= 4);
  for (const [, page = "", hash] of links) {
    const path = `/docs${page}`;
    assert.ok(ids.has(path), `${path} is not a docs page`);
    if (hash) assert.ok(ids.get(path)!.has(hash.slice(1)), `${path}${hash} is not a heading`);
  }
  for (const ref of ["https://doi.org/10.5281/zenodo.23382909", "https://doi.org/10.5281/zenodo.23383101", "blob/main/DESIGN.md", "https://github.com/tineira/agent-pointed-context"]) assert.ok(landing.includes(ref), ref);
  assert.match(landing, /MIT/);
  assert.match(landing, /href="\/v1\/">Version 1, as described in the paper/);
});
