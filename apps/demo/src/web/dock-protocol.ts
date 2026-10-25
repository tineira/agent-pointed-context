/**
 * What Pulse and the dock window say to each other (TIN-370), and the checks on both sides. No DOM
 * here, so the tests can run it; the hook that sends from Pulse is dock-bridge.ts.
 */
/** The dock's origin, and Pulse's on the dock's side: production, or any localhost port in development. */
export function dockOriginAllowed(origin: string): boolean {
  return origin === "https://v2.apc.tineira.com" || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}
export function appOriginAllowed(origin: string): boolean {
  return origin === "https://apc.tineira.com" || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

export interface DockAgent {
  /** The public handle the drop carries (the grant id). */
  handle: string;
  name: string;
  client_name: string | null;
  client_ua: string | null;
  client_icon: string | null;
  motion: "off" | "idle" | "waiting" | "busy" | "seen";
  /** Where it points now, in words, and whether it read that pin. */
  pin: { label: string; seen: boolean } | null;
}

export type DockMessage =
  | { type: "apc-dock:hello"; v: 1 }
  | { type: "apc-dock:agents"; v: 1; app: { name: string; origin: string }; agents: DockAgent[] };

const MOTIONS = new Set(["off", "idle", "waiting", "busy", "seen"]);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const strOrNull = (v: unknown, max: number) => v === null || str(v, max);

/** The dock's check of what Pulse sends: anything else is dropped. A client icon is a small raster data URI only. */
export function parseAgents(data: unknown): Extract<DockMessage, { type: "apc-dock:agents" }> | null {
  const m = data as Record<string, unknown> | null;
  if (!m || m.type !== "apc-dock:agents" || m.v !== 1 || !Array.isArray(m.agents) || m.agents.length > 32) return null;
  const app = m.app as Record<string, unknown> | null;
  if (!app || !str(app.name, 60) || !str(app.origin, 200)) return null;
  const agents: DockAgent[] = [];
  for (const raw of m.agents as unknown[]) {
    const a = raw as Record<string, unknown> | null;
    if (!a || !str(a.handle, 128) || !/^[\w.:-]{1,128}$/.test(a.handle) || !str(a.name, 80)) return null;
    if (!strOrNull(a.client_name, 100) || !strOrNull(a.client_ua, 200) || !strOrNull(a.client_icon, 16_384)) return null;
    if (typeof a.client_icon === "string" && !/^data:image\/(png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a.client_icon)) return null;
    if (!MOTIONS.has(a.motion as string)) return null;
    const pin = a.pin as Record<string, unknown> | null;
    if (pin !== null && (!pin || !str(pin.label, 200) || typeof pin.seen !== "boolean")) return null;
    agents.push({
      handle: a.handle,
      name: a.name,
      client_name: (a.client_name as string | null) ?? null,
      client_ua: (a.client_ua as string | null) ?? null,
      client_icon: (a.client_icon as string | null) ?? null,
      motion: a.motion as DockAgent["motion"],
      pin: pin ? { label: pin.label as string, seen: pin.seen as boolean } : null,
    });
  }
  return { type: "apc-dock:agents", v: 1, app: { name: app.name, origin: app.origin }, agents };
}
