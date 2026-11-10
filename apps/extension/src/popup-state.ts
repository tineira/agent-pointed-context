/**
 * What the toolbar popup shows and what each click does (TIN-786, DESIGN.md 13.3), as pure functions: no chrome.*
 * here, so the tests run them. popup.ts reads storage and Chrome, asks these what to draw, and carries out the
 * plan a click returns. Nothing here changes what a stored value means: `decide` in drop.ts is the one reader of them.
 */
import { agentName, grantedAlone, isSensitive, STATUS_TEXT, type DropStatus, type Mode, type SiteChoice } from "./drop.ts";

/** The agent's name as the popup draws it: the same cleaner the page's notes and `last` use (drop.ts). */
export { agentName };

/** What a site's control can select: "ask" is no stored value. */
export type Choice = "ask" | SiteChoice;

/** "Government domain", ".bank domain" or ".insurance domain": why a domain always asks. */
export function domainKind(host: string): string {
  const labels = host.toLowerCase().replace(/:\d+$/, "").split(".");
  const tld = labels.at(-1);
  return tld === "bank" ? ".bank domain" : tld === "insurance" ? ".insurance domain" : "Government domain";
}

/** What the popup knows of this tab's site. */
export interface SiteState {
  origin: string;
  host: string;
  /** The stored choice for the site, when it is one of the three values. */
  stored: SiteChoice | undefined;
  mode: Mode;
  /** The grant for any page ("Every site"). */
  anyPage: boolean;
  /** Every granted pattern but the any-page ones: what makes a site "granted by itself". */
  own: readonly string[];
  /** The patterns the manifest requires (ownPatterns): Chrome lists them and never lets one go. */
  required?: readonly string[];
}

export interface Option {
  value: Choice;
  selected: boolean;
  disabled: boolean;
}

export type SiteView =
  /** Not allowed: nothing reaches this page yet. */
  | { kind: "allow" }
  /** Never ask is on and the site is not set to Never. */
  | { kind: "never-ask" }
  /** A government, .bank or .insurance domain: always asks, two choices. */
  | { kind: "domain"; label: string; options: Option[] }
  /** The three-way control (two-way for a site granted by itself while Every site is off) and the tick. */
  | { kind: "control"; options: Option[]; tick: { checked: boolean; disabled: boolean } };

/** Whether the site has a grant of its own (by itself, from the popup), not only through Every site. */
export const hasOwnGrant = (s: Pick<SiteState, "origin" | "own">): boolean => grantedAlone(s.origin, s.own);

/** The site's own exact pattern, the only one a click ever removes for it. */
export const exactPattern = (origin: string): string => `${origin}/*`;

/**
 * Ask first is offered when it can be true: the site has no grant of its own, or Every site is on and removing the site's
 * own exact pattern leaves nothing else granting it. On a site granted by itself while Every site is off nothing stored
 * can make it ask, and removing the grant would leave the site not allowed: it is not offered.
 */
export function askOffered(s: SiteState): boolean {
  if (!hasOwnGrant(s)) return true;
  const exact = exactPattern(s.origin);
  const removable = s.own.includes(exact) && !(s.required ?? []).includes(exact);
  return s.anyPage && removable && !grantedAlone(s.origin, s.own.filter((p) => p !== exact));
}

export function siteView(s: SiteState): SiteView {
  const own = hasOwnGrant(s);
  if (!s.anyPage && !own) return { kind: "allow" };
  if (s.stored !== "never" && s.mode === "never_ask") return { kind: "never-ask" };
  const opt = (value: Choice, selected: boolean, disabled = false): Option => ({ value, selected, disabled });
  if (isSensitive(s.host)) {
    const never = s.stored === "never";
    return { kind: "domain", label: domainKind(s.host), options: [opt("sensitive", !never), opt("never", never)] };
  }
  const selected: Choice | null = s.stored ?? (own ? "always" : "ask");
  const effective: Choice = selected === "sensitive" ? "ask" : selected;
  const options: Option[] = [];
  // With the tick on, Ask first is the selected word when it is offered; when it is not, the tick alone says it.
  if (askOffered(s)) options.push(opt("ask", effective === "ask"));
  options.push(opt("always", effective === "always", s.stored === "sensitive"), opt("never", effective === "never"));
  return { kind: "control", options, tick: { checked: s.stored === "sensitive", disabled: s.stored === "never" } };
}

/** The click's plan: what to do with this site's stored key, and whether to remove the site's own grant afterwards. */
export interface Plan {
  /** undefined: leave the key; null: delete it; a value: set it. */
  write: SiteChoice | null | undefined;
  revoke: string | null;
}

export type SiteClick = "ask" | "always" | "never" | "tick-on" | "tick-off";

/**
 * What giving up a stored value (Never send, Sensitive site, or a plain Ask first) produces, said once: no stored value, and,
 * when the site has its own grant and Ask first is offered, that grant removed, so the site asks through the grant for any
 * page instead of being sent by its own. When Ask first is not offered (a site granted by itself while Every site is off) the
 * grant stays and the site reads Always send, which is what a grant by itself means and what the control then shows.
 */
function release(s: SiteState): Plan {
  return { write: null, revoke: hasOwnGrant(s) && askOffered(s) ? exactPattern(s.origin) : null };
}

/** What a click on the site's control writes, or null when the click is not offered. Nothing else is ever written. */
export function siteClick(s: SiteState, click: SiteClick): Plan | null {
  if (isSensitive(s.host)) {
    if (click === "never") return { write: "never", revoke: null };
    if (click === "ask") return { write: null, revoke: null };
    return null;
  }
  switch (click) {
    case "never":
      return { write: "never", revoke: null };
    case "always":
      return s.stored === "sensitive" ? null : { write: "always", revoke: null };
    case "ask":
      return askOffered(s) ? release(s) : null;
    case "tick-on":
      return s.stored === "never" ? null : { write: "sensitive", revoke: null };
    case "tick-off":
      return s.stored === "sensitive" ? release(s) : null;
  }
}

/** One line of "Your sites". */
export interface Row {
  /** The host, or the pattern without its scheme for a grant that is not one origin. */
  label: string;
  /** The `sites` key this row's select writes, or null for a pattern that is not one origin (no select). */
  origin: string | null;
  /** The effective choice shown: a sensitive domain asks, whatever is stored. */
  value: SiteChoice;
  /** Always send is not offered on a domain that always asks. */
  alwaysDisabled: boolean;
  /** The stored key this row's x deletes. */
  stored: boolean;
  /** The site's own grant this row's x removes. */
  revoke: string | null;
  /** The x's tooltip: "Back to Ask first" only when the site is left asking. */
  tip: string;
  /** False when removing the row would leave a site that asks or is blocked sent by another grant (a wildcard one). */
  removable: boolean;
}

const originOfPattern = (p: string): string | null => {
  const m = /^(https?):\/\/([^/*]+)\/\*$/.exec(p);
  return m ? `${m[1]}://${m[2]}` : null;
};

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * The rows of "Your sites": the stored choices (always, never, sensitive; anything else is ignored) and the sites granted by
 * themselves with no stored choice (`own`, never the extension's own patterns nor the any-page grant: grantedByPerson).
 */
export function rowsOf(sites: Readonly<Record<string, unknown>>, own: readonly string[], anyPage: boolean): Row[] {
  const rows: Row[] = [];
  const tip = (revoke: string | null) => (revoke && !anyPage ? "Remove" : "Back to Ask first");
  for (const [origin, v] of Object.entries(sites)) {
    if (v !== "always" && v !== "never" && v !== "sensitive") continue;
    const host = hostOf(origin);
    const revoke = own.includes(exactPattern(origin)) ? exactPattern(origin) : null;
    const domain = isSensitive(host);
    const stillGranted = grantedAlone(origin, own.filter((p) => p !== revoke));
    rows.push({ label: host, origin, value: v === "never" ? "never" : domain ? "sensitive" : v, alwaysDisabled: domain, stored: true, revoke, tip: tip(revoke), removable: !(stillGranted && v !== "always" && !domain) });
  }
  for (const p of own) {
    const origin = originOfPattern(p);
    if (origin && origin in sites && ["always", "never", "sensitive"].includes(sites[origin] as string)) continue;
    const domain = !!origin && isSensitive(hostOf(origin));
    rows.push({ label: p.replace(/\/\*$/, "").replace(/^https?:\/\//, ""), origin, value: domain ? "sensitive" : "always", alwaysDisabled: domain, stored: false, revoke: p, tip: tip(p), removable: true });
  }
  return rows;
}

/** What a row's select writes: always / sensitive / never for that one site. */
export const rowWrite = (row: Row, value: SiteChoice): { origin: string; value: SiteChoice } | null => (row.origin ? { origin: row.origin, value } : null);

/** What a row's x does: delete its key, then remove its own grant. Never another site, any page or any other key. */
export const rowRemove = (row: Row): { deleteKey: string | null; revoke: string | null } => ({ deleteKey: row.stored ? row.origin : null, revoke: row.revoke });

/** How each status the worker can write reads in "Last drop". A test fails when a status has no entry. */
export const STATUS_KIND: Record<DropStatus, "sent" | "waiting" | "failed" | "none"> = {
  sent: "sent",
  asking: "waiting",
  denied: "failed",
  timeout: "failed",
  no_ticket: "failed",
  unknown_dock: "failed",
  error: "failed",
  blocked: "failed",
  not_here: "failed",
  outline_changed: "failed",
  opaque_frame: "failed",
  // Never written to `last`: they are what the card asks, before anything is decided.
  consent: "none",
  consent_sensitive: "none",
  consent_update: "none",
};

/** A wait for the dock ends within 60 s; after this long a `last` still saying "asking" is a wait nobody is on. */
export const WAIT_STALE_MS = 75_000;

export type LastView =
  | { kind: "sent"; lead: string; at: string; detail: string }
  | { kind: "waiting"; text: string; hub: string | null }
  | { kind: "failed"; lead: string; at: string; reason: string };

/** The name kept for the one reader on this hub, when a `last` of today's shape names no agent. */
function nameOnHub(hub: unknown, known: { readers: Readonly<Record<string, unknown>>; names: Readonly<Record<string, unknown>> } | undefined): string | null {
  if (!known || typeof hub !== "string") return null;
  const keys = Object.keys(known.readers).filter((k) => k.split(" ")[0] === hub);
  return keys.length === 1 ? agentName(known.names[keys[0]!]) : null;
}

/** "Not sent", with its punctuation, at the start of a status line (Part 2 words every failure that way). */
const reasonOf = (text: string): string => text.replace(/^Not sent\W*/, "").trim() || text;

/**
 * The popup's Last drop from the stored `last` (`{at, hub, site, status}`; Part 2 adds `agent` and `leftOut`, an older one has
 * neither), or null when nothing is to be drawn. A missing agent is "your agent"; a missing `leftOut` is absent, never zero.
 */
export function lastView(last: unknown, now: number, known?: { readers: Readonly<Record<string, unknown>>; names: Readonly<Record<string, unknown>> }): LastView | null {
  if (!last || typeof last !== "object") return null;
  const l = last as { at?: unknown; hub?: unknown; site?: unknown; status?: unknown; agent?: unknown; leftOut?: unknown };
  if (typeof l.at !== "string" || typeof l.status !== "string" || !(l.status in STATUS_KIND)) return null;
  let status = l.status as DropStatus;
  const site = typeof l.site === "string" ? l.site : "";
  if (status === "asking" && now - Date.parse(l.at) > WAIT_STALE_MS) status = "timeout";
  switch (STATUS_KIND[status]) {
    case "sent": {
      const n = typeof l.leftOut === "number" && Number.isInteger(l.leftOut) && l.leftOut >= 1 ? l.leftOut : 0;
      const out = n ? ` · ${n === 1 ? "1 number" : `${n} numbers`} left out` : "";
      return { kind: "sent", lead: `✓ Sent to ${agentName(l.agent) ?? nameOnHub(l.hub, known) ?? "your agent"}`, at: l.at, detail: `${site}${out}` };
    }
    case "waiting":
      return { kind: "waiting", text: "Allow this browser in your dock", hub: typeof l.hub === "string" ? l.hub : null };
    case "failed":
      return { kind: "failed", lead: "✕ Not sent", at: l.at, reason: reasonOf(STATUS_TEXT[status]) };
    default:
      return null;
  }
}

/** The pill in the header, from what is stored (no network): the name, "N agents", or "Not paired". */
export function pillOf(readers: Readonly<Record<string, unknown>>, names: Readonly<Record<string, unknown>>, last: unknown): { text: string; on: boolean } {
  const keys = Object.keys(readers);
  if (!keys.length) return { text: "Not paired", on: false };
  if (keys.length > 1) return { text: `${keys.length} agents`, on: true };
  const key = keys[0]!;
  const l = (last ?? {}) as { hub?: unknown; agent?: unknown };
  const fromLast = l.hub === key.split(" ")[0] ? agentName(l.agent) : null;
  return { text: agentName(names[key]) ?? fromLast ?? "Paired", on: true };
}

/** A paired agent as Settings lists it: its name (never its id) and its hub's host. */
export function agentRow(key: string, names: Readonly<Record<string, unknown>>): { name: string; hub: string } {
  const hub = key.split(" ")[0] ?? key;
  return { name: agentName(names[key]) ?? "your agent", hub: hostOf(hub) };
}
