import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "@tineira/apc-protocol";
import type { ApcKv } from "./kv.ts";

/**
 * Consent in the app, checked by the app's server (the Dock profile, APC 0.7, `core.ts` in @tineira/apc-protocol).
 * A dock agent dropped on an app that holds no grant for it gets one only after the person allowed it on
 * the app's own page. The page cannot be the judge of that: it decides from the state it last loaded, and
 * a page that missed an update (a revoke, a dock that forgot the pairing) would pair without asking. So the
 * server decides: asked to pair an agent it holds no grant for, it answers `consent_required` with a nonce
 * and a pairing code (`ask`); the page shows its consent with both, and sends the nonce back with the
 * person's Allow; the server makes the grant only when it takes the nonce (`takeConsent`): once, for the same
 * dock and agent, within `DOCK_CONSENT_TTL_MS`. Taking it gives back the pairing code (APC 0.9), which the app
 * sends to the hub in `/apc/pair` and the dock owner must type to approve.
 *
 * The nonce lives in the app's own storage, reached only through the person's own session (the app's owner
 * cookie), so it is kept as is: it proves the request went through the page's consent, not who sent it.
 * `ask` and `takeConsent` are synchronous: in a Durable Object nothing runs between the check and the write.
 */

/** The answer an app gives when it needs the person's yes on its page first. */
export const CONSENT_REQUIRED = "consent_required";
/** How long a consent nonce and its pairing code work: two minutes, within a drag's ticket (240 s, APC 0.9). */
export const DOCK_CONSENT_TTL_MS = 120_000;

interface ConsentRow {
  hub: string;
  agent: string;
  expires_at: number;
  pairing_code: string;
}

/** What `ask` gives the page: the nonce to send back with the Allow, and the code to show (raw; format it to show it). */
export interface ConsentAsk {
  nonce: string;
  pairing_code: string;
}

/** What `takeConsent` gives: the code to send to the hub, or nothing (no `true` to test by mistake). */
export type ConsentTaken = { ok: true; pairing_code: string } | { ok: false };

const PREFIX = "consent:";

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A new pairing code (APC 0.9): `PAIRING_CODE_LENGTH` characters of Crockford base32, 5 random bits each (a
 * byte masked to 31, which is unbiased since 256 is a multiple of 32): 30 bits. Raw, as sent and stored.
 */
export function newPairingCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH))].map((b) => PAIRING_CODE_ALPHABET[b & 31]).join("");
}

export class DockConsent {
  private kv: ApcKv;
  private clock: () => number;

  constructor(kv: ApcKv, options: { now?: () => number } = {}) {
    this.kv = kv;
    this.clock = options.now ?? Date.now;
  }

  private now(): number {
    return this.clock();
  }

  /** A new nonce and pairing code for the page to show its consent with, for this dock and agent. Expired ones go first. */
  ask(hub: string, agent: string): ConsentAsk {
    const now = this.now();
    for (const [key, raw] of this.kv.list(PREFIX)) {
      try {
        if ((JSON.parse(raw) as ConsentRow).expires_at <= now) this.kv.delete(key);
      } catch {
        this.kv.delete(key);
      }
    }
    const nonce = `cn_${randomHex(16)}`;
    const pairing_code = newPairingCode();
    this.kv.put(`${PREFIX}${nonce}`, JSON.stringify({ hub, agent, expires_at: now + DOCK_CONSENT_TTL_MS, pairing_code } satisfies ConsentRow));
    return { nonce, pairing_code };
  }

  /**
   * Once: the nonce was asked for this dock and agent and has not expired, and here is the pairing code it was
   * shown with, to send to the hub. Used or not, it goes.
   */
  takeConsent(nonce: unknown, hub: string, agent: string): ConsentTaken {
    if (typeof nonce !== "string" || !/^cn_[0-9a-f]{32}$/.test(nonce)) return { ok: false };
    const key = `${PREFIX}${nonce}`;
    const raw = this.kv.get(key);
    if (!raw) return { ok: false };
    this.kv.delete(key);
    try {
      const row = JSON.parse(raw) as ConsentRow;
      if (row.hub !== hub || row.agent !== agent || row.expires_at <= this.now() || typeof row.pairing_code !== "string") return { ok: false };
      return { ok: true, pairing_code: row.pairing_code };
    } catch {
      return { ok: false };
    }
  }
}
