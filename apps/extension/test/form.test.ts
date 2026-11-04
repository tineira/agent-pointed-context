import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIELD_VALUE_MAX, FIELDS_MAX, FORM_TEXT_MAX } from "../../dock/src/worker/reading.ts";
import { formState, secretControl, type Control } from "../src/read.ts";

const control = (over: Partial<Control>): Control => ({ kind: "text", type: "text", label: null, group: null, groupKey: null, name: null, id: null, autocomplete: null, placeholder: null, checked: false, value: "", pointed: false, ...over });
const radio = (label: string, checked: boolean, over: Partial<Control> = {}) => control({ kind: "radio", type: "radio", label, group: "Shipping", groupKey: "name:ship", name: "ship", checked, ...over });

test("a checkout's state: the chosen radio with its group, checkboxes either way, the chosen option and typed values, with their labels (TIN-571)", () => {
  const state = formState([
    radio("DHL Express", false),
    radio("Registered post", true),
    control({ kind: "checkbox", type: "checkbox", label: "Insurance", checked: true }),
    control({ kind: "checkbox", type: "checkbox", label: "Gift wrap", checked: false }),
    control({ kind: "select", type: "select", label: "Country", value: "Chile" }),
    control({ label: "Notes", value: "Leave at the door" }),
    control({ kind: "text", type: "textarea", label: "Message", value: "Thanks!" }),
    control({ label: "Coupon", value: "" }),
  ]);
  assert.deepEqual(state, {
    fields: [
      { label: "Shipping", value: "Registered post", pointed: false },
      { label: "Insurance", value: "checked", pointed: false },
      { label: "Gift wrap", value: "not checked", pointed: false },
      { label: "Country", value: "Chile", pointed: false },
      { label: "Notes", value: "Leave at the door", pointed: false },
      { label: "Message", value: "Thanks!", pointed: false },
    ],
    left_out: 0,
    more: 0,
  });
});

test("the pointed control comes first, and a pointed radio says when it is not the chosen one", () => {
  const state = formState([radio("Registered post", true), control({ label: "Notes", value: "x" }), radio("DHL Express", false, { pointed: true })])!;
  assert.deepEqual(state.fields[0], { label: "Shipping", value: "DHL Express (not selected)", pointed: true });
  assert.deepEqual(state.fields[1], { label: "Shipping", value: "Registered post", pointed: false });
  // One chosen radio per group, and a radio with no group's label is named by its group's name.
  const two = formState([radio("A", true, { group: null }), radio("B", true, { group: null })])!;
  assert.deepEqual(two.fields, [{ label: "ship", value: "A", pointed: false }]);
});

test("password, hidden, card, one-time-code and id fields are never read, and are counted", () => {
  const secret = "4111 1111 1111 1111";
  const controls = [
    control({ type: "password", label: "Password", value: "hunter2" }),
    control({ type: "password", label: "Empty password", value: "" }),
    control({ type: "hidden", name: "csrf", value: "HIDDENTOKEN" }),
    control({ label: "Name on card", autocomplete: "cc-name", value: "Ada Lovelace" }),
    control({ label: "Code", autocomplete: "one-time-code", value: "123456" }),
    control({ label: "New", autocomplete: "section-a new-password", value: "pw" }),
    control({ name: "cardNumber", label: "Number", value: secret }),
    control({ id: "card_cvc", label: "Code", value: "123" }),
    control({ label: "CVV", value: "123" }),
    control({ label: "IBAN", value: "DE89 3704 0044 0532 0130 00" }),
    control({ label: "Account number", value: "12345678" }),
    control({ label: "SSN", value: "078-05-1120" }),
    control({ label: "RUT", value: "12.345.678-5" }),
    control({ placeholder: "Número de tarjeta", value: "5555" }),
    control({ label: "Reference", value: "4242424242424242" }),
    control({ label: "Notes", value: "fine" }),
  ];
  const state = formState(controls)!;
  assert.deepEqual(state.fields, [{ label: "Notes", value: "fine", pointed: false }]);
  assert.equal(state.left_out, 14, "the hidden input is not a field the person sees, so it is not counted");
  for (const word of ["hunter2", "HIDDENTOKEN", "Ada", "123456", "4111", "DE89", "12345678", "078-05", "12.345", "5555", "4242"]) assert.ok(!JSON.stringify(state).includes(word), word);
  // A field named for an ordinary thing that only contains such a word is not taken for one.
  for (const label of ["Shipping", "Business name", "Spin speed", "Tinted glass", "Pinned", "Address line 1"]) assert.equal(secretControl(control({ label, value: "x" })), false, label);
});

test("the caps hold: per value, per field count and in total, and the rest are counted", () => {
  const long = formState([control({ label: "Notes", value: "word ".repeat(500) })])!;
  assert.ok(long.fields[0]!.value.length <= FIELD_VALUE_MAX);
  const many = formState(Array.from({ length: 50 }, (_, i) => control({ label: `Field ${i}`, value: "v" })))!;
  assert.equal(many.fields.length, FIELDS_MAX);
  assert.equal(many.more, 50 - FIELDS_MAX);
  const big = formState(Array.from({ length: 15 }, (_, i) => control({ label: `Field ${i}`, value: "y".repeat(FIELD_VALUE_MAX) })))!;
  const size = big.fields.reduce((n, f) => n + (f.label?.length ?? 0) + f.value.length, 0);
  assert.ok(size <= FORM_TEXT_MAX && big.more > 0);
  assert.equal(formState([]), null);
  assert.equal(formState([control({ label: "Empty", value: "  " })]), null);
});

test("nothing is read outside a drop: the content script reads the page only in readAt, from a drop or a moved pin", () => {
  const source = readFileSync(new URL("../src/content.ts", import.meta.url), "utf8");
  // No listener that would see a form being filled in (the only keydown is Esc while a pin is dragged).
  assert.doesNotMatch(source, /addEventListener\(\s*"(input|change|keyup|focusin|selectionchange)"/);
  // readAt runs on a drop (onPageDrop) and when a pin is moved; formAt and selectionContext only inside readAt.
  assert.equal(source.match(/readAt\(/g)?.length, 3, "its definition, the drop and the pin's move");
  assert.equal(source.match(/formAt\(/g)?.length, 2, "its definition and readAt");
  assert.equal(source.match(/selectionContext\(/g)?.length, 2, "its definition and readAt");
});
