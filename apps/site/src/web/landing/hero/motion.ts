/**
 * The hero's two pieces of motion, transforms and opacity only (TIN-1066):
 * - the focus message, which in reality goes underneath and nobody sees: it lifts off the pinned bar, floats to the
 *   agent window and fades to black as it crosses into it. Under reduced motion it appears by the agent window and goes,
 *   with no travel;
 * - the stage's own drag on load: a copy of the agent's mark (as enablePinning's drag shows one) carried by a pointer
 *   from the agent bar to a bar. The agent in the bar never moves and never fades.
 * Every value is set through the CSSOM or the Web Animations API: the site's policy allows no style attribute.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An element's box, relative to the stage. */
export function boxIn(stage: Element, el: Element): Box {
  const s = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
}

const at = (x: number, y: number, scale = 1) => `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale})`;

/** The stage clock's wait (clock.ts): paused while the tab is hidden, its timer cleared when `signal` aborts. */
export type Wait = (ms: number, signal?: AbortSignal) => Promise<void>;

/** An animation's end, or a time limit (frames alone are never waited on); the limit's timer is cleared either way. */
function settle(anim: Animation, ms: number, wait: Wait): Promise<void> {
  const limit = new AbortController();
  return Promise.race([anim.finished.then(() => undefined, () => undefined), wait(ms, limit.signal)]).finally(() => limit.abort());
}

/** The message's lines: the focus's kind, its params and its next call, as the agent receives them. */
export function messageLines(month: string): string[] {
  return ["{ \"kind\": \"figure\",", `  "params": { "month": "${month}", … },`, "  \"next\": \"get_figure\", … }"];
}

export const MESSAGE_MS = 2100;
export const STILL_MESSAGE_MS = 1100;

/**
 * Sends the focus message from a bar to the agent window. Resolves when it is gone. `cancel` (set on the returned
 * handle) removes it at once.
 */
export function sendMessage(o: { stage: HTMLElement; bar: Element; agent: Element; month: string; reduce: boolean; wait: Wait }): { done: Promise<void>; cancel: () => void } {
  const el = document.createElement("div");
  el.className = "hero-msg";
  el.setAttribute("aria-hidden", "true");
  const head = document.createElement("b");
  head.textContent = "focus";
  const body = document.createElement("span");
  body.textContent = messageLines(o.month).join("\n");
  const veil = document.createElement("i");
  veil.className = "hero-msg-veil";
  el.append(head, body, veil);
  o.stage.append(el);

  const bar = boxIn(o.stage, o.bar);
  const agent = boxIn(o.stage, o.agent);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const stacked = agent.y >= bar.y + bar.h; // on a phone the agent window sits under the app
  const from = { x: Math.max(4, Math.min(bar.x + bar.w / 2 - w / 2, o.stage.clientWidth - w - 4)), y: Math.max(4, bar.y - h - 18) };
  const to = stacked ? { x: agent.x + agent.w / 2 - w / 2, y: agent.y + 40 } : { x: agent.x + 28, y: agent.y + agent.h * 0.32 - h / 2 };
  let anims: Animation[] = [];
  // Ends the still message's wait too, so its timer goes with it.
  const still = new AbortController();
  const cancel = () => {
    still.abort();
    for (const a of anims) a.cancel();
    el.remove();
  };

  if (o.reduce || typeof el.animate !== "function") {
    // No travel: the message shows by the agent window, then goes.
    el.style.setProperty("transform", at(to.x, to.y));
    return { done: o.wait(STILL_MESSAGE_MS, still.signal).then(cancel), cancel };
  }
  const edge = stacked ? { x: (from.x + to.x) / 2, y: agent.y - h * 0.6 } : { x: agent.x - w * 0.55, y: (from.y + to.y) / 2 };
  const move = el.animate(
    [
      { transform: at(from.x, from.y + 28, 0.6), opacity: 0, offset: 0 },
      { transform: at(from.x, from.y), opacity: 1, offset: 0.18 },
      { transform: at(from.x, from.y), opacity: 1, offset: 0.32, easing: "cubic-bezier(0.5, 0, 0.5, 1)" },
      { transform: at(edge.x, edge.y), opacity: 1, offset: 0.7, easing: "linear" },
      { transform: at((edge.x + to.x) / 2, (edge.y + to.y) / 2, 0.96), opacity: 1, offset: 0.86, easing: "linear" },
      { transform: at(to.x, to.y, 0.9), opacity: 0, offset: 1 },
    ],
    { duration: MESSAGE_MS, fill: "forwards" },
  );
  // The fade to black: a black veil over the message, rising as it crosses into the agent window.
  const dark = veil.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.62 }, { opacity: 1, offset: 0.86 }, { opacity: 1, offset: 1 }], { duration: MESSAGE_MS, fill: "forwards" });
  anims = [move, dark];
  return { done: settle(move, MESSAGE_MS + 300, o.wait).then(cancel), cancel };
}

export const GHOST_MS = 1500;

/**
 * The stage's own drag: a copy of the agent's mark, with a pointer, from the mark to just above a bar. Resolves true
 * when it arrived, false when cancelled.
 */
export function carryMark(o: { stage: HTMLElement; mark: HTMLElement; bar: Element; wait: Wait }): { done: Promise<boolean>; cancel: () => void } {
  const ghost = o.mark.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("data-apc-mark");
  ghost.removeAttribute("data-grant");
  ghost.removeAttribute("id");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("tabindex", "-1");
  ghost.classList.add("hero-ghost");
  const pointer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  pointer.setAttribute("class", "hero-ghost-pointer");
  pointer.setAttribute("viewBox", "0 0 18 18");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 1l13 7-5.5 1.6L7.8 15z");
  pointer.append(path);
  ghost.append(pointer);
  o.stage.append(ghost);

  const mark = boxIn(o.stage, o.mark);
  const bar = boxIn(o.stage, o.bar);
  const from = { x: mark.x, y: mark.y };
  const to = { x: bar.x + bar.w / 2 - mark.w / 2, y: bar.y + Math.min(24, bar.h / 3) };
  const ctrl = { x: from.x - 30, y: Math.min(from.y, to.y) - 70 };
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    frames.push({ transform: at(u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x, u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y, i === 0 ? 1 : 1.12), offset: t });
  }
  let cancelled = false;
  const anim = typeof ghost.animate === "function" ? ghost.animate(frames, { duration: GHOST_MS, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" }) : null;
  const cancel = () => {
    cancelled = true;
    anim?.cancel();
    ghost.remove();
  };
  const done = (anim ? settle(anim, GHOST_MS + 300, o.wait) : Promise.resolve()).then(() => {
    const arrived = !cancelled;
    ghost.remove();
    return arrived;
  });
  return { done, cancel };
}
