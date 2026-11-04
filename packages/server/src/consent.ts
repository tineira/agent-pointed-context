import type { ApcKv } from "./kv.ts";

/**
 * Consent in the app, checked by the app's server (the Dock profile, APC 0.7, `core.ts` in @tineira/apc-protocol).
 * A dock agent dropped on an app that holds no grant for it gets one only after the person allowed it on
 * the app's own page. The page cannot be the judge of that: it decides from the state it last loaded, and
 * a page that missed an update (a revoke, a dock that forgot the pairing) would pair without asking. So the
 * server decides: asked to pair an agent it holds no grant for, it answers `consent_required` with a nonce
 * (`ask`); the page shows its consent with that nonce, and sends it back with the person's Allow; the server
 * makes the grant only when it takes the nonce (`take`): once, for the same dock and agent, within
 * `DOCK_CONSENT_TTL_MS`.
 *
 * The nonce lives in the app's own storage, reached only through the person's own session (the app's owner
 * cookie), so it is kept as is: it proves the request went through the page's consent, not who sent it.
 * `ask` and `take` are synchronous: in a Durable Object nothing runs between the check and the write.
 */

/** The answer an app gives when it needs the person's yes on its page first. */
export const CONSENT_REQUIRED = "consent_required";
/** How long a consent nonce works: longer than a drag's ticket (60 s), which ends the pairing anyway. */
export const DOCK_CONSENT_TTL_MS = 120_000;

interface ConsentRow {
  hub: string;
  agent: string;
  expires_at: number;
}

const PREFIX = "consent:";

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
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

  /** A new nonce for the page to show its consent with, for this dock and agent. Expired ones go first. */
  ask(hub: string, agent: string): string {
    const now = this.now();
    for (const [key, raw] of this.kv.list(PREFIX)) {
      try {
        if ((JSON.parse(raw) as ConsentRow).expires_at <= now) this.kv.delete(key);
      } catch {
        this.kv.delete(key);
      }
    }
    const nonce = `cn_${randomHex(16)}`;
    this.kv.put(`${PREFIX}${nonce}`, JSON.stringify({ hub, agent, expires_at: now + DOCK_CONSENT_TTL_MS } satisfies ConsentRow));
    return nonce;
  }

  /** True once: the nonce was asked for this dock and agent and has not expired. Used or not, it goes. */
  take(nonce: unknown, hub: string, agent: string): boolean {
    if (typeof nonce !== "string" || !/^cn_[0-9a-f]{32}$/.test(nonce)) return false;
    const key = `${PREFIX}${nonce}`;
    const raw = this.kv.get(key);
    if (!raw) return false;
    this.kv.delete(key);
    try {
      const row = JSON.parse(raw) as ConsentRow;
      return row.hub === hub && row.agent === agent && row.expires_at > this.now();
    } catch {
      return false;
    }
  }
}
