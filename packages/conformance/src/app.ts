import { APC_JSON_MAX_BYTES, APC_JSON_PATH, APC_STANDARD_VERSION } from "@tineira/apc-protocol";
import { ConformanceError, isObject } from "./shared.ts";

export type StandInApcJsonMode =
  | "ok"
  | "missing"
  | "redirect"
  | "opaque_redirect"
  | "not_json"
  | "missing_fields"
  | "too_large"
  | "wrong_origin"
  | "no_dock"
  | "bad_mcp_path"
  | "endpoints_no_dock"
  | "error_503"
  | "network_error";

export type StandInMcpMode = "ok" | "redirect" | "not_found" | "error_500" | "hold_initialize";
export type StandInRevokeMode = "ok" | "redirect" | "slow";

export interface StandInAppOptions {
  origin?: string;
  redirectOrigin?: string;
  name?: string;
  mcpPath?: string;
  revokePath?: string;
  apcVersion?: string;
  apcJsonMode?: StandInApcJsonMode;
  mcpMode?: StandInMcpMode;
  revokeMode?: StandInRevokeMode;
  serverName?: string;
  serverVersion?: string;
}

export interface StandInAppCall {
  url: string;
  method: string;
  rpcMethod?: string;
  body: Record<string, unknown>;
}

export interface StandInApp {
  readonly origin: string;
  readonly redirectOrigin: string;
  readonly name: string;
  readonly revokeUrl: string;
  apcJsonMode: StandInApcJsonMode;
  mcpMode: StandInMcpMode;
  revokeMode: StandInRevokeMode;
  apcJsonReads: number;
  readonly calls: StandInAppCall[];
  readonly bodies: Array<{ url: string; text: string }>;
  readonly revokes: string[];
  readonly revokedUrls: Set<string>;
  readonly redirectHits: string[];
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  mintGrantUrl(secret?: string): string;
  waitForInitialize(timeoutMs?: number): Promise<void>;
  releaseInitialize(): void;
  releaseRevoke(): void;
  reset(): void;
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input !== "string" && !(input instanceof URL) && input.method) return input.method.toUpperCase();
  return "GET";
}

function resolveRedirectMode(input: RequestInfo | URL, init?: RequestInit): RequestRedirect {
  if (init?.redirect) return init.redirect;
  if (typeof input !== "string" && !(input instanceof URL) && input.redirect) return input.redirect;
  return "follow";
}

async function resolveRequestText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") return init.body;
    if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
      return new TextDecoder().decode(init.body);
    }
    return String(init.body);
  }
  if (typeof input !== "string" && !(input instanceof URL)) {
    return await input.clone().text();
  }
  return "";
}

/**
 * Stand-in APC app used by `hubConformance` to test a hub without running a
 * real app server. Mirrors `standInHub` in `./hub.ts`.
 */
export function standInApp(options: StandInAppOptions = {}): StandInApp {
  const origin = new URL(options.origin ?? "https://app.example").origin;
  const redirectOrigin = new URL(options.redirectOrigin ?? "https://elsewhere.example").origin;
  const name = options.name ?? "StandInApp";
  const mcpPath = options.mcpPath ?? "/mcp/";
  const revokePath = options.revokePath ?? "/apc/revoke";
  const apcVersion = options.apcVersion ?? APC_STANDARD_VERSION;
  const serverName = options.serverName ?? "stand-in-app";
  const serverVersion = options.serverVersion ?? "0.1.0";
  const revokeUrl = `${origin}${revokePath}`;

  let grantSeq = 0;
  let pendingRevokes: Array<() => void> = [];
  let pendingInitializes: Array<() => void> = [];
  let initializeWaiters: Array<() => void> = [];

  const app: StandInApp = {
    origin,
    redirectOrigin,
    name,
    revokeUrl,
    apcJsonMode: options.apcJsonMode ?? "ok",
    mcpMode: options.mcpMode ?? "ok",
    revokeMode: options.revokeMode ?? "ok",
    apcJsonReads: 0,
    calls: [],
    bodies: [],
    revokes: [],
    revokedUrls: new Set<string>(),
    redirectHits: [],

    mintGrantUrl(secret?: string): string {
      grantSeq += 1;
      const suffix = secret ?? `g${String(grantSeq).padStart(15, "0")}`;
      return `${origin}${mcpPath}${suffix}`;
    },

    waitForInitialize(timeoutMs = 1000): Promise<void> {
      if (pendingInitializes.length > 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        let done = false;
        const onArrive = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          initializeWaiters = initializeWaiters.filter((w) => w !== onArrive);
          reject(new ConformanceError(`timed out after ${timeoutMs} ms waiting for held MCP initialize`));
        }, timeoutMs);
        initializeWaiters.push(onArrive);
      });
    },

    releaseInitialize(): void {
      const waiting = pendingInitializes;
      pendingInitializes = [];
      for (const resolve of waiting) resolve();
    },

    releaseRevoke(): void {
      const waiting = pendingRevokes;
      pendingRevokes = [];
      for (const resolve of waiting) resolve();
    },

    reset(): void {
      app.apcJsonReads = 0;
      app.calls.length = 0;
      app.bodies.length = 0;
      app.revokes.length = 0;
      app.revokedUrls.clear();
      app.redirectHits.length = 0;
      app.apcJsonMode = options.apcJsonMode ?? "ok";
      app.mcpMode = options.mcpMode ?? "ok";
      app.revokeMode = options.revokeMode ?? "ok";
      grantSeq = 0;
      initializeWaiters = [];
      app.releaseInitialize();
      app.releaseRevoke();
    },

    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = resolveRequestUrl(input);
      const parsed = new URL(url);
      const method = resolveRequestMethod(input, init);
      const redirectMode = resolveRedirectMode(input, init);

      // Requests to redirectOrigin happen when a hub follows a 3xx redirect
      // instead of passing `redirect: "manual"`.
      if (parsed.origin === redirectOrigin) {
        app.redirectHits.push(url);
        if (parsed.pathname === APC_JSON_PATH) {
          return jsonResponse({
            name,
            standard: apcVersion,
            origin: redirectOrigin,
            profiles: ["dock"],
            mcp: { path: mcpPath },
            dock_connect: `${redirectOrigin}/connect/dock`,
          });
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      }

      if (parsed.origin !== origin) {
        return jsonResponse({ error: "unexpected_origin", url }, 404);
      }

      if (parsed.pathname === APC_JSON_PATH && method === "GET") {
        app.apcJsonReads += 1;
        return handleApcJson(app, parsed, redirectMode, { apcVersion, name, mcpPath, revokeUrl });
      }

      if (parsed.pathname === "/connect/dock" && method === "GET") {
        return new Response("<!doctype html><html><body>Connect</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" },
        });
      }

      if (parsed.pathname === revokePath && method === "POST") {
        return await handleRevoke(app, url, init, input, redirectMode, pendingRevokes);
      }

      if (parsed.pathname.startsWith(mcpPath) && method === "POST") {
        return await handleMcp(app, url, init, input, redirectMode, {
          serverName,
          serverVersion,
          pendingInitializes,
          initializeWaiters,
        });
      }

      return jsonResponse({ error: "not_found", path: parsed.pathname }, 404);
    },
  };

  return app;
}

function handleApcJson(
  app: StandInApp,
  parsed: URL,
  redirectMode: RequestRedirect,
  meta: { apcVersion: string; name: string; mcpPath: string; revokeUrl: string },
): Response {
  const validManifest = {
    name: meta.name,
    standard: meta.apcVersion,
    origin: app.origin,
    profiles: ["dock"],
    mcp: { path: meta.mcpPath },
    dock_connect: `${app.origin}/connect/dock`,
  };

  switch (app.apcJsonMode) {
    case "ok":
      return jsonResponse(validManifest);
    case "missing":
      return new Response("Not found", { status: 404 });
    case "error_503":
      return new Response("Service unavailable", { status: 503 });
    case "network_error":
      throw new TypeError("Simulated network failure reading apc.json");
    case "redirect": {
      const target = `${app.redirectOrigin}${parsed.pathname}`;
      if (redirectMode === "error") {
        throw new TypeError(`Refused redirect fetching ${parsed.toString()}`);
      }
      if (redirectMode !== "manual") {
        app.redirectHits.push(target);
        return jsonResponse(validManifest);
      }
      return new Response(null, { status: 302, headers: { location: target } });
    }
    case "opaque_redirect": {
      const target = `${app.redirectOrigin}${parsed.pathname}`;
      if (redirectMode === "error") {
        throw new TypeError(`Refused redirect fetching ${parsed.toString()}`);
      }
      if (redirectMode !== "manual") {
        app.redirectHits.push(target);
        return jsonResponse(validManifest);
      }
      return {
        ok: false,
        status: 0,
        statusText: "",
        type: "opaqueredirect",
        redirected: false,
        url: parsed.toString(),
        headers: new Headers(),
        text: async () => "",
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      } as unknown as Response;
    }
    case "not_json":
      return new Response("<html><body>Not APC</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    case "missing_fields":
      return jsonResponse({ name: meta.name });
    case "too_large":
      return jsonResponse({ ...validManifest, pad: "x".repeat(APC_JSON_MAX_BYTES + 256) });
    case "wrong_origin":
      return jsonResponse({
        ...validManifest,
        origin: app.redirectOrigin,
      });
    case "no_dock":
      return jsonResponse({
        name: meta.name,
        standard: meta.apcVersion,
        origin: app.origin,
        profiles: ["direct"],
        mcp: { path: meta.mcpPath },
        direct: { connect: `${app.origin}/?connect` },
      });
    case "bad_mcp_path":
      return jsonResponse({
        ...validManifest,
        mcp: { path: "/other/" },
      });
    case "endpoints_no_dock":
      return jsonResponse({
        ...validManifest,
        mcp: {
          path: meta.mcpPath,
          endpoints: [{ path: `${meta.mcpPath}{secret}`, profiles: ["direct"] }],
        },
      });
  }
}

async function handleRevoke(
  app: StandInApp,
  url: string,
  init: RequestInit | undefined,
  input: RequestInfo | URL,
  redirectMode: RequestRedirect,
  pendingRevokes: Array<() => void>,
): Promise<Response> {
  const text = await resolveRequestText(input, init);
  app.bodies.push({ url, text });
  let parsedBody: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(text);
    if (isObject(raw)) parsedBody = raw;
  } catch {
    return jsonResponse({ ok: false, error: "bad_json" }, 400);
  }
  app.calls.push({ url, method: "POST", body: parsedBody });

  if (app.revokeMode === "redirect") {
    const target = `${app.redirectOrigin}/apc/revoke`;
    if (redirectMode === "error") {
      throw new TypeError(`Refused redirect posting ${url}`);
    }
    if (redirectMode !== "manual") {
      app.redirectHits.push(target);
      if (typeof parsedBody.mcp_url === "string") {
        app.revokes.push(parsedBody.mcp_url);
        app.revokedUrls.add(parsedBody.mcp_url);
      }
      return jsonResponse({ ok: true });
    }
    return new Response(null, { status: 302, headers: { location: target } });
  }

  if (app.revokeMode === "slow") {
    await new Promise<void>((resolve) => {
      pendingRevokes.push(resolve);
    });
  }

  if (typeof parsedBody.mcp_url === "string") {
    app.revokes.push(parsedBody.mcp_url);
    app.revokedUrls.add(parsedBody.mcp_url);
  }
  return jsonResponse({ ok: true });
}

async function handleMcp(
  app: StandInApp,
  url: string,
  init: RequestInit | undefined,
  input: RequestInfo | URL,
  redirectMode: RequestRedirect,
  opts: {
    serverName: string;
    serverVersion: string;
    pendingInitializes: Array<() => void>;
    initializeWaiters: Array<() => void>;
  },
): Promise<Response> {
  const text = await resolveRequestText(input, init);
  app.bodies.push({ url, text });
  let parsedBody: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(text);
    if (isObject(raw)) parsedBody = raw;
  } catch {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const rpcMethod = typeof parsedBody.method === "string" ? parsedBody.method : undefined;
  app.calls.push({ url, method: "POST", rpcMethod, body: parsedBody });

  if (app.revokedUrls.has(url) || app.mcpMode === "not_found") {
    return jsonResponse({ error: "not_found" }, 404);
  }
  if (app.mcpMode === "error_500") {
    return jsonResponse({ error: "internal_error" }, 500);
  }
  if (app.mcpMode === "redirect") {
    const target = `${app.redirectOrigin}/mcp/redirected`;
    if (redirectMode === "error") {
      throw new TypeError(`Refused redirect posting ${url}`);
    }
    if (redirectMode !== "manual") {
      app.redirectHits.push(target);
      return jsonResponse({
        jsonrpc: "2.0",
        id: parsedBody.id ?? 1,
        result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: opts.serverName, version: opts.serverVersion } },
      });
    }
    return new Response(null, { status: 302, headers: { location: target } });
  }

  const id = parsedBody.id ?? 1;
  if (rpcMethod === "initialize") {
    if (app.mcpMode === "hold_initialize") {
      await new Promise<void>((resolve) => {
        opts.pendingInitializes.push(resolve);
        const waiters = opts.initializeWaiters.splice(0);
        for (const notify of waiters) notify();
      });
    }
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: opts.serverName, version: opts.serverVersion },
        },
      },
      200,
      { "mcp-session-id": "stand-in-session" },
    );
  }
  if (rpcMethod === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (rpcMethod === "tools/list") {
    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: { tools: [{ name: "apc_view", inputSchema: { type: "object" } }] },
    });
  }
  if (rpcMethod === "tools/call") {
    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  }
  return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}
