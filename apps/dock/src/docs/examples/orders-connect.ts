/**
 * Orders' Connect page client (APC 0.13): build this entry as the same-origin asset `connectScript` names
 * (/assets/dock-connect.js by default). Self-contained: it needs only @tineira/apc-web. The page's head script
 * (`dockConnectPage` in orders-app.ts) has already removed the `#apc_connect` fragment before this runs.
 */
import { clearApcConnect, defineHandoff, takeApcConnect, type ApcHandoffElement } from "@tineira/apc-web";

const EXPIRED = "This link expired. Drop the agent again, or use Connect an app in your dock.";
const SIGN_IN = "Sign in first, then return here to finish connecting.";
type Pairing = { code: string; expires_at: string };
type Answer = { ok?: boolean; error?: string; consent?: string; replaces?: boolean; grant_id?: string; pairing?: Pairing; pin_error?: string; unauthorized?: boolean };

async function mountOrdersConnect(): Promise<void> {
  const main = document.querySelector("main")!;
  const message = document.querySelector<HTMLElement>("#message")!;
  const account = document.querySelector<HTMLElement>("#account")!;
  const card = document.querySelector<HTMLElement>("#consent")!;
  const handoff = document.querySelector("apc-handoff") as ApcHandoffElement;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const end = (text: string) => { message.textContent = text; card.replaceChildren(); clearApcConnect(); };
  const post = async (path: string, body: unknown): Promise<Answer> => {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body), referrerPolicy: "no-referrer" });
    if (response.status === 401) return { unauthorized: true };
    if (![200, 400].includes(response.status)) throw new Error(`Orders did not answer (${response.status}). Open Orders and try connecting again.`);
    return response.json() as Promise<Answer>;
  };
  const refused = (error?: string) => error === "ticket_expired" || error === "dock_expired" || error === "consent_expired" ? EXPIRED
    : error === "ticket_not_for_pairing" ? "Drop the agent again, then confirm in your dock."
    : `Could not connect: ${error ?? "Orders did not answer"}.`;
  try {
    // The stored handoff is validated before any request. Nothing is kept in localStorage.
    const connect = takeApcConnect();
    if (!connect) return end(EXPIRED);
    const host = new URL(connect.hub).host;
    if (main.dataset.signedIn === "false") {
      account.textContent = main.dataset.account || "No account signed in.";
      message.textContent = SIGN_IN;
      return;
    }
    account.textContent = `Signed in: ${main.dataset.account}`;
    const asked = await post("/api/connect/dock", connect);
    if (asked.unauthorized) return void (message.textContent = SIGN_IN);
    if (asked.error !== "consent_required" || !asked.consent) return end(refused(asked.error));
    message.textContent = `Let your agent from the dock at ${host} read Orders?${asked.replaces ? " This replaces the current connection." : ""} After Allow, your dock will ask for a code.`;
    const allow = Object.assign(document.createElement("button"), { type: "button", textContent: "Allow" });
    const deny = Object.assign(document.createElement("button"), { type: "button", textContent: "Not now" });
    deny.onclick = () => end("Connection cancelled.");
    allow.onclick = () => {
      allow.disabled = deny.disabled = true;
      void (async () => {
        const paired = await post("/api/connect/dock", { ...connect, consent: asked.consent });
        if (paired.unauthorized) {
          card.replaceChildren();
          message.textContent = SIGN_IN;
          return;
        }
        clearApcConnect();
        if (!paired.ok || !paired.grant_id || !paired.pairing) return end(refused(paired.error));
        const grant = paired.grant_id;
        card.replaceChildren();
        message.textContent = paired.pin_error ? `Connected, but not pinned (${paired.pin_error}). Drop the agent again after your dock connects.` : "Type this code only in your own dock.";
        defineHandoff();
        handoff.hidden = false;
        handoff.host = host;
        handoff.pairing = paired.pairing;
        handoff.autoFocus = true;
        handoff.addEventListener("apc-cancel", () => {
          void post("/api/cancel", { grant_id: grant })
            .then((r) => {
              clearTimeout(poll);
              if (r.ok) { handoff.hidden = true; end("Connection cancelled."); return; }
              if (r.error === "not_cancellable") { handoff.hidden = true; end("The dock has connected already. To take its access back, revoke the agent."); return; }
              message.textContent = refused(r.error);
            })
            .catch((e: unknown) => { message.textContent = String(e); });
        });
        // Follow Orders' agent list, so a code the dock took disappears without a second drop.
        const follow = async () => {
          const response = await fetch("/api/agents/list", { credentials: "same-origin", referrerPolicy: "no-referrer" });
          if (!response.ok) return;
          const row = ((await response.json()) as Array<{ id: string; waiting: string | null; pairing: Pairing | null }>).find((r) => r.id === grant);
          handoff.pairing = row?.pairing ?? null;
          if (!row?.waiting) { handoff.hidden = true; message.textContent = "The connection finished. Open Orders to check your agent."; return; }
          poll = setTimeout(() => void follow().catch(() => {}), 1500);
        };
        poll = setTimeout(() => void follow().catch(() => {}), 1500);
      })().catch((error: unknown) => end(String(error)));
    };
    card.append(deny, allow);
    deny.focus();
  } catch (error) { end(String(error)); }
}

void mountOrdersConnect();
