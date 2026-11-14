/**
 * The agents in the header (TIN-795, TIN-878): `<apc-pets>`, each connected agent a pet next to the
 * app's account button, like another person looking at the page. At most three pets show (overlapping,
 * like avatars), then one button: "+N" for the rest, or "▾" when every agent shows. That button opens a
 * popover with every agent: what it is doing, where its pin is (a click there emits apc-open) and whether
 * it read it. A pet whose pin is not on this page wears a dot.
 *
 * Each pet is a mark and only a mark: it carries data-apc-mark and data-grant, the hooks enablePinning
 * drags by, so the person drags a pet onto a target (or taps it, or presses Enter on it, and then the
 * target) to point that agent. A pet never opens the popover, so the popover never covers the target the
 * person is about to tap. On a phone the pets stay in the header, side by side with no overlap, every
 * control at least 44 px.
 *
 * The popover updates in place: an agent keeps its row and its buttons across updates, so focus and a
 * press inside an open popover survive the app setting `agents` again (on every presence event).
 *
 * A custom element in light DOM, like <apc-agents>: the app's fonts and theme apply. It is themed by
 * --apc-* custom properties (--apc-chip, --apc-line, --apc-ink, --apc-muted, --apc-accent, and
 * --apc-pets-size for the pet), and the pets by `scheme` and `tint` (pet-scheme.ts). Framework-agnostic:
 * set `agents`, listen for apc-open.
 */
import { APC_MOBILE_MEDIA } from "@tineira/apc-protocol";
import { colorFor, type PetBadge } from "./brands.ts";
import { createPet, petPhase, type PetHandle } from "./pet.ts";
import type { PetScheme, PetTint } from "./pet-scheme.ts";
import type { PetState } from "./pet-state.ts";
import { DEFAULT_PETS_STRINGS, resolveStrings, type PetsStrings } from "./strings.ts";

/** At most this many pets show; the rest are "+N". */
export const PET_MAX = 3;

/** The pets drawn (the first `max`, in the order given) and how many are left out. */
export function petLayout<T>(agents: readonly T[], max = PET_MAX): { shown: T[]; extra: number } {
  const shown = agents.slice(0, Math.max(0, max));
  return { shown, extra: Math.max(0, agents.length - shown.length) };
}

export interface HeaderPet {
  /** The app's id for the agent (its grant): what the mark drags as. */
  id: string;
  name: string;
  /** From petState(...), fed by the app's own data. */
  state: PetState;
  /** Its logo (agentBadge); left out, the neutral mark in the agent's own colour. */
  badge?: PetBadge | null;
  /** Where it points: in words, whether it read it, and whether that target is on this page. */
  pin?: { label: string; seen: boolean; here: boolean } | null;
}

/** Event, with detail { id }: the person chose an agent's pin in the popover (go to it). */
export type HeaderPetsEvent = "apc-open";

const STYLE_ID = "apc-pets-style";
/** The component's styles (exported for tests). */
export const HEADER_PETS_CSS = `
apc-pets { position: relative; display: inline-flex; align-items: center; }
apc-pets[hidden] { display: none; }
.apc-pets__row { display: flex; align-items: center; }
.apc-pets__pet { position: relative; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; margin: 0; border: 0; border-radius: 50%; background: none; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; outline-offset: 2px; --apc-pet-size: var(--apc-pets-size, 36px); }
.apc-pets__pet + .apc-pets__pet { margin-left: -12px; }
.apc-pets__pet .apc-pet { display: block; pointer-events: none; overflow: visible; }
.apc-pets__dot { position: absolute; right: 4px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--apc-accent, #b85209); box-shadow: 0 0 0 2px var(--apc-chip, #ffffff); }
.apc-pets__dot[hidden] { display: none; }
.apc-pets__more { display: grid; place-items: center; min-width: 44px; min-height: 44px; padding: 0; margin: 0 0 0 -6px; border: 0; background: none; cursor: pointer; color: var(--apc-muted, #56627a); font: inherit; font-size: 12px; font-weight: 600; line-height: 1; }
.apc-pets__more[hidden] { display: none; }
.apc-pets__count { display: grid; place-items: center; min-width: 28px; height: 28px; padding: 0 6px; box-sizing: border-box; border-radius: 14px; border: 1px solid var(--apc-line, #d6dce5); background: var(--apc-chip, #ffffff); }
.apc-pets__popover { position: absolute; right: 0; top: 100%; z-index: 50; margin-top: 8px; width: 18rem; max-width: calc(100vw - 2rem); box-sizing: border-box; padding: 12px; border-radius: 12px; border: 1px solid var(--apc-line, #d6dce5);
  background: var(--apc-chip, #ffffff); color: var(--apc-ink, #141a24); box-shadow: 0 8px 24px rgb(0 0 0 / 0.18); font-size: 14px; text-align: left; }
.apc-pets__popover[hidden] { display: none; }
.apc-pets__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.apc-pets__name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apc-pets__doing, .apc-pets__pin { font-size: 12px; color: var(--apc-muted, #56627a); }
.apc-pets__pin[hidden], .apc-pets__open[hidden] { display: none; }
.apc-pets__open { padding: 0; border: 0; background: none; color: var(--apc-accent, #b85209); font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; min-height: 32px; }
.apc-pets__open:hover { text-decoration: underline; }
.apc-pets__close { position: absolute; right: 4px; top: 4px; width: 32px; height: 32px; padding: 0; border: 0; background: none; color: var(--apc-muted, #56627a); font-size: 18px; cursor: pointer; }
@media ${APC_MOBILE_MEDIA} {
  .apc-pets__pet + .apc-pets__pet { margin-left: 0; }
  .apc-pets__more { margin-left: 0; }
  .apc-pets__open, .apc-pets__close { min-height: 44px; min-width: 44px; }
}
`;

/** The popover's room from the viewport's edge, px. */
const EDGE = 8;

interface Row {
  li: HTMLElement;
  name: HTMLElement;
  doing: HTMLElement;
  open: HTMLButtonElement;
  note: HTMLElement;
}

/** Defines `<apc-pets>`. Only where custom elements exist (a browser), so importing this module in Node is safe. */
export function defineHeaderPets(tag = "apc-pets"): void {
  if (!globalThis.customElements || customElements.get(tag)) return;

  class ApcPets extends HTMLElement {
    private list: HeaderPet[] = [];
    private max = PET_MAX;
    private look: { scheme: PetScheme; tint: PetTint | null } = { scheme: "light", tint: null };
    private given: Partial<PetsStrings> | null = null;
    private words: PetsStrings = DEFAULT_PETS_STRINGS;
    private parts: { row: HTMLElement; more: HTMLButtonElement; count: HTMLElement; popover: HTMLElement; items: HTMLElement; close: HTMLButtonElement } | null = null;
    private pets = new Map<string, { button: HTMLButtonElement; dot: HTMLElement; pet: PetHandle; drawn: Pick<HeaderPet, "state" | "badge" | "name"> }>();
    private rows = new Map<string, Row>();

    get agents(): HeaderPet[] {
      return this.list;
    }
    set agents(next: HeaderPet[]) {
      this.list = next ?? [];
      this.render();
    }
    /** How many pets show before "+N" (default 3). */
    get limit(): number {
      return this.max;
    }
    set limit(next: number) {
      this.max = next;
      this.render();
    }
    /** "light" (default), "dark" or "auto": the pets follow the page (pet-scheme.ts). Also the `scheme` attribute. */
    get scheme(): PetScheme {
      return this.look.scheme;
    }
    set scheme(next: PetScheme) {
      this.look = { ...this.look, scheme: next ?? "light" };
      for (const p of this.pets.values()) p.pet.update({ scheme: this.look.scheme });
    }
    /** The app's colours for the pets' body and line (hex). */
    get tint(): PetTint | null {
      return this.look.tint;
    }
    set tint(next: PetTint | null) {
      this.look = { ...this.look, tint: next };
      for (const p of this.pets.values()) p.pet.update({ tint: next });
    }
    /** Every string it shows: the keys you set, over the English defaults. */
    get strings(): Partial<PetsStrings> | null {
      return this.given;
    }
    set strings(next: Partial<PetsStrings> | null) {
      this.given = next;
      this.words = resolveStrings(DEFAULT_PETS_STRINGS, next);
      this.render();
    }

    static observedAttributes = ["scheme"];
    attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
      if (name === "scheme") this.scheme = (value as PetScheme | null) ?? "light";
    }

    connectedCallback(): void {
      const own = this as unknown as Record<string, unknown>;
      for (const key of ["agents", "limit", "scheme", "tint", "strings"]) {
        if (!Object.hasOwn(own, key)) continue;
        const value = own[key];
        delete own[key];
        own[key] = value;
      }
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = HEADER_PETS_CSS;
        document.head.append(style);
      }
      if (!this.parts) {
        const row = document.createElement("div");
        row.className = "apc-pets__row";
        row.setAttribute("role", "group");
        const more = document.createElement("button");
        more.type = "button";
        more.className = "apc-pets__more";
        more.setAttribute("aria-haspopup", "dialog");
        const count = document.createElement("span");
        count.className = "apc-pets__count";
        more.append(count);
        more.addEventListener("click", () => this.toggle());
        const popover = document.createElement("div");
        popover.className = "apc-pets__popover";
        popover.setAttribute("role", "dialog");
        popover.hidden = true;
        const close = document.createElement("button");
        close.type = "button";
        close.className = "apc-pets__close";
        close.textContent = "×";
        close.addEventListener("click", () => this.close());
        const items = document.createElement("ul");
        items.className = "apc-pets__list";
        popover.append(close, items);
        this.parts = { row, more, count, popover, items, close };
        this.append(row, popover);
      }
      document.addEventListener("keydown", this.onKey);
      document.addEventListener("pointerdown", this.onOutside);
      this.render();
    }

    disconnectedCallback(): void {
      document.removeEventListener("keydown", this.onKey);
      document.removeEventListener("pointerdown", this.onOutside);
      for (const p of this.pets.values()) p.pet.destroy();
      this.pets.clear();
      this.parts?.row.replaceChildren();
    }

    private onKey = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape" && this.parts && !this.parts.popover.hidden) this.close();
    };
    private onOutside = (e: Event) => {
      const t = e.target as Node | null;
      if (this.parts && !this.parts.popover.hidden && t && !this.contains(t)) this.close(false);
    };

    /** Only the list button opens the popover; a pet is a mark, and its click or tap is pinning's. */
    private toggle(): void {
      if (!this.parts) return;
      if (!this.parts.popover.hidden) return this.close();
      const { popover } = this.parts;
      popover.style.right = "";
      popover.hidden = false;
      this.parts.more.setAttribute("aria-expanded", "true");
      // Near the left edge (a header that puts the pets on the left, on a phone), move it right into the viewport.
      const box = typeof popover.getBoundingClientRect === "function" ? popover.getBoundingClientRect() : null;
      if (box && box.left < EDGE) popover.style.right = `${box.left - EDGE}px`;
      this.parts.close.focus();
    }

    private close(refocus = true): void {
      if (!this.parts) return;
      this.parts.popover.hidden = true;
      this.parts.more.setAttribute("aria-expanded", "false");
      if (refocus && this.parts.more.isConnected) this.parts.more.focus();
    }

    private render(): void {
      if (!this.parts) return;
      const { row, more, count, popover, items, close } = this.parts;
      const w = this.words;
      const popoverId = (popover.id ||= `apc-pets-${Math.random().toString(36).slice(2, 10)}`);
      row.setAttribute("aria-label", w.group);
      popover.setAttribute("aria-label", w.group);
      close.setAttribute("aria-label", w.close);
      this.hidden = this.list.length === 0;

      const { shown, extra } = petLayout(this.list, this.max);
      const keep = new Set(shown.map((a) => a.id));
      for (const [id, p] of this.pets) {
        if (keep.has(id)) continue;
        p.pet.destroy();
        p.button.remove();
        this.pets.delete(id);
      }
      shown.forEach((a, i) => {
        let p = this.pets.get(a.id);
        const badge = a.badge ?? { color: colorFor(a.id) };
        if (!p) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "apc-pets__pet";
          button.setAttribute("data-apc-mark", "");
          const pet = createPet({ state: a.state, badge, label: a.name, phase: petPhase(a.id), decorative: true, scheme: this.look.scheme, tint: this.look.tint });
          const dot = document.createElement("span");
          dot.className = "apc-pets__dot";
          dot.setAttribute("aria-hidden", "true");
          button.append(pet.element, dot);
          p = { button, dot, pet, drawn: { state: a.state, badge: a.badge, name: a.name } };
          this.pets.set(a.id, p);
        } else if (p.drawn.state !== a.state || p.drawn.badge !== a.badge || p.drawn.name !== a.name) {
          // Only what changed is drawn again: an app sets `agents` on every presence event.
          p.pet.update({ state: a.state, badge, label: a.name });
          p.drawn = { state: a.state, badge: a.badge, name: a.name };
        }
        const { button, dot } = p;
        button.setAttribute("data-grant", a.id);
        button.title = w.markTitle(a.name);
        const offPage = !!a.pin && !a.pin.here;
        button.setAttribute("aria-label", w.markAria(a.name, offPage ? `${w.state(a.state)}. ${w.offPage}` : w.state(a.state)));
        button.style.zIndex = String(shown.length - i);
        dot.hidden = !offPage;
        // In order, before the list button.
        if (row.children[i] !== button) row.insertBefore(button, row.children[i] ?? null);
      });
      if (more.parentElement !== row) row.append(more);
      count.textContent = extra > 0 ? `+${extra}` : "▾";
      more.setAttribute("aria-label", extra > 0 ? w.moreAria(extra) : w.listAria);
      more.setAttribute("aria-controls", popoverId);
      more.setAttribute("aria-expanded", String(!popover.hidden));

      // The popover's rows, kept by agent and updated in place.
      const ids = new Set(this.list.map((a) => a.id));
      for (const [id, r] of this.rows) {
        if (ids.has(id)) continue;
        r.li.remove();
        this.rows.delete(id);
      }
      this.list.forEach((a, i) => {
        let r = this.rows.get(a.id);
        if (!r) {
          const li = document.createElement("li");
          const name = document.createElement("div");
          name.className = "apc-pets__name";
          const doing = document.createElement("div");
          doing.className = "apc-pets__doing";
          const open = document.createElement("button");
          open.type = "button";
          open.className = "apc-pets__open";
          open.addEventListener("click", (e) => {
            if (!(e as Event).isTrusted) return;
            this.close(false);
            this.dispatchEvent(new CustomEvent("apc-open", { detail: { id: a.id }, bubbles: true }));
          });
          const note = document.createElement("div");
          note.className = "apc-pets__pin";
          li.append(name, doing, open, note);
          r = { li, name, doing, open, note };
          this.rows.set(a.id, r);
        }
        setText(r.name, a.name);
        setText(r.doing, w.state(a.state));
        r.open.hidden = !a.pin;
        if (a.pin) setText(r.open, w.pinned(a.pin.label, a.pin.seen));
        r.note.hidden = !!a.pin?.here;
        setText(r.note, a.pin ? w.offPage : w.notPinned);
        if (items.children[i] !== r.li) items.insertBefore(r.li, items.children[i] ?? null);
      });
      if (this.list.length === 0 && !popover.hidden) this.close(false);
    }
  }

  customElements.define(tag, ApcPets);
}

/** Writes text only when it changed, so a node being read or pressed is left alone. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** `<apc-pets>`'s type, for apps that hold a reference to it. */
export interface ApcPetsElement extends HTMLElement {
  agents: HeaderPet[];
  /** How many pets show before "+N" (default 3). */
  limit: number;
  scheme: PetScheme;
  tint: PetTint | null;
  strings: Partial<PetsStrings> | null;
}
