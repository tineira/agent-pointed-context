import { clearApcConnect, defineHandoff, takeApcConnect, type ApcHandoffElement } from "@tineira/apc-web";

const EXPIRED = "This link expired. Drop the agent again, or use Connect an app in your dock.";
type Answer = { ok?: boolean; error?: string; consent?: string; grant_id?: string; pairing?: { code: string; expires_at: string }; pin_error?: string };

/** A separate entry: no analytics, fonts or third-party scripts. The head has already removed the fragment. */
export async function mountDockConnect(): Promise<void> {
  const main = document.querySelector("main")!;
  const message = document.querySelector<HTMLElement>("#message")!;
  const account = document.querySelector<HTMLElement>("#account")!;
  const card = document.querySelector<HTMLElement>("#consent")!;
  const handoff = document.querySelector("apc-handoff") as ApcHandoffElement;
  let base = "";
  let grant: string | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const end = (text: string) => { message.textContent = text; card.replaceChildren(); clearApcConnect(); };
  const post = async (path: string, body: unknown): Promise<Answer & { sid?: string }> => {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body), referrerPolicy: "no-referrer" });
    if (![200, 400].includes(response.status)) throw new Error(`The app did not answer (${response.status}). Open the app and try connecting again.`);
    return response.json() as Promise<Answer & { sid?: string }>;
  };
  const refused = (error?: string) => error === "ticket_expired" || error === "dock_expired" || error === "consent_expired" ? EXPIRED
    : error === "ticket_not_for_pairing" ? "Drop the agent again, then confirm in your dock."
    : `Could not connect: ${error ?? "the app did not answer"}.`;
  try {
    // Validates the stored handoff before even the session request. Nothing is kept in localStorage.
    const connect = takeApcConnect();
    if (!connect) return end(EXPIRED);
    const host = new URL(connect.hub).host;
    if (main.dataset.session !== "false") {
      const session = await post("/api/session", {});
      if (!session.sid) throw new Error("Open the app to start a sandbox, then connect again.");
      base = `/api/s/${session.sid}`;
      account.textContent = `${main.dataset.app} sandbox: ${session.sid}`;
    } else account.textContent = `Signed in: ${main.dataset.account}`;
    const endpoint = base ? `${base}/connect/dock` : "/api/connect/dock";
    const asked = await post(endpoint, connect);
    if (asked.error !== "consent_required" || !asked.consent) return end(refused(asked.error));
    message.textContent = `Let your agent from the dock at ${host} read ${main.dataset.app}? After Allow, your dock will ask for a code.`;
    const allow = Object.assign(document.createElement("button"), { type: "button", textContent: "Allow" });
    const deny = Object.assign(document.createElement("button"), { type: "button", textContent: "Not now" });
    // Keep Pulse's existing choice of access. Signals and Orders grant their existing full access.
    const region = document.createElement("select");
    if (main.dataset.app === "Pulse") {
      region.setAttribute("aria-label", "Access");
      for (const [value, label] of [["", "All of Pulse"], ["na", "NA only"], ["emea", "EMEA only"], ["latam", "LATAM only"]]) region.add(new Option(label, value));
      card.append(region);
    }
    deny.onclick = () => end("Connection cancelled.");
    allow.onclick = () => {
      allow.disabled = deny.disabled = true;
      void (async () => {
        const paired = await post(endpoint, { ...connect, consent: asked.consent, region: region.value || null });
        clearApcConnect();
        if (!paired.ok || !paired.grant_id || !paired.pairing) return end(refused(paired.error));
        grant = paired.grant_id;
        card.replaceChildren();
        message.textContent = paired.pin_error ? `Connected, but not pinned (${paired.pin_error}). Drop the agent again after your dock connects.` : "Type this code only in your own dock.";
        defineHandoff();
        handoff.hidden = false;
        handoff.host = host;
        handoff.pairing = paired.pairing;
        handoff.autoFocus = true;
        handoff.addEventListener("apc-cancel", () => void post(base ? `${base}/hub/cancel` : "/api/cancel", { grant_id: grant }).then(() => { clearTimeout(poll); handoff.hidden = true; end("Connection cancelled."); }).catch((e: unknown) => end(String(e))));
        // Follow the app's state, so a code taken by the dock disappears without a second drop.
        const follow = async () => {
          const response = await fetch(base ? `${base}/state` : "/api/agents/list", { credentials: "same-origin", referrerPolicy: "no-referrer" });
          if (!response.ok) return;
          const state = await response.json() as { hub_links?: Array<{ grant_id: string; state: string; pairing?: Answer["pairing"] }>; grants?: Array<{ id: string; state?: string; pairing_code?: string; pairing_expires_at?: string }> } | Array<{ id: string; waiting: string | null; pairing: Answer["pairing"] }>;
          let waiting = false;
          if (Array.isArray(state)) {
            const row = state.find((r) => r.id === grant);
            waiting = !!row?.waiting;
            handoff.pairing = row?.pairing ?? null;
          } else if (state.hub_links) {
            const row = state.hub_links.find((r) => r.grant_id === grant);
            waiting = row?.state === "handoff";
            handoff.pairing = row?.pairing ?? null;
          } else {
            const row = state.grants?.find((r) => r.id === grant);
            waiting = row?.state === "handoff";
            handoff.pairing = row?.pairing_code && row.pairing_expires_at ? { code: row.pairing_code, expires_at: row.pairing_expires_at } : null;
          }
          if (!waiting) { handoff.hidden = true; message.textContent = "The connection finished. Open the app to check your agent."; return; }
          poll = setTimeout(() => void follow().catch(() => {}), 1500);
        };
        poll = setTimeout(() => void follow().catch(() => {}), 1500);
      })().catch((error: unknown) => end(String(error)));
    };
    card.append(deny, allow);
    deny.focus();
  } catch (error) { end(String(error)); }
}

void mountDockConnect();
