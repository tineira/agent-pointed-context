/**
 * Orders against the conformance suite: the adapter the guide at apc.tineira.com/docs/conformance shows.
 * Everything runs in one process: the app's `fetch` is called directly, the person's page is the app's own
 * event stream, and on the Dock profile the suite's stand-in hub (`standInHub`) answers pairing and checks the
 * pairing code. `apps/dock/test/docs-examples.test.ts` runs it under `node --test`.
 */
// #region imports
import { apcConformance, runConformance, standInHub, type AgentConnection, type ApcAppAdapter, type ApcDockDropOutcome, type ApcDockLifecycleAdapter } from "@tineira/apc-conformance";
import { LONG_DORMANCY_RECOMMENDED_MS, T_IDLE_RECOMMENDED_MS, formatPairingCode, type ApcProfile, type FocusTarget, type PresenceEvent } from "@tineira/apc-protocol";
import { barCanCollapse, createTapPin, type BarAgent } from "@tineira/apc-web";
import { OrdersApp, newOrdersStore, type OrdersAppOptions } from "./orders-app.ts";
// #endregion

const ORIGIN = "https://orders.test";
const HUB = "https://dock.test";
/** The person's session: here a fixed cookie; in your app, your own sign-in. */
const SESSION = { cookie: "orders_session=owner" };

/** Orders and its adapter. `link` runs the apc_link checks too (an app with both profiles). */
export function ordersUnderTest(profile: ApcProfile, options: { link?: boolean } = {}): { app: OrdersApp; adapter: ApcAppAdapter } {
  // #region hub
  /**
   * A dock's hub, from the suite: it takes pairings (`/apc/pair`) and keeps their pairing codes, confirms them
   * (`/apc/confirm`), and calls the app back (`/apc/revoke`, and `initialize` once approved) through `app`.
   */
  const hub = standInHub({ origin: HUB, app: (request) => app.fetch(request) });
  // #endregion
  let skew = 0; // the time seam: the app's clock, moved forward by the checks
  const config: OrdersAppOptions = {
    origin: ORIGIN,
    profiles: ["direct", "dock"],
    hubs: [HUB],
    fetch: hub.fetch,
    now: () => Date.now() + skew,
    signedIn: (request) => request.headers.get("cookie") === SESSION.cookie,
    // What Orders keeps outlives the process: a restart is a new OrdersApp on the same store.
    store: newOrdersStore(),
  };
  let app = new OrdersApp(config);
  /** A request of the person's page: their session, JSON, and the page's own Origin. */
  const call = async (path: string, body: unknown = {}) =>
    (await app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { ...SESSION, "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;

  // #region connect
  let drops = 0;
  /** A new agent with full access, made the way each profile makes one. */
  async function connect(path: ApcProfile): Promise<AgentConnection> {
    if (path === "direct") {
      // The person makes an agent on the page and pastes its URL into the agent.
      const made = await call("/api/agents");
      return { grantId: made.id as string, mcpUrl: made.url as string };
    }
    // The person drops an agent from a dock: the app asks first, and the Allow brings the nonce back.
    drops++;
    const agent = `ag_${drops}`;
    const drop = { hub: HUB, agent, ticket: hub.ticket(agent), target: { kind: "order", id: "ord_1001" } };
    const asked = await call("/api/drop", drop);
    if (asked.error !== "consent_required") throw new Error(`expected consent_required, got ${JSON.stringify(asked)}`);
    const paired = await call("/api/drop", { ...drop, consent: asked.consent });
    if (!paired.ok) throw new Error(`pairing failed: ${JSON.stringify(paired)}`);
    // The person types the code in their dock: the hub approves and connects (its initialize makes the grant live).
    const pairing = hub.pairings.filter((p) => p.agent === agent).at(-1)!;
    const approved = await hub.decide(pairing.id, "approve", asked.pairing_code);
    if (!approved.ok) throw new Error(`the dock did not approve: ${JSON.stringify(approved)}`);
    const grantId = paired.grant_id as string;
    await call(`/api/agents/${grantId}/unpin`); // the suite starts from no pin
    return { grantId, mcpUrl: pairing.mcp_url };
  }
  // #endregion

  // #region dock
  /** What the page shows on a drop: the consent with its code and the Allow, the waiting card, or a refusal. */
  async function dropAgent(d: { agent: string; ticket: string; hub: string; target?: FocusTarget }): Promise<ApcDockDropOutcome> {
    const drop = { hub: d.hub, agent: d.agent, ticket: d.ticket, target: d.target ?? { kind: "order", id: "ord_1001" } };
    const r = await call("/api/drop", drop);
    if (r.error === "consent_required" && typeof r.pairing_code === "string") {
      return {
        page: "consent",
        // orders-page.ts shows it formatted, K7M-4P2.
        code: formatPairingCode(r.pairing_code),
        allow: async (over) => {
          const a = await call("/api/drop", { ...drop, ...(over?.hub !== undefined ? { hub: over.hub } : {}), consent: r.consent });
          return { ok: a.ok === true, ...(typeof a.error === "string" ? { error: a.error } : {}), ...(typeof a.grant_id === "string" ? { grantId: a.grant_id } : {}) };
        },
      };
    }
    if (r.ok === true && r.status === "pending") return { page: "waiting", code: formatPairingCode((r.pairing as { code: string }).code) };
    if (r.ok === true && r.status === "connecting") return { page: "connecting" };
    if (r.ok === true) return { page: "pinned" };
    return { page: "refused", error: String(r.error) };
  }

  /** The pairing code (APC 0.9): what the consent shows, and the person's Allow on it. */
  async function dropOnPage(agent: string, ticket: string) {
    const shown = await dropAgent({ agent, ticket, hub: HUB });
    if (shown.page !== "consent") throw new Error(`expected the consent, got ${JSON.stringify(shown)}`);
    return { shown: shown.code, allow: () => shown.allow() };
  }
  // #endregion

  // #region lifecycle
  /** A grant in handoff, for an endpoint's body: dropped and allowed, the dock has not connected. */
  async function waitingGrant(): Promise<string> {
    const agent = `ag_owner_${++drops}`;
    const shown = await dropAgent({ agent, ticket: hub.ticket(agent), hub: HUB });
    if (shown.page !== "consent") throw new Error(`expected the consent, got ${JSON.stringify(shown)}`);
    return (await shown.allow()).grantId!;
  }
  /**
   * The Dock profile as built (APC 0.10): how the suite puts a grant into each state (the drop, Cancel, the
   * heartbeat, the clock, a failing store, a restart) and reaches the person's endpoints.
   */
  const lifecycle: ApcDockLifecycleAdapter = {
    dropAgent,
    // The page's Allow sends the drop again with the nonce, hub included: the app checks it against its allowlist again (M1).
    allowCarriesHub: true,
    cancel: async (grantId) => (await call("/api/cancel", { grant_id: grantId })).ok === true,
    heartbeat: async () => void (await call("/api/heartbeat")),
    advance: async (ms) => void (skew += ms),
    // Orders keeps its grants in memory, so a store that fails is its one write on `initialize` throwing.
    failCommits(fail) {
      const store = app as unknown as { commitConnection?: () => boolean };
      if (fail) {
        store.commitConnection = () => {
          throw new Error("the store is down");
        };
      } else delete store.commitConnection;
    },
    // The process dies and comes back on the same store.
    async restart() {
      await setOpen(false);
      app = new OrdersApp(config);
    },
    idleMs: T_IDLE_RECOMMENDED_MS,
    // A grant asleep 30 days ends (long dormancy).
    dormancyMs: LONG_DORMANCY_RECOMMENDED_MS,
    owner: {
      origin: ORIGIN,
      session: SESSION,
      drop: { path: "/api/drop", body: () => ({ hub: HUB, agent: `ag_owner_${++drops}`, ticket: hub.ticket(`ag_owner_${drops}`) }) },
      allow: {
        path: "/api/drop",
        body: async () => {
          const drop = { hub: HUB, agent: `ag_owner_${++drops}`, ticket: hub.ticket(`ag_owner_${drops}`) };
          return { ...drop, consent: (await call("/api/drop", drop)).consent };
        },
      },
      heartbeat: { path: "/api/heartbeat", body: () => ({}) },
      cancel: { path: "/api/cancel", body: async () => ({ grant_id: await waitingGrant() }) },
    },
    // The same app with no hub to pair with: its apc.json must not list dock.
    pairingDisabled: async () => {
      const off = new OrdersApp({ ...config, hubs: [], store: newOrdersStore() });
      return (request) => off.fetch(request);
    },
  };
  // #endregion

  // #region page
  /** The person's page: open is an open event stream, which also carries presence. */
  let page: { reader: ReadableStreamDefaultReader<Uint8Array>; done: Promise<void> } | null = null;
  const presence: PresenceEvent[] = [];
  async function setOpen(open: boolean): Promise<void> {
    if (open && !page) {
      const response = await app.fetch(new Request(`${ORIGIN}/api/events`, { headers: SESSION }));
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const done = (async () => {
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const message = JSON.parse(buffer.slice(6, end)) as { type: string; event?: PresenceEvent };
            buffer = buffer.slice(end + 2);
            if (message.type === "presence" && message.event) presence.push(message.event);
          }
        }
      })();
      page = { reader, done };
    } else if (!open && page) {
      await page.reader.cancel();
      await page.done;
      page = null;
    }
  }
  // #endregion

  // #region adapter
  const targets: [FocusTarget, FocusTarget] = [
    { kind: "order", id: "ord_1001", part: null, params: null },
    { kind: "order", id: "ord_1002", part: "total", params: null },
  ];
  const adapter: ApcAppAdapter = {
    name: "Orders",
    profile,
    fetch: (request) => app.fetch(request),
    connect: () => connect(profile),
    targets,
    probe: { tool: "list_orders", args: {} },
    page: {
      setOpen,
      showView: async () => void (await call("/api/view", { screen: "orders", params: { status: "open" }, selection: { kind: "order", id: "ord_1001" } })),
      pin: async (grantId, target) => (await call(`/api/agents/${grantId}/pin`, { target })).ok === true,
      takePresence: () => presence.splice(0),
      revoke: async (grantId) => (await call(`/api/agents/${grantId}/revoke`)).ok === true,
      // The page on a phone (APC 0.6), modelled with @tineira/apc-web's own pieces: the agent bar's collapse rule and
      // the tap-to-pin controller that enablePinning runs. A browser with touch emulation is the real check.
      mobile: {
        async agentBar() {
          const bar: BarAgent[] = app.agents().map((a) => ({ id: a.id, name: a.name, state: "idle", paths: a.paths }));
          return { visible: app.agents().flatMap((a) => a.grants), collapsible: barCanCollapse(bar, true) };
        },
        async pinByTouch(grantId, target) {
          const pins: Array<Promise<Record<string, unknown>>> = [];
          const tap = createTapPin({ onPin: (id, t) => void pins.push(call(`/api/agents/${id}/pin`, { target: t })) });
          tap.toggle(grantId);
          return tap.tap({ element: {} as Element, target }) === "pinned" && (await pins[0]!).ok === true;
        },
        unpinByTouch: async (grantId) => (await call(`/api/agents/${grantId}/unpin`)).ok === true,
      },
    },
    ...(profile === "dock" ? { dock: { hub, drop: dropOnPage, lifecycle } } : {}),
    ...(options.link
      ? {
          link: {
            connect,
            agents: async () => app.agents().map((a) => ({ grants: a.grants })),
            unlink: async (grantId) => (await call(`/api/agents/${grantId}/unlink`)).ok === true,
            // The app's clock moves past a link code's two minutes.
            expireCodes: async () => void (skew += 121_000),
          },
        }
      : {}),
  };
  // #endregion
  return {
    get app() {
      return app;
    },
    adapter,
  };
}

// #region run
/** Every check, with a line per check: what a CI job or a script prints. */
export async function checkOrders(): Promise<boolean> {
  let ok = true;
  for (const profile of ["direct", "dock"] as const) {
    const { adapter } = ordersUnderTest(profile, { link: profile === "direct" });
    const report = await runConformance(adapter);
    for (const r of report.results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : ""}`);
    ok &&= report.failed === 0;
  }
  return ok;
}
// #endregion

/** For a test runner: one test per check (`for (const c of ordersChecks("direct")) test(c.name, c.run)`). */
export function ordersChecks(profile: ApcProfile, options: { link?: boolean } = {}) {
  return apcConformance(ordersUnderTest(profile, options).adapter);
}
