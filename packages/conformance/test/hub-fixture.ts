import {
  APC_JSON_MAX_BYTES,
  APC_JSON_PAIRING_MAX_AGE_S,
  APC_JSON_PATH,
  decodeApcConnect,
  declaresMcpUrl,
  encodeApcConnect,
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
import type {
  ApcHubAdapter,
  ApcHubApproveConnectResult,
  ApcHubApproveResult,
  ApcHubPendingConnect,
} from "../src/index.ts";

export type HubBreak =
  | "accepts-bad-apc-json"
  | "ignores-mcp-path"
  | "ignores-mcp-endpoints"
  | "stale-apc-json"
  | "stale-apc-json-network"
  | "spends-ticket-on-malformed-body"
  | "accepts-codeless"
  | "returns-201-on-pair"
  | "returns-201-on-confirm"
  | "echoes-pairing-code"
  | "echoes-code-in-pending-confirm"
  | "no-owner-code-normalization"
  | "no-revoke-on-fifth-wrong"
  | "mcp-before-approval"
  | "mcp-on-agent-call-before-approval"
  | "counts-code-while-approving"
  | "confirm-does-not-expire"
  | "does-not-replace-pending"
  | "replaces-approving"
  | "sync-revoke-on-replace"
  | "deletes-ended-tombstone"
  | "follows-redirects"
  | "accepts-drop-ticket-on-pair"
  | "spends-drop-ticket-on-pair"
  | "ignores-connect-ticket-origin"
  | "spends-mismatched-connect-ticket"
  | "unauth-approve-exposes-ticket"
  | "no-owner-csrf"
  | "preapproval-ticket-leak"
  | "preapproval-ticket-leak-nested"
  | "preapproval-ticket-leak-fragment"
  | "state-exposes-connect-ticket"
  | "double-approve-mints-ticket";

interface StoredPairing {
  id: string;
  agent: string;
  origin: string;
  mcpUrl: string;
  revokeUrl: string;
  code: string;
  attempts: number;
  expiresAt: number;
  status: "pending" | "approving" | "paired" | "ended";
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
export function hubFixture(
  options: {
    broken?: HubBreak;
    redirectPolicy?: "manual" | "error";
    requiresPairingCode?: boolean;
    codelessPolicyNote?: string;
  } = {},
): ApcHubAdapter {
  const broken = options.broken;
  const redirectPolicy = options.redirectPolicy ?? "manual";
  const origin = "https://fixture-hub.example";
  const defaultAgent = "AgentA";

  let now = 1_700_000_000_000;
  let seq = 0;
  const tickets = new Map<string, { agent: string; expiresAt: number }>();
  const connectRequests = new Map<string, { id: string; agent: string; origin: string; dockConnect: string; expiresAt: number }>();
  const connectTickets = new Map<string, { agent: string; origin: string; expiresAt: number }>();
  const exposedTickets: string[] = [];
  const pairings = new Map<string, StoredPairing>();
  const manifestCache = new Map<string, { manifest: ApcManifest; readAt: number }>();
  const inflight: Array<Promise<unknown>> = [];

  function track(promise: Promise<unknown>): void {
    const wrapped = promise.catch(() => undefined);
    inflight.push(wrapped);
  }

  function redirectMode(): RequestRedirect {
    return broken === "follows-redirects" ? "follow" : redirectPolicy;
  }

  function giveBack(revokeUrl: string, mcpUrl: string): Promise<void> {
    return fetch(revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp_url: mcpUrl }),
      redirect: redirectMode(),
    }).then(
      () => undefined,
      () => undefined,
    );
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
    try {
      const res = await fetch(`${appOrigin}${APC_JSON_PATH}`, { redirect: redirectMode() });
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
      if ((broken === "stale-apc-json" || broken === "stale-apc-json-network") && cached) {
        return { ok: true, manifest: cached.manifest };
      }
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

  function issueConnectTicket(agent: string, appOrigin: string): string {
    seq += 1;
    const hex = seq.toString(16).padStart(32, "0");
    const t = `${hex}.${hex}`;
    connectTickets.set(t, { agent, origin: appOrigin, expiresAt: now + TICKET_TTL_MS });
    return t;
  }

  const adapter: ApcHubAdapter = {
    name: broken ? `FixtureHub(${broken})` : "FixtureHub",
    origin,
    agent: defaultAgent,
    requiresPairingCode: options.requiresPairingCode ?? true,
    ...(options.codelessPolicyNote !== undefined ? { codelessPolicyNote: options.codelessPolicyNote } : {}),

    ticket(agent: string): string {
      return issueTicket(agent);
    },

    async pairingTicket(agent: string, appOrigin: string): Promise<string> {
      const dropTicket = issueTicket(agent);
      const res = await adapter.fetch(`${origin}/apc/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket: dropTicket,
          agent,
          app: { origin: appOrigin, name: "StandInApp" },
        }),
      });
      if (!res.ok) {
        throw new Error(`fixture /apc/connect failed: ${res.status} ${await res.text()}`);
      }
      const pending = await adapter.pendingConnects!();
      const cr = [...pending].reverse().find((c) => c.agent === agent && c.origin === appOrigin);
      if (!cr) {
        throw new Error("fixture pendingConnects did not record connect request");
      }
      const approved = await adapter.approveConnect!(cr.id);
      if (!approved.ok || !approved.url) {
        throw new Error(`fixture approveConnect failed: ${approved.error ?? "missing url"}`);
      }
      const decoded = decodeApcConnect(new URL(approved.url).hash);
      if (!decoded?.ticket) {
        throw new Error("fixture approveConnect url missing #apc-connect ticket");
      }
      return decoded.ticket;
    },

    pendingConnects(): ApcHubPendingConnect[] {
      return [...connectRequests.values()]
        .filter((c) => c.expiresAt >= now)
        .map((c) => ({ id: c.id, agent: c.agent, origin: c.origin }));
    },

    async approveConnect(id: string): Promise<ApcHubApproveConnectResult> {
      const res = await adapter.ownerFetch!(`${origin}/owner/connects/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
        body: "{}",
      });
      const body = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      return {
        ok: Boolean(body.ok),
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(typeof body.error === "string" ? { error: body.error } : {}),
      };
    },

    connectApproveEndpoint(id: string): { path: string; method: string; body: unknown } {
      return { path: `/owner/connects/${id}/approve`, method: "POST", body: {} };
    },

    ownerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      request.headers.set("x-hub-owner", "owner-secret");
      return adapter.fetch(request);
    },

    observeState(): unknown {
      return {
        pairings: [...pairings.values()].map((p) => ({
          id: p.id,
          agent: p.agent,
          origin: p.origin,
          status: p.status,
        })),
        pendingConnects: [...connectRequests.values()].map((c) => ({
          id: c.id,
          agent: c.agent,
          origin: c.origin,
        })),
        ...(exposedTickets.length > 0 ? { exposedTickets: [...exposedTickets] } : {}),
      };
    },

    advance(ms: number): void {
      now += ms;
    },

    reset(): void {
      seq = 0;
      tickets.clear();
      connectRequests.clear();
      connectTickets.clear();
      exposedTickets.length = 0;
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

    async exerciseAgent(agent: string): Promise<void> {
      const targets = [...pairings.values()].filter((p) => {
        if (p.agent !== agent) return false;
        if (broken === "mcp-on-agent-call-before-approval") {
          return p.status === "pending" || p.status === "approving" || p.status === "paired";
        }
        return p.status === "paired";
      });
      for (const p of targets) {
        try {
          const res = await fetch(p.mcpUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
            redirect: redirectMode(),
          });
          if (res.status === 404) {
            if (broken === "deletes-ended-tombstone") {
              pairings.delete(p.id);
            } else {
              p.status = "ended";
            }
          }
        } catch {
          // Network error during agent relay does not end the pairing here.
        }
      }
    },

    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      const url = new URL(request.url);
      let body: Record<string, unknown> | null = null;
      try {
        const text = await request.text();
        const raw: unknown = text ? JSON.parse(text) : null;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) body = raw as Record<string, unknown>;
      } catch {
        body = null;
      }

      if (url.pathname === "/apc/connect") {
        if (!body) return jsonRes({ ok: false, error: "invalid" }, 400);
        const ticketStr = body.ticket;
        const agentStr = body.agent;
        const appObj = body.app && typeof body.app === "object" ? (body.app as Record<string, unknown>) : null;
        const appOrigin = typeof appObj?.origin === "string" ? appObj.origin : "";
        if (typeof ticketStr !== "string" || typeof agentStr !== "string" || !appOrigin) {
          return jsonRes({ ok: false, error: "invalid" }, 400);
        }
        const storedTicket = tickets.get(ticketStr);
        tickets.delete(ticketStr);
        if (!storedTicket || storedTicket.expiresAt < now || storedTicket.agent !== agentStr) {
          return jsonRes({ ok: false, error: "ticket_expired" }, 400);
        }
        const read = await readManifest(appOrigin);
        if (!read.ok) return jsonRes({ ok: false, error: read.error }, 400);
        if (!read.manifest.profiles.includes("dock")) return jsonRes({ ok: false, error: "dock_not_offered" }, 400);
        if (!read.manifest.dock_connect) return jsonRes({ ok: false, error: "dock_connect_missing" }, 400);
        let dockConnectUrl: URL;
        try {
          dockConnectUrl = new URL(read.manifest.dock_connect);
        } catch {
          return jsonRes({ ok: false, error: "dock_connect_invalid" }, 400);
        }
        if (dockConnectUrl.origin !== appOrigin || dockConnectUrl.hash) {
          return jsonRes({ ok: false, error: "dock_connect_invalid" }, 400);
        }
        const id = `conn_${++seq}`;
        connectRequests.set(id, {
          id,
          agent: agentStr,
          origin: appOrigin,
          dockConnect: dockConnectUrl.toString(),
          expiresAt: now + TICKET_TTL_MS,
        });
        // Mutants mint a usable, independent ticket before approval, leaving the owner flow unchanged.
        if (broken?.startsWith("preapproval-ticket-leak")) {
          const leaked = issueConnectTicket(agentStr, appOrigin);
          const fragment = encodeApcConnect({ v: 1, ticket: leaked, hub: origin, agent: agentStr });
          const extra = broken === "preapproval-ticket-leak-nested" ? { details: [{ credentials: { connect_ticket: leaked } }] }
            : broken === "preapproval-ticket-leak-fragment" ? { details: [{ link: `${dockConnectUrl.href}${fragment}` }] }
            : { connect_ticket: leaked };
          return jsonRes({ ok: true, status: "connect_requested", ...extra });
        }
        return jsonRes({ ok: true, status: "connect_requested" }, 200);
      }

      const approveMatch = url.pathname.match(/^\/owner\/connects\/([^/]+)\/approve$/);
      if (approveMatch) {
        const hasOwnerHeader = request.headers.get("x-hub-owner") === "owner-secret";
        if (!hasOwnerHeader && broken !== "unauth-approve-exposes-ticket") {
          return jsonRes({ ok: false, error: "unauthorized" }, 401);
        }
        if (broken !== "no-owner-csrf" && ((request.headers.has("origin") && request.headers.get("origin") !== origin)
          || ![null, "same-origin", "none"].includes(request.headers.get("sec-fetch-site")))) {
          return jsonRes({ ok: false, error: "forbidden" }, 403);
        }
        const id = decodeURIComponent(approveMatch[1]!);
        const cr = connectRequests.get(id);
        if (!cr || cr.expiresAt < now) {
          connectRequests.delete(id);
          return jsonRes({ ok: false, error: "connect_not_found" }, 404);
        }
        if (broken !== "double-approve-mints-ticket") {
          connectRequests.delete(id);
        }
        const connectTicket = issueConnectTicket(cr.agent, cr.origin);
        if (broken === "state-exposes-connect-ticket") {
          exposedTickets.push(connectTicket);
        }
        const fragment = encodeApcConnect({
          v: 1,
          ticket: connectTicket,
          hub: origin,
          agent: cr.agent,
        });
        return jsonRes({ ok: true, url: `${cr.dockConnect}${fragment}` }, 200);
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
          connectTickets.delete(ticketStr);
        }

        if (typeof ticketStr !== "string" || typeof agentStr !== "string" || typeof mcpUrl !== "string" || !appName || !appOrigin) {
          return jsonRes({ ok: false, error: "invalid" }, 400);
        }
        let normalizedCode: string | null = null;
        if (body.pairing_code === undefined) {
          if (broken !== "accepts-codeless") {
            return jsonRes({ ok: false, error: "pairing_code_required" }, 400);
          }
          normalizedCode = "";
        } else {
          normalizedCode = normalizePairingCode(body.pairing_code);
          if (!normalizedCode) {
            return jsonRes({ ok: false, error: "invalid_pairing_code" }, 400);
          }
        }

        if (tickets.has(ticketStr)) {
          const dropTicket = tickets.get(ticketStr)!;
          if (broken !== "accepts-drop-ticket-on-pair") {
            if (broken === "spends-drop-ticket-on-pair") {
              tickets.delete(ticketStr);
            }
            return jsonRes({ ok: false, error: "ticket_not_for_pairing" }, 400);
          }
          tickets.delete(ticketStr);
          if (dropTicket.expiresAt < now || dropTicket.agent !== agentStr) {
            return jsonRes({ ok: false, error: "ticket_expired" }, 400);
          }
        } else {
          const storedConnect = connectTickets.get(ticketStr);
          if (!storedConnect || storedConnect.expiresAt < now) {
            connectTickets.delete(ticketStr);
            return jsonRes({ ok: false, error: "ticket_expired" }, 400);
          }
          if ((storedConnect.agent !== agentStr || storedConnect.origin !== appOrigin) && broken !== "ignores-connect-ticket-origin") {
            if (broken === "spends-mismatched-connect-ticket") {
              connectTickets.delete(ticketStr);
            }
            return jsonRes({ ok: false, error: "ticket_origin_mismatch" }, 400);
          }
          connectTickets.delete(ticketStr);
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
          if (broken === "ignores-mcp-path") {
            // Only checks same origin, ignoring mcp.path.
            if (!mcpUrl.startsWith(appOrigin)) {
              return jsonRes({ ok: false, error: "mcp_url_not_declared" }, 400);
            }
          } else if (broken === "ignores-mcp-endpoints") {
            // Validates only mcp.path, ignoring mcp.endpoints profile restriction.
            const pathPrefix = read.manifest.mcp.path;
            if (!pathPrefix || !mcpUrl.startsWith(`${appOrigin}${pathPrefix}`)) {
              return jsonRes({ ok: false, error: "mcp_url_not_declared" }, 400);
            }
          } else if (!declaresMcpUrl(read.manifest, mcpUrl, { profile: "dock" })) {
            return jsonRes({ ok: false, error: "mcp_url_not_declared" }, 400);
          }
          manifest = read.manifest;
        }
        void manifest;

        expireOverdue();

        for (const [eid, existing] of [...pairings]) {
          if (existing.agent === agentStr && existing.origin === appOrigin && existing.status === "ended") {
            pairings.delete(eid);
          }
        }

        if (broken !== "does-not-replace-pending") {
          for (const [pid, existing] of [...pairings]) {
            const matchesStatus =
              existing.status === "pending" || (broken === "replaces-approving" && existing.status === "approving");
            if (existing.agent === agentStr && existing.origin === appOrigin && matchesStatus) {
              pairings.delete(pid);
              if (existing.mcpUrl !== mcpUrl) {
                if (broken === "sync-revoke-on-replace") {
                  await giveBack(existing.revokeUrl, existing.mcpUrl);
                } else {
                  track(giveBack(existing.revokeUrl, existing.mcpUrl));
                }
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

        return jsonRes(
          {
            ok: true,
            pairing_id: id,
            status: "pending",
            agent: { name: `${agentStr} via dock`, icon: null },
            pairing_code: broken === "echoes-pairing-code" ? normalizedCode : PAIRING_CODE_ACK,
            binding: PAIRING_BINDING,
          },
          broken === "returns-201-on-pair" ? 201 : 200,
        );
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
        return jsonRes(
          {
            ok: true,
            status: match.status === "approving" ? "pending" : match.status,
            agent: { name: `${body.agent} via dock`, icon: null },
            ...(broken === "echoes-code-in-pending-confirm" && match.status === "pending"
              ? { pairing_code: match.code }
              : {}),
          },
          broken === "returns-201-on-confirm" ? 201 : 200,
        );
      }

      return jsonRes({ ok: false, error: "not_found" }, 404);
    },

    async approve(id: string, code?: string): Promise<ApcHubApproveResult> {
      expireOverdue();
      const p = pairings.get(id);
      if (!p) return { ok: false, error: "unknown_pairing" };
      if (p.status === "ended") return { ok: false, error: PAIRING_ENDED_ERROR };
      if (p.status === "approving") {
        if (broken === "counts-code-while-approving") {
          const normalized = normalizePairingCode(code);
          if (normalized && !pairingCodesMatch(p.code, normalized)) {
            p.attempts += 1;
            if (p.attempts >= PAIRING_CODE_MAX_ATTEMPTS) {
              pairings.delete(id);
              await giveBack(p.revokeUrl, p.mcpUrl);
              return { ok: false, error: "pairing_code_refused" };
            }
          }
        }
        return { ok: false, error: "approving" };
      }
      if (p.status !== "pending") return { ok: false, error: "unknown_pairing" };

      const normalized = normalizePairingCode(code);
      if (!normalized) return { ok: false, error: "invalid_pairing_code" };

      const matched =
        broken === "no-owner-code-normalization"
          ? typeof code === "string" && p.code === code.trim().toUpperCase()
          : pairingCodesMatch(p.code, normalized);

      if (!matched) {
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

      p.status = "approving";

      let initRes: Response;
      try {
        initRes = await fetch(p.mcpUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-hub", version: "0.1.0" } },
          }),
          redirect: redirectMode(),
        });
      } catch {
        const nowP = pairings.get(id);
        if (nowP && nowP.status === "approving") nowP.status = "pending";
        return { ok: false, error: "app_unreachable" };
      }

      if (broken !== "follows-redirects" && ((initRes.status >= 300 && initRes.status < 400) || initRes.type === "opaqueredirect" || initRes.redirected)) {
        const nowP = pairings.get(id);
        if (nowP && nowP.status === "approving") nowP.status = "pending";
        return { ok: false, error: "app_redirect" };
      }

      if (initRes.status === 404) {
        if (broken === "deletes-ended-tombstone") {
          pairings.delete(id);
        } else {
          p.status = "ended";
        }
        return { ok: false, error: PAIRING_ENDED_ERROR };
      }

      if (!initRes.ok) {
        const nowP = pairings.get(id);
        if (nowP && nowP.status === "approving") nowP.status = "pending";
        return { ok: false, error: "app_unreachable" };
      }

      const settled = pairings.get(id);
      if (!settled || settled.status !== "approving") {
        return { ok: false, error: "unknown_pairing" };
      }
      settled.status = "paired";
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
