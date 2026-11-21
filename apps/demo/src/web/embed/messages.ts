/**
 * The hero frame's side of the message contract with the landing (TIN-1070, design TIN-1063 § 5). Status and
 * lifecycle only: never a sandbox id, a grant id, a secret or an MCP address.
 *
 * Out, to the parent's origin only (never "*"):
 * - `{ type: "apc:embed-ready" }`, once, when the view has mounted;
 * - `{ type: "apc:pulse-status", connected, agentName }`, after the first state load and whenever either changes;
 * - `{ type: "apc:embed-resize", height }`, when the view's height changes.
 *
 * In: `{ type: "apc:theme", scheme: "light" | "dark" }`, taken only from the parent's origin and the parent window.
 */
import { cleanName } from "../../worker/names.ts";
import type { GrantState } from "./api.ts";

export type Scheme = "light" | "dark";

export type EmbedMessage =
  | { type: "apc:embed-ready" }
  | { type: "apc:pulse-status"; connected: boolean; agentName: string | null }
  | { type: "apc:embed-resize"; height: number };

/**
 * The origin the Worker wrote into the page (`<meta name="apc-embed-parent">`): one http(s) origin, or null, and then
 * the view sends nothing and takes nothing.
 */
export function parentOriginFrom(content: string | null | undefined): string | null {
  if (!content) return null;
  try {
    const url = new URL(content);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === content ? content : null;
  } catch {
    return null;
  }
}

/**
 * Whether the hero's agent is connected: its grant exists and its agent sent `initialize` with a name (`client_name`),
 * as Pulse's own pages read it (an empty name is not connected). Never from presence. The view and the landing's status
 * both read this, so they never disagree.
 */
export function agentConnected(grant: GrantState | null | undefined): boolean {
  return !!grant?.client_name;
}

/** The status the landing may know (§ 5): whether the hero's agent is connected, and its name, cleaned, or null. */
export function pulseStatus(grant: GrantState | null, name: string | null | undefined): Extract<EmbedMessage, { type: "apc:pulse-status" }> {
  const connected = agentConnected(grant);
  return { type: "apc:pulse-status", connected, agentName: connected ? cleanName(name || grant!.client_name) : null };
}

/** What the landing is told when the hero has no agent to speak of: the sandbox ended, or its grant was revoked. */
export const NOT_CONNECTED: Extract<EmbedMessage, { type: "apc:pulse-status" }> = { type: "apc:pulse-status", connected: false, agentName: null };

/** An `apc:theme` from the parent, or null for anything else (another origin, another window, another shape). */
export function themeFrom(event: { origin: string; source: unknown; data: unknown }, parentOrigin: string | null, parent: unknown): Scheme | null {
  if (!parentOrigin || event.origin !== parentOrigin || event.source !== parent || event.source === null) return null;
  const data = event.data as { type?: unknown; scheme?: unknown } | null;
  if (!data || typeof data !== "object" || data.type !== "apc:theme") return null;
  return data.scheme === "light" || data.scheme === "dark" ? data.scheme : null;
}

/** Posts to the parent, at its origin only. Nothing when the view has no parent origin or is not framed. */
export function createPoster(parentOrigin: string | null, target: { postMessage(message: unknown, targetOrigin: string): void } | null) {
  let readySent = false;
  let lastStatus = "";
  let lastHeight = -1;
  const send = (message: EmbedMessage) => {
    if (parentOrigin && target) target.postMessage(message, parentOrigin);
  };
  return {
    /** Once per page, however often it is called (React StrictMode runs an effect twice). */
    ready: () => {
      if (readySent) return;
      readySent = true;
      send({ type: "apc:embed-ready" });
    },
    /** Sent the first time, then only when `connected` or `agentName` changed. */
    status: (status: Extract<EmbedMessage, { type: "apc:pulse-status" }>) => {
      const key = JSON.stringify([status.connected, status.agentName]);
      if (key === lastStatus) return;
      lastStatus = key;
      send(status);
    },
    resize: (height: number) => {
      const h = Math.ceil(height);
      if (!Number.isFinite(h) || h <= 0 || h === lastHeight) return;
      lastHeight = h;
      send({ type: "apc:embed-resize", height: h });
    },
  };
}
