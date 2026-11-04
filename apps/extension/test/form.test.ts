import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIELD_VALUE_MAX, FIELDS_MAX, FORM_TEXT_MAX, LEFT_OUT, shapeReading } from "../../dock/src/worker/reading.ts";
import { controlVisible, countable, formState, pickScope, SCOPE_MAX, visuallyHidden, type Control, type Seen } from "../src/read.ts";

const shown: Seen = { checkVisible: true, opacity: 1, textAlpha: 1, width: 200, height: 24, left: 10, top: 10, right: 210, bottom: 34, pageWidth: 1200, pageHeight: 900, position: "static", clip: "auto", clipPath: "none", ariaHidden: false };

const control = (over: Partial<Control>): Control => ({ kind: "text", type: "text", label: null, group: null, groupKey: null, name: null, id: null, autocomplete: null, placeholder: null, checked: false, value: "", pointed: false, visible: true, ...over });
const radio = (label: string, checked: boolean, over: Partial<Control> = {}) => control({ kind: "radio", type: "radio", label, group: "Shipping method", groupKey: "name:ship", name: "ship", checked, ...over });
const checkbox = (label: string, checked: boolean, over: Partial<Control> = {}) => control({ kind: "checkbox", type: "checkbox", label, checked, ...over });
const typed = (label: string | null, value: string, over: Partial<Control> = {}) => control({ label, value, pointed: true, ...over });
/** What the reading says of the field dropped on, once the extension and then the hub have shaped it. */
const pointedValue = (c: Control) => {
  const form = formState([c]);
  const atHub = shapeReading({ url: "https://shop.example/checkout", title: "Checkout", form })?.form;
  assert.deepEqual(atHub, form, "the hub keeps what the extension kept");
  return form?.fields[0]?.value;
};
const page = { url: "https://shop.example/checkout", title: "Checkout" };

test("a checkout's choices come through with their labels: the chosen shipping option, boxes either way, the chosen option (TIN-571)", () => {
  const state = formState([
    radio("DHL Express", false),
    radio("Registered post", true),
    checkbox("Insurance", true),
    checkbox("Gift wrap", false),
    control({ kind: "select", type: "select", label: "Country", value: "Chile" }),
    radio("Standard", false, { pointed: true, group: "Speed", groupKey: "name:speed", name: "speed" }),
  ]);
  assert.deepEqual(state, {
    fields: [
      { label: "Speed", value: "Standard (not selected)", kind: "choice", pointed: true },
      { label: "Shipping method", value: "Registered post", kind: "choice", pointed: false },
      { label: "Insurance", value: "checked", kind: "choice", pointed: false },
      { label: "Gift wrap", value: "not checked", kind: "choice", pointed: false },
      { label: "Country", value: "Chile", kind: "choice", pointed: false },
    ],
    left_out: 0,
    more: 0,
  });
  // One chosen radio per group; a group with no label is named by the radios' name.
  assert.deepEqual(formState([radio("A", true, { group: null }), radio("B", true, { group: null })])!.fields, [{ label: "ship", value: "A", kind: "choice", pointed: false }]);
});

test("a typed value goes only for the field dropped on, never for any other field", () => {
  const state = formState([typed("Notes", "Leave at the door"), control({ label: "Address", value: "Av. Siempre Viva 742" }), checkbox("Insurance", true)])!;
  assert.deepEqual(state.fields, [
    { label: "Notes", value: "Leave at the door", kind: "typed", pointed: true },
    { label: "Insurance", value: "checked", kind: "choice", pointed: false },
  ]);
  assert.ok(!JSON.stringify(state).includes("Siempre"));
  // The hub drops a typed value not marked as the field dropped on, and any second one.
  const atHub = shapeReading({ ...page, form: { fields: [{ label: "Address", value: "Av. Siempre Viva 742", kind: "typed", pointed: false }, { label: "A", value: "one", kind: "typed", pointed: true }, { label: "B", value: "two", kind: "typed", pointed: true }, { label: "C", value: "no kind", pointed: true }] } })!;
  assert.deepEqual(atHub.form!.fields, [{ label: "A", value: "one", kind: "typed", pointed: true }]);
});

test("the review's examples are all held back (TIN-571)", () => {
  // A lowercase IBAN in a field named for something else, and in a select's option.
  assert.equal(pointedValue(typed("Reference", "de89 3704 0044 0532 0130 00")), LEFT_OUT);
  assert.equal(pointedValue(typed("Beneficiary", "GB82-WEST-1234-5698-7654-32")), LEFT_OUT);
  assert.equal(formState([control({ kind: "select", type: "select", label: "Pay to", value: "de89370400440532013000" })])!.left_out, 1);
  // A card number with dots or slashes, and inside other words.
  assert.equal(pointedValue(typed("Number", "4111.1111.1111.1111")), LEFT_OUT);
  assert.equal(pointedValue(typed("Number", "4111/1111/1111/1111")), LEFT_OUT);
  assert.equal(pointedValue(typed("Card", "Visa 4111111111111111")), LEFT_OUT);
  assert.equal(formState([radio("Visa 4111 1111 1111 1111", true, { group: "Saved cards" })])!.left_out, 1);
  // A Chilean RUN, by its label and by its value alone.
  assert.equal(pointedValue(typed("Ingresa tu RUN", "12.345.678-5", { name: "run" })), LEFT_OUT);
  assert.equal(pointedValue(typed("Documento", "12.345.678-5")), LEFT_OUT);
  assert.equal(pointedValue(typed("Documento", "1.234.567-K")), LEFT_OUT);
  assert.equal(pointedValue(typed("Cédula de identidad", "1234567")), LEFT_OUT);
  // An account number of 8 to 12 digits, under the abbreviated labels bank forms use.
  for (const label of ["Nro. de cuenta", "N° de cuenta", "No. de cuenta"]) {
    assert.equal(pointedValue(typed(label, "1234567")), LEFT_OUT, label);
    assert.equal(pointedValue(typed("Destino", "123456789012")), LEFT_OUT);
  }
  // A checkbox whose label is the card number.
  assert.equal(formState([checkbox("4111111111111111", true)])!.left_out, 1);
  assert.equal(shapeReading({ ...page, form: { fields: [{ label: "4111111111111111", value: "checked", kind: "choice", pointed: false }] } })!.form!.left_out, 1);
  // One-time codes and passwords by their markup.
  assert.equal(pointedValue(typed("Code", "123456", { autocomplete: "one-time-password" })), LEFT_OUT);
  for (const name of ["totp", "mfa_code", "2fa", "otp"]) assert.equal(pointedValue(typed("Code", "123456", { name })), LEFT_OUT, name);
  assert.equal(pointedValue(typed("Password", "hunter2", { name: "pass" })), LEFT_OUT, "after a show-password toggle made it type=text");
  for (const name of ["cid", "ccv", "account", "acct", "account_num", "clabe", "iban", "panNumber", "sin", "nif", "curp", "dni", "rut"]) assert.equal(pointedValue(typed("Field", "abc", { name })), LEFT_OUT, name);
  // A CVV labelled from inside a shadow root (the content script resolves aria-labelledby there), named only "code".
  assert.equal(pointedValue(typed("CVV", "123", { name: "code" })), LEFT_OUT);
  // A password field is said to be there, never read.
  assert.equal(pointedValue(typed("Password", "hunter2", { type: "password" })), LEFT_OUT);
  // A label that holds a secret number is dropped with the value.
  assert.deepEqual(formState([typed("Card 4111111111111111", "x")])!.fields[0], { label: null, value: LEFT_OUT, kind: "typed", pointed: true });
});

test("a field the person cannot see is never read: transparent, of no size, off the page, clipped, hidden from assistive technology", () => {
  assert.equal(visuallyHidden(shown), false);
  for (const [why, over] of [
    ["opacity: 0 (checkVisibility)", { checkVisible: false }],
    ["near-zero opacity", { opacity: 0.001 }],
    ["opacity 0.02, the second review's covering input", { opacity: 0.02 }],
    ["opacity 0.099", { opacity: 0.099 }],
    ["zero size", { width: 0, height: 0 }],
    ["1 px (screen reader only)", { width: 1, height: 1 }],
    ["off the page to the left", { left: -10010, right: -9810 }],
    ["off the page above", { top: -500, bottom: -476 }],
    ["clip on an absolute box", { position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" }],
    ["clip-path inset", { clipPath: "inset(50%)" }],
    ["aria-hidden", { ariaHidden: true }],
  ] as const) assert.equal(visuallyHidden({ ...shown, ...over }), true, why);
  // Transparent text counts for a field one types in, not for a radio.
  assert.equal(visuallyHidden({ ...shown, textAlpha: 0 }, true), true);
  assert.equal(visuallyHidden({ ...shown, textAlpha: 0 }), false);
  // The bait field: a text field under the pointer that the person cannot see sends its label and "left out", never its value.
  assert.deepEqual(formState([typed("Promo", "BAITVALUE", { visible: false })])!.fields, [{ label: "Promo", value: LEFT_OUT, kind: "typed", pointed: true }]);
});

test("only a native radio or checkbox is seen through a label the person sees; a select, a typed field or a role never is (second review)", () => {
  const hidden: Seen = { ...shown, opacity: 0 };
  // A custom-styled radio: the native input is transparent under a styled label.
  assert.equal(controlVisible(true, false, hidden, [shown]), true);
  assert.equal(controlVisible(true, false, { ...hidden, ariaHidden: true }, [shown]), false, "aria-hidden on the input itself");
  assert.equal(controlVisible(true, false, hidden, [hidden]), false);
  // An <input role="textbox" style="opacity:0"> reached through its visible label: not seen, so left out.
  assert.equal(controlVisible(false, true, hidden, [shown]), false);
  assert.deepEqual(formState([typed("Promo note", "ROLEVALUE", { visible: controlVisible(false, true, hidden, [shown]) })])!.fields[0]!.value, LEFT_OUT);
  // An off-screen <select> with a visible label and a fullwidth card number: not a choice at all.
  const offscreen: Seen = { ...shown, left: -9999, right: -9799 };
  const select = control({ kind: "select", type: "select", label: "Saved", value: "４１１１１１１１１１１１１１１１", visible: controlVisible(false, false, offscreen, [shown]) });
  assert.equal(select.visible, false);
  assert.deepEqual(formState([radio("Registered post", true), select])!.fields, [{ label: "Shipping method", value: "Registered post", kind: "choice", pointed: false }]);
  // Seen, its number is still held back.
  assert.equal(formState([{ ...select, visible: true }])!.left_out, 1);
});

test("only controls a reading could speak of count toward the 25: not hidden inputs, buttons or ones not seen (second review)", () => {
  assert.equal(countable(control({ type: "hidden" })), false);
  for (const type of ["submit", "button", "reset", "image", "file"]) assert.equal(countable(control({ type })), false, type);
  assert.equal(countable(control({ visible: false })), false);
  for (const c of [control({}), control({ type: "password" }), radio("A", false), checkbox("B", true), control({ kind: "select", type: "select" })]) assert.equal(countable(c), true, c.type);
  // A checkout of 10 fields with 20 hidden tracking inputs still fits.
  const form = [...Array.from({ length: 10 }, () => control({})), ...Array.from({ length: 20 }, () => control({ type: "hidden" }))];
  assert.equal(pickScope([{ kind: "wider", controls: form.filter(countable).length }]), 0);
});

test("a field named only Code with a short number is held back by its markup too", () => {
  assert.equal(pointedValue(typed(null, "123456", { name: "code" })), LEFT_OUT);
  assert.equal(pointedValue(typed("Postal code", "8320000", { name: "postal_code" })), "8320000");
});

test("choices come from the control's own group; a form or role=group only when it holds at most 25 controls", () => {
  assert.equal(pickScope([{ kind: "own", controls: 0 }, { kind: "wider", controls: 300 }]), 0);
  assert.equal(pickScope([{ kind: "wider", controls: 12 }, { kind: "own", controls: 0 }]), 1, "the own group, even when a wider one is nearer");
  assert.equal(pickScope([{ kind: "wider", controls: SCOPE_MAX }]), 0);
  assert.equal(pickScope([{ kind: "wider", controls: 400 }, { kind: "wider", controls: 3 }]), -1, "a page-sized role=group: only the control dropped on");
  assert.equal(pickScope([]), -1);
});

test("the caps hold, and the rest are counted", () => {
  const long = formState([typed("Notes", "word ".repeat(500))])!;
  assert.ok(long.fields[0]!.value.length <= FIELD_VALUE_MAX);
  const many = formState(Array.from({ length: 50 }, (_, i) => checkbox(`Option ${i}`, true)))!;
  assert.equal(many.fields.length, FIELDS_MAX);
  assert.equal(many.more, 50 - FIELDS_MAX);
  const big = formState(Array.from({ length: 15 }, (_, i) => control({ kind: "select", type: "select", label: `Field ${i}`, value: "y".repeat(FIELD_VALUE_MAX) })))!;
  const size = big.fields.reduce((n, f) => n + (f.label?.length ?? 0) + f.value.length, 0);
  assert.ok(size <= FORM_TEXT_MAX && big.more > 0);
  assert.equal(formState([]), null);
  assert.equal(formState([typed("Empty", "  ")]), null);
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
