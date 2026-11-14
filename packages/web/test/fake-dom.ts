/**
 * A DOM just big enough for the apc-web components and enablePinning (there is no browser in `node --test`):
 * elements with attributes, children, classes, listeners, custom elements, localStorage. Importing it sets
 * the globals the components read. Shared by packages/web/test/strings.test.ts and apps/demo/test.
 */
export class Text {
  parentElement: El | null = null;
  data: string;
  constructor(data: string) {
    this.data = data;
  }
}
export class El {
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
  insertBefore(n: El, ref: El | null) {
    if (!ref) return this.append(n);
    n.remove();
    n.parentElement = this;
    this.children.splice(this.children.indexOf(ref), 0, n);
    if (this.isConnected) n.connect();
  }
  removeChild(n: El) {
    n.remove();
  }
  get firstChild(): El | Text | null {
    return this.children[0] ?? null;
  }
  contains(n: unknown): boolean {
    for (let x = n as El | null; x; x = x.parentElement) if (x === this) return true;
    return false;
  }
  get ownerDocument() {
    return doc;
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
export const doc = {
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
  /** SVG elements: the same fake element, its tag as given (lower case kept in localName). */
  createElementNS: (_ns: string, tag: string) => Object.assign(new El(tag), { localName: tag }),
  listeners: new Map<string, Array<(e: unknown) => void>>(),
  addEventListener: (t: string, fn: (e: unknown) => void) => doc.listeners.set(t, [...(doc.listeners.get(t) ?? []), fn]),
  removeEventListener: (t: string, fn: (e: unknown) => void) => doc.listeners.set(t, (doc.listeners.get(t) ?? []).filter((f) => f !== fn)),
  querySelectorAll: (selector: string): El[] => doc.documentElement.querySelectorAll(selector),
  elementFromPoint: (): El | null => hovered,
};
doc.documentElement.append(doc.head, doc.body);
doc.documentElement.style.setProperty = () => {};
doc.documentElement.style.removeProperty = () => {};
let hovered: El | null = null;
export const setHovered = (el: El | null): void => {
  hovered = el;
};
export const defined = new Map<string, new () => El>();
export const store = new Map<string, string>();
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
export const press = (type: string, init: Record<string, unknown> = {}) => (windowListeners.get(type) ?? []).slice().forEach((fn) => fn({ type, clientX: 0, clientY: 0, isTrusted: true, ...init }));


/** The test locale: every key replaced by a marked string; every function by one that marks its arguments. Records which were used. */
export function locale<T extends object>(defaults: T, used: Set<string>): T {
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
export function visible(root: El): string[] {
  const out: string[] = [];
  for (const el of [root, ...root.elements()]) {
    const text = el.ownText().trim();
    if (text) out.push(text);
    for (const v of [el.getAttribute("aria-label"), el.title, el.getAttribute("title"), el.placeholder, el.alt]) if (v) out.push(v);
  }
  return out;
}

