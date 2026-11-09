import assert from "node:assert/strict";
import { test } from "node:test";
import { altText, blockAbove, BOX_MAX, headingOf, isHeading, isItem, NO_ALT, ownsHeadings, tableContext, visibleWords, type Rect } from "../src/read.ts";

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

/** A page as plain nodes, for blockAbove and headingOf: a tag, a role, its own text, and whether it is inline. */
interface Node {
  tag: string;
  role: string | null;
  own: string;
  inline: boolean;
  parent: Node | null;
  kids: Node[];
}
const el = (tag: string, kids: (Node | string)[] = [], opts: { role?: string; inline?: boolean } = {}): Node => {
  const node: Node = { tag, role: opts.role ?? null, own: "", inline: opts.inline ?? false, parent: null, kids: [] };
  for (const k of kids) {
    if (typeof k === "string") node.own += k;
    else {
      k.parent = node;
      node.kids.push(k);
    }
  }
  return node;
};
const textOf = (n: Node): string => [n.own, ...n.kids.map(textOf)].join(" ").replace(/\s+/g, " ").trim();
const climb = (body: Node) => ({
  up: (n: Node) => n.parent,
  top: (n: Node) => n === body,
  inline: (n: Node) => n.inline,
  item: (n: Node) => isItem(n.tag, n.role),
  text: (n: Node) => textOf(n).length,
});
const outline = {
  up: (n: Node) => n.parent,
  children: (n: Node) => n.kids,
  heading: (n: Node) => isHeading(n.tag, n.role) && textOf(n).length > 0,
  owns: (n: Node) => ownsHeadings(n.tag, n.role),
};

/** A car card as autio.cl draws one: a photo with a photo-count badge, a caption, and an empty link stretched over it all. */
const card = (title: string, price: string) => {
  const photo = el("img", [], { inline: true });
  const badge = el("span", ["5"]);
  const media = el("div", [photo, badge]);
  const heading = el("h2", [title]);
  const priceTag = el("p", [price]);
  const facts = el("p", ["45.870 km · Manual · Bencina"]);
  const caption = el("div", [el("div", [heading, priceTag]), facts]);
  const link = el("a", [el("span")]); // its words are sr-only: the person sees none
  const article = el("article", [el("div", [media, caption]), link]);
  return { article, photo, badge, media, heading, priceTag, caption, link };
};
const grid = () => {
  const audi = card("Audi A3 Attraction 2009", "$8.900.000");
  const vw = card("Volkswagen Saveiro Comfortline 2020", "$10.100.000");
  const lone = el("article", [el("p", ["A card with no title of its own"])]);
  const section = el("section", [el("h2", ["Autos disponibles"]), el("div", [audi.article, vw.article, lone])]);
  const body = el("body", [el("header", [el("h1", ["autio"])]), section]);
  return { audi, vw, lone, section, body };
};

test("a drop on a card's photo or on the link stretched over it points at the card, not the page (blockAbove, TIN-697)", () => {
  const { vw, body } = grid();
  const block = (n: Node) => blockAbove(n, climb(body));
  // The link over the card holds no text the person sees: the card around it is what was pointed at.
  assert.equal(block(vw.link), vw.article);
  // The photo: past the badge, a scrap of text; the box around the photo and the caption holds the card's
  // text, and so does the card around it, so the card itself.
  assert.equal(block(vw.photo), vw.article);
  assert.equal(block(vw.badge), vw.article);
  // A box with enough text of its own is the block, not the card around it.
  assert.equal(block(vw.caption), vw.caption);
});

test("the climb takes an item with little text, stops at most of the page, and keeps a scrap rather than nothing (blockAbove)", () => {
  const small = el("li", ["Home"]);
  const list = el("ul", [small]);
  const body = el("body", [list]);
  assert.equal(blockAbove(small, climb(body)), small);
  // A scrap inside a box that is most of the page: the scrap, since there is nothing between.
  const scrap = el("span", ["5"]);
  const huge = el("div", [scrap, "x".repeat(BOX_MAX + 1)]);
  const page = el("body", [huge]);
  assert.equal(blockAbove(scrap, climb(page)), scrap);
  // An empty table cell: its row, an item of the table, not the whole table.
  const blank = el("td");
  const row = el("tr", [el("td", ["Alice"]), blank]);
  const table = el("table", [el("tr", [el("th", ["Name"]), el("th", ["Score"])]), row]);
  assert.equal(blockAbove(blank, climb(el("body", [table]))), row);
  // No text at all on the way up: the page.
  const empty = el("div");
  assert.equal(blockAbove(empty, climb(el("body", [el("main", [empty])]))), null);
  // An inline box gives its words to the box around it; boxes around that with the same text but no
  // card among them (a feed like X's, one post on the page) leave it the post's text, not the main box.
  const word = el("span", ["Churn rose in March after the offer"], { inline: true });
  const para = el("div", [word]);
  assert.equal(blockAbove(word, climb(el("body", [el("main", [el("div", [para])])]))), para);
});

test("a card is under its own title, never the card before it; in a card, the title above (headingOf, TIN-697)", () => {
  const { audi, vw, lone, section } = grid();
  const title = (n: Node) => {
    const h = headingOf(n, outline);
    return h ? textOf(h) : null;
  };
  assert.equal(title(vw.article), "Volkswagen Saveiro Comfortline 2020");
  assert.equal(title(audi.article), "Audi A3 Attraction 2009");
  // Inside a card: its own title, before it in the card.
  assert.equal(title(vw.priceTag), "Volkswagen Saveiro Comfortline 2020");
  // A card with no title: the grid's heading, past the cards before it.
  assert.equal(title(lone), "Autos disponibles");
  // The heading itself, or something in it.
  assert.equal(title(vw.heading), "Volkswagen Saveiro Comfortline 2020");
  // A photo box whose badge has text enough to be the block: still under its own card's title, which
  // comes after it in the card, not under the card before it.
  const media = el("div", [el("img", [], { inline: true }), el("span", ["12 photos · 360 view"])]);
  const subaru = el("article", [media, el("h2", ["Subaru Forester 2021"])]);
  el("div", [card("Audi A3 Attraction 2009", "$8.900.000").article, subaru]);
  assert.equal(title(media), "Subaru Forester 2021");
  // A list of cards: its own heading, not its first card's title.
  assert.equal(title(section), "Autos disponibles");
});

test("a paragraph is under the heading before it, never one inside a section, item or nav before it (headingOf)", () => {
  const p = el("p", ["Churn in EU-West rose 4.2% in March."]);
  const cell = el("td", ["19.6"]);
  const body = el("body", [
    el("h1", ["Churn notes"]),
    el("nav", [el("h2", ["Menu"])]),
    el("div", [el("h2", ["EU-West"])]),
    el("section", [el("h2", ["Another section"])]),
    el("ul", [el("li", [el("h3", ["A step"])])]),
    p,
    el("h2", ["", ""]), // an empty heading: no one sees it
    el("table", [el("tr", [el("td", ["Chile"]), cell])]),
  ]);
  const title = (n: Node) => {
    const h = headingOf(n, outline);
    return h ? textOf(h) : null;
  };
  // In a wrapper before it: still its heading; inside a section or a list item before it: not.
  assert.equal(title(p), "EU-West");
  assert.equal(title(cell), "EU-West");
  // A heading by its role (Google Forms) counts as one.
  const q = el("div", [el("div", ["Email"], { role: "heading" }), el("div", ["Your answer"])], { role: "listitem" });
  assert.equal(title(q), "Email");
  assert.equal(headingOf(el("p", ["alone"]), outline), null);
});

// TIN-622: a token with no space that spans lines is kept only where it shows.
/** A text laid out `perLine` UTF-16 units to a line, 20 px high, as a Range over a slice reports it: one rect per line the slice touches. */
const layout = (perLine: number) => (start: number, end: number): Rect[] => {
  const rects: Rect[] = [];
  for (let l = Math.floor(start / perLine); l <= Math.floor((end - 1) / perLine); l++) {
    const from = Math.max(start, l * perLine) - l * perLine;
    const to = Math.min(end, (l + 1) * perLine) - l * perLine;
    rects.push({ left: from * 10, top: l * 20, right: to * 10, bottom: l * 20 + 20 });
  }
  return rects;
};
/** A scroll box 100 px wide that shows the first two lines. */
const twoLines: Rect = { left: 0, top: 0, right: 100, bottom: 40 };

test("a CJK paragraph in a box that shows two of its lines gives only those lines, with no spaces (TIN-622)", () => {
  const text = "一二三四五六七八九十" + "甲乙丙丁戊己庚辛壬癸" + "子丑寅卯辰巳午未申酉" + "春夏秋冬東南西北中央";
  assert.equal(visibleWords(text, layout(10), twoLines), "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸");
  assert.equal(visibleWords(text, layout(10), { ...twoLines, top: 40, bottom: 80 }), "子丑寅卯辰巳午未申酉春夏秋冬東南西北中央");
  assert.equal(visibleWords(text, layout(10), { left: 0, top: 100, right: 100, bottom: 140 }), "");
});

test("a break-all hash partly clipped gives only its visible part (TIN-622)", () => {
  const hash = "0123456789abcdef".repeat(13).slice(0, 200); // 200 characters, 20 to a line
  // "sha " takes 4 units, so the hash starts on line 0 and the box shows up to unit 40.
  assert.equal(visibleWords(`sha ${hash} end`, layout(20), { ...twoLines, right: 200 }), `sha ${hash.slice(0, 36)}`);
});

test("a word wrapped across a clip keeps its visible graphemes only: a surrogate pair and a combining mark are never split (TIN-622)", () => {
  // Lines of 4 UTF-16 units: line 0 is "a", a surrogate pair, "b"; line 1 starts with e + U+0301.
  const text = "a\u{1D4B3}bécdXYZ12345";
  assert.equal(visibleWords(text, layout(4), { left: 0, top: 0, right: 100, bottom: 20 }), "a\u{1D4B3}b");
  // The box shows line 1 only: "e" and its accent stay together.
  assert.equal(visibleWords(text, layout(4), { left: 0, top: 20, right: 100, bottom: 40 }), "écd");
});

test("ordinary text is read as before: whole words that show, the spaces between them, a one-line word partly cut stays whole (TIN-622)", () => {
  // 8 units to a line, each line a whole number of words: the box shows the first two lines.
  assert.equal(visibleWords("aaa bbb ccc ddd eee fff", layout(8), twoLines), "aaa bbb ccc ddd");
  const oneLine = (s: number, e: number): Rect[] => [{ left: s * 10, top: 0, right: e * 10, bottom: 20 }];
  assert.equal(visibleWords("alpha beta", oneLine, { left: 0, top: 0, right: 80, bottom: 20 }), "alpha beta");
  assert.equal(visibleWords("alpha beta", oneLine, { left: 0, top: 0, right: 50, bottom: 20 }), "alpha");
});
