/**
 * The pin badge (TIN-482): the standard mark an APC app shows where an agent is pinned. It is the
 * agent's logo in a square, a dashed breathing ring while the agent has not read the pin, a check
 * once it has, × to remove the pin, and the agent's name as tooltip. The agent bar (agents-bar.ts)
 * is where the agents are; this is where one points, and it works the same in every APC app.
 *
 * The badge is a mark: it carries data-apc-mark and data-grant, the hooks enablePinning drags by, so
 * dragging it onto another target moves the pin with no code in the app. While it is dragged it
 * dims, until the drop or Esc. Where the badge goes is the app's: Pulse floats badges over their
 * targets, Signals puts them inline next to a post part.
 *
 * A custom element in light DOM, like <apc-agents>: enablePinning finds marks by event target, and
 * the app's fonts and theme apply. Its styles are injected once and scoped by class prefix; the app
 * themes it through --apc-* custom properties (--apc-chip, --apc-line, --apc-ink, --apc-muted, --apc-accent, --apc-ok, and --apc-pin-font for
 * the check). Framework-agnostic: set `agent`, listen for apc-unpin.
 *
 * The browser extension keeps a copy of this badge's look (apps/extension/src/content.ts): a content
 * script has no customElements, and it moves the badge with its own drag, since a moved reading is
 * sent again from the page. Keep the two in step.
 */
import { APC_MOBILE_MEDIA } from "@tineira/apc-protocol";
import { markArmed } from "./armed.ts";
import type { PetBadge } from "./brands.ts";
import { drawBadge } from "./pet.ts";
import { DEFAULT_PIN_STRINGS, resolveStrings, type PinStrings } from "./strings.ts";

export interface PinAgent {
  /** The app's id for the agent (its grant): what the mark drags as. */
  id: string;
  name: string;
  /** An image source for the agent's mark (a data URI or URL), unless the app draws it (renderIcon). */
  icon?: string | null;
  /**
   * The agent's logo or neutral mark, as its pet wears it (agentBadge, TIN-878): drawn when there is no
   * `icon` and the app draws none. Without either, a small robot.
   */
  badge?: PetBadge | null;
  /** Whether the agent has read the pin: a check instead of the dashed ring. */
  seen: boolean;
}

/** Event, with detail { id }: the person removed the pin. */
export type PinBadgeEvent = "apc-unpin";

const STYLE_ID = "apc-pin-style";
/** The badge's styles (exported for tests). */
export const PIN_BADGE_CSS = `
apc-pin { position: relative; display: inline-block; width: var(--apc-pin-size, 28px); height: var(--apc-pin-size, 28px); vertical-align: middle; }
.apc-pin__mark { display: grid; place-items: center; width: var(--apc-pin-size, 28px); height: var(--apc-pin-size, 28px); border-radius: 6px; cursor: grab; touch-action: none; outline-offset: 2px;
  background: var(--apc-chip, #ffffff); color: var(--apc-ink, #141a24); box-shadow: 0 2px 6px rgb(0 0 0 / 0.18); }
.apc-pin__icon { display: grid; place-items: center; }
.apc-pin__mark .apc-pin__img { width: 18px; height: 18px; display: block; object-fit: contain; pointer-events: none; }
.apc-pin__mark .apc-pin__badge { width: 22px; height: 22px; display: block; overflow: visible; pointer-events: none; }
apc-pin[data-apc-pin-state="waiting"] .apc-pin__mark { outline: 2px dashed var(--apc-accent, #b85209); animation: apc-pin-breathe 1.8s ease-in-out infinite; }
apc-pin.apc-pin--dragging { opacity: 0.35; }
.apc-pin__check { position: absolute; right: -7px; bottom: -7px; width: 15px; height: 15px; border-radius: 50%; background: var(--apc-ok, #1f7a4d); color: #fff;
  font: 700 10px/15px var(--apc-pin-font, ui-monospace, monospace); text-align: center; }
.apc-pin__check[hidden] { display: none; }
.apc-pin__unpin { position: absolute; right: -8px; top: -8px; width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid var(--apc-line, #d6dce5);
  background: var(--apc-pin-unpin-bg, var(--apc-chip, #ffffff)); color: var(--apc-muted, #56627a); font-size: 12px; line-height: 13px; cursor: pointer; opacity: 0.85; }
.apc-pin__unpin:hover { color: var(--apc-ink, #141a24); opacity: 1; }
/* On touch the × sits beside the mark, never over its corner, and its hit area stops at the mark's edge (TIN-903):
   a tap on the mark arms or drags it, and a tap on the × unpins. The step between stacked badges is PIN_STACK_STEP_TOUCH. */
@media ${APC_MOBILE_MEDIA} {
  .apc-pin__unpin { right: auto; top: 2px; left: calc(var(--apc-pin-size, 28px) + 4px); width: 24px; height: 24px; font-size: 16px; line-height: 21px; }
  .apc-pin__unpin::after { content: ""; position: absolute; inset: -10px -10px -10px -4px; }
}
@keyframes apc-pin-breathe { 0%, 100% { outline-offset: 2px; } 50% { outline-offset: 4px; } }
@media (prefers-reduced-motion: reduce) { apc-pin .apc-pin__mark { animation: none !important; } }
`;

/** A small robot, for an agent with no icon. */
const BOT = '<svg class="apc-pin__img" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 2h2v2.07A7 7 0 0 1 19 11v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a7 7 0 0 1 6-6.93V2Zm-2.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM2 12h2v5H2v-5Zm18 0h2v5h-2v-5Z"/></svg>';

const SVG_NS = "http://www.w3.org/2000/svg";
let clips = 0;

/** What the icon is drawn from: an `icon` wins over a `badge`, which wins over the robot. */
const iconKeyOf = (a: PinAgent) => JSON.stringify(a.icon ? [a.icon] : [null, a.badge ?? null]);

/** An agent's badge as the pet wears it, in a small SVG. */
function badgeSvg(badge: PetBadge): Element {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "apc-pin__badge");
  svg.setAttribute("viewBox", "-20 -20 40 40");
  svg.setAttribute("aria-hidden", "true");
  const clip = `apc-pin-clip-${++clips}`;
  const path = document.createElementNS(SVG_NS, "clipPath");
  path.setAttribute("id", clip);
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("r", "15.5");
  path.appendChild(circle);
  svg.appendChild(path);
  for (const el of drawBadge(document, badge, clip)) svg.appendChild(el);
  return svg;
}

/** How far (px) each further badge on the same target sits from the last, so every × stays reachable (TIN-878). */
export const PIN_STACK_STEP = 30;

/**
 * The same step on touch (TIN-903): the × sits beside the mark (4 px off, 24 px wide, a 10 px hit area), so
 * a badge takes 28 + 4 + 24 + 10 px, and the next badge starts past that: no × covers another badge's mark.
 */
export const PIN_STACK_STEP_TOUCH = 72;

/** The step between stacked badges: PIN_STACK_STEP, or PIN_STACK_STEP_TOUCH where the page is touch (APC_MOBILE_MEDIA). */
export function pinStackStep(touch: boolean): number {
  return touch ? PIN_STACK_STEP_TOUCH : PIN_STACK_STEP;
}

/** Whether the page is touch for the badge: the media query the badge's styles use. False where there is no matchMedia. */
export function pinTouch(): boolean {
  return typeof globalThis.matchMedia === "function" && globalThis.matchMedia(APC_MOBILE_MEDIA).matches;
}

/**
 * Where a badge's left edge goes on the page (px), for the app that places badges itself (Pulse floats them over their
 * targets): at the target's right edge, each further badge on the same target `index` steps to the left, and the first
 * never so far right that its × leaves the viewport. The stack keeps its steps at the right edge (it moves left as a
 * whole), and no badge goes past 4 px from the left edge.
 */
export function pinBadgeX(o: { targetRight: number; viewportWidth: number; index: number; touch: boolean; size?: number }): number {
  const size = o.size ?? 28;
  // The room the × needs right of the mark: 8 px of corner on a pointer, 4 + 24 + 10 px of beside-and-hit-area on touch.
  const room = o.touch ? 38 : 8;
  const first = Math.min(o.targetRight - 22, o.viewportWidth - size - room);
  return Math.max(first - Math.max(0, o.index) * pinStackStep(o.touch), 4);
}

/**
 * Where an agent's badge goes among the badges on the same target (0: the first), so several agents
 * pinned to one element each keep a badge and an × the person can reach: place each one pinStackStep(touch)
 * further along (PIN_STACK_STEP, and PIN_STACK_STEP_TOUCH on touch; pinBadgeX does it). Two pins are on the same target when kind, id, part and params are the same.
 */
export function pinStackIndex(agents: ReadonlyArray<{ id: string; target: StackTarget }>, id: string): number {
  const key = (t: StackTarget) => JSON.stringify([t.kind, t.id ?? null, t.part ?? null, t.params ?? null]);
  const mine = agents.find((a) => a.id === id);
  if (!mine) return 0;
  return Math.max(0, agents.filter((a) => key(a.target) === key(mine.target)).findIndex((a) => a.id === id));
}
type StackTarget = { kind: string; id?: string | null; part?: string | null; params?: unknown };

/** The words a badge says, for its tooltip and screen readers. Pure, so it is tested. */
export function pinBadgeLabels(a: Pick<PinAgent, "name" | "seen">, given?: Partial<PinStrings> | null): { title: string; unpin: string } {
  const strings = resolveStrings(DEFAULT_PIN_STRINGS, given);
  return { title: strings.title(a.name, a.seen), unpin: strings.unpinAria(a.name) };
}

/** The element's constructor, defined only where custom elements exist (a browser), so importing this module in Node is safe. */
export function definePinBadge(tag = "apc-pin"): void {
  // Null in a content script, where there are no custom elements.
  if (!globalThis.customElements || customElements.get(tag)) return;

  class ApcPin extends HTMLElement {
    private value: PinAgent | null = null;
    private parts: { mark: HTMLElement; icon: HTMLElement; check: HTMLElement; unpin: HTMLButtonElement } | null = null;
    private iconKey = "";
    private stopDim: (() => void) | null = null;
    private draw: ((agent: PinAgent, into: HTMLElement) => void) | null = null;
    private words: PinStrings = DEFAULT_PIN_STRINGS;
    private given: Partial<PinStrings> | null = null;

    /** Every string the badge shows (TIN-668): the keys you set, over the English defaults. */
    get strings(): Partial<PinStrings> | null {
      return this.given;
    }
    set strings(next: Partial<PinStrings> | null) {
      this.given = next;
      this.words = resolveStrings(DEFAULT_PIN_STRINGS, next);
      this.render();
    }

    /**
     * The app draws the agent's icon into this element itself (for example with its own logos). Called on every update.
     * A function that draws nothing says the app draws it elsewhere, into `iconHost` (React: a portal).
     */
    get renderIcon(): ((agent: PinAgent, into: HTMLElement) => void) | null {
      return this.draw;
    }
    set renderIcon(next: ((agent: PinAgent, into: HTMLElement) => void) | null) {
      this.draw = next;
      this.render();
    }

    /** Where the agent's icon goes: the app may draw into it once the badge is connected. */
    get iconHost(): HTMLElement | null {
      return this.parts?.icon ?? null;
    }

    get agent(): PinAgent | null {
      return this.value;
    }
    set agent(next: PinAgent | null) {
      this.value = next;
      this.render();
    }

    /** The mark inside: what a drag starts from. */
    get mark(): HTMLElement | null {
      return this.parts?.mark ?? null;
    }

    connectedCallback(): void {
      // A property set before the element was defined (a framework, a script) sits on the instance: take it in through the setter.
      const own = this as unknown as Record<string, unknown>;
      for (const key of ["agent", "renderIcon", "strings"]) {
        if (!Object.hasOwn(own, key)) continue;
        const value = own[key];
        delete own[key];
        own[key] = value;
      }
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = PIN_BADGE_CSS;
        document.head.append(style);
      }
      if (!this.parts) {
        const mark = document.createElement("span");
        mark.className = "apc-pin__mark";
        mark.setAttribute("data-apc-mark", "");
        const icon = document.createElement("span");
        icon.className = "apc-pin__icon";
        mark.append(icon);
        const check = document.createElement("span");
        check.className = "apc-pin__check";
        check.textContent = "✓";
        check.setAttribute("aria-hidden", "true");
        const unpin = document.createElement("button");
        unpin.type = "button";
        unpin.className = "apc-pin__unpin";
        unpin.textContent = "×";
        unpin.addEventListener("click", (e) => e.isTrusted && this.value && this.dispatchEvent(new CustomEvent("apc-unpin", { detail: { id: this.value.id }, bubbles: true })));
        // The badge dims from the press until the drop or Esc (the drag itself is enablePinning's).
        mark.addEventListener("pointerdown", (e) => (e as PointerEvent).button === 0 && this.dim());
        this.parts = { mark, icon, check, unpin };
        this.append(mark, check, unpin);
      }
      this.render();
    }

    disconnectedCallback(): void {
      this.stopDim?.();
    }

    private dim(): void {
      this.stopDim?.();
      this.classList.add("apc-pin--dragging");
      const stop = () => this.stopDim?.();
      const onKey = (e: KeyboardEvent) => e.key === "Escape" && stop();
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      window.addEventListener("keydown", onKey);
      this.stopDim = () => {
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        window.removeEventListener("keydown", onKey);
        this.classList.remove("apc-pin--dragging");
        this.stopDim = null;
      };
    }

    private render(): void {
      const a = this.value;
      if (!this.parts || !a) return;
      const { mark, icon, check, unpin } = this.parts;
      const labels = pinBadgeLabels(a, this.words);
      this.setAttribute("title", labels.title);
      this.setAttribute("data-apc-pin-state", a.seen ? "seen" : "waiting");
      mark.setAttribute("data-grant", a.id);
      // A button, so the armed state (aria-pressed) is valid on it; it is not a tab stop: the person drags it.
      mark.setAttribute("role", "button");
      mark.setAttribute("aria-label", this.words.markAria(a.name, a.seen));
      markArmed(mark, a.id);
      check.hidden = !a.seen;
      unpin.setAttribute("aria-label", labels.unpin);
      if (this.draw) this.draw(a, icon);
      else if (this.iconKey !== iconKeyOf(a)) {
        this.iconKey = iconKeyOf(a);
        if (!a.icon && a.badge) icon.replaceChildren(badgeSvg(a.badge));
        else if (a.icon) {
          const img = document.createElement("img");
          img.className = "apc-pin__img";
          img.src = a.icon;
          img.alt = a.name;
          icon.replaceChildren(img);
        } else icon.innerHTML = BOT;
      }
    }
  }

  customElements.define(tag, ApcPin);
}

/** The element's type, for apps that hold a reference to it. */
export interface ApcPinElement extends HTMLElement {
  agent: PinAgent | null;
  readonly mark: HTMLElement | null;
  readonly iconHost: HTMLElement | null;
  renderIcon: ((agent: PinAgent, into: HTMLElement) => void) | null;
  /** The badge's strings (TIN-668): set the keys you translate; the rest stay English. */
  strings: Partial<PinStrings> | null;
}
