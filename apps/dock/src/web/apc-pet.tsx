/**
 * The APC pet (TIN-483): one animated character for every agent, a soft blob with two eyes drawn in
 * SVG, with the agent's logo (the PNG badge the dock draws, TIN-388) on a white disc at its bottom
 * right. The Windows pets, the web Float and the dock's tiles all draw this one component. The
 * character is APC's own: no vendor's mascot is drawn or animated, only the official logo as a badge.
 *
 * Motion: pet-pose.ts says what each state looks like; this file draws a frame into the SVG with no
 * React render per frame. One requestAnimationFrame loop per window drives every pet in it (Float's
 * Picture-in-Picture window is a window of its own, so its pets run on its requestAnimationFrame). The
 * loop stops while the window is hidden and slows down once every pet has kept its state for a while.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { brandFor } from "../../../demo/src/web/agent-brands.ts";
import type { DockAgent } from "./agent-page.tsx";
import { GEOM, PetSim, type Frame } from "./pet-pose.ts";
import { pinPhase, petState, watchRead, type PetState, type ReadWatch } from "./pet-state.ts";

interface Sub {
  tick(t: number, dt: number): void;
  calm(t: number): boolean;
}

/** Once every pet in a window has kept its state for a while (PetSim.calm), the loop draws 20 frames a second instead of 60. */
const SLOW_MS = 50;

/** The loop of one window: every pet in it, one frame callback. */
class Loop {
  private subs = new Set<Sub>();
  private handle: number | null = null;
  private slow = false;
  private last = 0;
  private win: Window;
  constructor(win: Window) {
    this.win = win;
    win.document.addEventListener("visibilitychange", () => (this.hidden() ? this.halt() : this.go()));
  }
  private hidden = () => this.win.document.visibilityState === "hidden";
  add(sub: Sub): () => void {
    this.subs.add(sub);
    this.go();
    return () => {
      this.subs.delete(sub);
      if (!this.subs.size) this.halt();
    };
  }
  private halt() {
    if (this.handle === null) return;
    this.slow ? this.win.clearTimeout(this.handle) : this.win.cancelAnimationFrame(this.handle);
    this.handle = null;
  }
  private go() {
    if (this.handle !== null || !this.subs.size || this.hidden()) return;
    this.last = this.win.performance.now();
    this.schedule();
  }
  private schedule() {
    const frame = (ms: number) => {
      this.handle = null;
      const t = ms / 1000;
      const dt = Math.min(0.1, Math.max(0, t - this.last / 1000));
      this.last = ms;
      let calm = true;
      for (const s of this.subs) {
        s.tick(t, dt);
        calm &&= s.calm(t);
      }
      this.slow = calm;
      if (this.subs.size && !this.hidden()) this.schedule();
    };
    this.handle = this.slow ? this.win.setTimeout(() => frame(this.win.performance.now()), SLOW_MS) : this.win.requestAnimationFrame(frame);
  }
}

const loops = new WeakMap<Window, Loop>();
const loopOf = (win: Window) => {
  let l = loops.get(win);
  if (!l) loops.set(win, (l = new Loop(win)));
  return l;
};

const BODY_DARK = "#23262f";

const STATE_WORDS: Record<PetState, string> = {
  idle: "connected",
  waiting: "waiting for you to point",
  calling: "calling tools",
  pinned: "pointed at something, not read yet",
  read: "read what you pointed at",
  pairing: "a pairing request waits for you",
  dragging: "being dragged",
  offline: "not connected",
};

/** Writes a frame into the SVG's parts (found by data-k). */
function paint(parts: Record<string, Element>, f: Frame): void {
  const set = (k: string, attrs: Record<string, string | number>) => {
    const el = parts[k];
    if (el) for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, String(v));
  };
  set("group", { transform: `translate(0 ${f.bob.toFixed(2)}) rotate(${f.tilt.toFixed(2)})` });
  set("body", { d: f.body, fill: f.fill });
  set("shine", { d: f.shine });
  for (const [k, e] of [["left", f.left], ["right", f.right]] as const) set(k, { x: (e.x - e.w / 2).toFixed(2), y: (e.y - e.h / 2).toFixed(2), width: e.w, height: e.h.toFixed(2), rx: e.rx.toFixed(2), opacity: e.opacity.toFixed(3) });
  set("wink", { d: f.wink.d, opacity: f.wink.opacity.toFixed(3) });
  set("ring", { opacity: f.ring.opacity.toFixed(3), "stroke-dashoffset": f.ring.offset.toFixed(2), r: f.ring.r.toFixed(2) });
  set("bang", { opacity: f.bang.opacity.toFixed(3), transform: `translate(0 ${(f.bang.y + GEOM.bang.y).toFixed(2)}) scale(${f.bang.scale.toFixed(3)})` });
  set("check", { opacity: f.check.opacity.toFixed(3), transform: `translate(${GEOM.check.x} ${GEOM.check.y}) scale(${f.check.scale.toFixed(3)})` });
  f.orbit.forEach((o, i) => set(`orbit${i}`, { cx: o.cx.toFixed(2), cy: o.cy.toFixed(2), opacity: o.opacity.toFixed(3) }));
  f.zz.forEach((z, i) => set(`zz${i}`, { x: z.x.toFixed(2), y: z.y.toFixed(2), opacity: z.opacity.toFixed(3) }));
  set("badge", { opacity: f.badgeOpacity.toFixed(3) });
}

/**
 * The character in a given state, `size` px square; `badge` is the agent's logo as a PNG data URI
 * (none: no badge). `phase` offsets its clock, so pets side by side do not breathe in step.
 */
export function ApcPet(props: { state: PetState; badge: string | null; label: string; size: number; phase?: number; /** The name is written next to it: hide it from screen readers. */ decorative?: boolean }) {
  const uid = useId().replace(/\W/g, "");
  const svg = useRef<SVGSVGElement>(null);
  const state = useRef(props.state);
  state.current = props.state;
  const refresh = useRef<() => void>(() => {});
  // A layout effect, so the first frame is drawn before the browser paints (no blank frame).
  useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? window;
    const parts: Record<string, Element> = {};
    el.querySelectorAll("[data-k]").forEach((n) => (parts[n.getAttribute("data-k")!] = n));
    const sim = new PetSim();
    const phase = props.phase ?? 0;
    const reduced = win.matchMedia("(prefers-reduced-motion: reduce)");
    let stop = () => {};
    if (!reduced.matches) paint(parts, sim.snap(state.current, phase));
    const run = () => {
      stop();
      stop = () => {};
      if (reduced.matches) paint(parts, sim.still(state.current));
      else
        stop = loopOf(win).add({
          tick: (t, dt) => paint(parts, sim.step(state.current, t + phase, dt)),
          calm: (t) => sim.calm(t + phase),
        });
    };
    refresh.current = () => reduced.matches && paint(parts, sim.still(state.current));
    run();
    reduced.addEventListener("change", run);
    return () => {
      reduced.removeEventListener("change", run);
      stop();
      refresh.current = () => {};
    };
  }, []);
  useEffect(() => {
    refresh.current();
  }, [props.state]);
  const id = (s: string) => `${s}-${uid}`;
  return (
    <svg ref={svg} className="apc-pet" width={props.size} height={props.size} viewBox="-100 -110 200 200" {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": `${props.label}, ${STATE_WORDS[props.state]}` })}>
      <defs>
        <radialGradient id={id("shine")} cx="35%" cy="28%" r="60%">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={id("logo")}>
          <circle r="15.5" />
        </clipPath>
      </defs>
      <g data-k="group">
        <circle data-k="ring" r="78" fill="none" stroke="#f08a3e" strokeWidth="3.5" strokeDasharray="9 7" strokeLinecap="round" opacity="0" />
        <path data-k="body" d="" fill={BODY_DARK} stroke="#fff" strokeWidth="2.5" />
        <path data-k="shine" d="" fill={`url(#${id("shine")})`} />
        <rect data-k="left" fill="#fff" />
        <rect data-k="right" fill="#fff" />
        <path data-k="wink" d="" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity="0" />
        <g data-k="badge" transform="translate(40 38)">
          {props.badge && (
            <>
              <circle r="19" fill="#fff" />
              <image href={props.badge} x="-15.5" y="-15.5" width="31" height="31" clipPath={`url(#${id("logo")})`} />
            </>
          )}
        </g>
        <g data-k="bang" opacity="0" fill="#f08a3e" stroke="#fff" strokeWidth="5" paintOrder="stroke">
          <rect x="-3.6" y="-22.5" width="7.2" height="14" rx="3.6" />
          <circle r="4.2" />
        </g>
        {[0, 1, 2].map((i) => (
          <circle key={i} data-k={`orbit${i}`} r="4.5" fill="#fff" stroke={BODY_DARK} strokeWidth="1.5" opacity="0" />
        ))}
      </g>
      <g data-k="check" opacity="0" transform={`translate(${GEOM.check.x} ${GEOM.check.y})`}>
        <circle r="11" fill="#157a3a" stroke="#fff" strokeWidth="2.5" />
        <path d="M-5 0 L-1.5 4 L5.5 -4" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {[0, 1].map((i) => (
        <text key={i} data-k={`zz${i}`} fontSize={GEOM.zz[i]!.fs} fontWeight="700" fontFamily="system-ui, sans-serif" fill="#8a96a8" stroke="#fff" strokeWidth="1.5" paintOrder="stroke" opacity="0">
          z
        </text>
      ))}
    </svg>
  );
}

/**
 * An agent's pet: the character in the state the hub's data gives it. `dragging` is local to the
 * page (the person holds the pet). The pin the agent just read shows as "read" for a few seconds.
 */
export function AgentPet(props: { agent: DockAgent; size: number; dragging?: boolean; decorative?: boolean }) {
  const a = props.agent;
  const focus = a.focus ? { pinned_at: a.focus.pinned_at, seen: a.focus.seen } : null;
  const watch = useRef<ReadWatch | null | undefined>(undefined);
  const now = Date.now();
  watch.current = watchRead(watch.current, focus, now);
  const [, tick] = useState(0);
  const until = watch.current?.seen ? watch.current.until : 0;
  useEffect(() => {
    if (until <= Date.now()) return;
    const h = setTimeout(() => tick((n) => n + 1), until - Date.now() + 20);
    return () => clearTimeout(h);
  }, [until]);
  const state = petState({
    connected: !!a.client_name,
    waiting: a.waiting,
    busy: a.busy,
    pin: pinPhase(watch.current, now),
    requests: a.pairings.filter((p) => p.status === "pending").length,
    dragging: !!props.dragging,
  });
  const phase = [...a.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7) / 100;
  // The hub's badge once it has one; before, the logo the client sent or the curated raster logo (an SVG-only brand waits for the hub's PNG).
  const logo = brandFor(a.client_name, a.client_ua)?.logo;
  const badge = a.badge ?? a.client_icon ?? (logo && "image" in logo ? logo.image : null);
  return <ApcPet state={state} badge={badge} label={a.name} size={props.size} phase={phase} decorative={props.decorative} />;
}
