/**
 * A page reading (TIN-421, DESIGN.md 13.2): what the browser extension saw where the person dropped
 * their agent on a page without APC. It is untrusted data, not a pin, so the hub takes it only in
 * this shape and with these caps, whatever the extension sent. No Workers APIs here, so the tests and
 * the extension run it.
 */

export interface PageReading {
  /** The page's origin and path; never its query string or fragment, which often carry tokens. */
  url: string;
  title: string;
  /** The nearest block element at the drop point, or null when the drop was not on one. */
  element: { tag: string; role: string | null; name: string | null; text: string; heading: string | null } | null;
  selection: string | null;
}

/** How long the hub keeps a reading: until the next drop replaces it, or this old. */
export const READING_TTL_MS = 10 * 60_000;
/** The most page text the agent gets from one reading. */
export const PAGE_TEXT_MAX = 6 * 1024;

const TEXT_MAX = 2048;
const NAME_MAX = 200;

/** Whitespace folded and capped, or null when nothing is left. */
function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

/** An http(s) address cut to origin and path, or null. */
export function pageAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${u.pathname}`.slice(0, 1024);
  } catch {
    return null;
  }
}

/** The reading in its one accepted shape, or null when it is not a reading. */
export function shapeReading(raw: unknown): PageReading | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { url?: unknown; title?: unknown; element?: unknown; selection?: unknown };
  const url = pageAddress(r.url);
  if (!url) return null;
  let element: PageReading["element"] = null;
  if (r.element && typeof r.element === "object" && !Array.isArray(r.element)) {
    const e = r.element as { tag?: unknown; role?: unknown; name?: unknown; text?: unknown; heading?: unknown };
    const tag = typeof e.tag === "string" && /^[a-z][a-z0-9-]{0,19}$/i.test(e.tag) ? e.tag.toLowerCase() : null;
    const text = clean(e.text, TEXT_MAX);
    if (tag && text) element = { tag, role: clean(e.role, 40), name: clean(e.name, NAME_MAX), text, heading: clean(e.heading, NAME_MAX) };
  }
  return { url, title: clean(r.title, NAME_MAX) ?? "", element, selection: clean(r.selection, TEXT_MAX) };
}

/** The reading as the agent gets it in page_text: labelled lines, capped. */
export function readingText(r: PageReading): string {
  const lines = [`Page: ${r.title || "(no title)"}`, `Address: ${r.url}`];
  if (r.element) {
    if (r.element.heading) lines.push(`Under the heading: ${r.element.heading}`);
    lines.push(`Pointed at (${[r.element.tag, r.element.role].filter(Boolean).join(", ")}): ${r.element.text}`);
  } else {
    lines.push("Pointed at: the page, not a block of text on it.");
  }
  if (r.selection) lines.push(`Selected: ${r.selection}`);
  return lines.join("\n").slice(0, PAGE_TEXT_MAX);
}

/** The site a reading is from, as the dock and the focus show it: its host. */
export function readingSite(r: PageReading): string {
  return new URL(r.url).host;
}

/**
 * An extension's origin the hub takes readers and readings from (13.5): one of the published
 * extensions' ids, or under vite dev any unpacked one. A page cannot send this Origin.
 */
export function readerAllowed(origin: string | null, allowed: readonly string[], dev: boolean): boolean {
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
  return allowed.includes(origin) || dev;
}
