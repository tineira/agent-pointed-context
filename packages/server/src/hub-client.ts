import { badContentLength, bareOrigin, LOOPBACK_HOST, readCapped, utf8 } from "./util.ts";
import { HUB_ANSWER_MAX_BYTES, HUB_CALL_DEADLINE_MS, PAIRING_CODE_ACK, type DockPairRequest, type HubCallError } from "@tineira/apc-protocol";

/**
 * An app's calls to a dock's hub, server to server (the Dock profile; APC 0.9, hardened in 0.10):
 * `pairWithHub` after the person's Allow, `confirmWithHub` on every later drop. Both fail closed, and follow
 * the app's MUSTs on the hub call (APC 0.10):
 *
 * - **M9.** The request goes to the parsed origin of `hub` (`new URL(hub).origin` and the path), never to
 *   the raw string. A `hub` that is not a bare `https:` origin (or `http:` on a loopback host), or is
 *   unparsable, or has userinfo, a path other than `/`, a query or a fragment, is `hub_not_allowed`, and
 *   nothing is sent. Check the hub against the app's
 *   allowlist first (`parseDockDrop`, M1): this client does not know the allowlist.
 * - **M2.** `redirect: "error"`, and any 3xx, `opaqueredirect` or `response.redirected` is `hub_refused`:
 *   the app's hub list is its trust anchor, and a redirect would hand the grant and the pairing code to
 *   another host.
 * - **M3.** One deadline, `timeoutMs` (10 s by default, and never more: `HUB_CALL_DEADLINE_MS`), covers the
 *   headers **and** the whole body. Past it the call is `hub_unreachable`.
 * - **M4.** A `content-length` that is present must be digits only and at most `HUB_ANSWER_MAX_BYTES`, or
 *   the answer is `hub_refused` before a byte is read. The decoded body is read as a stream and cut at the
 *   cap (past it: `hub_refused`). An absent `content-length` (chunked) is fine, and the declared length is
 *   never compared with the decoded one (gzip).
 *
 * It believes only these answers:
 *
 * - **HTTP 200** with `ok: true` and, for a pairing, the acknowledgement `pairing_code: "required"` and a
 *   string `pairing_id`; for a confirm, `status` `"pending"` or `"paired"`.
 * - **HTTP 400** with `ok: false` and an `error` in the hub's vocabulary (`/^[a-z_]{1,64}$/`): the hub's
 *   own refusal, passed on.
 *
 * Anything else is a refusal of the app's own (`HubCallError`): `hub_not_allowed`, `hub_unreachable` (no
 * answer, the deadline, a redirect the runtime refused), `hub_ignores_pairing_code` (a yes without the
 * acknowledgement: a hub that would not check the code), `hub_refused` (any other status, a redirect that
 * came through, a body past the cap or a bad `content-length`, JSON that is not an answer). On any refusal
 * after `/apc/pair` the app ends the grant it made, before it answers its page: a grant is kept only when
 * the hub said it holds the code.
 */
export interface HubCallOptions {
  /** How the app reaches the hub; the global fetch by default. */
  fetch?: typeof fetch;
  /** Milliseconds for the whole call, headers and body: 10 000 by default, and never more (`HUB_CALL_DEADLINE_MS`). */
  timeoutMs?: number;
}

/** The agent as the hub names it, checked: strings or null, nothing else. */
export interface HubAgent {
  name: string | null;
  icon: string | null;
}

export type PairWithHubResult = { ok: true; pairing_id: string; status: "pending"; agent: HubAgent } | { ok: false; error: string };
export type ConfirmWithHubResult = { ok: true; status: "pending" | "paired"; agent: HubAgent } | { ok: false; error: string };

const HUB_ERROR = /^[a-z_]{1,64}$/;

const agentOf = (raw: unknown): HubAgent => {
  const a = raw && typeof raw === "object" ? (raw as { name?: unknown; icon?: unknown }) : {};
  return { name: typeof a.name === "string" ? a.name : null, icon: typeof a.icon === "string" ? a.icon : null };
};

type Answer = { status: number; body: Record<string, unknown> | null } | { error: Exclude<HubCallError, "hub_ignores_pairing_code"> };

/**
 * The origin a hub call goes to (M9): `hub` as a bare origin (`bareOrigin`: printable ASCII, no userinfo, path
 * but `/`, dot segment, query or fragment, written exactly as its origin), over `https:`, or over `http:` only on
 * a loopback host (`localhost`, `*.localhost`, `127.0.0.1`: local development), so the secret MCP URL and the
 * pairing code never go out in clear text; null otherwise. Whether it is on the app's allowlist is
 * `parseDockDrop`'s question (M1), asked before the call.
 */
export function hubCallOrigin(hub: string | URL): string | null {
  const url = bareOrigin(String(hub));
  if (!url) return null;
  if (url.protocol === "https:") return url.origin;
  return url.protocol === "http:" && LOOPBACK_HOST.test(url.hostname) ? url.origin : null;
}

/** The one deadline of a call (M3): `timeoutMs` when it is a positive number, never more than `HUB_CALL_DEADLINE_MS`. */
function deadlineMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, HUB_CALL_DEADLINE_MS) : HUB_CALL_DEADLINE_MS;
}

/** The deadline passed (M3). */
class Expired extends Error {}

export { badContentLength };

async function post(hub: string | URL, path: string, body: unknown, options: HubCallOptions): Promise<Answer> {
  const origin = hubCallOrigin(hub);
  if (!origin) return { error: "hub_not_allowed" };
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One deadline for the headers and the whole body (M3): it aborts the request and fails any read still waiting.
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("The hub call took too long.", "TimeoutError"));
      reject(new Expired());
    }, deadlineMs(options.timeoutMs));
  });
  expired.catch(() => {});
  try {
    let response: Response;
    try {
      response = await Promise.race([
        send(`${origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: controller.signal,
        }),
        expired,
      ]);
    } catch {
      return { error: "hub_unreachable" };
    }
    const discard = () => void response.body?.cancel().catch(() => {});
    // A fetch that followed a redirect anyway (or gave the redirect itself back) is not the hub answering (M2).
    if (response.redirected || (response.type as string) === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      discard();
      return { error: "hub_refused" };
    }
    // Only a 200 or the hub's own 400 is ever believed: the body of anything else is not read.
    if (response.status !== 200 && response.status !== 400) {
      discard();
      return { error: "hub_refused" };
    }
    if (badContentLength(response.headers, HUB_ANSWER_MAX_BYTES)) {
      discard();
      return { error: "hub_refused" };
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(response.body, HUB_ANSWER_MAX_BYTES, expired);
    } catch (error) {
      return { error: error instanceof Expired || controller.signal.aborted ? "hub_unreachable" : "hub_refused" };
    }
    if (!bytes) return { error: "hub_refused" };
    const text = utf8(bytes);
    if (text === null) return { status: response.status, body: null };
    try {
      const parsed = JSON.parse(text) as unknown;
      return { status: response.status, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null };
    } catch {
      return { status: response.status, body: null };
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The hub's own refusal (HTTP 400, `ok: false`, an error in its words), or null. */
function refusal(a: { status: number; body: Record<string, unknown> | null }): string | null {
  return a.status === 400 && a.body?.ok === false && typeof a.body.error === "string" && HUB_ERROR.test(a.body.error) ? a.body.error : null;
}

/**
 * `POST {hub}/apc/pair` with the pairing code (APC 0.9). `{ ok: true }` only on HTTP 200 with the
 * acknowledgement; on anything else the caller ends the grant it made before it answers. Pass the hub as
 * `parseDockDrop` gave it: its allowlisted origin.
 */
export async function pairWithHub(hub: string | URL, body: DockPairRequest, options: HubCallOptions = {}): Promise<PairWithHubResult> {
  const a = await post(hub, "/apc/pair", body, options);
  if ("error" in a) return { ok: false, error: a.error };
  const refused = refusal(a);
  if (refused) return { ok: false, error: refused };
  if (a.status !== 200 || a.body?.ok !== true) return { ok: false, error: "hub_refused" };
  if (a.body.pairing_code !== PAIRING_CODE_ACK) return { ok: false, error: "hub_ignores_pairing_code" };
  if (typeof a.body.pairing_id !== "string" || !a.body.pairing_id) return { ok: false, error: "hub_refused" };
  return { ok: true, pairing_id: a.body.pairing_id, status: "pending", agent: agentOf(a.body.agent) };
}

/** `POST {hub}/apc/confirm` on a drop of an agent the app holds a grant for: whether the hub still pairs them. */
export async function confirmWithHub(hub: string | URL, body: { ticket: string; agent: string; mcp_url: string }, options: HubCallOptions = {}): Promise<ConfirmWithHubResult> {
  const a = await post(hub, "/apc/confirm", body, options);
  if ("error" in a) return { ok: false, error: a.error };
  const refused = refusal(a);
  if (refused) return { ok: false, error: refused };
  if (a.status !== 200 || a.body?.ok !== true || (a.body.status !== "pending" && a.body.status !== "paired")) return { ok: false, error: "hub_refused" };
  return { ok: true, status: a.body.status, agent: agentOf(a.body.agent) };
}
