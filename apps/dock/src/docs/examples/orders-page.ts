/**
 * Orders' page: the browser side of the guide at apc.tineira.com/docs/integrate, with @tineira/apc-web. Plain DOM, so
 * it fits any framework: React, Vue or none. It talks to the server in orders-app.ts (`/api/*`, `/api/events`).
 */
// #region imports
import { T_IDLE_RECOMMENDED_MS, focusAttrs, formatPairingCode, type FocusTarget } from "@tineira/apc-protocol";
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
  type PinningStrings,
  formatPageTime,
  agentBadge,
  defineHeaderPets,
  petState,
  type ApcPetsElement,
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
  showWaiting(rows);
  showPets(rows);
}
// #endregion

// #region waiting
/**
 * Dock: an agent the person allowed here waits until they type its pairing code in their dock. Its row shows
 * the code while it is good, and Cancel, which takes the access back (only before the dock connected; after
 * that it is Revoke in the bar): if their dock never asks for that code, the agent was someone else's. The row
 * believes the server's expiry: past it, it shows no code and says the dock did not finish in time. Once the
 * dock took the code, the row says it is connecting.
 */
const waiting = document.querySelector<HTMLElement>("#waiting") ?? document.body.appendChild(document.createElement("div"));
/** A drop that paired but could not pin its target (the server's `pin_error`), by grant: its row says so. */
const pinErrors = new Map<string, string>();
let waitingRows: AgentRow[] = [];
function showWaiting(rows: AgentRow[] = waitingRows): void {
  waitingRows = rows;
  waiting.replaceChildren(
    ...rows.flatMap((a) => {
      if (!a.waiting) return [];
      const line = document.createElement("p");
      const pinError = pinErrors.get(a.id);
      const left = a.pairing ? Math.max(0, Math.ceil((Date.parse(a.pairing.expires_at) - Date.now()) / 1000)) : 0;
      const says =
        a.waiting === "connecting"
          ? "Your dock took the code and is connecting."
          : left > 0
            ? `Waiting for your dock — code ${formatPairingCode(a.pairing!.code)} (${left} s left). If your dock doesn't ask for this code, the agent wasn't yours: Cancel.`
            : "Your dock didn't finish in time. Drop the agent here again for a new code.";
      line.textContent = `${says} ${pinError ? `Not pinned where you dropped it (${pinError}). ` : ""}`;
      const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: "Cancel" });
      cancel.addEventListener("click", () => void post("/api/cancel", { grant_id: a.id }).then(refresh));
      line.append(cancel);
      return [line];
    }),
  );
}
// The countdown, and the code going away at its expiry.
setInterval(() => waitingRows.some((a) => a.waiting === "code") && showWaiting(), 1000);
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
/**
 * The heartbeat (Dock, APC 0.10): while the page is open it tells the server the person is here, at least every
 * T_idle / 2. A dock agent's grant sleeps T_idle after the last one, and wakes with the next. The server's answer
 * carries the T_idle it runs with (`idle_ms`), so the page follows it; until one arrives it assumes the recommended one.
 */
let idleMs = T_IDLE_RECOMMENDED_MS;
async function heartbeat(): Promise<void> {
  const answer = await post("/api/heartbeat").catch(() => null);
  if (typeof answer?.idle_ms === "number" && answer.idle_ms > 0) idleMs = answer.idle_ms;
  // Every quarter of T_idle: one beat that fails still leaves the next inside T_idle / 2.
  setTimeout(() => void heartbeat(), Math.max(1000, idleMs / 4));
}
void heartbeat();
// #endregion

// #region pets
/**
 * The agent in the page: each agent a pet in the header, up to 3 and then "+N", the same character the dock draws.
 * A pet is a mark too: drag it onto a row to point the agent. Its state comes only from what the page knows: an
 * unread pin, a call presence just reported, a pairing waiting on the person. Never a guess from timing.
 */
defineHeaderPets();
const pets = document.querySelector("apc-pets") as ApcPetsElement;
pets.scheme = "auto"; // follow the page's prefers-color-scheme; an app with a theme switch passes "light" or "dark"
const heard = new Map<string, number>(); // grant id -> when presence last reported a call
events.addEventListener("message", (message) => {
  const data = JSON.parse(message.data as string) as { type: string; event?: { grant_id: string } };
  if (data.type !== "presence" || !data.event) return;
  heard.set(data.event.grant_id, Date.now());
  showPets();
  setTimeout(() => showPets(), 4000);
});
let petRows: AgentRow[] = [];
function showPets(rows: AgentRow[] = petRows): void {
  petRows = rows;
  pets.agents = rows.map((a) => ({
    id: a.id,
    name: a.name,
    badge: agentBadge({ clientName: a.client, key: a.id }),
    pin: a.pin ? { ...a.pin, here: true } : null,
    // An open wait_for_focus shows as `waiting` only from the page-readable wait signal: pass `waiting` when your page has it.
    state: petState({
      connected: a.client !== null,
      busy: Date.now() - (heard.get(a.id) ?? 0) < 4000,
      pin: a.pin && !a.pin.seen ? "unread" : "none",
      requests: a.waiting === "code" ? 1 : 0,
    }),
  }));
}
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

/**
 * The server asks for the person's yes first (consent_required with a nonce and a pairing code); their Allow sends
 * the nonce back, and their dock then asks for the code. A refusal says why: `hub_not_allowed` (a dock this app
 * does not pair with), `consent_expired` (a newer drop of the agent replaced this consent), `pairing_in_progress`.
 */
async function dropFromDock(drag: AgentDrag & { hub: string; ticket: string }, target: FocusTarget, consent?: string): Promise<void> {
  const answer = await post("/api/drop", { hub: drag.hub, agent: drag.agent, ticket: drag.ticket, target, consent });
  if (answer.error === "consent_required" && typeof answer.consent === "string" && typeof answer.pairing_code === "string") {
    const host = new URL(drag.hub).host;
    if (confirm(`Let your agent from the dock at ${host} read Orders? After OK, your dock asks for this code: ${formatPairingCode(answer.pairing_code)}. Type it only in your own dock; never give it to anyone.`)) await dropFromDock(drag, target, answer.consent);
    return;
  }
  // Paired, but the pin on the drop's target failed: the waiting row says so.
  if (answer.ok === true && typeof answer.grant_id === "string" && typeof answer.pin_error === "string") pinErrors.set(answer.grant_id, answer.pin_error);
  await refresh();
}
// #endregion

// #region localize
/**
 * Another language: every string the package draws is a key you can pass, tooltips and `aria-label`s included.
 * A key you leave out stays English. A name, a count or a label is a function, so the word order and the
 * plural forms are yours. Here, Spanish; the pin badge `<apc-pin>` takes `strings` the same way.
 */
bar.strings = {
  toolbar: "Agentes",
  markTitle: (name, connected) => `${name}${connected ? "" : " (aún sin conectar)"}. Arrástralo sobre cualquier cosa para apuntarlo.`,
  revokeConfirm: "¿Revocar?",
  revokeAria: (name) => `Revocar a ${name}`,
  readingCount: (count) => (count === 1 ? "1 leyendo" : `${count} leyendo`),
  nobodyReadingShort: "ningún agente leyendo",
  reading: (names) => `Leyendo: ${names.join(", ")}`,
  dockHint: "Usa este agente en todas tus apps con el dock",
  dockHintDismiss: "Cerrar este aviso",
};
// An app that offers Direct only (no dock) turns the hint off: bar.dockHint = null, or dock-hint="off" on the element.
direct.strings = {
  connectAgent: "Conectar un agente",
  addAnother: "Agregar otro agente",
  prompt: (url, appName) => `Conecta este servidor MCP remoto, llamado "${appName}". URL: ${url}. Usa Streamable HTTP y no necesita OAuth ni clave: el acceso está en la URL.`,
};
/** What `enablePinning` says (the tap-to-pin note, refused drops); pass it as `strings` there. `directOnlyNote` replaces the protocol's English note. */
export const pinningStrings: Partial<PinningStrings> = {
  tapPrompt: (name) => `Toca lo que quieres que ${name} mire.`,
  cancel: "Cancelar",
  directOnlyNote: (appName) => `${appName} conecta agentes directamente, no con un dock.`,
};
/** A time in your own labels (a pin's "read at…") follows the page's language (`<html lang>`), not the machine's. */
export const readAt = (when: Date): string => formatPageTime(when, { timeStyle: "short" });
// #endregion

void refresh();
