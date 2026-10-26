/**
 * The welcome page (TIN-465, DESIGN.md 13.3), opened on install: the one grant for any page, and when
 * the extension asks. The grant is asked from a click here, as Chrome requires.
 */
import { ANY_PAGE, type Mode } from "./drop.ts";

const grant = document.getElementById("grant") as HTMLButtonElement;
const granted = document.getElementById("granted")!;

async function render(): Promise<void> {
  const has = await chrome.permissions.contains({ origins: ANY_PAGE });
  grant.hidden = has;
  granted.hidden = !has;
  const mode = ((await chrome.storage.local.get("mode")).mode as Mode | undefined) ?? "ask";
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.checked = r.value === mode;
}

grant.addEventListener("click", async () => {
  grant.disabled = true;
  await chrome.permissions.request({ origins: ANY_PAGE }).catch(() => false);
  grant.disabled = false;
  void render();
});
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  r.addEventListener("change", () => void chrome.storage.local.set({ mode: r.value as Mode }));
}

void render();
