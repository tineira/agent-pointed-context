import assert from "node:assert/strict";
import { test } from "node:test";
import type { FocusTarget } from "@tineira/apc-protocol";
import { couldNotCheckNote, directOnlyNote } from "@tineira/apc-protocol";

/**
 * Localizable strings (TIN-668). The components run on a DOM just big enough for them (there is no
 * browser in `node --test`). A test locale replaces every key by a marked string («key», or
 * «key:args» for a function); then every visible text, `aria-label`, title, placeholder and alt in
 * what the components drew must come from it, and every key must have been drawn at least once.
 */

class Text {
  parentElement: El | null = null;
  data: string;
  constructor(data: string) {
    this.data = data;
  }
}
class El {
  tagName: string;
  attrs = new Map<string, string>();
  children: Array<El | Text> = [];
  parentElement: El | null = null;
  className = "";
  own = "";
  hidden = false;
  type = "";
  title = "";
  placeholder = "";
  alt = "";
  value = "";
  href = "";
  maxLength = 0;
  dataset: Record<string, string> = {};
  style: Record<string, string> & { setProperty?: (k: string, v: string) => void; removeProperty?: (k: string) => void } = {};
  listeners = new Map<string, Array<(e: unknown) => void>>();
  classes = new Set<string>();
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
    contains: (c: string) => this.classes.has(c),
  };
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
  }
  get textContent(): string {
    return this.own + this.children.map((c) => (c instanceof Text ? c.data : c.textContent)).join("");
  }
  set textContent(v: string) {
    this.children = [];
    this.own = v;
  }
  set innerHTML(_v: string) {
    this.children = [];
    this.own = "";
  }
  get isConnected(): boolean {
    for (let n: El | null = this; n; n = n.parentElement) if (n === doc.documentElement) return true;
    return false;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  focus() {}
  setSelectionRange() {}
  append(...nodes: Array<El | Text>) {
    for (const n of nodes) {
      if (n instanceof El) n.remove();
      n.parentElement = this;
      this.children.push(n);
    }
    if (this.isConnected) for (const n of nodes) if (n instanceof El) n.connect();
  }
  appendChild(n: El) {
    this.append(n);
  }
  replaceChildren(...nodes: Array<El | Text>) {
    this.children = [];
    this.own = "";
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  connect() {
    (this as unknown as { connectedCallback?: () => void }).connectedCallback?.();
    for (const c of this.children) if (c instanceof El) c.connect();
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  dispatchEvent(e: Event) {
    for (const fn of this.listeners.get(e.type) ?? []) fn(e);
    return true;
  }
  /** Fires the listeners of this element, then its ancestors' (bubbling). */
  fire(type: string, init: Record<string, unknown> = {}) {
    const event = { type, target: this, button: 0, isTrusted: true, preventDefault() {}, ...init };
    for (let n: El | null = this; n; n = n.parentElement) for (const fn of n.listeners.get(type) ?? []) fn(event);
  }
  elements(): El[] {
    const out: El[] = [];
    const walk = (n: El) => {
      for (const c of n.children) if (c instanceof El) (out.push(c), walk(c));
    };
    walk(this);
    return out;
  }
  matches(selector: string): boolean {
    const attr = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    if (attr) return this.attrs.has(attr);
    return false;
  }
  querySelectorAll(selector: string): El[] {
    const scoped = /^:scope > \.([\w-]+)$/.exec(selector)?.[1];
    if (scoped) return this.children.filter((c): c is El => c instanceof El && c.classes.has(scoped) || (c instanceof El && c.className.split(" ").includes(scoped)));
    return this.elements().filter((e) => e.matches(selector));
  }
  querySelector(selector: string): El | null {
    const cls = /^\.([\w-]+)$/.exec(selector)?.[1];
    if (cls) return this.elements().find((e) => e.className.split(" ").includes(cls)) ?? null;
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): El | null {
    const name = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    for (let n: El | null = this; n; n = n.parentElement) if (name && n.attrs.has(name)) return n;
    return null;
  }
  cloneNode() {
    const copy = new El(this.tagName);
    copy.attrs = new Map(this.attrs);
    return copy;
  }
  /** Own visible text of this element only (not its children's). */
  ownText(): string {
    return this.own + this.children.map((c) => (c instanceof Text ? c.data : "")).join("");
  }
}

class FakeHTMLElement extends El {}

const windowListeners = new Map<string, Array<(e: unknown) => void>>();
const doc = {
  documentElement: Object.assign(new El("html"), { lang: "" }),
  head: new El("head"),
  body: new El("body"),
  visibilityState: "visible",
  getElementById: (id: string) => doc.head.children.find((c) => c instanceof El && c.attrs.get("id") === id) ?? null,
  createElement: (tag: string) => {
    const e = new El(tag);
    Object.defineProperty(e, "id", { set: (v: string) => e.setAttribute("id", v) });
    return e;
  },
  createTextNode: (data: string) => new Text(data),
  querySelectorAll: (selector: string): El[] => doc.documentElement.querySelectorAll(selector),
  elementFromPoint: (): El | null => hovered,
};
doc.documentElement.append(doc.head, doc.body);
doc.documentElement.style.setProperty = () => {};
doc.documentElement.style.removeProperty = () => {};
let hovered: El | null = null;
const defined = new Map<string, new () => El>();
const store = new Map<string, string>();
Object.assign(globalThis, {
  document: doc,
  HTMLElement: FakeHTMLElement,
  customElements: { get: (t: string) => defined.get(t), define: (t: string, c: new () => El) => void defined.set(t, c) },
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  location: { href: "https://app.test/", origin: "https://app.test" },
  window: {
    dispatchEvent: () => true,
    addEventListener: (t: string, fn: (e: unknown) => void) => windowListeners.set(t, [...(windowListeners.get(t) ?? []), fn]),
    removeEventListener: (t: string, fn: (e: unknown) => void) => windowListeners.set(t, (windowListeners.get(t) ?? []).filter((f) => f !== fn)),
  },
});
const press = (type: string, init: Record<string, unknown> = {}) => (windowListeners.get(type) ?? []).slice().forEach((fn) => fn({ type, clientX: 0, clientY: 0, isTrusted: true, ...init }));

const { defineAgentBar, mergePins, pathLabel, readingSummary, agentLabels, DOCK_HINT } = await import("../src/agents-bar.ts");
const { definePinBadge, pinBadgeLabels } = await import("../src/pin-badge.ts");
const { defineDirectAgents, connectPrompt, directAgentStatus } = await import("../src/direct-agents.ts");
const { enablePinning, showDockUnsupported, REFUSED_NOTE, UNKNOWN_AGENT_NOTE } = await import("../src/pinning.ts");
const { DEFAULT_BAR_STRINGS, DEFAULT_PIN_STRINGS, DEFAULT_DIRECT_STRINGS, DEFAULT_PINNING_STRINGS, formatPageTime, pageLocale, resolveStrings } = await import("../src/strings.ts");

/** The test locale: every key replaced by a marked string; every function by one that marks its arguments. Records which were used. */
function locale<T extends object>(defaults: T, used: Set<string>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    out[key] =
      typeof value === "function"
        ? (...args: unknown[]) => (used.add(key), `«${key}:${args.map((a) => (Array.isArray(a) ? a.join("+") : typeof a === "object" && a ? "obj" : String(a))).join("|")}»`)
        : `«${key}»`;
  }
  return out as T;
}

/** Everything the person can read or hear in a tree: text, aria-label, title, placeholder, alt. */
function visible(root: El): string[] {
  const out: string[] = [];
  for (const el of [root, ...root.elements()]) {
    const text = el.ownText().trim();
    if (text) out.push(text);
    for (const v of [el.getAttribute("aria-label"), el.title, el.getAttribute("title"), el.placeholder, el.alt]) if (v) out.push(v);
  }
  return out;
}

/** What may appear without coming from the strings: symbols with no language, and what the app passes in. */
const SYMBOLS = new Set(["×", "⊘", "‹", "!", "✓"]);
const APP_OWN = new Set(["Claude", "Gemini", "Codex", "post_1", "Heads up from the app", "https://app.test/mcp/abc/def", "Signals", "claude-code"]);
function assertAllFromLocale(texts: string[], where: string): void {
  for (const t of texts) {
    if (SYMBOLS.has(t) || APP_OWN.has(t)) continue;
    assert.ok(t.includes("«"), `${where}: "${t}" is not from the strings option`);
  }
}

/** A flat list of every English default (strings, and functions called with sample arguments), for "no English remains". */
function englishOf(defaults: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const value of Object.values(defaults)) {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "function") {
      const f = value as (...a: unknown[]) => string;
      for (const args of [["Claude", true, true], ["Claude", false, false], [["Claude"]], [["Claude", "Codex"]], [2], [{ connected: true, client: "claude-code", linked: true }], ["https://x", "Signals"], ["post_1", true, false]]) {
        try {
          const s = f(...args);
          if (typeof s === "string") out.push(s);
        } catch {
          // wrong sample arguments for this function
        }
      }
    }
  }
  return out.filter((s) => s.length > 6);
}

test("the defaults are exactly the text the package always showed (TIN-668)", () => {
  const b = DEFAULT_BAR_STRINGS;
  assert.equal(b.toolbar, "Agents");
  assert.equal(b.markTitle("Claude", true), "Claude. Drag onto anything to point this agent.");
  assert.equal(b.markTitle("Claude", false), "Claude (not connected yet). Drag onto anything to point this agent.");
  assert.equal(b.pinTitle("cus_1", true, true), "Pinned to cus_1: your agent read it");
  assert.equal(b.pinTitle("cus_1", false, false), "Pinned to cus_1: waiting for your agent's next call. Click to open it.");
  assert.equal(b.pinAria("Claude", "cus_1", true), "Claude pinned to cus_1, read");
  assert.equal(b.pinAria("Claude", "cus_1", false), "Claude pinned to cus_1, not read yet");
  assert.equal(b.unpinAria("Claude"), "Remove Claude's pin");
  assert.equal(b.revokeTitle("Claude", false), "Revoke Claude: it can no longer read this app, at once. To let it back, connect or drop it here again.");
  assert.equal(b.revokeTitle("Claude", true), "Revoke Claude: it can no longer read this app, directly or through the dock, at once. To let it back, connect or drop it here again.");
  assert.equal(b.revokeAria("Claude"), "Revoke Claude");
  assert.equal(b.revokeConfirm, "Revoke?");
  assert.equal(b.revokeConfirmTitle("Claude"), "Click again to revoke Claude.");
  assert.deepEqual([b.pathDirect, b.pathDirectTitle], ["direct", "Connected directly, on this app's own MCP URL"]);
  assert.deepEqual([b.pathDock, b.pathDockTitle], ["via dock", "Came through an agent dock"]);
  assert.deepEqual([b.pathBoth, b.pathBothTitle], ["direct + dock", "The same agent, connected directly and through a dock. Each way keeps its own access; Revoke cuts both."]);
  assert.deepEqual([b.unlink, b.unlinkTitle("Claude"), b.unlinkAria("Claude")], ["unlink", "Show Claude's two connections as two agents again. Nothing else changes.", "Unlink Claude"]);
  assert.deepEqual([b.collapseTitle, b.collapseAria], ["Collapse to who is reading. Your agents came through your dock: drag them from there.", "Collapse the agent bar"]);
  assert.equal(b.reading(["A"]), "A is reading");
  assert.equal(b.reading(["A", "B"]), "A and B are reading");
  assert.equal(b.reading(["A", "B", "C"]), "A, B and C are reading");
  assert.equal(b.nobodyReading, "No agent is reading");
  assert.equal(b.showAgents("A is reading"), "A is reading. Show the agents.");
  assert.equal(b.readingCount(2), "2 reading");
  assert.equal(b.nobodyReadingShort, "no agent reading");
  assert.equal(b.dockHint, "Use this agent across apps with the dock");
  assert.equal(DOCK_HINT.text, "Use this agent across apps with the dock");
  assert.equal(b.dockHintDismiss, "Dismiss this hint");
  assert.equal(b.joinPins(["A", "B"]), "A and B");

  assert.equal(DEFAULT_PIN_STRINGS.title("Claude", true), "Claude: read this pin. Drag to point it at something else.");
  assert.equal(DEFAULT_PIN_STRINGS.title("Claude", false), "Claude: has not read this pin yet. Drag to point it at something else.");
  assert.equal(DEFAULT_PIN_STRINGS.unpinAria("Claude"), "Remove Claude's pin");
  assert.equal(DEFAULT_PIN_STRINGS.markAria("Claude", true), "Claude, has read its pin");
  assert.equal(DEFAULT_PIN_STRINGS.markAria("Claude", false), "Claude, has not read its pin yet");

  const d = DEFAULT_DIRECT_STRINGS;
  assert.deepEqual([d.nameLabel, d.namePlaceholder, d.save, d.cancel, d.rename], ["Agent name", "Empty: back to its own name", "Save", "Cancel", "Rename"]);
  assert.deepEqual([d.hideConnection, d.showConnection, d.copy, d.copyPrompt, d.copied, d.addAnother, d.connectAgent, d.thisApp], ["Hide connection", "Show connection", "Copy", "Copy prompt", "Copied", "Add another agent", "Connect an agent", "this app"]);
  assert.equal(d.urlHint, "Add this URL to your agent as a remote MCP server (Streamable HTTP). No login: the secret in the URL is its access, so give each agent its own.");
  assert.equal(d.askHint, "Don't know how? Paste this to your agent:");
  assert.equal(d.status({ connected: false }), "not connected yet");
  assert.equal(d.status({ connected: true }), "connected");
  assert.equal(d.status({ connected: true, client: "claude-code" }), "connected as claude-code");
  assert.equal(d.status({ connected: true, client: "claude-code", linked: true }), "connected as claude-code, also through your dock");
  assert.equal(
    d.prompt("https://x/mcp/a/b", "Signals"),
    `Please connect this remote MCP server, named "Signals". URL: https://x/mcp/a/b. It uses Streamable HTTP and needs no OAuth or API key: the access is in the URL. If you can add it yourself, do it now and tell me when it's connected. If you can't, tell me the exact steps to add it in the app I'm using you in right now. Do not open the URL in a browser.`,
  );

  const p = DEFAULT_PINNING_STRINGS;
  assert.equal(p.tapPrompt("Claude"), "Tap what to point Claude at.");
  assert.deepEqual([p.yourAgent, p.cancel, p.close, p.thisApp], ["your agent", "Cancel", "Close", "This app"]);
  assert.equal(p.keyboardArmed, "Pointing your agent: Tab to an outlined item, then press Enter or Space to pin it. Escape cancels.");
  assert.equal(p.refusedTap, "This agent cannot point at that. Tap another outlined target, or Cancel.");
  assert.equal(p.refusedKeys, "This agent cannot point at that. Tab to another outlined item, or press Escape.");
  assert.equal(p.refused, "This agent cannot point at that. Drop it on another highlighted item.");
  assert.equal(p.unknownAgent, "This app does not know that agent.");
  assert.equal(REFUSED_NOTE, p.refused);
  assert.equal(UNKNOWN_AGENT_NOTE, p.unknownAgent);
  assert.equal(p.connectLink("Signals"), "Connect an agent to Signals");
  assert.equal(p.directOnlyNote("Signals"), directOnlyNote("Signals"), "the protocol's own note, unchanged");
  assert.equal(p.couldNotCheckNote("Signals"), couldNotCheckNote("Signals"));

  // The exported pure helpers give the same words with no strings passed.
  assert.equal(readingSummary([{ id: "a", name: "A", state: "idle" }, { id: "b", name: "B", state: "idle" }]), "A and B are reading");
  assert.equal(pathLabel(["dock"])?.text, "via dock");
  assert.equal(mergePins([{ label: "x", seen: true, here: true }, { label: "y", seen: true, here: true }])?.label, "x and y");
  assert.equal(connectPrompt("u", "N"), d.prompt("u", "N"));
  assert.equal(directAgentStatus({ id: "g", name: "A", url: "u", connected: true }), "connected");
  assert.equal(pinBadgeLabels({ name: "A", seen: true }).unpin, "Remove A's pin");
  assert.match(agentLabels({ id: "g", name: "A", state: "off" }).mark, /^A \(not connected yet\)\./);
});

test("an app that passes nothing sees the English defaults drawn, in the bar, the badge and the list (TIN-668)", () => {
  defineAgentBar();
  const bar = new (defined.get("apc-agents")!)() as El & { agents: unknown[] };
  doc.body.append(bar);
  assert.equal(bar.getAttribute("aria-label"), "Agents");
  bar.agents = [
    { id: "g_d", name: "Claude", state: "idle", paths: ["direct"], pin: { label: "post_1", seen: false, here: false } },
  ];
  const text = visible(bar);
  for (const expected of [
    "Claude. Drag onto anything to point this agent.",
    "Pinned to post_1: waiting for your agent's next call. Click to open it.",
    "Claude pinned to post_1, not read yet",
    "Remove Claude's pin",
    "direct",
    "Connected directly, on this app's own MCP URL",
    "Revoke Claude",
    "Use this agent across apps with the dock",
    "Dismiss this hint",
  ]) assert.ok(text.includes(expected), `default text missing: ${expected}`);
  bar.remove();
});

test("with a test locale, every string the bar draws comes from the option, and every key is drawn (TIN-668)", () => {
  const used = new Set<string>();
  const words = locale(DEFAULT_BAR_STRINGS, used);
  const english = englishOf(DEFAULT_BAR_STRINGS as unknown as Record<string, unknown>);
  const drawn: string[] = [];
  const collect = (bar: El) => drawn.push(...visible(bar));

  defineAgentBar();
  const make = (agents: unknown[]) => {
    const bar = new (defined.get("apc-agents")!)() as El & { agents: unknown[]; strings: unknown };
    bar.strings = words;
    doc.body.append(bar);
    bar.agents = agents;
    return bar;
  };

  // A Direct agent with a pin away from here and a warning, a linked one, a not yet connected one.
  const full = make([
    { id: "g_d", name: "Claude", state: "idle", paths: ["direct"], pin: { label: "post_1", seen: false, here: false }, warning: "Heads up from the app" },
    { id: "g_l", name: "Gemini", state: "busy", paths: ["direct", "dock"], pin: { label: "post_1", seen: true, here: true } },
    { id: "g_o", name: "Codex", state: "off", paths: ["dock"] },
  ]);
  collect(full);
  // Revoke, first click: the armed button.
  const revoke = full.elements().find((e) => e.className.includes("apc-agents__revoke"))!;
  revoke.fire("click");
  collect(full);

  // Dock-only agents: the bar may fold; folded it shows who is reading (one, then two, then nobody).
  const docked = make([{ id: "g_k", name: "Gemini", state: "busy", paths: ["dock"] }]);
  collect(docked);
  docked.elements().find((e) => e.className.includes("apc-agents__collapse"))!.fire("click");
  collect(docked);
  docked.agents = [{ id: "g_k", name: "Gemini", state: "busy", paths: ["dock"] }, { id: "g_c", name: "Codex", state: "idle", paths: ["dock"] }];
  collect(docked);
  docked.agents = [{ id: "g_k", name: "Gemini", state: "off", paths: ["dock"] }];
  collect(docked);

  // The merged label of a linked agent's two pins, through the same strings.
  assert.equal(mergePins([{ label: "a", seen: true, here: true }, { label: "b", seen: true, here: true }], words)?.label, "«joinPins:a+b»");

  for (const bar of [full, docked]) assertAllFromLocale(drawn, "bar");
  for (const e of english) assert.ok(!drawn.some((t) => t.includes(e)), `English default left in the bar: ${e}`);
  const everything = drawn.join("\n");
  for (const [key, value] of Object.entries(DEFAULT_BAR_STRINGS)) {
    if (key === "joinPins") continue;
    if (typeof value === "string") assert.ok(everything.includes(`«${key}»`), `bar string never drawn: ${key}`);
    else assert.ok(used.has(key), `bar function never called: ${key}`);
  }
  assert.ok(used.has("joinPins"));
  assert.equal(full.getAttribute("aria-label"), "«toolbar»", "the bar's own aria-label");
  full.remove();
  docked.remove();
});

test("setting strings after the bar is drawn redraws it; a name the app gave the bar is kept (TIN-668)", () => {
  const bar = new (defined.get("apc-agents")!)() as El & { agents: unknown[]; strings: unknown };
  doc.body.append(bar);
  bar.agents = [{ id: "g_d", name: "Claude", state: "idle", paths: ["direct"] }];
  assert.ok(visible(bar).includes("Revoke Claude"));
  bar.strings = { revokeAria: (n: string) => `Revocar ${n}` };
  assert.ok(visible(bar).includes("Revocar Claude"), "redrawn with the new words");
  assert.ok(visible(bar).includes("direct"), "the keys left out stay English");
  bar.remove();
  const named = new (defined.get("apc-agents")!)() as El & { strings: unknown };
  named.setAttribute("aria-label", "Mis agentes");
  named.strings = { toolbar: "Other" };
  doc.body.append(named);
  assert.equal(named.getAttribute("aria-label"), "Mis agentes");
  named.remove();
});

test("the dock hint can be translated through strings, replaced, or turned off (TIN-668)", () => {
  const make = () => {
    const bar = new (defined.get("apc-agents")!)() as El & { agents: unknown[]; strings: unknown; dockHint: { text: string; url: string } | null };
    doc.body.append(bar);
    bar.agents = [{ id: "g_d", name: "Claude", state: "idle", paths: ["direct"] }];
    return bar;
  };
  const hintText = (bar: El) => bar.elements().find((e) => e.className.includes("apc-agents__hint"))?.elements().find((e) => e.tagName === "A")?.textContent ?? null;
  store.clear();

  const translated = make();
  translated.strings = { dockHint: "Usa este agente en todas tus apps con el dock", dockHintDismiss: "Cerrar" };
  assert.equal(hintText(translated), "Usa este agente en todas tus apps con el dock");
  assert.equal(translated.dockHint?.url, "https://apc.tineira.com/dock");
  assert.ok(visible(translated).includes("Cerrar"));
  translated.remove();

  const replaced = make();
  replaced.dockHint = { text: "Texto propio", url: "https://autio.cl/dock" };
  assert.equal(hintText(replaced), "Texto propio");
  replaced.remove();

  const off = make();
  off.dockHint = null;
  assert.equal(hintText(off), null, "dockHint = null turns it off, strings or not");
  off.strings = { dockHint: "x" };
  assert.equal(hintText(off), null);
  off.remove();

  const attr = new (defined.get("apc-agents")!)() as El & { agents: unknown[] };
  attr.setAttribute("dock-hint", "off");
  doc.body.append(attr);
  attr.agents = [{ id: "g_d", name: "Claude", state: "idle", paths: ["direct"] }];
  assert.equal(hintText(attr), null, 'dock-hint="off" turns it off');
  attr.remove();
});

test("with a test locale, every string the pin badge draws comes from the option, and every key is drawn (TIN-668)", () => {
  const used = new Set<string>();
  const words = locale(DEFAULT_PIN_STRINGS, used);
  definePinBadge();
  const drawn: string[] = [];
  for (const seen of [false, true]) {
    const pin = new (defined.get("apc-pin")!)() as El & { agent: unknown; strings: unknown };
    pin.strings = words;
    doc.body.append(pin);
    pin.agent = { id: "g_1", name: "Claude", seen };
    drawn.push(...visible(pin));
    const mark = pin.children.find((c) => c instanceof El && c.className === "apc-pin__mark") as El;
    drawn.push(...visible(mark));
    pin.remove();
  }
  assertAllFromLocale(drawn, "pin");
  for (const e of englishOf(DEFAULT_PIN_STRINGS as unknown as Record<string, unknown>)) assert.ok(!drawn.some((t) => t.includes(e)), `English default left in the badge: ${e}`);
  assert.deepEqual([...used].sort(), ["markAria", "title", "unpinAria"]);
});

test("with a test locale, every string the Direct agents list draws comes from the option, and every key is drawn (TIN-668)", () => {
  const used = new Set<string>();
  const words = locale(DEFAULT_DIRECT_STRINGS, used);
  defineDirectAgents();
  const list = new (defined.get("apc-direct-agents")!)() as El & { agents: unknown[]; strings: unknown; appName: string };
  list.strings = words;
  doc.body.append(list);
  const url = "https://app.test/mcp/abc/def";
  list.agents = [];
  const drawn: string[] = [...visible(list)];
  list.agents = [
    { id: "g_1", name: "Claude", url, connected: false },
    { id: "g_2", name: "Codex", url, connected: true, client: "claude-code", linked: true },
  ];
  drawn.push(...visible(list));
  // Hide the open connection of the first (and show the second's), then open the rename form.
  const buttons = () => list.elements().filter((e) => e.tagName === "BUTTON");
  buttons().find((b) => b.textContent === "«hideConnection»")!.fire("click");
  drawn.push(...visible(list));
  list.elements().filter((e) => e.className === "apc-direct__link").find((b) => b.textContent === "«rename»")!.fire("click");
  drawn.push(...visible(list));
  assertAllFromLocale(drawn, "direct");
  const everything = drawn.join("\n");
  for (const e of englishOf(DEFAULT_DIRECT_STRINGS as unknown as Record<string, unknown>)) assert.ok(!everything.includes(e), `English default left in the list: ${e}`);
  for (const [key, value] of Object.entries(DEFAULT_DIRECT_STRINGS)) {
    if (typeof value === "string") {
      if (key === "copied" || key === "thisApp") continue; // shown for a moment after a copy; used in the prompt until appName is set
      assert.ok(everything.includes(`«${key}»`), `list string never drawn: ${key}`);
    } else assert.ok(used.has(key), `list function never called: ${key}`);
  }
  // The prompt carries the app's name: until it is set, the translated "this app".
  assert.match(connectPrompt(url, list.appName, words), /thisApp/, "the prompt's app name comes from the strings too");
  list.remove();
});

test("with a test locale, everything enablePinning tells the person comes from the option, and every key is used (TIN-668)", () => {
  const used = new Set<string>();
  const words = locale(DEFAULT_PINNING_STRINGS, used);
  const names: string[] = [];
  const tapPrompt = words.tapPrompt;
  words.tapPrompt = (name) => (names.push(name), tapPrompt(name));
  const bar = new El("div");
  doc.body.append(bar);
  const mark = new El("button");
  mark.setAttribute("data-apc-mark", "");
  mark.setAttribute("data-grant", "g_k");
  mark.setAttribute("aria-label", "Claude");
  bar.append(mark);
  const bare = new El("button");
  bare.setAttribute("data-apc-mark", "");
  bare.setAttribute("data-grant", "g_bare");
  bar.append(bare);
  const row = new El("div");
  row.setAttribute("data-focus", "customer:cus_5");
  doc.body.append(row);
  const drawn = () => (doc.body.elements().filter((e) => e.attrs.has("data-apc-tap-pin")).flatMap((n) => visible(n)));

  const stop = enablePinning({ root: doc.body as unknown as HTMLElement, canTarget: () => false, onPin: () => {}, strings: words });
  mark.fire("click", { detail: 0 });
  assert.deepEqual(drawn(), ["«keyboardArmed»", "«cancel»"], "armed from the keyboard: the instructions, and Cancel");
  press("keydown", { key: "Enter", target: row, preventDefault() {} });
  assert.deepEqual(drawn(), ["«refusedKeys»", "«cancel»"]);
  // Armed by a tap, refused by a tap.
  press("keydown", { key: "Escape" });
  mark.fire("click", { detail: 0 });
  const note = doc.body.elements().find((e) => e.attrs.has("data-apc-tap-pin"))!;
  assert.ok(visible(note).includes("«cancel»"));
  hovered = row;
  press("pointerdown", { clientX: 10, clientY: 10, target: row });
  press("pointerup", { clientX: 10, clientY: 10, target: row });
  assert.deepEqual(drawn(), ["«refusedTap»", "«cancel»"]);
  press("keydown", { key: "Escape" });
  // The name in the prompt comes from the mark, or from the strings when the mark has none.
  bare.fire("click", { detail: 0 });
  assert.equal(drawn()[0], "«keyboardArmed»");
  press("keydown", { key: "Escape" });
  stop();
  // (the prompt itself is drawn by tapPrompt, called with the mark's name)
  assert.ok(used.has("tapPrompt"));
  assert.ok(visible(doc.body).every((t) => !t.includes("Tap what")));

  // The page note for a dock agent dropped on a Direct-only app: the app's own words, link and ×.
  const drop = { v: 1 as const, agent: "ag_1", hub: "https://apc.tineira.com", ticket: "0123456789abcdef0" };
  const target: FocusTarget | null = null;
  const note2 = showDockUnsupported({ drag: drop, target, name: "Autio", connect: "https://app.test/connect", reason: "direct_only", message: words.directOnlyNote("Autio") }, words) as unknown as El;
  assert.deepEqual(visible(note2), ["«directOnlyNote:Autio»", "«connectLink:Autio»", "×", "«close»"]);
  note2.remove();
  // The unknown / refused answers of a native drop and the default name are checked in the next test.
  assert.deepEqual(names, ["Claude", "Claude", "«yourAgent»"], "the agent's name comes from its mark, or from the strings when the mark has none");
});

test("a refused or unknown native drop is told in the app's strings; the Direct-only note too (TIN-668)", async () => {
  const told: string[] = [];
  const { placeNativeDrop, refusalTeller } = await import("../src/pinning.ts");
  const words = locale(DEFAULT_PINNING_STRINGS, new Set());
  const drag = { v: 1 as const, agent: "ag_9" };
  const hit = { element: new El() as unknown as Element, target: { kind: "post", id: "p_1", part: null, params: null } as FocusTarget };
  placeNativeDrop({ strings: words, onPin: () => {}, resolveAgent: () => null }, drag, hit, (m) => void told.push(m));
  placeNativeDrop({ strings: words, onPin: () => {}, canTarget: () => false }, drag, hit, (m) => void told.push(m));
  assert.deepEqual(told, ["«unknownAgent»", "«refused»"]);
  const answers: Array<{ name: string; message: string }> = [];
  refusalTeller({ strings: words, onDockUnsupported: (a) => void answers.push(a) })("m", drag, hit.target);
  assert.equal(answers[0]!.name, "«thisApp»", "the app's name defaults to the translated one");
  // Without strings, the same calls say what they always said.
  const plain: string[] = [];
  placeNativeDrop({ onPin: () => {}, resolveAgent: () => null }, drag, hit, (m) => void plain.push(m));
  placeNativeDrop({ onPin: () => {}, canTarget: () => false }, drag, hit, (m) => void plain.push(m));
  assert.deepEqual(plain, ["This app does not know that agent.", "This agent cannot point at that. Drop it on another highlighted item."]);
});

test("dates and times follow the page's locale, or the one the app names, never the machine's (TIN-668)", () => {
  const when = new Date(Date.UTC(2026, 10, 10, 15, 4));
  const options = { dateStyle: "long", timeStyle: "short", timeZone: "UTC" } as const;
  doc.documentElement.lang = "es-CL";
  assert.equal(pageLocale(), "es-CL");
  const es = formatPageTime(when, options);
  assert.match(es, /noviembre/, "a Spanish page reads Spanish");
  assert.equal(es, new Intl.DateTimeFormat("es-CL", options).format(when));
  doc.documentElement.lang = "en";
  assert.match(formatPageTime(when, options), /November/);
  assert.match(formatPageTime(when, { ...options, locale: "de" }), /10\. November 2026/, "an explicit option wins over the page");
  doc.documentElement.lang = "";
  assert.equal(pageLocale(), "en", "a page that names none is English, not the machine's");
  doc.documentElement.lang = "not a locale!";
  assert.equal(pageLocale(), "en", "a bad tag does not throw");
  assert.equal(pageLocale("fr"), "fr");
  doc.documentElement.lang = "";
});

test("resolveStrings keeps the default for a key left out or set to undefined", () => {
  const merged = resolveStrings({ a: "A", b: "B" }, { b: undefined, a: "x" });
  assert.deepEqual(merged, { a: "x", b: "B" });
  assert.deepEqual(resolveStrings({ a: "A" }, null), { a: "A" });
});
