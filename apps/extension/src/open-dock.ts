/**
 * Open dock and Float from the extension (TIN-473): bring the person's dock to the front, or open it
 * in a narrow window like the installed app's strip (TIN-392). Float cannot be opened from here:
 * Chrome opens Document Picture-in-Picture only from a click in the dock's own page, so Float opens the
 * dock with ?float=1, where a prompt takes that one click.
 */
import { HUB_ORIGINS } from "./drop.ts";

/** The dock this browser sends readings to (the newest pairing), or the published one. */
async function dockOrigin(): Promise<string> {
  const readers = ((await chrome.storage.local.get("readers")).readers ?? {}) as Record<string, string>;
  const paired = Object.keys(readers).map((key) => key.split(" ")[0]!);
  return paired.at(-1) ?? HUB_ORIGINS[0]!;
}

export async function openDock(float: boolean): Promise<void> {
  const origin = await dockOrigin();
  const url = `${origin}/dock${float ? "?float=1" : ""}`;
  // By the address's start, not a match pattern, which takes no port (a local dock has one). The
  // extension sees the dock's tab addresses: it holds the dock's host permission.
  const open = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(`${origin}/dock`));
  if (open?.id !== undefined) {
    // Already open: to the front, and reloaded with ?float=1 when Float asked for it.
    await chrome.tabs.update(open.id, { active: true, ...(float ? { url } : {}) });
    if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  await chrome.windows.create({ url, type: "popup", width: 400, height: 760, focused: true });
}
