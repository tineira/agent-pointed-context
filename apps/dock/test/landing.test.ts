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
import { clipFallback } from "../src/web/clip-fallback.ts";
import { FOCUS_EXAMPLE } from "../src/web/landing-example.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const landing = read("apps/dock/src/web/landing.tsx");
const video = landing.slice(landing.indexOf("<video"), landing.indexOf("</video>"));

test("the hero says what APC is, plays the clip, and links the full video", () => {
  assert.match(landing, /<h1>Point your AI agent at what you see<\/h1>/);
  assert.match(landing, /Drag your agent onto a chart, a row or a paragraph and ask about "this"\. It reads the data underneath, through access it already has\. No screen sharing\./);
  assert.match(video, /^<video\s[^]*?\sautoPlay\s+muted\s+loop\s+playsInline\s/, "a muted loop, inline");
  assert.doesNotMatch(video, /\bcontrols\b/, "no player controls");
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

test("a clip that fails falls back: a failed WebM to the MP4, and no playable clip to the poster", () => {
  // <source> errors do not bubble to the video: the browser moves on to the next source, and only the last one failing means no clip.
  assert.equal(clipFallback({ on: "source", last: false }), "wait");
  assert.equal(clipFallback({ on: "source", last: true }), "poster");
  // A file that loads but cannot be decoded fires on the video.
  assert.equal(clipFallback({ on: "video", currentSrc: "https://apc.tineira.com/media/apc-hero.webm" }), "mp4");
  assert.equal(clipFallback({ on: "video", currentSrc: "https://apc.tineira.com/media/apc-hero.webm?v=2" }), "mp4");
  assert.equal(clipFallback({ on: "video", currentSrc: "https://apc.tineira.com/media/apc-hero.mp4" }), "poster");
  assert.equal(clipFallback({ on: "video", currentSrc: "" }), "poster");
  // And the page wires every one of them: both sources and the video.
  assert.match(video, /<source src=\{CLIP\.webm\} type="video\/webm" onError=\{\(\) => fallBack\(\{ on: "source", last: false \}\)\} \/>/);
  assert.match(video, /<source src=\{CLIP\.mp4\} type="video\/mp4" onError=\{\(\) => fallBack\(\{ on: "source", last: true \}\)\} \/>/);
  // React bubbles a source's error to the video's onError: the video acts on its own errors only.
  assert.match(video, /onError=\{\(e\) => e\.target === e\.currentTarget && fallBack\(\{ on: "video", currentSrc: e\.currentTarget\.currentSrc \}\)\}/);
});

test("the clip's button follows the video and says what it does", () => {
  assert.match(video, /onPlay=\{\(\) => setPaused\(false\)\}/);
  assert.match(video, /onPause=\{\(\) => setPaused\(true\)\}/);
  assert.match(landing, /\{paused \? "Play animation" : "Pause animation"\}/);
  assert.doesNotMatch(landing, /aria-pressed/, "a label that changes, so no pressed state");
  const css = read("apps/dock/src/web/dock.css");
  assert.doesNotMatch(css.match(/^\.landing-stage-toggle \{[^}]*\}/m)![0], /opacity: 0;/, "the button is always visible");
});

test("the orange buttons and links pass 4.5:1 in both themes", () => {
  const css = read("apps/dock/src/web/dock.css");
  const tokens = (line: string) => Object.fromEntries([...line.matchAll(/--([a-z]+): (#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  const light = tokens(css.split("\n")[0]!);
  const dark = tokens(css.split("\n").find((l) => l.startsWith("@media (prefers-color-scheme: dark)"))!);
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  assert.match(css, /^\.landing-cta \{[^}]*background: var\(--accent\); color: var\(--card\);/m, "the button's ink is the card colour, not white");
  for (const [name, t] of [["light", light], ["dark", dark]] as const) {
    assert.ok(contrast(t.card!, t.accent!) >= 4.5, `${name}: button text ${contrast(t.card!, t.accent!).toFixed(2)}:1`);
    for (const bg of ["bg", "card"]) assert.ok(contrast(t.accent!, t[bg]!) >= 4.5, `${name}: an orange link on --${bg} is ${contrast(t.accent!, t[bg]!).toFixed(2)}:1`);
  }
});

test("two paths: Try it for people using an agent, Build it for people building an app", () => {
  assert.match(landing, /For people using an AI agent<\/span>\s*<h3>Try it<\/h3>/);
  assert.match(landing, /For people building an app<\/span>\s*<h3>Build it<\/h3>/);
  // The sections the cards lead to are the page's h2s, named as the cards are.
  assert.match(landing, /<section id="try">\s*<h2 className="landing-eyebrow">Try it<\/h2>/);
  assert.match(landing, /<section id="build">\s*<h2 className="landing-eyebrow">Build it<\/h2>/);
  assert.match(landing, /href="#try">Try the demo →</);
  assert.match(landing, /href="#build">Add APC to your app →</);
  assert.match(landing, /<section id="try">/);
  assert.match(landing, /<section id="build">/);
  assert.ok(landing.indexOf('id="try"') < landing.indexOf('id="build"'));
  assert.ok(landing.indexOf('id="build"') < landing.indexOf("What your agent can and cannot see"), "what the agent can see stays at the end");
});

test("Try it opens the dock once and links each demo app; the dock does not launch them", () => {
  assert.equal(landing.match(/Open your dock/g)?.length, 1, "only the button says it; the step and the top bar say \"Your dock\"");
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
