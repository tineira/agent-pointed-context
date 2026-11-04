import assert from "node:assert/strict";
import { test } from "node:test";
import { agoLabel, autocompleteSecret, codeSecret, CONTEXT_MAX, FIELD_LABEL_MAX, FIELD_VALUE_MAX, FIELDS_MAX, FORM_TEXT_MAX, namesSecret, PAGE_TEXT_MAX, pageAddress, readerAllowed, readingEntry, readingSite, readingText, shapeReading, sizeLabel, textSecret } from "../src/worker/reading.ts";

const raw = {
  url: "https://en.wikipedia.org/wiki/Churn_rate?session=s3cr3t#History",
  title: "Churn rate - Wikipedia",
  element: { tag: "P", role: null, name: null, text: "Churn rate is   widely applied\nin SaaS.", heading: "Churn rate" },
  selection: "",
};

test("a reading keeps origin and path, never the query or fragment (TIN-421)", () => {
  assert.equal(pageAddress(raw.url), "https://en.wikipedia.org/wiki/Churn_rate");
  assert.equal(pageAddress("javascript:alert(1)"), null);
  assert.equal(pageAddress("file:///etc/passwd"), null);
  assert.equal(pageAddress(42), null);
  const r = shapeReading(raw)!;
  assert.equal(r.url, "https://en.wikipedia.org/wiki/Churn_rate");
  assert.ok(!JSON.stringify(r).includes("s3cr3t"));
  assert.equal(readingSite(r), "en.wikipedia.org");
});

test("a reading is taken only in its shape: text folded, tag checked, empty parts null", () => {
  const r = shapeReading(raw)!;
  assert.deepEqual(r.element, { tag: "p", role: null, name: null, text: "Churn rate is widely applied in SaaS.", heading: "Churn rate", column: null, row: null });
  assert.equal(r.selection, null);
  assert.equal(shapeReading(null), null);
  assert.equal(shapeReading([]), null);
  assert.equal(shapeReading({ title: "no url" }), null);
  assert.equal(shapeReading({ ...raw, element: { tag: "<script>", text: "x" } })!.element, null);
  assert.equal(shapeReading({ ...raw, element: { tag: "p", text: "   " } })!.element, null);
  assert.equal("extra" in shapeReading({ ...raw, extra: 1 })!, false);
});

test("the caps hold, whatever the extension sent", () => {
  const big = "word ".repeat(5000);
  const r = shapeReading({ ...raw, title: big, element: { tag: "p", text: big, name: big, heading: big, role: big }, selection: big })!;
  assert.ok(r.title.length <= 200);
  assert.ok(r.element!.text.length <= 2048);
  assert.ok(r.element!.name!.length <= 200 && r.element!.heading!.length <= 200 && r.element!.role!.length <= 40);
  assert.ok(r.selection!.length <= 2048);
  assert.ok(readingText(r).length <= PAGE_TEXT_MAX);
});

test("page_text says what the person pointed at, or that it was the page", () => {
  const text = readingText(shapeReading({ ...raw, selection: "widely applied" })!);
  assert.match(text, /^Page: Churn rate - Wikipedia\nAddress: https:\/\/en\.wikipedia\.org\/wiki\/Churn_rate\nUnder the heading: Churn rate\nPointed at \(p\): Churn rate is widely applied in SaaS\.\nSelected: widely applied$/);
  assert.match(readingText(shapeReading({ url: raw.url, title: "" })!), /Page: \(no title\)[\s\S]*Pointed at: the page, not a block of text on it\./);
});

test("a table cell comes with its column and row (TIN-422)", () => {
  const r = shapeReading({ ...raw, element: { tag: "td", text: "19.6", heading: "Countries", column: "Population", row: "Chile" } })!;
  assert.match(readingText(r), /Under the heading: Countries\nTable column: Population\nTable row: Chile\nPointed at \(td\): 19\.6/);
  const big = shapeReading({ ...raw, element: { tag: "td", text: "x", column: "c".repeat(5000), row: "r".repeat(5000) } })!;
  assert.ok(big.element!.column!.length <= 200 && big.element!.row!.length <= 200);
});

test("the form state goes into page_text with its labels, after what was pointed at, and says what was left out (TIN-571)", () => {
  const form = {
    fields: [
      { label: "Notes", value: "Leave at the door", kind: "typed", pointed: true },
      { label: "Shipping", value: "Registered post", kind: "choice" },
      { label: null, value: "Chile", kind: "choice" },
    ],
    left_out: 2,
    more: 1,
  };
  const r = shapeReading({ ...raw, form })!;
  assert.deepEqual(r.form, {
    fields: [
      { label: "Notes", value: "Leave at the door", kind: "typed", pointed: true },
      { label: "Shipping", value: "Registered post", kind: "choice", pointed: false },
      { label: null, value: "Chile", kind: "choice", pointed: false },
    ],
    left_out: 2,
    more: 1,
  });
  assert.match(
    readingText(r),
    /Pointed at \(p\): Churn rate is widely applied in SaaS\.\nForm fields, as filled in on the page:\n- Notes: Leave at the door \(pointed at\)\n- Shipping: Registered post\n- \(no label\): Chile\n1 field more not included\.\n2 fields left out as sensitive\.$/,
  );
  // A drop on a field: no block of text, but the field.
  assert.match(readingText(shapeReading({ url: raw.url, title: "Checkout", form })!), /Pointed at: a form field, marked \(pointed at\) below\./);
  // Only what was left out: still said.
  assert.match(readingText(shapeReading({ ...raw, form: { fields: [], left_out: 1 } })!), /\n1 field left out as sensitive\.$/);
  // The field dropped on, held back.
  assert.match(readingText(shapeReading({ ...raw, form: { fields: [{ label: "RUN", value: "12.345.678-5", kind: "typed", pointed: true }] } })!), /\n- RUN: \(left out as sensitive\) \(pointed at\)$/);
  assert.equal(shapeReading({ ...raw, form: { fields: [] } })!.form, null);
  assert.equal(shapeReading({ ...raw, form: "nope" })!.form, null);
  assert.equal(shapeReading(raw)!.form, null);
});

test("the hub holds the form to its caps and holds back secrets whatever the extension sent", () => {
  const fields = [
    { label: "Card number", value: "Visa", kind: "choice" },
    { label: "Reference", value: "4242.4242.4242.4242", kind: "choice" },
    { label: "Bank", value: "gb82 west 1234 5698 7654 32", kind: "choice" },
    { label: "Ingresa tu RUN", value: "Chile", kind: "choice" },
    { label: "Nro. de cuenta", value: "Corriente", kind: "choice" },
    { label: "Saved card 4111111111111111", value: "checked", kind: "choice" },
    ...Array.from({ length: 40 }, (_, i) => ({ label: `Field ${i}`, value: "v".repeat(500), kind: "choice" })),
    { label: 5, value: { x: 1 } },
  ];
  const r = shapeReading({ ...raw, form: { fields, left_out: -3, more: "many" } })!;
  assert.equal(r.form!.left_out, 6);
  assert.ok(r.form!.fields.length <= FIELDS_MAX);
  assert.ok(r.form!.fields.every((f) => f.value.length <= FIELD_VALUE_MAX && (f.label?.length ?? 0) <= FIELD_LABEL_MAX));
  assert.ok(r.form!.fields.reduce((n, f) => n + (f.label?.length ?? 0) + f.value.length, 0) <= FORM_TEXT_MAX);
  assert.equal(r.form!.fields.length + r.form!.more, 40);
  assert.doesNotMatch(JSON.stringify(r), /4111|4242|gb82|RUN|cuenta/i);
  assert.ok(readingText(r).length <= PAGE_TEXT_MAX);
});

test("a selection elsewhere on the page comes with its heading and block, unless that block holds a secret number (TIN-571)", () => {
  const r = shapeReading({ ...raw, selection: "4.2% in March", selection_context: { heading: "EU-West", text: "Churn in EU-West rose 4.2% in March." } })!;
  assert.match(readingText(r), /\nSelected: 4\.2% in March\nThe selection is under the heading: EU-West\nThe selection is in: Churn in EU-West rose 4\.2% in March\.$/);
  // No selection, no context; and an empty one is none.
  assert.equal(shapeReading({ ...raw, selection_context: { heading: "EU-West", text: "x" } })!.selection_context, null);
  assert.equal(shapeReading({ ...raw, selection: "x", selection_context: { heading: " ", text: "" } })!.selection_context, null);
  assert.ok(shapeReading({ ...raw, selection: "x", selection_context: { text: "w".repeat(5000) } })!.selection_context!.text!.length <= CONTEXT_MAX);
  // A block the person did not drop on that holds a card number or an IBAN is not sent (the review's P3).
  const held = shapeReading({ ...raw, selection: "Pay to", selection_context: { heading: "Payment", text: "Pay to de89 3704 0044 0532 0130 00 today" } })!;
  assert.deepEqual(held.selection_context, { heading: "Payment", text: null });
  assert.doesNotMatch(readingText(held), /de89/);
});

test("secret numbers are found in any case and with any separators, and ordinary text is not taken for one", () => {
  for (const text of [
    "4111 1111 1111 1111", "4111.1111.1111.1111", "4111/1111/1111/1111", "Visa 4111111111111111", "Saved card 5555-5555-5555-4444",
    "de89 3704 0044 0532 0130 00", "DE89370400440532013000", "GB82 WEST 1234 5698 7654 32", "nl91abna0417164300",
    "12.345.678-5", "12345678-5", "1.234.567-K", "1234567k", "123456789012", "+56 9 1234 5678", "2026-11-04",
  ]) assert.equal(textSecret(text), true, text);
  for (const text of ["Registered post", "DHL Express (3-5 days)", "Total: $1,234.56", "Order 1234", "Size XL 42", "AB12 costs 4 dollars more than the old one", "Chile", "Leave at the door", null, ""]) assert.equal(textSecret(text), false, String(text));
});

test("the second review's bypasses are held back: any dash, zero-width characters, digits of any script, fullwidth IBANs, letters between digits (TIN-571)", () => {
  for (const [why, text] of [
    ["RUN with an en dash", "1.234.567–K"],
    ["RUN with a minus sign", "1.234.567−K"],
    ["RUN with a non-breaking hyphen", "1.234.567‑K"],
    ["RUN with a zero-width space before K", "1.234.567-​K"],
    ["RUN with a figure dash", "12.345.678‒5"],
    ["fullwidth PAN", "４１１１１１１１１１１１１１１１"],
    ["mathematical bold PAN", "𝟒𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏"],
    ["Arabic-Indic PAN", "٤١١١١١١١١١١١١١١١"],
    ["Devanagari account", "१२३४५६७८९"],
    ["fullwidth IBAN", "ｄｅ８９ ３７０４ ００４４ ０５３２ ０１３０ ００"],
    ["PAN split by letters", "4111a1111a1111a1111"],
    ["PAN split by zero-width spaces", "4111​1111​1111​1111"],
  ] as const) {
    assert.equal(textSecret(text), true, why);
    // The hub holds it back as the typed value of the field dropped on, under an ordinary label, and as a choice.
    const typed = shapeReading({ ...raw, form: { fields: [{ label: "Documento", value: text, kind: "typed", pointed: true }] } })!;
    assert.equal(typed.form!.fields[0]!.value, "(left out as sensitive)", why);
    assert.equal(shapeReading({ ...raw, form: { fields: [{ label: "Saved", value: text, kind: "choice" }] } })!.form!.left_out, 1, why);
  }
  // In a block of page text, 12 digits count within 24 characters, so an article with dates and figures still goes.
  assert.equal(textSecret("Card 4111 then a1111 b1111 c1111 at the end", true), true);
  assert.equal(textSecret("In 2025 sales rose 12% to 340 units; in 2026 they reached 512 units across 7 regions and 19 stores.", true), false);
  const held = shapeReading({ ...raw, selection: "Pay", selection_context: { heading: "Payment", text: "Pay to ｄｅ８９ ３７０４ ００４４ ０５３２ ０１３０ ００" } })!;
  assert.deepEqual(held.selection_context, { heading: "Payment", text: null });
});

test("a short number in a field named only Code or Código is held back; a postal, promo or country code is not", () => {
  for (const label of ["Code", "Código", "Enter the code we sent you", "codigo"]) assert.equal(codeSecret("123456", label), true, label);
  assert.equal(codeSecret("123", "Code"), true);
  for (const label of ["Postal code", "Código postal", "Zip code", "Promo code", "Country code", "Código de descuento", "Notes"]) assert.equal(codeSecret("8320000", label), false, label);
  assert.equal(codeSecret("SPRING25", "Code"), false, "not a number");
  assert.equal(shapeReading({ ...raw, form: { fields: [{ label: "Code", value: "123456", kind: "typed", pointed: true }] } })!.form!.fields[0]!.value, "(left out as sensitive)");
  assert.equal(shapeReading({ ...raw, form: { fields: [{ label: "Código postal", value: "8320000", kind: "typed", pointed: true }] } })!.form!.fields[0]!.value, "8320000");
});

test("secrets are named by markup or label, in English, Spanish and Portuguese, not by a word inside an ordinary one", () => {
  for (const name of ["cardNumber", "card_number", "card_num", "cc-num", "CVV", "cvc2", "cid", "ccv", "security code", "IBAN", "clabe", "accountNo", "account", "acct", "account_num", "routing number", "SSN", "national id", "tax_id", "passport", "RUT", "RUN", "Ingresa tu RUN", "DNI", "NIF", "CURP", "Cédula de identidad", "Número de tarjeta", "Nro. de cuenta", "N° de cuenta", "Contraseña", "PIN", "pass", "pwd", "totp", "mfa_code", "2fa", "otp"]) {
    assert.equal(namesSecret("label", name), true, name);
  }
  // SIN and PAN name a secret in markup, and in a label only in capitals: "sin" is Spanish for "without", "pan" for bread.
  for (const name of ["sin", "pan", "panNumber", "SIN", "PAN"]) assert.equal(namesSecret("name", name), true, name);
  for (const label of ["Social Insurance Number (SIN)", "PAN"]) assert.equal(namesSecret("label", label), true, label);
  for (const label of ["Envío sin costo", "Pan integral", "Shipping", "Business name", "Spin", "Tinted", "Card message", "Notes", "Passenger", "Compass", "Runner", null, ""]) assert.equal(namesSecret("label", label), false, String(label));
  for (const ac of ["cc-number", "cc-csc", "shipping cc-exp", "current-password", "new-password", "one-time-code", "one-time-password"]) assert.equal(autocompleteSecret(ac), true, ac);
  for (const ac of ["email", "shipping street-address", "off", null]) assert.equal(autocompleteSecret(ac), false, String(ac));
});

test("the log's entry is the site, the time and the size, never a word of the reading (TIN-422)", () => {
  const r = shapeReading({ ...raw, selection: "widely applied" })!;
  const entry = readingEntry(r, "2026-11-01T12:00:00.000Z");
  assert.deepEqual(Object.keys(entry).sort(), ["at", "bytes", "site"]);
  assert.equal(entry.site, "en.wikipedia.org");
  assert.equal(entry.bytes, new TextEncoder().encode(readingText(r)).length);
  assert.doesNotMatch(JSON.stringify(entry), /Churn|widely|\/wiki/i);
});

test("the list shows size and time in human units", () => {
  assert.equal(sizeLabel(512), "512 B");
  assert.equal(sizeLabel(1536), "1.5 KB");
  const now = Date.parse("2026-11-01T12:00:00.000Z");
  const ago = (ms: number) => agoLabel(new Date(now - ms).toISOString(), now);
  assert.equal(ago(20_000), "just now");
  assert.equal(ago(120_000), "2 min ago");
  assert.equal(ago(3 * 3_600_000), "3 h ago");
  assert.equal(ago(49 * 3_600_000), "2 d ago");
});

test("readers come only from an allowed extension origin; under dev, any unpacked one (13.5)", () => {
  const id = "chrome-extension://" + "a".repeat(32);
  assert.equal(readerAllowed(id, [id], false), true);
  assert.equal(readerAllowed("chrome-extension://" + "b".repeat(32), [id], false), false);
  assert.equal(readerAllowed("chrome-extension://" + "b".repeat(32), [id], true), true);
  assert.equal(readerAllowed("https://evil.example", [id], true), false);
  assert.equal(readerAllowed(null, [id], true), false);
  assert.equal(readerAllowed("chrome-extension://" + "z".repeat(32), [], true), false);
});
