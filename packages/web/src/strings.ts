/**
 * Every string the package puts in the page (TIN-668), so an app in another language ships it without
 * a fork. Each component takes one `strings` object (a `Partial` of its type below): the keys you leave
 * out keep their English default, which is exactly the text the package always showed. A string that
 * holds a name, a count or a label is a function, so the app decides the word order and the plural
 * forms: nothing here is joined from English fragments.
 *
 * - `<apc-agents>`: `agentBar.strings = { ... }` (type `BarStrings`)
 * - `<apc-pin>`: `pin.strings = { ... }` (type `PinStrings`)
 * - `<apc-direct-agents>`: `list.strings = { ... }` (type `DirectStrings`)
 * - `enablePinning({ strings: { ... } })` (type `PinningStrings`)
 *
 * Left as they are, on purpose: the symbols (×, ⊘, ‹, !, ✓), which carry no language; the agents' own
 * names, labels and URLs, which the app passes in; and the page text an agent reads, which is not this
 * package's. The note for a dock agent dropped on a Direct-only app is the protocol's `directOnlyNote`;
 * `PinningStrings.directOnlyNote` replaces it with the app's own words.
 */
import { couldNotCheckNote, directOnlyNote } from "@tineira/apc-protocol";

/** What `<apc-agents>` says. Tooltips and `aria-label`s included. */
export interface BarStrings {
  /** The bar's own `aria-label` (unless the element has one). */
  toolbar: string;
  /** A mark's tooltip: the agent and what to do with it. `connected` is false until it first connects. */
  markTitle(name: string, connected: boolean): string;
  /** A pin dot's tooltip. `read`: the agent read the pin; `here`: its target is on this screen. */
  pinTitle(label: string, read: boolean, here: boolean): string;
  /** A pin dot's `aria-label`. */
  pinAria(name: string, label: string, read: boolean): string;
  /** The × that removes a pin: its `aria-label`. */
  unpinAria(name: string): string;
  /** The ⊘ button's tooltip. `both`: the agent is linked, so revoking cuts both its paths. */
  revokeTitle(name: string, both: boolean): string;
  /** The ⊘ button's `aria-label`. */
  revokeAria(name: string): string;
  /** The ⊘ button's text after the first click. */
  revokeConfirm: string;
  /** The armed button's tooltip and `aria-label`. */
  revokeConfirmTitle(name: string): string;
  /** The tag of an agent that came directly: text, then tooltip. */
  pathDirect: string;
  pathDirectTitle: string;
  pathDock: string;
  pathDockTitle: string;
  /** The tag of an agent linked across both. */
  pathBoth: string;
  pathBothTitle: string;
  /** The Unlink button: text, tooltip and `aria-label`. */
  unlink: string;
  unlinkTitle(name: string): string;
  unlinkAria(name: string): string;
  /** The ‹ button that collapses the bar: tooltip and `aria-label`. */
  collapseTitle: string;
  collapseAria: string;
  /** The collapsed indicator, long form (tooltip and `aria-label`): who is reading. Names in the order given. */
  reading(names: readonly string[]): string;
  /** The same when nobody is. */
  nobodyReading: string;
  /** The collapsed indicator's tooltip and `aria-label`: the summary above, then how to open the bar. */
  showAgents(summary: string): string;
  /** The collapsed indicator's visible text: "2 reading". Plurals are yours. */
  readingCount(count: number): string;
  /** …and when no agent is reading. */
  nobodyReadingShort: string;
  /** The dock hint's text (the link). An app can also set `dockHint = { text, url }`, or turn it off with `dockHint = null`. */
  dockHint: string;
  /** The hint's × button: `aria-label`. */
  dockHintDismiss: string;
  /** Two or more pinned targets of one linked agent as one label: "A and B". Called with the distinct labels. */
  joinPins(labels: readonly string[]): string;
}

export const DEFAULT_BAR_STRINGS: BarStrings = {
  toolbar: "Agents",
  markTitle: (name, connected) => `${name}${connected ? "" : " (not connected yet)"}. Drag onto anything to point this agent.`,
  pinTitle: (label, read, here) => `Pinned to ${label}: ${read ? "your agent read it" : "waiting for your agent's next call"}${here ? "" : ". Click to open it."}`,
  pinAria: (name, label, read) => `${name} pinned to ${label}${read ? ", read" : ", not read yet"}`,
  unpinAria: (name) => `Remove ${name}'s pin`,
  revokeTitle: (name, both) => `Revoke ${name}: it can no longer read this app${both ? ", directly or through the dock" : ""}, at once. To let it back, connect or drop it here again.`,
  revokeAria: (name) => `Revoke ${name}`,
  revokeConfirm: "Revoke?",
  revokeConfirmTitle: (name) => `Click again to revoke ${name}.`,
  pathDirect: "direct",
  pathDirectTitle: "Connected directly, on this app's own MCP URL",
  pathDock: "via dock",
  pathDockTitle: "Came through an agent dock",
  pathBoth: "direct + dock",
  pathBothTitle: "The same agent, connected directly and through a dock. Each way keeps its own access; Revoke cuts both.",
  unlink: "unlink",
  unlinkTitle: (name) => `Show ${name}'s two connections as two agents again. Nothing else changes.`,
  unlinkAria: (name) => `Unlink ${name}`,
  collapseTitle: "Collapse to who is reading. Your agents came through your dock: drag them from there.",
  collapseAria: "Collapse the agent bar",
  reading: (names) => (names.length === 1 ? `${names[0]} is reading` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are reading`),
  nobodyReading: "No agent is reading",
  showAgents: (summary) => `${summary}. Show the agents.`,
  readingCount: (count) => `${count} reading`,
  nobodyReadingShort: "no agent reading",
  dockHint: "Use this agent across apps with the dock",
  dockHintDismiss: "Dismiss this hint",
  joinPins: (labels) => labels.join(" and "),
};

/** What `<apc-pin>` says. */
export interface PinStrings {
  /** The badge's tooltip. */
  title(name: string, seen: boolean): string;
  /** The × button's `aria-label`. */
  unpinAria(name: string): string;
  /** The mark's `aria-label`. */
  markAria(name: string, seen: boolean): string;
}

export const DEFAULT_PIN_STRINGS: PinStrings = {
  title: (name, seen) => `${name}: ${seen ? "read this pin" : "has not read this pin yet"}. Drag to point it at something else.`,
  unpinAria: (name) => `Remove ${name}'s pin`,
  markAria: (name, seen) => `${name}, ${seen ? "has read its pin" : "has not read its pin yet"}`,
};

/** What `<apc-pets>` (the agents in the header, TIN-878) says. */
export interface PetsStrings {
  /** The group's `aria-label`, and the popover's. */
  group: string;
  /** What a state says, after the agent's name (the pet's `aria-label`, and the popover). */
  state(state: "idle" | "waiting" | "calling" | "pinned" | "read" | "pairing" | "dragging" | "offline"): string;
  /** A pet's tooltip. */
  markTitle(name: string): string;
  /** A pet's `aria-label`: its name and what it is doing. */
  markAria(name: string, doing: string): string;
  /** The "+N" button's `aria-label`. */
  moreAria(count: number): string;
  /** The popover's line for an agent's pin: where it points and whether it read it. */
  pinned(label: string, seen: boolean): string;
  /** The popover's line for an agent with no pin. */
  notPinned: string;
  /** Said of a pin whose target is not on this page (the dot on the pet). */
  offPage: string;
  /** The popover's close button. */
  close: string;
}

export const DEFAULT_PETS_STRINGS: PetsStrings = {
  group: "Agents in this page",
  state: (state) =>
    ({
      idle: "connected",
      waiting: "waiting for you to point",
      calling: "calling tools",
      pinned: "pointed at something, not read yet",
      read: "read what you pointed at",
      pairing: "a pairing request waits for you",
      dragging: "being dragged",
      offline: "not connected",
    })[state],
  markTitle: (name) => `${name}. Drag onto anything to point this agent.`,
  markAria: (name, doing) => `${name}, ${doing}`,
  moreAria: (count) => `${count} more ${count === 1 ? "agent" : "agents"}`,
  pinned: (label, seen) => `Pinned to ${label}, ${seen ? "read" : "not read yet"}`,
  notPinned: "Not pinned",
  offPage: "Its pin is on another page",
  close: "Close",
};

/** What `<apc-direct-agents>` says, and the prompt it hands the person to paste to their agent. */
export interface DirectStrings {
  /** The agent name field: `aria-label` and placeholder. */
  nameLabel: string;
  namePlaceholder: string;
  save: string;
  cancel: string;
  rename: string;
  hideConnection: string;
  showConnection: string;
  /** Above the URL, and above the prompt. */
  urlHint: string;
  askHint: string;
  /** The copy buttons, and what the first says for a moment after it copied. */
  copy: string;
  copyPrompt: string;
  copied: string;
  /** The add button once there is an agent, and before. */
  addAnother: string;
  connectAgent: string;
  /** The app's name in the prompt until `appName` is set. */
  thisApp: string;
  /** One agent's status line. */
  status(agent: { connected: boolean; client?: string | null; linked?: boolean }): string;
  /** What the person pastes to their own agent to connect it. */
  prompt(url: string, appName: string): string;
}

export const DEFAULT_DIRECT_STRINGS: DirectStrings = {
  nameLabel: "Agent name",
  namePlaceholder: "Empty: back to its own name",
  save: "Save",
  cancel: "Cancel",
  rename: "Rename",
  hideConnection: "Hide connection",
  showConnection: "Show connection",
  urlHint: "Add this URL to your agent as a remote MCP server (Streamable HTTP). No login: the secret in the URL is its access, so give each agent its own.",
  askHint: "Don't know how? Paste this to your agent:",
  copy: "Copy",
  copyPrompt: "Copy prompt",
  copied: "Copied",
  addAnother: "Add another agent",
  connectAgent: "Connect an agent",
  thisApp: "this app",
  status: (a) => {
    if (!a.connected) return "not connected yet";
    const as = a.client ? `connected as ${a.client}` : "connected";
    return a.linked ? `${as}, also through your dock` : as;
  },
  prompt: (url, appName) =>
    `Please connect this remote MCP server, named "${appName}". URL: ${url}. It uses Streamable HTTP and needs no OAuth or API key: the access is in the URL. If you can add it yourself, do it now and tell me when it's connected. If you can't, tell me the exact steps to add it in the app I'm using you in right now. Do not open the URL in a browser.`,
};

/** What `enablePinning` shows the person: the tap-to-pin note and the answers to a dock agent's drop. */
export interface PinningStrings {
  /** The note while an agent is armed, with the agent's name (from its mark). */
  tapPrompt(name: string): string;
  /** The agent's name when its mark has none. */
  yourAgent: string;
  /** The note's Cancel button. */
  cancel: string;
  /** Armed from the keyboard. */
  keyboardArmed: string;
  /** The armed agent may not point there: by tap, and by keyboard. */
  refusedTap: string;
  refusedKeys: string;
  /** A native drop the app cannot place: the agent may not point there, or is not known. */
  refused: string;
  unknownAgent: string;
  /** The app's name in those answers until `direct.name` says it. */
  thisApp: string;
  /** The page note for a dock agent dropped on a Direct-only app: the link to the app's connect page, and its × (`aria-label`). */
  connectLink(appName: string): string;
  close: string;
  /** A dock agent dropped on a Direct-only app, and when the page could not check whether it is one. Default: the protocol's notes. */
  directOnlyNote(appName: string): string;
  couldNotCheckNote(appName: string): string;
}

export const DEFAULT_PINNING_STRINGS: PinningStrings = {
  tapPrompt: (name) => `Tap what to point ${name} at.`,
  yourAgent: "your agent",
  cancel: "Cancel",
  keyboardArmed: "Pointing your agent: Tab to an outlined item, then press Enter or Space to pin it. Escape cancels.",
  refusedTap: "This agent cannot point at that. Tap another outlined target, or Cancel.",
  refusedKeys: "This agent cannot point at that. Tab to another outlined item, or press Escape.",
  refused: "This agent cannot point at that. Drop it on another highlighted item.",
  unknownAgent: "This app does not know that agent.",
  thisApp: "This app",
  connectLink: (appName) => `Connect an agent to ${appName}`,
  close: "Close",
  directOnlyNote,
  couldNotCheckNote,
};

/** The defaults with the app's overrides on top. A key set to `undefined` keeps its default. */
export function resolveStrings<T extends object>(defaults: T, given?: Partial<T> | null): T {
  const out = { ...defaults };
  if (given) for (const key of Object.keys(given) as Array<keyof T>) if (given[key] !== undefined) out[key] = given[key] as T[keyof T];
  return out;
}

/**
 * The locale a page's dates and times are shown in: the one the app names, else the page's own
 * (`<html lang>`), else English. Never the operating system's: a Spanish page on an English machine
 * reads Spanish dates.
 */
export function pageLocale(explicit?: string | null): string {
  const lang = explicit || (typeof document === "undefined" ? "" : document.documentElement?.lang);
  const tag = (lang ?? "").trim();
  if (!tag) return "en";
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? "en";
  } catch {
    return "en";
  }
}

/** A time or date for the person, in the page's locale (see `pageLocale`). For an app's own labels, such as a pin's "read 12:04". */
export function formatPageTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions & { locale?: string | null }): string {
  const { locale, ...given } = options ?? {};
  // No format option at all: a date and a time, in the medium and short styles.
  const format: Intl.DateTimeFormatOptions = Object.keys(given).length ? given : { dateStyle: "medium", timeStyle: "short" };
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(pageLocale(locale), format).format(date);
}
