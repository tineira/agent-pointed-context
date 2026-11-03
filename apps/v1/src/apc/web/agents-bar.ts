/**
 * The agent bar (TIN-394): the standard place, top right of every APC app, where the agents present
 * in this app show. Each agent is its mark (logo; name as tooltip) and its state; a dot says where it
 * points (click: go there), × removes the pin, ! warns of a shared URL. Dragging a mark onto a target
 * points the agent within the page: the marks carry data-apc-mark and data-grant, the hooks
 * enablePinning drags by.
 *
 * A custom element in light DOM, not shadow DOM: enablePinning finds marks by event target, and the
 * app's own fonts and theme apply. Its styles are injected once and scoped by class prefix; the app
 * themes it through --apc-* custom properties. Framework-agnostic: set `agents`, listen for events.
 */

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
}

/** Events, all with detail { id }: open (go to the pin), unpin, warning (open what the warning is about). */
export type AgentBarEvent = "apc-open" | "apc-unpin" | "apc-warning";

const STYLE_ID = "apc-agents-style";
const CSS = `
apc-agents { display: inline-flex; align-items: center; gap: 10px; }
.apc-agents__agent { position: relative; display: inline-flex; align-items: center; gap: 6px; }
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
@keyframes apc-agents-float { 0%, 100% { transform: translateY(1.5px); } 50% { transform: translateY(-2.5px); } }
@keyframes apc-agents-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.18); } }
@keyframes apc-agents-bounce { 0% { transform: translateY(0); } 25% { transform: translateY(-6px); } 50% { transform: translateY(0); } 70% { transform: translateY(-2px); } 100% { transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .apc-agents__mark img, .apc-agents__mark svg { animation: none !important; } }
`;

/** A small robot, for an agent with no icon. */
const BOT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 2h2v2.07A7 7 0 0 1 19 11v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a7 7 0 0 1 6-6.93V2Zm-2.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM2 12h2v5H2v-5Zm18 0h2v5h-2v-5Z"/></svg>';

/** The words a mark and its dot say, for tooltips and screen readers. Pure, so it is tested. */
export function agentLabels(a: BarAgent): { mark: string; dot: string | null } {
  const mark = `${a.name}${a.state === "off" ? " (not connected yet)" : ""}. Drag onto anything to point this agent.`;
  if (!a.pin) return { mark, dot: null };
  const read = a.pin.seen ? "your agent read it" : "waiting for your agent's next call";
  return { mark, dot: `Pinned to ${a.pin.label}: ${read}${a.pin.here ? "" : ". Click to open it."}` };
}

/** The element's constructor, defined only where custom elements exist (a browser), so importing this module in Node is safe. */
export function defineAgentBar(tag = "apc-agents"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;

  class ApcAgents extends HTMLElement {
    private list: BarAgent[] = [];
    private nodes = new Map<string, { root: HTMLElement; icon: HTMLElement; key: string }>();
    /** The app draws an agent's icon into this element itself (for example with its own logos). Called on every update. */
    renderIcon: ((agent: BarAgent, into: HTMLElement) => void) | null = null;

    get agents(): BarAgent[] {
      return this.list;
    }
    set agents(next: BarAgent[]) {
      this.list = next;
      this.render();
    }

    connectedCallback(): void {
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.append(style);
      }
      if (!this.hasAttribute("role")) this.setAttribute("role", "toolbar");
      if (!this.hasAttribute("aria-label")) this.setAttribute("aria-label", "Agents");
      this.render();
    }

    private emit(type: AgentBarEvent, id: string): void {
      this.dispatchEvent(new CustomEvent(type, { detail: { id }, bubbles: true }));
    }

    /** Keyed by agent: an agent's element (and the icon the app drew in it) lives as long as the agent. */
    private render(): void {
      if (!this.isConnected) return;
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
        this.append(node.root);
        this.fill(node, a);
      }
      for (const [id, node] of this.nodes) {
        if (seen.has(id)) continue;
        node.root.remove();
        this.nodes.delete(id);
      }
    }

    private fill(node: { root: HTMLElement; icon: HTMLElement; key: string }, a: BarAgent): void {
      const labels = agentLabels(a);
      const key = JSON.stringify([a.name, a.state, a.pin, a.warning, a.restricted, typeof a.icon === "string" ? a.icon.length : null]);
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
        dot.setAttribute("aria-label", `${a.name} pinned to ${a.pin.label}${a.pin.seen ? ", read" : ", not read yet"}`);
        dot.addEventListener("click", () => !a.pin?.here && this.emit("apc-open", a.id));
        const unpin = document.createElement("button");
        unpin.type = "button";
        unpin.className = "apc-agents__unpin";
        unpin.textContent = "×";
        unpin.setAttribute("aria-label", `Remove ${a.name}'s pin`);
        unpin.addEventListener("click", () => this.emit("apc-unpin", a.id));
        pin.append(dot, unpin);
        parts.push(pin);
      }
      node.root.replaceChildren(...parts);
    }
  }

  customElements.define(tag, ApcAgents);
}

/** The element's type, for apps that hold a reference to it. */
export interface ApcAgentsElement extends HTMLElement {
  agents: BarAgent[];
  renderIcon: ((agent: BarAgent, into: HTMLElement) => void) | null;
}
