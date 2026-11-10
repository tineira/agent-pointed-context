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

async function render(): Promise<void> {
  const has = await chrome.permissions.contains({ origins: ANY_PAGE });
  grant.hidden = has;
  granted.hidden = !has;
  step1.classList.toggle("done", has);
  dock.classList.toggle("primary", has);
  text("held", WHATS_SENT.heldBack(sensitiveMode((await chrome.storage.local.get("sensitive")).sensitive)));
}

grant.addEventListener("click", async () => {
  grant.disabled = true;
  await chrome.permissions.request({ origins: ANY_PAGE }).catch(() => false);
  grant.disabled = false;
  void render();
});
dock.addEventListener("click", () => void openDock(false));

void render();
