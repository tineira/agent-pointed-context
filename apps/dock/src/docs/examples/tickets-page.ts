/**
 * Tickets' page: the browser side of tickets-app.ts, with @tineira/apc-web, in plain DOM. Bundle it with any
 * bundler into the page that lists the tickets; it talks to the server's /api/* routes.
 */
import { focusAttrs } from "@tineira/apc-protocol";
import { createViewReporter, defineAgentBar, enablePinning, flashTargets, initials, type ApcAgentsElement } from "@tineira/apc-web";
// Types only: the page never bundles the server module.
import type { AgentRow, Ticket } from "./tickets-app.ts";

const post = async (path: string, body: unknown = {}): Promise<Record<string, unknown>> =>
  (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

/** The tickets, each a row the person can point at: data-focus, made by focusAttrs. Your page draws your own data. */
const tickets: Ticket[] = [
  { id: "t_101", subject: "Printer offline", status: "open" },
  { id: "t_102", subject: "VPN drops every hour", status: "open" },
  { id: "t_103", subject: "New laptop for Ana", status: "closed" },
];
const table = document.body.appendChild(document.createElement("table"));
for (const ticket of tickets) {
  const row = table.appendChild(document.createElement("tr"));
  for (const [name, value] of Object.entries(focusAttrs({ kind: "ticket", id: ticket.id }))) row.setAttribute(name, value);
  row.append(Object.assign(document.createElement("td"), { textContent: ticket.subject }), Object.assign(document.createElement("td"), { textContent: ticket.status }));
}

/** The screen as identifiers, sent when it changes. */
const reportView = createViewReporter((view) => void post("/api/view", view));
reportView({ screen: "tickets", params: {}, selection: null });

/** The agent bar: each agent's mark (drag it onto a ticket), its pin, × to unpin, ⊘ to revoke. It needs no paths on a Direct-only app. */
defineAgentBar();
const bar = document.body.appendChild(document.createElement("apc-agents")) as ApcAgentsElement;
bar.dockHint = null; // Direct only: no "get a dock" hint
const marks = new Map<string, string>();
async function refresh(): Promise<void> {
  const rows = (await (await fetch("/api/agents/list")).json()) as AgentRow[];
  marks.clear();
  for (const row of rows) marks.set(row.id, initials(row.name, new Set(marks.values())));
  bar.agents = rows.map((a) => ({ id: a.id, name: a.name, state: "idle", pin: a.pin ? { ...a.pin, here: true } : null }));
}
bar.addEventListener("apc-revoke", (e) => void post(`/api/agents/${(e as CustomEvent<{ id: string }>).detail.id}/revoke`).then(refresh));
bar.addEventListener("apc-unpin", (e) => void post(`/api/agents/${(e as CustomEvent<{ id: string }>).detail.id}/unpin`).then(refresh));

/** A new agent: its MCP URL and its token, shown once, for the person to paste into their agent. */
const add = document.body.appendChild(Object.assign(document.createElement("button"), { type: "button", textContent: "Connect an agent" }));
const secret = document.body.appendChild(document.createElement("pre"));
add.addEventListener("click", async () => {
  const made = await post("/api/agents");
  secret.textContent = `MCP URL: ${String(made.url)}\nHeader:  Authorization: Bearer ${String(made.token)}\n(shown once)`;
  await refresh();
});

/** The page's stream: while it is open the page is open (for `then` and wait_for_focus); it carries presence and changes. */
const events = new EventSource("/api/events");
events.onmessage = (message) => {
  const data = JSON.parse(message.data as string) as { type: string; event?: Parameters<typeof flashTargets>[0] };
  if (data.type === "presence" && data.event) flashTargets(data.event, marks.get(data.event.grant_id) ?? "?");
  else void refresh();
};

/** Pinning: a mark dragged (or on a phone tapped, then a ticket tapped) onto a row pins that agent there. */
enablePinning({ onPin: (grantId, target) => void post(`/api/agents/${grantId}/pin`, { target }).then(refresh) });
void refresh();
