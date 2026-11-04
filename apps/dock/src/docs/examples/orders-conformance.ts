/**
 * Orders against the conformance suite: the adapter the guide at apc.tineira.com/docs/conformance shows.
 * Everything runs in one process: the app's `fetch` is called directly, the person's page is the app's own
 * event stream, and on the Dock profile a stand-in hub answers pairing. `apps/dock/test/docs-examples.test.ts`
 * runs it under `node --test`.
 */
// #region imports
import { apcConformance, runConformance, type AgentConnection, type ApcAppAdapter } from "@apc/conformance";
import type { ApcProfile, FocusTarget, PresenceEvent } from "@apc/protocol";
import { barCanCollapse, createTapPin, type BarAgent } from "@apc/web";
import { OrdersApp } from "./orders-app.ts";
// #endregion

const ORIGIN = "https://orders.test";
const HUB = "https://dock.test";

// #region hub
/**
 * A dock's hub, reduced to what the Dock profile needs from it: it takes every pairing (`/apc/pair`),
 * confirms every pairing it took (`/apc/confirm`), and remembers each grant's MCP URL, which the real hub
 * keeps to itself.
 */
function standInHub(): { fetch: typeof fetch; urls: Map<string, string> } {
  const urls = new Map<string, string>(); // agent handle -> MCP URL
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}")) as { agent: string; mcp_url: string };
    if (url === `${HUB}/apc/pair`) {
      urls.set(body.agent, body.mcp_url);
      return Response.json({ ok: true, pairing_id: "pr_1", status: "pending", agent: { name: "Agent via dock", icon: null } });
    }
    if (url === `${HUB}/apc/confirm`) return Response.json(urls.get(body.agent) === body.mcp_url ? { ok: true, status: "paired" } : { ok: false, error: "not_paired" });
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  };
  return { fetch: answer as typeof fetch, urls };
}
// #endregion

/** Orders and its adapter. `link` runs the apc_link checks too (an app with both profiles). */
export function ordersUnderTest(profile: ApcProfile, options: { link?: boolean } = {}): { app: OrdersApp; adapter: ApcAppAdapter } {
  const hub = standInHub();
  let skew = 0; // expireCodes moves the app's clock past a link code's two minutes
  const app = new OrdersApp({ origin: ORIGIN, profiles: ["direct", "dock"], hubs: [HUB], fetch: hub.fetch, now: () => Date.now() + skew });
  const call = async (path: string, body: unknown = {}) => (await app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;

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
    const drop = { hub: HUB, agent: `ag_${drops}`, ticket: `${"t".repeat(32)}.${String(drops).padStart(16, "0")}`, target: { kind: "order", id: "ord_1001" } };
    const asked = await call("/api/drop", drop);
    if (asked.error !== "consent_required") throw new Error(`expected consent_required, got ${JSON.stringify(asked)}`);
    const paired = await call("/api/drop", { ...drop, consent: asked.consent });
    if (!paired.ok) throw new Error(`pairing failed: ${JSON.stringify(paired)}`);
    const grantId = paired.grant_id as string;
    await call(`/api/agents/${grantId}/unpin`); // the suite starts from no pin
    return { grantId, mcpUrl: hub.urls.get(drop.agent)! };
  }
  // #endregion

  // #region page
  /** The person's page: open is an open event stream, which also carries presence. */
  let page: { reader: ReadableStreamDefaultReader<Uint8Array>; done: Promise<void> } | null = null;
  const presence: PresenceEvent[] = [];
  async function setOpen(open: boolean): Promise<void> {
    if (open && !page) {
      const response = await app.fetch(new Request(`${ORIGIN}/api/events`));
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
      // The page on a phone (APC 0.6), modelled with @apc/web's own pieces: the agent bar's collapse rule and
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
    ...(options.link
      ? {
          link: {
            connect,
            agents: async () => app.agents().map((a) => ({ grants: a.grants })),
            unlink: async (grantId) => (await call(`/api/agents/${grantId}/unlink`)).ok === true,
            expireCodes: async () => void (skew += 121_000),
          },
        }
      : {}),
  };
  // #endregion
  return { app, adapter };
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
