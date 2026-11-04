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
  /**
   * What the outline covered at the drop (TIN-619): the block of text, a form's card or the whole form
   * the extension outlined, or null when the drop was on none. A sensitive number in its words is
   * NUMBER_LEFT_OUT, unless the person chose to send it (`sensitive: "included"`).
   */
  element: { tag: string; role: string | null; name: string | null; text: string; heading: string | null; column: string | null; row: string | null; sensitive?: "included" } | null;
  /** The person's selection, or SELECTION_LEFT_OUT when it holds what looks like a secret number (TIN-571). */
  selection: string | null;
  /** The person chose to send the sensitive numbers in the selection and its context (TIN-619). */
  selection_sensitive?: "included";
  /**
   * Where the selection is, when it is not in the pointed block (TIN-571): the nearest h1 to h3 above it
   * and the text of its block. Null when there is no selection, or it is inside the pointed block.
   */
  selection_context: { heading: string | null; text: string | null } | null;
  /** The form state at the drop point (TIN-571), taken once on the drop, or null when there is none. */
  form: FormReading | null;
}

/**
 * The form state inside the outline (TIN-571, TIN-619): every control the person can see there, with
 * its label: what was typed, the chosen radio, checkboxes, a select's option. A password or a one-time
 * code is CODE_LEFT_OUT, always. A sensitive value (a card, account or id number) is LEFT_OUT, or for a
 * choice counted in left_out, unless the person chose to send it (`sensitive: "included"`). Past the
 * caps, the rest are counted in more.
 */
export interface FormReading {
  fields: FormField[];
  left_out: number;
  more: number;
}

export interface FormField {
  label: string | null;
  value: string;
  /** A choice (radio, checkbox, select) or what was typed. */
  kind: "choice" | "typed";
  /** The control right under the pointer, when the drop was on one. */
  pointed: boolean;
  /** A sensitive value the person chose to send (TIN-619): the hub keeps it. */
  sensitive?: "included";
  /** A password or a code (TIN-619): its value is CODE_LEFT_OUT, and stays so however the field is marked. */
  credential?: true;
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

/** Said wherever the dock asks to allow a browser (13.5): what a reading carries (TIN-571, TIN-619) and where it goes. */
export const READER_NOTICE =
  "A reading is everything you can see inside the outline where you drop your agent, including what you typed there. Sensitive numbers (card, account, id) go only as you set in the APC extension; passwords and codes never. It passes through this dock's APC hub, on Cloudflare (kept 10 minutes at most), and then to your agent's provider.";

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

/** Said in place of a typed value that is held back as sensitive (TIN-571). */
export const LEFT_OUT = "(left out as sensitive)";
/** Said in place of a password or a one-time code, which never goes, whatever the person chose (TIN-619). */
export const CODE_LEFT_OUT = "(left out: password or code)";
/** Said in place of a sensitive number in visible text, when it is held back (TIN-617, TIN-619). */
export const NUMBER_LEFT_OUT = "[sensitive number left out]";
/** Said in place of a selection that holds what looks like a secret number (TIN-571). */
export const SELECTION_LEFT_OUT = "(selection left out as sensitive)";

/**
 * The filters a form's labels and values pass before they go into a reading (TIN-571, TIN-619), the same
 * in the extension and at the hub. Two kinds: a password or a one-time code (a card's security code
 * too) never goes, in any mode; a sensitive number (a card, an account, a national id) goes only when
 * the person chose so, in the extension's setting or with "Include them this time".
 */

/** autocomplete tokens of a password or a code: never in a reading. */
const CREDENTIAL_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|one-time-password|cc-csc)$/;
/** autocomplete tokens of a payment card's other fields: sensitive. */
const SECRET_AUTOCOMPLETE = /^cc-[a-z-]+$/;
/** Words that, alone, name a password or a code: a card's security code, a PIN, a one-time code. */
const CREDENTIAL_WORDS = new Set(["cvv", "cvv2", "cvc", "cvc2", "cvn", "csc", "cid", "ccv", "pin", "otp", "totp", "mfa", "2fa", "password", "passwd", "pass", "pwd", "passcode", "contrasena", "clave", "senha"]);
/** Words that, alone, name a sensitive number: an account, a national id. */
const SECRET_WORDS = new Set(["iban", "clabe", "account", "acct", "ssn", "tin", "rut", "run", "dni", "cuenta", "cpf", "nif", "nie", "curp", "cedula"]);
/** The same as CREDENTIAL_WORDS, written as several words (securityCode, one_time_code). */
const CREDENTIAL_PHRASES = /cardverification|securitycode|cardcode|password|passcode|onetimecode|onetimepassword|verificationcode|authcode|authenticationcode/;
/**
 * Words that name a secret in a field's name or id but are ordinary words in a label: "Envío sin costo"
 * (Spanish "without"), "Pan integral" (bread). In a label they count only written in capitals (SIN, PAN).
 */
const NAME_WORDS = new Set(["sin", "pan"]);
/** The same, written as several words (card number, cardNumber, card_number, número de tarjeta, Nro. de cuenta). */
const SECRET_PHRASES =
  /cardnumber|cardno|cardnum|ccnumber|ccnum|creditcard|debitcard|cardexp|expirydate|expirationdate|accountnumber|accountnum|accountno|acctnumber|acctnum|acctno|bankaccount|routingnumber|sortcode|socialsecurity|socialinsurance|nationalid|identitynumber|identificationnumber|taxid|passport|numerodetarjeta|tarjetadecredito|tarjetadedebito|numerodecuenta|nrodecuenta|ndecuenta|nodecuenta|numdecuenta|cuentacorriente|cuentavista|cuentarut|numerodocartao|cedulade/;

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
 * Whether a field's names say it holds a password, a code, or a sensitive number (any of them).
 * `kind` is "name" for what the page named the field in its markup (name, id), "label" for what the
 * person reads (label, placeholder, a group's legend), where SIN and PAN count only in capitals.
 */
export function namesSecret(kind: "name" | "label", ...texts: Array<string | null | undefined>): boolean {
  if (namesCredential(...texts)) return true;
  for (const text of texts) {
    if (!text) continue;
    const raw = wordsOf(text);
    const words = raw.map((w) => w.toLowerCase());
    if (words.some((w, i) => SECRET_WORDS.has(w) || (NAME_WORDS.has(w) && (kind === "name" || raw[i] === w.toUpperCase())))) return true;
    if (SECRET_PHRASES.test(words.join(""))) return true;
  }
  return false;
}

/** Whether a field's names say it holds a password or a code (a one-time code, a PIN, a card's security code): never sent. */
export function namesCredential(...texts: Array<string | null | undefined>): boolean {
  for (const text of texts) {
    if (!text) continue;
    const words = wordsOf(text).map((w) => w.toLowerCase());
    if (words.some((w) => CREDENTIAL_WORDS.has(w)) || CREDENTIAL_PHRASES.test(words.join(""))) return true;
  }
  return false;
}

const tokens = (value: string | null | undefined) => (value ? value.toLowerCase().split(/\s+/) : []);
/** Whether an autocomplete attribute marks a password, a one-time code or a payment card field. */
export function autocompleteSecret(value: string | null | undefined): boolean {
  return tokens(value).some((token) => CREDENTIAL_AUTOCOMPLETE.test(token) || SECRET_AUTOCOMPLETE.test(token));
}
/** Whether an autocomplete attribute marks a password or a one-time code (or a card's security code): never sent. */
export function autocompleteCredential(value: string | null | undefined): boolean {
  return tokens(value).some((token) => CREDENTIAL_AUTOCOMPLETE.test(token));
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

/**
 * Whether a field's value or label holds what looks like a secret number (secretForm first): once
 * everything but letters and digits is removed, a run of 8 or more digits (a card, an account, an id, a
 * phone number or a date written as digits); 12 or more digits in all, whatever separates them; a valid
 * IBAN of its country's length, in any case; or a RUT or RUN, with any dash. Strict on purpose: a field
 * holds one value. Visible text uses redactNumbers instead, which validates what it finds.
 */
export function textSecret(text: string | null | undefined): boolean {
  if (!text) return false;
  const norm = secretForm(text);
  const flat = norm.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  if (/\d{8}/.test(flat)) return true;
  if ((norm.match(/\d/g)?.length ?? 0) > DIGITS_MAX) return true;
  return holdsIban(flat) || holdsRut(norm);
}

/** Whether flattened text (letters and digits only, upper case) holds an IBAN of its country's length with valid check digits. */
function holdsIban(flat: string): boolean {
  for (const at of flat.matchAll(/[A-Z]{2}(?=\d{2})/g)) {
    const length = IBAN_LENGTHS[at[0]];
    const candidate = length ? flat.slice(at.index, at.index + length) : "";
    if (candidate.length === length && /^[A-Z0-9]+$/.test(candidate) && ibanValid(candidate)) return true;
  }
  return false;
}

/** Whether normalized text holds a RUT or RUN, or ends in one written loosely. */
function holdsRut(norm: string): boolean {
  if (RUT.test(norm)) return true;
  const body = RUT_LOOSE.exec(norm.trim())?.groups?.body;
  const bodyDigits = body?.match(/\d/g)?.length ?? 0;
  return bodyDigits >= 7 && bodyDigits <= 9;
}

/** Whether a run of digits passes the Luhn check, as every payment card number does. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The first digits of the card networks' numbers (Visa 4, Mastercard 51–55 and 2221–2720, Amex, Diners, JCB 3, Discover, UnionPay, Maestro 5 and 6): a year such as 2019 or 2020 is none. */
const CARD_START = /^(4|5|6|3|2(22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/;

/** A RUN or RUT's check character: modulo 11 of its body, weighted 2 to 7 from the right. */
function rutCheck(body: string): string {
  let sum = 0;
  let weight = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const rest = 11 - (sum % 11);
  return rest === 11 ? "0" : rest === 10 ? "K" : String(rest);
}

/** A RUN or RUT in visible text: 7 or 8 digits, in groups split by dots or spaces or none, a dash, its check character. Checked by rutCheck. */
const TEXT_RUT = /(?<![\dA-Za-z])(\d{1,2})[.\s]?(\d{3})[.\s]?(\d{3})\s*-\s*([\dkK])(?![\dA-Za-z])/g;
/** Between two groups of a number's digits: separators, or a few other characters (letters a page may put between them). */
const joinsGroups = (gap: string) => /^[\s,./-]*$/.test(gap) || gap.length <= 6 || (gap.length <= 16 && !/\s/.test(gap));

/**
 * Visible text as the checks read it, character by character: secretForm's folding for each character of
 * the text, and where each folded character came from, so a number found in it is cut out of the text
 * the person sees, and only that number.
 */
function folded(text: string): { norm: string; from: number[]; to: number[] } {
  let norm = "";
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    const ch = secretForm(String.fromCodePoint(cp));
    for (const c of ch) {
      norm += /^[a-z]$/.test(c) ? c.toUpperCase() : c;
      from.push(i);
      to.push(i + size);
    }
    i += size;
  }
  return { norm, from, to };
}

/**
 * Where visible text holds a sensitive number (TIN-617, TIN-619), as [start, end) of the text, each
 * found by what the number is, not by how many digits there are:
 * - a payment card: 13 to 19 digits, in groups joined by spaces, commas, dots, slashes, dashes or up to 6
 *   other characters (16 with no space between, as letters a page put inside a number), starting as the
 *   card networks' numbers do and passing the Luhn check;
 * - an IBAN with valid check digits, written in groups or with letters between its digits;
 * - a RUN or RUT with its dash and a valid check character.
 * A list of years, dates, scores and phone numbers pass none of these.
 */
function sensitiveSpans(text: string): Array<[number, number]> {
  const { norm, from, to } = folded(text);
  const spans: Array<[number, number]> = [];
  const add = (start: number, end: number) => spans.push([from[start]!, to[end - 1]!]);
  // Cards: runs of digit groups, and in each the groups that make a valid card number.
  const groups = [...norm.matchAll(/\d+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length, digits: m[0] }));
  for (let a = 0; a < groups.length; a++) {
    let digits = "";
    for (let b = a; b < groups.length; b++) {
      if (b > a && !joinsGroups(norm.slice(groups[b - 1]!.end, groups[b]!.start))) break;
      digits += groups[b]!.digits;
      if (digits.length > 19) break;
      if (digits.length >= 13 && CARD_START.test(digits) && luhnValid(digits)) {
        add(groups[a]!.start, groups[b]!.end);
        a = b;
        break;
      }
    }
  }
  // IBANs: from a country code and two digits, the country's length in letters and digits (spaces and dashes skipped),
  // or in digits only, skipping what joinsGroups lets through (a German IBAN with letters put between its digits).
  for (const m of norm.matchAll(/[A-Z]{2}(?=[\s-]?\d{2})/g)) {
    const length = IBAN_LENGTHS[m[0]];
    if (!length) continue;
    for (const lettersToo of [true, false]) {
      let iban = m[0];
      let at = m.index + 2;
      let last = at;
      let gap = "";
      for (; at < norm.length && iban.length < length; at++) {
        const c = norm[at]!;
        const keep = /\d/.test(c) || (lettersToo && iban.length >= 4 && /[A-Z]/.test(c));
        if (keep) {
          if (gap && !(lettersToo ? /^[\s-]{1,2}$/.test(gap) : joinsGroups(gap))) break;
          iban += c;
          last = at;
          gap = "";
        } else {
          gap += c;
          if (lettersToo && gap.length > 2) break;
          if (!lettersToo && gap.length > 16) break;
        }
      }
      if (iban.length === length && ibanValid(iban)) {
        add(m.index, last + 1);
        break;
      }
    }
  }
  for (const m of norm.matchAll(TEXT_RUT)) {
    if (rutCheck(`${m[1]}${m[2]}${m[3]}`) === m[4]!.toUpperCase()) add(m.index, m.index + m[0].length);
  }
  // One span for numbers that overlap.
  spans.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const prev = merged.at(-1);
    if (prev && s[0] <= prev[1]) prev[1] = Math.max(prev[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

/**
 * Visible text with each sensitive number in it replaced by NUMBER_LEFT_OUT (TIN-617, TIN-619), and how
 * many (sensitiveSpans). Only the number is replaced, never the rest of the text.
 */
export function redactNumbers(text: string): { text: string; count: number } {
  const spans = sensitiveSpans(text);
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    out += text.slice(at, start) + NUMBER_LEFT_OUT;
    at = end;
  }
  return { text: out + text.slice(at), count: spans.length };
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
  // Trimmed again after the cut, so shaping a shaped reading changes nothing.
  return text ? text.slice(0, max).trimEnd() : null;
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
  return shapeReadingCounted(raw)?.reading ?? null;
}

/**
 * The reading in its one accepted shape, and how many sensitive values it held back (TIN-619): those the
 * person did not choose to send, which "Include them this time" would add. A password or a code is never
 * counted, since it never goes. Null when it is not a reading.
 */
export function shapeReadingCounted(raw: unknown): { reading: PageReading; withheld: number } | null {
  if (!isObject(raw)) return null;
  const r = raw as { url?: unknown; title?: unknown; element?: unknown; selection?: unknown; selection_sensitive?: unknown; selection_context?: unknown; form?: unknown };
  const url = pageAddress(r.url);
  if (!url) return null;
  let withheld = 0;
  /** Visible text, capped, with its sensitive numbers left out unless the person chose to send them (keep). */
  const words = (value: unknown, max: number, keep: boolean): { text: string | null; found: number } => {
    if (typeof value !== "string") return { text: null, found: 0 };
    const cut = value.slice(0, max * 4 + 64);
    const redacted = redactNumbers(cut);
    if (!keep) withheld += redacted.count;
    return { text: clean(keep ? cut : redacted.text, max), found: redacted.count };
  };
  let element: PageReading["element"] = null;
  if (isObject(r.element)) {
    const e = r.element as { tag?: unknown; role?: unknown; name?: unknown; text?: unknown; heading?: unknown; column?: unknown; row?: unknown; sensitive?: unknown };
    const tag = typeof e.tag === "string" && /^[a-z][a-z0-9-]{0,19}$/i.test(e.tag) ? e.tag.toLowerCase() : null;
    const keep = e.sensitive === "included";
    const before = withheld;
    const [text, name, heading, column, row] = [words(e.text, TEXT_MAX, keep), words(e.name, NAME_MAX, keep), words(e.heading, NAME_MAX, keep), words(e.column, NAME_MAX, keep), words(e.row, NAME_MAX, keep)];
    if (tag && text.text) {
      const found = text.found + name.found + heading.found + column.found + row.found;
      element = { tag, role: clean(e.role, 40), name: name.text, text: text.text, heading: heading.text, column: column.text, row: row.text, ...(keep && found ? { sensitive: "included" as const } : {}) };
    } else {
      withheld = before;
    }
  }
  const keepSelection = r.selection_sensitive === "included";
  let selectionFound = 0;
  let selection: string | null = null;
  // The selection's sensitive numbers are left out as in the outline's text, the rest of it kept (TIN-619); a
  // selection that was nothing but such a number is not sent, nor where it is: only that there was one.
  let selectionHeld = false;
  const taken = words(r.selection, TEXT_MAX, keepSelection);
  if (taken.text) {
    selectionFound += taken.found;
    selectionHeld = !keepSelection && taken.found > 0 && !/[\p{L}\p{N}]/u.test(taken.text.replaceAll(NUMBER_LEFT_OUT, ""));
    selection = selectionHeld ? SELECTION_LEFT_OUT : taken.text;
  }
  let selectionContext: PageReading["selection_context"] = null;
  if (selection && !selectionHeld && isObject(r.selection_context)) {
    const c = r.selection_context as { heading?: unknown; text?: unknown };
    // A block the person did not drop on: its sensitive numbers left out, the rest of its words kept (TIN-617).
    const heading = words(c.heading, NAME_MAX, keepSelection);
    const text = words(c.text, CONTEXT_MAX, keepSelection);
    selectionFound += heading.found + text.found;
    if (heading.text || text.text) selectionContext = { heading: heading.text, text: text.text };
  }
  const form = shapeFormCounted(r.form);
  withheld += form.withheld;
  const reading: PageReading = { url, title: clean(r.title, NAME_MAX) ?? "", element, selection, ...(keepSelection && selectionFound ? { selection_sensitive: "included" as const } : {}), selection_context: selectionContext, form: form.form };
  return { reading, withheld: Math.min(withheld, 999) };
}

/**
 * A reading as the person chose to send it (TIN-619), before shapeReading: with include, every value the
 * extension found sensitive is marked `sensitive: "included"`, and so are the outlined text and the
 * selection, so the hub keeps them; without it, nothing is marked and the shared filters leave them out.
 * A password or a code is never marked: the content script never puts one in a reading.
 */
export function chooseSensitive(raw: unknown, include: boolean): unknown {
  if (!isObject(raw)) return raw;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  delete out.selection_sensitive;
  if (include) out.selection_sensitive = "included";
  if (isObject(r.element)) {
    const { sensitive: _, ...element } = r.element as Record<string, unknown>;
    out.element = include ? { ...element, sensitive: "included" } : element;
  }
  const form = r.form as { fields?: unknown } | undefined;
  if (isObject(form) && Array.isArray(form.fields)) {
    out.form = {
      ...form,
      fields: form.fields.map((f: unknown) => {
        if (!isObject(f)) return f;
        const { sensitive, ...field } = f as Record<string, unknown>;
        // A password or a code is never marked as the person's choice.
        if (field.credential === true) return field;
        return sensitive === true || sensitive === "included" ? { ...field, sensitive: include ? "included" : true } : field;
      }),
    };
  }
  return out;
}

const isObject = (value: unknown): value is object => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 999) : 0);

/** A field before the shared filters: a choice, or what was typed. */
export interface FieldCandidate {
  kind: "choice" | "typed";
  label: string | null;
  value: string;
  pointed: boolean;
  /**
   * true: the extension found it sensitive from what the hub cannot see (autocomplete, name, id), and
   * the person has not chosen to send it; "included": the person chose to send it (TIN-619).
   */
  sensitive?: true | "included";
  /** The extension found a password or a code from its markup (type, autocomplete, name, id): never sent. */
  credential?: boolean;
}

/**
 * The form a reading carries, from its candidate fields in order, through the filters that the
 * extension and the hub share (TIN-571, TIN-619): a password or a code is CODE_LEFT_OUT, always; a
 * sensitive value the person did not choose to send is LEFT_OUT, or for a choice counted in left_out
 * (a label that holds a secret number is dropped with it); one that they chose to send keeps its value
 * and says so. Then the caps, the rest counted in more. Null when there is nothing to say.
 */
export function shapeFields(candidates: readonly FieldCandidate[], leftOut = 0, more = 0): FormReading | null {
  return shapeFieldsCounted(candidates, leftOut, more).form;
}

function shapeFieldsCounted(candidates: readonly FieldCandidate[], leftOut = 0, more = 0): { form: FormReading | null; withheld: number } {
  const fields: FormField[] = [];
  let size = 0;
  let withheld = 0;
  let pointedTaken = false;
  for (const c of candidates) {
    const label = clean(c.label, FIELD_LABEL_MAX);
    const value = clean(c.value, FIELD_VALUE_MAX);
    if (!value) continue;
    // One control is under the pointer.
    const pointed = c.pointed && !pointedTaken;
    if (pointed) pointedTaken = true;
    const labelHolds = textSecret(label);
    const credential = c.credential === true || value === CODE_LEFT_OUT || namesCredential(label) || codeSecret(value, label);
    const sensitive = c.sensitive === true || labelHolds || namesSecret("label", label) || textSecret(value);
    let field: FormField;
    if (credential) {
      // A checkbox such as "Show password" says nothing worth a line.
      if (c.kind === "choice") {
        leftOut++;
        continue;
      }
      field = { label: labelHolds ? null : label, value: CODE_LEFT_OUT, kind: "typed", pointed, credential: true };
    } else if (sensitive && c.sensitive !== "included") {
      withheld++;
      if (c.kind === "choice") {
        leftOut++;
        continue;
      }
      field = { label: labelHolds ? null : label, value: LEFT_OUT, kind: "typed", pointed };
    } else {
      field = { label, value, kind: c.kind, pointed, ...(c.sensitive === "included" ? { sensitive: "included" as const } : {}) };
    }
    const length = (field.label?.length ?? 0) + field.value.length;
    if (fields.length >= FIELDS_MAX || size + length > FORM_TEXT_MAX) {
      more++;
      continue;
    }
    size += length;
    fields.push(field);
  }
  const form = fields.length || leftOut || more ? { fields, left_out: Math.min(leftOut, 999), more: Math.min(more, 999) } : null;
  return { form, withheld };
}

/** The form state in its one accepted shape (TIN-571), through the same filters and caps, whatever the extension sent. */
function shapeFormCounted(raw: unknown): { form: FormReading | null; withheld: number } {
  if (!isObject(raw)) return { form: null, withheld: 0 };
  const f = raw as { fields?: unknown; left_out?: unknown; more?: unknown };
  const candidates: FieldCandidate[] = [];
  const items = Array.isArray(f.fields) ? f.fields : [];
  for (const item of items.slice(0, FIELDS_SCANNED)) {
    if (!isObject(item)) continue;
    const field = item as { label?: unknown; value?: unknown; pointed?: unknown; kind?: unknown; sensitive?: unknown; credential?: unknown };
    if (typeof field.value !== "string") continue;
    const sensitive = field.sensitive === "included" ? "included" : field.sensitive === true ? true : undefined;
    // The extension's word that this is a password or a code holds whatever else the field says (an older extension sends none: its labels decide).
    const credential = field.credential === true;
    candidates.push({ kind: field.kind === "choice" ? "choice" : "typed", label: typeof field.label === "string" ? field.label : null, value: field.value, pointed: field.pointed === true, ...(sensitive ? { sensitive } : {}), ...(credential ? { credential } : {}) });
  }
  return shapeFieldsCounted(candidates, count(f.left_out), count(f.more) + Math.max(0, items.length - FIELDS_SCANNED));
}

/** The most fields the hub looks at in one reading; the rest are counted in more. */
const FIELDS_SCANNED = 200;

/** The form lines of page_text (TIN-571). */
function formLines(form: FormReading): string[] {
  const lines = form.fields.length ? ["Form fields, as filled in on the page:"] : [];
  for (const f of form.fields) lines.push(`- ${f.label ?? "(no label)"}: ${f.value}${f.pointed ? " (pointed at)" : ""}${f.sensitive === "included" ? " (sensitive: the person chose to send it)" : ""}`);
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
