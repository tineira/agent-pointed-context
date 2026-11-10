/**
 * The welcome page (TIN-465, TIN-786, DESIGN.md 13.3), opened on install: the one grant for any page, a button
 * that opens the dock, and what is sent. The grant is asked from a click here, as Chrome requires. The page
 * keeps no setting: when to ask and the numbers setting live in the popup; it only reads `sensitive` to say what
 * is held back, and the dock's address (`readers`) through openDock.
 */
import { ANY_PAGE, sensitiveMode, WHATS_SENT } from "./drop.ts";
import { openDock } from "./open-dock.ts";

const grant = document.getElementById("grant") as HTMLButtonElement;
const granted = document.getElementById("granted")!;
const step1 = document.getElementById("step1")!;
const dock = document.getElementById("open-dock") as HTMLButtonElement;
const text = (id: string, value: string) => void (document.getElementById(id)!.textContent = value);

text("sent-label", WHATS_SENT.label);
text("goes-label", WHATS_SENT.labels.goes);
text("held-label", WHATS_SENT.labels.heldBack);
text("where-label", WHATS_SENT.labels.where);
text("goes", WHATS_SENT.goes);
text("where", WHATS_SENT.where);

// Render again when the grant or the numbers setting changes elsewhere (the popup, chrome://extensions), so the
// page never claims what is no longer true. It touches only what the state decides: never `disabled` (the
// grant click owns it while Chrome's dialog is open) and never the disclosure's open state. A later call wins.
let latest = 0;
async function render(): Promise<void> {
  const mine = ++latest;
  const has = await chrome.permissions.contains({ origins: ANY_PAGE });
  const held = WHATS_SENT.heldBack(sensitiveMode((await chrome.storage.local.get("sensitive")).sensitive));
  if (mine !== latest) return;
  grant.hidden = has;
  granted.hidden = !has;
  step1.classList.toggle("done", has);
  dock.classList.toggle("primary", has);
  text("held", held);
}

grant.addEventListener("click", async () => {
  grant.disabled = true;
  await chrome.permissions.request({ origins: ANY_PAGE }).catch(() => false);
  grant.disabled = false;
  void render();
});
dock.addEventListener("click", () => {
  dock.disabled = true;
  void openDock(false).finally(() => (dock.disabled = false));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "sensitive" in changes) void render();
});
chrome.permissions.onAdded.addListener(() => void render());
chrome.permissions.onRemoved.addListener(() => void render());

void render();
