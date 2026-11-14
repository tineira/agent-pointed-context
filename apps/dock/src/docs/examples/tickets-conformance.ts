/**
 * Tickets against the conformance suite, in process: the adapter for tickets-app.ts. The app's `fetch` is called
 * directly, and the person's page is the app's own event stream. Run it under `node --test`
 * (`for (const c of apcConformance(ticketsUnderTest().adapter)) test(c.name, c.run)`) or with `checkTickets()`.
 */
import { apcConformance, runConformance, type ApcAppAdapter } from "@tineira/apc-conformance";
import type { FocusTarget, PresenceMessage } from "@tineira/apc-protocol";
import { barCanCollapse, createTapPin, type BarAgent } from "@tineira/apc-web";
import { TicketsApp } from "./tickets-app.ts";

const ORIGIN = "https://tickets.test";
/** The person's session: here a fixed cookie; in your app, your own sign-in. */
const SESSION = { cookie: "tickets_session=owner" };

export function ticketsUnderTest(): { app: TicketsApp; adapter: ApcAppAdapter } {
  const app = new TicketsApp(ORIGIN, { signedIn: (request) => request.headers.get("cookie") === SESSION.cookie });
  /** A request of the person's page: their session, JSON, and the page's own Origin. */
  const call = async (path: string, body: unknown = {}) =>
    (await app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { ...SESSION, "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) }))).json() as Promise<Record<string, unknown>>;

  /** The person's page: open while its event stream is, which also carries presence. */
  let page: { reader: ReadableStreamDefaultReader<Uint8Array>; done: Promise<void> } | null = null;
  const presence: PresenceMessage[] = [];
  async function setOpen(open: boolean): Promise<void> {
    if (open && !page) {
      const reader = (await app.fetch(new Request(`${ORIGIN}/api/events`, { headers: SESSION }))).body!.getReader();
      const decoder = new TextDecoder();
      const done = (async () => {
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const message = JSON.parse(buffer.slice(6, end)) as { type: string; event?: PresenceMessage };
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

  const targets: [FocusTarget, FocusTarget] = [
    { kind: "ticket", id: "t_101", part: null, params: null },
    { kind: "ticket", id: "t_102", part: null, params: null },
  ];
  const adapter: ApcAppAdapter = {
    name: "Tickets",
    profile: "direct",
    fetch: (request) => app.fetch(request),
    // The person makes an agent on the page: the shared MCP URL, and the grant's token in a header.
    connect: async () => {
      const made = await call("/api/agents");
      return { grantId: made.id as string, mcpUrl: made.url as string, headers: { authorization: `Bearer ${made.token as string}` } };
    },
    targets,
    probe: { tool: "list_tickets", args: {} },
    page: {
      setOpen,
      showView: async () => void (await call("/api/view", { screen: "tickets", params: {}, selection: { kind: "ticket", id: "t_101" } })),
      pin: async (grantId, target) => (await call(`/api/agents/${grantId}/pin`, { target })).ok === true,
      takePresence: () => presence.splice(0),
      revoke: async (grantId) => (await call(`/api/agents/${grantId}/revoke`)).ok === true,
      // The page on a phone (APC 0.6), modelled with @tineira/apc-web's own pieces: the agent bar's collapse rule
      // and the tap-to-pin controller enablePinning runs. A browser with touch emulation is the real check.
      mobile: {
        async agentBar() {
          const bar: BarAgent[] = app.agents().map((a) => ({ id: a.id, name: a.name, state: "idle" }));
          return { visible: bar.map((a) => a.id), collapsible: barCanCollapse(bar, true) };
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
  };
  return { app, adapter };
}

/** Every check, with a line per check: what a CI job or a script prints. */
export async function checkTickets(): Promise<boolean> {
  const report = await runConformance(ticketsUnderTest().adapter);
  for (const r of report.results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : ""}`);
  return report.failed === 0;
}

/** For a test runner: one test per check. */
export const ticketsChecks = () => apcConformance(ticketsUnderTest().adapter);
