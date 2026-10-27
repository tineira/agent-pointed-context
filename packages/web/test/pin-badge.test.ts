import assert from "node:assert/strict";
import { test } from "node:test";
import type { FocusTarget } from "@apc/protocol";
import { pinBadgeLabels } from "../src/pin-badge.ts";

/**
 * A DOM just big enough for <apc-pin> and enablePinning (there is no browser in `node --test`):
 * elements with attributes, children, classes, listeners, closest("[attr]") and cloneNode.
 */
class El {
  tagName: string;
  attrs = new Map<string, string>();
  children: El[] = [];
  parentElement: El | null = null;
  className = "";
  textContent = "";
  innerHTML = "";
  hidden = false;
  type = "";
  style: Record<string, string> = {};
  listeners = new Map<string, Array<(e: unknown) => void>>();
  classes = new Set<string>();
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
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
  append(...nodes: El[]) {
    for (const n of nodes) {
      n.parentElement = this;
      this.children.push(n);
    }
    if (this.isConnected) for (const n of nodes) n.connect();
  }
  appendChild(n: El) {
    this.append(n);
  }
  replaceChildren(...nodes: El[]) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  connect() {
    (this as unknown as { connectedCallback?: () => void }).connectedCallback?.();
    for (const c of this.children) c.connect();
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
    const event = { type, target: this, button: 0, preventDefault() {}, ...init };
    for (let n: El | null = this; n; n = n.parentElement) for (const fn of n.listeners.get(type) ?? []) fn(event);
  }
  closest(selector: string): El | null {
    const name = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    for (let n: El | null = this; n; n = n.parentElement) if (name && n.attrs.has(name)) return n;
    return null;
  }
  cloneNode() {
    const copy = new El(this.tagName);
    copy.attrs = new Map(this.attrs);
    copy.className = this.className;
    return copy;
  }
}

class FakeHTMLElement extends El {
  constructor() {
    super("apc-pin");
  }
}

const windowListeners = new Map<string, Array<(e: unknown) => void>>();
const doc = {
  documentElement: new El("html"),
  head: new El("head"),
  body: new El("body"),
  getElementById: (id: string) => doc.head.children.find((c) => c.attrs.get("id") === id) ?? null,
  createElement: (tag: string) => {
    const e = new El(tag);
    Object.defineProperty(e, "id", { set: (v: string) => e.setAttribute("id", v) });
    return e;
  },
  elementFromPoint: (_x: number, _y: number): El | null => hovered,
};
doc.documentElement.append(doc.head, doc.body);
let hovered: El | null = null;
const defined = new Map<string, new () => El>();
Object.assign(globalThis, {
  document: doc,
  HTMLElement: FakeHTMLElement,
  customElements: { get: (t: string) => defined.get(t), define: (t: string, c: new () => El) => void defined.set(t, c) },
  window: {
    addEventListener: (t: string, fn: (e: unknown) => void) => windowListeners.set(t, [...(windowListeners.get(t) ?? []), fn]),
    removeEventListener: (t: string, fn: (e: unknown) => void) => windowListeners.set(t, (windowListeners.get(t) ?? []).filter((f) => f !== fn)),
  },
});
const press = (type: string, init: Record<string, unknown> = {}) => (windowListeners.get(type) ?? []).slice().forEach((fn) => fn({ type, clientX: 0, clientY: 0, ...init }));

const { definePinBadge } = await import("../src/pin-badge.ts");
const { enablePinning } = await import("../src/pinning.ts");

interface Pin extends El {
  agent: { id: string; name: string; icon?: string | null; seen: boolean } | null;
  mark: El;
}
function badge(agent: { id: string; name: string; seen: boolean }): Pin {
  definePinBadge();
  const el = new (defined.get("apc-pin")!)() as Pin;
  doc.body.append(el);
  el.agent = agent;
  return el;
}
const targetEl = (focus: string) => {
  const el = new El("div");
  el.setAttribute("data-focus", focus);
  doc.body.append(el);
  return el;
};

test("the pin badge is a mark: data-apc-mark and the agent's grant (TIN-482)", () => {
  const pin = badge({ id: "g_1a2b", name: "Claude", seen: false });
  assert.equal(pin.mark.getAttribute("data-apc-mark"), "", "enablePinning's default markSelector is [data-apc-mark]");
  assert.equal(pin.mark.getAttribute("data-grant"), "g_1a2b");
  assert.equal(pin.getAttribute("data-apc-pin-state"), "waiting");
  assert.equal(pin.getAttribute("title"), "Claude: has not read this pin yet. Drag to point it at something else.");
  assert.ok(doc.getElementById("apc-pin-style"), "styles are injected once");
  pin.agent = { id: "g_1a2b", name: "Claude", seen: true };
  assert.equal(pin.getAttribute("data-apc-pin-state"), "seen");
  assert.match(pinBadgeLabels({ name: "Claude", seen: true }).title, /^Claude: read this pin\./);
});

test("enablePinning drags a pin badge onto another target; Esc and a drop outside cancel (TIN-482)", () => {
  const pin = badge({ id: "g_move", name: "Claude", seen: true });
  const post = targetEl("post:p_7");
  const pinned: Array<[string, FocusTarget]> = [];
  // enablePinning listens for pointerdown on its root; the badge's events bubble up to it.
  const stop = enablePinning({ root: doc.body as unknown as HTMLElement, onPin: (grantId, target) => void pinned.push([grantId, target]) });
  const drag = (to: El | null, end: () => void) => {
    pin.mark.fire("pointerdown", { clientX: 5, clientY: 5 });
    assert.ok(pin.classes.has("apc-pin--dragging"), "the badge dims while it is dragged");
    assert.ok(doc.body.classes.has("apc-dragging"));
    hovered = to;
    press("pointermove", { clientX: 40, clientY: 40 });
    end();
    assert.ok(!pin.classes.has("apc-pin--dragging"), "and is back once the drag ends");
    assert.ok(!doc.body.classes.has("apc-dragging"));
  };

  drag(post, () => press("pointerup"));
  assert.deepEqual(pinned, [["g_move", { kind: "post", id: "p_7", part: null, params: null }]], "dropped on a target: the pin moves to it");

  drag(post, () => press("keydown", { key: "Escape" }));
  drag(null, () => press("pointerup"));
  assert.equal(pinned.length, 1, "Esc, and a drop outside any target, move nothing");
  stop();
});

test("an agent set before the element was upgraded is taken in on connect; the mark is named", () => {
  definePinBadge();
  const el = new (defined.get("apc-pin")!)() as Pin;
  // What a framework leaves on a not yet upgraded element: an own data property.
  Object.defineProperty(el, "agent", { value: { id: "g_early", name: "Codex", seen: false }, writable: true, configurable: true, enumerable: true });
  doc.body.append(el);
  assert.equal(el.mark.getAttribute("data-grant"), "g_early");
  assert.equal(el.mark.getAttribute("aria-label"), "Codex, has not read its pin yet", "an agent with no icon still has an accessible name");
});

test("× asks the app to remove the pin (apc-unpin)", () => {
  const pin = badge({ id: "g_x", name: "Claude", seen: false });
  const seen: string[] = [];
  pin.addEventListener("apc-unpin", ((e: CustomEvent<{ id: string }>) => void seen.push(e.detail.id)) as (e: unknown) => void);
  const unpin = pin.children.find((c) => c.className === "apc-pin__unpin")!;
  assert.equal(unpin.getAttribute("aria-label"), "Remove Claude's pin");
  unpin.fire("click");
  assert.deepEqual(seen, ["g_x"]);
});
