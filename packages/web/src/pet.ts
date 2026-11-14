/**
 * The agent's pet (TIN-483, TIN-878): how an app shows an agent inside its page. One animated character
 * for every agent, a soft blob with two eyes drawn in SVG, with the agent's logo as a badge on a white
 * disc at its bottom right. The character is APC's own: no vendor's mascot is drawn or animated, only
 * the brand's logo as a badge (TIN-388).
 *
 * Motion: pet-pose.ts says what each state looks like; this file draws a frame into the SVG, with no
 * framework render per frame. One requestAnimationFrame loop per window drives every pet in it (a
 * Picture-in-Picture window is a window of its own). The loop stops while the page is hidden and slows to
 * 20 frames a second once every pet has kept its state for a while. With `prefers-reduced-motion` a pet
 * is a still pose. Colours follow the page's scheme (pet-scheme.ts).
 *
 * Framework-light: `createPet` returns the SVG and a handle (React, Vue or none wrap it), and
 * `definePet()` defines `<apc-pet>`. The dock draws its pets with `createPet` too.
 */
import { type ApcLogo, type PetBadge } from "./brands.ts";
import { GEOM, PetSim, type Frame } from "./pet-pose.ts";
import { petFill, petPalette, resolvePetScheme, type PetPalette, type PetScheme, type PetTint } from "./pet-scheme.ts";
import type { PetState } from "./pet-state.ts";
import { DEFAULT_PETS_STRINGS } from "./strings.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Sub {
  tick(t: number, dt: number): void;
  calm(t: number): boolean;
}

/** Once every pet in a window has kept its state for a while (PetSim.calm), the loop draws 20 frames a second instead of 60. */
export const PET_SLOW_MS = 50;

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
    if (this.slow) this.win.clearTimeout(this.handle);
    else this.win.cancelAnimationFrame(this.handle);
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
    this.handle = this.slow ? this.win.setTimeout(() => frame(this.win.performance.now()), PET_SLOW_MS) : this.win.requestAnimationFrame(frame);
  }
}

const loops = new WeakMap<Window, Loop>();
const loopOf = (win: Window) => {
  let l = loops.get(win);
  if (!l) loops.set(win, (l = new Loop(win)));
  return l;
};

/** Writes a frame into the SVG's parts (found by data-k). */
function paint(parts: Record<string, Element>, f: Frame, palette: PetPalette): void {
  const set = (k: string, attrs: Record<string, string | number>) => {
    const el = parts[k];
    if (el) for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, String(v));
  };
  set("group", { transform: `translate(0 ${f.bob.toFixed(2)}) rotate(${f.tilt.toFixed(2)})` });
  set("body", { d: f.body, fill: petFill(palette, f.grey) });
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

type Attrs = Record<string, string | number>;
function svgEl(doc: Document, tag: string, attrs: Attrs = {}, ...children: Element[]): Element {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.appendChild(c);
  return el;
}

/**
 * A badge's drawing, centred on (0, 0), on a white disc of radius 19: a logo (vector, or an image clipped
 * to a circle by `clipId`), or the neutral mark (a disc in the agent's colour with two eyes). `outline`
 * rings the white disc (the dark pet). Shared with the pin badge.
 */
export function drawBadge(doc: Document, badge: PetBadge, clipId: string, outline: string | null = null): Element[] {
  const disc = svgEl(doc, "circle", { r: 19, fill: "#fff", ...(outline ? { stroke: outline, "stroke-width": 1.5 } : {}) });
  if ("color" in badge) {
    return [disc, svgEl(doc, "circle", { r: 15.5, fill: badge.color }), svgEl(doc, "circle", { cx: -5.5, cy: -1, r: 2.6, fill: "#fff" }), svgEl(doc, "circle", { cx: 5.5, cy: -1, r: 2.6, fill: "#fff" })];
  }
  if ("image" in badge) return [disc, svgEl(doc, "image", { href: badge.image, x: -15.5, y: -15.5, width: 31, height: 31, "clip-path": `url(#${clipId})` })];
  return [disc, logoSvg(doc, badge, 24)];
}

/** A vector logo, `size` units square, centred on (0, 0). */
function logoSvg(doc: Document, logo: Extract<ApcLogo, { parts: unknown }>, size: number): Element {
  return svgEl(
    doc,
    "svg",
    { x: -size / 2, y: -size / 2, width: size, height: size, viewBox: logo.viewBox, overflow: "visible" },
    ...logo.parts.map((p) => svgEl(doc, "path", { d: p.d, fill: p.fill ?? "#111", ...(p.evenodd ? { "fill-rule": "evenodd", "clip-rule": "evenodd" } : {}) })),
  );
}

let uid = 0;

export interface PetOptions {
  state: PetState;
  /** The agent's badge (`agentBadge` in brands.ts); none: no badge. */
  badge?: PetBadge | null;
  /** The agent's name, for screen readers. */
  label: string;
  /** Pixels square. Left out, the pet is `--apc-pet-size` (default: as big as its parent makes it). */
  size?: number | null;
  /** Offsets the pet's clock (seconds), so pets side by side do not breathe in step: `petPhase(id)`. */
  phase?: number;
  /** The name is written next to it: hidden from screen readers. */
  decorative?: boolean;
  /** "light" (the default), "dark", or "auto" (follows `prefers-color-scheme`). */
  scheme?: PetScheme;
  /** The app's own body and line colours (hex). The custom properties `--apc-pet-body` and `--apc-pet-line` do the same; this wins. */
  tint?: PetTint | null;
  /** What a state says to a screen reader (localize it); default DEFAULT_PETS_STRINGS.state. */
  words?: ((state: PetState) => string) | null;
}

export interface PetHandle {
  /** The pet's SVG (class "apc-pet"): put it in the page. */
  readonly element: SVGSVGElement;
  /** Change what the pet shows: its state, badge, scheme, tint, label, size. */
  update(next: Partial<PetOptions>): void;
  /** Stop its motion and listeners (it stays where it is; remove it yourself). */
  destroy(): void;
}

/** A stable clock offset from an agent's id, so pets side by side do not breathe in step. */
export function petPhase(id: string): number {
  return [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7) / 100;
}

/** The custom properties an app tints the pet with, read from the page around the pet. */
function cssTint(el: Element, win: Window): PetTint | null {
  if (!el.isConnected || typeof win.getComputedStyle !== "function") return null;
  const css = win.getComputedStyle(el);
  return { body: css.getPropertyValue("--apc-pet-body"), line: css.getPropertyValue("--apc-pet-line") };
}

/** The pet: its SVG, drawn now (the first frame before the browser paints), and its handle. */
export function createPet(options: PetOptions, doc: Document = document): PetHandle {
  let opts: PetOptions = { ...options };
  const win = (doc.defaultView ?? globalThis.window) as Window;
  const n = ++uid;
  const id = (s: string) => `apc-pet-${s}-${n}`;
  const parts: Record<string, Element> = {};
  const k = (key: string, el: Element) => (el.setAttribute("data-k", key), (parts[key] = el), el);

  const stops = [svgEl(doc, "stop", { offset: 0 }), svgEl(doc, "stop", { offset: 1 })];
  const defs = svgEl(doc, "defs", {}, svgEl(doc, "radialGradient", { id: id("shine"), cx: "35%", cy: "28%", r: "60%" }, ...stops), svgEl(doc, "clipPath", { id: id("logo") }, svgEl(doc, "circle", { r: 15.5 })));
  const badge = k("badge", svgEl(doc, "g", { transform: "translate(40 38)" }));
  const group = k(
    "group",
    svgEl(
      doc,
      "g",
      {},
      k("ring", svgEl(doc, "circle", { r: 78, fill: "none", stroke: "#f08a3e", "stroke-width": 3.5, "stroke-dasharray": "9 7", "stroke-linecap": "round", opacity: 0 })),
      k("body", svgEl(doc, "path", { d: "", "stroke-width": 2.5 })),
      k("shine", svgEl(doc, "path", { d: "", fill: `url(#${id("shine")})` })),
      k("left", svgEl(doc, "rect")),
      k("right", svgEl(doc, "rect")),
      k("wink", svgEl(doc, "path", { d: "", fill: "none", "stroke-width": 5, "stroke-linecap": "round", opacity: 0 })),
      badge,
      k("bang", svgEl(doc, "g", { opacity: 0, fill: "#f08a3e", stroke: "#fff", "stroke-width": 5, "paint-order": "stroke" }, svgEl(doc, "rect", { x: -3.6, y: -22.5, width: 7.2, height: 14, rx: 3.6 }), svgEl(doc, "circle", { r: 4.2 }))),
      ...[0, 1, 2].map((i) => k(`orbit${i}`, svgEl(doc, "circle", { r: 4.5, fill: "#fff", stroke: "#23262f", "stroke-width": 1.5, opacity: 0 }))),
    ),
  );
  const check = k(
    "check",
    svgEl(
      doc,
      "g",
      { opacity: 0, transform: `translate(${GEOM.check.x} ${GEOM.check.y})` },
      svgEl(doc, "circle", { r: 11, fill: "#157a3a", stroke: "#fff", "stroke-width": 2.5 }),
      svgEl(doc, "path", { d: "M-5 0 L-1.5 4 L5.5 -4", fill: "none", stroke: "#fff", "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }),
    ),
  );
  const zz = [0, 1].map((i) => {
    const t = svgEl(doc, "text", { "font-size": GEOM.zz[i]!.fs, "font-weight": 700, "font-family": "system-ui, sans-serif", fill: "#8a96a8", stroke: "#fff", "stroke-width": 1.5, "paint-order": "stroke", opacity: 0 });
    t.textContent = "z";
    return k(`zz${i}`, t);
  });
  const svg = svgEl(doc, "svg", { class: "apc-pet", viewBox: "-100 -110 200 200" }, defs, group, check, ...zz) as SVGSVGElement;

  const sim = new PetSim();
  const reduced = win.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  const dark = win.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const still = () => !!reduced?.matches;
  let palette = petPalette("light");
  let badgeKey = "";

  /** The pieces that do not move: the size, the words, the colours and the badge. */
  const dress = () => {
    if (opts.size) {
      svg.setAttribute("width", String(opts.size));
      svg.setAttribute("height", String(opts.size));
      svg.removeAttribute("style");
    } else {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.setAttribute("style", "width: var(--apc-pet-size, 100%); height: var(--apc-pet-size, 100%)");
    }
    if (opts.decorative) {
      svg.setAttribute("aria-hidden", "true");
      svg.removeAttribute("role");
      svg.removeAttribute("aria-label");
    } else {
      svg.removeAttribute("aria-hidden");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `${opts.label}, ${(opts.words ?? DEFAULT_PETS_STRINGS.state)(opts.state)}`);
    }
    const scheme = resolvePetScheme(opts.scheme ?? "light", !!dark?.matches);
    palette = petPalette(scheme, { ...cssTintOrNull(), ...definedTint(opts.tint) });
    stops[0]!.setAttribute("stop-color", palette.shineFrom.color);
    stops[0]!.setAttribute("stop-opacity", String(palette.shineFrom.opacity));
    stops[1]!.setAttribute("stop-color", palette.shineTo.color);
    stops[1]!.setAttribute("stop-opacity", String(palette.shineTo.opacity));
    parts.body!.setAttribute("stroke", palette.line);
    for (const e of ["left", "right"]) parts[e]!.setAttribute("fill", palette.line);
    parts.wink!.setAttribute("stroke", palette.line);
    const key = JSON.stringify([opts.badge ?? null, palette.badgeOutline]);
    if (key !== badgeKey) {
      badgeKey = key;
      while (badge.firstChild) badge.removeChild(badge.firstChild);
      if (opts.badge) for (const el of drawBadge(doc, opts.badge, id("logo"), palette.badgeOutline)) badge.appendChild(el);
    }
  };
  const cssTintOrNull = (): PetTint => {
    const t = cssTint(svg, win);
    return { ...(t?.body?.trim() ? { body: t.body } : {}), ...(t?.line?.trim() ? { line: t.line } : {}) };
  };

  const phase = () => opts.phase ?? 0;
  let stop = () => {};
  const run = () => {
    stop();
    stop = () => {};
    if (still()) paint(parts, sim.still(opts.state), palette);
    else
      stop = loopOf(win).add({
        tick: (t, dt) => paint(parts, sim.step(opts.state, t + phase(), dt), palette),
        calm: (t) => sim.calm(t + phase()),
      });
  };
  const restyle = () => {
    dress();
    if (still()) paint(parts, sim.still(opts.state), palette);
  };
  dress();
  // The first frame now, before the browser paints (no blank frame).
  if (!still()) paint(parts, sim.snap(opts.state, phase()), palette);
  run();
  reduced?.addEventListener?.("change", run);
  dark?.addEventListener?.("change", restyle);
  // Once the app has put the pet in the page, its custom properties can be read.
  let live = true;
  queueMicrotask(() => live && restyle());

  return {
    element: svg,
    update(next) {
      opts = { ...opts, ...next };
      restyle();
    },
    destroy() {
      live = false;
      reduced?.removeEventListener?.("change", run);
      dark?.removeEventListener?.("change", restyle);
      stop();
      stop = () => {};
    },
  };
}

const definedTint = (t: PetTint | null | undefined): PetTint => ({ ...(t?.body ? { body: t.body } : {}), ...(t?.line ? { line: t.line } : {}) });

/**
 * `<apc-pet>`: one pet, for an app with no framework. Set `state`, `badge`, `label`, and optionally
 * `scheme` (or the `scheme` attribute), `tint`, `phase`, `size`. Light DOM, like the other components.
 */
export function definePet(tag = "apc-pet"): void {
  if (!globalThis.customElements || customElements.get(tag)) return;
  const KEYS = ["state", "badge", "label", "scheme", "tint", "phase", "size", "decorative", "words"] as const;
  class ApcPet extends HTMLElement {
    static observedAttributes = ["scheme", "label"];
    private opts: PetOptions = { state: "idle", label: "" };
    private pet: PetHandle | null = null;
    constructor() {
      super();
      for (const key of KEYS) {
        // A property set before the element was defined (a framework, a script) sits on the instance: take it in.
        const own = this as unknown as Record<string, unknown>;
        if (Object.hasOwn(own, key)) this.opts = { ...this.opts, [key]: own[key] };
        Object.defineProperty(this, key, {
          configurable: true,
          get: () => this.opts[key],
          set: (v: unknown) => this.set({ [key]: v } as Partial<PetOptions>),
        });
      }
    }
    private set(next: Partial<PetOptions>) {
      this.opts = { ...this.opts, ...next };
      this.pet?.update(next);
    }
    attributeChangedCallback(name: string, _old: string | null, value: string | null) {
      if (name === "scheme") this.set({ scheme: (value as PetScheme | null) ?? "light" });
      if (name === "label") this.set({ label: value ?? "" });
    }
    connectedCallback() {
      if (!document.getElementById("apc-pet-style")) {
        const style = document.createElement("style");
        style.id = "apc-pet-style";
        // A bare <apc-pet> is 2.5rem square unless the app sets --apc-pet-size.
        style.textContent = `${tag} { display: inline-block; width: var(--apc-pet-size, 2.5rem); height: var(--apc-pet-size, 2.5rem); vertical-align: middle; } ${tag} > .apc-pet { display: block; overflow: visible; }`;
        document.head.append(style);
      }
      if (this.pet) return;
      this.pet = createPet(this.opts, this.ownerDocument);
      this.append(this.pet.element);
    }
    disconnectedCallback() {
      this.pet?.destroy();
      this.pet?.element.remove();
      this.pet = null;
    }
  }
  customElements.define(tag, ApcPet);
}

/** `<apc-pet>`'s type, for apps that hold a reference to it. */
export interface ApcPetElement extends HTMLElement {
  state: PetState;
  badge: PetBadge | null;
  label: string;
  scheme: PetScheme;
  tint: PetTint | null;
  phase: number;
  size: number | null;
  decorative: boolean;
  words: ((state: PetState) => string) | null;
}
