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
  element: { tag: string; role: string | null; name: string | null; text: string; heading: string | null; column: string | null; row: string | null } | null;
  selection: string | null;
  /**
   * Where the selection is, when it is not in the pointed block (TIN-571): the nearest h1 to h3 above it
   * and the text of its block. Null when there is no selection, or it is inside the pointed block.
   */
  selection_context: { heading: string | null; text: string | null } | null;
  /** The form state at the drop point (TIN-571), taken once on the drop, or null when there is none. */
  form: FormReading | null;
}

/**
 * The form state of the pointed control and of the form, fieldset or group around it (TIN-571): each
 * field's label and what the person sees chosen or typed in it. Never a password, a hidden input, or a
 * field for a card, an account, a one-time code or a national id; those are counted in left_out. Past
 * the caps, the rest are counted in more.
 */
export interface FormReading {
  fields: FormField[];
  left_out: number;
  more: number;
}

export interface FormField {
  label: string | null;
  value: string;
  /** The control the person dropped on. */
  pointed: boolean;
}

/** What the hub's log keeps of a reading (TIN-422, 13.3): site, time and size, never its address or text. */
export interface ReadingEntry {
  at: string;
  site: string;
  bytes: number;
}

/** A log entry as the popup and the dock list it; kept while the reading itself is still at the hub. */
export interface ReadingRow extends ReadingEntry {
  kept: boolean;
}

/** Said wherever the dock asks to allow a browser (13.5). */
export const READER_NOTICE = "That text passes through this dock, on Cloudflare, and is kept 10 minutes at most.";

/** How long the hub keeps a reading: until the next drop replaces it, or this old. */
export const READING_TTL_MS = 10 * 60_000;
/** The most page text the agent gets from one reading. */
export const PAGE_TEXT_MAX = 6 * 1024;

const TEXT_MAX = 2048;
const NAME_MAX = 200;
/** The selection's block, when it is not the pointed one (TIN-571). */
export const CONTEXT_MAX = 500;
/** The most form fields a reading carries, and the caps on each and on all of them (TIN-571). */
export const FIELDS_MAX = 20;
export const FIELD_LABEL_MAX = 100;
export const FIELD_VALUE_MAX = 200;
export const FORM_TEXT_MAX = 1500;

/** autocomplete tokens of fields that never go into a reading (TIN-571). */
const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-[a-z-]+)$/;
/** Words that, alone, name a secret or an identity field: a card's code, an account, a national id, a password. */
const SECRET_WORDS = new Set(["cvv", "cvv2", "cvc", "cvc2", "cvn", "csc", "iban", "ssn", "pin", "otp", "tin", "rut", "dni", "cpf", "nif", "nie", "curp", "password", "passwd", "pwd", "passcode", "contrasena", "clave", "senha"]);
/** The same, written as several words (card number, cardNumber, card_number, número de tarjeta). */
const SECRET_PHRASES =
  /cardnumber|cardno|ccnumber|ccnum|creditcard|debitcard|cardverification|securitycode|cardcode|cardexp|expirydate|expirationdate|accountnumber|accountno|acctnumber|acctno|bankaccount|routingnumber|sortcode|socialsecurity|nationalid|identitynumber|identificationnumber|taxid|passport|password|passcode|onetimecode|verificationcode|numerodetarjeta|tarjetadecredito|tarjetadedebito|numerodecuenta|cuentacorriente|numerodocartao/;

/** Whether a field's name, id, label or placeholder says it holds a secret or an identity number (TIN-571). */
export function namesSecret(...texts: Array<string | null | undefined>): boolean {
  for (const text of texts) {
    if (!text) continue;
    const words = text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (words.some((w) => SECRET_WORDS.has(w)) || SECRET_PHRASES.test(words.join(""))) return true;
  }
  return false;
}

/** Whether an autocomplete attribute marks a password, a one-time code or a payment card field. */
export function autocompleteSecret(value: string | null | undefined): boolean {
  return !!value && value.toLowerCase().split(/\s+/).some((token) => SECRET_AUTOCOMPLETE.test(token));
}

/** Whether a value looks like a payment card number (13 to 19 digits that pass Luhn) or an IBAN, whatever its field says. */
export function valueSecret(value: string): boolean {
  const compact = value.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(compact)) {
    let sum = 0;
    for (let i = 0; i < compact.length; i++) {
      let d = Number(compact[compact.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact);
}

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
  const r = raw as { url?: unknown; title?: unknown; element?: unknown; selection?: unknown; selection_context?: unknown; form?: unknown };
  const url = pageAddress(r.url);
  if (!url) return null;
  let element: PageReading["element"] = null;
  if (isObject(r.element)) {
    const e = r.element as { tag?: unknown; role?: unknown; name?: unknown; text?: unknown; heading?: unknown; column?: unknown; row?: unknown };
    const tag = typeof e.tag === "string" && /^[a-z][a-z0-9-]{0,19}$/i.test(e.tag) ? e.tag.toLowerCase() : null;
    const text = clean(e.text, TEXT_MAX);
    if (tag && text) element = { tag, role: clean(e.role, 40), name: clean(e.name, NAME_MAX), text, heading: clean(e.heading, NAME_MAX), column: clean(e.column, NAME_MAX), row: clean(e.row, NAME_MAX) };
  }
  const selection = clean(r.selection, TEXT_MAX);
  let selectionContext: PageReading["selection_context"] = null;
  if (selection && isObject(r.selection_context)) {
    const c = r.selection_context as { heading?: unknown; text?: unknown };
    const heading = clean(c.heading, NAME_MAX);
    const text = clean(c.text, CONTEXT_MAX);
    if (heading || text) selectionContext = { heading, text };
  }
  return { url, title: clean(r.title, NAME_MAX) ?? "", element, selection, selection_context: selectionContext, form: shapeForm(r.form) };
}

const isObject = (value: unknown): value is object => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 999) : 0);

/**
 * The form state in its one accepted shape (TIN-571), with the caps, whatever the extension sent. A field
 * whose label names a secret, or whose value looks like a card number or an IBAN, is left out here too.
 */
function shapeForm(raw: unknown): FormReading | null {
  if (!isObject(raw)) return null;
  const f = raw as { fields?: unknown; left_out?: unknown; more?: unknown };
  const fields: FormField[] = [];
  let leftOut = count(f.left_out);
  let more = count(f.more);
  let size = 0;
  for (const item of Array.isArray(f.fields) ? f.fields.slice(0, 200) : []) {
    if (!isObject(item)) continue;
    const field = item as { label?: unknown; value?: unknown; pointed?: unknown };
    const label = clean(field.label, FIELD_LABEL_MAX);
    const value = clean(field.value, FIELD_VALUE_MAX);
    if (!value) continue;
    if (namesSecret(label) || valueSecret(value)) {
      leftOut++;
      continue;
    }
    const length = (label?.length ?? 0) + value.length;
    if (fields.length >= FIELDS_MAX || size + length > FORM_TEXT_MAX) {
      more++;
      continue;
    }
    size += length;
    fields.push({ label, value, pointed: field.pointed === true });
  }
  return fields.length || leftOut || more ? { fields, left_out: Math.min(leftOut, 999), more: Math.min(more, 999) } : null;
}

/** The form lines of page_text (TIN-571). */
function formLines(form: FormReading): string[] {
  const lines = form.fields.length ? ["Form fields, as filled in on the page:"] : [];
  for (const f of form.fields) lines.push(`- ${f.label ?? "(no label)"}: ${f.value}${f.pointed ? " (pointed at)" : ""}`);
  const plural = (n: number) => (n === 1 ? "1 field" : `${n} fields`);
  if (form.more) lines.push(`${plural(form.more)} more not included.`);
  if (form.left_out) lines.push(`${plural(form.left_out)} left out as sensitive.`);
  return lines;
}

/** The reading as the agent gets it in page_text: labelled lines, capped. */
export function readingText(r: PageReading): string {
  const lines = [`Page: ${r.title || "(no title)"}`, `Address: ${r.url}`];
  if (r.element) {
    if (r.element.heading) lines.push(`Under the heading: ${r.element.heading}`);
    if (r.element.column) lines.push(`Table column: ${r.element.column}`);
    if (r.element.row) lines.push(`Table row: ${r.element.row}`);
    lines.push(`Pointed at (${[r.element.tag, r.element.role].filter(Boolean).join(", ")}): ${r.element.text}`);
  } else if (r.form?.fields.some((f) => f.pointed)) {
    lines.push("Pointed at: a form field, marked (pointed at) below.");
  } else {
    lines.push("Pointed at: the page, not a block of text on it.");
  }
  // Readings stored before TIN-571 have neither.
  if (r.form) lines.push(...formLines(r.form));
  if (r.selection) {
    lines.push(`Selected: ${r.selection}`);
    if (r.selection_context?.heading) lines.push(`The selection is under the heading: ${r.selection_context.heading}`);
    if (r.selection_context?.text) lines.push(`The selection is in: ${r.selection_context.text}`);
  }
  return lines.join("\n").slice(0, PAGE_TEXT_MAX);
}

/** The site a reading is from, as the dock and the focus show it: its host. */
export function readingSite(r: PageReading): string {
  return new URL(r.url).host;
}

/** The one thing the hub logs of a reading. Size is what the agent gets, in bytes. */
export function readingEntry(r: PageReading, at: string): ReadingEntry {
  return { at, site: readingSite(r), bytes: new TextEncoder().encode(readingText(r)).length };
}

/** "1.2 KB": a reading's size as the popup and the dock show it. */
export const sizeLabel = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** "2 min ago": a reading's time as the popup and the dock show it. */
export function agoLabel(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/**
 * An extension's origin the hub takes readers and readings from (13.5): one of the published
 * extensions' ids, or under vite dev any unpacked one. A page cannot send this Origin.
 */
export function readerAllowed(origin: string | null, allowed: readonly string[], dev: boolean): boolean {
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
  return allowed.includes(origin) || dev;
}
