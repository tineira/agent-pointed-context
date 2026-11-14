/**
 * The handoff card (TIN-901): what an APC app on the Dock profile shows from the person's Allow until their
 * dock has the pairing code. The code is the one thing the person carries to the other window, so it is its
 * own block (large, monospaced, with a copy button), with the time left, a warning under it, and Cancel.
 * The app shows it in the place its consent was, so the Allow turns the question into the answer.
 *
 * It follows the app's stored expiry (APC 0.10 § 4): the countdown stops at zero and the code goes, and the
 * card says the dock did not finish in time. It offers no "New code": a new code needs a new consent.
 *
 * `handoffView` is the card's words and numbers, pure (so it is tested); `<apc-handoff>` draws them in light
 * DOM, like the other elements here: styles injected once, scoped by class prefix, themed through --apc-*.
 * Set `host`, then `pairing` (the code, raw, and the app's stored expiry), or `message` once the pairing
 * ended; listen for `apc-cancel`. Pulse and Signals wrap it in React.
 */
import { formatPairingCode } from "@tineira/apc-protocol";
import { DEFAULT_HANDOFF_STRINGS, resolveStrings, type HandoffStrings } from "./strings.ts";

/** The code and the app's stored expiry (an ISO time, as the app's state carries it). */
export interface HandoffPairing {
  code: string;
  expires_at: string;
}

/** Event, no detail: the person pressed Cancel (or Close, once the pairing ended). */
export type HandoffEvent = "apc-cancel";

/** What the card shows: the code to type, the dock connecting, the code run out, or an ended pairing. */
export type HandoffPhase = "code" | "connecting" | "expired" | "ended";

export interface HandoffView {
  phase: HandoffPhase;
  title: string;
  /** The code as shown (`K7M-4P2`), only in the `code` phase, and only while there is time left. */
  code: string | null;
  /** Seconds left, never below zero. */
  left: number;
  /** `m:ss`. */
  clock: string;
  /** The lines under the title, in order. */
  lines: string[];
  /** The button: Cancel takes the access back, Close only dismisses an ended pairing. */
  button: string;
}

/** `m:ss`, for a number of seconds; below zero is zero. */
export function handoffClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * What the card shows now. The app's stored expiry is the truth: past it the code is not shown, whatever else
 * the card knows. `message` (why it ended: a refusal, or a timeout) wins over everything and has no code.
 * `pairing` null with no message is the dock connecting: it took the code, so there is none to show.
 */
export function handoffView(
  input: { host: string; pairing: HandoffPairing | null; message?: string | null; now: number },
  given?: Partial<HandoffStrings> | null,
): HandoffView {
  const w = resolveStrings(DEFAULT_HANDOFF_STRINGS, given);
  const none = { code: null, left: 0, clock: handoffClock(0) };
  if (input.message) return { phase: "ended", title: w.endedTitle, ...none, lines: [input.message, w.dropAgain], button: w.close };
  if (!input.pairing) return { phase: "connecting", title: w.connectingTitle(input.host), ...none, lines: [w.connecting], button: w.cancel };
  const expires = Date.parse(input.pairing.expires_at);
  const left = Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - input.now) / 1000)) : 0;
  if (left <= 0) return { phase: "expired", title: w.endedTitle, ...none, lines: [w.expired(input.host), w.dropAgain], button: w.cancel };
  return {
    phase: "code",
    title: w.waitingTitle(input.host),
    code: formatPairingCode(input.pairing.code),
    left,
    clock: handoffClock(left),
    lines: [w.typeItOnlyInYourDock, w.notYours],
    button: w.cancel,
  };
}

const STYLE_ID = "apc-handoff-style";
const CSS = `
apc-handoff { display: block; color: var(--apc-ink, inherit); }
.apc-handoff { display: flex; flex-direction: column; gap: 10px; }
.apc-handoff__title { margin: 0; font-weight: 600; }
.apc-handoff__code-block { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 12px; border: 1px solid var(--apc-line, #d6dce5); border-radius: 12px; background: var(--apc-chip, transparent); }
.apc-handoff__label { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.08em; color: var(--apc-muted, #5b6575); }
.apc-handoff__code { font: 700 2.4em/1.1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.12em; white-space: nowrap; user-select: all; }
.apc-handoff__copy, .apc-handoff__cancel { padding: 5px 12px; border: 1px solid var(--apc-line, #d6dce5); border-radius: 8px; background: var(--apc-chip, transparent); color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.apc-handoff__copy:hover, .apc-handoff__cancel:hover { border-color: var(--apc-accent, #b85209); }
.apc-handoff__clock { margin: 0; color: var(--apc-muted, #5b6575); font-size: 0.9em; }
.apc-handoff__clock b { font-variant-numeric: tabular-nums; color: var(--apc-ink, inherit); }
.apc-handoff__line { margin: 0; color: var(--apc-muted, #5b6575); font-size: 0.9em; }
.apc-handoff__actions { display: flex; gap: 8px; }
`;

/** The element's type: `host`, `pairing` (null: the dock took the code), `message` (set once the pairing ended), `strings`. */
export interface ApcHandoffElement extends HTMLElement {
  host: string;
  pairing: HandoffPairing | null;
  message: string | null;
  strings: Partial<HandoffStrings> | null;
}

/** Defines `<apc-handoff>` where custom elements exist (a browser), so importing this module in Node is safe. */
export function defineHandoff(tag = "apc-handoff"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;

  class ApcHandoff extends HTMLElement {
    private hostName = "";
    private pair: HandoffPairing | null = null;
    private note: string | null = null;
    private given: Partial<HandoffStrings> | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private shown = "";
    private clockEl: HTMLElement | null = null;

    get host(): string {
      return this.hostName;
    }
    set host(next: string) {
      this.hostName = next;
      this.render();
    }
    get pairing(): HandoffPairing | null {
      return this.pair;
    }
    set pairing(next: HandoffPairing | null) {
      this.pair = next;
      this.render();
    }
    get message(): string | null {
      return this.note;
    }
    set message(next: string | null) {
      this.note = next;
      this.render();
    }
    /** Every string the card shows (TIN-668): the keys you set, over the English defaults. */
    get strings(): Partial<HandoffStrings> | null {
      return this.given;
    }
    set strings(next: Partial<HandoffStrings> | null) {
      this.given = next;
      this.shown = "";
      this.render();
    }

    connectedCallback(): void {
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.append(style);
      }
      this.timer ??= setInterval(() => this.render(), 1000);
      this.render();
    }

    disconnectedCallback(): void {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.shown = "";
    }

    private render(): void {
      if (!this.isConnected) return;
      const view = handoffView({ host: this.hostName, pairing: this.pair, message: this.note, now: Date.now() }, this.given);
      const w = resolveStrings(DEFAULT_HANDOFF_STRINGS, this.given);
      // Each second only the clock changes: the card is redrawn when what it says does.
      const key = JSON.stringify([view.phase, view.title, view.code, view.lines, view.button]);
      if (key === this.shown) {
        if (this.clockEl) this.clockEl.textContent = view.clock;
        return;
      }
      this.shown = key;
      this.clockEl = null;
      const card = document.createElement("div");
      card.className = "apc-handoff";
      card.setAttribute("role", "group");
      card.setAttribute("aria-label", view.title);
      const title = document.createElement("p");
      title.className = "apc-handoff__title";
      title.textContent = view.title;
      card.append(title);
      if (view.code) {
        const block = document.createElement("div");
        block.className = "apc-handoff__code-block";
        const label = document.createElement("span");
        label.className = "apc-handoff__label";
        label.textContent = w.codeLabel;
        const code = document.createElement("span");
        code.className = "apc-handoff__code";
        code.textContent = view.code;
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "apc-handoff__copy";
        copy.textContent = w.copy;
        const shownCode = view.code;
        copy.addEventListener("click", () => {
          void navigator.clipboard?.writeText(shownCode).then(
            () => {
              copy.textContent = w.copied;
              setTimeout(() => (copy.textContent = w.copy), 1500);
            },
            () => undefined,
          );
        });
        block.append(label, code, copy);
        const clock = document.createElement("p");
        clock.className = "apc-handoff__clock";
        // "Works once. Expires in <b>m:ss</b>.": the clock is the part that changes.
        const [before = "", after = ""] = w.expiresIn("\u0000").split("\u0000");
        const time = document.createElement("b");
        time.textContent = view.clock;
        clock.append(before, time, after);
        this.clockEl = time;
        card.append(block, clock);
      }
      for (const line of view.lines) {
        const p = document.createElement("p");
        p.className = "apc-handoff__line";
        p.textContent = line;
        card.append(p);
      }
      const actions = document.createElement("div");
      actions.className = "apc-handoff__actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "apc-handoff__cancel";
      cancel.textContent = view.button;
      cancel.addEventListener("click", () => this.dispatchEvent(new CustomEvent("apc-cancel", { bubbles: true })));
      actions.append(cancel);
      card.append(actions);
      this.replaceChildren(card);
    }
  }
  customElements.define(tag, ApcHandoff);
}
