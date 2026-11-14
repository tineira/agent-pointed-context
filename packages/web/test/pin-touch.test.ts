import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The pin badge and the pets on touch (TIN-903): the × never covers the mark, the stack step grows,
 * a pin with no route is text, the app's own links sit in the popover, and the armed mark wears
 * data-armed and aria-pressed itself. There is no browser in `node --test`: the badge's geometry is read
 * from its own CSS, then checked as rectangles at a 375 px phone.
 */
import { APC_MOBILE_MEDIA } from "@tineira/apc-protocol";
import { defined, doc, El } from "./fake-dom.ts";

const { PIN_BADGE_CSS, PIN_STACK_STEP, PIN_STACK_STEP_TOUCH, pinStackStep, pinBadgeX, pinStackIndex, definePinBadge } = await import("../src/pin-badge.ts");
const { defineHeaderPets, safeLinkHref } = await import("../src/header-pets.ts");
const { enablePinning } = await import("../src/pinning.ts");

const win = globalThis.window as unknown as Record<string, unknown>;
Object.assign(win, {
  document: doc,
  performance: { now: () => 0 },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  setTimeout: () => 1,
  clearTimeout: () => {},
  matchMedia: (q: string) => ({ matches: q.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }),
});

// ---- the badge's geometry, from its CSS ----

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const overlaps = (a: Rect, b: Rect) => a.x1 > b.x0 && a.x0 < b.x1 && a.y1 > b.y0 && a.y0 < b.y1;
const SIZE = 28;

/** A px length as the badge's CSS writes it: `Npx`, or `calc(var(--apc-pin-size, 28px) + Npx)`. */
function px(value: string): number {
  const v = value.replace(/var\(--apc-pin-size,\s*(\d+)px\)/g, "$1");
  const calc = /^calc\((-?[\d.]+)\s*\+\s*(-?[\d.]+)px\)$/.exec(v);
  if (calc) return Number(calc[1]) + Number(calc[2]);
  const n = /^(-?[\d.]+)(?:px)?$/.exec(v.trim());
  if (!n) throw new Error(`cannot read ${value}`);
  return Number(n[1]);
}
const declarations = (body: string): Record<string, string> => Object.fromEntries([...body.matchAll(/([\w-]+):\s*([^;]+);?/g)].map((m) => [m[1]!, m[2]!.trim()]));
const ruleBody = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return "";
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
};

/** Where the × and its hit area sit in the badge's own box (the mark is 0..28), with `touch` on or off. */
function unpinBoxes(touch: boolean): { x: Rect; hit: Rect } {
  const mediaAt = PIN_BADGE_CSS.indexOf(`@media ${APC_MOBILE_MEDIA}`);
  assert.ok(mediaAt >= 0, "the touch rules are under the mobile media query");
  const media = PIN_BADGE_CSS.slice(mediaAt);
  const base = declarations(ruleBody(PIN_BADGE_CSS.slice(0, mediaAt), ".apc-pin__unpin"));
  const over = touch ? declarations(ruleBody(media, ".apc-pin__unpin")) : {};
  const d = { ...base, ...over };
  const w = px(d.width!);
  const h = px(d.height!);
  const left = d.left && d.left !== "auto" ? px(d.left) : SIZE - px(d.right!) - w;
  const top = px(d.top!);
  const x: Rect = { x0: left, y0: top, x1: left + w, y1: top + h };
  const after = declarations(ruleBody(touch ? media : "", ".apc-pin__unpin::after"));
  const inset = after.inset ? after.inset.split(/\s+/).map(px) : [0, 0, 0, 0];
  const [t, r, b, l] = inset.length === 4 ? inset : [inset[0]!, inset[0]!, inset[0]!, inset[0]!];
  const hit: Rect = touch ? { x0: x.x0 + l!, y0: x.y0 + t!, x1: x.x1 - r!, y1: x.y1 - b! } : x;
  return { x, hit };
}

test("at 375 px no point on the mark hits the ×, and the × is at least 24 px (TIN-903)", () => {
  const mark: Rect = { x0: 0, y0: 0, x1: SIZE, y1: SIZE };
  const { x, hit } = unpinBoxes(true);
  assert.ok(x.x1 - x.x0 >= 24 && x.y1 - x.y0 >= 24, "the × is at least 24 px");
  assert.ok(!overlaps(hit, mark), `the × hit area ${JSON.stringify(hit)} covers the mark`);
  assert.ok(!overlaps(x, mark));
  // The same, point by point: every point of the mark, a tap there is not on the ×.
  for (let cx = 0; cx <= SIZE; cx++) for (let cy = 0; cy <= SIZE; cy++) assert.ok(!(cx > hit.x0 && cx < hit.x1 && cy > hit.y0 && cy < hit.y1), `(${cx}, ${cy}) is on the ×`);
  // The × is still reachable: beside the mark, with a hit area a thumb can find.
  assert.ok(hit.y1 - hit.y0 >= 36 && hit.x1 - hit.x0 >= 24);
});

test("a pointer keeps the × on the mark's corner, as it was (desktop is unchanged)", () => {
  const { x } = unpinBoxes(false);
  assert.deepEqual(x, { x0: 20, y0: -8, x1: 36, y1: 8 });
});

test("the stack step is larger on touch, and no × covers the next badge's mark (TIN-903)", () => {
  assert.equal(PIN_STACK_STEP, 30);
  assert.equal(PIN_STACK_STEP_TOUCH, 72);
  assert.equal(pinStackStep(false), PIN_STACK_STEP);
  assert.equal(pinStackStep(true), PIN_STACK_STEP_TOUCH);
  const { hit } = unpinBoxes(true);
  const viewport = 375;
  const xs = [0, 1, 2, 3].map((index) => pinBadgeX({ targetRight: 350, viewportWidth: viewport, index, touch: true }));
  assert.deepEqual(xs.slice(1).map((x, i) => xs[i]! - x), [72, 72, 72], "each badge sits one touch step from the last");
  xs.forEach((x, i) => {
    const area: Rect = { x0: x + hit.x0, y0: hit.y0, x1: x + hit.x1, y1: hit.y1 };
    assert.ok(area.x1 <= viewport, `badge ${i}'s × stays on the screen`);
    xs.forEach((other, j) => {
      if (i !== j) assert.ok(!overlaps(area, { x0: other, y0: 0, x1: other + SIZE, y1: SIZE }), `badge ${i}'s × covers badge ${j}'s mark`);
    });
  });
  // On a pointer the placement is the old one: 30 px steps.
  assert.equal(pinBadgeX({ targetRight: 200, viewportWidth: 1000, index: 2, touch: false }), 200 - 22 - 60);
  // At the right edge the badge is pulled in to leave room for its ×, and a deep stack never leaves the screen's left edge.
  assert.equal(pinBadgeX({ targetRight: 400, viewportWidth: 375, index: 0, touch: true }), 375 - SIZE - 38);
  assert.equal(pinBadgeX({ targetRight: 400, viewportWidth: 375, index: 9, touch: true }), 4);
  // The index still comes from the pins on one target.
  const t = { kind: "order", id: "1" };
  assert.equal(pinStackIndex([{ id: "a", target: t }, { id: "b", target: t }], "b"), 1);
});

// ---- the popover ----

function mountPets(agents: unknown[]) {
  defineHeaderPets();
  const el = new (defined.get("apc-pets")!)() as El & { agents: unknown; links: unknown };
  doc.body.append(el);
  el.agents = agents;
  const find = (cls: string) => el.elements().filter((e) => e.className === cls);
  return { el, find, popover: find("apc-pets__popover")[0]!, more: find("apc-pets__more")[0]! };
}

test("a pin with no route (href: null) is plain text in the popover, never a button that goes nowhere (TIN-903)", () => {
  const { el, find, more } = mountPets([
    { id: "g1", name: "Claude", state: "idle", pin: { label: "the dashboard", seen: true, here: true, href: null } },
    { id: "g2", name: "Codex", state: "idle", pin: { label: "order 9", seen: false, here: true, href: "/orders/9" } },
    { id: "g3", name: "Gemini", state: "idle", pin: { label: "order 3", seen: false, here: true } },
  ]);
  more.fire("click");
  const rows = el.elements().filter((e) => e.tagName === "LI");
  const open = (li: El) => li.elements().find((e) => e.className === "apc-pets__open")!;
  const plain = (li: El) => li.elements().find((e) => e.className === "apc-pets__pin" && !e.hidden && e.textContent.includes("the dashboard"));
  assert.equal(open(rows[0]!).hidden, true, "no button for a pin with no route");
  assert.ok(plain(rows[0]!), "its words are shown as text");
  assert.equal(open(rows[1]!).hidden, false);
  assert.equal(open(rows[2]!).hidden, false, "a pin with no href at all is a button, as before");
  // The route is carried in the event, so the app needs no lookup.
  const got: unknown[] = [];
  el.addEventListener("apc-open", (e) => got.push((e as CustomEvent).detail));
  open(rows[1]!).fire("click");
  open(rows[2]!).fire("click");
  assert.deepEqual(got, [{ id: "g2", href: "/orders/9" }, { id: "g3" }]);
  assert.equal(find("apc-pets__open").length, 3);
  el.remove();
});

test("the app's own links sit at the foot of the popover and tell the app first (TIN-903)", () => {
  const { el, find, more, popover } = mountPets([{ id: "g1", name: "Claude", state: "idle" }]);
  const foot = find("apc-pets__links")[0]!;
  assert.equal(foot.hidden, true, "no links, no foot");
  const set = (links: unknown) => ((el as unknown as { links: unknown }).links = links);
  set([{ label: "Manage agents", href: "/agents" }, { label: "Help", href: "/help" }]);
  assert.equal(foot.hidden, false);
  const links = find("apc-pets__link");
  assert.deepEqual(links.map((l) => [l.textContent, l.getAttribute("href")]), [["Manage agents", "/agents"], ["Help", "/help"]]);
  set([{ label: "Manage agents", href: "/agents" }, { label: "Help", href: "/help" }]);
  assert.equal(find("apc-pets__link")[0], links[0], "the same links are kept, so a pressed link survives an update");
  more.fire("click");
  assert.equal(popover.hidden, false);
  const seen: string[] = [];
  let prevented = false;
  el.addEventListener("apc-link", (e) => {
    seen.push((e as CustomEvent<{ href: string }>).detail.href);
    (e as Event).preventDefault();
  });
  links[0]!.fire("click", { preventDefault: () => (prevented = true) });
  assert.deepEqual(seen, ["/agents"]);
  assert.equal(popover.hidden, true, "choosing a link closes the popover");
  assert.ok(prevented, "the app can take the navigation (a client-side router)");
  el.remove();
});

test("a link's address is http(s) or relative; javascript: and the like are shown as text, never as a link (TIN-903)", () => {
  const { el, find } = mountPets([{ id: "g1", name: "Claude", state: "idle" }]);
  (el as unknown as { links: unknown }).links = [
    { label: "Manage", href: "/agents" },
    { label: "Docs", href: "https://example.com/a?b=c" },
    { label: "Evil", href: "javascript:alert(1)" },
    { label: "Tabbed", href: "java	script:alert(1)" },
    { label: "Data", href: "data:text/html,x" },
    { label: "Empty", href: "" },
  ];
  const all = find("apc-pets__link");
  assert.deepEqual(all.filter((l) => l.tagName === "A").map((l) => l.getAttribute("href")), ["/agents", "https://example.com/a?b=c"]);
  assert.deepEqual(all.filter((l) => l.tagName !== "A").map((l) => l.textContent), ["Evil", "Tabbed", "Data", "Empty"]);
  assert.equal(safeLinkHref("HTTP://x.test"), "HTTP://x.test");
  assert.equal(safeLinkHref(null), null);
  el.remove();
});

// ---- the armed mark ----

test("the armed mark wears data-armed and aria-pressed itself, pets and badges, and lets go (TIN-903)", () => {
  definePinBadge();
  const { el, find } = mountPets([
    { id: "g1", name: "Claude", state: "idle" },
    { id: "g2", name: "Codex", state: "idle" },
  ]);
  const pin = new (defined.get("apc-pin")!)() as El & { agent: unknown; mark: El };
  doc.body.append(pin);
  pin.agent = { id: "g1", name: "Claude", seen: false };
  const [pet1, pet2] = find("apc-pets__pet");
  const stop = enablePinning({ root: doc.body as unknown as HTMLElement, onPin: () => {} });
  for (const m of [pet1!, pet2!, pin.mark]) assert.equal(m.getAttribute("data-armed"), null);
  pet1!.fire("click", { detail: 0 });
  assert.equal(doc.documentElement.getAttribute("data-apc-armed"), "g1");
  assert.equal(pet1!.getAttribute("data-armed"), "true");
  assert.equal(pet1!.getAttribute("aria-pressed"), "true");
  assert.equal(pin.mark.getAttribute("data-armed"), "true", "the badge of the armed agent too");
  assert.equal(pin.mark.getAttribute("aria-pressed"), "true");
  assert.equal(pet2!.getAttribute("data-armed"), null, "another agent's mark stays as it was");
  assert.equal(pet2!.getAttribute("aria-pressed"), null);
  // A mark drawn after the agent was armed is armed too.
  el.agents = [{ id: "g1", name: "Claude", state: "idle" }, { id: "g2", name: "Codex", state: "calling" }, { id: "g3", name: "Kimi", state: "idle" }];
  assert.equal(find("apc-pets__pet")[0]!.getAttribute("aria-pressed"), "true");
  assert.equal(find("apc-pets__pet")[2]!.getAttribute("data-armed"), null);
  // Armed again on the same mark lets go.
  pet1!.fire("click", { detail: 0 });
  assert.equal(doc.documentElement.getAttribute("data-apc-armed"), null);
  for (const m of [pet1!, pet2!, pin.mark]) {
    assert.equal(m.getAttribute("data-armed"), null);
    assert.equal(m.getAttribute("aria-pressed"), null);
  }
  stop();
  el.remove();
  pin.remove();
});
