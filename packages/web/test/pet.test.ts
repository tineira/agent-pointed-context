import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The agent in the page (TIN-878): the pet's states as an app feeds them, the header's 3 + N layout,
 * reduced motion, the colour scheme, the brand logos, and the components on a DOM just big enough for
 * them (there is no browser in `node --test`).
 */
import { defined, doc, El, locale, visible } from "./fake-dom.ts";

const { petState, PET_STATES } = await import("../src/pet-state.ts");
const { petLayout, PET_MAX, defineHeaderPets } = await import("../src/header-pets.ts");
const { petPalette, petFill, petHex, resolvePetScheme, PET_DARK_BODY } = await import("../src/pet-scheme.ts");
const { BODY, BODY_GREY, frameAt, POSES, FX, stilled } = await import("../src/pet-pose.ts");
const { createPet, petPhase, drawBadge } = await import("../src/pet.ts");
const { APC_BRANDS, agentBadge, brandFor, colorFor } = await import("../src/brands.ts");
const { definePinBadge, pinStackIndex, PIN_STACK_STEP } = await import("../src/pin-badge.ts");
const { DEFAULT_PETS_STRINGS } = await import("../src/strings.ts");

/** The window the pets run in: frames are counted, never run, unless a test runs them. */
const frames: Array<(ms: number) => void> = [];
let reduce = false;
let dark = false;
const media = new Map<string, Set<() => void>>();
const win = globalThis.window as unknown as Record<string, unknown>;
Object.assign(win, {
  document: doc,
  performance: { now: () => 0 },
  requestAnimationFrame: (fn: (ms: number) => void) => (frames.push(fn), frames.length),
  cancelAnimationFrame: () => {},
  setTimeout: (fn: () => void) => (frames.push(() => fn()), frames.length),
  clearTimeout: () => {},
  matchMedia: (q: string) => ({
    get matches() {
      return q.includes("reduced-motion") ? reduce : q.includes("color-scheme") ? dark : false;
    },
    addEventListener: (_t: string, fn: () => void) => media.set(q, new Set([...(media.get(q) ?? []), fn])),
    removeEventListener: (_t: string, fn: () => void) => media.get(q)?.delete(fn),
  }),
});
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));
const part = (svg: El, k: string) => svg.elements().find((e) => e.getAttribute("data-k") === k)!;

test("The pet's state comes only from what the app says: no wait is ever inferred (TIN-878)", () => {
  assert.equal(petState(), "idle");
  assert.equal(petState({}), "idle");
  // Waiting shows only when the input says a wait is open, never from a recent call.
  assert.equal(petState({ busy: false }), "idle");
  assert.equal(petState({ waiting: true }), "waiting");
  assert.equal(petState({ waiting: false }), "idle");
  // The app's own data, each in its place: a call in flight, a pin, a pairing, offline or revoked, a drag.
  assert.equal(petState({ busy: true, waiting: true }), "calling");
  assert.equal(petState({ pin: "unread", waiting: true }), "pinned");
  assert.equal(petState({ pin: "read" }), "read");
  assert.equal(petState({ requests: 1 }), "pairing");
  assert.equal(petState({ revoked: true, waiting: true }), "offline");
  assert.equal(petState({ connected: false }), "offline");
  assert.equal(petState({ dragging: true, revoked: true }), "dragging");
  assert.equal(PET_STATES.length, 8);
});

test("The header shows at most three pets, and +N for the rest", () => {
  assert.equal(PET_MAX, 3);
  assert.deepEqual(petLayout([]), { shown: [], extra: 0 });
  assert.deepEqual(petLayout(["a"]), { shown: ["a"], extra: 0 });
  assert.deepEqual(petLayout(["a", "b", "c"]), { shown: ["a", "b", "c"], extra: 0 });
  assert.deepEqual(petLayout(["a", "b", "c", "d"]), { shown: ["a", "b", "c"], extra: 1 });
  assert.deepEqual(petLayout(["a", "b", "c", "d", "e", "f", "g"]), { shown: ["a", "b", "c"], extra: 4 });
  assert.deepEqual(petLayout(["a", "b", "c"], 1), { shown: ["a"], extra: 2 });
});

test("Light is the pet the dock always drew; dark is its inverse, with the same state marks (TIN-878)", () => {
  const light = petPalette("light");
  // The dock's colours, unchanged: a dark body, white outline and eyes, a white shine, no ring on the badge.
  assert.deepEqual(light, { body: "#23262f", bodyGrey: "#9aa0ab", line: "#ffffff", shineFrom: { color: "#ffffff", opacity: 0.22 }, shineTo: { color: "#ffffff", opacity: 0 }, badgeOutline: null });
  assert.equal(BODY, "#23262f");
  assert.equal(BODY_GREY, "#9aa0ab");
  // The light body, painted from the palette, is the colour the pose always gave it, offline grey included.
  for (const g of [0, 0.25, 0.5, 1]) assert.equal(petFill(light, g), frameAt({ ...POSES.idle, grey: g }, FX.idle, 1, false).fill);

  const dark = petPalette("dark");
  const lum = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).reduce((a, b) => a + b) / 3;
  assert.notEqual(dark.body, "#ffffff");
  assert.equal(dark.body, PET_DARK_BODY);
  assert.ok(lum(dark.body) > 0.85 && lum(dark.body) < 1, "near-white body, never pure white");
  assert.ok(lum(dark.line) < 0.2, "a dark outline and eyes");
  assert.equal(dark.badgeOutline, dark.line, "the badge's disc keeps a thin outline");
  assert.ok(dark.shineFrom.opacity > light.shineFrom.opacity, "a shine tuned to the light body");

  // "auto" follows prefers-color-scheme; an app with a theme switch passes its theme.
  assert.equal(resolvePetScheme("auto", true), "dark");
  assert.equal(resolvePetScheme("auto", false), "light");
  assert.equal(resolvePetScheme("dark", false), "dark");
  assert.equal(resolvePetScheme("light", true), "light");
  assert.equal(resolvePetScheme(undefined, true), "light");

  // The token hook: an app with a strict palette tints the body and the line, in hex; anything else is ignored.
  assert.equal(petPalette("dark", { body: "#e9e6dd", line: "#141414" }).body, "#e9e6dd");
  assert.equal(petPalette("dark", { line: "#141414" }).badgeOutline, "#141414");
  assert.equal(petPalette("light", { body: "red" }).body, "#23262f");
  assert.equal(petHex("#ABC"), "#aabbcc");
  assert.equal(petHex("var(--x)"), null);
});

test("Reduced motion: a still pose, drawn once, with no frame loop; a state change repaints it", async () => {
  reduce = true;
  frames.length = 0;
  const pet = createPet({ state: "pinned", label: "Claude", size: 40 }, doc as unknown as Document);
  const svg = pet.element as unknown as El;
  assert.equal(frames.length, 0, "no requestAnimationFrame with reduced motion");
  const still = frameAt(stilled(POSES.pinned), FX.pinned, 0, true);
  assert.equal(part(svg, "group").getAttribute("transform"), `translate(0 ${still.bob.toFixed(2)}) rotate(${still.tilt.toFixed(2)})`);
  assert.equal(part(svg, "ring").getAttribute("opacity"), "0.950");
  pet.update({ state: "read" });
  assert.equal(part(svg, "check").getAttribute("opacity"), "1.000");
  assert.equal(part(svg, "ring").getAttribute("opacity"), "0.000");
  assert.equal(frames.length, 0);
  pet.destroy();

  // With motion, one loop for the window: the first frame is drawn at once, then frames follow.
  reduce = false;
  const a = createPet({ state: "idle", label: "A" }, doc as unknown as Document);
  const b = createPet({ state: "calling", label: "B" }, doc as unknown as Document);
  assert.equal(frames.length, 1, "one requestAnimationFrame for every pet in the window");
  assert.notEqual(part(a.element as unknown as El, "body").getAttribute("d"), "");
  frames.shift()!(16);
  assert.equal(frames.length, 1, "the loop goes on while pets run");
  a.destroy();
  b.destroy();
  frames.length = 0;
  await flushMicrotasks();
});

test("The pet's colours follow its scheme, and auto follows the page (TIN-878)", async () => {
  reduce = true;
  dark = false;
  const pet = createPet({ state: "idle", label: "Claude", badge: { image: "data:image/png;base64,AA" }, scheme: "auto" }, doc as unknown as Document);
  const svg = pet.element as unknown as El;
  assert.equal(part(svg, "body").getAttribute("stroke"), "#ffffff");
  assert.equal(part(svg, "body").getAttribute("fill"), "rgb(35,38,47)");
  const disc = () => part(svg, "badge").children[0] as El;
  assert.equal(disc().getAttribute("stroke"), null);
  // The page turns dark: the pet repaints as the inverse at once.
  dark = true;
  for (const fn of media.get("(prefers-color-scheme: dark)") ?? []) fn();
  assert.equal(part(svg, "body").getAttribute("fill"), "rgb(232,233,236)");
  assert.equal(part(svg, "left").getAttribute("fill"), "#1b1e25");
  assert.equal(disc().getAttribute("stroke"), "#1b1e25");
  // The state marks do not change.
  assert.equal(part(svg, "ring").getAttribute("stroke"), "#f08a3e");
  // An app with its own theme switch passes its theme.
  pet.update({ scheme: "light" });
  assert.equal(part(svg, "body").getAttribute("fill"), "rgb(35,38,47)");
  pet.update({ scheme: "dark", tint: { body: "#e9e6dd" } });
  assert.equal(part(svg, "body").getAttribute("fill"), "rgb(233,230,221)");
  pet.destroy();
  dark = false;
  await flushMicrotasks();
});

test("The SVG is the dock's pet, part for part (the dock's look does not change)", () => {
  reduce = true;
  const svg = createPet({ state: "idle", label: "Claude", size: 96, badge: { image: "data:x" } }, doc as unknown as Document).element as unknown as El;
  assert.equal(svg.getAttribute("class"), "apc-pet");
  assert.equal(svg.getAttribute("viewBox"), "-100 -110 200 200");
  assert.equal(svg.getAttribute("width"), "96");
  assert.equal(svg.getAttribute("role"), "img");
  assert.equal(svg.getAttribute("aria-label"), "Claude, connected");
  const shape = (e: El): string => `${e.tagName.toLowerCase()}${e.getAttribute("data-k") ? `[${e.getAttribute("data-k")}]` : ""}`;
  // The tree the dock's apc-pet.tsx rendered, in order.
  assert.deepEqual(
    svg.elements().map(shape),
    ["defs", "radialgradient", "stop", "stop", "clippath", "circle", "g[group]", "circle[ring]", "path[body]", "path[shine]", "rect[left]", "rect[right]", "path[wink]", "g[badge]", "circle", "image", "g[bang]", "rect", "circle", "circle[orbit0]", "circle[orbit1]", "circle[orbit2]", "g[check]", "circle", "path", "text[zz0]", "text[zz1]"],
  );
  const ring = part(svg, "ring");
  for (const [k, v] of Object.entries({ fill: "none", stroke: "#f08a3e", "stroke-width": "3.5", "stroke-dasharray": "9 7", "stroke-linecap": "round" })) assert.equal(ring.getAttribute(k), v, k);
  assert.equal(part(svg, "body").getAttribute("stroke-width"), "2.5");
  assert.equal(part(svg, "badge").getAttribute("transform"), "translate(40 38)");
  const [disc, image] = part(svg, "badge").children as El[];
  assert.deepEqual([disc!.getAttribute("r"), disc!.getAttribute("fill")], ["19", "#fff"]);
  assert.deepEqual(["x", "y", "width", "height"].map((k) => image!.getAttribute(k)), ["-15.5", "-15.5", "31", "31"]);
  assert.equal(part(svg, "orbit0").getAttribute("stroke"), "#23262f");
  assert.equal(part(svg, "zz1").getAttribute("font-size"), "24");
  // No badge: nothing on the body (the dock before the hub has a logo).
  const bare = createPet({ state: "idle", label: "x", decorative: true }, doc as unknown as Document).element as unknown as El;
  assert.equal(part(bare, "badge").children.length, 0);
  assert.equal(bare.getAttribute("aria-hidden"), "true");
  assert.equal(bare.getAttribute("role"), null);
  // Size is themeable: left out, the pet is --apc-pet-size.
  assert.match(createPet({ state: "idle", label: "x" }, doc as unknown as Document).element.getAttribute("style") ?? "", /var\(--apc-pet-size, 100%\)/);
});

test("Logos are brands only, and an agent with none wears its own colour (TIN-388)", () => {
  assert.deepEqual(APC_BRANDS.map((b) => b.id), ["grok", "claude", "openai", "antigravity", "gemini", "cursor", "kimi", "zai"]);
  assert.equal(brandFor("claude-code")?.id, "claude");
  assert.equal(brandFor("Cursor")?.id, "cursor");
  assert.equal(brandFor("mcp", "Googlebot")?.id, undefined);
  assert.equal(brandFor("mcp", "Google")?.id, "gemini");
  assert.equal(brandFor("my-own-client"), null);
  assert.deepEqual(agentBadge({ clientName: "my-own-client", key: "g1" }), { color: colorFor("my-own-client") });
  assert.deepEqual(agentBadge({ clientName: null, key: "g1" }), { color: colorFor("g1") });
  assert.deepEqual(agentBadge({ clientName: "x", icon: "data:y", key: "g1" }), { image: "data:y" });
  assert.notEqual(colorFor("a"), colorFor("b"));
  // A vector logo draws on the white disc; a neutral mark is a disc in the agent's colour with two eyes.
  const vector = drawBadge(doc as unknown as Document, brandFor("claude")!.logo, "c") as unknown as El[];
  assert.deepEqual(vector.map((e) => e.tagName.toLowerCase()), ["circle", "svg"]);
  const neutral = drawBadge(doc as unknown as Document, { color: "hsl(1 2% 3%)" }, "c") as unknown as El[];
  assert.equal(neutral[1]!.getAttribute("fill"), "hsl(1 2% 3%)");
  assert.equal(neutral.length, 4);
  assert.ok(petPhase("g1") !== petPhase("g2"));
});

test("<apc-pets>: three pets as marks, +N, a popover with every agent, and apc-open (TIN-878)", async () => {
  reduce = true;
  defineHeaderPets();
  const Pets = defined.get("apc-pets")!;
  const el = new Pets() as El & { agents: unknown; strings: unknown; scheme: string };
  doc.body.append(el);
  const agents = [
    { id: "g1", name: "Claude", state: "waiting", pin: { label: "order 7", seen: false, here: true } },
    { id: "g2", name: "Codex", state: "calling", pin: { label: "order 9", seen: true, here: false } },
    { id: "g3", name: "Gemini", state: "idle" },
    { id: "g4", name: "Kimi", state: "offline" },
    { id: "g5", name: "Grok", state: "pairing" },
  ];
  el.agents = agents;
  const pets = el.elements().filter((e) => e.className === "apc-pets__pet");
  assert.deepEqual(pets.map((p) => p.getAttribute("data-grant")), ["g1", "g2", "g3"]);
  for (const p of pets) {
    assert.ok(p.hasAttribute("data-apc-mark"), "a pet is a mark enablePinning drags by");
    assert.equal(p.tagName, "BUTTON");
  }
  assert.equal(pets[0]!.getAttribute("aria-label"), "Claude, waiting for you to point");
  // The pin of Codex is not on this page: a dot, and it says so.
  assert.equal((pets[1]!.elements().find((e) => e.className === "apc-pets__dot") as El).hidden, false);
  assert.equal((pets[0]!.elements().find((e) => e.className === "apc-pets__dot") as El).hidden, true);
  const more = el.elements().find((e) => e.className === "apc-pets__more")!;
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, "+2");
  assert.equal(more.getAttribute("aria-label"), "2 more agents");
  // The popover lists all five; a pin opens.
  const popover = el.elements().find((e) => e.className === "apc-pets__popover")!;
  assert.equal(popover.hidden, true);
  pets[0]!.fire("click");
  assert.equal(popover.hidden, false);
  assert.equal(pets[0]!.getAttribute("aria-expanded"), "true");
  assert.equal(popover.elements().filter((e) => e.tagName === "LI").length, 5);
  const opened: string[] = [];
  el.addEventListener("apc-open", (e) => opened.push((e as CustomEvent<{ id: string }>).detail.id));
  popover.elements().find((e) => e.className === "apc-pets__open" && e.textContent.includes("order 9"))!.fire("click");
  assert.deepEqual(opened, ["g2"]);
  assert.equal(popover.hidden, true);
  // Escape closes it too.
  more.fire("click");
  for (const fn of doc.listeners.get("keydown") ?? []) fn({ key: "Escape" });
  assert.equal(popover.hidden, true);
  // Fewer agents: the pets that left go, +N hides; the pet that stays is the same element (its motion goes on).
  el.agents = agents.slice(0, 2);
  const after = el.elements().filter((e) => e.className === "apc-pets__pet");
  assert.equal(after.length, 2);
  assert.equal(after[0], pets[0]);
  assert.equal(more.hidden, true);
  el.agents = [];
  assert.equal(el.hidden, true);

  // Every word it shows is a string the app can pass.
  const used = new Set<string>();
  el.strings = locale(DEFAULT_PETS_STRINGS, used);
  el.agents = agents;
  el.elements().find((e) => e.className === "apc-pets__pet")!.fire("click");
  for (const t of visible(el)) if (!["×", "z", "+2", "Claude", "Codex", "Gemini", "Kimi", "Grok"].includes(t)) assert.ok(t.includes("«"), `"${t}" is not from the strings option`);
  for (const key of Object.keys(DEFAULT_PETS_STRINGS)) assert.ok(used.has(key) || visible(el).some((t) => t.includes(`«${key}»`)), `${key} is never shown`);
  el.remove();
  await flushMicrotasks();
});

test("<apc-pin> wears the agent's badge when it has no icon, and badges on one target stack", () => {
  definePinBadge();
  const Pin = defined.get("apc-pin")!;
  const pin = new Pin() as El & { agent: unknown };
  doc.body.append(pin);
  pin.agent = { id: "g1", name: "Claude", seen: false, badge: brandFor("claude")!.logo };
  assert.ok(pin.elements().some((e) => e.getAttribute("class") === "apc-pin__badge"));
  pin.agent = { id: "g1", name: "Claude", seen: false, icon: "data:z", badge: brandFor("claude")!.logo };
  assert.ok(pin.elements().some((e) => e.tagName === "IMG"));
  assert.ok(!pin.elements().some((e) => e.getAttribute("class") === "apc-pin__badge"));
  pin.remove();
  const t = (id: string) => ({ kind: "order", id });
  const pins = [
    { id: "a", target: t("1") },
    { id: "b", target: t("2") },
    { id: "c", target: t("1") },
  ];
  assert.deepEqual(["a", "b", "c"].map((id) => pinStackIndex(pins, id)), [0, 0, 1]);
  assert.equal(pinStackIndex(pins, "zz"), 0);
  assert.equal(PIN_STACK_STEP, 30);
});
