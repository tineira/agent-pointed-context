/**
 * APC 0.13 dock UI (TIN-916): ConnectRequest across surfaces (verified, unverified, reader, blocked
 * popup fallback), ConnectApp, PairingRequest with code field everywhere except pets, JoinRequests in
 * Float, and approveAndOpen with window.open mocked against both stubs and a real Hub DO.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { approveAndOpen, beginAnswer, CODE_IN_DOCK, connectCheckErrorText, decisionNotice, endAnswer, type OpenedWindow, type Sent } from "../src/web/request-state.ts";
import { fakeApp, manifestOf, world } from "./hostile-world.ts";

test("request-state: connect approval & check errors produce clear copy", () => {
  assert.match(decisionNotice("not_found"), /no longer waiting/i);
  assert.match(decisionNotice("https_required"), /HTTPS/i);
  assert.match(decisionNotice("app_not_allowed"), /cannot connect to this app/i);
  assert.match(decisionNotice("reader_not_allowed"), /browser extension/i);
  assert.match(decisionNotice("unknown_agent"), /no longer in your dock/i);
  assert.match(decisionNotice("warning_required", "connect"), /request now shows it.*connect or deny/i);
  assert.match(decisionNotice("warning_required"), /request now shows it.*approve or deny/i);

  assert.match(connectCheckErrorText("apc_json_missing"), /apc\.json/i);
  assert.match(connectCheckErrorText("app_blocked"), /does not pair/i);
  assert.match(connectCheckErrorText("too_many_requests"), /too many/i);
  assert.match(connectCheckErrorText("https_required"), /HTTPS/i);
  assert.match(connectCheckErrorText("unreachable"), /Could not reach/i);
});

function makeFakeWindow() {
  const replaced: string[] = [];
  let closedCount = 0;
  const win: OpenedWindow = {
    closed: false,
    opener: { marker: true },
    location: {
      replace(u: string) {
        replaced.push(u);
      },
    },
    close() {
      closedCount++;
      win.closed = true;
    },
  };
  return { win, replaced, getClosedCount: () => closedCount };
}

test("approveAndOpen: browser pre-opens synchronously without noopener, navigates via location.replace, handles blocks/failures, and shell opens post-approve", async () => {
  const url = "https://shop.example/connect/dock#apc_connect=tok";

  // 1. noopener-faithful stub (returns null whenever noopener is in features): must succeed without false "blocked".
  const calls: Array<{ url: string; target: string; features: string }> = [];
  const w1 = makeFakeWindow();
  let callsAtApproveStart = -1;
  const opened = await approveAndOpen({
    approve: async () => {
      callsAtApproveStart = calls.length;
      return { ok: true, url };
    },
    opener: {
      open(u = "", target = "", features = "") {
        calls.push({ url: u, target, features });
        if (features.split(",").map((f) => f.trim().toLowerCase()).includes("noopener")) return null;
        return w1.win;
      },
    },
  });
  assert.equal(callsAtApproveStart, 1, "pre-open happened synchronously before awaiting approve");
  assert.deepEqual(calls, [{ url: "", target: "_blank", features: "" }]);
  assert.equal(w1.win.opener, null);
  assert.deepEqual(w1.replaced, [url]);
  assert.deepEqual(opened, { status: "opened", url });

  // 2. Blocked pre-open (open("", "_blank") returns null) shows the fallback after approve.
  const blocked = await approveAndOpen({
    approve: async () => ({ ok: true, url }),
    opener: { open: () => null },
  });
  assert.deepEqual(blocked, { status: "blocked", url });

  // 3. Thrown pre-open (e.g. closed PiP window) still approves and shows the fallback.
  const thrownOpen = await approveAndOpen({
    approve: async () => ({ ok: true, url }),
    opener: {
      open() {
        throw new Error("PiP closed");
      },
    },
  });
  assert.deepEqual(thrownOpen, { status: "blocked", url });

  // 4. Pre-opened window closed during approve, or location.replace throwing, returns fallback so ticket is not lost.
  const wClosed = makeFakeWindow();
  const closedDuringApprove = await approveAndOpen({
    approve: async () => {
      wClosed.win.closed = true;
      return { ok: true, url };
    },
    opener: { open: () => wClosed.win },
  });
  assert.deepEqual(closedDuringApprove, { status: "blocked", url });
  assert.deepEqual(wClosed.replaced, []);

  const wThrowNav = makeFakeWindow();
  wThrowNav.win.location = {
    replace() {
      throw new Error("navigation failed");
    },
  };
  const failedNav = await approveAndOpen({
    approve: async () => ({ ok: true, url }),
    opener: { open: () => wThrowNav.win },
  });
  assert.deepEqual(failedNav, { status: "blocked", url });
  assert.equal(wThrowNav.getClosedCount(), 1);

  // 5. Approve failure (ok: false or rejected promise) closes the pre-opened window.
  const wErr = makeFakeWindow();
  const failed = await approveAndOpen({
    approve: async () => ({ ok: false, error: "not_found" }),
    opener: { open: () => wErr.win },
  });
  assert.deepEqual(failed, { status: "error", error: "not_found" });
  assert.equal(wErr.getClosedCount(), 1);

  const wReject = makeFakeWindow();
  await assert.rejects(
    () =>
      approveAndOpen({
        approve: async () => {
          throw new Error("network down");
        },
        opener: { open: () => wReject.win },
      }),
    /network down/,
  );
  assert.equal(wReject.getClosedCount(), 1);

  // 6. Dock for Windows shell (desktop: true): opens post-approve via window.open(url, "_blank"); null from on_new_window still means opened.
  const shellCalls: Array<{ url: string; target: string; features: string }> = [];
  let shellCallsBeforeApprove = -1;
  const desktopOpened = await approveAndOpen({
    approve: async () => {
      shellCallsBeforeApprove = shellCalls.length;
      return { ok: true, url };
    },
    opener: {
      open(u = "", target = "", features = "") {
        shellCalls.push({ url: u, target, features });
        return null;
      },
    },
    desktop: true,
  });
  assert.equal(shellCallsBeforeApprove, 0, "shell must not pre-open before approve");
  assert.deepEqual(shellCalls, [{ url, target: "_blank", features: "" }]);
  assert.deepEqual(desktopOpened, { status: "opened", url });

  // Shell open throwing still recovers with the fallback card.
  const desktopThrown = await approveAndOpen({
    approve: async () => ({ ok: true, url }),
    opener: {
      open() {
        throw new Error("shell open failed");
      },
    },
    desktop: true,
  });
  assert.deepEqual(desktopThrown, { status: "blocked", url });

  // 7. Reader connect approves without opening any tab.
  let readerOpenCalls = 0;
  const reader = await approveAndOpen({
    approve: async () => ({ ok: true }),
    kind: "reader",
    opener: {
      open() {
        readerOpenCalls++;
        return null;
      },
    },
  });
  assert.deepEqual(reader, { status: "paired" });
  assert.equal(readerOpenCalls, 0);
});

test("beginAnswer/endAnswer: synchronous ref guard blocks double approve before re-render while allowing deny", () => {
  const ref: { current: Sent } = { current: new Map() };
  assert.equal(beginAnswer(ref, "cr1", "approve"), "approve");
  assert.equal(beginAnswer(ref, "cr1", "approve"), null, "second approve before re-render is blocked");
  assert.equal(beginAnswer(ref, "cr1", "approve_unverified"), null, "second yes is blocked");
  assert.equal(beginAnswer(ref, "cr1", "deny"), "deny", "deny can still undo an in-flight approve");
  assert.equal(beginAnswer(ref, "cr1", "deny"), null, "second deny is blocked");
  endAnswer(ref, "cr1", "deny");
  endAnswer(ref, "cr1", "approve");
  assert.equal(beginAnswer(ref, "cr1", "approve"), "approve", "approve allowed again after settling");
});

test("approveAndOpen against real Hub DO approveConnect with blocked and allowed window.open", async (t) => {
  const SHOP = "https://shop.example";
  const w = await world(t, { APP_ORIGINS: SHOP });
  const owner = String(w.hubRoom.db.prepare("select secret from devices").get()!.secret);
  const agent = (await w.agent()).id as string;
  w.apps.set(SHOP, fakeApp(SHOP, "Shop", { apcJson: () => Response.json(manifestOf(SHOP, "Shop", { standard: "0.13.0", dock_connect: `${SHOP}/connect/dock` })) }));

  const approveReal = async (openFn: (u: string, tgt: string, feat: string) => OpenedWindow | null) => {
    const { ticket } = await w.hub.ticket(agent);
    assert.equal((await w.hub.requestConnect({ ticket, agent, app: { origin: SHOP } })).ok, true);
    const id = (await w.state()).connects[0].id as string;
    const seen: Array<[string, string, string]> = [];
    const res = await approveAndOpen({
      approve: () => w.hub.asOwner(owner, "approveConnect", [id, undefined, "https://dock.test"]) as Promise<{ ok?: boolean; url?: string; error?: unknown }>,
      opener: {
        open(u = "", tgt = "", feat = "") {
          seen.push([u, tgt, feat]);
          return openFn(u, tgt, feat);
        },
      },
    });
    return { res, seen };
  };

  const blocked = await approveReal(() => null);
  assert.equal(blocked.res.status, "blocked");
  assert.deepEqual(blocked.seen, [["", "_blank", ""]]);
  if (blocked.res.status === "blocked") {
    assert.match(blocked.res.url, /^https:\/\/shop\.example\/connect\/dock#apc_connect=/);
  }

  const fake = makeFakeWindow();
  const opened = await approveReal(() => fake.win);
  assert.equal(opened.res.status, "opened");
  assert.deepEqual(opened.seen, [["", "_blank", ""]]);
  assert.equal(fake.win.opener, null);
  assert.equal(fake.replaced.length, 1);
  assert.match(fake.replaced[0]!, /^https:\/\/shop\.example\/connect\/dock#apc_connect=/);
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
let petApp: { bubble(size: { width: number; height: number } | null): Promise<unknown> };
let petCodeEntry: (caps: string[] | null) => "field" | "dock";
let petInvoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> = async () => null;

let restoredGlobals: (() => void) | null = null;

before(async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWin = g.window;
  const prevLoc = g.location;
  g.window = { ...(prevWin as object | undefined), __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => petInvoke(cmd, args) } };
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
  petApp = petMod.petApp as typeof petApp;
  petCodeEntry = petMod.petCodeEntry as typeof petCodeEntry;
  PairingRequest = pairingMod.PairingRequest;
  ssr = (comp, props) => renderToStaticMarkup(createElement(comp as never, props as never));
});

test("pet native resize commands preserve order when Done follows a slow measurement", async () => {
  const calls: unknown[] = [];
  let finish: (value: null) => void = () => {};
  petInvoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (calls.length === 1) return new Promise<null>((resolve) => { finish = resolve; });
    return null;
  };
  try {
    const grown = petApp.bubble({ width: 240, height: 400 });
    const done = petApp.bubble(null);
    await Promise.resolve();
    assert.deepEqual(calls, [{ cmd: "pet_bubble", args: { bubble: [240, 400] } }]);
    finish(null);
    await Promise.all([grown, done]);
    assert.deepEqual(calls, [
      { cmd: "pet_bubble", args: { bubble: [240, 400] } },
      { cmd: "pet_bubble", args: { bubble: null } },
    ]);
  } finally {
    petInvoke = async () => null;
  }
});

test("pet bubble renders idle, unverified, reader, fallback and refusal states", () => {
  const props = {
    agent: { id: "a1", name: "Claude", client_name: "Claude Desktop", client_icon: null, client_ua: null, waiting: false, calls: 0, pairings: [] },
    requests: [], decide: () => {}, decideConnect: () => {}, startDrag: () => false, endDrag: () => {},
  };
  assert.doesNotMatch(ssr(PetView, props), /pet-bubble/);
  const connect = { id: "cr1", kind: "app", agent: "a1", origin: "https://xn--bcher-kva.example", host: "xn--bcher-kva.example", name: "Books", verified: false, expires_at: 9999999999999 };
  const unverified = ssr(PetView, { ...props, connects: [{ connect, agentName: "Claude", inFlight: "approve" }] });
  assert.match(unverified, /pet-request unverified/);
  assert.match(unverified, /Not verified/);
  assert.match(unverified, /xn--bcher-kva\.example/);
  assert.match(unverified, /<button[^>]*autofocus=""[^>]*>Deny<\/button>/);
  assert.match(unverified, /<button[^>]*disabled=""[^>]*>Connect<\/button>/);
  const reader = ssr(PetView, { ...props, connects: [{ connect: { ...connect, kind: "reader", verified: true, check: "4821" }, agentName: "Claude", inFlight: "deny" }] });
  assert.match(reader, /Connect the APC extension/);
  assert.match(reader, /4821/);
  assert.match(reader, /<button[^>]*disabled=""[^>]*>Deny<\/button>/);
  assert.match(reader, /<button[^>]*disabled=""[^>]*>Connect<\/button>/);
  const url = "https://xn--bcher-kva.example/connect/dock#apc_connect=fixture";
  const fallback = ssr(PetView, { ...props, connects: [{ connect, agentName: "Claude", blockedUrl: url }] });
  assert.ok(fallback.includes(`href="${url}" target="_blank" rel="noopener"`));
  assert.match(fallback, />Dismiss<\/button>/);
  const refusal = ssr(PetView, { ...props, refusal: "This request is no longer waiting." });
  assert.match(refusal, /pet-bubble/);
  assert.match(refusal, /This request is no longer waiting/);
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
  assert.doesNotMatch(readerHtml, /<button[^>]*disabled=""[^>]*>Connect<\/button>/);
  assert.doesNotMatch(readerHtml, /connect-open/);

  for (const check of [undefined, ""]) {
    const missingCheckHtml = ssr(ConnectRequest, {
      connect: { id: "cr3b", kind: "reader", agent: "a1", origin: "chrome-extension://abc", host: "chrome-extension://abc", name: "APC extension", verified: true, check, expires_at: 9999999999999 },
      agentName: "Claude",
      decide: () => {},
    });
    assert.match(missingCheckHtml, /ask your extension again/i);
    assert.match(missingCheckHtml, /<button[^>]*disabled=""[^>]*>Connect<\/button>/);
    assert.doesNotMatch(missingCheckHtml, /<button[^>]*disabled=""[^>]*>Deny<\/button>/);
  }

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

test("the pet takes the code only on an app that can activate the pet (TIN-922)", () => {
  // An installed app before TIN-922 has no pet_caps (null): the code stays in the dock.
  assert.equal(petCodeEntry(null), "dock");
  assert.equal(petCodeEntry([]), "dock");
  assert.equal(petCodeEntry(["code_field"]), "field");
});
