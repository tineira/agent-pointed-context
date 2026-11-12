/**
 * The computers on one dock (TIN-838): what is pure about linking another computer, kept apart from the
 * hub so it can be tested on its own. A dock had one owner secret; now each computer that opens it has
 * its own, and a new computer joins with a short code the dock shows, after a yes on a computer already
 * linked.
 */

/** A join code is claimed within this time of being made, or it is gone. */
export const JOIN_CODE_TTL_MS = 2 * 60_000;
/** A claimed code waits this long for a yes or a no on a linked computer, and as long again to be collected. */
export const JOIN_ANSWER_MS = 2 * 60_000;
/** The most computers one dock holds. */
export const MAX_DEVICES = 10;
/**
 * The close code a computer's dock page gets when another computer removed it. A WebSocket closes only with
 * 1000 or an application code (3000 to 4999): another code makes the close itself fail.
 */
export const REMOVED_CLOSE = 4001;
/** A computer's "last used" moves at most this often (one write per minute, not one per request). */
export const LAST_USED_STEP_MS = 60_000;

/** Crockford's base32: no I, L, O or U, so a typed code is read the same way it was shown. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Nine characters: 45 bits, shown as three groups of three. */
export const JOIN_CODE_LENGTH = 9;

/** A new join code, in its plain form (no dashes). */
export function newJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(JOIN_CODE_LENGTH));
  return [...bytes].map((b) => ALPHABET[b & 31]).join("");
}

/**
 * A code as the person typed or pasted it, in its plain form, or null when it cannot be one: case,
 * spaces and dashes do not matter, and O, I and L read as 0, 1 and 1. A whole join link works too
 * (`…/dock/join#KQ7M4P2XD`).
 */
export function normalizeJoinCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 200) return null;
  const raw = input.includes("#") ? input.slice(input.lastIndexOf("#") + 1) : input;
  const code = raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== JOIN_CODE_LENGTH) return null;
  return [...code].every((ch) => ALPHABET.includes(ch)) ? code : null;
}

/** "KQ7M4P2XD" as the dock shows it: "KQ7-M4P-2XD". */
export function formatJoinCode(code: string): string {
  return code.match(/.{1,3}/g)?.join("-") ?? code;
}

/** The link another computer opens to join: the code in the fragment, so it never reaches a server log. */
export function joinLink(origin: string, code: string): string {
  return `${origin}/dock/join#${code}`;
}

/**
 * How the dock names a computer: its browser and system, from the request's User-Agent ("Edge on
 * Windows"), or "Dock for Windows" for the desktop app. Only a label for the person; never a check.
 */
export function deviceLabel(userAgent: string | null | undefined, desktop = false): string {
  if (desktop) return "Dock for Windows";
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const system = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? (system ? `A browser on ${system}` : "A browser");
}
