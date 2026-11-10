/**
 * A drop on a chart's mark (TIN-760, TIN-765, DESIGN.md 13.2): a point of a line chart, a bar, or a shape that names
 * itself (a pie's slice, a map's region), drawn in SVG. The content script finds the drawing's labels and shapes (with
 * their boxes); this file decides whether the drawing is a chart (chartAxes: a value axis, and a category axis or
 * data labels), which shapes are its marks (in the plot the axes bound), and says what the person sees at a mark: its
 * series, its category and its value. Typed by what it touches rather than by the DOM, so the tests run it on plain
 * objects, as read.ts does.
 *
 * It reads only what the page declares, never what has to be guessed. A value is text written on the page for that
 * mark: its own accessible text (aria-label, <title>, <desc>), or a data label drawn at it that no other mark is
 * nearer to. Nothing is read from where a mark is drawn against an axis, and nothing from a tooltip (an HTML5 drag
 * does not move the chart's hover, so a tooltip on screen is about another point). With no value written, the
 * reading says so. Nothing here knows a chart library: no class name is read.
 */
import { within, type Rect } from "./read.ts";

/** A label the drawing shows: an SVG <text>, or HTML text laid over the drawing. */
export interface ChartLabel {
  text: string;
  box: Rect;
}

/** A shape a chart may draw its data with: filled, seen, not hidden from assistive technology, not a control. */
export interface ChartShape {
  box: Rect;
  /** A bar (or column, or stack segment) grows from a baseline; a point sits at its value. */
  kind: "point" | "bar";
}

export interface ChartMark extends ChartShape {
  /** Its own accessible text: aria-label, <title> or <desc>. */
  accessible: string | null;
  /** Its series' name, when the page declares it on the group the series is drawn in (aria-label, aria-labelledby). */
  series: string | null;
  /** The other shapes of the group it is drawn in (its series), their boxes. */
  siblings: readonly Rect[];
}

export interface Chart {
  labels: readonly ChartLabel[];
  /** Every shape of the drawing that could be a mark; those in the plot are its marks. */
  shapes: readonly ChartShape[];
  /** How many groups the chart's marks (isMark) are drawn in: with one, the chart's single title names its series. */
  series: number;
}

/** A drawing confirmed as a chart: its value axis, its category axis, its data labels, and the plot they bound. */
export interface Axes {
  /** Values go up (a column of numbers); otherwise across (a row). */
  vertical: boolean;
  valueAxis: ChartLabel[];
  categoryAxis: ChartLabel[] | null;
  /** The numbers drawn in the chart that are no axis's: each may be the value of the one mark that owns it (ownerOf). */
  dataLabels: ChartLabel[];
  /** Where marks are: between the value axis's ends and along the categories, on the plot's side of the category labels. */
  plot: Rect;
  /** The value axis's end ticks (their centres, along the values): a mark's box crosses this range. */
  ticks: [number, number];
}

export interface MarkReading {
  /** "mark": a shape outside any axes that names itself (a pie's slice, a map's region). */
  kind: "point" | "bar" | "mark";
  series: string | null;
  category: string | null;
  value: string | null;
  /** What the reading says it pointed at: the parts that are known, joined by " · ". */
  text: string;
}

/** Said after a mark whose value the page does not write. */
export const NO_VALUE = "(no value written on the chart)";

// ---- numbers as charts draw them ----

/** A number's scale by its suffix: "1 000M", "8G", "3k". "MM" is the Spanish millions. "B" is billions. */
const SCALE: Record<string, number> = { "": 1, k: 1e3, K: 1e3, M: 1e6, MM: 1e6, G: 1e9, B: 1e9, T: 1e12, "%": 1 };

const NUMBER = /^((?:[A-Z]{0,3}[$€£¥₹])?)\s*([+\-−]?)\s*(\d(?:[\d\s  .,']*\d)?)\s*(MM|[kKMGBT%])?$/;

/**
 * A label's number, or null when it is not one: only what tells an axis tick or a data label from other text, never
 * a value to show (the reading shows the label's own text). When both "." and "," show, the last is the decimal; one
 * that shows more than once groups thousands; one that shows once is a decimal unless exactly three digits follow it.
 * Whatever groups thousands (a space, also no-break and thin, ".", "," or "'") must group them: one to three digits,
 * then groups of exactly three ("1 000M", "1.000.000"); "1.2.3" is no number.
 */
export function parseNumber(text: string): number | null {
  const m = NUMBER.exec(text.trim());
  if (!m) return null;
  const [, , sign = "", raw = "", unit = ""] = m;
  const count = (c: string) => raw.split(c).length - 1;
  let dec: "," | "." | null = null;
  if (count(".") && count(",")) dec = raw.lastIndexOf(".") > raw.lastIndexOf(",") ? "." : ",";
  else if (count(".") || count(",")) {
    const c = count(".") ? "." : ",";
    dec = count(c) > 1 || /^\d{3}$/.test(raw.slice(raw.indexOf(c) + 1)) ? null : c;
  }
  if (dec && count(dec) > 1) return null;
  const int = dec ? raw.slice(0, raw.indexOf(dec)) : raw;
  const frac = dec ? raw.slice(raw.indexOf(dec) + 1) : "";
  if (dec && !/^\d+$/.test(frac)) return null;
  const seps = new Set(int.replace(/\d/g, "").replace(/[\s  ]/g, " "));
  if (seps.size > 1) return null;
  const group = seps.size ? [...seps][0]! : null;
  if (group && !int.replace(/[\s  ]/g, " ").split(group).every((g, i) => (i === 0 ? /^\d{1,3}$/ : /^\d{3}$/).test(g))) return null;
  const n = Number(`${int.replace(/\D/g, "")}${frac ? `.${frac}` : ""}`);
  if (!Number.isFinite(n)) return null;
  return (sign === "-" || sign === "−" ? -n : n) * SCALE[unit]!;
}

// ---- the chart's axes ----

const cx = (r: Rect) => (r.left + r.right) / 2;
const cy = (r: Rect) => (r.top + r.bottom) / 2;
const fold = (s: string) => s.replace(/\s+/g, " ").trim();
/** How far two labels' edges or centres may be apart and still be aligned. */
const ALIGN = 3;

/** Labels that line up along one of the keys (left, right or centre for a column; top, bottom or centre for a row), two or more. */
function lines(labels: readonly ChartLabel[], keys: ReadonlyArray<(r: Rect) => number>): ChartLabel[][] {
  const found: ChartLabel[][] = [];
  for (const key of keys) {
    const sorted = [...labels].sort((a, b) => key(a.box) - key(b.box));
    let line: ChartLabel[] = [];
    for (const l of sorted) {
      if (line.length && key(l.box) - key(line[0]!.box) > ALIGN) {
        if (line.length > 1) found.push(line);
        line = [];
      }
      line.push(l);
    }
    if (line.length > 1) found.push(line);
  }
  return found;
}
const columns = (labels: readonly ChartLabel[]) => lines(labels, [(r) => r.left, (r) => r.right, cx]);
const rows = (labels: readonly ChartLabel[]) => lines(labels, [(r) => r.top, (r) => r.bottom, cy]);

/** A line of numbers, two of them different at least: a value axis. */
function numeric(line: readonly ChartLabel[]): boolean {
  return new Set(line.map((l) => parseNumber(l.text))).size > 1;
}

/** The longest line; of two as long, the one with fewer numbers (a category axis names things). */
function longest(found: readonly ChartLabel[][]): ChartLabel[] | null {
  const numbers = (line: readonly ChartLabel[]) => line.filter((l) => parseNumber(l.text) !== null).length;
  let pick: ChartLabel[] | null = null;
  for (const line of found) if (!pick || line.length > pick.length || (line.length === pick.length && numbers(line) < numbers(pick))) pick = line;
  return pick;
}

/** The smallest gap between sorted positions, or null with fewer than two that differ. */
function minGap(positions: readonly number[]): number | null {
  const sorted = [...positions].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((p, i) => p - sorted[i]!).filter((g) => g > 0);
  return gaps.length ? Math.min(...gaps) : null;
}

/**
 * The plot: along the values, between the value axis's end ticks (a little past them, for a value just over the last
 * tick), and never past the category labels, which sit outside it (a legend lies beyond them); across, from half a
 * category before the first to half a category after the last.
 */
function plotOf(vertical: boolean, valueAxis: readonly ChartLabel[], categoryAxis: readonly ChartLabel[] | null): Rect {
  const along = vertical ? cy : cx;
  const across = vertical ? cx : cy;
  const ticks = valueAxis.map((l) => along(l.box));
  const lo = Math.min(...ticks);
  const hi = Math.max(...ticks);
  const pad = Math.max(6, (hi - lo) * 0.08);
  let [vLo, vHi] = [lo - pad, hi + pad];
  let [aLo, aHi] = [-Infinity, Infinity];
  if (categoryAxis) {
    const near = categoryAxis.map((l) => (vertical ? [l.box.top, l.box.bottom] : [l.box.left, l.box.right]) as [number, number]);
    const from = Math.min(...near.map((n) => n[0]));
    const to = Math.max(...near.map((n) => n[1]));
    if (from >= (lo + hi) / 2) vHi = Math.min(vHi, from);
    else if (to <= (lo + hi) / 2) vLo = Math.max(vLo, to);
    const centres = categoryAxis.map((l) => across(l.box));
    const half = (minGap(centres) ?? 0) / 2;
    [aLo, aHi] = [Math.min(...centres) - half, Math.max(...centres) + half];
  }
  return vertical ? { left: aLo, right: aHi, top: vLo, bottom: vHi } : { left: vLo, right: vHi, top: aLo, bottom: aHi };
}

/** Whether a shape's centre is in the plot. */
export function inPlot(box: Rect, axes: Axes): boolean {
  const [x, y] = [cx(box), cy(box)];
  return x >= axes.plot.left && x <= axes.plot.right && y >= axes.plot.top && y <= axes.plot.bottom;
}

/** Whether a shape is the box of a label (a tooltip's, a legend's, a button's): it wholly holds words that are not a number. */
function labelBox(box: Rect, labels: readonly ChartLabel[]): boolean {
  return labels.some((l) => within(l.box, box) && parseNumber(l.text) === null && !!fold(l.text));
}

/**
 * Whether a shape of a confirmed chart is one of its marks (TIN-765, rule B). It is one when all hold:
 * - its centre is in the plot;
 * - its box crosses the value axis's tick range: the plot's margin past the end ticks may hold the centre of a bar
 *   drawn just past the last tick, never a shape that lies only in that margin;
 * - it is not across most of the plot (coversPlot);
 * - it is not the box of a label (labelBox);
 * - it does not wholly hold two or more of the drawing's other shapes (a background, a plot area).
 */
export function isMark(box: Rect, chart: Pick<Chart, "labels" | "shapes">, axes: Axes): boolean {
  const [from, to] = axes.vertical ? [box.top, box.bottom] : [box.left, box.right];
  const crosses = from <= axes.ticks[1] && to >= axes.ticks[0];
  const holds = chart.shapes.filter((s) => !sameBox(s.box, box) && within(s.box, box)).length;
  return inPlot(box, axes) && crosses && !coversPlot(box, axes) && !labelBox(box, chart.labels) && holds < 2;
}

/** The category label in line with a box (within half the space between two labels), or null. */
function categoryLabel(box: Rect, axes: Axes): ChartLabel | null {
  const cats = axes.categoryAxis;
  if (!cats) return null;
  const along = axes.vertical ? cx : cy;
  const size = axes.vertical ? box.right - box.left : box.bottom - box.top;
  const gap = minGap(cats.map((l) => along(l.box)));
  const reach = gap === null ? size / 2 + 2 : gap / 2;
  let nearest: ChartLabel | null = null;
  for (const l of cats) if (!nearest || Math.abs(along(l.box) - along(box)) < Math.abs(along(nearest.box) - along(box))) nearest = l;
  return nearest && Math.abs(along(nearest.box) - along(box)) <= reach ? nearest : null;
}

/**
 * Whether a drawing is a chart, and its axes: a value axis (two numbers or more in one aligned line), and a category
 * axis (two labels or more in a line the other way) or data labels. Null otherwise: then no shape in it is a mark of
 * a chart. Every line of numbers along the values that lies beside the plot (none of its numbers over a shape) is an
 * axis (a chart may draw one on each side), never data labels; a number in a longer line the other way is that line's. When both ways would do, the one with more category labels
 * that shapes line up with wins (one per category, where the other way piles them on a few), then the longer value axis.
 */
export function chartAxes(chart: Pick<Chart, "labels" | "shapes">): Axes | null {
  const labels = chart.labels.filter((l) => fold(l.text));
  // A number belongs to the longest line of numbers it is in: the ticks of two axes, one on each side, make rows of
  // two numbers each, which are no axis.
  const numbers = labels.filter((l) => parseNumber(l.text) !== null);
  // An axis lies beside the plot: a line of numbers one of which is drawn over a shape (a stack's labels, one above
  // the other) is data labels, not an axis.
  const beside = (line: readonly ChartLabel[]) => !line.some((l) => chart.shapes.some((s) => overlap(l.box, s.box)));
  const numberLines = { up: columns(numbers).filter((line) => numeric(line) && beside(line)), across: rows(numbers).filter((line) => numeric(line) && beside(line)) };
  const longestOf = new Map<ChartLabel, number>();
  for (const line of [...numberLines.up, ...numberLines.across]) for (const l of line) longestOf.set(l, Math.max(longestOf.get(l) ?? 0, line.length));
  const option = (vertical: boolean): Axes | null => {
    const valueLines = numberLines[vertical ? "up" : "across"].filter((line) => line.every((l) => longestOf.get(l) === line.length));
    const valueAxis = longest(valueLines);
    if (!valueAxis) return null;
    const ticks = new Set(valueLines.flat());
    const rest = labels.filter((l) => !ticks.has(l));
    const categoryAxis = longest((vertical ? rows : columns)(rest));
    const taken = new Set([...ticks, ...(categoryAxis ?? [])]);
    const dataLabels = rest.filter((l) => !taken.has(l) && parseNumber(l.text) !== null);
    if (!categoryAxis && !dataLabels.length) return null;
    const ends = valueAxis.map((l) => (vertical ? cy : cx)(l.box));
    return { vertical, valueAxis, categoryAxis, dataLabels, plot: plotOf(vertical, valueAxis, categoryAxis), ticks: [Math.min(...ends), Math.max(...ends)] };
  };
  const options = [option(true), option(false)].filter((a): a is Axes => a !== null);
  // How many category labels have a shape in line with them: in the wrong way, many shapes fall by one label.
  const lined = (a: Axes) => new Set(chart.shapes.filter((s) => inPlot(s.box, a)).map((s) => categoryLabel(s.box, a)).filter(Boolean)).size;
  options.sort((a, b) => lined(b) - lined(a) || b.valueAxis.length - a.valueAxis.length);
  return options[0] ?? null;
}

/**
 * Whether a shape covers most of the plot the way no single data mark does: across most of the category axis (a plot
 * band, an area's fill, a background). Only with three categories or more, which a mark spans one of.
 */
export function coversPlot(box: Rect, axes: Axes): boolean {
  const cats = axes.categoryAxis;
  if (!cats || cats.length < 3) return false;
  const centres = cats.map((l) => (axes.vertical ? cx(l.box) : cy(l.box)));
  const span = Math.max(...centres) - Math.min(...centres);
  const [a, b] = axes.vertical ? [box.left, box.right] : [box.top, box.bottom];
  return b - a >= span * 0.6;
}

/** How far a data label may be from the end of its mark. */
const LABEL_REACH = 24;

const sameBox = (a: Rect, b: Rect) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
const overlap = (a: Rect, b: Rect) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
/** The distance between two boxes (0 when they touch or overlap). */
const distance = (a: Rect, b: Rect) => Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom));

/**
 * Whether a number could be the value of a mark: its centre strictly inside the mark's span across the values (no
 * gutter), and the number at the mark's value end. A point's number sits above or below it, within LABEL_REACH; a
 * bar's is on it or within LABEL_REACH past one of its ends.
 */
function couldOwn(l: ChartLabel, m: ChartShape, vertical: boolean): boolean {
  const b = m.box;
  if (m.kind === "point") {
    const c = cx(l.box);
    return c > b.left && c < b.right && Math.max(0, l.box.top - b.bottom, b.top - l.box.bottom) <= LABEL_REACH;
  }
  const c = vertical ? cx(l.box) : cy(l.box);
  const [lo, hi] = vertical ? [b.left, b.right] : [b.top, b.bottom];
  if (!(c > lo && c < hi)) return false;
  const [from, to] = vertical ? [l.box.top, l.box.bottom] : [l.box.left, l.box.right];
  const [start, end] = vertical ? [b.top, b.bottom] : [b.left, b.right];
  return Math.max(0, start - to, from - end) <= LABEL_REACH;
}

/**
 * The one mark a data label is the value of, or null (TIN-765, rule A). A number is a mark's value only when exactly
 * one mark could own it (couldOwn), and no other mark of any series is a rival:
 * - a rival lies within LABEL_REACH of the number, with its centre (across the values) as near to the number's centre
 *   as the owner's is: a point drawn in front of a column, under the number, makes the number nobody's;
 * - with the number outside every mark, a rival is any mark whose span holds the number's centre: a stack's total,
 *   above its top segment, is no segment's value.
 * Whatever is ambiguous is nobody's value: no value beats a wrong value.
 */
export function ownerOf(l: ChartLabel, marks: readonly ChartShape[], axes: Axes): ChartShape | null {
  const owners = marks.filter((m) => couldOwn(l, m, axes.vertical));
  if (owners.length !== 1) return null;
  const owner = owners[0]!;
  const across = axes.vertical ? cx : cy;
  const at = across(l.box);
  const mine = Math.abs(across(owner.box) - at);
  const outside = !marks.some((m) => overlap(l.box, m.box));
  for (const m of marks) {
    if (m === owner) continue;
    if (distance(l.box, m.box) <= LABEL_REACH && Math.abs(across(m.box) - at) <= mine) return null;
    const [lo, hi] = axes.vertical ? [m.box.left, m.box.right] : [m.box.top, m.box.bottom];
    if (outside && at > lo && at < hi) return null;
  }
  return owner;
}

/**
 * The numbers that may be values at all: data labels (chartAxes) that do not lie above the plot (a year as the chart's
 * title) and are not in the box of a label (a tooltip's "400" beside its "F").
 */
function valueLabels(chart: Chart, axes: Axes): ChartLabel[] {
  const boxes = chart.shapes.filter((s) => labelBox(s.box, chart.labels));
  return axes.dataLabels.filter((l) => l.box.bottom > axes.plot.top && !boxes.some((s) => within(l.box, s.box)));
}

/**
 * The single label above everything the chart draws (its axes and its marks) that is not a number: the chart's title.
 * Null when there is none, or more than one (a title and a subtitle, a legend on top).
 */
function titleOf(chart: Chart, axes: Axes): string | null {
  const axisLabels = [...axes.valueAxis, ...(axes.categoryAxis ?? [])];
  const used = new Set([...axisLabels, ...axes.dataLabels]);
  const marks = chart.shapes.filter((s) => isMark(s.box, chart, axes));
  const top = Math.min(...axisLabels.map((l) => l.box.top), ...marks.map((s) => s.box.top));
  const above = chart.labels.filter((l) => fold(l.text) && !used.has(l) && l.box.bottom <= top && parseNumber(l.text) === null);
  return above.length === 1 ? fold(above[0]!.text) : null;
}

/**
 * What the person sees at a mark of a confirmed chart, or null when it is not a mark (isMark) or the chart tells neither
 * its category nor its value (the drop then reads as any other). `omit` is a text the reading already gives (its
 * heading), left out of the parts.
 *
 * - category: the category label in line with the mark, when no other mark of its series is nearer to that label;
 * - series: the name its group declares; with one series, the chart's single title;
 * - value: its own accessible text, else the one data label it owns (ownerOf); else none, and the text says no
 *   value is written.
 */
export function describeMark(mark: ChartMark, chart: Chart, axes: Axes, omit?: string | null): MarkReading | null {
  if (!isMark(mark.box, chart, axes)) return null;
  const along = axes.vertical ? cx : cy;

  let category: string | null = null;
  const cat = categoryLabel(mark.box, axes);
  if (cat) {
    const mine = Math.abs(along(cat.box) - along(mark.box));
    if (!mark.siblings.some((s) => Math.abs(along(cat.box) - along(s)) < mine)) category = fold(cat.text);
  }

  let series = fold(mark.series ?? "") || null;
  if (!series && chart.series <= 1) series = titleOf(chart, axes);

  const accessible = fold(mark.accessible ?? "");
  let value: string | null = accessible || null;
  if (!value) {
    // The mark among the chart's marks, so that ownerOf can tell it from the others.
    const marks = [...chart.shapes.filter((s) => !sameBox(s.box, mark.box) && isMark(s.box, chart, axes)), mark];
    const owned = valueLabels(chart, axes).filter((l) => ownerOf(l, marks, axes) === mark);
    if (owned.length === 1) value = fold(owned[0]!.text);
  }

  if (!category && !value) return null;
  const said = (part: string | null) => !!part && ((omit && fold(omit) === part) || (accessible && part !== accessible && accessible.includes(part)));
  if (said(series)) series = null;
  if (said(category)) category = null;
  const parts = [series, category, value].filter(Boolean).join(" · ");
  const text = value ? parts : parts ? `${parts} ${NO_VALUE}` : NO_VALUE;
  return { kind: mark.kind, series, category, value, text };
}

/**
 * What the person sees at a shape of a drawing that is no chart (no axes) but names its shapes: a pie's slice or a
 * map's region with its own accessible text, in a drawing where two shapes or more name themselves differently. Only
 * that text, nothing around it. Null otherwise (an icon's single <title> is no mark).
 */
export function describeNamed(accessible: string | null, named: readonly string[]): MarkReading | null {
  const own = fold(accessible ?? "");
  if (!own || new Set(named.map(fold).filter(Boolean)).size < 2) return null;
  return { kind: "mark", series: null, category: null, value: own, text: own };
}

// ---- labels drawn twice ----

/** What isOutlineCopy needs of an SVG text, a tspan or a run of text in one. */
export interface SvgText {
  text: string;
  box: Rect;
  /** Drawn with a stroke only (a halo around the letters): a stroke, and a fill that is none, transparent or the stroke's own colour. */
  strokeOnly: boolean;
  /** Drawn with a stroke at all. */
  stroked: boolean;
}

/**
 * Whether an SVG text is the outline copy of a label drawn twice: a halo drawn under the label so it reads on any
 * background. It is drawn with a stroke only, and an unstroked twin with the same words is drawn at the same place
 * (their centres within a pixel). A label drawn with a fill (bold-looking text with a stroke too) is never one.
 */
export function isOutlineCopy(el: SvgText, twins: readonly SvgText[]): boolean {
  const words = fold(el.text);
  if (!el.strokeOnly || !words) return false;
  // Centres, not edges: a stroke widens a halo's box by half its width on each side (1.5 px for a 3 px halo). Rule D.
  const near = (a: Rect, b: Rect) => Math.abs(cx(a) - cx(b)) <= 1 && Math.abs(cy(a) - cy(b)) <= 1;
  return twins.some((t) => t !== el && !t.stroked && fold(t.text) === words && near(t.box, el.box));
}
