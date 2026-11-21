/**
 * What the site may know about the visitor's Pulse (design TIN-1063 § 5, TIN-1071, TIN-1072): the parent side of the
 * hero frame's messages, and the one hint /try reads. Status only: the site never receives or stores a sandbox id, a
 * grant id, a secret or an MCP address, and the hint is never an auth check.
 *
 * - Messages from the frame count only from Pulse's origin and from the frame's own window, in the exact shapes of
 *   the contract (`embedMessage`).
 * - `sessionStorage["apc:site:pulse-status"]` holds `{ connected: true, agentName, updatedAt }`, cleared when the
 *   frame mounts and when Pulse says it is not connected, ignored and removed when malformed or older than 6 h.
 * - The agent's name passes `cleanName` on receipt and again on read (the hub and V1 share this origin's storage), and
 *   is rendered only as a React text node.
 */
import { PULSE_ORIGIN } from "../pulse-origin.ts";

/** The view the landing frames; the site's CSP allows framing Pulse's /embed/ views only. */
export const PULSE_HERO = `${PULSE_ORIGIN}/embed/hero`;
/** Pulse's Agents page, for the links the site owns outside the frame (the frame is sandboxed: no popups, no navigation). */
export const PULSE_AGENTS = `${PULSE_ORIGIN}/agents`;
/** Where /try sends a visitor whose agent is already connected. */
export const PULSE_OVERVIEW = `${PULSE_ORIGIN}/overview`;

export const STATUS_KEY = "apc:site:pulse-status";
/** A Pulse sandbox lives 6 h idle (SANDBOX_TTL_MS); a hint older than that says nothing. */
export const STATUS_TTL_MS = 6 * 60 * 60_000;
/** The frame's height, as the landing lets the embed ask for it. */
export const FRAME_MIN = 280;
export const FRAME_MAX = 720;
/** How long the landing waits for the embed to say it is ready before it offers to open Pulse in a new tab. */
export const READY_TIMEOUT_MS = 5000;

const NAME_MAX = 40;

/**
 * An agent name as Pulse cleans it (apps/demo/src/worker/names.ts; pulse-status.test.ts checks they agree): NFC, every
 * control, format (bidi included), line and paragraph separator turned to a space, spaces folded, at most 40
 * characters. Null for anything else or nothing left.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = [...raw.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim()].slice(0, NAME_MAX).join("").trim();
  return name || null;
}

export type EmbedMessage =
  | { type: "apc:embed-ready" }
  | { type: "apc:pulse-status"; connected: boolean; agentName: string | null }
  | { type: "apc:embed-resize"; height: number };

/**
 * A message from the hero frame, or null: another origin, another window (or none), or any shape the contract does
 * not name. The name is cleaned here, and the height clamped.
 */
export function embedMessage(event: { origin: string; source: unknown; data: unknown }, frame: unknown, origin: string = PULSE_ORIGIN): EmbedMessage | null {
  if (event.origin !== origin || !frame || event.source !== frame) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  switch (data.type) {
    case "apc:embed-ready":
      return { type: "apc:embed-ready" };
    case "apc:pulse-status": {
      if (typeof data.connected !== "boolean") return null;
      if (data.agentName !== null && (typeof data.agentName !== "string" || data.agentName.length > 400)) return null;
      return { type: "apc:pulse-status", connected: data.connected, agentName: data.connected ? cleanName(data.agentName) : null };
    }
    case "apc:embed-resize": {
      const h = data.height;
      if (typeof h !== "number" || !Number.isFinite(h)) return null;
      return { type: "apc:embed-resize", height: Math.round(Math.min(FRAME_MAX, Math.max(FRAME_MIN, h))) };
    }
    default:
      return null;
  }
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** This tab's sessionStorage, or null where it is blocked. */
export function sessionStore(): Store | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Drops the hint (the frame just mounted, or Pulse says it is not connected). */
export function clearPulseStatus(store: Store | null = sessionStore()): void {
  try {
    store?.removeItem(STATUS_KEY);
  } catch {
    // storage blocked: there is no hint to drop
  }
}

/** Keeps what an `apc:pulse-status` says: the hint when connected, nothing when not. */
export function savePulseStatus(status: { connected: boolean; agentName: string | null }, store: Store | null = sessionStore(), now = Date.now()): void {
  if (!status.connected) return clearPulseStatus(store);
  try {
    store?.setItem(STATUS_KEY, JSON.stringify({ connected: true, agentName: cleanName(status.agentName), updatedAt: now }));
  } catch {
    // storage blocked or full: /try shows the unconnected walk
  }
}

/**
 * The connection /try may show, or null. A value that is not the contract's shape, or older than 6 h (or from the
 * future), is removed. The name is cleaned again: anything on this origin can write this key.
 */
export function readPulseStatus(store: Store | null = sessionStore(), now = Date.now()): { agentName: string | null } | null {
  let raw: string | null;
  try {
    raw = store?.getItem(STATUS_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  const v = value as { connected?: unknown; agentName?: unknown; updatedAt?: unknown } | null;
  const valid =
    !!v &&
    typeof v === "object" &&
    v.connected === true &&
    (v.agentName === null || typeof v.agentName === "string") &&
    typeof v.updatedAt === "number" &&
    Number.isFinite(v.updatedAt) &&
    v.updatedAt <= now &&
    now - v.updatedAt <= STATUS_TTL_MS;
  if (!valid) {
    clearPulseStatus(store);
    return null;
  }
  return { agentName: cleanName(v.agentName) };
}
