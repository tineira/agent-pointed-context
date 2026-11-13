import { PAIRING_CODE_ACK, type DockPairRequest } from "@tineira/apc-protocol";

/**
 * An app's calls to a dock's hub, server to server (the Dock profile; APC 0.9): `pairWithHub` after the
 * person's Allow, `confirmWithHub` on every later drop. Both fail closed. A call never follows a redirect
 * (`redirect: "error"`: the app's hub list is its trust anchor, and a redirect would hand the grant and the
 * pairing code to another host), gives up after `timeoutMs` (10 s by default), and believes only these
 * answers:
 *
 * - **HTTP 200** with `ok: true` and, for a pairing, the acknowledgement `pairing_code: "required"` and a
 *   string `pairing_id`; for a confirm, `status` `"pending"` or `"paired"`.
 * - **HTTP 400** with `ok: false` and an `error` in the hub's vocabulary (`/^[a-z_]{1,64}$/`): the hub's
 *   own refusal, passed on.
 *
 * Anything else is a refusal of the app's own: `hub_unreachable` (no answer, a time limit, a redirect the
 * runtime refused), `hub_ignores_pairing_code` (a yes without the acknowledgement: a hub that would not check
 * the code), `hub_refused` (any other status, a redirect that came through, JSON that is not an answer).
 * On any refusal after `/apc/pair` the app deletes the grant it made, before it answers its page: a grant is
 * kept only when the hub said it holds the code.
 */
export interface HubCallOptions {
  /** How the app reaches the hub; the global fetch by default. */
  fetch?: typeof fetch;
  /** Milliseconds before the call gives up: 10 000 by default. */
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

type Answer = { status: number; body: Record<string, unknown> | null } | { error: "hub_unreachable" | "hub_refused" };

async function post(hub: string, path: string, body: unknown, options: HubCallOptions): Promise<Answer> {
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let response: Response;
  try {
    response = await send(`${hub}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return { error: "hub_unreachable" };
  }
  // A fetch that followed a redirect anyway (or gave the redirect itself back) is not the hub answering.
  if (response.redirected || (response.type as string) === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => {});
    return { error: "hub_refused" };
  }
  try {
    const parsed = (await response.json()) as unknown;
    return { status: response.status, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null };
  } catch {
    return { status: response.status, body: null };
  }
}

/** The hub's own refusal (HTTP 400, `ok: false`, an error in its words), or null. */
function refusal(a: { status: number; body: Record<string, unknown> | null }): string | null {
  return a.status === 400 && a.body?.ok === false && typeof a.body.error === "string" && HUB_ERROR.test(a.body.error) ? a.body.error : null;
}

/**
 * `POST {hub}/apc/pair` with the pairing code (APC 0.9). `{ ok: true }` only on HTTP 200 with the
 * acknowledgement; on anything else the caller deletes the grant it made before it answers.
 */
export async function pairWithHub(hub: string, body: DockPairRequest, options: HubCallOptions = {}): Promise<PairWithHubResult> {
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
export async function confirmWithHub(hub: string, body: { ticket: string; agent: string; mcp_url: string }, options: HubCallOptions = {}): Promise<ConfirmWithHubResult> {
  const a = await post(hub, "/apc/confirm", body, options);
  if ("error" in a) return { ok: false, error: a.error };
  const refused = refusal(a);
  if (refused) return { ok: false, error: refused };
  if (a.status !== 200 || a.body?.ok !== true || (a.body.status !== "pending" && a.body.status !== "paired")) return { ok: false, error: "hub_refused" };
  return { ok: true, status: a.body.status, agent: agentOf(a.body.agent) };
}
