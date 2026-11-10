import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defined, doc, El, locale, press, visible } from "../../../packages/web/test/fake-dom.ts";
import { forwardStrings, type PulseStrings } from "../src/web/apc-strings.ts";

/**
 * Pulse and a test locale (TIN-668). Pulse's wrappers (agent-bar.tsx, apc-pin.tsx, direct-agents.tsx) are TSX,
 * which `node --test` here cannot import (no loader, and none is added), and React cannot render in this
 * setup without a DOM library. So this drives what the wrappers do with the new `strings` prop or context:
 * `forwardStrings` (apc-strings.ts, plain TypeScript) on the real `<apc-agents>`, `<apc-pin>` and
 * `<apc-direct-agents>` elements of @tineira/apc-web, on the package's fake DOM, and `enablePinning` with the
 * pinning strings Pulse's App passes. A source check says each wrapper and App really make those calls.
 * NOT covered: React rendering itself (effects running in a browser) and Pulse's own page copy.
 */
const { defineAgentBar } = await import("../../../packages/web/src/agents-bar.ts");
const { definePinBadge } = await import("../../../packages/web/src/pin-badge.ts");
const { defineDirectAgents } = await import("../../../packages/web/src/direct-agents.ts");
const { enablePinning } = await import("../../../packages/web/src/pinning.ts");
const { DEFAULT_BAR_STRINGS, DEFAULT_PIN_STRINGS, DEFAULT_DIRECT_STRINGS, DEFAULT_PINNING_STRINGS } = await import("../../../packages/web/src/strings.ts");
const { mergePins } = await import("../../../packages/web/src/agents-bar.ts");

const make = <T extends El>(tag: string): T => {
  const el = new (defined.get(tag)!)() as T;
  doc.body.append(el);
  return el;
};
const english = (t: string) => /[A-Za-z]{4,}/.test(t.replace(/«[^»]*»/g, ""));
const NAMES = new Set(["Pulse agent", "Claude", "post_1", "https://pulse.test/mcp/a/b"]);

test("Pulse with a test locale: every string the package draws in Pulse comes from the option (TIN-668)", () => {
  const used = new Set<string>();
  const strings: Required<PulseStrings> = {
    bar: locale(DEFAULT_BAR_STRINGS, used),
    pin: locale(DEFAULT_PIN_STRINGS, used),
    direct: locale(DEFAULT_DIRECT_STRINGS, used),
    pinning: locale(DEFAULT_PINNING_STRINGS, used),
  };
  defineAgentBar();
  definePinBadge();
  defineDirectAgents();

  const bar = make<El & { agents: unknown[]; strings: unknown }>("apc-agents");
  forwardStrings(bar as never, strings.bar);
  bar.agents = [{ id: "g_1", name: "Claude", state: "idle", paths: ["direct"], pin: { label: "post_1", seen: false, here: false } }];
  const pin = make<El & { agent: unknown; strings: unknown }>("apc-pin");
  forwardStrings(pin as never, strings.pin);
  pin.agent = { id: "g_1", name: "Claude", seen: false };
  const list = make<El & { agents: unknown[]; strings: unknown; appName: string }>("apc-direct-agents");
  forwardStrings(list as never, strings.direct);
  list.appName = "Pulse";
  list.agents = [{ id: "g_1", name: "Claude", url: "https://pulse.test/mcp/a/b", connected: false }];

  const drawn = [...visible(bar), ...visible(pin), ...visible(pin.children.find((c) => c instanceof El && c.className === "apc-pin__mark") as El), ...visible(list)];
  for (const t of drawn) {
    if (["×", "⊘", "✓"].includes(t) || NAMES.has(t)) continue;
    assert.ok(t.includes("«"), `not from the strings: "${t}"`);
    assert.ok(!english(t), `English left: "${t}"`);
  }
  // Pulse's two grants of a linked agent: the merged label goes through the same strings.
  assert.equal(mergePins([{ label: "a", seen: true, here: true }, { label: "b", seen: true, here: true }], strings.bar)?.label, "«joinPins:a+b»");

  // enablePinning, as App.tsx calls it with `strings: pulseStrings?.pinning`: the armed note and Cancel.
  const mark = new El("button");
  mark.setAttribute("data-apc-mark", "");
  mark.setAttribute("data-grant", "g_1");
  mark.setAttribute("aria-label", "Claude");
  doc.body.append(mark);
  const stop = enablePinning({ root: doc.body as unknown as HTMLElement, onPin: () => {}, strings: strings.pinning });
  mark.fire("click", { detail: 0 });
  const note = doc.body.elements().find((e) => e.attrs.has("data-apc-tap-pin"))!;
  assert.deepEqual(visible(note), ["«keyboardArmed»", "«cancel»"]);
  press("keydown", { key: "Escape" });
  stop();
  for (const el of [bar, pin, list, mark]) el.remove();
});

test("Pulse with no strings is unchanged: the elements are left alone and draw English (TIN-668)", () => {
  const bar = make<El & { agents: unknown[]; strings: unknown }>("apc-agents");
  forwardStrings(bar as never, undefined);
  assert.equal(bar.strings, null, "nothing was set on the element");
  bar.agents = [{ id: "g_1", name: "Claude", state: "idle", paths: ["direct"] }];
  assert.ok(visible(bar).includes("Revoke Claude"));
  assert.equal(bar.getAttribute("aria-label"), "Agents");
  // Given, then taken away: back to English.
  forwardStrings(bar as never, { revokeAria: (n: string) => `Revocar ${n}` });
  assert.ok(visible(bar).includes("Revocar Claude"));
  forwardStrings(bar as never, undefined);
  assert.ok(visible(bar).includes("Revoke Claude"));
  bar.remove();
});

test("Pulse's wrappers and App forward the strings (source check, since TSX is not importable here)", () => {
  const web = (f: string) => readFileSync(new URL(`../src/web/${f}`, import.meta.url), "utf8");
  for (const [file, key] of [["agent-bar.tsx", "bar"], ["apc-pin.tsx", "pin"], ["direct-agents.tsx", "direct"]] as const) {
    const src = web(file);
    assert.ok(src.includes(`usePulseStrings()?.${key}`), `${file} reads the context`);
    assert.match(src, /props\.strings \?\? fromContext/, `${file} takes a strings prop first`);
    assert.match(src, /forwardStrings\(ref\.current, strings\)/, `${file} forwards them to the element`);
  }
  const app = web("App.tsx");
  assert.match(app, /strings: pulseStrings\?\.pinning/, "App passes the pinning strings to enablePinning");
  assert.match(app, /pulseStrings\?\.bar\)/, "App passes the bar strings to mergePins");
  assert.ok(!/<PulseStringsContext\.Provider/.test(web("main.tsx")), "Pulse itself sets none, so it keeps shipping English");
});
