import assert from "node:assert/strict";
import { test } from "node:test";
import { agoLabel, autocompleteSecret, CONTEXT_MAX, FIELD_LABEL_MAX, FIELD_VALUE_MAX, FIELDS_MAX, FORM_TEXT_MAX, namesSecret, PAGE_TEXT_MAX, pageAddress, readerAllowed, readingEntry, readingSite, readingText, shapeReading, sizeLabel, valueSecret } from "../src/worker/reading.ts";

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
  const form = { fields: [{ label: "Shipping", value: "Registered post", pointed: true }, { label: "Insurance", value: "checked" }, { label: null, value: "Chile" }], left_out: 2, more: 1 };
  const r = shapeReading({ ...raw, form })!;
  assert.deepEqual(r.form, { fields: [{ label: "Shipping", value: "Registered post", pointed: true }, { label: "Insurance", value: "checked", pointed: false }, { label: null, value: "Chile", pointed: false }], left_out: 2, more: 1 });
  assert.match(
    readingText(r),
    /Pointed at \(p\): Churn rate is widely applied in SaaS\.\nForm fields, as filled in on the page:\n- Shipping: Registered post \(pointed at\)\n- Insurance: checked\n- \(no label\): Chile\n1 field more not included\.\n2 fields left out as sensitive\.$/,
  );
  // A drop on a field: no block of text, but the field.
  assert.match(readingText(shapeReading({ url: raw.url, title: "Checkout", form })!), /Pointed at: a form field, marked \(pointed at\) below\./);
  // Only what was left out: still said.
  assert.match(readingText(shapeReading({ ...raw, form: { fields: [], left_out: 1 } })!), /\n1 field left out as sensitive\.$/);
  assert.equal(shapeReading({ ...raw, form: { fields: [] } })!.form, null);
  assert.equal(shapeReading({ ...raw, form: "nope" })!.form, null);
  assert.equal(shapeReading(raw)!.form, null);
});

test("the hub holds the form to its caps and leaves out secrets whatever the extension sent", () => {
  const fields = [
    { label: "Card number", value: "4111 1111 1111 1111" },
    { label: "Reference", value: "4242424242424242" },
    { label: "Bank", value: "GB82WEST12345698765432" },
    { label: "CVC", value: "123" },
    ...Array.from({ length: 40 }, (_, i) => ({ label: `Field ${i}`, value: "v".repeat(500) })),
    { label: 5, value: { x: 1 } },
  ];
  const r = shapeReading({ ...raw, form: { fields, left_out: -3, more: "many" } })!;
  assert.equal(r.form!.left_out, 4);
  assert.ok(r.form!.fields.length <= FIELDS_MAX);
  assert.ok(r.form!.fields.every((f) => f.value.length <= FIELD_VALUE_MAX && (f.label?.length ?? 0) <= FIELD_LABEL_MAX));
  assert.ok(r.form!.fields.reduce((n, f) => n + (f.label?.length ?? 0) + f.value.length, 0) <= FORM_TEXT_MAX);
  assert.equal(r.form!.fields.length + r.form!.more, 40);
  assert.doesNotMatch(JSON.stringify(r), /4111|4242|GB82|123/);
  assert.ok(readingText(r).length <= PAGE_TEXT_MAX);
});

test("a selection elsewhere on the page comes with its heading and block; inside the pointed block it adds nothing (TIN-571)", () => {
  const r = shapeReading({ ...raw, selection: "4.2% in March", selection_context: { heading: "EU-West", text: "Churn in EU-West rose 4.2% in March." } })!;
  assert.match(readingText(r), /\nSelected: 4\.2% in March\nThe selection is under the heading: EU-West\nThe selection is in: Churn in EU-West rose 4\.2% in March\.$/);
  // No selection, no context; and an empty one is none.
  assert.equal(shapeReading({ ...raw, selection_context: { heading: "EU-West", text: "x" } })!.selection_context, null);
  assert.equal(shapeReading({ ...raw, selection: "x", selection_context: { heading: " ", text: "" } })!.selection_context, null);
  assert.ok(shapeReading({ ...raw, selection: "x", selection_context: { text: "w".repeat(5000) } })!.selection_context!.text!.length <= CONTEXT_MAX);
});

test("secrets are recognised by name, autocomplete and value, not by a word inside an ordinary one", () => {
  for (const name of ["cardNumber", "card_number", "cc-num", "CVV", "cvc2", "security code", "IBAN", "accountNo", "routing number", "SSN", "national id", "tax_id", "passport", "RUT", "DNI", "Número de tarjeta", "Contraseña", "PIN"]) assert.equal(namesSecret(name), true, name);
  for (const name of ["Shipping", "Business name", "Spin", "Tinted", "Account holder", "Card message", "Notes", null, ""]) assert.equal(namesSecret(name), false, String(name));
  for (const ac of ["cc-number", "cc-csc", "shipping cc-exp", "current-password", "new-password", "one-time-code"]) assert.equal(autocompleteSecret(ac), true, ac);
  for (const ac of ["email", "shipping street-address", "off", null]) assert.equal(autocompleteSecret(ac), false, String(ac));
  assert.equal(valueSecret("4111-1111-1111-1111"), true);
  assert.equal(valueSecret("4111 1111 1111 1112"), false, "fails Luhn");
  assert.equal(valueSecret("DE89 3704 0044 0532 0130 00"), true);
  assert.equal(valueSecret("Order 1234"), false);
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
