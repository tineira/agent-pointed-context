import assert from "node:assert/strict";
import { after, test } from "node:test";
import { defined, doc, El } from "./fake-dom.ts";

const { defineHandoff } = await import("../src/handoff-card.ts");

type Card = El & { host: string; pairing: unknown; message: string | null; titleId: string; autoFocus: boolean; disconnectedCallback(): void };

const drawn: Card[] = [];
after(() => drawn.forEach((e) => e.disconnectedCallback()));

function draw(): Card {
  defineHandoff();
  const el = new (defined.get("apc-handoff")!)() as Card;
  doc.body.append(el);
  drawn.push(el);
  return el;
}
const inSoon = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const focused: El[] = [];
El.prototype.focus = function (this: El) {
  focused.push(this);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the card names itself with the id a dialog points at, and has no live region, so the countdown is not read out", () => {
  const el = draw();
  el.titleId = "hub-consent-title";
  el.host = "dock.test";
  el.pairing = { code: "K7M4P2", expires_at: inSoon(60) };
  const title = el.elements().find((e) => e.getAttribute("id") === "hub-consent-title");
  assert.ok(title, "the title carries the id");
  assert.match(title.textContent, /dock\.test/);
  for (const e of [el, ...el.elements()]) {
    assert.equal(e.getAttribute("aria-live"), null);
    assert.notEqual(e.getAttribute("role"), "status");
    assert.notEqual(e.getAttribute("role"), "alert");
  }
  assert.ok(el.elements().some((e) => e.textContent === "K7M-4P2"));
});

test("in a dialog, focus goes to Copy while there is a code, and to Cancel when the code runs out or the pairing ended", async () => {
  const el = draw();
  el.autoFocus = true;
  el.host = "dock.test";
  focused.length = 0;
  el.pairing = { code: "K7M4P2", expires_at: inSoon(60) };
  await settle();
  assert.equal(focused.at(-1)?.textContent, "Copy code");
  el.pairing = { code: "K7M4P2", expires_at: new Date(Date.now() - 1000).toISOString() };
  await settle();
  assert.equal(focused.at(-1)?.textContent, "Cancel");
  assert.ok(!el.elements().some((e) => e.textContent.includes("K7M")), "the code is gone");
  el.pairing = null;
  el.message = "The dock refused the pairing code.";
  await settle();
  assert.equal(focused.at(-1)?.textContent, "Close");
});

test("without autoFocus the card never takes focus (the banner case)", async () => {
  const el = draw();
  el.host = "dock.test";
  focused.length = 0;
  el.pairing = { code: "K7M4P2", expires_at: inSoon(60) };
  await settle();
  assert.equal(focused.length, 0);
});

test("a code with no stored expiry shows no clock", () => {
  const el = draw();
  el.host = "dock.test";
  el.pairing = { code: "K7M4P2", expires_at: null };
  assert.ok(el.elements().some((e) => e.textContent === "K7M-4P2"));
  assert.ok(!el.elements().some((e) => e.className === "apc-handoff__clock"));
});
