import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chooseSensitive, CODE_LEFT_OUT, FIELD_VALUE_MAX, FIELDS_MAX, FORM_TEXT_MAX, LEFT_OUT, NUMBER_LEFT_OUT, readingText, shapeReading, shapeReadingCounted } from "../../dock/src/worker/reading.ts";
import { includeSensitive, type SensitiveMode } from "../src/drop.ts";
import { cardOf, classify, controlVisible, FIELDS_SENT, formState, visuallyHidden, type Control, type Seen } from "../src/read.ts";

const shown: Seen = { checkVisible: true, opacity: 1, textAlpha: 1, width: 200, height: 24, left: 10, top: 10, right: 210, bottom: 34, pageWidth: 1200, pageHeight: 900, position: "static", clip: "auto", clipPath: "none", ariaHidden: false };

const control = (over: Partial<Control>): Control => ({ kind: "text", type: "text", label: null, group: null, groupKey: null, name: null, id: null, autocomplete: null, placeholder: null, checked: false, value: "", pointed: false, visible: true, ...over });
const radio = (label: string, checked: boolean, over: Partial<Control> = {}) => control({ kind: "radio", type: "radio", label, group: "Shipping method", groupKey: "name:ship", name: "ship", checked, ...over });
const checkbox = (label: string, checked: boolean, over: Partial<Control> = {}) => control({ kind: "checkbox", type: "checkbox", label, checked, ...over });
const typed = (label: string | null, value: string, over: Partial<Control> = {}) => control({ label, value, ...over });
const page = { url: "https://shop.example/checkout", title: "Checkout" };

/** What the hub keeps of an outline's controls, as the service worker sends it under a sensitive-data setting (the person's "include this time" too). */
const sent = (controls: Control[], mode: SensitiveMode = "ask", includeThisTime = false) => {
  const raw = { ...page, form: formState(controls) };
  const fromWorker = shapeReadingCounted(chooseSensitive(raw, includeSensitive(mode, includeThisTime)))!;
  // The hub shapes it again, and keeps what the extension kept.
  assert.deepEqual(shapeReading(fromWorker.reading), fromWorker.reading, "the hub keeps what the extension kept");
  return { form: fromWorker.reading.form, withheld: fromWorker.withheld, text: readingText(fromWorker.reading) };
};
const valueOf = (c: Control, mode: SensitiveMode = "ask", includeThisTime = false) => sent([c], mode, includeThisTime).form?.fields[0]?.value;

test("everything the person can see in the outline goes: typed values of every field, the chosen radio, boxes either way, the chosen option (TIN-619)", () => {
  const { form } = sent([
    radio("DHL Express", false),
    radio("Registered post", true),
    checkbox("Insurance", true),
    checkbox("Gift wrap", false),
    control({ kind: "select", type: "select", label: "Country", value: "Chile" }),
    typed("Notes", "Leave at the door", { pointed: true }),
    typed("Address", "Av. Siempre Viva 742"),
    typed("Empty", "  "),
  ]);
  assert.deepEqual(form, {
    fields: [
      { label: "Notes", value: "Leave at the door", kind: "typed", pointed: true },
      { label: "Shipping method", value: "Registered post", kind: "choice", pointed: false },
      { label: "Insurance", value: "checked", kind: "choice", pointed: false },
      { label: "Gift wrap", value: "not checked", kind: "choice", pointed: false },
      { label: "Country", value: "Chile", kind: "choice", pointed: false },
      { label: "Address", value: "Av. Siempre Viva 742", kind: "typed", pointed: false },
    ],
    left_out: 0,
    more: 0,
  });
  // One chosen radio per group; a group with no label is named by the radios' name; the radio under the pointer says when it is not chosen.
  assert.deepEqual(sent([radio("A", true, { group: null }), radio("B", true, { group: null })]).form!.fields, [{ label: "ship", value: "A", kind: "choice", pointed: false }]);
  assert.deepEqual(sent([radio("Standard", false, { pointed: true })]).form!.fields, [{ label: "Shipping method", value: "Standard (not selected)", kind: "choice", pointed: true }]);
});

test("a Google-Forms-like card: its answer goes with the question it was typed under (TIN-619)", () => {
  // The question's title names the answer with aria-labelledby; the content script reads the card's controls.
  const { form, text } = sent([typed("Email", "tomas@example.com", { type: "email" })]);
  assert.deepEqual(form!.fields, [{ label: "Email", value: "tomas@example.com", kind: "typed", pointed: false }]);
  assert.match(text, /\n- Email: tomas@example\.com$/);
});

test("the outline is a field's card: the largest box around it that holds no other control, its text short (cardOf, TIN-619)", () => {
  // A Google Form: list > card > [title, answer box > input], next card > its input.
  interface Node {
    name: string;
    parent: Node | null;
    keys: string[] | null;
    text: number;
  }
  const node = (name: string, parent: Node | null, keys: string[] | null, text: number): Node => ({ name, parent, keys, text });
  const body = node("body", null, ["email", "name"], 500);
  const list = node("list", body, ["email", "name"], 400);
  const card = node("card", list, ["email"], 30);
  const title = node("title", card, [], 6);
  const box = node("box", card, ["email"], 12);
  const input = node("input", box, ["email"], 0);
  const grow = (start: Node, own: string[], textMax = 1200) => cardOf(start, new Set(own), (n) => n.parent, (n) => (n.keys ? new Set(n.keys) : null), (n) => n.text, (n) => n === body, textMax).name;
  // From the answer, and from the common ancestor of the title and the answer (labelCard), the card.
  assert.equal(grow(input, ["email"]), "card");
  assert.equal(grow(box, ["email"]), "card");
  assert.equal(title.parent, card);
  // A card with too much text, or too many controls to count, stops the outline below it.
  assert.equal(grow(input, ["email"], 20), "box");
  card.keys = null;
  assert.equal(grow(input, ["email"]), "box");
  // A radio's whole group counts as one control, so a question of options grows to its card too.
  const options = node("options", list, ["radio:size"], 40);
  const option = node("option", options, ["radio:size"], 6);
  assert.equal(grow(option, ["radio:size"]), "options");
});

test("passwords and one-time codes never go, in any mode, by markup or by words (TIN-619)", () => {
  const credentials = [
    typed("Password", "hunter2", { type: "password" }),
    typed("Password", "hunter2", { name: "pass" }), // after a show-password toggle made it type=text
    typed("Code", "123456", { autocomplete: "one-time-code" }),
    typed("Code", "123456", { autocomplete: "one-time-password" }),
    ...["totp", "mfa_code", "2fa", "otp"].map((name) => typed("Verification", "123456", { name })),
    typed(null, "123456", { name: "code" }),
    typed("Código", "123456"),
    typed("CVV", "123", { name: "code" }),
    typed("Security code", "123", { autocomplete: "cc-csc" }),
  ];
  for (const mode of ["ask", "send", "never"] as const) {
    for (const include of [false, true]) {
      for (const c of credentials) {
        assert.equal(classify(c), "credential", `${c.label} ${c.name}`);
        assert.equal(valueOf(c, mode, include), CODE_LEFT_OUT, `${mode} ${include} ${c.label} ${c.name}`);
        assert.ok(!JSON.stringify(formState([c])).includes("hunter2"), "the value never leaves the content script");
      }
    }
  }
  // Nor counted as something the person could include.
  assert.equal(sent(credentials).withheld, 0);
  // A postal code is not a code.
  assert.equal(valueOf(typed("Postal code", "8320000", { name: "postal_code" })), "8320000");
});

test("a card, IBAN or RUN goes by the setting: Ask per drop leaves it out and offers it, Send if it's in the outline sends it, Always leave out never (TIN-619)", () => {
  const sensitive = [
    typed("Card number", "4111 1111 1111 1111", { name: "cardnumber", autocomplete: "cc-number" }),
    typed("Reference", "de89 3704 0044 0532 0130 00"),
    typed("Beneficiary", "GB82-WEST-1234-5698-7654-32"),
    typed("Ingresa tu RUN", "12.345.678-5", { name: "run" }),
    typed("Documento", "1.234.567-K"),
    typed("Cédula de identidad", "1234567"),
    typed("Nro. de cuenta", "1234567"),
    typed("Number", "4111.1111.1111.1111"),
    typed("Field", "abc", { name: "iban" }),
  ];
  for (const c of sensitive) {
    assert.equal(classify(c), "sensitive", `${c.label}`);
    assert.equal(valueOf(c, "ask"), LEFT_OUT, `ask: ${c.label}`);
    assert.equal(valueOf(c, "never"), LEFT_OUT, `never: ${c.label}`);
    assert.equal(valueOf(c, "never", true), LEFT_OUT, `never ignores include: ${c.label}`);
    assert.equal(valueOf(c, "ask", true), c.value, `ask, then Include them this time: ${c.label}`);
    assert.equal(valueOf(c, "send"), c.value, `send: ${c.label}`);
  }
  // Under Ask per drop, the count is what "Include them this time" would add.
  assert.equal(sent(sensitive, "ask").withheld, sensitive.length);
  assert.equal(sent(sensitive, "send").withheld, 0);
  // A sent value says it was the person's choice.
  assert.match(sent([sensitive[0]!], "send").text, /- Card number: 4111 1111 1111 1111 \(sensitive: the person chose to send it\)/);
  // A choice whose label is a card number is counted, or sent when chosen.
  const saved = checkbox("Visa 4111 1111 1111 1111", true);
  assert.deepEqual(sent([saved], "ask").form, { fields: [], left_out: 1, more: 0 });
  assert.deepEqual(sent([saved], "send").form!.fields, [{ label: "Visa 4111 1111 1111 1111", value: "checked", kind: "choice", pointed: false, sensitive: "included" }]);
  // A label that holds a secret number is dropped with the value.
  assert.deepEqual(sent([typed("Card 4111111111111111", "x")]).form!.fields[0], { label: null, value: LEFT_OUT, kind: "typed", pointed: false });
});

test("a letter-spaced card number in the outlined text is left out under Ask per drop and Always leave out, and goes under Send (TIN-617)", () => {
  const raw = { ...page, element: { tag: "p", text: "Pay 4111aaaaaaaa1111aaaaaaaa1111aaaaaaaa1111 today, before 2026-11-04." }, selection: null };
  for (const [mode, include, text] of [
    ["ask", false, `Pay ${NUMBER_LEFT_OUT} today, before 2026-11-04.`],
    ["never", false, `Pay ${NUMBER_LEFT_OUT} today, before 2026-11-04.`],
    ["ask", true, raw.element.text],
    ["send", false, raw.element.text],
  ] as const) assert.equal(shapeReading(chooseSensitive(raw, includeSensitive(mode, include)))!.element!.text, text, `${mode} ${include}`);
});

test("a field the person cannot see is never read, not even its label: transparent, of no size, off the page, clipped, hidden from assistive technology", () => {
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
  // The bait field under the pointer, a hidden input and a field hidden in the outline: nothing of them goes.
  const state = sent([typed("Promo", "BAITVALUE", { visible: false, pointed: true }), typed("csrf", "HIDDENTOKEN", { type: "hidden" }), typed("Notes", "Leave at the door")]);
  assert.deepEqual(state.form!.fields, [{ label: "Notes", value: "Leave at the door", kind: "typed", pointed: false }]);
  assert.doesNotMatch(state.text, /BAIT|HIDDEN|Promo|csrf/);
});

test("only a native radio or checkbox is seen through a label the person sees; a select, a typed field or a role never is (second review)", () => {
  const hidden: Seen = { ...shown, opacity: 0 };
  // A custom-styled radio: the native input is transparent under a styled label.
  assert.equal(controlVisible(true, false, hidden, [shown]), true);
  assert.equal(controlVisible(true, false, { ...hidden, ariaHidden: true }, [shown]), false, "aria-hidden on the input itself");
  assert.equal(controlVisible(true, false, hidden, [hidden]), false);
  // An <input role="textbox" style="opacity:0"> reached through its visible label: not seen, so not read.
  assert.equal(controlVisible(false, true, hidden, [shown]), false);
  assert.equal(sent([typed("Promo note", "ROLEVALUE", { visible: controlVisible(false, true, hidden, [shown]) })]).form, null);
  // An off-screen <select> with a visible label and a fullwidth card number: not a choice at all, in any mode.
  const offscreen: Seen = { ...shown, left: -9999, right: -9799 };
  const select = control({ kind: "select", type: "select", label: "Saved", value: "４１１１１１１１１１１１１１１１", visible: controlVisible(false, false, offscreen, [shown]) });
  assert.equal(select.visible, false);
  assert.deepEqual(sent([radio("Registered post", true), select], "send").form!.fields, [{ label: "Shipping method", value: "Registered post", kind: "choice", pointed: false }]);
  // Seen, its number is a sensitive value.
  assert.equal(sent([{ ...select, visible: true }]).form!.left_out, 1);
});

test("the caps hold, and the rest are counted as more fields not included", () => {
  const long = sent([typed("Notes", "word ".repeat(500))]).form!;
  assert.ok(long.fields[0]!.value.length <= FIELD_VALUE_MAX);
  const many = sent(Array.from({ length: 50 }, (_, i) => checkbox(`Option ${i}`, true)));
  assert.equal(many.form!.fields.length, FIELDS_MAX);
  assert.equal(many.form!.more, 50 - FIELDS_MAX);
  assert.match(many.text, /\n30 fields more not included\.$/);
  const big = sent(Array.from({ length: 15 }, (_, i) => control({ kind: "select", type: "select", label: `Field ${i}`, value: "y".repeat(FIELD_VALUE_MAX) }))).form!;
  const size = big.fields.reduce((n, f) => n + (f.label?.length ?? 0) + f.value.length, 0);
  assert.ok(size <= FORM_TEXT_MAX && big.more > 0);
  // The content script hands on at most FIELDS_SENT, and counts the rest.
  const huge = formState(Array.from({ length: FIELDS_SENT + 5 }, (_, i) => checkbox(`Option ${i}`, true)))!;
  assert.equal(huge.fields.length, FIELDS_SENT);
  assert.equal(huge.more, 5);
  assert.equal(shapeReading({ ...page, form: huge })!.form!.more, FIELDS_SENT + 5 - FIELDS_MAX);
  assert.equal(formState([]), null);
  assert.equal(formState([typed("Empty", "  ")]), null);
});

test("nothing is read outside a drop: the content script reads the page only in readAt, from a drop or a moved pin, from what was outlined", () => {
  const source = readFileSync(new URL("../src/content.ts", import.meta.url), "utf8");
  // No listener that would see a form being filled in (the only keydown is Esc while a pin is dragged).
  assert.doesNotMatch(source, /addEventListener\(\s*"(input|change|keyup|focusin|selectionchange)"/);
  // readAt runs on a drop (onPageDrop) and when a pin is moved; formIn and selectionContext only inside readAt.
  assert.equal(source.match(/readAt\(/g)?.length, 3, "its definition, the drop and the pin's move");
  assert.equal(source.match(/formIn\(/g)?.length, 2, "its definition and readAt");
  assert.equal(source.match(/selectionContext\(/g)?.length, 2, "its definition and readAt");
  // The drop and the pin's release read what was outlined (lit), not what is under the pointer by then.
  assert.match(source, /const outlined = lit;\s*light\(null\);/);
  assert.match(source, /const outlined = lit;\s*end\(\);/);
});
