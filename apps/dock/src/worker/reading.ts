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
  /** The person's selection, or SELECTION_LEFT_OUT when it holds what looks like a secret number (TIN-571). */
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
 * The form state where the person dropped (TIN-571): the choices made in that part of the form (the
 * chosen radio, checkboxes, a select's option) and what was typed in the field dropped on, each with its
 * label. Never a typed value of another field. A choice that looks secret is counted in left_out; the
 * typed value of the field dropped on, when it looks secret, is LEFT_OUT. Past the caps, the rest are
 * counted in more.
 */
export interface FormReading {
  fields: FormField[];
  left_out: number;
  more: number;
}

export interface FormField {
  label: string | null;
  value: string;
  /** A choice (radio, checkbox, select) or what was typed (only ever in the field dropped on). */
  kind: "choice" | "typed";
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

/** Said wherever the dock asks to allow a browser (13.5): what a reading carries (TIN-571) and where it goes. */
export const READER_NOTICE =
  "A reading is the text you drop your agent on, with the choices made in that part of a form and what you typed in the field you drop it on (never a password or a card, account or id number). It passes through this dock, on Cloudflare, and is kept 10 minutes at most.";

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

/** Said in place of the typed value of the field the person dropped on, when it is held back (TIN-571). */
export const LEFT_OUT = "(left out as sensitive)";
/** Said in place of a selection that holds what looks like a secret number (TIN-571). */
export const SELECTION_LEFT_OUT = "(selection left out as sensitive)";

/**
 * The filters a form's labels and values pass before they go into a reading (TIN-571), the same in the
 * extension and at the hub. Choices (radios, checkboxes, a select's option) and the one typed value of
 * the field the person dropped on are all a reading carries of a form; each is held back when its
 * label, its value or the names the page gave the field look like a secret.
 */

/** autocomplete tokens of fields that never go into a reading. */
const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|one-time-password|cc-[a-z-]+)$/;
/** Words that, alone, name a secret or an identity field: a card's code, an account, a national id, a password, a one-time code. */
const SECRET_WORDS = new Set([
  "cvv", "cvv2", "cvc", "cvc2", "cvn", "csc", "cid", "ccv", "iban", "clabe", "account", "acct", "ssn", "pin", "otp", "totp", "mfa", "2fa", "tin", "rut", "run", "dni", "cuenta", "cpf", "nif", "nie", "curp", "cedula",
  "password", "passwd", "pass", "pwd", "passcode", "contrasena", "clave", "senha",
]);
/**
 * Words that name a secret in a field's name or id but are ordinary words in a label: "Envío sin costo"
 * (Spanish "without"), "Pan integral" (bread). In a label they count only written in capitals (SIN, PAN).
 */
const NAME_WORDS = new Set(["sin", "pan"]);
/** The same, written as several words (card number, cardNumber, card_number, número de tarjeta, Nro. de cuenta). */
const SECRET_PHRASES =
  /cardnumber|cardno|cardnum|ccnumber|ccnum|creditcard|debitcard|cardverification|securitycode|cardcode|cardexp|expirydate|expirationdate|accountnumber|accountnum|accountno|acctnumber|acctnum|acctno|bankaccount|routingnumber|sortcode|socialsecurity|socialinsurance|nationalid|identitynumber|identificationnumber|taxid|passport|password|passcode|onetimecode|onetimepassword|verificationcode|authcode|authenticationcode|numerodetarjeta|tarjetadecredito|tarjetadedebito|numerodecuenta|nrodecuenta|ndecuenta|nodecuenta|numdecuenta|cuentacorriente|cuentavista|cuentarut|numerodocartao|cedulade/;

const wordsOf = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

/**
 * Whether a field's names say it holds a secret or an identity number. `kind` is "name" for what the
 * page named the field in its markup (name, id), "label" for what the person reads (label, placeholder,
 * a group's legend), where SIN and PAN count only in capitals.
 */
export function namesSecret(kind: "name" | "label", ...texts: Array<string | null | undefined>): boolean {
  for (const text of texts) {
    if (!text) continue;
    const raw = wordsOf(text);
    const words = raw.map((w) => w.toLowerCase());
    if (words.some((w, i) => SECRET_WORDS.has(w) || (NAME_WORDS.has(w) && (kind === "name" || raw[i] === w.toUpperCase())))) return true;
    if (SECRET_PHRASES.test(words.join(""))) return true;
  }
  return false;
}

/** Whether an autocomplete attribute marks a password, a one-time code or a payment card field. */
export function autocompleteSecret(value: string | null | undefined): boolean {
  return !!value && value.toLowerCase().split(/\s+/).some((token) => SECRET_AUTOCOMPLETE.test(token));
}

/** Each country's IBAN length, so a run of letters and digits is checked as an IBAN only where one could be. */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18,
  FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25,
  MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19,
  SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/** Whether an IBAN's check digits hold (ISO 13616, mod 97). */
function ibanValid(iban: string): boolean {
  let rest = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const n = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/**
 * A Chilean RUT or RUN, its digit groups split by dots, spaces or nothing, and its check character after
 * an optional dash: 12.345.678-5, 1 234 567-K, 12345678K. On normalized text (secretForm).
 */
const RUT = /(?<![\dA-Za-z])\d{1,2}[\s.]*\d{3}[\s.]*\d{3}\s*-?\s*[\dkK](?![\dA-Za-z])/;
/** A value that ends in a check character after a dash, with 7 to 9 digits before it, whatever separates them (12.345x678-5). */
const RUT_LOOSE = /^(?<body>[^-]*)-\s*[\dkK]\s*$/;

/** Letters that look like K in other scripts (Greek Κ κ, Cyrillic К к), so a RUN's check character cannot hide as one. */
const LOOKS_LIKE_K = /[ΚκКк]/g;

/** Each Unicode decimal digit's value: they come in runs of ten, from 0 (Unicode keeps them so). */
const digitValues = new Map<string, string>();
function asciiDigit(d: string): string {
  let value = digitValues.get(d);
  if (value === undefined) {
    let back = 0;
    for (let cp = d.codePointAt(0)! - 1; /\p{Nd}/u.test(String.fromCodePoint(cp)); cp--) back++;
    value = String(back % 10);
    digitValues.set(d, value);
  }
  return value;
}

/**
 * Text as the secret checks read it: compatibility forms folded (fullwidth, mathematical letters and
 * digits, NFKC), every decimal digit of any script as 0 to 9 (Arabic-Indic included), format and
 * zero-width characters removed, every dash or minus as "-", and letters that look like K as K.
 */
export function secretForm(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(LOOKS_LIKE_K, "K")
    .replace(/[\p{Pd}−‑]/gu, "-")
    .replace(/\p{Nd}/gu, (d) => (d >= "0" && d <= "9" ? d : asciiDigit(d)));
}

/** At most this many digits in a value, whatever separates them: 12 is the shortest card number. */
const DIGITS_MAX = 11;
/** In a block of page text, the same, within any stretch this long: a card number split by letters. */
const DIGITS_SPAN = 24;

/**
 * Whether a text holds what looks like a secret number, whatever field it is in (secretForm first): once
 * everything but letters and digits is removed, a run of 8 or more digits (a card, an account, an id, a
 * phone number or a date written as digits); 12 or more digits in all, whatever separates them (in a
 * block of page text, `block`, within any 24 characters); a valid IBAN of its country's length, in any
 * case; or a RUT or RUN, with any dash.
 */
export function textSecret(text: string | null | undefined, block = false): boolean {
  if (!text) return false;
  const norm = secretForm(text);
  const flat = norm.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  if (/\d{8}/.test(flat)) return true;
  if (block) {
    const digits = [...norm].map((ch, i) => (ch >= "0" && ch <= "9" ? i : -1)).filter((i) => i >= 0);
    for (let k = DIGITS_MAX; k < digits.length; k++) if (digits[k]! - digits[k - DIGITS_MAX]! < DIGITS_SPAN) return true;
  } else if ((norm.match(/\d/g)?.length ?? 0) > DIGITS_MAX) {
    return true;
  }
  for (const at of flat.matchAll(/[A-Z]{2}(?=\d{2})/g)) {
    const length = IBAN_LENGTHS[at[0]];
    const candidate = length ? flat.slice(at.index, at.index + length) : "";
    if (candidate.length === length && /^[A-Z0-9]+$/.test(candidate) && ibanValid(candidate)) return true;
  }
  if (RUT.test(norm)) return true;
  const body = RUT_LOOSE.exec(norm.trim())?.groups?.body;
  const bodyDigits = body?.match(/\d/g)?.length ?? 0;
  return bodyDigits >= 7 && bodyDigits <= 9;
}

/**
 * "Code" or "código" alone, with a short number in it: a one-time code or a card's code. Not a postal,
 * zip, promo, discount, coupon, country, area, product, tracking or referral code.
 */
const CODE_WORDS = new Set(["code", "codigo", "cod"]);
const CODE_KINDS = new Set(["postal", "zip", "post", "promo", "promotional", "promocion", "promocional", "discount", "descuento", "coupon", "cupon", "voucher", "country", "pais", "area", "product", "producto", "tracking", "seguimiento", "referral", "referido", "invite", "invitation", "sku", "item", "color", "colour", "source", "html"]);
export function codeSecret(value: string, ...texts: Array<string | null | undefined>): boolean {
  if (!/^\d{3,8}$/.test(secretForm(value).replace(/[\s-]/g, ""))) return false;
  return texts.some((text) => {
    if (!text) return false;
    const words = wordsOf(text).map((w) => w.toLowerCase());
    return words.some((w) => CODE_WORDS.has(w)) && !words.some((w) => CODE_KINDS.has(w));
  });
}

/** Whitespace folded and capped, or null when nothing is left. */
function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Format and zero-width characters go: as spaces they would split a number the secret checks must see whole.
  const text = value.replace(/\p{Cf}/gu, "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
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
  const selected = clean(r.selection, TEXT_MAX);
  // A selection that holds what looks like a secret number is not sent, nor where it is: only that there was one.
  const selectionHeld = textSecret(selected, true);
  const selection = selectionHeld ? SELECTION_LEFT_OUT : selected;
  let selectionContext: PageReading["selection_context"] = null;
  if (selection && !selectionHeld && isObject(r.selection_context)) {
    const c = r.selection_context as { heading?: unknown; text?: unknown };
    // A block the person did not drop on: held back when it holds what looks like a secret number.
    const heading = clean(c.heading, NAME_MAX);
    const text = clean(c.text, CONTEXT_MAX);
    const safe = { heading: textSecret(heading, true) ? null : heading, text: textSecret(text, true) ? null : text };
    if (safe.heading || safe.text) selectionContext = safe;
  }
  return { url, title: clean(r.title, NAME_MAX) ?? "", element, selection, selection_context: selectionContext, form: shapeForm(r.form) };
}

const isObject = (value: unknown): value is object => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 999) : 0);

/** A field before the shared filters: a choice, or the typed value of the field dropped on. */
export interface FieldCandidate {
  kind: "choice" | "typed";
  label: string | null;
  value: string;
  pointed: boolean;
  /** What the extension alone can tell from the control's markup (type, autocomplete, name, id): it holds a secret. */
  secret?: boolean;
}

/**
 * The form a reading carries, from its candidate fields in order, through the filters that the
 * extension and the hub share (TIN-571): a typed value only for the field dropped on; a choice whose
 * label or value looks secret counted in left_out; the typed value of the field dropped on, when it or
 * its label looks secret, said as LEFT_OUT (and a label that holds a secret number dropped). Then the
 * caps, the rest counted in more. Null when there is nothing to say.
 */
export function shapeFields(candidates: readonly FieldCandidate[], leftOut = 0, more = 0): FormReading | null {
  const fields: FormField[] = [];
  let size = 0;
  let typed = false;
  for (const c of candidates) {
    // Never the typed value of a field the person did not drop on, and only one field is dropped on.
    if (c.kind === "typed" && (!c.pointed || typed)) continue;
    if (c.kind === "typed") typed = true;
    const label = clean(c.label, FIELD_LABEL_MAX);
    const value = clean(c.value, FIELD_VALUE_MAX);
    if (!value) continue;
    const labelHolds = textSecret(label);
    const secret = c.secret === true || labelHolds || namesSecret("label", label) || textSecret(value) || codeSecret(value, label);
    let field: FormField;
    if (c.kind === "choice") {
      if (secret) {
        leftOut++;
        continue;
      }
      field = { label, value, kind: "choice", pointed: c.pointed };
    } else {
      field = { label: labelHolds ? null : label, value: secret ? LEFT_OUT : value, kind: "typed", pointed: true };
    }
    const length = (field.label?.length ?? 0) + field.value.length;
    if (fields.length >= FIELDS_MAX || size + length > FORM_TEXT_MAX) {
      more++;
      continue;
    }
    size += length;
    fields.push(field);
  }
  return fields.length || leftOut || more ? { fields, left_out: Math.min(leftOut, 999), more: Math.min(more, 999) } : null;
}

/** The form state in its one accepted shape (TIN-571), through the same filters and caps, whatever the extension sent. */
function shapeForm(raw: unknown): FormReading | null {
  if (!isObject(raw)) return null;
  const f = raw as { fields?: unknown; left_out?: unknown; more?: unknown };
  const candidates: FieldCandidate[] = [];
  for (const item of Array.isArray(f.fields) ? f.fields.slice(0, 200) : []) {
    if (!isObject(item)) continue;
    const field = item as { label?: unknown; value?: unknown; pointed?: unknown; kind?: unknown };
    if (typeof field.value !== "string") continue;
    // Anything not said to be a choice is taken as typed, so it goes only for the field dropped on.
    candidates.push({ kind: field.kind === "choice" ? "choice" : "typed", label: typeof field.label === "string" ? field.label : null, value: field.value, pointed: field.pointed === true });
  }
  return shapeFields(candidates, count(f.left_out), count(f.more));
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
