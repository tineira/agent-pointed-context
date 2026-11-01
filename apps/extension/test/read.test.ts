import assert from "node:assert/strict";
import { test } from "node:test";
import { altText, NO_ALT, tableContext } from "../src/read.ts";

const described = (tagName: string, attrs: Record<string, string> = {}, inner: Record<string, string> = {}) => ({
  tagName,
  getAttribute: (name: string) => attrs[name] ?? null,
  querySelector: (selector: string) => (selector in inner ? { textContent: inner[selector]! } : null),
});

test("an image gives its alt text, says when it has none, and stays silent when marked as decoration (TIN-422)", () => {
  assert.equal(altText(described("IMG", { alt: "  Churn by region " })), "Churn by region");
  assert.equal(altText(described("IMG", { "aria-label": "Churn by region" })), "Churn by region");
  assert.equal(altText(described("IMG")), NO_ALT);
  assert.equal(altText(described("IMG", { alt: "" })), "");
});

test("a formula gives its alternative text, not its glyphs", () => {
  const tex = 'annotation[encoding="application/x-tex"]';
  assert.equal(altText(described("math", { alttext: "{\\displaystyle L\\times T*100}" })), "{\\displaystyle L\\times T*100}");
  assert.equal(altText(described("math", { "aria-label": "L times T" })), "L times T");
  assert.equal(altText(described("math", {}, { [tex]: "L T" })), "L T");
  assert.equal(altText(described("math")), null);
});

test("a drawing gives its label or title; anything else stands for itself", () => {
  assert.equal(altText(described("svg", { "aria-label": "Logo" })), "Logo");
  assert.equal(altText(described("svg", {}, { title: "Chart" })), "Chart");
  assert.equal(altText(described("svg")), null);
  assert.equal(altText(described("P", { alt: "ignored" })), null);
});

interface TestCell {
  tagName: string;
  colSpan: number;
  rowSpan: number;
  words: string;
}
const th = (words: string, colSpan = 1, rowSpan = 1): TestCell => ({ tagName: "TH", colSpan, rowSpan, words });
const td = (words: string, colSpan = 1, rowSpan = 1): TestCell => ({ tagName: "TD", colSpan, rowSpan, words });
const table = (...rows: TestCell[][]) => ({ rows: rows.map((cells) => ({ cells })) });
const place = (t: ReturnType<typeof table>, cell: TestCell) => tableContext(t, cell, (c) => c.words);

test("a cell finds its column header and its row's first cell", () => {
  const cell = td("19.6");
  const t = table([th("Country"), th("Population")], [td("Peru"), td("33")], [td("Chile"), cell]);
  assert.deepEqual(place(t, cell), { column: "Population", row: "Chile" });
});

test("the first cell of a row has no row of its own, and a header row none either", () => {
  const first = td("Chile");
  const header = th("Population");
  const t = table([th("Country"), header], [first, td("19.6")]);
  assert.deepEqual(place(t, first), { column: "Country", row: null });
  assert.deepEqual(place(t, header), { column: null, row: null });
});

test("a header cell in the first column names the row", () => {
  const cell = td("19.6");
  assert.deepEqual(place(table([th("Country"), th("Population")], [th("Chile"), cell]), cell), { column: "Population", row: "Chile" });
});

test("spans keep the grid straight", () => {
  // Wide header over two columns, then a rowspan pushing the next row's cell to the right.
  const cell = td("7");
  const t = table([th("Region", 1, 2), th("Sales", 2)], [th("Q1"), th("Q2")], [td("EU", 1, 2), td("1"), td("2")], [td("3"), cell]);
  assert.deepEqual(place(t, cell), { column: "Q2", row: "EU" });
  const under = td("9");
  assert.deepEqual(place(table([th("Region"), th("Sales", 2)], [td("EU"), td("1"), under]), under), { column: "Sales", row: "EU" });
});

test("a plain table has no column header: its first row may be data", () => {
  const cell = td("2");
  assert.deepEqual(place(table([td("a"), td("b")], [td("c"), cell]), cell), { column: null, row: "c" });
});

test("a table that asks for millions of places gets no context, and no work", () => {
  const cell = td("x");
  const huge = table(Array.from({ length: 100 }, () => th("h", 1000, 1000)), ...Array.from({ length: 999 }, () => []), [cell]);
  assert.deepEqual(place(huge, cell), { column: null, row: null });
});

test("empty headers count as none, and a cell not in the table finds nothing", () => {
  const cell = td("2");
  assert.deepEqual(place(table([th(" "), th("  ")], [td(""), cell]), cell), { column: null, row: null });
  assert.deepEqual(place(table([td("a")]), td("elsewhere")), { column: null, row: null });
});
