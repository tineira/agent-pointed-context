import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { chartAxes, coversPlot, describeMark, describeNamed, isMark, isOutlineCopy, NO_VALUE, ownerOf, parseNumber, type Chart, type ChartLabel, type ChartMark, type ChartShape, type SvgText } from "../src/chart.ts";
import type { Rect } from "../src/read.ts";

// The corpus of scripts/extension-e2e-corpus (TIN-765), as the content script hands it over: the labels the person sees
// with their boxes, and the shapes that could be marks. No class name reaches this file.

/** A label `text` centred at (x, y), w wide and 12 tall. */
const label = (text: string, x: number, y: number, w = 8 * text.length): ChartLabel => ({ text, box: { left: x - w / 2, right: x + w / 2, top: y - 6, bottom: y + 6 } });
/** A label right-aligned at x, as a value axis on the left draws them. */
const right = (text: string, x: number, y: number): ChartLabel => ({ text, box: { left: x - 8 * text.length, right: x, top: y - 6, bottom: y + 6 } });
/** A label left-aligned at x. */
const left = (text: string, x: number, y: number): ChartLabel => ({ text, box: { left: x, right: x + 8 * text.length, top: y - 6, bottom: y + 6 } });
const box = (l: number, t: number, r: number, b: number): Rect => ({ left: l, top: t, right: r, bottom: b });
const cx = (r: Rect) => (r.left + r.right) / 2;
const point = (b: Rect): ChartShape => ({ box: b, kind: "point" });
const barShape = (b: Rect): ChartShape => ({ box: b, kind: "bar" });

/** A chart of these labels and shapes, its series counted as the content script does: one group per series given. */
function chartOf(labels: ChartLabel[], series: ChartShape[][]): Chart {
  const shapes = series.flat();
  const axes = chartAxes({ labels, shapes });
  const groups = axes ? series.filter((g) => g.some((s) => isMark(s.box, { labels, shapes }, axes))).length : 0;
  return { labels, shapes, series: groups };
}
/** describeMark on the shape at (series s, index i) of a chart chartAxes confirms. */
function readAt(labels: ChartLabel[], series: ChartShape[][], s: number, i: number, extra: Partial<ChartMark> = {}, omit?: string | null) {
  const chart = chartOf(labels, series);
  const axes = chartAxes(chart);
  assert.ok(axes, "a chart");
  const shape = series[s]![i]!;
  return describeMark({ ...shape, accessible: null, series: null, siblings: series[s]!.filter((o) => o !== shape).map((o) => o.box), ...extra }, chart, axes, omit);
}

// ---- Highcharts-like: "Venta neta" (charts-highcharts.html) ----
// The title "SMU" above the plot, a month per category along the bottom (E..D, 40 px apart from x = 80), the value axis
// on the left with only "0" (y = 260) and "1 000M" (y = 60), a marker per month, no data labels.
const MONTHS = ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const VENTA = [520, 610, 480, 700, 650, 590, 980, 760, 930, 880, 640, 710];
const lineY = (m: number) => 260 - m * 0.2;
const ventaLabels = (extra: ChartLabel[] = []) => [label("SMU", 300, 20), ...MONTHS.map((m, i) => label(m, 80 + i * 40, 276)), right("0", 50, 260), right("1 000M", 50, 60), ...extra];
const markers = () => VENTA.map((m, i) => point(box(76 + i * 40, lineY(m) - 4, 84 + i * 40, lineY(m) + 4)));
// A plot band across the plot, and February's tooltip box left on screen with its words in it.
const band = barShape(box(60, 200, 580, 240));
const tooltip = barShape(box(500, 190, 580, 224));
const tooltipWords = [left("F", 506, 200), left("SMU: 400 M", 506, 214)];

test("a line chart's point without a data label reads its series and category, and says no value is written (TIN-765)", () => {
  const r = readAt(ventaLabels(tooltipWords), [markers(), [band, tooltip]], 0, 8, {}, "Venta neta");
  assert.ok(r);
  assert.equal(r.text, `SMU · S ${NO_VALUE}`);
  assert.deepEqual([r.kind, r.series, r.category, r.value], ["point", "SMU", "S", null]);
  // The series that is the reading's heading already is not said twice.
  assert.equal(readAt(ventaLabels(), [markers()], 0, 8, {}, "SMU")!.text, `S ${NO_VALUE}`);
  assert.doesNotMatch(r.text, /≈|approximate|400/);
});

test("a value is only text written for the mark: its own accessible text, or a data label at it (TIN-765)", () => {
  assert.equal(readAt(ventaLabels(), [markers()], 0, 8, { accessible: "S, 931 012 340. SMU." })!.text, "S, 931 012 340. SMU.");
  assert.equal(readAt(ventaLabels(), [markers()], 0, 8, { accessible: "931 012 340" })!.text, "SMU · S · 931 012 340");
  // October's HTML label laid over its point.
  const october = label("880M", 440, lineY(880) - 2, 40);
  assert.equal(readAt(ventaLabels([october]), [markers()], 0, 9)!.text, "SMU · O · 880M");
  // A label far above the point is no one's.
  assert.equal(readAt(ventaLabels([label("880M", 440, lineY(880) - 60, 40)]), [markers()], 0, 9)!.text, `SMU · O ${NO_VALUE}`);
});

test("a plot band, a tooltip's box and anything outside the plot is no mark; they do not count as series (TIN-765)", () => {
  const labels = ventaLabels(tooltipWords);
  const chart = chartOf(labels, [markers(), [band], [tooltip]]);
  const axes = chartAxes(chart)!;
  assert.equal(chart.series, 1, "only the markers' group");
  assert.equal(coversPlot(band.box, axes), true);
  assert.equal(isMark(band.box, chart, axes), false);
  assert.equal(isMark(tooltip.box, chart, axes), false, "a box with words in it is a label's");
  assert.equal(describeMark({ ...tooltip, accessible: null, series: null, siblings: [] }, chart, axes), null);
  // A legend symbol under the month labels.
  assert.equal(isMark(box(220, 290, 232, 302), chart, axes), false);
});

// ---- Highcharts-like: "Instock promedio" ----
// Horizontal bars, the stores down the left (right-aligned at x = 100, 44 px apart), the value axis along the bottom
// (0% at x = 110 to 100% at x = 510), and a data label 5 px past each bar's end.
const STORES = [["CENCOSUD", 98.51], ["WALMART", 96.23], ["TOTTUS", 90.42], ["SMU", 87.67], ["Total General", 94.81]] as const;
const rowY = (i: number) => 40 + i * 44;
const end = (v: number) => 110 + v * 4;
const pct = (v: number) => `${v.toFixed(2).replace(".", ",")}%`;
const instockLabels = (dataLabels = true, values: ReadonlyArray<readonly [string, number]> = STORES) => [
  ...values.map(([name], i) => right(name, 100, rowY(i))),
  ...Array.from({ length: 11 }, (_, i) => label(`${i * 10}%`, 110 + i * 40, 280)),
  ...(dataLabels ? values.map(([, v], i) => left(pct(v), end(v) + 5, rowY(i))) : []),
];
const instockBars = (values: ReadonlyArray<readonly [string, number]> = STORES) => values.map(([, v], i) => barShape(box(110, rowY(i) - 12, end(v), rowY(i) + 12)));

test("a bar with a data label reads its category and that exact label (Instock: WALMART · 96,23%)", () => {
  const r = readAt(instockLabels(), [instockBars()], 0, 1, {}, "Instock promedio");
  assert.equal(r!.text, "WALMART · 96,23%");
  assert.equal(r!.kind, "bar");
  assert.equal(readAt(instockLabels(), [instockBars()], 0, 3)!.text, "SMU · 87,67%");
  assert.equal(readAt(instockLabels(), [instockBars()], 0, 4)!.text, "Total General · 94,81%");
  // Without data labels, no value.
  assert.equal(readAt(instockLabels(false), [instockBars()], 0, 3)!.text, `SMU ${NO_VALUE}`);
  // A short bar takes the label just past its end.
  const small = [["CENCOSUD", 98.51], ["WALMART", 96.23], ["TOTTUS", 90.42], ["SMU", 8], ["Total General", 94.81]] as const;
  assert.equal(readAt(instockLabels(true, small), [instockBars(small)], 0, 3)!.text, "SMU · 8,00%");
});

// ---- Highcharts-like: "Precios", two value axes ----
// Columns of sales on a left axis (0 to 320M, right-aligned at x = 60) and a line of prices on a right axis (3.6k to
// 4.4k, left-aligned at x = 540), months along the bottom (76 px apart from x = 110), a legend under them.
const P_MONTHS = ["Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const SALES = [210, 240, 180, 260, 300, 230];
const PRICES = [3.9, 4.12, 4.0, 4.3, 4.2, 4.05];
const pX = (i: number) => 110 + i * 76;
const comboLabels = [
  label("Ventas y precio", 300, 20),
  ...P_MONTHS.map((m, i) => label(m, pX(i), 268)),
  ...["0", "80M", "160M", "240M", "320M"].map((t, i) => right(t, 60, 250 - i * 50)),
  ...["3.6k", "3.8k", "4.0k", "4.2k", "4.4k"].map((t, i) => left(t, 540, 250 - i * 50)),
  left("Venta", 238, 296),
  left("Precio", 332, 296),
];
const columns = SALES.map((v, i) => barShape(box(pX(i) - 15, 250 - (v / 320) * 200, pX(i) + 15, 250)));
const prices = PRICES.map((p, i) => point(box(pX(i) - 4, 250 - ((p - 3.6) / 0.8) * 200 - 4, pX(i) + 4, 250 - ((p - 3.6) / 0.8) * 200 + 4)));
const legendSymbols = [barShape(box(220, 290, 232, 302)), point(box(314, 292, 322, 300))];

test("on a chart with two value axes, a bar or a point reads its category and no value, never one off an axis (Datamind's prices)", () => {
  const series = [columns, prices, legendSymbols];
  const ago = readAt(comboLabels, series, 0, 1, {}, "Precios");
  assert.equal(ago!.text, `Ago ${NO_VALUE}`);
  assert.equal(ago!.kind, "bar");
  assert.doesNotMatch(ago!.text, /4[.,]12k|≈/);
  assert.equal(readAt(comboLabels, series, 1, 2, {}, "Precios")!.text, `Sep ${NO_VALUE}`);
  // The right axis's numbers are an axis, not data labels; two series: the title names neither.
  const chart = chartOf(comboLabels, series);
  const axes = chartAxes(chart)!;
  assert.equal(axes.vertical, true);
  assert.deepEqual(axes.dataLabels, []);
  assert.equal(chart.series, 2);
  // The legend's symbols, under the months, are no marks.
  for (const s of legendSymbols) assert.equal(isMark(s.box, chart, axes), false);
});

// ---- ECharts-like (charts-libraries.html) ----
// Ticks 0..250 up the left (right-aligned at x = 52, 40 px per 50), days along the bottom, a data label 9 px above each
// bar, the title "Visits" at the top left.
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const VISITS = [120, 200, 150, 80, 70, 110, 130];
const eX = (i: number) => 60 + ((i + 0.5) * 500) / 7;
const eY = (v: number) => 260 - v * 0.8;
const echartsLabels = [left("Visits", 5, 16), ...[0, 50, 100, 150, 200, 250].map((v) => right(String(v), 52, eY(v))), ...DAYS.map((d, i) => label(d, eX(i), 272)), ...VISITS.map((v, i) => label(String(v), eX(i), eY(v) - 9))];
const echartsBars = VISITS.map((v, i) => barShape(box(eX(i) - 20, eY(v), eX(i) + 20, 260)));

test("an ECharts-like chart: the title above names its one series, the data label above the bar is its value", () => {
  assert.equal(readAt(echartsLabels, [echartsBars], 0, 2, {}, "Site traffic")!.text, "Visits · Wed · 150");
});

// ---- D3 (charts-libraries.html) ----
// Ticks 0%..12% up the left (right-aligned at x = 31), letters along the bottom, no data labels, C with a <title>.
const LETTERS = [["A", 8.17], ["B", 1.49], ["C", 2.78], ["D", 4.25], ["E", 11.2], ["F", 2.23]] as const;
const step = 440 / 6;
const dY = (v: number) => 20 + 250 - (v / 12) * 250;
const d3Labels = [...[0, 2, 4, 6, 8, 10, 12].map((v) => right(`${v}%`, 31, dY(v))), ...LETTERS.map(([l], i) => label(l, 40 + step * (i + 0.5), 280)), { text: "Frequency", box: box(46, 20, 58, 80) }];
const d3Bars = LETTERS.map(([, v], i) => barShape(box(40 + step * i + 4, dY(v), 40 + step * (i + 1) - 4, 270)));

test("a D3 chart with no data labels: the category and no value; a bar's own <title> is its value", () => {
  assert.equal(readAt(d3Labels, [d3Bars], 0, 1, {}, "Letter frequency")!.text, `B ${NO_VALUE}`);
  assert.equal(readAt(d3Labels, [d3Bars], 0, 2, { accessible: "C: 2.78%" }, "Letter frequency")!.text, "C: 2.78%");
});

// ---- Recharts-like (charts-libraries.html) ----
// Two bar series side by side (pv left, uv right of each page's centre), pv with a label on top of each bar, uv with
// none; ticks 0..10000 up the left; an HTML legend "pv" "uv" over the drawing's bottom.
const PAGES = ["Page A", "Page B", "Page C", "Page D", "Page E", "Page F"];
const PV = [2400, 1398, 9800, 3908, 4800, 3500];
const UV = [4000, 3000, 2000, 2780, 1890, 2390];
const rcX = (i: number) => 65 + (430 / 6) * (i + 0.5);
const rcY = (v: number) => 235 - (v / 10000) * 230;
const rechartsLabels = [
  ...[0, 2500, 5000, 7500, 10000].map((v) => right(String(v), 57, rcY(v))),
  ...PAGES.map((p, i) => label(p, rcX(i), 249)),
  ...PV.map((v, i) => label(String(v), rcX(i) - 15, rcY(v) - 10)),
  label("pv", 240, 288),
  label("uv", 270, 288),
];
const pv = PV.map((v, i) => barShape(box(rcX(i) - 28, rcY(v), rcX(i) - 2, 235)));
const uv = UV.map((v, i) => barShape(box(rcX(i) + 2, rcY(v), rcX(i) + 28, 235)));

test("a Recharts-like chart: a label is the value of the bar it is drawn at, never of the bar beside it", () => {
  assert.equal(readAt(rechartsLabels, [pv, uv], 0, 1, {}, "Page views")!.text, "Page B · 1398");
  assert.equal(readAt(rechartsLabels, [pv, uv], 1, 1, {}, "Page views")!.text, `Page B ${NO_VALUE}`);
  assert.equal(readAt(rechartsLabels, [pv, uv], 1, 2)!.text, `Page C ${NO_VALUE}`);
});

test("a series is named only as the page declares it: its group's name, or the single title of a chart of one series", () => {
  assert.equal(readAt(rechartsLabels, [pv, uv], 0, 1, { series: "Page views (pv)" })!.text, "Page views (pv) · Page B · 1398");
  // A title and a subtitle: neither is taken.
  const two = [...echartsLabels, left("Last week", 5, 34)];
  assert.equal(readAt(two, [echartsBars], 0, 2)!.text, "Wed · 150");
});

test("a data label as near to two marks is neither's; a category label nearer another mark of the series is not this one's", () => {
  // Two series' points on the same month, a label centred between them.
  const a = point(box(396, 96, 404, 104));
  const b = point(box(396, 136, 404, 144));
  const labels = [...MONTHS.map((m, i) => label(m, 80 + i * 40, 276)), right("0", 50, 260), right("1 000M", 50, 60), label("500M", 400, 120, 32)];
  assert.equal(readAt(labels, [[a], [b]], 0, 0)!.text, `S ${NO_VALUE}`);
  // Daily points under monthly labels: only the day at a label takes it.
  const days = Array.from({ length: 31 }, (_, d) => point(box(80 + d * (40 / 31) * 1 - 2, 158, 80 + d * (40 / 31) + 2, 162)));
  assert.equal(readAt(labels.slice(0, -1), [days], 0, 0)!.text, `E ${NO_VALUE}`);
  assert.equal(readAt(labels.slice(0, -1), [days], 0, 10), null, "neither a category nor a value");
});

test("a drawing is a chart only with a value axis and a category axis or data labels", () => {
  // A step indicator "1" "2", a calendar badge "15" over "2024", a pie or an icon with no labels: no chart, so no mark.
  assert.equal(chartAxes({ labels: [label("1", 100, 20), label("2", 200, 20)], shapes: [] }), null);
  assert.equal(chartAxes({ labels: [label("15", 100, 20), label("2024", 100, 40)], shapes: [] }), null);
  assert.equal(chartAxes({ labels: [], shapes: [] }), null);
  assert.equal(chartAxes({ labels: [label("Sales", 100, 20)], shapes: [] }), null);
  // A value axis and data labels: a chart.
  assert.ok(chartAxes({ labels: [right("0", 40, 230), right("100", 40, 30), label("42", 200, 140)], shapes: [] }));
});

test("years along the bottom are the categories, not a value axis: the shapes line up with them", () => {
  const years = ["2019", "2020", "2021", "2022", "2023"];
  const labels = [...years.map((y, i) => label(y, 100 + i * 80, 276)), ...["0", "500", "1000", "1500"].map((t, i) => right(t, 50, 260 - i * 60))];
  const cols = years.map((_, i) => barShape(box(85 + i * 80, 120 + i * 10, 115 + i * 80, 260)));
  const axes = chartAxes({ labels, shapes: cols })!;
  assert.equal(axes.vertical, true);
  assert.equal(readAt(labels, [cols], 0, 2)!.text, `2021 ${NO_VALUE}`);
});

// ---- shapes that name themselves (charts-other.html) ----

test("a pie's slice or a map's region that names itself is a mark, read from that name only; unnamed ones are not", () => {
  const pie = ["CENCOSUD: 38%", "WALMART: 27%", "TOTTUS: 20%", "SMU: 15%"];
  assert.deepEqual(describeNamed("CENCOSUD: 38%", pie), { kind: "mark", series: null, category: null, value: "CENCOSUD: 38%", text: "CENCOSUD: 38%" });
  assert.equal(describeNamed("Valparaíso: 1.9M", ["Valparaíso: 1.9M", "Santiago: 7.1M"])!.text, "Valparaíso: 1.9M");
  // Without names, or an icon's single <title>: no mark.
  assert.equal(describeNamed(null, []), null);
  assert.equal(describeNamed("Close", ["Close"]), null);
  assert.equal(describeNamed("Star", ["Star", "Star"]), null);
});

// ---- numbers and labels ----

// ---- fix round 1 (reviews on #145): who owns a data label (rule A), what is a mark (rule B) ----
// A small vertical chart: ticks "0", "100", "200" up the left (y = 250, 150, 50), "Jan" and "Feb" along the bottom
// (x = 120 and 220).
const small = (extra: ChartLabel[] = []) => [right("0", 50, 250), right("100", 50, 150), right("200", 50, 50), label("Jan", 120, 280), label("Feb", 220, 280), ...extra];
const feb = barShape(box(200, 150, 240, 250));

test("a number between a column and a point of another series is nobody's value (rule A; Grok #1 P1, Gemini P1)", () => {
  // Grok: column x 100-140 from y 100, "42" 16 px above it, a point of the price series in that gap.
  const column = barShape(box(100, 100, 140, 250));
  const price = point(box(116, 86, 124, 94));
  const labels = small([label("42", 120, 78, 16)]);
  assert.equal(readAt(labels, [[column, feb], [price]], 0, 0)!.text, `Jan ${NO_VALUE}`);
  assert.equal(readAt(labels, [[column, feb], [price]], 1, 0)!.text, `Jan ${NO_VALUE}`);
  // Gemini: "4.2k" drawn just above a price point that stands in front of a column, inside the column's top.
  const sales = barShape(box(95, 100, 125, 250));
  const pricePoint = point(box(106, 120, 114, 128));
  const gemini = [right("0", 50, 250), right("100", 50, 150), right("200", 50, 50), label("Jan", 110, 280), label("Feb", 220, 280), { text: "4.2k", box: box(105, 104, 125, 116) }];
  assert.equal(readAt(gemini, [[sales, feb], [pricePoint]], 0, 0)!.text, `Jan ${NO_VALUE}`);
  assert.equal(readAt(gemini, [[sales, feb], [pricePoint]], 1, 0)!.text, `Jan ${NO_VALUE}`);
});

test("on the combo with labels on both series, a column's own label is its value; a price label on the column is nobody's (rule A)", () => {
  // "Precios con etiquetas": Ago's column (x 171-201, top 62.5) with "300M" above it, its price point inside the column
  // (y 208.5-216.5) with "3.75k" just above the point, on the column.
  const column = barShape(box(171, 62.5, 201, 250));
  const pricePoint = point(box(182, 208.5, 190, 216.5));
  const labels = [right("0", 60, 250), right("160M", 60, 150), right("320M", 60, 50), label("Jul", 110, 268), label("Ago", 186, 268), label("300M", 186, 52.5, 24), label("3.75k", 186, 200.5, 30)];
  const jul = barShape(box(95, 75, 125, 250));
  assert.equal(readAt(labels, [[jul, column], [pricePoint]], 0, 1)!.text, "Ago · 300M");
  assert.equal(readAt(labels, [[jul, column], [pricePoint]], 1, 0)!.text, `Ago ${NO_VALUE}`);
});

test("a label in the gutter of grouped bars is nobody's; one centred on a bar is that bar's (rule A; Grok #1 P1)", () => {
  const a = barShape(box(100, 100, 118, 250));
  const b = barShape(box(122, 150, 140, 250));
  const gutter = small([label("10", 120, 140, 16)]);
  assert.equal(readAt(gutter, [[a, feb], [b]], 0, 0)!.text, `Jan ${NO_VALUE}`);
  assert.equal(readAt(gutter, [[a, feb], [b]], 1, 0)!.text, `Jan ${NO_VALUE}`);
  const onB = small([label("10", 131, 140, 16)]);
  assert.equal(readAt(onB, [[a, feb], [b]], 1, 0)!.text, "Jan · 10");
  assert.equal(readAt(onB, [[a, feb], [b]], 0, 0)!.text, `Jan ${NO_VALUE}`);
});

test("a stack's segments keep the labels inside them; its total above is no segment's value (rule A; Grok #1 P1)", () => {
  const bottom = barShape(box(100, 170, 140, 250));
  const top = barShape(box(100, 100, 140, 170));
  const labels = small([label("70", 120, 135, 16), label("80", 120, 210, 16), label("150", 120, 88, 24)]);
  const series = [[bottom, feb], [top]];
  assert.equal(readAt(labels, series, 1, 0)!.text, "Jan · 70");
  assert.equal(readAt(labels, series, 0, 0)!.text, "Jan · 80");
  const chart = chartOf(labels, series);
  assert.equal(ownerOf(labels.find((l) => l.text === "150")!, series.flat(), chartAxes(chart)!), null);
});

test("a number in a tooltip's box, beside its words, is never a value (rule A; Grok #3 P1)", () => {
  // February's marker (x 116-124) with a stale tooltip over it whose "F" and "400" are texts of their own.
  const box400 = barShape(box(104, 98, 170, 128));
  const words = [left("F", 114, 108), label("400", 120, 120, 24)];
  assert.equal(readAt(ventaLabels(words), [markers(), [box400]], 0, 1)!.text, `SMU · F ${NO_VALUE}`);
});

test("a number above the plot (a year as the title) is never a value (rule A; Gemini P2)", () => {
  // A bar just over the top tick, with "2026" written above the plot, 22 px over the bar's top.
  const tall = barShape(box(100, 48, 140, 250));
  const labels = small([label("2026", 120, 20, 32)]);
  assert.equal(readAt(labels, [[tall, feb]], 0, 0)!.text, `Jan ${NO_VALUE}`);
});

test("a shape only in the plot's margin, or holding other shapes, is no mark and takes no label (rule B; Grok #2 P1)", () => {
  // Grok: a strip at y 252-268 under Jan (below the "0" tick at 250), holding the label "9".
  const strip = barShape(box(100, 252, 140, 268));
  const column = barShape(box(100, 150, 140, 250));
  const labels = small([label("9", 120, 258, 8)]);
  const series = [[column, feb], [strip]];
  const chart = chartOf(labels, series);
  const axes = chartAxes(chart)!;
  assert.equal(isMark(strip.box, chart, axes), false);
  assert.equal(readAt(labels, series, 1, 0), null);
  assert.equal(readAt(labels, series, 0, 0)!.text, "Jan · 9");
  // A plot-sized rect (two categories, so coversPlot does not apply) holding both columns: no mark, and "7" over Feb is Feb's.
  const plotRect = barShape(box(60, 40, 260, 250));
  const withRect = small([label("7", 220, 140, 8)]);
  const rectSeries = [[column, feb], [plotRect]];
  assert.equal(isMark(plotRect.box, chartOf(withRect, rectSeries), chartAxes(chartOf(withRect, rectSeries))!), false);
  assert.equal(readAt(withRect, rectSeries, 1, 0), null);
  assert.equal(readAt(withRect, rectSeries, 0, 1)!.text, "Feb · 7");
  // A bar drawn a little past the last tick is still a mark.
  assert.equal(isMark(box(150, 44, 190, 250), chart, axes), true);
});

// ---- fix round 2 (fix checks on #145): the inputs of Grok's and Gemini's reports, one test each ----

test("Grok fix1 #1: a stack segment of any height keeps the label written on it (Chrome's boxes from the corpus)", () => {
  const dy = 100 - 232;
  const dx = 120 - 428;
  const live = (b: Rect) => box(b.left + dx, b.top + dy, b.right + dx, b.bottom + dy);
  const store2 = barShape(live(box(428, 232, 488, 282)));
  const online2 = barShape(live(box(428, 282, 488, 382)));
  const store1 = barShape(live(box(278, 242, 338, 322)));
  const online1 = barShape(live(box(278, 322, 338, 382)));
  const t50 = { text: "50", box: live(box(451.88, 249.86, 464.13, 261.86)) };
  const t60 = { text: "60", box: live(box(301.88, 344.86, 314.13, 356.86)) };
  const ticks = [0, 50, 100, 150, 200].map((v, i) => right(String(v), 40, 250 - i * 40));
  const labels = [...ticks, label("Q2", cx(store1.box), 280), label("Q3", cx(store2.box), 280), t50, t60];
  const series = [[online2, online1], [store2, store1]];
  assert.equal(readAt(labels, series, 1, 0)!.text, "Q3 · 50");
  assert.equal(readAt(labels, series, 0, 1)!.text, "Q2 · 60");
});

test("Grok fix1 #2: a second number the column could own does not erase its own", () => {
  // The corpus's Ago column with the price point 4 px left: the price label is the point's rival's, nobody's.
  const ago = barShape(box(171, 62.5, 201, 250));
  const jul = barShape(box(95, 75, 125, 250));
  const shifted = point(box(178, 208.5, 186, 216.5));
  const precio = [right("0", 60, 250), right("160M", 60, 150), right("320M", 60, 50), label("Jul", 110, 268), label("Ago", 186, 268), label("300M", 186, 52.5, 24), label("3.75k", 186, 200.5, 30)];
  assert.equal(readAt(precio, [[jul, ago], [shifted]], 0, 1)!.text, "Ago · 300M");
  assert.equal(readAt(precio, [[jul, ago], [shifted]], 1, 0)!.text, `Ago ${NO_VALUE}`);
  // Two numbers above one bar: a mark that owns two numbers reads no value (round 3).
  assert.equal(readAt(small([label("42", 120, 88, 16), label("7", 120, 70, 12)]), [[barShape(box(100, 100, 140, 250)), feb]], 0, 0)!.text, `Jan ${NO_VALUE}`);
});

test("Grok fix1 #3, Gemini fix1 P2: a column holding points is a mark; a rect around a bar or a 1 px strip is not", () => {
  const column = barShape(box(100, 80, 140, 250));
  const inner = [point(box(116, 120, 124, 128)), point(box(116, 160, 124, 168))];
  assert.equal(readAt(small([label("42", 120, 68, 16)]), [[column, feb], inner], 0, 0)!.text, "Jan · 42");
  // A background around the January column only.
  const jan = barShape(box(100, 100, 140, 250));
  const bg = barShape(box(80, 40, 160, 250));
  const bgLabels = small([label("42", 120, 88, 16)]);
  assert.equal(readAt(bgLabels, [[bg], [jan, feb]], 0, 0), null);
  assert.equal(readAt(bgLabels, [[bg], [jan, feb]], 1, 0)!.text, "Jan · 42");
  // Gemini: a plot rect with one column in it.
  const gem = [right("0", 50, 250), right("100", 50, 150), right("200", 50, 50), label("Jan", 120, 280), label("Feb", 220, 280), label("100", 120, 90, 24)];
  assert.equal(readAt(gem, [[barShape(box(80, 50, 240, 250))], [jan]], 0, 0), null);
  assert.equal(readAt(gem, [[barShape(box(80, 50, 240, 250))], [jan]], 1, 0)!.text, "Jan · 100");
  // A strip crossing the 0 tick by 1 px is no mark; the column keeps "9".
  const strip = barShape(box(100, 249, 140, 265));
  const col = barShape(box(100, 150, 140, 250));
  const stripLabels = small([label("9", 120, 256, 8)]);
  assert.equal(readAt(stripLabels, [[col, feb], [strip]], 1, 0), null);
  assert.equal(readAt(stripLabels, [[col, feb], [strip]], 0, 0)!.text, "Jan · 9");
});

test("Grok fix1 #4: a tick a bar is drawn over leaves the value axis an axis, and never becomes a value", () => {
  const under = barShape(box(40, 100, 140, 250));
  const l1 = [right("0", 50, 250), right("100", 50, 150), right("200", 50, 50), label("Jan", 120, 280), label("Feb", 220, 280), label("42", 120, 88, 16)];
  assert.deepEqual(chartAxes({ labels: l1, shapes: [under, feb] })!.valueAxis.map((l) => l.text), ["0", "100", "200"]);
  assert.equal(readAt(l1, [[under, feb]], 0, 0)!.text, "Jan · 42");
  // Every tick drawn over a bar (one out of line, inside it): no axis can be told, so no chart and no mark; a tick is
  // never taken for the bar's value.
  const wide = barShape(box(20, 80, 140, 250));
  const other = barShape(box(180, 150, 230, 250));
  const l2 = [right("0", 40, 250), right("100", 80, 150), right("200", 40, 50), label("Jan", 80, 280), label("Feb", 205, 280), label("42", 80, 68, 16)];
  assert.equal(chartAxes({ labels: l2, shapes: [wide, other] }), null);
  // A tick overlapping a bar by 2 px, with a second axis.
  const by2 = barShape(box(48, 100, 140, 250));
  const l3 = [right("0", 50, 250), right("100", 50, 150), right("200", 50, 50), left("0", 300, 250), left("5", 300, 150), left("10", 300, 50), label("Jan", 120, 280), label("Feb", 220, 280), label("42", 120, 88, 16)];
  assert.equal(readAt(l3, [[by2, feb]], 0, 0)!.text, "Jan · 42");
});

test("Grok fix1 #7, Gemini fix1 P1: a number above the top tick is never a value, even just above a bar at that tick", () => {
  // These are the same drawing as a year as the title in the plot's margin (below): constraint 1 wins, no value.
  const atTick = barShape(box(100, 50, 140, 250));
  assert.equal(readAt(small([label("42", 120, 28, 16)]), [[atTick, feb]], 0, 0)!.text, `Jan ${NO_VALUE}`);
  const gemCol = barShape(box(100, 100, 140, 200));
  const gemTicks = [right("0", 50, 200), right("50", 50, 150), right("100", 50, 100), label("Jan", 120, 230), label("Feb", 220, 230)];
  assert.equal(readAt([...gemTicks, label("100", 120, 84, 24)], [[gemCol, barShape(box(200, 150, 240, 200))]], 0, 0)!.text, `Jan ${NO_VALUE}`);
  // A label above a bar below the top tick still reads.
  assert.equal(readAt(small([label("42", 120, 88, 16)]), [[barShape(box(100, 100, 140, 250)), feb]], 0, 0)!.text, "Jan · 42");
});

test("Gemini P2 (round 0), still open: a year as the title in the plot's margin is never a value", () => {
  const atTick = barShape(box(100, 50, 140, 250));
  assert.equal(readAt(small([label("2026", 120, 30, 32)]), [[atTick, feb]], 0, 0)!.text, `Jan ${NO_VALUE}`);
  assert.equal(readAt(small([label("2026", 120, 36, 32)]), [[atTick, feb]], 0, 0)!.text, `Jan ${NO_VALUE}`);
});

test("Grok #3 (round 0), still open: a tooltip's number is never a value, its box or not", () => {
  // The number hangs 2 px below the tooltip's box, which holds "F".
  const tip = barShape(box(104, 110, 160, 140));
  assert.equal(readAt(ventaLabels([left("F", 112, 122), label("400", 120, 138, 24)]), [markers(), [tip]], 0, 1)!.text, `SMU · F ${NO_VALUE}`);
  const tipB = barShape(box(100, 120, 170, 150));
  assert.equal(readAt(ventaLabels([left("F", 110, 132), { text: "400", box: box(108, 144, 140, 160) }]), [markers(), [tipB]], 0, 1)!.text, `SMU · F ${NO_VALUE}`);
  // An HTML tooltip, no shape at all: "F" over "400".
  assert.equal(readAt(ventaLabels([left("F", 112, 122), label("400", 120, 138, 24)]), [markers()], 0, 1)!.text, `SMU · F ${NO_VALUE}`);
  // Its word sticks 2 px out of the box.
  const tipC = barShape(box(104, 98, 170, 128));
  // (That box then counts as a shape of its own, a second group, so the title no longer names the series: left out.)
  assert.equal(readAt(ventaLabels([{ text: "F", box: box(110, 90, 122, 106) }, label("400", 120, 118, 24)]), [markers(), [tipC]], 0, 1)!.text, `F ${NO_VALUE}`);
  // A box with only a number in it, over February: the point is in reach of a number on a bar, so it is nobody's.
  assert.equal(readAt(ventaLabels([label("400", 120, 112, 24)]), [markers(), [tipC]], 0, 1)!.text, `F ${NO_VALUE}`);
});

test("Gemini P1 variant: a price label on a column, its point off the label's centre, is nobody's", () => {
  const ago = barShape(box(171, 62.5, 201, 250));
  const jul = barShape(box(95, 75, 125, 250));
  const shifted = point(box(177, 208.5, 185, 216.5));
  const labels = [right("0", 60, 250), right("160M", 60, 150), right("320M", 60, 50), label("Jul", 110, 268), label("Ago", 186, 268), label("3.75k", 186, 200.5, 30)];
  assert.equal(readAt(labels, [[jul, ago], [shifted]], 0, 1)!.text, `Ago ${NO_VALUE}`);
  assert.equal(readAt(labels, [[jul, ago], [shifted]], 1, 0)!.text, `Ago ${NO_VALUE}`);
  // Grok's probe: a point at the column's edge, 6 px left of a number above the column.
  const wide = barShape(box(100, 100, 180, 250));
  const edge = point(box(102, 88, 110, 96));
  assert.equal(readAt(small([label("4.2k", 130, 86, 28)]), [[wide], [edge]], 0, 0)!.text, `Jan ${NO_VALUE}`);
});

// ---- round 3 (Grok's fix check on round 2): removed capability, each with Grok's input ----

test("Grok fix2 A: a mark that owns two numbers reads no value, never the other one", () => {
  const col = barShape(box(100, 100, 140, 250));
  const pt = point(box(112, 150, 120, 158));
  const near = small([label("300M", 120, 84, 32), label("3.75k", 120, 108, 36)]);
  assert.equal(readAt(near, [[col, feb], [pt]], 0, 0)!.text, `Jan ${NO_VALUE}`);
  assert.equal(readAt(near, [[col, feb], [pt]], 1, 0)!.text, `Jan ${NO_VALUE}`);
  const far = small([label("300M", 120, 70, 32), label("3.75k", 120, 112, 36)]);
  assert.equal(readAt(far, [[col, feb], [point(box(112, 160, 120, 168))]], 0, 0)!.text, `Jan ${NO_VALUE}`);
  // A "9" on a wide bar beside its axis, "42" above it.
  const wide = barShape(box(50, 80, 160, 250));
  const leaked = [right("0", 40, 250), right("100", 40, 150), right("200", 40, 50), label("9", 90, 240, 12), label("Jan", 100, 280), label("Feb", 220, 280), label("42", 100, 68, 16)];
  assert.doesNotMatch(readAt(leaked, [[wide, feb]], 0, 0)?.text ?? "", /· 9$/);
});

test("Grok fix2 B: a rect that holds shapes of two categories is no mark, and takes no point's label", () => {
  const p0 = point(box(116, 140, 124, 148));
  const p1 = point(box(216, 160, 224, 168));
  const back = barShape(box(80, 60, 260, 240));
  const lineL = small([label("42", 120, 128, 16), label("7", 220, 148, 12)]);
  const chart = chartOf(lineL, [[p0, p1], [back]]);
  assert.equal(isMark(back.box, chart, chartAxes(chart)!), false);
  assert.equal(readAt(lineL, [[p0, p1], [back]], 0, 0)!.text, "Jan · 42");
  // A rect behind February and March of the twelve-month line.
  const band2 = barShape(box(100, 40, 180, 270));
  assert.equal(readAt(ventaLabels([label("610", 120, lineY(610) - 10, 24)]), [markers(), [band2]], 0, 1)!.text, "SMU · F · 610");
  assert.equal(readAt(ventaLabels([label("880M", 440, lineY(880) - 2, 40)]), [markers(), [band2]], 0, 9)!.text, "SMU · O · 880M");
  // A column holding two points of its own category stays a mark (Grok fix1 #3).
  const column = barShape(box(100, 80, 140, 250));
  assert.equal(readAt(small([label("42", 120, 68, 16)]), [[column, feb], [point(box(116, 120, 124, 128)), point(box(116, 160, 124, 168))]], 0, 0)!.text, "Jan · 42");
});

test("Grok fix2 C: on a horizontal chart a point's reach runs across the rows, not the columns", () => {
  const hTicks = [0, 50, 100].map((v, i) => label(String(v), 40 + i * 80, 200));
  const hCats = [label("A", 20, 80), label("B", 20, 140)];
  const hBar = barShape(box(40, 68, 180, 92));
  const hBar2 = barShape(box(40, 128, 120, 152));
  const hPoint = point(box(164, 74, 172, 82));
  const hLabels = [...hTicks, ...hCats, label("42", 180, 52, 16)];
  assert.equal(readAt(hLabels, [[hBar, hBar2], [hPoint]], 0, 0)!.text, `A ${NO_VALUE}`);
  assert.equal(readAt(hLabels, [[hBar, hBar2], [hPoint]], 1, 0)!.text, `A ${NO_VALUE}`);
  // A label at the end of the bar, on its row, still reads (Instock's way).
  assert.equal(readAt([...hTicks, ...hCats, left("42", 186, 80)], [[hBar, hBar2]], 0, 0)!.text, "A · 42");
});

test("numbers as charts write them tell an axis's ticks and data labels from other text", () => {
  for (const [t, v] of [["1 000M", 1e9], ["1 000M", 1e9], ["8G", 8e9], ["12MM", 12e6], ["3k", 3000], ["0", 0], ["90%", 90], ["98,51%", 98.51], ["1,5", 1.5], ["0.25", 0.25], ["1.000", 1000], ["1,000", 1000], ["1.000.000", 1e6], ["1.234,5", 1234.5], ["$1,200", 1200], ["US$ 5", 5], ["-5", -5], ["−5", -5], ["4.0k", 4000]] as const) assert.equal(parseNumber(t), v, t);
  for (const t of ["SMU", "Q1", "E", "Total General", "1.2.3", "1 00M", "SMU: 400 M", "Page B", ""]) assert.equal(parseNumber(t), null, t);
});

test("a label drawn twice, its halo under it, is read once; a real label never dropped (by paint and place, not class)", () => {
  const at = box(10, 14, 50, 26);
  const t = (text: string, b: Rect, paint: "fill" | "halo" | "both" = "fill"): SvgText => ({ text, box: b, stroked: paint !== "fill", strokeOnly: paint === "halo" });
  const realLabel = t("98,51%", at);
  const halo = t("98,51%", at, "halo");
  assert.equal(isOutlineCopy(halo, [halo, realLabel]), true);
  assert.equal(isOutlineCopy(realLabel, [halo, realLabel]), false);
  // A filled label with a stroke too (ECharts' data labels with a border) is a label, not a halo.
  assert.equal(isOutlineCopy(t("98,51%", at, "both"), [realLabel]), false);
  // A halo elsewhere, or with no twin, is kept.
  assert.equal(isOutlineCopy(halo, [halo, t("98,51%", box(10, 54, 50, 66))]), false);
  assert.equal(isOutlineCopy(halo, [halo]), false);
  // A 3 px halo: its box is 1.5 px wider on each side than its twin's, its centre the same (rule D; Gemini P2).
  const wide = t("98,51%", box(8.5, 12.5, 51.5, 27.5), "halo");
  assert.equal(isOutlineCopy(wide, [wide, realLabel]), true);
});

test("the extension's source knows no chart library and estimates no value (TIN-765)", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /highcharts|echarts|recharts|chart\.js/i, file);
    assert.doesNotMatch(source, /≈|approximate|interpolate/i, file);
  }
  const content = readFileSync(new URL("../src/content.ts", import.meta.url), "utf8");
  // One analysis per drawing per drag, forgotten with the scope.
  assert.match(content, /const known = charts\.get\(svg\);\s*if \(known\) return known;/);
  assert.match(content, /function forgetScopes\(\): void \{\s*scopeCache = null;\s*charts\.clear\(\);/);
  // An aborted drag sends neither drop nor dragend: the outline goes after OUTLINE_IDLE_MS without a dragover.
  assert.match(content, /idleTimer = window\.setTimeout\(\(\) => \{\s*light\(null\);\s*forgetScopes\(\);\s*\}, OUTLINE_IDLE_MS\);/);
  // The box is drawn in a closed shadow root of the extension's host.
  assert.match(content, /host\.dataset\.apcOutline = "";[\s\S]{0,400}host\.attachShadow\(\{ mode: "closed" \}\)/);
  // A mark the chart no longer describes at the drop sends element: null, so the dock says the page.
  assert.match(content, /: scope && !shape\s*\?/);
  // Rule C: every text a chart reading uses goes through chartText (readable's walk, cut to the drawing, no control),
  // aria-labelledby targets too; markAt passes only through what the drawing's holder lays over it.
  assert.match(content, /function chartText\(e: Element, drawn: Rect\): string \{\s*if \(inControl\(e, document\.documentElement\) \|\| !within\(boxOf\(e\), drawn\)\) return "";[\s\S]{0,900}?const cut = clipCut\(at\);\s*if \(cut === "hide"\) return "";[\s\S]{0,200}?return readable\(e, LABEL_MAX, bound\)/);
  assert.match(content, /\.filter\(\(t\): t is Element => !!t && scope\.contains\(t\)\)\.map\(\(t\) => chartText\(t, drawn\)\)/);
  assert.match(content, /if \(!holder\?\.contains\(e\) \|\| inControl\(e, document\.documentElement\) \|\| !within\(boxOf\(e\), drawn\)\) return null;/);
  // A clip path whose <clipPath> is missing hides; a complex one hides SVG only; HTML text is otherwise read (fix round 2).
  // Round 3 (Grok fix2 D): a clip path that is missing or more than one rect hides what it clips, SVG or HTML.
  assert.ok(content.includes('return clip === "missing" || clip === "complex" ? "hide" : clip;'), "clipCut");
  // Round 3 (Grok fix2 F): stroke-opacity and fill-opacity count in a text's paint.
  assert.ok(content.includes("alpha(style.stroke) * Number(style.strokeOpacity) >= OPACITY_MIN"), "stroke-opacity");
  assert.ok(content.includes("alpha(style.fill) * Number(style.fillOpacity) < OPACITY_MIN"), "fill-opacity");
  assert.match(content, /const cut = clipCut\(e\);\s*if \(cut === "hide"\) return;/);
  // SVG fill: none is no ink, unless a stroke paints the glyphs.
  assert.ok(content.includes('style.fill === "none" ? paintOf(e).stroked'), "fill none");
  assert.doesNotMatch(content, /labelSeen|textContent \?\? ""\)\.replace/);
  // No class name is read for a chart: no classList, no class attribute.
  const section = content.slice(content.indexOf("// ---- chart marks"), content.indexOf("/** Whether the person can see this element."));
  assert.doesNotMatch(section, /classList|getAttribute\("class"\)|className/);
});
