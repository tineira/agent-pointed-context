import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APPROXIMATE, chartAxes, coversPlot, decimalOf, describeMark, formatLike, interpolate, isOutlineCopy, parseNumber, type Chart, type ChartLabel, type ChartMark, type LabelRole, type SvgText } from "../src/chart.ts";

/** A label `text` centred at (x, y), w wide and 12 tall. */
const label = (text: string, x: number, y: number, role: LabelRole = "axis", series: number | null = null, w = 8 * text.length): ChartLabel => ({ text, box: { left: x - w / 2, right: x + w / 2, top: y - 6, bottom: y + 6 }, role, series });
/** A label right-aligned at x, as a value axis on the left draws them. */
const right = (text: string, x: number, y: number, role: LabelRole = "axis"): ChartLabel => ({ text, box: { left: x - 8 * text.length, right: x, top: y - 6, bottom: y + 6 }, role, series: null });
const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
/** describeMark on a chart chartAxes confirms. */
const read = (mark: ChartMark, chart: Chart, omit?: string | null) => {
  const axes = chartAxes(chart);
  assert.ok(axes, "a chart");
  return describeMark(mark, chart, axes, omit);
};

// "Venta neta", series SMU, as Datamind draws it with Highcharts: the title "SMU" above the plot, a month per
// category along the bottom (E F M A M J J A S O N D, 40 px apart from x = 80), and the value axis on the
// left with only "0" (y = 260) and "1 000M" (y = 60).
const MONTHS = ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const monthX = (i: number) => 80 + i * 40;
const yOf = (value: number) => 260 - (value / 1e9) * 200;
const ventaNeta = (extra: ChartLabel[] = [], series = 1): Chart => ({
  labels: [label("SMU", 300, 16, "title"), ...MONTHS.map((m, i) => label(m, monthX(i), 276)), right("0", 50, 260), right("1 000M", 50, 60), ...extra],
  series,
  horizontal: false,
});
/** A line marker (8 px) centred at month i and the given value. */
const marker = (i: number, value: number, series: number | null = 0, accessible: string | null = null): ChartMark => ({ box: box(monthX(i) - 4, yOf(value) - 4, monthX(i) + 4, yOf(value) + 4), kind: "point", series, accessible, siblings: [] });

test("a line chart's point reads its series, its category and an approximate value (TIN-760)", () => {
  const r = read(marker(8, 930e6), ventaNeta(), "Venta neta");
  assert.ok(r);
  assert.equal(r.kind, "point");
  assert.equal(r.text, `SMU · S · ≈ 930M ${APPROXIMATE}`);
  assert.deepEqual([r.series, r.category, r.approximate], ["SMU", "S", true]);
  assert.equal(read(marker(0, 412e6), ventaNeta())!.text, `SMU · E · ≈ 410M ${APPROXIMATE}`);
});

test("with several series, a point is named by its legend item, never by the chart's title", () => {
  const legend = [label("SMU", 200, 296, "legend", 0), label("WALMART", 300, 296, "legend", 1)];
  assert.equal(read(marker(3, 2e8, 1), ventaNeta(legend, 2))!.text, `WALMART · A · ≈ 200M ${APPROXIMATE}`);
  // A series the legend does not name, in a chart of several: left out, not guessed.
  assert.equal(read(marker(3, 2e8, 4), ventaNeta(legend, 2))!.text, `A · ≈ 200M ${APPROXIMATE}`);
});

test("a series that is the reading's heading already is not said twice", () => {
  assert.equal(read(marker(8, 930e6), ventaNeta(), "SMU")!.text, `S · ≈ 930M ${APPROXIMATE}`);
});

test("a value is exact only from visible text of the mark: its own text, then its data label; otherwise approximate", () => {
  assert.equal(read(marker(8, 930e6, 0, "S, 931 012 340. SMU."), ventaNeta())!.text, "S, 931 012 340. SMU.");
  assert.equal(read(marker(8, 930e6, 0, "931 012 340"), ventaNeta())!.text, "SMU · S · 931 012 340");
  const dataLabel = label("931M", monthX(8), yOf(930e6) - 14, "data", 0);
  const withLabel = read(marker(8, 930e6), ventaNeta([dataLabel]));
  assert.equal(withLabel!.text, "SMU · S · 931M");
  assert.equal(withLabel!.approximate, false);
  // Another series' label at the same place is not this point's; nor is a label far from it.
  assert.equal(read(marker(8, 930e6), ventaNeta([{ ...dataLabel, series: 1 }]))!.approximate, true);
  assert.equal(read(marker(8, 930e6), ventaNeta([label("931M", monthX(8), yOf(930e6) - 60, "data", 0)]))!.approximate, true);
});

test("a tooltip on screen is never the value: a drag does not move the chart's hover (Grok P2, Gemini P2)", () => {
  // September dropped on while February's tooltip is still up: "F" / "SMU: 400 M" contains "S".
  const feb = [label("F", 420, 40, "tooltip"), label("SMU: 400 M", 420, 54, "tooltip")];
  assert.equal(read(marker(8, 930e6), ventaNeta(feb))!.text, `SMU · S · ≈ 930M ${APPROXIMATE}`);
  // April with "Agosto" up; March ("M") with "Septiembre" and "930 M" up.
  assert.equal(read(marker(3, 700e6), ventaNeta([label("Agosto", 420, 40, "tooltip"), label("SMU: 700 M", 420, 54, "tooltip")]))!.text, `SMU · A · ≈ 700M ${APPROXIMATE}`);
  assert.equal(read(marker(2, 500e6), ventaNeta([label("Septiembre", 420, 40, "tooltip"), label("SMU: 930 M", 420, 54, "tooltip")]))!.text, `SMU · M · ≈ 500M ${APPROXIMATE}`);
  // A mark with no category does not take it either.
  const off = { ...marker(8, 930e6), box: box(900, yOf(930e6) - 4, 908, yOf(930e6) + 4) };
  assert.equal(read(off, ventaNeta(feb))!.text, `SMU · ≈ 930M ${APPROXIMATE}`);
});

// "Instock promedio": horizontal Highcharts bars, the categories down the left (right-aligned at x = 100, 40 px
// apart), the value axis along the bottom (0% at x = 110 to 100% at x = 510), and a data label at each bar's end.
const STORES = [["CENCOSUD", 98.51], ["WALMART", 96.23], ["TOTTUS", 90.42], ["SMU", 87.67], ["Total General", 94.81]] as const;
const rowY = (i: number) => 40 + i * 40;
const end = (value: number) => 110 + value * 4;
const pct = (v: number) => `${v.toFixed(2).replace(".", ",")}%`;
const ticks = (zero = "0%") => Array.from({ length: 11 }, (_, i) => label(i ? `${i * 10}%` : zero, 110 + i * 40, 250));
const instock = (dataLabels = true, zero = "0%", values: ReadonlyArray<readonly [string, number]> = STORES): Chart => ({
  labels: [
    ...values.map(([name], i) => right(name, 100, rowY(i))),
    ...ticks(zero),
    ...(dataLabels ? values.map(([, v], i) => ({ ...label(pct(v), 0, rowY(i), "data", 0), box: box(end(v) + 5, rowY(i) - 6, end(v) + 5 + 8 * pct(v).length, rowY(i) + 6) })) : []),
  ],
  series: 1,
  horizontal: true,
});
const barBox = (i: number, v: number) => box(110, rowY(i) - 10, end(v), rowY(i) + 10);
const bars = (values: ReadonlyArray<readonly [string, number]> = STORES) => values.map(([, v], i) => barBox(i, v));
const bar = (i: number, values: ReadonlyArray<readonly [string, number]> = STORES): ChartMark => ({ box: barBox(i, values[i]![1]), kind: "bar", series: 0, accessible: null, siblings: bars(values).filter((_, j) => j !== i) });

test("a bar reads its category and its exact data label (TIN-760)", () => {
  const r = read(bar(3), instock(), "Instock promedio");
  assert.equal(r!.kind, "bar");
  assert.equal(r!.text, "SMU · 87,67%");
  assert.equal(r!.approximate, false);
  assert.equal(read(bar(4), instock())!.text, "Total General · 94,81%");
  assert.equal(read(bar(3), instock(false))!.text, `SMU · ≈ 87.7% ${APPROXIMATE}`);
});

test("a percentage axis whose zero is a bare \"0\" keeps its % (Gemini P2, Grok P2)", () => {
  assert.equal(read(bar(3), instock(false, "0"))!.text, `SMU · ≈ 87.7% ${APPROXIMATE}`);
  const axis = (...t: string[]) => t.map((s) => parseNumber(s)!);
  assert.equal(formatLike(87.67, axis("0", "10%", "20%")), "87.7%");
  assert.equal(formatLike(87.67, axis("0", "50%", "100%")), "87.7%");
});

test("a short bar is read at its end and takes the data label just past it (Grok P2)", () => {
  // 8% on the Instock axis: a bar 32 x 20, its label "8%" 5 px past its end.
  const small = [["CENCOSUD", 98.51], ["WALMART", 96.23], ["TOTTUS", 90.42], ["SMU", 8], ["Total General", 94.81]] as const;
  assert.equal(read(bar(3, small), instock(true, "0%", small))!.text, "SMU · 8,00%");
  assert.equal(read(bar(3, small), instock(false, "0%", small))!.text, `SMU · ≈ 8% ${APPROXIMATE}`);
});

// A plain SVG chart, no classes: "Revenue" on top, 0 to 100 up the left (0 at y = 230, 100 at y = 30), Q1 to Q3 along the bottom.
const plain: Chart = {
  labels: [label("Revenue", 200, 8, null), right("0", 40, 230, null), right("50", 40, 130, null), right("100", 40, 30, null), label("Q1", 100, 246, null), label("Q2", 200, 246, null), label("Q3", 300, 246, null)],
  series: 1,
  horizontal: null,
};
const column = (x: number, value: number, accessible: string | null = null): ChartMark => {
  const own = box(x - 20, 230 - value * 2, x + 20, 230);
  return { box: own, kind: "bar", series: null, accessible, siblings: [box(80, 130, 120, 230), box(180, 80, 220, 230), box(280, 50, 320, 230)].filter((b) => b.left !== own.left) };
};

test("a chart whose markup says nothing: axes found by their place, the title above them (generic SVG)", () => {
  assert.equal(read(column(200, 75), plain)!.text, `Revenue · Q2 · ≈ 75 ${APPROXIMATE}`);
  assert.equal(read(column(200, 75, "Q2: 75.2"), plain)!.text, "Revenue · Q2: 75.2");
  const twoTitles = { ...plain, labels: [...plain.labels, label("Draft", 320, 8, null)] };
  assert.equal(read(column(200, 75), twoTitles)!.text, `Q2 · ≈ 75 ${APPROXIMATE}`);
  // A short column (0 to 15, 40 x 30) is read at its top, not its centre (Grok P2).
  assert.equal(read(column(200, 15), plain)!.text, `Revenue · Q2 · ≈ 15 ${APPROXIMATE}`);
});

test("a bar is read at its end away from the baseline, also on a negative axis (Gemini P2)", () => {
  // Ticks -100 to -60 along the bottom, bars from -100 (their shared left edge) to their value.
  const negative: Chart = { labels: [...["-100", "-90", "-80", "-70", "-60"].map((t, i) => label(t, 110 + i * 100, 250)), right("A", 100, 40), right("B", 100, 80)], series: 1, horizontal: true };
  const x = (v: number) => 110 + (v + 100) * 10;
  const a = box(110, 30, x(-80), 50);
  const b = box(110, 70, x(-70), 90);
  assert.equal(read({ box: a, kind: "bar", series: null, accessible: null, siblings: [b] }, negative)!.text, `A · ≈ -80 ${APPROXIMATE}`);
  // No sibling and no zero on the axis: the baseline cannot be told, so no value.
  assert.equal(read({ box: a, kind: "bar", series: null, accessible: null, siblings: [] }, negative)!.text, "A");
});

test("a drawing is a chart only with a value axis and a category axis or data labels (Gemini P2, Grok P2)", () => {
  // A step indicator "1" "2", a calendar badge "15" over "2024", a pie or an icon with no labels: no chart, so no mark.
  assert.equal(chartAxes({ labels: [label("1", 100, 20, null), label("2", 200, 20, null)], series: 1, horizontal: null }), null);
  assert.equal(chartAxes({ labels: [label("15", 100, 20, null), label("2024", 100, 40, null)], series: 1, horizontal: null }), null);
  assert.equal(chartAxes({ labels: [], series: 1, horizontal: null }), null);
  assert.equal(chartAxes({ labels: [label("Sales", 100, 20, "title")], series: 1, horizontal: null }), null);
  // Value axis and category axis, or value axis and data labels: a chart.
  assert.ok(chartAxes(plain));
  assert.ok(chartAxes({ labels: [right("0", 40, 230), right("100", 40, 30), label("42", 200, 140, "data")], series: 1, horizontal: null }));
});

test("geometry is trusted with three ticks on a line, or two with a zero; never a two-tick log axis (Grok P2)", () => {
  assert.equal(interpolate([{ pos: 0, value: 1 }, { pos: 200, value: 1000 }], 100), null);
  assert.equal(interpolate([{ pos: 0, value: 1000 }, { pos: 100, value: 100 }, { pos: 200, value: 10 }], 50), null);
  assert.equal(interpolate([{ pos: 260, value: 0 }, { pos: 60, value: 1e9 }], 74), 930e6);
  assert.equal(interpolate([{ pos: 0, value: 10 }, { pos: 100, value: 20 }, { pos: 200, value: 30 }], 50), 15);
  // So on a two-tick axis without zero, a point keeps its category and has no value.
  const log: Chart = { labels: [...MONTHS.map((m, i) => label(m, monthX(i), 276)), right("1", 50, 260), right("1000", 50, 60)], series: 1, horizontal: false };
  assert.equal(read(marker(4, 500e6), log)!.text, "M");
});

test("a plot band, an area's fill or anything across most of the plot is no mark (Gemini P2, Grok P2)", () => {
  const axes = chartAxes(ventaNeta())!;
  // A band from (60, 60) to (580, 140); an area's fill box from (80, 180) to (520, 260).
  assert.equal(coversPlot(box(60, 60, 580, 140), axes), true);
  assert.equal(describeMark({ box: box(60, 60, 580, 140), kind: "bar", series: null, accessible: null, siblings: [] }, ventaNeta(), axes), null);
  assert.equal(describeMark({ box: box(80, 180, 520, 260), kind: "point", series: 0, accessible: null, siblings: [] }, ventaNeta(), axes), null);
  assert.equal(coversPlot(marker(8, 930e6).box, axes), false);
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
  assert.equal(value("1.000"), 1000);
  assert.equal(value("1,000"), 1000);
  assert.equal(value("1.000.000"), 1e6);
  assert.equal(value("1.234,5"), 1234.5);
  assert.equal(value("1,234.5"), 1234.5);
  assert.equal(value("$1,200"), 1200);
  assert.equal(parseNumber("US$ 5")!.prefix, "US$");
  assert.equal(value("-5"), -5);
  assert.equal(value("−5"), -5);
  assert.equal(value("1,000", ","), 1);
  assert.equal(value("1.000", ","), 1000);
  // Separators that do not group thousands make no number (Grok P2): "1.2.3", or "98,51%" where "," groups.
  assert.equal(parseNumber("1.2.3"), null);
  assert.equal(parseNumber("98,51%", "."), null);
  assert.equal(parseNumber("1 00M"), null);
  for (const t of ["SMU", "Q1", "E", "Total General", "1.2.3,4,5", ""]) assert.equal(parseNumber(t), null, t);
  assert.equal(decimalOf(["0%", "98,51%"]), ",");
  assert.equal(decimalOf(["1.000", "2.000"]), null);
  assert.equal(decimalOf(["0", "0.5"]), ".");
  // Only labels that are numbers tell the separator, never a subtitle (Grok P2).
  assert.equal(decimalOf(["Crecimiento 1.5%", "0", "1.000", "2.000"]), null);
});

test("a subtitle with a decimal does not rewrite the axis's thousands (Grok P2)", () => {
  // "Crecimiento 1.5%" above, ticks "0", "1.000", "2.000" up the left (dot groups thousands), columns Q1..Q3.
  const chart: Chart = { labels: [label("Crecimiento 1.5%", 200, 8, "other"), right("0", 40, 230), right("1.000", 40, 130), right("2.000", 40, 30), label("Q1", 100, 246), label("Q2", 200, 246), label("Q3", 300, 246)], series: 2, horizontal: false };
  const axes = chartAxes(chart)!;
  assert.deepEqual(axes.numbers.map((n) => n.value), [0, 1000, 2000]);
  const col: ChartMark = { box: box(180, 80, 220, 230), kind: "bar", series: null, accessible: null, siblings: [box(80, 130, 120, 230)] };
  assert.equal(describeMark(col, chart, axes)!.text, `Q2 · ≈ 1.500 ${APPROXIMATE}`);
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
});

test("a label drawn twice, its halo under it, is read once; a real label never dropped (TIN-760, Grok P3)", () => {
  const svgText = (tagName: string, text: string, attrs: Record<string, string> = {}, paint: "fill" | "halo" | "both" = "fill"): SvgText => ({ tagName, textContent: text, getAttribute: (n) => attrs[n] ?? null, stroked: paint !== "fill", strokeOnly: paint === "halo" });
  assert.equal(isOutlineCopy(svgText("tspan", "98,51%", { class: "highcharts-text-outline" }, "halo"), []), true);
  const realLabel = svgText("text", "98,51%", { x: "10", y: "20" });
  const halo = svgText("text", "98,51%", { x: "10", y: "20" }, "halo");
  assert.equal(isOutlineCopy(halo, [halo, realLabel]), true);
  assert.equal(isOutlineCopy(realLabel, [halo, realLabel]), false);
  // A filled label with a stroke too (bold-looking text) at the same place as another is a label, not a halo.
  assert.equal(isOutlineCopy(svgText("text", "98,51%", { x: "10", y: "20" }, "both"), [realLabel]), false);
  assert.equal(isOutlineCopy(halo, [halo, svgText("text", "98,51%", { x: "10", y: "60" })]), false);
  assert.equal(isOutlineCopy(halo, [halo]), false);
});

test("the content script keeps chart work per drag, removes an idle outline, and sends no element for an unreadable mark", () => {
  const source = readFileSync(new URL("../src/content.ts", import.meta.url), "utf8");
  // One analysis per drawing per drag (Gemini P2, Grok P3), forgotten with the scope.
  assert.match(source, /const known = charts\.get\(svg\);\s*if \(known\) return known;/);
  assert.match(source, /function forgetScopes\(\): void \{\s*scopeCache = null;\s*charts\.clear\(\);/);
  // An aborted drag sends neither drop nor dragend: the outline goes after OUTLINE_IDLE_MS without a dragover (Gemini P2).
  assert.match(source, /idleTimer = window\.setTimeout\(\(\) => \{\s*light\(null\);\s*forgetScopes\(\);\s*\}, OUTLINE_IDLE_MS\);/);
  // The box is drawn in a closed shadow root of the extension's host (Grok P3).
  assert.match(source, /host\.dataset\.apcOutline = "";[\s\S]{0,400}host\.attachShadow\(\{ mode: "closed" \}\)/);
  // A mark the chart no longer describes at the drop sends element: null, so the dock says the page (Gemini P3).
  assert.match(source, /: scope && !shape\s*\?/);
  // No tooltip is read for a value.
  assert.doesNotMatch(readFileSync(new URL("../src/chart.ts", import.meta.url), "utf8"), /role === "tooltip"\)\.map/);
});
