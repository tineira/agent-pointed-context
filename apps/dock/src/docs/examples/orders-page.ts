/**
 * Orders' page: the browser side of the guide at apc.tineira.com/docs/integrate, with @tineira/apc-web. Plain DOM, so
 * it fits any framework: React, Vue or none. It talks to the server in orders-app.ts (`/api/*`, `/api/events`).
 */
// #region imports
import { focusAttrs, type FocusTarget } from "@tineira/apc-protocol";
import {
  createViewReporter,
  defineAgentBar,
  defineDirectAgents,
  enablePinning,
  flashTargets,
  initials,
  loadApcProfiles,
  type AgentDrag,
  type ApcAgentsElement,
  type ApcDirectAgentsElement,
} from "@tineira/apc-web";
import type { AgentRow, Order } from "./orders-app.ts";
// #endregion

const post = async (path: string, body: unknown = {}): Promise<Record<string, unknown>> =>
  (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

// #region markup
/** Anything the person may point at carries data-focus: here, a row per order, and its total as a part. */
export function orderRow(order: Order): HTMLTableRowElement {
  const row = document.createElement("tr");
  for (const [name, value] of Object.entries(focusAttrs({ kind: "order", id: order.id }))) row.setAttribute(name, value);
  const total = document.createElement("td");
  for (const [name, value] of Object.entries(focusAttrs({ kind: "order", id: order.id, part: "total" }))) total.setAttribute(name, value);
  total.textContent = `€${order.total_eur}`;
  row.append(Object.assign(document.createElement("td"), { textContent: order.customer }), Object.assign(document.createElement("td"), { textContent: order.status }), total);
  return row;
}
// #endregion

// #region view
/** The screen as identifiers: sent when it changes (debounced, and only while the tab is visible). */
const reportView = createViewReporter((view) => void post("/api/view", view));
export function showOrders(status: "open" | "shipped" | null, selected: string | null): void {
  reportView({ screen: "orders", params: status ? { status } : {}, selection: selected ? { kind: "order", id: selected } : null });
}
// #endregion

// #region bar
/** The agent bar, top right: every agent's mark (drag it onto a row), its pin, × to unpin, ⊘ to revoke. */
defineAgentBar();
const bar = document.querySelector("apc-agents") as ApcAgentsElement;
const marks = new Map<string, string>(); // grant id -> initials, for presence
const onAgent = (event: string, run: (id: string) => Promise<unknown>) => bar.addEventListener(event, (e) => void run((e as CustomEvent<{ id: string }>).detail.id).then(refresh));
onAgent("apc-revoke", (id) => post(`/api/agents/${id}/revoke`));
onAgent("apc-unpin", (id) => post(`/api/agents/${id}/unpin`));
onAgent("apc-unlink", (id) => post(`/api/agents/${id}/unlink`));

/** The agents, from the server: into the bar and the Direct agent list. */
async function refresh(): Promise<void> {
  const rows = (await (await fetch("/api/agents/list")).json()) as AgentRow[];
  marks.clear();
  for (const row of rows) marks.set(row.id, initials(row.name, new Set(marks.values())));
  bar.agents = rows.map((a) => ({ id: a.id, name: a.name, state: "idle", paths: a.paths, pin: a.pin ? { ...a.pin, here: true } : null }));
  direct.agents = rows.filter((a) => a.url).map((a) => ({ id: a.id, name: a.name, url: a.url!, connected: a.client !== null, client: a.client, linked: a.paths.length === 2 }));
}
// #endregion

// #region direct
/** Direct: the list where the person makes an agent and copies its URL (and a prompt) into their agent. */
defineDirectAgents();
const direct = document.querySelector("apc-direct-agents") as ApcDirectAgentsElement;
direct.appName = "Orders";
direct.addEventListener("apc-add", () => void post("/api/agents").then(refresh));
// #endregion

// #region events
/** The page's stream: an open page (what `then` and wait_for_focus look at), presence, and changes. */
const events = new EventSource("/api/events");
events.onmessage = (message) => {
  const data = JSON.parse(message.data as string) as { type: string; event?: Parameters<typeof flashTargets>[0] };
  if (data.type === "presence" && data.event) flashTargets(data.event, marks.get(data.event.grant_id) ?? "?");
  else void refresh();
};
// #endregion

// #region pinning
/**
 * Pinning: a mark dragged (or, on a phone, tapped then a row tapped) onto anything with data-focus pins that
 * agent there. Agents dropped from a dock come with a hub and a ticket, and always go to the server.
 */
enablePinning({
  onPin: (grantId, target) => void post(`/api/agents/${grantId}/pin`, { target }).then(refresh),
  acceptNativeDrops: true,
  resolveAgent: () => null, // every dock drop goes to the server, which decides
  onUnknownAgent: (drag, target) => void dropFromDock(drag, target),
  profiles: () => loadApcProfiles(),
  direct: { name: "Orders", connect: `${location.origin}/agents` },
});

/** The server asks for the person's yes first (consent_required with a nonce); their Allow sends it back. */
async function dropFromDock(drag: AgentDrag & { hub: string; ticket: string }, target: FocusTarget, consent?: string): Promise<void> {
  const answer = await post("/api/drop", { hub: drag.hub, agent: drag.agent, ticket: drag.ticket, target, consent });
  if (answer.error === "consent_required" && typeof answer.consent === "string") {
    if (confirm(`Let your agent from the dock at ${new URL(drag.hub).host} read Orders?`)) await dropFromDock(drag, target, answer.consent);
    return;
  }
  await refresh();
}
// #endregion

void refresh();
