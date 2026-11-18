/**
 * The doorbell (TIN-962, experimental, not part of the APC standard yet): after a pin on a dock grant, the app's server
 * tells the hub "a pin happened", with no target, so the hub can wake an agent that is not calling (a Grok Bot webhook).
 * The hub learns of pins only when the agent calls; without the ring, an idle agent never hears of one.
 *
 * - **The address.** A hub that rings answers a successful `/apc/pair` and `/apc/confirm` with
 *   `ring: { url, id }`: `url` is `<hub origin>/apc/ring/<32 hex>` and `id` the pairing's id at the hub
 *   (`parseRing` accepts nothing else). A hub that does not send it is rung by nobody.
 * - **The key.** SHA-256 of the UTF-8 MCP URL exactly as the app sent it in that pair or confirm call (`ringKey`), as
 *   lowercase hex. The MCP URL is the grant's own secret, which the app and the hub already hold: no new secret. The
 *   app keeps the key server-side with the address; never in a page, a log or a tool result.
 * - **The ring.** `POST <url>` with `{ id, at, n, sig }`: `at` the time in Unix ms, `n` 16 random bytes as unpadded
 *   base64url, `sig` = unpadded base64url of HMAC-SHA256(key bytes, `apc-ring-v1|<id>|<at>|<n>`) (`ringSignature`).
 *   The hub accepts it within 300 s of `at` and once per `n`. Its answer says nothing: a ring is fire-and-forget.
 */

/** Where and as which pairing an app rings its hub. */
export interface HubRing {
  url: string;
  id: string;
}

/** How long either side accepts a ring after its `at`, both ways (ms). */
export const RING_WINDOW_MS = 300_000;

const RING_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RING_PATH = /^\/apc\/ring\/[0-9a-f]{32}$/;
const KEY = /^[0-9a-f]{64}$/;
/** 16 bytes as unpadded base64url. */
export const RING_NONCE = /^[A-Za-z0-9_-]{21}[AQgw]$/;
/** 32 bytes (an HMAC-SHA256) as unpadded base64url. */
export const RING_SIG = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The ring address in a hub's answer, checked against the hub the app called: `url` exactly `<origin>/apc/ring/<32 hex>`
 * on that hub's origin (`origin` as `hubCallOrigin` gave it), `id` 1 to 128 of `A–Z a–z 0–9 _ -`. Anything else is null:
 * the app does not ring, and the pairing is not refused for it.
 */
export function parseRing(origin: string | null, raw: unknown): HubRing | null {
  if (!origin || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { url?: unknown; id?: unknown };
  if (typeof r.url !== "string" || typeof r.id !== "string" || !RING_ID.test(r.id) || r.url.length > 300) return null;
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    return null;
  }
  if (url.origin !== origin || !RING_PATH.test(url.pathname) || url.search || url.hash || url.username || url.password) return null;
  if (r.url !== `${origin}${url.pathname}`) return null;
  return { url: r.url, id: r.id };
}

/** The ring key for a grant: SHA-256 of its MCP URL as sent to the hub, lowercase hex. */
export async function ringKey(mcpUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(mcpUrl));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A ring's signature: unpadded base64url of HMAC-SHA256(key bytes, `apc-ring-v1|<id>|<at>|<n>`). */
export async function ringSignature(keyHex: string, id: string, at: number, n: string): Promise<string> {
  if (!KEY.test(keyHex)) throw new TypeError("ringSignature: the key is 64 lowercase hex characters");
  const key = await crypto.subtle.importKey("raw", hexBytes(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`apc-ring-v1|${id}|${at}|${n}`));
  return base64url(new Uint8Array(mac));
}

/** A new ring nonce: 16 random bytes, unpadded base64url. */
export function newRingNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** The body of a ring, signed (`now` in ms). */
export async function ringBody(ring: HubRing, keyHex: string, now = Date.now()): Promise<{ id: string; at: number; n: string; sig: string }> {
  const n = newRingNonce();
  return { id: ring.id, at: now, n, sig: await ringSignature(keyHex, ring.id, now, n) };
}

/** Constant-time comparison of two strings of the same length (a signature against the expected one). */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Whether a stored ring key is well formed. */
export function isRingKey(value: unknown): value is string {
  return typeof value === "string" && KEY.test(value);
}
