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

export interface PinAgent {
  /** The app's id for the agent (its grant): what the mark drags as. */
  id: string;
  name: string;
  /** An image source for the agent's mark (a data URI or URL), unless the app draws it (renderIcon). */
  icon?: string | null;
  /** Whether the agent has read the pin: a check instead of the dashed ring. */
  seen: boolean;
}

/** Event, with detail { id }: the person removed the pin. */
export type PinBadgeEvent = "apc-unpin";

const STYLE_ID = "apc-pin-style";
const CSS = `
apc-pin { position: relative; display: inline-block; width: var(--apc-pin-size, 28px); height: var(--apc-pin-size, 28px); vertical-align: middle; }
.apc-pin__mark { display: grid; place-items: center; width: var(--apc-pin-size, 28px); height: var(--apc-pin-size, 28px); border-radius: 6px; cursor: grab; touch-action: none; outline-offset: 2px;
  background: var(--apc-chip, #ffffff); color: var(--apc-ink, #141a24); box-shadow: 0 2px 6px rgb(0 0 0 / 0.18); }
.apc-pin__mark:active { cursor: grabbing; }
.apc-pin__icon { display: grid; place-items: center; }
.apc-pin__mark .apc-pin__img { width: 18px; height: 18px; display: block; object-fit: contain; pointer-events: none; }
apc-pin[data-apc-pin-state="waiting"] .apc-pin__mark { outline: 2px dashed var(--apc-accent, #b85209); animation: apc-pin-breathe 1.8s ease-in-out infinite; }
apc-pin.apc-pin--dragging { opacity: 0.35; }
.apc-pin__check { position: absolute; right: -7px; bottom: -7px; width: 15px; height: 15px; border-radius: 50%; background: var(--apc-ok, #1f7a4d); color: #fff;
  font: 700 10px/15px var(--apc-pin-font, ui-monospace, monospace); text-align: center; }
.apc-pin__check[hidden] { display: none; }
.apc-pin__unpin { position: absolute; right: -8px; top: -8px; width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid var(--apc-line, #d6dce5);
  background: var(--apc-chip, #ffffff); color: var(--apc-muted, #56627a); font-size: 12px; line-height: 13px; cursor: pointer; opacity: 0.85; }
.apc-pin__unpin:hover { color: var(--apc-ink, #141a24); opacity: 1; }
@keyframes apc-pin-breathe { 0%, 100% { outline-offset: 2px; } 50% { outline-offset: 4px; } }
@media (prefers-reduced-motion: reduce) { apc-pin .apc-pin__mark { animation: none !important; } }
`;

/** A small robot, for an agent with no icon. */
const BOT = '<svg class="apc-pin__img" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 2h2v2.07A7 7 0 0 1 19 11v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a7 7 0 0 1 6-6.93V2Zm-2.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM2 12h2v5H2v-5Zm18 0h2v5h-2v-5Z"/></svg>';

/** The words a badge says, for its tooltip and screen readers. Pure, so it is tested. */
export function pinBadgeLabels(a: Pick<PinAgent, "name" | "seen">): { title: string; unpin: string } {
  return {
    title: `${a.name}: ${a.seen ? "read this pin" : "has not read this pin yet"}. Drag to point it at something else.`,
    unpin: `Remove ${a.name}'s pin`,
  };
}

/** The element's constructor, defined only where custom elements exist (a browser), so importing this module in Node is safe. */
export function definePinBadge(tag = "apc-pin"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;

  class ApcPin extends HTMLElement {
    private value: PinAgent | null = null;
    private parts: { mark: HTMLElement; icon: HTMLElement; check: HTMLElement; unpin: HTMLButtonElement } | null = null;
    private iconKey = "";
    private stopDim: (() => void) | null = null;
    /** The app draws the agent's icon into this element itself (for example with its own logos). Called on every update. */
    renderIcon: ((agent: PinAgent, into: HTMLElement) => void) | null = null;

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
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
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
        unpin.addEventListener("click", () => this.value && this.dispatchEvent(new CustomEvent("apc-unpin", { detail: { id: this.value.id }, bubbles: true })));
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
      const labels = pinBadgeLabels(a);
      this.setAttribute("title", labels.title);
      this.setAttribute("data-apc-pin-state", a.seen ? "seen" : "waiting");
      mark.setAttribute("data-grant", a.id);
      check.hidden = !a.seen;
      unpin.setAttribute("aria-label", labels.unpin);
      if (this.renderIcon) this.renderIcon(a, icon);
      else if (this.iconKey !== JSON.stringify(a.icon ?? null)) {
        this.iconKey = JSON.stringify(a.icon ?? null);
        if (a.icon) {
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
  renderIcon: ((agent: PinAgent, into: HTMLElement) => void) | null;
}
