import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROXIMATE, decimalOf, describeMark, formatLike, interpolate, isOutlineCopy, parseNumber, type Chart, type ChartLabel, type LabelRole, type SvgText } from "../src/chart.ts";

/** A label `text` centred at (x, y), w wide and 12 tall. */
const label = (text: string, x: number, y: number, role: LabelRole = "axis", series: number | null = null, w = 8 * text.length): ChartLabel => ({ text, box: { left: x - w / 2, right: x + w / 2, top: y - 6, bottom: y + 6 }, role, series });
/** A label right-aligned at x, as a value axis on the left draws them. */
const right = (text: string, x: number, y: number, role: LabelRole = "axis"): ChartLabel => ({ text, box: { left: x - 8 * text.length, right: x, top: y - 6, bottom: y + 6 }, role, series: null });
const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

// "Venta neta", series SMU, as Datamind draws it with Highcharts: the title "SMU" above the plot, a month per
// category along the bottom (E F M A M J J A S O N D, 40 px apart from x = 80), and the value axis on the
// left with only "0" (y = 260) and "1 000M" (y = 60).
const MONTHS = ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const monthX = (i: number) => 80 + i * 40;
const yOf = (value: number) => 260 - (value / 1e9) * 200;
const ventaNeta = (extra: ChartLabel[] = [], series = 1): Chart => ({
  labels: [label("SMU", 300, 16, "title"), ...MONTHS.map((m, i) => label(m, monthX(i), 276)), right("0", 50, 260), right("1 000M", 50, 60), ...extra],
  series,
});
/** A line marker (8 px) centred at month i and the given value. */
const marker = (i: number, value: number, series: number | null = 0, accessible: string | null = null) => ({ box: box(monthX(i) - 4, yOf(value) - 4, monthX(i) + 4, yOf(value) + 4), series, accessible });

test("a line chart's point reads its series, its category and an approximate value (TIN-760)", () => {
  const r = describeMark(marker(8, 930e6), ventaNeta(), "Venta neta");
  assert.ok(r);
  assert.equal(r.kind, "point");
  assert.equal(r.text, `SMU · S · ≈ 930M ${APPROXIMATE}`);
  assert.deepEqual([r.series, r.category, r.approximate], ["SMU", "S", true]);
  // Another month, another value: in line with the label under it.
  assert.equal(describeMark(marker(0, 412e6), ventaNeta())!.text, `SMU · E · ≈ 410M ${APPROXIMATE}`);
});

test("with several series, a point is named by its legend item, never by the chart's title", () => {
  const legend = [label("SMU", 200, 296, "legend", 0), label("WALMART", 300, 296, "legend", 1)];
  const r = describeMark(marker(3, 2e8, 1), ventaNeta(legend, 2));
  assert.equal(r!.text, `WALMART · A · ≈ 200M ${APPROXIMATE}`);
  // A series the legend does not name, in a chart of several: left out, not guessed.
  assert.equal(describeMark(marker(3, 2e8, 4), ventaNeta(legend, 2))!.text, `A · ≈ 200M ${APPROXIMATE}`);
});

test("a series that is the reading's heading already is not said twice", () => {
  assert.equal(describeMark(marker(8, 930e6), ventaNeta(), "SMU")!.text, `S · ≈ 930M ${APPROXIMATE}`);
});

test("the value comes from the mark's own text first, then a data label, then a tooltip, then the axis", () => {
  // Its own accessible text (Highcharts' accessibility module, other libraries): exact, and what it already says is not repeated.
  assert.equal(describeMark(marker(8, 930e6, 0, "S, 931 012 340. SMU."), ventaNeta())!.text, "S, 931 012 340. SMU.");
  assert.equal(describeMark(marker(8, 930e6, 0, "931 012 340"), ventaNeta())!.text, "SMU · S · 931 012 340");
  // A data label above the point, in its series: exact.
  const dataLabel = label("931M", monthX(8), yOf(930e6) - 14, "data", 0);
  const withLabel = describeMark(marker(8, 930e6), ventaNeta([dataLabel]));
  assert.equal(withLabel!.text, "SMU · S · 931M");
  assert.equal(withLabel!.approximate, false);
  // Another series' label at the same place is not this point's.
  assert.equal(describeMark(marker(8, 930e6), ventaNeta([{ ...dataLabel, series: 1 }]))!.approximate, true);
  // A label far from the point is not its label.
  assert.equal(describeMark(marker(8, 930e6), ventaNeta([label("931M", monthX(8), yOf(930e6) - 60, "data", 0)]))!.approximate, true);
  // A tooltip shown at the drop that names the point's category.
  const tip = [label("S", 420, 40, "tooltip"), label("SMU: 931 M", 420, 54, "tooltip")];
  assert.equal(describeMark(marker(8, 930e6), ventaNeta(tip))!.text, "SMU · S · S SMU: 931 M");
  // One about another category is not this point's.
  const other = [label("Agosto", 420, 40, "tooltip"), label("SMU: 700 M", 420, 54, "tooltip")];
  assert.equal(describeMark(marker(5, 930e6), ventaNeta(other))!.approximate, true);
});

// "Instock promedio": horizontal Highcharts bars, the categories down the left (right-aligned at x = 100, 40 px
// apart), the value axis along the bottom (0% at x = 110 to 100% at x = 510), and a data label at each bar's end.
const STORES = [["CENCOSUD", 98.51], ["WALMART", 96.23], ["TOTTUS", 90.42], ["SMU", 87.67], ["Total General", 94.81]] as const;
const rowY = (i: number) => 40 + i * 40;
const end = (value: number) => 110 + value * 4;
const pct = (v: number) => `${v.toFixed(2).replace(".", ",")}%`;
const instock = (dataLabels = true): Chart => ({
  labels: [
    ...STORES.map(([name], i) => right(name, 100, rowY(i))),
    ...Array.from({ length: 11 }, (_, i) => label(`${i * 10}%`, 110 + i * 40, 250)),
    ...(dataLabels ? STORES.map(([, v], i) => ({ ...label(pct(v), 0, rowY(i), "data", 0), box: box(end(v) + 5, rowY(i) - 6, end(v) + 53, rowY(i) + 6) })) : []),
  ],
  series: 1,
});
const bar = (i: number) => ({ box: box(110, rowY(i) - 10, end(STORES[i]![1]), rowY(i) + 10), series: 0, accessible: null });

test("a bar reads its category and its exact data label (TIN-760)", () => {
  const r = describeMark(bar(3), instock(), "Instock promedio");
  assert.equal(r!.kind, "bar");
  assert.equal(r!.text, "SMU · 87,67%");
  assert.equal(r!.approximate, false);
  assert.equal(describeMark(bar(4), instock())!.text, "Total General · 94,81%");
  // Without data labels, the bar's end against the axis, in the axis's own way of writing it.
  assert.equal(describeMark(bar(3), instock(false))!.text, `SMU · ≈ 87.7% ${APPROXIMATE}`);
});

test("a chart whose markup says nothing: axes found by their place, the title above them (generic SVG)", () => {
  // A vertical bar chart drawn by hand or with d3 without classes: "Revenue" on top, 0 to 100 up the left, Q1 to Q3 along the bottom.
  const plain: Chart = {
    labels: [label("Revenue", 200, 8, null), right("0", 40, 230, null), right("50", 40, 130, null), right("100", 40, 30, null), label("Q1", 100, 246, null), label("Q2", 200, 246, null), label("Q3", 300, 246, null)],
    series: 1,
  };
  // 0 at y = 230, 100 at y = 30: 2 px a unit. Q2's bar reaches 75, at y = 80.
  const column = { box: box(180, 80, 220, 230), series: null, accessible: null };
  assert.equal(describeMark(column, plain)!.text, `Revenue · Q2 · ≈ 75 ${APPROXIMATE}`);
  // With its own <title>, exact; the category it names is not said twice.
  assert.equal(describeMark({ ...column, accessible: "Q2: 75.2" }, plain)!.text, "Revenue · Q2: 75.2");
  // Two titles above: which one names the series cannot be told, so neither.
  const twoTitles = { ...plain, labels: [...plain.labels, label("Draft", 320, 8, null)] };
  assert.equal(describeMark(column, twoTitles)!.text, `Q2 · ≈ 75 ${APPROXIMATE}`);
});

test("a mark the chart tells nothing about is not a point of its own: the drop takes the whole chart", () => {
  assert.equal(describeMark({ box: box(10, 10, 18, 18), series: null, accessible: null }, { labels: [], series: 1 }), null);
  // A point far off any category and with no value axis.
  assert.equal(describeMark({ box: box(10, 10, 18, 18), series: null, accessible: null }, { labels: [label("A", 300, 200), label("B", 400, 200)], series: 1 }), null);
});

test("numbers as charts write them (TIN-760)", () => {
  const value = (t: string, d?: "," | ".") => parseNumber(t, d)?.value ?? null;
  assert.equal(value("1 000M"), 1e9);
  assert.equal(value("1 000M"), 1e9);
  assert.equal(value("3 200M"), 3.2e9);
  assert.equal(value("8G"), 8e9);
  assert.equal(value("800M"), 8e8);
  assert.equal(value("12MM"), 12e6);
  assert.equal(value("3k"), 3000);
  assert.equal(value("0"), 0);
  assert.equal(value("90%"), 90);
  assert.equal(parseNumber("90%")!.unit, "%");
  assert.equal(value("98,51%"), 98.51);
  assert.equal(value("1,5"), 1.5);
  assert.equal(value("0.25"), 0.25);
  // One separator followed by exactly three digits groups thousands, whichever it is.
  assert.equal(value("1.000"), 1000);
  assert.equal(value("1,000"), 1000);
  assert.equal(value("1.000.000"), 1e6);
  assert.equal(value("1.234,5"), 1234.5);
  assert.equal(value("1,234.5"), 1234.5);
  assert.equal(value("$1,200"), 1200);
  assert.equal(parseNumber("US$ 5")!.prefix, "US$");
  assert.equal(value("-5"), -5);
  assert.equal(value("−5"), -5);
  // The chart's own decimal separator settles "1,000".
  assert.equal(value("1,000", ","), 1);
  assert.equal(value("1.000", ","), 1000);
  // Words are not numbers, nor are categories like Q1.
  for (const t of ["SMU", "Q1", "E", "Total General", "1.2.3,4,5", ""]) assert.equal(parseNumber(t), null, t);
  assert.equal(decimalOf(["0%", "98,51%"]), ",");
  assert.equal(decimalOf(["1.000", "2.000"]), null);
  assert.equal(decimalOf(["0", "0.5"]), ".");
});

test("a value read off the axis is written as the axis writes its numbers", () => {
  const axis = (...t: string[]) => t.map((s) => parseNumber(s)!);
  assert.equal(formatLike(930.4e6, axis("0", "1 000M")), "930M");
  assert.equal(formatLike(1_234e6, axis("0", "1 000M", "2 000M")), "1 230M");
  assert.equal(formatLike(930e6, axis("0", "800M", "1,6G")), "930M");
  assert.equal(formatLike(2.4e9, axis("0", "800M", "1,6G", "2,4G")), "2,4G");
  assert.equal(formatLike(87.67, axis("0%", "10%", "20%")), "87.7%");
  assert.equal(formatLike(87.67, axis("0,0%", "10,0%", "20,0%")), "87,7%");
  assert.equal(formatLike(1234, axis("$0", "$1.000", "$2.000")), "$1.230");
  assert.equal(formatLike(-12, axis("-50", "0", "50")), "-12");
  // A log axis is not a straight line: nothing is read.
  assert.equal(interpolate([{ pos: 0, value: 1000 }, { pos: 100, value: 100 }, { pos: 200, value: 10 }], 50), null);
  assert.equal(interpolate([{ pos: 260, value: 0 }, { pos: 60, value: 1e9 }], 74), 930e6);
});

test("a label drawn twice, its halo under it, is read once (TIN-760)", () => {
  const svgText = (tagName: string, text: string, attrs: Record<string, string> = {}, stroked = false): SvgText => ({ tagName, textContent: text, getAttribute: (n) => attrs[n] ?? null, stroked });
  // Highcharts marks the copy.
  assert.equal(isOutlineCopy(svgText("tspan", "98,51%", { class: "highcharts-text-outline" }, true), []), true);
  // Otherwise: a stroked copy with the same words at the same place as an unstroked one.
  const label = svgText("text", "98,51%", { x: "10", y: "20" });
  const halo = svgText("text", "98,51%", { x: "10", y: "20" }, true);
  assert.equal(isOutlineCopy(halo, [halo, label]), true);
  assert.equal(isOutlineCopy(label, [halo, label]), false);
  // The same words elsewhere, or a stroked label alone, are labels of their own.
  assert.equal(isOutlineCopy(halo, [halo, svgText("text", "98,51%", { x: "10", y: "60" })]), false);
  assert.equal(isOutlineCopy(halo, [halo]), false);
});
