/**
 * Which Wake on pin card `/agents#wake-<grant id>` (wake_on_pin's paste_at) opens, as pure decisions (TIN-973, TIN-981):
 * what wake-on-pin.tsx does with the address on load, on a hashchange, when the person closes a card, and when it
 * scrolls. No DOM here: the component reads the address and hands it in.
 */

/** The card (its element id, `wake-<grant id>`) a `#wake-<grant id>` address names, or null. */
export function wakeCardOf(hash: string): string | null {
  return /^#wake-g_[0-9a-f]+$/.test(hash) ? hash.slice(1) : null;
}

/**
 * The card the address named when the page loaded, read once as the module loads (Pulse's routing and its sandbox start
 * can drop the hash before the cards mount), and handed out once: the first list to mount opens it, a later one does not.
 */
export function wakeLinkAtLoad(hashAtLoad: string | null): { mount(hash: string): string | null } {
  let atLoad = hashAtLoad === null ? null : wakeCardOf(hashAtLoad);
  return {
    /** The card open when the list mounts: the address's own, else the one it named at load (then forgotten). */
    mount(hash: string): string | null {
      const open = wakeCardOf(hash) ?? atLoad;
      atLoad = null;
      return open;
    },
  };
}

/** A hashchange in a page already open: the card it names opens and is to be scrolled to; any other hash changes nothing. */
export function wakeOnHashChange(hash: string): { open: string; pending: true } | null {
  const open = wakeCardOf(hash);
  return open ? { open, pending: true } : null;
}

/** A card toggled by the person: closing the open one closes it for good (nothing reopens it but a new link); else as it was. */
export function wakeAfterToggle(open: string | null, card: string, nowOpen: boolean): string | null {
  return !nowOpen && open === card ? null : open;
}

/** Whether to scroll to the open card now: one is open, not yet scrolled to, and the cards are shown. */
export function wakeScrollDue(open: string | null, shown: string, pending: boolean): open is string {
  return !!open && !!shown && pending;
}
