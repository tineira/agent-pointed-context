import {
  APC_JSON_MAX_BYTES,
  APC_JSON_PAIRING_MAX_AGE_S,
  APC_JSON_PATH,
  declaresMcpUrl,
  normalizePairingCode,
  PAIRING_BINDING,
  PAIRING_CODE_ACK,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_TTL_MS,
  PAIRING_ENDED_ERROR,
  pairingCodesMatch,
  parseApcManifest,
  TICKET_TTL_MS,
  type ApcManifest,
} from "@tineira/apc-protocol";
import type { ApcHubAdapter, ApcHubApproveResult } from "../src/index.ts";

export type HubBreak =
  | "accepts-bad-apc-json"
  | "stale-apc-json"
  | "spends-ticket-on-malformed-body"
  | "echoes-pairing-code"
  | "no-revoke-on-fifth-wrong"
  | "mcp-before-approval"
  | "confirm-does-not-expire"
  | "does-not-replace-pending"
  | "revokes-after-404"
  | "follows-redirects";

interface StoredPairing {
  id: string;
  agent: string;
  origin: string;
  mcpUrl: string;
  revokeUrl: string;
  code: string;
  attempts: number;
  expiresAt: number;
  status: "pending" | "paired" | "ended";
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Minimal in-process conforming hub fixture (with `HubBreak` fault injection)
 * used by `hub-conformance.test.ts` to verify both passes and failure detection.
 */
export function hubFixture(options: { broken?: HubBreak } = {}): ApcHubAdapter {
  const broken = options.broken;
  const origin = "https://fixture-hub.example";
  const defaultAgent = "AgentA";

  let now = 1_700_000_000_000;
  let seq = 0;
  const tickets = new Map<string, { agent: string; expiresAt: number }>();
  const pairings = new Map<string, StoredPairing>();
  const manifestCache = new Map<string, { manifest: ApcManifest; readAt: number }>();
  const inflight: Array<Promise<unknown>> = [];

  function track(promise: Promise<unknown>): void {
    const wrapped = promise.catch(() => undefined);
    inflight.push(wrapped);
  }

  function giveBack(revokeUrl: string, mcpUrl: string): Promise<void> {
    const redirect: RequestRedirect = broken === "follows-redirects" ? "follow" : "manual";
    return fetch(revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp_url: mcpUrl }),
      redirect,
    }).then(() => undefined);
  }

  function expireOverdue(): void {
    for (const [id, p] of pairings) {
      if (p.status === "pending" && p.expiresAt <= now) {
        pairings.delete(id);
        track(giveBack(p.revokeUrl, p.mcpUrl));
      }
    }
  }

  async function readManifest(appOrigin: string): Promise<{ ok: true; manifest: ApcManifest } | { ok: false; error: string }> {
    const cached = manifestCache.get(appOrigin);
    if (cached && now - cached.readAt <= APC_JSON_PAIRING_MAX_AGE_S * 1000) {
      return { ok: true, manifest: cached.manifest };
    }
    const redirect: RequestRedirect = broken === "follows-redirects" ? "follow" : "manual";
    try {
      const res = await fetch(`${appOrigin}${APC_JSON_PATH}`, { redirect });
      if (broken !== "follows-redirects" && ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect" || res.redirected)) {
        manifestCache.delete(appOrigin);
        return { ok: false, error: "apc_json_redirect" };
      }
      if (!res.ok) {
        if (broken === "stale-apc-json" && cached) return { ok: true, manifest: cached.manifest };
        manifestCache.delete(appOrigin);
        return { ok: false, error: "apc_json_unreachable" };
      }
      const text = await res.text();
      if (new TextEncoder().encode(text).byteLength > APC_JSON_MAX_BYTES) {
        manifestCache.delete(appOrigin);
        return { ok: false, error: "apc_json_too_large" };
      }
      const raw: unknown = JSON.parse(text);
      const parsed = parseApcManifest(raw, appOrigin);
      if (!parsed.ok) {
        manifestCache.delete(appOrigin);
        return { ok: false, error: parsed.error };
      }
      manifestCache.set(appOrigin, { manifest: parsed.manifest, readAt: now });
      return { ok: true, manifest: parsed.manifest };
    } catch {
      if (broken === "stale-apc-json" && cached) return { ok: true, manifest: cached.manifest };
      manifestCache.delete(appOrigin);
      return { ok: false, error: "apc_json_unreachable" };
    }
  }

  function issueTicket(agent: string): string {
    seq += 1;
    const hex = seq.toString(16).padStart(32, "0");
    const t = `${hex}.${hex}`;
    tickets.set(t, { agent, expiresAt: now + TICKET_TTL_MS });
    return t;
  }

  const adapter: ApcHubAdapter = {
    name: broken ? `FixtureHub(${broken})` : "FixtureHub",
    origin,
    agent: defaultAgent,

    ticket(agent: string): string {
      return issueTicket(agent);
    },

    pairingTicket(agent: string, _origin: string): string {
      return issueTicket(agent);
    },

    advance(ms: number): void {
      now += ms;
    },

    reset(): void {
      seq = 0;
      tickets.clear();
      pairings.clear();
      manifestCache.clear();
      inflight.length = 0;
    },

    async idle(): Promise<void> {
      while (inflight.length > 0) {
        const batch = inflight.splice(0, inflight.length);
        await Promise.allSettled(batch);
      }
    },

    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      let body: Record<string, unknown> | null = null;
      try {
        const text = typeof init?.body === "string" ? init.body : "";
        const raw: unknown = text ? JSON.parse(text) : null;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) body = raw as Record<string, unknown>;
      } catch {
        body = null;
      }

      if (url.pathname === "/apc/pair") {
        if (!body) return jsonRes({ ok: false, error: "invalid" }, 400);
        const ticketStr = body.ticket;
        const agentStr = body.agent;
        const mcpUrl = body.mcp_url;
        const appObj = body.app && typeof body.app === "object" ? (body.app as Record<string, unknown>) : null;
        const appName = typeof appObj?.name === "string" ? appObj.name.trim() : "";
        const appOrigin = typeof appObj?.origin === "string" ? appObj.origin : "";

        if (broken === "spends-ticket-on-malformed-body" && typeof ticketStr === "string") {
          tickets.delete(ticketStr);
        }

        if (typeof ticketStr !== "string" || typeof agentStr !== "string" || typeof mcpUrl !== "string" || !appName || !appOrigin) {
          return jsonRes({ ok: false, error: "invalid" }, 400);
        }
        if (body.pairing_code === undefined) {
          return jsonRes({ ok: false, error: "pairing_code_required" }, 400);
        }
        const normalizedCode = normalizePairingCode(body.pairing_code);
        if (!normalizedCode) {
          return jsonRes({ ok: false, error: "invalid_pairing_code" }, 400);
        }

        const storedTicket = tickets.get(ticketStr);
        tickets.delete(ticketStr);
        if (!storedTicket || storedTicket.expiresAt < now || storedTicket.agent !== agentStr) {
          return jsonRes({ ok: false, error: "ticket_expired" }, 400);
        }

        let manifest: ApcManifest | null = null;
        if (broken === "accepts-bad-apc-json") {
          manifest = {
            standard: "0.12.0",
            name: appName,
            origin: appOrigin,
            profiles: ["dock"],
            mcp: { path: "/mcp/" },
          };
        } else {
          const read = await readManifest(appOrigin);
          if (!read.ok) return jsonRes({ ok: false, error: read.error }, 400);
          if (!read.manifest.profiles.includes("dock")) return jsonRes({ ok: false, error: "dock_not_offered" }, 400);
          if (!declaresMcpUrl(read.manifest, mcpUrl, { profile: "dock" })) {
            return jsonRes({ ok: false, error: "mcp_url_not_declared" }, 400);
          }
          manifest = read.manifest;
        }

        expireOverdue();

        for (const [eid, existing] of [...pairings]) {
          if (existing.agent === agentStr && existing.origin === appOrigin && (existing.status === "ended")) {
            pairings.delete(eid);
          }
        }

        if (broken !== "does-not-replace-pending") {
          for (const [pid, existing] of [...pairings]) {
            if (existing.agent === agentStr && existing.origin === appOrigin && existing.status === "pending") {
              pairings.delete(pid);
              if (existing.mcpUrl !== mcpUrl) {
                track(giveBack(existing.revokeUrl, existing.mcpUrl));
              }
            }
          }
        }

        seq += 1;
        const id = `pr_${seq.toString(16).padStart(16, "0")}`;
        pairings.set(id, {
          id,
          agent: agentStr,
          origin: appOrigin,
          mcpUrl,
          revokeUrl: `${appOrigin}/apc/revoke`,
          code: normalizedCode,
          attempts: 0,
          expiresAt: now + PAIRING_CODE_TTL_MS,
          status: "pending",
        });

        if (broken === "mcp-before-approval") {
          await fetch(mcpUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
          });
        }

        return jsonRes({
          ok: true,
          pairing_id: id,
          status: "pending",
          agent: { name: `${agentStr} via dock`, icon: null },
          pairing_code: broken === "echoes-pairing-code" ? normalizedCode : PAIRING_CODE_ACK,
          binding: PAIRING_BINDING,
        });
      }

      if (url.pathname === "/apc/confirm") {
        if (!body || typeof body.ticket !== "string" || typeof body.agent !== "string" || typeof body.mcp_url !== "string") {
          return jsonRes({ ok: false, error: "invalid" }, 400);
        }
        const storedTicket = tickets.get(body.ticket);
        if (!storedTicket || storedTicket.expiresAt < now || storedTicket.agent !== body.agent) {
          return jsonRes({ ok: false, error: "ticket_expired" }, 400);
        }
        if (broken !== "confirm-does-not-expire") {
          expireOverdue();
        }
        const match = [...pairings.values()].find((p) => p.agent === body.agent && p.mcpUrl === body.mcp_url && p.status !== "ended");
        if (!match) {
          return jsonRes({ ok: false, error: "not_paired" }, 400);
        }
        tickets.delete(body.ticket);
        return jsonRes({
          ok: true,
          status: match.status,
          agent: { name: `${body.agent} via dock`, icon: null },
        });
      }

      return jsonRes({ ok: false, error: "not_found" }, 404);
    },

    async approve(id: string, code?: string): Promise<ApcHubApproveResult> {
      expireOverdue();
      const p = pairings.get(id);
      if (!p || p.status !== "pending") return { ok: false, error: "unknown_pairing" };

      const normalized = normalizePairingCode(code);
      if (!normalized) return { ok: false, error: "invalid_pairing_code" };

      if (!pairingCodesMatch(p.code, normalized)) {
        p.attempts += 1;
        if (p.attempts >= PAIRING_CODE_MAX_ATTEMPTS) {
          pairings.delete(id);
          if (broken !== "no-revoke-on-fifth-wrong") {
            await giveBack(p.revokeUrl, p.mcpUrl);
          }
          return { ok: false, error: "pairing_code_refused" };
        }
        return { ok: false, error: "pairing_code_wrong", remaining: PAIRING_CODE_MAX_ATTEMPTS - p.attempts };
      }

      const redirect: RequestRedirect = broken === "follows-redirects" ? "follow" : "manual";
      const initRes = await fetch(p.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-hub", version: "0.1.0" } },
        }),
        redirect,
      });

      if (broken !== "follows-redirects" && ((initRes.status >= 300 && initRes.status < 400) || initRes.type === "opaqueredirect" || initRes.redirected)) {
        return { ok: false, error: "app_redirect" };
      }

      if (initRes.status === 404) {
        p.status = "ended";
        if (broken === "revokes-after-404") {
          await giveBack(p.revokeUrl, p.mcpUrl);
        }
        return { ok: false, error: PAIRING_ENDED_ERROR };
      }

      if (!initRes.ok) {
        return { ok: false, error: "app_unreachable" };
      }

      p.status = "paired";
      return { ok: true };
    },

    async deny(id: string): Promise<{ ok: boolean; error?: string }> {
      const p = pairings.get(id);
      if (!p) return { ok: false, error: "unknown_pairing" };
      pairings.delete(id);
      await giveBack(p.revokeUrl, p.mcpUrl);
      return { ok: true };
    },
  };

  return adapter;
}
