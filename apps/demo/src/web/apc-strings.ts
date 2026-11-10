/**
 * Strings for the `@tineira/apc-web` components Pulse shows (TIN-668). Pulse ships English: nothing here is
 * set in its own page, so every component keeps the package's defaults. An embedder (or a test) wraps Pulse in
 * `PulseStringsContext.Provider`, or gives a wrapper its `strings` prop, and every visible string the package
 * draws comes from that object. Plain TypeScript (no JSX), so a unit test can drive it.
 */
import type { BarStrings, DirectStrings, PinStrings, PinningStrings } from "@tineira/apc-web";
import { createContext, useContext } from "react";

export interface PulseStrings {
  /** `<apc-agents>`, and `mergePins` for a linked agent's two pins. */
  bar?: Partial<BarStrings>;
  /** `<apc-pin>`. */
  pin?: Partial<PinStrings>;
  /** `<apc-direct-agents>`. */
  direct?: Partial<DirectStrings>;
  /** `enablePinning`: the tap-to-pin note, refused drops, the Direct-only note. */
  pinning?: Partial<PinningStrings>;
}

export const PulseStringsContext = createContext<PulseStrings | undefined>(undefined);
export const usePulseStrings = (): PulseStrings | undefined => useContext(PulseStringsContext);

/**
 * Hands a component its strings. Nothing given and nothing set before: the element is left alone, so
 * without a prop Pulse is exactly what it was. Given, then removed: back to the English defaults.
 */
export function forwardStrings<S>(el: { strings: Partial<S> | null }, strings: Partial<S> | undefined): void {
  if (strings === undefined && el.strings === null) return;
  el.strings = strings ?? null;
}
