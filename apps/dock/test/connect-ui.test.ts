/**
 * APC 0.13 dock UI (TIN-916): ConnectRequest across surfaces (verified, unverified, reader, blocked
 * popup fallback), ConnectApp, PairingRequest with code field everywhere except pets, JoinRequests in
 * Float, and approveAndOpen with window.open mocked against both stubs and a real Hub DO.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { approveAndOpen, CODE_IN_DOCK, connectCheckErrorText, decisionNotice } from "../src/web/request-state.ts";
import { fakeApp, manifestOf, world } from "./hostile-world.ts";

test("request-state: connect approval & check errors produce clear copy", () => {
  assert.match(decisionNotice("not_found"), /no longer waiting/i);
  assert.match(decisionNotice("https_required"), /HTTPS/i);
  assert.match(decisionNotice("app_not_allowed"), /cannot connect to this app/i);
  assert.match(decisionNotice("reader_not_allowed"), /browser extension/i);
  assert.match(decisionNotice("unknown_agent"), /no longer in your dock/i);

  assert.match(connectCheckErrorText("apc_json_missing"), /apc\.json/i);
  assert.match(connectCheckErrorText("app_blocked"), /does not pair/i);
  assert.match(connectCheckErrorText("too_many_requests"), /too many/i);
  assert.match(connectCheckErrorText("https_required"), /HTTPS/i);
  assert.match(connectCheckErrorText("unreachable"), /Could not reach/i);
});

test("approveAndOpen: calls approve then window.open(url, _blank, noopener); returns blocked when null", async () => {
  const calls: Array<{ url: string; target: string; features: string }> = [];
  const url = "https://shop.example/connect/dock#apc_connect=tok";

  const opened = await approveAndOpen({
    approve: async () => ({ ok: true, url }),
    opener: {
      open(u, target, features) {
        calls.push({ url: u ?? "", target: target ?? "", features: features ?? "" });
        return { closed: false };
      },
    },
  });
  assert.deepEqual(opened, { status: "opened", url });
  assert.deepEqual(calls, [{ url, target: "_blank", features: "noopener" }]);

  const blocked = await approveAndOpen({
    approve: async () => ({ ok: true, url }),
    opener: { open: () => null },
  });
  assert.deepEqual(blocked, { status: "blocked", url });

  // Inside Dock for Windows (WebView2 on_new_window returns null after handing URL to OS browser).
  const desktopOpened = await approveAndOpen({
    approve: async () => ({ ok: true, url }),
    opener: { open: () => null },
    desktop: true,
  });
  assert.deepEqual(desktopOpened, { status: "opened", url });

  // Reader connect approves without opening any tab.
  let openCalls = 0;
  const reader = await approveAndOpen({
    approve: async () => ({ ok: true }),
    opener: {
      open() {
        openCalls++;
        return null;
      },
    },
  });
  assert.deepEqual(reader, { status: "paired" });
  assert.equal(openCalls, 0);

  // Error from hub does not attempt window.open.
  const failed = await approveAndOpen({
    approve: async () => ({ ok: false, error: "not_found" }),
    opener: {
      open() {
        openCalls++;
        return null;
      },
    },
  });
  assert.deepEqual(failed, { status: "error", error: "not_found" });
  assert.equal(openCalls, 0);
});

test("approveAndOpen against real Hub DO approveConnect with blocked and allowed window.open", async (t) => {
  const SHOP = "https://shop.example";
  const w = await world(t, { APP_ORIGINS: SHOP });
  const owner = String(w.hubRoom.db.prepare("select secret from devices").get()!.secret);
  const agent = (await w.agent()).id as string;
  w.apps.set(SHOP, fakeApp(SHOP, "Shop", { apcJson: () => Response.json(manifestOf(SHOP, "Shop", { standard: "0.13.0", dock_connect: `${SHOP}/connect/dock` })) }));

  const approveReal = async (openReturn: unknown) => {
    const { ticket } = await w.hub.ticket(agent);
    assert.equal((await w.hub.requestConnect({ ticket, agent, app: { origin: SHOP } })).ok, true);
    const id = (await w.state()).connects[0].id as string;
    const seen: Array<[string, string, string]> = [];
    const res = await approveAndOpen({
      approve: () => w.hub.asOwner(owner, "approveConnect", [id, undefined, "https://dock.test"]) as Promise<{ ok?: boolean; url?: string; error?: unknown }>,
      opener: {
        open(u, tgt, feat) {
          seen.push([u ?? "", tgt ?? "", feat ?? ""]);
          return openReturn;
        },
      },
    });
    return { res, seen };
  };

  const blocked = await approveReal(null);
  assert.equal(blocked.res.status, "blocked");
  assert.equal(blocked.seen.length, 1);
  assert.equal(blocked.seen[0]![1], "_blank");
  assert.equal(blocked.seen[0]![2], "noopener");
  assert.match(blocked.seen[0]![0], /^https:\/\/shop\.example\/connect\/dock#apc_connect=/);

  const opened = await approveReal({ closed: false });
  assert.equal(opened.res.status, "opened");
  assert.equal(opened.seen.length, 1);
});

// ---- SSR rendering of APC 0.13 components ----

type Vite = { ssrLoadModule(url: string): Promise<Record<string, unknown>>; close(): Promise<void> };
let vite: Vite;
let ssr: (comp: unknown, props: Record<string, unknown>) => string;
let ConnectRequest: unknown;
let ConnectApp: unknown;
let JoinRequests: unknown;
let AgentPage: unknown;
let PetView: unknown;
let PairingRequest: unknown;

let restoredGlobals: (() => void) | null = null;

before(async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWin = g.window;
  const prevLoc = g.location;
  if (!g.window) g.window = {};
  if (!g.location) g.location = { search: "", origin: "https://dock.test", href: "https://dock.test/dock" };
  restoredGlobals = () => {
    if (prevWin === undefined) delete g.window;
    else g.window = prevWin;
    if (prevLoc === undefined) delete g.location;
    else g.location = prevLoc;
  };
  const { createServer } = await import("vite");
  vite = (await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    oxc: { jsx: { runtime: "automatic" } },
  } as Parameters<typeof createServer>[0])) as unknown as Vite;
  const [connectMod, computersMod, agentMod, petMod, pairingMod, { createElement }, { renderToStaticMarkup }] = await Promise.all([
    vite.ssrLoadModule("/src/web/connect-request.tsx"),
    vite.ssrLoadModule("/src/web/computers.tsx"),
    vite.ssrLoadModule("/src/web/agent-page.tsx"),
    vite.ssrLoadModule("/src/web/pet.tsx"),
    vite.ssrLoadModule("/src/web/pairing-request.tsx"),
    import("react"),
    import("react-dom/server"),
  ]);
  ConnectRequest = connectMod.ConnectRequest;
  ConnectApp = connectMod.ConnectApp;
  JoinRequests = computersMod.JoinRequests;
  AgentPage = agentMod.AgentPage;
  PetView = petMod.PetView;
  PairingRequest = pairingMod.PairingRequest;
  ssr = (comp, props) => renderToStaticMarkup(createElement(comp as never, props as never));
});

after(async () => {
  restoredGlobals?.();
  await vite.close();
});

test("ConnectRequest: verified, unverified, reader and blocked-popup states", () => {
  const verifiedHtml = ssr(ConnectRequest, {
    connect: { id: "cr1", kind: "app", agent: "a1", origin: "https://shop.example", host: "shop.example", name: "Shop", verified: true, expires_at: 9999999999999 },
    agentName: "Claude",
    decide: () => {},
  });
  assert.match(verifiedHtml, /Connect <b>Shop<\/b> to <b>Claude<\/b>\?/);
  assert.match(verifiedHtml, /shop\.example/);
  assert.match(verifiedHtml, /Verified/);
  assert.ok(verifiedHtml.indexOf(">Deny<") < verifiedHtml.indexOf(">Connect<"));

  const unverifiedHtml = ssr(ConnectRequest, {
    connect: { id: "cr2", kind: "app", agent: "a1", origin: "https://evil.example", host: "evil.example", name: "Fake", verified: false, expires_at: 9999999999999 },
    agentName: "Claude",
    inFlight: "approve",
    decide: () => {},
  });
  assert.match(unverifiedHtml, /role="alertdialog"/);
  assert.match(unverifiedHtml, /Not verified/);
  assert.match(unverifiedHtml, /Connect <b>evil\.example<\/b> to <b>Claude<\/b>\?/);
  // Deny is first, autofocus, primary, and still enabled while Approve is in flight.
  assert.match(unverifiedHtml, /<button[^>]*class="primary"[^>]*autofocus=""[^>]*>Deny<\/button>/i);
  assert.match(unverifiedHtml, /<button[^>]*disabled=""[^>]*>Connect<\/button>/);

  const readerHtml = ssr(ConnectRequest, {
    connect: { id: "cr3", kind: "reader", agent: "a1", origin: "chrome-extension://abc", host: "chrome-extension://abc", name: "APC extension", verified: true, check: "4821", expires_at: 9999999999999 },
    agentName: "Claude",
    decide: () => {},
  });
  assert.match(readerHtml, /Connect the APC extension to <b>Claude<\/b>\?/);
  assert.match(readerHtml, /Allow only if your extension shows/);
  assert.match(readerHtml, /4821/);
  assert.ok(readerHtml.indexOf(">Deny<") < readerHtml.indexOf(">Connect<"));
  assert.doesNotMatch(readerHtml, /connect-open/);

  const blockedUrl = "https://shop.example/connect/dock#apc_connect=tok";
  const blockedHtml = ssr(ConnectRequest, {
    connect: { id: "cr1", kind: "app", agent: "a1", origin: "https://shop.example", host: "shop.example", name: "Shop", verified: true, expires_at: 9999999999999 },
    agentName: "Claude",
    blockedUrl,
    decide: () => {},
  });
  assert.match(blockedHtml, /<a href="https:\/\/shop\.example\/connect\/dock#apc_connect=tok" target="_blank" rel="noopener" class="connect-open">Open Shop<\/a>/);
  assert.match(blockedHtml, />Dismiss<\/button>/);
});

test("ConnectApp: renders verified apps and host Check form", () => {
  const html = ssr(ConnectApp, {
    apps: [{ origin: "https://pulse.test", name: "Pulse" }, { origin: "https://shop.example", name: "Shop" }],
    create: async () => ({ ok: true }),
    refresh: () => {},
  });
  assert.match(html, />Pulse<\/button>/);
  assert.match(html, />Shop<\/button>/);
  assert.match(html, /Or enter an app host/);
  assert.match(html, />Check<\/button>/);
});

test("JoinRequests in compact (Float) mode renders the 4-digit check inside a float-request card", () => {
  const now = Date.now();
  const html = ssr(JoinRequests, {
    state: {
      agents: [],
      joins: [{ id: "j1", label: "Work laptop", check: "4821", status: "pending", expires_at: now + 60_000, answer_by: now + 60_000 }],
    },
    base: "/api/d/test",
    refresh: () => {},
    compact: true,
  });
  assert.match(html, /<div class="float-request join-request"/);
  assert.match(html, /Work laptop/);
  assert.match(html, /4821/);
  assert.match(html, />Deny<\/button>/);
  assert.match(html, />Allow<\/button>/);
});

test("PairingRequest with entry=field and compact (Float/strip) includes code input; pet keeps Open the dock", () => {
  const floatPairingHtml = ssr(PairingRequest, {
    entry: "field",
    kind: "app",
    app: "Shop",
    host: "shop.example",
    agent: "Claude",
    says: "Shop wants Claude.",
    code: true,
    compact: true,
    decide: () => {},
  });
  assert.match(floatPairingHtml, /<input[^>]*class="code-input"/);
  assert.ok(floatPairingHtml.indexOf(">Deny<") < floatPairingHtml.indexOf(">Allow<"));
  assert.match(floatPairingHtml, /<button[^>]*disabled=""[^>]*>Allow<\/button>/);

  const agent = {
    id: "a1",
    name: "Claude",
    client_name: "Claude Desktop",
    client_ua: null,
    client_icon: null,
    mcp_url: "https://dock.test/mcp/a1",
    pairings: [{
      id: "p1",
      kind: "app",
      app: { origin: "https://shop.example", name: "Shop" },
      status: "pending",
      created_at: 1,
      expires_at: 9999999999999,
      code: true,
    }],
    focus: null,
    readings: [],
    waiting: false,
    calls: 0,
    compat: { listed_after_pairing: false, prefixed_calls: 0, relay_calls: 0, waits: 0 },
  };

  const petHtml = ssr(PetView, {
    agent,
    requests: [{ id: "p1", kind: "app", app: "Shop", host: "shop.example", agent: "Claude", agentId: "a1", code: true }],
    connects: [{
      connect: { id: "cr1", kind: "app", agent: "a1", origin: "https://mail.example", host: "mail.example", name: "Mail", verified: true, expires_at: 9999999999999 },
      agentName: "Claude",
    }],
    decide: () => {},
    decideConnect: () => {},
    startDrag: () => false,
    endDrag: () => {},
  });
  assert.match(petHtml, /Connect <b>Mail<\/b> to <b>Claude<\/b>\?/);
  assert.match(petHtml, new RegExp(CODE_IN_DOCK));
  assert.doesNotMatch(petHtml, /code-input/);
  assert.match(petHtml, /Open the dock/);

  const agentPageHtml = ssr(AgentPage, {
    agent,
    base: "/api/d/test",
    apps: [{ origin: "https://pulse.test", name: "Pulse" }],
    requests: [],
    connects: [{
      connect: { id: "cr1", kind: "app", agent: "a1", origin: "https://mail.example", host: "mail.example", name: "Mail", verified: true, expires_at: 9999999999999 },
      agentName: "Claude",
    }],
    decide: () => {},
    decideConnect: () => {},
    dismissBlockedConnect: () => {},
    refresh: () => {},
    back: () => {},
    dragProps: { draggable: true, title: "Drag", onDragStart: () => {}, onDragEnd: () => {} },
    dragging: false,
  });
  assert.match(agentPageHtml, /Connect <b>Mail<\/b> to <b>Claude<\/b>\?/);
  assert.match(agentPageHtml, /<h3>Connect an app<\/h3>/);
  assert.match(agentPageHtml, />Pulse<\/button>/);
  assert.match(agentPageHtml, />Check<\/button>/);
});
