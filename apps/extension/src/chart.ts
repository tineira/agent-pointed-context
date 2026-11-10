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
 * - its centre is in the plot, and along the values between the end ticks (a shape only past the last tick, or one
 *   that crosses it by a pixel, is none; a bar drawn a little past it keeps its centre inside);
 * - it is not across most of the plot (coversPlot);
 * - it is not the box of a label (labelBox);
 * - it wholly holds no other bar (a background, a plot area, a rect around a column), and no shapes of two
 *   categories or more (a rect behind a line's points); a column holding points of its own category stays a mark.
 */
export function isMark(box: Rect, chart: Pick<Chart, "labels" | "shapes">, axes: Axes): boolean {
  const centre = axes.vertical ? cy(box) : cx(box);
  const between = centre >= axes.ticks[0] && centre <= axes.ticks[1];
  const held = chart.shapes.filter((s) => !sameBox(s.box, box) && within(s.box, box));
  const categories = new Set(held.map((s) => categoryLabel(s.box, axes)).filter(Boolean));
  const holds = held.some((s) => s.kind === "bar") || categories.size >= 2;
  return inPlot(box, axes) && between && !coversPlot(box, axes) && !labelBox(box, chart.labels) && !holds;
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
 * a chart. Every line of numbers along the values that lies beside the plot (two of its numbers or more beside every
 * shape) is an axis (a chart may draw one on each side), never data labels; a number in a longer line the other way is that
 * line's. When both ways would do, the one with more category labels that shapes line up with wins (one per category,
 * where the other way piles them on a few), then the longer value axis.
 */
export function chartAxes(chart: Pick<Chart, "labels" | "shapes">): Axes | null {
  const labels = chart.labels.filter((l) => fold(l.text));
  // A number belongs to the longest line of numbers it is in: the ticks of two axes, one on each side, make rows of
  // two numbers each, which are no axis.
  const numbers = labels.filter((l) => parseNumber(l.text) !== null);
  // An axis lies beside the plot: a line of numbers is an axis when two of its numbers or more, of different values,
  // have their centres beside every shape (a column's left of or right of each shape's span, a row's above or below).
  // Numbers one above the other over a bar or a stack are data labels; a tick a bar is drawn under leaves its axis an
  // axis, and stays a tick.
  const besideAll = (l: ChartLabel, up: boolean) => chart.shapes.every((s) => (up ? cx(l.box) <= s.box.left || cx(l.box) >= s.box.right : cy(l.box) <= s.box.top || cy(l.box) >= s.box.bottom));
  const beside = (up: boolean) => (line: readonly ChartLabel[]) => numeric(line.filter((l) => besideAll(l, up)));
  const numberLines = { up: columns(numbers).filter(beside(true)), across: rows(numbers).filter(beside(false)) };
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

/** How far a data label may be from its mark, along the values. */
const LABEL_REACH = 24;

const sameBox = (a: Rect, b: Rect) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
const overlap = (a: Rect, b: Rect) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
/** Whether a point lies strictly inside a box. */
const inside = (x: number, y: number, b: Rect) => x > b.left && x < b.right && y > b.top && y < b.bottom;

/*
 * Who owns a number (TIN-765, rule A, fix round 2). One structural rule, no tolerances that interact:
 *
 * 1. A number may be a value only when it is no axis tick, its centre is not above the top tick (on a horizontal
 *    chart, not above the plot: the title's region), and it is not a tooltip's: no word that is not a number (axis
 *    labels aside) lies within one line of it, and it does not overlap a shape that holds such words.
 * 2. A mark is in reach of a number when the number's box overlaps the mark's span across the values (a point's give
 *    or take its own size across) and, along the values, the number is on it or within LABEL_REACH of it. Across and
 *    along follow the chart: on a horizontal chart, across is up and down for a point as for a bar.
 * 3. A number whose centre lies on a bar is that bar's when it lies on exactly one bar and no point is in reach.
 * 4. A number on no bar is the one mark's that claims it, when exactly one does: the marks in reach, and every bar
 *    whose span across holds the number's centre at any distance (a stack's other segments).
 * 5. A mark that owns two numbers or more reads no value.
 * Anything else is nobody's value: no value beats a wrong value.
 */

/** Whether a mark is in reach of a number (rule 2). */
function inReach(l: ChartLabel, m: ChartShape, vertical: boolean): boolean {
  const b = m.box;
  const across = vertical ? [[l.box.left, l.box.right], [b.left, b.right]] : [[l.box.top, l.box.bottom], [b.top, b.bottom]];
  // A point is small: one that comes within its own size of the number, across, is in reach too.
  const slack = m.kind === "point" ? (vertical ? b.right - b.left : b.bottom - b.top) : 0;
  if (Math.min(across[0]![1]!, across[1]![1]!) + slack <= Math.max(across[0]![0]!, across[1]![0]!)) return false;
  const [from, to, start, end] = vertical ? [l.box.top, l.box.bottom, b.top, b.bottom] : [l.box.left, l.box.right, b.left, b.right];
  return Math.max(0, start - to, from - end) <= LABEL_REACH;
}

/** The mark a number is the value of, or null (rules 2 to 4). */
export function ownerOf(l: ChartLabel, marks: readonly ChartShape[], axes: Axes): ChartShape | null {
  const [x, y] = [cx(l.box), cy(l.box)];
  const bars = marks.filter((m) => m.kind === "bar");
  const reach = marks.filter((m) => inReach(l, m, axes.vertical));
  const on = bars.filter((m) => inside(x, y, m.box));
  if (on.length) return on.length === 1 && !reach.some((m) => m.kind === "point") ? on[0]! : null;
  const at = axes.vertical ? x : y;
  const holders = bars.filter((m) => (axes.vertical ? at > m.box.left && at < m.box.right : at > m.box.top && at < m.box.bottom));
  const claims = new Set([...reach, ...holders]);
  if (claims.size !== 1) return null;
  const [owner] = claims;
  return reach.includes(owner!) ? owner! : null;
}

/** The numbers that may be values at all (rule 1). */
function valueLabels(chart: Chart, axes: Axes): ChartLabel[] {
  const axisLabels = new Set([...axes.valueAxis, ...(axes.categoryAxis ?? [])]);
  const words = chart.labels.filter((l) => !axisLabels.has(l) && fold(l.text) && parseNumber(l.text) === null);
  const boxes = chart.shapes.filter((s) => labelBox(s.box, chart.labels));
  const nearWord = (l: ChartLabel) => {
    const h = l.box.bottom - l.box.top;
    const grown = { left: l.box.left - h, right: l.box.right + h, top: l.box.top - h, bottom: l.box.bottom + h };
    return words.some((w) => overlap(w.box, grown));
  };
  const titleRegion = (l: ChartLabel) => (axes.vertical ? cy(l.box) < axes.ticks[0] : cy(l.box) < axes.plot.top);
  return axes.dataLabels.filter((l) => !titleRegion(l) && !nearWord(l) && !boxes.some((s) => overlap(l.box, s.box)));
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
