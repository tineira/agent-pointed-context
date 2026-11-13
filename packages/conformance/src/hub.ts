/**
 * A stand-in for a dock's hub (the Dock profile), for testing an app in process: what `@tineira/apc-conformance`
 * checks a Dock app against, and what an app's own tests can pair with. It is faithful to the parts of a hub an
 * app meets, as of APC 0.9:
 *
 * - **Tickets**: `ticket(agent)` mints a single-use ticket for an agent, valid `TICKET_TTL_MS`.
 * - **`POST {hub}/apc/pair`**: checks the body before it spends the ticket (a `pairing_code` present but not a
 *   code is `invalid_pairing_code`), keeps the code with the pending pairing and answers the acknowledgement
 *   (`pairing_code: "required"`). An app that sends no code still pairs, as a hub in `when_sent` mode lets it.
 * - **`POST {hub}/apc/confirm`**: whether it still pairs that agent with that MCP URL.
 * - **The dock owner's answer** (`decide`): approving a pairing with a code needs that code; wrong ones count, and
 *   the last of `PAIRING_CODE_MAX_ATTEMPTS` removes the pairing and gives the grant back
 *   (`POST {app}/apc/revoke`); the right one pairs it and introduces the hub to the app (`initialize` on the
 *   grant). `expire()` is the pairing code's time running out: every pending pairing with a code goes, its
 *   grant given back.
 * - **A broken hub**, for the checks that an app fails closed (`mode`): `"no_ack"` answers a yes without the
 *   acknowledgement (a hub from before 0.9), `"redirect"` redirects `/apc/pair` to another host that says yes,
 *   `"error_500"` says yes with HTTP 500.
 * - **Since 0.10**, for the checks of the hub call (M2 to M4): `"status_3xx"` answers a yes with a 307 (whatever the
 *   app's `redirect` option), `"opaque_redirect"` and `"redirected"` a yes marked as a redirect; `"slow_body"` sends
 *   its headers and stalls the body (`releaseStalls()` ends it); `"length_over_cap"`, `"length_not_digits"` and
 *   `"body_over_cap"` break the byte cap; `"length_mismatch"` and `"ack_with_length"` are yeses an app must take (a
 *   `content-length` other than the decoded body's, as with gzip, and a plain one). `hold()` keeps the next
 *   `/apc/pair` answer back until the check releases it (the grant is in flight); `requests` lists every URL the
 *   app called (M9); `forget()` drops a pairing without giving it back (it expired at the hub, so `/apc/confirm`
 *   answers `not_paired`); `decide(…, { introduce: false })` approves without the hub's `initialize`.
 *
 * It never shows a code: `received` keeps what the app sent, for the checks to compare with what the app showed.
 */
import { HUB_ANSWER_MAX_BYTES, normalizePairingCode, PAIRING_CODE_ACK, PAIRING_CODE_MAX_ATTEMPTS, pairingCodesMatch, TICKET_TTL_MS } from "@tineira/apc-protocol";

export type StandInHubMode =
  | "ack"
  | "no_ack"
  | "redirect"
  | "error_500"
  | "status_3xx"
  | "opaque_redirect"
  | "redirected"
  | "slow_body"
  | "length_over_cap"
  | "length_not_digits"
  | "body_over_cap"
  | "length_mismatch"
  | "ack_with_length";

/** A `/apc/pair` answer kept back (`hold()`): what the app sent once it arrives, and the release. */
export interface StandInHold {
  /** The `/apc/pair` body the app sent, once it arrives. */
  readonly arrived: Promise<Record<string, unknown>>;
  /** Answers it now, in `mode` (the hub's own mode when left out). Released before it arrived, the hold is withdrawn. */
  release(mode?: StandInHubMode): void;
}

export interface StandInPairing {
  id: string;
  agent: string;
  mcp_url: string;
  app_origin: string;
  status: "pending" | "paired";
  /** The code the app sent, raw, until it is typed right; null for an app that sent none. */
  pairing_code: string | null;
  attempts: number;
}

export interface StandInHubOptions {
  /** The hub's origin; "https://dock.test" by default. */
  origin?: string;
  /** How the hub reaches the app (its `/apc/revoke` and the grant's MCP URL): in process, the app's own handler. Without it the hub calls nobody. */
  app?: (request: Request) => Promise<Response>;
  /** Milliseconds since the epoch, for tickets; Date.now by default. */
  now?: () => number;
}

export interface StandInHub {
  readonly origin: string;
  /** What the app's server calls the hub with (pass it as the app's fetch, or route the hub's origin to it). */
  readonly fetch: typeof fetch;
  /** How the hub answers `/apc/pair`: "ack" (a hub of 0.9) unless a check sets another. */
  mode: StandInHubMode;
  /** A new single-use ticket for this agent, as the dock puts on a drag. */
  ticket(agent: string): string;
  /** The pairings it holds, pending and paired. */
  readonly pairings: StandInPairing[];
  /** Every `/apc/pair` body the app sent, oldest first, whatever the hub answered. */
  readonly received: Array<Record<string, unknown>>;
  /** Every URL the app's server called through this hub's `fetch`, on any origin, oldest first. */
  readonly requests: string[];
  /** The MCP URL of the agent's latest pairing. */
  urlOf(agent: string): string | undefined;
  /**
   * The dock owner approves (with what they typed) or denies a pairing. An approval introduces the hub to the app
   * (`initialize` on the grant) unless `introduce` is false: the hub has not got round to it yet.
   */
  decide(pairingId: string, action: "approve" | "deny", code?: unknown, options?: { introduce?: boolean }): Promise<{ ok: boolean; error?: string; attempts_left?: number }>;
  /** The pairing code's time ran out: every pending pairing with a code goes, its grant given back. */
  expire(): Promise<void>;
  /** Keeps the next `/apc/pair` answer back until it is released: the grant it carries is in flight. */
  hold(): StandInHold;
  /** The hub drops a pairing without giving its grant back (it expired at the hub): `/apc/confirm` then answers `not_paired`. */
  forget(pairingId: string): void;
  /** Ends every body `"slow_body"` stalled. */
  releaseStalls(): void;
}

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function standInHub(options: StandInHubOptions = {}): StandInHub {
  const origin = options.origin ?? "https://dock.test";
  const now = options.now ?? Date.now;
  const did = randomHex(16);
  const tickets = new Map<string, { agent: string; expires_at: number }>();
  const pairings: StandInPairing[] = [];
  const received: Array<Record<string, unknown>> = [];
  const requests: string[] = [];
  const holds: Array<{ resolve: (body: Record<string, unknown>) => void; gate: Promise<StandInHubMode | undefined>; open: (mode?: StandInHubMode) => void; taken: boolean }> = [];
  const stalls = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const json = (body: unknown, status = 200) => Response.json(body, { status });

  const callApp = async (url: string, body: unknown) => {
    if (!options.app) return;
    const response = await options.app(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }));
    await response.body?.cancel().catch(() => {});
  };
  const giveBack = async (p: StandInPairing) => {
    pairings.splice(pairings.indexOf(p), 1);
    await callApp(`${p.app_origin}/apc/revoke`, { mcp_url: p.mcp_url });
  };
  const live = (ticket: unknown, agent: unknown) => {
    const t = typeof ticket === "string" ? tickets.get(ticket) : undefined;
    return !!t && t.agent === agent && t.expires_at > now();
  };

  const pair = (b: Record<string, unknown>): Response => {
    if (typeof b.ticket !== "string" || typeof b.agent !== "string" || typeof b.mcp_url !== "string") return json({ ok: false, error: "invalid" }, 400);
    const app = b.app as { name?: unknown; origin?: unknown } | undefined;
    if (typeof app?.name !== "string" || !app.name || typeof app.origin !== "string") return json({ ok: false, error: "app_not_allowed" }, 400);
    // The body first: a malformed code leaves the ticket good.
    const code = b.pairing_code === undefined ? null : normalizePairingCode(b.pairing_code);
    if (b.pairing_code !== undefined && !code) return json({ ok: false, error: "invalid_pairing_code" }, 400);
    if (!live(b.ticket, b.agent)) return json({ ok: false, error: "ticket_expired" }, 400);
    tickets.delete(b.ticket);
    const p: StandInPairing = { id: `pr_${randomHex(6)}`, agent: b.agent, mcp_url: b.mcp_url, app_origin: app.origin, status: "pending", pairing_code: code, attempts: 0 };
    pairings.push(p);
    return json({ ok: true, pairing_id: p.id, status: "pending", agent: { name: "Agent via dock", icon: null }, ...(code ? { pairing_code: PAIRING_CODE_ACK } : {}) });
  };

  /** What `/apc/pair` answers in `mode`. */
  const answerPair = async (body: Record<string, unknown>, mode: StandInHubMode, redirect: RequestRedirect | undefined): Promise<Response> => {
    const yes = { ok: true, pairing_id: "pr_elsewhere", status: "pending", agent: { name: "Agent via dock", icon: null }, pairing_code: PAIRING_CODE_ACK };
    if (mode === "redirect") {
      // A fetch that refuses redirects (as an app's must) fails; one that follows lands on another host that says yes.
      if (redirect === "error") throw new TypeError(`redirect from ${origin}/apc/pair refused`);
      const elsewhere = json(yes);
      Object.defineProperty(elsewhere, "redirected", { value: true });
      return elsewhere;
    }
    if (mode === "error_500") return json({ ...yes, pairing_id: "pr_500" }, 500);
    const answer = pair(body);
    if (mode === "ack") return answer;
    const text = await answer.text();
    const headers = (more: Record<string, string> = {}) => ({ "content-type": "application/json", ...more });
    switch (mode) {
      case "no_ack": {
        if (!answer.ok) return new Response(text, { status: answer.status, headers: headers() });
        const rest = JSON.parse(text) as Record<string, unknown>;
        delete rest.pairing_code;
        return json(rest);
      }
      case "status_3xx":
        // A 3xx with a yes in it: an app must refuse it, whatever its redirect option let through.
        return new Response(text, { status: 307, headers: headers({ location: "https://elsewhere.example/apc/pair" }) });
      case "opaque_redirect": {
        const r = new Response(text, { status: 200, headers: headers() });
        Object.defineProperty(r, "type", { value: "opaqueredirect" });
        return r;
      }
      case "redirected": {
        const r = new Response(text, { status: 200, headers: headers() });
        Object.defineProperty(r, "redirected", { value: true });
        return r;
      }
      case "slow_body": {
        const bytes = new TextEncoder().encode(text);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Half of the yes, then nothing: the body never ends until the check releases it.
            controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
            stalls.add(controller);
          },
        });
        return new Response(stream, { status: answer.status, headers: headers() });
      }
      case "length_over_cap":
        return new Response(text, { status: answer.status, headers: headers({ "content-length": String(HUB_ANSWER_MAX_BYTES + 1) }) });
      case "length_not_digits":
        // A number, but not digits only: an app that reads it with Number() takes it.
        return new Response(text, { status: answer.status, headers: headers({ "content-length": "1e2" }) });
      case "body_over_cap":
        // The padding first: an app that cuts at the cap reads broken JSON; one that reads it all reads a yes.
        return new Response(`{"pad":"${"x".repeat(HUB_ANSWER_MAX_BYTES)}",${text.slice(1)}`, { status: answer.status, headers: headers() });
      case "length_mismatch":
        // As with gzip: the declared length is not the decoded one. An app must not compare them.
        return new Response(text, { status: answer.status, headers: headers({ "content-length": "20" }) });
      case "ack_with_length":
        return new Response(text, { status: answer.status, headers: headers({ "content-length": String(new TextEncoder().encode(text).length) }) });
    }
  };

  const hub: StandInHub = {
    origin,
    mode: "ack",
    pairings,
    received,
    requests,
    ticket(agent) {
      const ticket = `${did}.${randomHex(16)}`;
      tickets.set(ticket, { agent, expires_at: now() + TICKET_TTL_MS });
      return ticket;
    },
    urlOf: (agent) => pairings.filter((p) => p.agent === agent).at(-1)?.mcp_url,
    fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request.url);
      const url = new URL(request.url);
      if (url.origin !== origin || request.method !== "POST") return json({ ok: false, error: "not_found" }, 404);
      const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      if (url.pathname === "/apc/pair") {
        received.push(body);
        let mode = hub.mode;
        const held = holds.shift();
        if (held) {
          held.taken = true;
          held.resolve(body);
          mode = (await held.gate) ?? hub.mode;
        }
        return answerPair(body, mode, init?.redirect ?? request.redirect);
      }
      if (url.pathname === "/apc/confirm") {
        if (!live(body.ticket, body.agent)) return json({ ok: false, error: "ticket_expired" }, 400);
        const p = pairings.find((x) => x.agent === body.agent && x.mcp_url === body.mcp_url);
        if (!p) return json({ ok: false, error: "not_paired" }, 400);
        tickets.delete(body.ticket as string);
        return json({ ok: true, status: p.status, agent: { name: "Agent via dock", icon: null } });
      }
      return json({ ok: false, error: "not_found" }, 404);
    }) as typeof fetch,
    async decide(pairingId, action, code, decideOptions) {
      const p = pairings.find((x) => x.id === pairingId);
      if (!p) return { ok: false, error: "unknown_pairing" };
      if (action === "deny") {
        await giveBack(p);
        return { ok: true };
      }
      if (p.status !== "pending") return { ok: false, error: "invalid_action" };
      if (p.pairing_code) {
        if (code === undefined || code === null || code === "") return { ok: false, error: "pairing_code_required" };
        const given = normalizePairingCode(code);
        if (!given) return { ok: false, error: "invalid_pairing_code" };
        if (!pairingCodesMatch(p.pairing_code, given)) {
          p.attempts++;
          if (p.attempts < PAIRING_CODE_MAX_ATTEMPTS) return { ok: false, error: "wrong_pairing_code", attempts_left: PAIRING_CODE_MAX_ATTEMPTS - p.attempts };
          await giveBack(p);
          return { ok: false, error: "pairing_code_refused" };
        }
        p.pairing_code = null;
      }
      p.status = "paired";
      if (decideOptions?.introduce === false) return { ok: true };
      // The hub introduces itself to the app, as a real one does on approval.
      await callApp(p.mcp_url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "apc-hub", title: "Agent via dock", version: "0.9.0" } } });
      return { ok: true };
    },
    async expire() {
      for (const p of pairings.filter((x) => x.status === "pending" && x.pairing_code)) await giveBack(p);
    },
    hold() {
      let resolve!: (body: Record<string, unknown>) => void;
      const arrived = new Promise<Record<string, unknown>>((r) => (resolve = r));
      let open!: (mode?: StandInHubMode) => void;
      const gate = new Promise<StandInHubMode | undefined>((r) => (open = r));
      const entry = { resolve, gate, open, taken: false };
      holds.push(entry);
      return {
        arrived,
        release(mode) {
          if (!entry.taken && holds.includes(entry)) holds.splice(holds.indexOf(entry), 1);
          entry.open(mode);
        },
      };
    },
    forget(pairingId) {
      const i = pairings.findIndex((p) => p.id === pairingId);
      if (i >= 0) pairings.splice(i, 1);
    },
    releaseStalls() {
      for (const c of stalls) {
        try {
          c.close();
        } catch {
          // already closed or cancelled
        }
      }
      stalls.clear();
    },
  };
  return hub;
}
