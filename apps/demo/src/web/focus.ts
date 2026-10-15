import { focusAttrs, type FocusAttrs } from "@apc/protocol";
import type { FigureKey } from "../model/figures.ts";

/**
 * The only way the page marks something pointable. A test scans the page for
 * figureFocus("<key>" and checks it against the figure registry, both ways.
 */
export function figureFocus(key: FigureKey, params: Record<string, string | undefined>, part: string | null = null): FocusAttrs {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>;
  return focusAttrs({ kind: "figure", id: null, part, params: { key, ...clean } });
}

export function customerFocus(id: string, part: "plan" | "seats" | "usage" | "status" | null = null): FocusAttrs {
  return focusAttrs({ kind: "customer", id, part });
}
