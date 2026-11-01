import assert from "node:assert/strict";
import { test } from "node:test";
import { agoLabel, PAGE_TEXT_MAX, pageAddress, readerAllowed, readingEntry, readingSite, readingText, shapeReading, sizeLabel } from "../src/worker/reading.ts";

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
