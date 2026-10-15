import type { FocusParams, FocusTarget, KeyValue } from "./types.ts";

/** The part grammar of the specification (the PFA 0114 check). */
export const PART_RE = /^[a-z][a-z0-9_]{0,31}(:[A-Za-z0-9_.|:-]{1,80})?$/;
const KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:|-]{1,80}$/;
/** A bare number is an amount, never a key. Months ("2026-03") and ids pass. */
const NUMBER_RE = /^[-+]?\d+(\.\d+)?$/;
export const PARAMS_MAX_BYTES = 1024;

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value) && !NUMBER_RE.test(value);
}

/** Keys only: string tokens or short lists of them; no numbers, no free text, at most 1 KB. */
export function parseParams(raw: unknown): FocusParams | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: FocusParams = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PARAM_KEY_RE.test(key)) return null;
    if (Array.isArray(value)) {
      if (value.length === 0 || value.length > 20 || !value.every(isToken)) return null;
      out[key] = [...value] as string[];
    } else if (isToken(value)) {
      out[key] = value;
    } else {
      return null;
    }
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > PARAMS_MAX_BYTES) return null;
  return out;
}

/** A valid target, or null. A target names a row (id) or a computation (params), or both. */
export function parseTarget(raw: { kind?: unknown; id?: unknown; part?: unknown; params?: unknown }): FocusTarget | null {
  const kind = raw.kind;
  if (typeof kind !== "string" || !KIND_RE.test(kind)) return null;
  const id = raw.id === null || raw.id === undefined || raw.id === "" ? null : raw.id;
  if (id !== null && (typeof id !== "string" || !ID_RE.test(id))) return null;
  const part = raw.part === null || raw.part === undefined || raw.part === "" ? null : raw.part;
  if (part !== null && (typeof part !== "string" || !PART_RE.test(part))) return null;
  const params = parseParams(raw.params);
  if (raw.params !== null && raw.params !== undefined && params === null) return null;
  if (id === null && params === null) return null;
  return { kind, id: id as string | null, part: part as string | null, params };
}

/** One canonical string per target: param order does not matter. */
export function canonicalTarget(target: FocusTarget): string {
  const params = target.params
    ? Object.fromEntries(Object.entries(target.params).sort(([a], [b]) => a.localeCompare(b)))
    : null;
  return JSON.stringify([target.kind, target.id, target.part, params]);
}

/** The three DOM attributes a pointable element carries. */
export interface FocusAttrs {
  "data-focus": string;
  "data-focus-part"?: string;
  "data-focus-params"?: string;
}

export function focusAttrs(target: { kind: string; id?: string | null; part?: string | null; params?: Record<string, KeyValue> | null }): FocusAttrs {
  const attrs: FocusAttrs = { "data-focus": `${target.kind}:${target.id ?? ""}` };
  if (target.part) attrs["data-focus-part"] = target.part;
  if (target.params) attrs["data-focus-params"] = JSON.stringify(target.params);
  return attrs;
}

export function parseFocusAttrs(focus: string | null, part: string | null, params: string | null): FocusTarget | null {
  if (!focus) return null;
  const colon = focus.indexOf(":");
  if (colon < 1) return null;
  let parsedParams: unknown = null;
  if (params) {
    try {
      parsedParams = JSON.parse(params);
    } catch {
      return null;
    }
  }
  return parseTarget({ kind: focus.slice(0, colon), id: focus.slice(colon + 1), part, params: parsedParams });
}
