import assert from "node:assert/strict";
import { test } from "node:test";
import { agoLabel, autocompleteCredential, autocompleteSecret, chooseSensitive, CODE_LEFT_OUT, codeSecret, CONTEXT_MAX, SELECTION_LEFT_OUT, FIELD_LABEL_MAX, FIELD_VALUE_MAX, FIELDS_MAX, FORM_TEXT_MAX, LEFT_OUT, namesCredential, namesSecret, NUMBER_LEFT_OUT, PAGE_TEXT_MAX, pageAddress, readerAllowed, readingEntry, readingSite, readingText, redactNumbers, shapeReading, shapeReadingCounted, sizeLabel, textSecret } from "../src/worker/reading.ts";

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
  // A card number or an IBAN in a block the person did not drop on is left out, and only it (the review's P3, TIN-617).
  const held = shapeReading({ ...raw, selection: "Pay to", selection_context: { heading: "Payment", text: "Pay to de89 3704 0044 0532 0130 00 today" } })!;
  assert.deepEqual(held.selection_context, { heading: "Payment", text: `Pay to ${NUMBER_LEFT_OUT} today` });
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
  // In visible text, a card number is found by what it is (redactNumbers), so an article with dates and figures still goes.
  assert.equal(redactNumbers("Card 4111 then 1111 b 1111 c-1111 at the end").count, 1);
  assert.equal(redactNumbers("In 2025 sales rose 12% to 340 units; in 2026 they reached 512 units across 7 regions and 19 stores.").count, 0);
  const held = shapeReading({ ...raw, selection: "Pay", selection_context: { heading: "Payment", text: "Pay to ｄｅ８９ ３７０４ ００４４ ０５３２ ０１３０ ００" } })!;
  assert.deepEqual(held.selection_context, { heading: "Payment", text: `Pay to ${NUMBER_LEFT_OUT}` });
});

test("the third review's RUN variants are held back: any separators, look-alike K, letters between the groups (TIN-571)", () => {
  for (const text of ["1 234 567-K", "1.234.567-Κ", "1.234.567-κ", "1.234.567-К", "1.234.567-к", "12.345x678-5", "12 345 678 5", "1.234.567 – K"]) {
    assert.equal(textSecret(text), true, text);
    assert.equal(shapeReading({ ...raw, form: { fields: [{ label: "Documento", value: text, kind: "typed", pointed: true }] } })!.form!.fields[0]!.value, "(left out as sensitive)", text);
  }
  for (const text of ["Ships in 3-5 days", "Size 42 - M", "Kit 7-K"]) assert.equal(textSecret(text), false, text);
});

test("a selection that holds a secret number is not sent, nor where it is: the reading says one was left out (TIN-571)", () => {
  const r = shapeReading({ ...raw, selection: "4111111111111111", selection_context: { heading: "Payment", text: "Card on file" } })!;
  assert.equal(r.selection, SELECTION_LEFT_OUT);
  assert.equal(r.selection_context, null);
  assert.match(readingText(r), /\nSelected: \(selection left out as sensitive\)$/);
  assert.doesNotMatch(JSON.stringify(r), /4111/);
  for (const selection of ["1.000.005-К", "de89 3704 0044 0532 0130 00", "4111, 1111, 1111, 1111."]) assert.equal(shapeReading({ ...raw, selection })!.selection, SELECTION_LEFT_OUT, selection);
  // A selection with more than the number keeps the rest, the number left out (TIN-619).
  const around = shapeReading({ ...raw, selection: "Pay 4111 1111 1111 1111 today", selection_context: { heading: "Billing", text: "Total due" } })!;
  assert.equal(around.selection, `Pay ${NUMBER_LEFT_OUT} today`);
  assert.deepEqual(around.selection_context, { heading: "Billing", text: "Total due" });
  // An ordinary selection with a few figures goes, and so do a date and a phone number's groups (Grok's P2).
  for (const selection of ["Churn rose 4.2% in March 2026", "2026-11-04", "1234 5678"]) assert.equal(shapeReading({ ...raw, selection })!.selection, selection);
});

test("a short number in a field named only Code or Código is held back; a postal, promo or country code is not", () => {
  for (const label of ["Code", "Código", "Enter the code we sent you", "codigo"]) assert.equal(codeSecret("123456", label), true, label);
  assert.equal(codeSecret("123", "Code"), true);
  for (const label of ["Postal code", "Código postal", "Zip code", "Promo code", "Country code", "Código de descuento", "Notes"]) assert.equal(codeSecret("8320000", label), false, label);
  assert.equal(codeSecret("SPRING25", "Code"), false, "not a number");
  assert.equal(shapeReading({ ...raw, form: { fields: [{ label: "Code", value: "123456", kind: "typed", pointed: true }] } })!.form!.fields[0]!.value, CODE_LEFT_OUT);
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

test("a password or a code is named apart from a sensitive number: it never goes, whatever the person chose (TIN-619)", () => {
  for (const name of ["Password", "Contraseña", "PIN", "pass", "pwd", "totp", "mfa_code", "2fa", "otp", "CVV", "cvc2", "Security code", "One-time code"]) assert.equal(namesCredential(name), true, name);
  for (const name of ["IBAN", "Card number", "Ingresa tu RUN", "Nro. de cuenta", "Email", "Passenger", "Compass"]) assert.equal(namesCredential(name), false, name);
  for (const ac of ["current-password", "new-password", "one-time-code", "one-time-password", "cc-csc"]) assert.equal(autocompleteCredential(ac), true, ac);
  for (const ac of ["cc-number", "cc-exp", "email", null]) assert.equal(autocompleteCredential(ac), false, String(ac));
});

test("a letter-spaced card number or IBAN in visible text is left out, and only that span (TIN-617)", () => {
  assert.deepEqual(redactNumbers("Pay 4111aaaaaaaa1111aaaaaaaa1111aaaaaaaa1111 today"), { text: `Pay ${NUMBER_LEFT_OUT} today`, count: 1 });
  assert.deepEqual(redactNumbers("Send to DE89aaaaaaaa3704aaaaaaaa0044aaaaaaaa0532aaaaaaaa0130aaaaaaaa00 please"), { text: `Send to ${NUMBER_LEFT_OUT} please`, count: 1 });
  // Grouped, with any dash, a RUN, an IBAN with letters.
  for (const [text, out] of [
    ["Card 4111 1111 1111 1111, exp 12/27", `Card ${NUMBER_LEFT_OUT}, exp 12/27`],
    ["Card 4111-1111-1111-1111 on file", `Card ${NUMBER_LEFT_OUT} on file`],
    ["Amex 3782 822463 10005 on file", `Amex ${NUMBER_LEFT_OUT} on file`],
    ["IBAN GB82 WEST 1234 5698 7654 32.", `IBAN ${NUMBER_LEFT_OUT}.`],
    ["IBAN de89 3704 0044 0532 0130 00 here", `IBAN ${NUMBER_LEFT_OUT} here`],
    ["RUN 12.345.678-5 del titular", `RUN ${NUMBER_LEFT_OUT} del titular`],
    ["RUT 1.000.005-K", `RUT ${NUMBER_LEFT_OUT}`],
    ["Card ４１１１ １１１１ １１１１ １１１１.", `Card ${NUMBER_LEFT_OUT}.`],
    ["Card ٤١١١١١١١١١١١١١١١ x", `Card ${NUMBER_LEFT_OUT} x`],
  ] as const) assert.equal(redactNumbers(text).text, out, text);
  // Ordinary prose with years and figures, dates, phone numbers and lists stays as it is.
  for (const text of [
    "In 2025 sales rose 12% to 340 units; in 2026 they reached 512 units across 7 regions and 19 stores.",
    "Between 2019 and 2024 revenue grew from 120 to 450 million.",
    "Years: 2019, 2020, 2021, 2022 and 2023.",
    "Call +56 9 1234 5678 before 2026-11-04.",
    "Total: $1,234,567.89 in Q3",
    "RUN 12.345.678-4 is not a valid one",
  ]) assert.deepEqual(redactNumbers(text), { text, count: 0 }, text);
});

test("Grok's review of the span rule: every card number it leaked is left out, every ordinary figure it swallowed stays (TIN-619)", () => {
  for (const text of ["4111, 1111, 1111, 1111", "4111 aa 1111 bb 1111 cc 1111", "Pay 4111 aaaa 1111 aaaa 1111 aaaa 1111 today", "4111 then 1111 then 1111 then 1111"]) {
    const out = redactNumbers(text);
    assert.equal(out.count, 1, text);
    assert.doesNotMatch(out.text, /4111|1111/, text);
  }
  // In a selection's block, too.
  const block = shapeReading({ ...raw, selection: "Pay", selection_context: { heading: "Billing", text: "Pay 4111, 1111, 1111, 1111 today" } })!;
  assert.equal(block.selection_context!.text, `Pay ${NUMBER_LEFT_OUT} today`);
  for (const text of ["Years: 2019 2020 2021 2022 were fine.", "from 2020-01-01 2020-12-31", "Scores were 12 34 56 78 90 12 today", "2026-11-04", "1234 5678"]) assert.deepEqual(redactNumbers(text), { text, count: 0 }, text);
});

test("a run of percentages or amounts is not a card number, whatever separates its figures; a card among them still is (TIN-762)", () => {
  // A whole-chart reading of an Instock-like bar chart (Datamind's "Instock promedio"), with and without spaces between the labels.
  for (const text of [
    "98,51% 96,23% 90,42% 87,67% 94,81%",
    "98,51%96,23%90,42%87,67%94,81%",
    "Instock promedio SMU 98,51% Tottus 96,23% Lider 90,42% Unimarc 87,67% Jumbo 94,81%",
    "98.51 % 96.23 % 90.42 % 87.67 % 94.81 %",
    "$293.460.353 $332.718.794",
    "$293.460.353$332.718.794",
    "Ventas $293.460.353 $332.718.794 $301.112.640",
    "1.234,56 € 7.890,12 € 4.111,11 €",
    // Figures of 4 or more digits marked as amounts or percentages: their digits would pass as a card (4125038900 52306 is Luhn-valid).
    "$41250 $38900 $52306",
    "41250% 38900% 52306%",
    "41250 € 38900 € 52306 €",
  ]) {
    assert.deepEqual(redactNumbers(text), { text, count: 0 }, text);
    const reading = shapeReadingCounted({ ...raw, element: { tag: "svg", text } })!;
    assert.equal(reading.reading.element!.text, text, text);
    assert.equal(reading.withheld, 0, text);
  }
  // A card number is still one: split by spaces, among percentages and amounts, and in each card network's layout.
  for (const [text, out] of [
    ["4111 1111 1111 1111", NUMBER_LEFT_OUT],
    ["98,51% 4111 1111 1111 1111 96,23%", `98,51% ${NUMBER_LEFT_OUT} 96,23%`],
    ["$293.460.353 card 4111-1111-1111-1111 $332.718.794", `$293.460.353 card ${NUMBER_LEFT_OUT} $332.718.794`],
    ["Total 87,67% paid with 4111111111111111.", `Total 87,67% paid with ${NUMBER_LEFT_OUT}.`],
    ["Amex 3782 822463 10005", `Amex ${NUMBER_LEFT_OUT}`],
    ["Card 4000 0000 0000 0001 103 on file", `Card ${NUMBER_LEFT_OUT} on file`],
    ["UnionPay 622202 1000000000009", `UnionPay ${NUMBER_LEFT_OUT}`],
    ["Card 6011 8587 6596 62 today", `Card ${NUMBER_LEFT_OUT} today`],
    // Written digit by digit (each digit in a box of its own), with or without a wider gap between the groups.
    ["Card 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 today", `Card ${NUMBER_LEFT_OUT} today`],
    ["Card 4 1 1 1  1 1 1 1  1 1 1 1  1 1 1 1", `Card ${NUMBER_LEFT_OUT}`],
    // A figure just before a card no longer starts the candidate, which then left the card's last digits out of the span.
    ["Paid 56,52% via 6011 aa 858765-9662 today", `Paid 56,52% via ${NUMBER_LEFT_OUT} today`],
    ["Paid 3,40% via 2720 aa 618243 then 37839 today", `Paid 3,40% via ${NUMBER_LEFT_OUT} today`],
  ] as const) assert.equal(redactNumbers(text).text, out, text);
  // A page's numbering is not one (the old rule took "2 3 … 13" for a card).
  assert.deepEqual(redactNumbers("1 2 3 4 5 6 7 8 9 10 11 12 13 14"), { text: "1 2 3 4 5 6 7 8 9 10 11 12 13 14", count: 0 });
});

test("what is left out is the union of every span that is a card, so no card's tail is left in the text (TIN-762, Grok's and Gemini's review)", () => {
  for (const [why, text, out] of [
    // A 19-digit card (4-4-4-4-3) whose first 16 digits also pass Luhn: the first match no longer ends the search.
    ["19 digits, UnionPay", "6222 0200 0000 0007 005", NUMBER_LEFT_OUT],
    ["19 digits, Visa", "Card 4000 0000 0000 0002 002 on file", `Card ${NUMBER_LEFT_OUT} on file`],
    // A figure of 4 or more digits before a card, whose digits pass with the card's first ones: the card's own span covers its tail,
    // and the figure is left out with it (the safe side).
    ["a 4-digit figure before a card", "3000 4111 1111 1111 1111", NUMBER_LEFT_OUT],
    ["a 5-digit figure before a card", "30140 4111 1111 1111 1111", NUMBER_LEFT_OUT],
    ["a figure before an Amex", "3009 3782 822463 10005", NUMBER_LEFT_OUT],
    ["a figure and a word before a card", "4008 ref 4111 1111 1111 1111", NUMBER_LEFT_OUT],
    ["an amount before a card", "Paid $4008 via 4111 1111 1111 1111", `Paid $${NUMBER_LEFT_OUT}`],
    // Digit by digit with wider gaps (what the extension reads from a box or a table cell per digit), and windows inside a longer run.
    ["two spaces", "Card 4  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1 end", `Card ${NUMBER_LEFT_OUT} end`],
    ["block boxes", " 4  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1 ", ` ${NUMBER_LEFT_OUT} `],
    ["spaced dashes", "Card 4 - 1 - 1 - 1 - 1 - 1 - 1 - 1 - 1 - 1 - 1 - 1 - 1 - 1 - 1 - 1 end", `Card ${NUMBER_LEFT_OUT} end`],
    ["a digit after", "Card 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 9 end", `Card ${NUMBER_LEFT_OUT} 9 end`],
    ["a digit before", "Card 1 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 end", `Card 1 ${NUMBER_LEFT_OUT} end`],
    ["20 digits", "Card 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 9 9 9 9 end", `Card ${NUMBER_LEFT_OUT} 9 9 9 9 end`],
  ] as const) assert.deepEqual(redactNumbers(text), { text: out, count: 1 }, why);
  // Words and units join groups as letters a page puts inside a number do ("4111 then 1111"); only a sign breaks a run.
  assert.equal(redactNumbers("41250 USD 38900 USD 52306 USD").count, 1);
  // Page numbering, percentages and amounts still go whole.
  for (const text of ["1 2 3 4 5 6 7 8 9 10 11 12 13 14", "Page 1 - 2 - 3 - 4 - 5 - 6 - 7 - 8 - 9 - 10", "98,51% 96,23% 90,42% 87,67% 94,81%", "$293.460.353 $332.718.794"]) assert.deepEqual(redactNumbers(text), { text, count: 0 }, text);
});

test("the hub leaves sensitive numbers out of the outlined text and the selection's block, unless the person chose to send them (TIN-617, TIN-619)", () => {
  const card = "Pay 4111aaaaaaaa1111aaaaaaaa1111aaaaaaaa1111 today";
  const page = { ...raw, element: { tag: "p", text: card, heading: "Billing" }, selection: "today", selection_context: { heading: "Other", text: "Wire to DE89 3704 0044 0532 0130 00." } };
  const left = shapeReadingCounted(page)!;
  assert.equal(left.reading.element!.text, `Pay ${NUMBER_LEFT_OUT} today`);
  assert.equal(left.reading.selection_context!.text, `Wire to ${NUMBER_LEFT_OUT}.`);
  assert.equal(left.withheld, 2);
  assert.doesNotMatch(readingText(left.reading), /4111|DE89/);
  // Marked by the extension as the person's choice: kept, and said to be so.
  const kept = shapeReadingCounted(chooseSensitive(page, true))!;
  assert.equal(kept.reading.element!.text, card);
  assert.equal(kept.reading.element!.sensitive, "included");
  assert.equal(kept.reading.selection_sensitive, "included");
  assert.equal(kept.reading.selection_context!.text, "Wire to DE89 3704 0044 0532 0130 00.");
  assert.equal(kept.withheld, 0);
  // The hub keeps what was marked, again, and a reading the extension marked is the same once the hub shapes it.
  assert.deepEqual(shapeReading(kept.reading), kept.reading);
  // A selection that is a card number: left out whole, or sent when the person included it.
  assert.equal(shapeReading({ ...raw, selection: "4111111111111111" })!.selection, SELECTION_LEFT_OUT);
  assert.equal(shapeReading({ ...raw, selection: "4111111111111111", selection_sensitive: "included" })!.selection, "4111111111111111");
});

test("the hub keeps a sensitive value the person chose to send, leaves out one not marked, and never takes a password or a code (TIN-619)", () => {
  const fields = [
    { label: "Card number", value: "4111 1111 1111 1111", kind: "typed", sensitive: "included" },
    { label: "Reference", value: "de89 3704 0044 0532 0130 00", kind: "typed" },
    { label: "Ingresa tu RUN", value: "12.345.678-5", kind: "typed", sensitive: true },
    { label: "Saved card 5555 5555 5555 4444", value: "checked", kind: "choice", sensitive: "included" },
    { label: "Saved card 4111 1111 1111 1111", value: "checked", kind: "choice" },
    { label: "Password", value: "hunter2", kind: "typed", sensitive: "included" },
    { label: "Code", value: "123456", kind: "typed", sensitive: "included" },
    { label: "CVV", value: "123", kind: "typed", sensitive: "included" },
    { label: "Notes", value: "Leave at the door", kind: "typed" },
    { label: "Address", value: "Av. Siempre Viva 742", kind: "typed" },
  ];
  const { reading, withheld } = shapeReadingCounted({ ...raw, form: { fields } })!;
  assert.deepEqual(reading.form, {
    fields: [
      { label: "Card number", value: "4111 1111 1111 1111", kind: "typed", pointed: false, sensitive: "included" },
      { label: "Reference", value: LEFT_OUT, kind: "typed", pointed: false },
      { label: "Ingresa tu RUN", value: LEFT_OUT, kind: "typed", pointed: false },
      { label: "Saved card 5555 5555 5555 4444", value: "checked", kind: "choice", pointed: false, sensitive: "included" },
      { label: "Password", value: CODE_LEFT_OUT, kind: "typed", pointed: false, credential: true },
      { label: "Code", value: CODE_LEFT_OUT, kind: "typed", pointed: false, credential: true },
      { label: "CVV", value: CODE_LEFT_OUT, kind: "typed", pointed: false, credential: true },
      { label: "Notes", value: "Leave at the door", kind: "typed", pointed: false },
      { label: "Address", value: "Av. Siempre Viva 742", kind: "typed", pointed: false },
    ],
    left_out: 1,
    more: 0,
  });
  assert.equal(withheld, 3);
  assert.doesNotMatch(JSON.stringify(reading), /hunter2|123456|de89|12\.345/);
  assert.match(readingText(reading), /- Card number: 4111 1111 1111 1111 \(sensitive: the person chose to send it\)\n/);
  assert.match(readingText(reading), /- Password: \(left out: password or code\)\n/);
  // The extension's word that a field is a password or a code holds at the hub, whatever its label says and however it is marked.
  const flagged = shapeReading({ ...raw, form: { fields: [{ label: "Notes", value: "hunter2", kind: "typed", sensitive: "included", credential: true }] } })!;
  assert.deepEqual(flagged.form!.fields, [{ label: "Notes", value: CODE_LEFT_OUT, kind: "typed", pointed: false, credential: true }]);
  // And chooseSensitive never marks such a field as chosen.
  const chosen = chooseSensitive({ ...raw, form: { fields: [{ label: "Notes", value: CODE_LEFT_OUT, kind: "typed", credential: true, sensitive: true }] } }, true) as { form: { fields: Array<Record<string, unknown>> } };
  assert.equal(chosen.form.fields[0]!.sensitive, undefined);
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
