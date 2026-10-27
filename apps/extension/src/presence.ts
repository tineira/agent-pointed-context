/** A public UI hint only. A page can forge this; it grants no access or checklist progress. */
export const EXTENSION_PRESENT = "data-apc-extension-installed";

export function markDockPresence(root: { setAttribute(name: string, value: string): void }): void {
  root.setAttribute(EXTENSION_PRESENT, "");
}
