/**
 * The agent bar (TIN-394): the standard place, top right of every APC app, where the agents present
 * in this app show. Each agent is its mark (logo; name as tooltip) and its state; a dot says where it
 * points (click: go there), × removes the pin, ! warns of a shared URL. Dragging a mark onto a target
 * points the agent within the page: the marks carry data-apc-mark and data-grant, the hooks
 * enablePinning drags by. ⊘ revokes the agent (APC 0.2, TIN-577): a first click asks "Revoke?", a
 * second within a few seconds emits apc-revoke, and the app cuts the agent's grant at once, whichever
 * way it came (its own URL or a dock).
 *
 * A custom element in light DOM, not shadow DOM: enablePinning finds marks by event target, and the
 * app's own fonts and theme apply. Its styles are injected once and scoped by class prefix; the app
 * themes it through --apc-* custom properties. Framework-agnostic: set `agents`, listen for events.
 *
 * The bar's rule (APC 0.4, TIN-578):
 * - Each agent shows which path it came by (`paths`): directly, via a dock, or both when the same agent
 *   is linked (apc_link), with Unlink (event apc-unlink).
 * - With any agent that came directly, the bar is always shown in full: the app is the only place the
 *   person sees and points that agent. When every agent came through a dock, the person may collapse it
 *   to a small indicator of who is reading (the dock has the marks); it is never hidden. The pins on the
 *   page (`<apc-pin>`) stay visible and draggable either way.
 * - On mobile (APC 0.6, TIN-608; a viewport that matches APC_MOBILE_MEDIA: a coarse pointer or a narrow
 *   width) the bar is the person's only way to point an agent, so it is never collapsed, whatever the
 *   agents' paths. It sits fixed at the bottom of the viewport, so it stays reachable while the page
 *   scrolls, and reserves its height at the bottom of the page (--apc-bar-height on <html>, plus
 *   padding-bottom on <body>) so it covers no content; an app's own fixed things at the bottom can
 *   sit above it with calc(... + var(--apc-bar-height, 0px)). Its marks, pin dots, × and ⊘ are finger
 *   sized. Tapping a mark arms the agent (tap to pin, enablePinning); the armed mark is outlined.
 * - Offering the dock to a Direct user: a quiet hint, "Use this agent across apps with the dock", shown
 *   while an agent that came only directly is connected, until the person dismisses or follows it (once
 *   per browser). On by default; an app turns it off with `dockHint = null` or `dock-hint="off"`.
 */
import { APC_MOBILE_MEDIA, type ApcProfile } from "@tineira/apc-protocol";
import { APC_ARMED_EVENT } from "./pinning.ts";
import { DEFAULT_BAR_STRINGS, resolveStrings, type BarStrings } from "./strings.ts";

export type AgentState = "off" | "idle" | "waiting" | "busy" | "seen";

export interface BarAgent {
  /** The app's id for the agent (its grant): what pins name. */
  id: string;
  name: string;
  /** An image source for the agent's mark (a data URI or URL), unless the app draws it (renderIcon). */
  icon?: string | null;
  state: AgentState;
  /** Where it points: in words, whether it read it, and whether that target is on this screen. */
  pin?: { label: string; seen: boolean; here: boolean } | null;
  /** A note that something needs the person (TIN-358: another agent uses this one's URL). */
  warning?: string | null;
  /** Limited to part of the app (a restricted grant): outlined. */
  restricted?: boolean;
  /** How it came: ["direct"], ["dock"], or both when the same agent is linked (apc_link). Left out: not shown, and the bar never collapses. */
  paths?: ApcProfile[];
}

/** Events, all with detail { id }: open (go to the pin), unpin, warning (open what the warning is about), revoke (cut the agent from the app, both paths when linked), unlink (show a linked agent as two again). */
export type AgentBarEvent = "apc-open" | "apc-unpin" | "apc-warning" | "apc-revoke" | "apc-unlink";

/** How long the first click on ⊘ waits for the second before it lets go. */
export const REVOKE_CONFIRM_MS = 4000;

/**
 * The one pin a bar entry shows for an agent linked across both paths (apc_link), which holds two
 * grants and so up to two pins: neither hidden. One pin is itself; two read "A and B" (the same
 * target once), unread until both are read, and "here" only when both targets are on screen (so the
 * dot still opens the one that is not). No pin at all is null.
 */
export function mergePins<P extends { label: string; seen: boolean; here: boolean }>(pins: ReadonlyArray<P | null | undefined>, strings: Pick<BarStrings, "joinPins"> = DEFAULT_BAR_STRINGS): P | null {
  const some = pins.filter((p): p is P => !!p);
  if (some.length < 2) return some[0] ?? null;
  return { ...some[0]!, label: strings.joinPins([...new Set(some.map((p) => p.label))]), seen: some.every((p) => p.seen), here: some.every((p) => p.here) };
}

/** The hint that offers the dock to a Direct user, and where it leads. */
export const DOCK_HINT = { text: DEFAULT_BAR_STRINGS.dockHint, url: "https://apc.tineira.com/dock" } as const;
const COLLAPSED_KEY = "apc-agents.collapsed";
const HINT_KEY = "apc-agents.dock-hint";

/** The words for the path an agent came by, for its tag. Null when the app does not say. */
export function pathLabel(paths: readonly ApcProfile[] | undefined, strings: BarStrings = DEFAULT_BAR_STRINGS): { text: string; title: string } | null {
  if (!paths?.length) return null;
  if (paths.includes("direct") && paths.includes("dock")) return { text: strings.pathBoth, title: strings.pathBothTitle };
  return paths[0] === "direct" ? { text: strings.pathDirect, title: strings.pathDirectTitle } : { text: strings.pathDock, title: strings.pathDockTitle };
}

/** Whether this window is a phone or any touch viewport (APC 0.6): a coarse pointer or a narrow width. False where there is no window. */
export function isMobileViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia(APC_MOBILE_MEDIA).matches;
}

/**
 * The bar may collapse only when every agent came through a dock: an agent that came directly keeps it in
 * full. On mobile (APC 0.6) never: the bar is the only place the person can point an agent from.
 */
export function barCanCollapse(agents: readonly BarAgent[], mobile = false): boolean {
  return !mobile && agents.length > 0 && agents.every((a) => !!a.paths?.length && !a.paths.includes("direct"));
}

/** Who is reading, for the collapsed indicator: the agents that connected. */
export function readingSummary(agents: readonly BarAgent[], strings: BarStrings = DEFAULT_BAR_STRINGS): string {
  const names = agents.filter((a) => a.state !== "off").map((a) => a.name);
  return names.length ? strings.reading(names) : strings.nobodyReading;
}

/** The dock hint shows while an agent that came only directly is connected, unless the app turned it off or the person dismissed it. */
export function showDockHint(agents: readonly BarAgent[], options: { enabled: boolean; dismissed: boolean }): boolean {
  return options.enabled && !options.dismissed && agents.some((a) => a.paths?.length === 1 && a.paths[0] === "direct" && a.state !== "off");
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode or storage off: for this page only
  }
}

const STYLE_ID = "apc-agents-style";
const CSS = `
apc-agents { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.apc-agents__agent { position: relative; display: inline-flex; align-items: center; gap: 6px; }
.apc-agents__agent[hidden] { display: none; }
.apc-agents__mark { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border-radius: 8px; cursor: grab; touch-action: none;
  background: var(--apc-chip, #ffffff); border: 1px solid var(--apc-line, #d6dce5); color: var(--apc-ink, #141a24); }
.apc-agents__mark:active { cursor: grabbing; }
.apc-agents__mark img, .apc-agents__mark svg { width: 22px; height: 22px; display: block; pointer-events: none; }
.apc-agents__mark--restricted { outline: 2px solid var(--apc-accent, #b85209); outline-offset: 1px; }
.apc-agents__mark--off img, .apc-agents__mark--off svg { filter: grayscale(1); opacity: 0.45; }
.apc-agents__mark--waiting img, .apc-agents__mark--waiting svg { animation: apc-agents-float 3s ease-in-out infinite; }
.apc-agents__mark--busy img, .apc-agents__mark--busy svg { animation: apc-agents-pulse 0.6s ease-in-out infinite; }
.apc-agents__mark--seen img, .apc-agents__mark--seen svg { animation: apc-agents-bounce 0.9s ease-out 1; }
.apc-agents__warn { position: absolute; top: -5px; left: 22px; width: 14px; height: 14px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
  background: var(--apc-warn, #c0392b); color: #fff; font: 700 10px/14px system-ui, sans-serif; text-align: center; }
.apc-agents__pin { display: inline-flex; align-items: center; gap: 2px; }
.apc-agents__dot { width: 10px; height: 10px; padding: 0; border: 0; border-radius: 50%; cursor: default; background: var(--apc-accent, #b85209); }
.apc-agents__dot--seen { background: var(--apc-ok, #1f7a4d); }
.apc-agents__dot--away { cursor: pointer; box-shadow: 0 0 0 3px var(--apc-accent-soft, rgb(184 82 9 / 0.2)); }
.apc-agents__unpin { border: 0; background: none; padding: 0 3px; font: 14px/1 system-ui, sans-serif; color: inherit; cursor: pointer; opacity: 0.7; }
.apc-agents__unpin:hover { opacity: 1; }
.apc-agents__revoke { border: 0; background: none; padding: 0 2px; font: 13px/1 system-ui, sans-serif; color: inherit; cursor: pointer; opacity: 0.45; }
.apc-agents__revoke:hover, .apc-agents__revoke:focus-visible { opacity: 1; color: var(--apc-warn, #c0392b); }
.apc-agents__revoke.apc-agents__revoke--armed { opacity: 1; padding: 2px 6px; border-radius: 6px; font-weight: 600; font-size: 12px; color: #fff; background: var(--apc-warn, #c0392b); }
.apc-agents__path { font: 600 10px/1 system-ui, sans-serif; letter-spacing: 0.02em; white-space: nowrap; color: var(--apc-muted, #5b6575); }
.apc-agents__unlink, .apc-agents__collapse, .apc-agents__hint button { border: 0; background: none; padding: 0 2px; font: 11px/1 system-ui, sans-serif; color: var(--apc-muted, #5b6575); cursor: pointer; text-decoration: underline dotted; }
.apc-agents__unlink:hover, .apc-agents__collapse:hover, .apc-agents__hint button:hover { color: var(--apc-ink, #141a24); }
.apc-agents__collapse { text-decoration: none; font-size: 13px; opacity: 0.6; }
.apc-agents__mini { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px 0 4px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--apc-line, #d6dce5); background: var(--apc-chip, #ffffff); color: var(--apc-ink, #141a24); font: 600 11px/1 system-ui, sans-serif; }
.apc-agents__mini-icon { display: grid; place-items: center; width: 16px; height: 16px; }
.apc-agents__mini-icon img, .apc-agents__mini-icon svg { width: 16px; height: 16px; display: block; }
.apc-agents__hint { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; font: 11px/1.2 system-ui, sans-serif; color: var(--apc-muted, #5b6575); }
.apc-agents__hint a { color: inherit; }
.apc-agents__hint a:hover { color: var(--apc-ink, #141a24); }
.apc-agents__mark[aria-pressed="true"] { outline: 3px solid var(--apc-accent, #b85209); outline-offset: 2px; }
html.apc-bar-fixed body { padding-bottom: var(--apc-bar-height, 0px); }
@media ${APC_MOBILE_MEDIA} {
  apc-agents { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; box-sizing: border-box; display: flex; justify-content: center; gap: 4px 14px; width: auto; max-height: 40vh; overflow-y: auto; margin: 0; padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
    background: var(--apc-bar-bg, var(--apc-chip, #ffffff)); border-top: 1px solid var(--apc-line, #d6dce5); box-shadow: 0 -2px 10px rgb(0 0 0 / 0.08); }
  apc-agents:empty { display: none; }
  .apc-agents__agent { flex-wrap: wrap; row-gap: 0; }
  .apc-agents__mark { width: 44px; height: 44px; border-radius: 10px; }
  .apc-agents__mark img, .apc-agents__mark svg { width: 28px; height: 28px; }
  .apc-agents__dot { position: relative; width: 14px; height: 14px; margin: 0 6px; }
  .apc-agents__dot::after, .apc-agents__warn::after { content: ""; position: absolute; inset: -14px; }
  .apc-agents__warn { top: -8px; left: 30px; width: 20px; height: 20px; font-size: 13px; line-height: 20px; }
  .apc-agents__unpin { min-width: 44px; min-height: 44px; padding: 0 12px; font-size: 22px; }
  .apc-agents__revoke { min-width: 44px; min-height: 44px; padding: 0 10px; font-size: 17px; }
  .apc-agents__revoke.apc-agents__revoke--armed { padding: 0 12px; font-size: 14px; }
  .apc-agents__unlink { min-height: 44px; padding: 0 8px; font-size: 13px; }
  .apc-agents__path { font-size: 11px; }
  .apc-agents__hint { display: none; }
}
@keyframes apc-agents-float { 0%, 100% { transform: translateY(1.5px); } 50% { transform: translateY(-2.5px); } }
@keyframes apc-agents-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.18); } }
@keyframes apc-agents-bounce { 0% { transform: translateY(0); } 25% { transform: translateY(-6px); } 50% { transform: translateY(0); } 70% { transform: translateY(-2px); } 100% { transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .apc-agents__mark img, .apc-agents__mark svg { animation: none !important; } }
`;

/** A small robot, for an agent with no icon. */
const BOT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 2h2v2.07A7 7 0 0 1 19 11v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a7 7 0 0 1 6-6.93V2Zm-2.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM2 12h2v5H2v-5Zm18 0h2v5h-2v-5Z"/></svg>';

/** The words a mark, its dot and its revoke button say, for tooltips and screen readers. Pure, so it is tested. */
export function agentLabels(a: BarAgent, strings: BarStrings = DEFAULT_BAR_STRINGS): { mark: string; dot: string | null; revoke: string; revokeArmed: string } {
  const mark = strings.markTitle(a.name, a.state !== "off");
  const both = !!a.paths?.includes("direct") && !!a.paths.includes("dock");
  const revoke = strings.revokeTitle(a.name, both);
  const revokeArmed = strings.revokeConfirmTitle(a.name);
  if (!a.pin) return { mark, dot: null, revoke, revokeArmed };
  return { mark, dot: strings.pinTitle(a.pin.label, a.pin.seen, a.pin.here), revoke, revokeArmed };
}

/** The room each fixed bar takes at the bottom of the page: the page keeps the largest, as --apc-bar-height and padding on <body>. */
const reserved = new Map<HTMLElement, number>();
function reserveBottom(el: HTMLElement, height: number): void {
  if (height > 0) reserved.set(el, height);
  else reserved.delete(el);
  const max = Math.max(0, ...reserved.values());
  const html = document.documentElement;
  if (max > 0) {
    html.style.setProperty("--apc-bar-height", `${max}px`);
    html.classList.add("apc-bar-fixed");
  } else {
    html.style.removeProperty("--apc-bar-height");
    html.classList.remove("apc-bar-fixed");
  }
}

/** The element's constructor, defined only where custom elements exist (a browser), so importing this module in Node is safe. */
export function defineAgentBar(tag = "apc-agents"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;

  class ApcAgents extends HTMLElement {
    private list: BarAgent[] = [];
    private nodes = new Map<string, { root: HTMLElement; icon: HTMLElement; key: string }>();
    /** Agents whose ⊘ was clicked once, with the timer that lets go. */
    private armed = new Map<string, ReturnType<typeof setTimeout>>();
    /** The app draws an agent's icon into this element itself (for example with its own logos). Called on every update. */
    renderIcon: ((agent: BarAgent, into: HTMLElement) => void) | null = null;
    /** undefined: the default hint, in the bar's strings; null: off. */
    private hint: { text: string; url: string } | null | undefined = undefined;
    private words: BarStrings = DEFAULT_BAR_STRINGS;
    private given: Partial<BarStrings> | null = null;
    /** Bumped when the strings change, so every entry is drawn again. */
    private stringsVersion = 0;
    /** The collapsed indicator's icons, kept per agent like the marks' (an app's renderIcon may keep state in them). */
    private miniIcons = new Map<string, HTMLElement>();

    get agents(): BarAgent[] {
      return this.list;
    }
    set agents(next: BarAgent[]) {
      this.list = next;
      this.render();
    }
    /** The hint that offers the dock to a Direct user; null turns it off. */
    get dockHint(): { text: string; url: string } | null {
      if (this.getAttribute("dock-hint") === "off" || this.hint === null) return null;
      return this.hint ?? { text: this.words.dockHint, url: DOCK_HINT.url };
    }
    set dockHint(next: { text: string; url: string } | null) {
      this.hint = next;
      this.render();
    }
    /** Every string the bar shows (TIN-668): the keys you set, over the English defaults. */
    get strings(): Partial<BarStrings> | null {
      return this.given;
    }
    set strings(next: Partial<BarStrings> | null) {
      this.given = next;
      this.words = resolveStrings(DEFAULT_BAR_STRINGS, next);
      this.stringsVersion++;
      if (this.getAttribute("data-apc-label") === "default") this.setAttribute("aria-label", this.words.toolbar);
      this.render();
    }

    /** Mobile (APC 0.6): the viewport is a phone's or a touch one's; the bar then never collapses. */
    private media: MediaQueryList | null = null;
    private resizer: ResizeObserver | null = null;
    private mobile(): boolean {
      return !!this.media?.matches;
    }
    private onMedia = (): void => {
      this.render();
      this.reserve();
    };
    private onArmed = (): void => {
      for (const node of this.nodes.values()) node.key = "";
      this.render();
    };
    /** Tell the page how much room the fixed bar takes at the bottom, or that it takes none. */
    private reserve(): void {
      reserveBottom(this, this.mobile() ? this.offsetHeight : 0);
    }

    private collapsed(): boolean {
      return barCanCollapse(this.list, this.mobile()) && stored(COLLAPSED_KEY) === "1";
    }

    disconnectedCallback(): void {
      this.media?.removeEventListener("change", this.onMedia);
      this.media = null;
      this.resizer?.disconnect();
      this.resizer = null;
      window.removeEventListener(APC_ARMED_EVENT, this.onArmed);
      reserveBottom(this, 0);
    }

    connectedCallback(): void {
      if (typeof matchMedia === "function") {
        this.media = matchMedia(APC_MOBILE_MEDIA);
        this.media.addEventListener("change", this.onMedia);
      }
      window.addEventListener(APC_ARMED_EVENT, this.onArmed);
      if (typeof ResizeObserver === "function") {
        this.resizer = new ResizeObserver(() => this.reserve());
        this.resizer.observe(this);
      }
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.append(style);
      }
      if (!this.hasAttribute("role")) this.setAttribute("role", "toolbar");
      if (!this.hasAttribute("aria-label")) {
        this.setAttribute("aria-label", this.words.toolbar);
        this.setAttribute("data-apc-label", "default");
      }
      this.render();
    }

    private emit(type: AgentBarEvent, id: string): void {
      this.dispatchEvent(new CustomEvent(type, { detail: { id }, bubbles: true }));
    }

    private disarm(id: string, rerender = true): void {
      const timer = this.armed.get(id);
      if (timer === undefined) return;
      clearTimeout(timer);
      this.armed.delete(id);
      if (rerender) this.render();
    }

    /** First click arms, second (within REVOKE_CONFIRM_MS) emits apc-revoke. */
    private revokeClicked(id: string): void {
      if (this.armed.has(id)) {
        this.disarm(id);
        this.emit("apc-revoke", id);
        return;
      }
      this.armed.set(id, setTimeout(() => this.disarm(id), REVOKE_CONFIRM_MS));
      this.render();
      (this.nodes.get(id)?.root.querySelector(".apc-agents__revoke") as HTMLElement | null)?.focus();
    }

    /** Keyed by agent: an agent's element (and the icon the app drew in it) lives as long as the agent. */
    private render(): void {
      if (!this.isConnected) return;
      const collapsed = this.collapsed();
      const seen = new Set<string>();
      for (const a of this.list) {
        seen.add(a.id);
        let node = this.nodes.get(a.id);
        if (!node) {
          const root = document.createElement("span");
          root.className = "apc-agents__agent";
          const icon = document.createElement("span");
          icon.className = "apc-agents__icon";
          node = { root, icon, key: "" };
          this.nodes.set(a.id, node);
        }
        // Collapsed, an agent's element is hidden, not removed: what the app drew in it stays.
        node.root.hidden = collapsed;
        this.append(node.root);
        this.fill(node, a);
      }
      for (const [id, node] of this.nodes) {
        if (seen.has(id)) continue;
        node.root.remove();
        this.nodes.delete(id);
        this.miniIcons.delete(id);
        this.disarm(id, false);
      }
      for (const old of this.querySelectorAll(":scope > .apc-agents__extra")) old.remove();
      if (collapsed) this.append(this.mini());
      else if (barCanCollapse(this.list, this.mobile())) {
        const fold = document.createElement("button");
        fold.type = "button";
        fold.className = "apc-agents__collapse apc-agents__extra";
        fold.textContent = "‹";
        fold.title = this.words.collapseTitle;
        fold.setAttribute("aria-label", this.words.collapseAria);
        fold.addEventListener("click", () => {
          store(COLLAPSED_KEY, "1");
          this.render();
        });
        this.append(fold);
      }
      const hint = this.dockHint;
      if (hint && showDockHint(this.list, { enabled: true, dismissed: stored(HINT_KEY) === "dismissed" })) this.append(this.hintNode(hint));
    }

    /** Collapsed: who is reading, as small icons and a count; a click shows the bar again. Never hidden. */
    private mini(): HTMLElement {
      const reading = this.list.filter((a) => a.state !== "off");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "apc-agents__mini apc-agents__extra";
      const summary = readingSummary(this.list, this.words);
      button.title = this.words.showAgents(summary);
      button.setAttribute("aria-label", this.words.showAgents(summary));
      for (const a of reading.slice(0, 4)) {
        let icon = this.miniIcons.get(a.id);
        if (!icon) {
          icon = document.createElement("span");
          icon.className = "apc-agents__mini-icon";
          this.miniIcons.set(a.id, icon);
        }
        if (this.renderIcon) this.renderIcon(a, icon);
        else if (a.icon) {
          const img = document.createElement("img");
          img.src = a.icon;
          img.alt = "";
          icon.replaceChildren(img);
        } else icon.innerHTML = BOT;
        button.append(icon);
      }
      button.append(document.createTextNode(reading.length ? this.words.readingCount(reading.length) : this.words.nobodyReadingShort));
      button.addEventListener("click", () => {
        store(COLLAPSED_KEY, null);
        this.render();
      });
      return button;
    }

    private hintNode(hint: { text: string; url: string }): HTMLElement {
      const box = document.createElement("span");
      box.className = "apc-agents__hint apc-agents__extra";
      const dismiss = () => {
        store(HINT_KEY, "dismissed");
        this.render();
      };
      const link = document.createElement("a");
      link.href = hint.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = hint.text;
      link.addEventListener("click", () => setTimeout(dismiss, 0));
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", this.words.dockHintDismiss);
      close.addEventListener("click", dismiss);
      box.append(link, close);
      return box;
    }

    private fill(node: { root: HTMLElement; icon: HTMLElement; key: string }, a: BarAgent): void {
      const labels = agentLabels(a, this.words);
      const armed = this.armed.has(a.id);
      const key = JSON.stringify([a.name, a.state, a.pin, a.warning, a.restricted, typeof a.icon === "string" ? a.icon.length : null, armed, a.paths ?? null, this.stringsVersion]);
      if (this.renderIcon) this.renderIcon(a, node.icon);
      else if (node.key === "" || JSON.stringify(a.icon ?? null) !== node.icon.dataset.src) {
        node.icon.dataset.src = JSON.stringify(a.icon ?? null);
        if (a.icon) {
          const img = document.createElement("img");
          img.src = a.icon;
          img.alt = "";
          node.icon.replaceChildren(img);
        } else node.icon.innerHTML = BOT;
      }
      if (node.key === key) return;
      node.key = key;

      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = `apc-agents__mark apc-agents__mark--${a.state}${a.restricted ? " apc-agents__mark--restricted" : ""}`;
      mark.dataset.apcMark = "";
      mark.dataset.grant = a.id;
      mark.title = labels.mark;
      mark.setAttribute("aria-label", a.name);
      if (document.documentElement.getAttribute("data-apc-armed") === a.id) mark.setAttribute("aria-pressed", "true");
      // The icon element moves into the new mark, so what the app drew in it stays.
      mark.append(node.icon);
      const parts: HTMLElement[] = [mark];

      if (a.warning) {
        const warn = document.createElement("button");
        warn.type = "button";
        warn.className = "apc-agents__warn";
        warn.textContent = "!";
        warn.title = a.warning;
        warn.setAttribute("aria-label", a.warning);
        warn.addEventListener("click", () => this.emit("apc-warning", a.id));
        parts.push(warn);
      }
      if (a.pin && labels.dot) {
        const pin = document.createElement("span");
        pin.className = "apc-agents__pin";
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = `apc-agents__dot${a.pin.seen ? " apc-agents__dot--seen" : ""}${a.pin.here ? "" : " apc-agents__dot--away"}`;
        dot.title = labels.dot;
        dot.setAttribute("aria-label", this.words.pinAria(a.name, a.pin.label, a.pin.seen));
        dot.addEventListener("click", () => !a.pin?.here && this.emit("apc-open", a.id));
        const unpin = document.createElement("button");
        unpin.type = "button";
        unpin.className = "apc-agents__unpin";
        unpin.textContent = "×";
        unpin.setAttribute("aria-label", this.words.unpinAria(a.name));
        unpin.addEventListener("click", (e) => e.isTrusted && this.emit("apc-unpin", a.id));
        pin.append(dot, unpin);
        parts.push(pin);
      }
      // Which path it came by; a linked agent can be shown as two again.
      const path = pathLabel(a.paths, this.words);
      if (path) {
        const tag = document.createElement("span");
        tag.className = "apc-agents__path";
        tag.textContent = path.text;
        tag.title = path.title;
        parts.push(tag);
        if (a.paths?.length === 2) {
          const unlink = document.createElement("button");
          unlink.type = "button";
          unlink.className = "apc-agents__unlink";
          unlink.textContent = this.words.unlink;
          unlink.title = this.words.unlinkTitle(a.name);
          unlink.setAttribute("aria-label", this.words.unlinkAria(a.name));
          unlink.addEventListener("click", (e) => e.isTrusted && this.emit("apc-unlink", a.id));
          parts.push(unlink);
        }
      }
      // Revoke from the app: every agent has it, whichever way it came.
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = `apc-agents__revoke${armed ? " apc-agents__revoke--armed" : ""}`;
      revoke.textContent = armed ? this.words.revokeConfirm : "⊘";
      revoke.title = armed ? labels.revokeArmed : labels.revoke;
      revoke.setAttribute("aria-label", armed ? labels.revokeArmed : this.words.revokeAria(a.name));
      revoke.addEventListener("click", (e) => e.isTrusted && this.revokeClicked(a.id));
      revoke.addEventListener("keydown", (e) => e.key === "Escape" && this.disarm(a.id));
      parts.push(revoke);
      node.root.replaceChildren(...parts);
    }
  }

  customElements.define(tag, ApcAgents);
}

/** The element's type, for apps that hold a reference to it. */
export interface ApcAgentsElement extends HTMLElement {
  agents: BarAgent[];
  renderIcon: ((agent: BarAgent, into: HTMLElement) => void) | null;
  dockHint: { text: string; url: string } | null;
  /** The bar's strings (TIN-668): set the keys you translate; the rest stay English. */
  strings: Partial<BarStrings> | null;
}
