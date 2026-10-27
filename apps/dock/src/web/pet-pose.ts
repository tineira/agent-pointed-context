/**
 * The APC character's motion (TIN-483), pure: each state is a pose (numbers), the renderer eases
 * toward it, and a frame is a function of time. apc-pet.tsx draws a Frame into SVG; nothing here
 * touches the DOM, so the tests run without a browser.
 *
 * The character is APC's own, a soft blob with two eyes, the same for every agent. The agent's logo
 * is a badge on it; no vendor's mascot is drawn or animated.
 */
import type { PetState } from "./pet-state.ts";

export interface Pose {
  /** Breathing: the body's size, as a fraction. */
  breath: number;
  /** The outline's wobble, as a fraction of the radius, and its speed. */
  wobble: number;
  wspeed: number;
  /** Positive: wider than tall; negative: taller (stretched). */
  squash: number;
  /** Gentle float, px in the 200 unit box, and its speed. */
  bob: number;
  bspeed: number;
  /** Hops, px. */
  hop: number;
  /** Degrees. */
  tilt: number;
  /** 0 colour .. 1 grey. */
  grey: number;
  eyeW: number;
  eyeH: number;
  /** Where the eyes look. */
  gx: number;
  gy: number;
  /** How far the gaze wanders while idle. */
  wander: number;
}

/** What a state adds around the body, 0 to 1 (eased like the pose). */
export interface Fx {
  ring: number;
  bang: number;
  check: number;
  wink: number;
  orbit: number;
  zz: number;
}

const base: Pose = { breath: 0.025, wobble: 0.02, wspeed: 1.2, squash: 0, bob: 2, bspeed: 1.4, hop: 0, tilt: 0, grey: 0, eyeW: 11, eyeH: 21, gx: 0, gy: 0, wander: 0 };
const none: Fx = { ring: 0, bang: 0, check: 0, wink: 0, orbit: 0, zz: 0 };

export const POSES: Record<PetState, Pose> = {
  idle: { ...base, wander: 3 },
  waiting: { ...base, breath: 0.03, wobble: 0.03, wspeed: 1.0, squash: -0.02, bob: 7, bspeed: 1.9, eyeH: 22, gx: -3, gy: -5, wander: 7 },
  calling: { ...base, breath: 0.02, wobble: 0.06, wspeed: 3.2, squash: 0.02, bspeed: 3, eyeW: 10, eyeH: 18, gx: 6, gy: -7 },
  pinned: { ...base, breath: 0.02, wobble: 0.03, wspeed: 2, bob: 0, bspeed: 1, hop: 7, eyeW: 13, eyeH: 25, gy: -2 },
  read: { ...base, squash: 0.03, tilt: -4, gx: -2 },
  pairing: { ...base, wobble: 0.03, wspeed: 1.6, bob: 3, bspeed: 2.2, tilt: 6, eyeW: 12, eyeH: 23, gx: -8, gy: -2 },
  dragging: { ...base, breath: 0, wobble: 0.05, wspeed: 4, squash: -0.1, bob: 0, bspeed: 1, tilt: 8, eyeW: 14, eyeH: 27, gy: 4 },
  offline: { ...base, breath: 0.035, wobble: 0.01, wspeed: 0.6, squash: 0.07, bob: 1, bspeed: 0.8, grey: 1, eyeW: 12, eyeH: 3, gy: 4 },
};

export const FX: Record<PetState, Fx> = {
  idle: none,
  waiting: none,
  calling: { ...none, orbit: 1 },
  pinned: { ...none, ring: 1, bang: 1 },
  read: { ...none, check: 1, wink: 1 },
  pairing: { ...none, bang: 0.85 },
  dragging: none,
  offline: { ...none, zz: 1 },
};

/** Reduced motion: the same pose with nothing that moves by itself. */
export function stilled(p: Pose): Pose {
  return { ...p, breath: 0, wobble: 0, bob: 0, hop: 0, wander: 0 };
}

/** Moves each number of `cur` toward `target` by the share k (0 to 1), in place. */
function approach<T extends object>(cur: T, target: T, k: number): void {
  for (const key of Object.keys(target) as Array<keyof T>) (cur[key] as number) += ((target[key] as number) - (cur[key] as number)) * k;
}

/** The share to move in dt seconds at a given rate: the same speed at any frame rate. */
export const share = (dt: number, rate: number) => 1 - Math.exp(-Math.max(0, dt) * rate);

/**
 * Where things are drawn, in the SVG's 200 unit box (viewBox -100 -110 200 200, centre (0, -10)). The
 * Windows pet window is clipped to a circle of CLIP.r around that centre (apps/dock-desktop/src/pets.rs),
 * so everything must stay inside it: the tests check the farthest point each state draws.
 */
export const CLIP = { cx: 0, cy: -10, r: 100 };
export const GEOM = {
  ring: { r: 68, stroke: 3.5 },
  orbit: { rx: 66, ry: 14, cy: -62, dot: 6 },
  badge: { x: 40, y: 38, r: 19 },
  check: { x: 52, y: -46, r: 12.25 },
  /** The "!": its baseline (the bottom of its dot), the height of the bar above it and its dot's radius, stroke included. */
  bang: { y: -70, bar: 25, dot: 6.7, half: 7 },
  zz: [
    { x: 22, y: -50, fs: 18 },
    { x: 32, y: -50, fs: 24 },
  ],
};

const N = 40;

/** The body: a closed smooth path through N points on a wobbling, breathing ellipse, flatter at the bottom so it sits. */
export function blobPoints(pose: Pose, t: number, scale: number): Array<[number, number]> {
  const R = 60 * scale;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const grown = R * (1 + pose.breath * Math.sin((t * 2 * Math.PI) / 3.2));
    const wob = pose.wobble * (Math.sin(3 * th + t * pose.wspeed) * 0.6 + Math.sin(2 * th - t * pose.wspeed * 0.7) * 0.4);
    const r = grown * (1 + wob);
    const x = r * Math.cos(th) * (1 + pose.squash);
    let y = r * Math.sin(th) * (1 - pose.squash);
    if (y > 0) y *= 0.9;
    pts.push([x, y]);
  }
  return pts;
}

export function blobPath(pose: Pose, t: number, scale: number): string {
  const pts = blobPoints(pose, t, scale);
  const f = (n: number) => n.toFixed(2);
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % N]!;
    const p3 = pts[(i + 2) % N]!;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

export interface Eye {
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
  opacity: number;
}

export interface Frame {
  body: string;
  shine: string;
  fill: string;
  /** The group's offset (px) and tilt (degrees). */
  bob: number;
  tilt: number;
  left: Eye;
  right: Eye;
  wink: { d: string; opacity: number };
  ring: { opacity: number; offset: number; r: number };
  bang: { opacity: number; y: number; scale: number };
  check: { opacity: number; scale: number };
  orbit: Array<{ cx: number; cy: number; opacity: number }>;
  zz: Array<{ x: number; y: number; opacity: number }>;
  badgeOpacity: number;
}

const hex = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));
const mix = (a: string, b: string, k: number) => {
  const [x, y] = [hex(a), hex(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i]! - v) * k)).join(",")})`;
};

export const BODY = "#23262f";
export const BODY_GREY = "#9aa0ab";

/** The blink: every 3.4 s the eyes close for a moment (not when still, nor when the eyes are shut already). */
export function blink(t: number, still: boolean, eyeH: number): number {
  if (still || eyeH < 6) return 1;
  const phase = (t % 3.4) / 3.4;
  return phase > 0.95 ? Math.max(0.12, 1 - Math.sin(((phase - 0.95) / 0.05) * Math.PI)) : 1;
}

/** One frame at time t (seconds) from the eased pose and effects. `still` is reduced motion: t is 0 and nothing moves by itself. */
export function frameAt(pose: Pose, fx: Fx, t: number, still: boolean): Frame {
  const time = still ? 0 : t;
  const gx = pose.gx + (still ? 0 : pose.wander * Math.sin(time * 0.7) * 0.8);
  const gy = pose.gy + (still ? 0 : pose.wander * Math.sin(time * 0.43 + 1) * 0.4);
  const h = Math.max(2, pose.eyeH * blink(time, still, pose.eyeH));
  const rx = Math.min(pose.eyeW / 2, Math.max(1, h / 2));
  const cy = -10 + gy;
  const wx = 21 + gx;
  const hop = still ? 0 : Math.abs(Math.sin(time * 4.2));
  const orbitAngle = still ? 0 : time * 2.4;
  return {
    body: blobPath(pose, time, 1),
    shine: blobPath(pose, time, 0.94),
    fill: mix(BODY, BODY_GREY, pose.grey),
    bob: still ? 0 : pose.bob * Math.sin(time * pose.bspeed) - pose.hop * hop,
    tilt: pose.tilt,
    left: { x: -21 + gx, y: cy, w: pose.eyeW, h, rx, opacity: 1 },
    right: { x: wx, y: cy, w: pose.eyeW, h, rx, opacity: 1 - fx.wink },
    wink: { d: `M${wx - 8} ${cy + 2} Q${wx} ${cy - 9} ${wx + 8} ${cy + 2}`, opacity: fx.wink },
    ring: { opacity: fx.ring * 0.95, offset: -time * 22, r: GEOM.ring.r + (still ? 0 : 2 * Math.sin(time * 3.6)) },
    bang: { opacity: fx.bang, y: -2 * hop, scale: 0.6 + 0.4 * fx.bang },
    check: { opacity: fx.check, scale: 0.5 + 0.5 * fx.check },
    orbit: [0, 1, 2].map((i) => {
      const a = orbitAngle + (i * 2 * Math.PI) / 3;
      return { cx: Math.cos(a) * GEOM.orbit.rx, cy: GEOM.orbit.cy + Math.sin(a) * GEOM.orbit.ry, opacity: fx.orbit };
    }),
    zz: [0, 1].map((i) => {
      const u = still ? 0.5 * i + 0.25 : (time * 0.5 + i * 0.5) % 1;
      const g = GEOM.zz[i]!;
      return { x: g.x + u * 8, y: g.y - u * 20, opacity: fx.zz * Math.sin(u * Math.PI) };
    }),
    badgeOpacity: 1 - 0.45 * pose.grey,
  };
}

/** A pet's motion state: the eased pose and effects, and how long the state has stayed put. */
export class PetSim {
  private pose: Pose = { ...POSES.idle };
  private fx: Fx = { ...FX.idle };
  private state: PetState | null = null;
  private since = 0;

  /** A frame at time t, dt seconds after the last, easing toward the state. */
  step(state: PetState, t: number, dt: number): Frame {
    if (state !== this.state) {
      this.state = state;
      this.since = t;
    }
    approach(this.pose, POSES[state], share(dt, 7));
    approach(this.fx, FX[state], share(dt, 9));
    return frameAt(this.pose, this.fx, t, false);
  }

  /** The pose of a state at once, without starting its clock: the first frame, drawn before the loop runs. */
  snap(state: PetState, t: number): Frame {
    this.pose = { ...POSES[state] };
    this.fx = { ...FX[state] };
    return frameAt(this.pose, this.fx, t, false);
  }

  /** The still frame of a state (reduced motion): it snaps there, with nothing moving by itself. */
  still(state: PetState): Frame {
    this.state = state;
    this.pose = stilled(POSES[state]);
    this.fx = { ...FX[state] };
    return frameAt(this.pose, this.fx, 0, true);
  }

  /** The state has not changed for `after` seconds, and nobody is dragging: the loop may run slowly. */
  calm(t: number, after = 10): boolean {
    return this.state !== null && this.state !== "dragging" && t - this.since > after;
  }
}

/** The farthest any part of the character is from the clip's centre, in a state at time t (rotation and bob included). */
export function farthest(state: PetState, t: number, still: boolean): number {
  const pose = still ? stilled(POSES[state]) : POSES[state];
  const fx = FX[state];
  const f = frameAt(pose, fx, t, still);
  const a = (f.tilt * Math.PI) / 180;
  const dist = (x: number, y: number, inGroup: boolean) => {
    if (inGroup) {
      [x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a) + f.bob];
    }
    return Math.hypot(x - CLIP.cx, y - CLIP.cy);
  };
  let far = 0;
  const take = (d: number) => (far = Math.max(far, d));
  for (const [x, y] of blobPoints(pose, still ? 0 : t, 1)) take(dist(x, y, true) + 1.25);
  // A circle: its centre's distance plus its radius.
  const disc = (x: number, y: number, r: number, inGroup: boolean) => take(dist(x, y, inGroup) + r);
  disc(GEOM.badge.x, GEOM.badge.y, GEOM.badge.r, true);
  if (fx.ring > 0) disc(0, 0, f.ring.r + GEOM.ring.stroke / 2, true);
  if (fx.orbit > 0) for (const o of f.orbit) disc(o.cx, o.cy, GEOM.orbit.dot, true);
  if (fx.check > 0) disc(GEOM.check.x, GEOM.check.y, GEOM.check.r, false);
  if (fx.bang > 0) {
    // At full size, its bar and dot, hopping with the body: the bar's corners and the dot.
    const y = GEOM.bang.y + f.bang.y;
    for (const x of [-GEOM.bang.half, GEOM.bang.half]) take(dist(x, y - GEOM.bang.bar, true));
    disc(0, y, GEOM.bang.dot, true);
  }
  if (fx.zz > 0) {
    for (const [i, z] of f.zz.entries()) {
      if (z.opacity < 0.02) continue;
      const g = GEOM.zz[i]!;
      take(dist(z.x + g.fs * 0.7, z.y - g.fs * 0.75, false));
    }
  }
  return far;
}
