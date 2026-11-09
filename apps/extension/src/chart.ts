/**
 * A drop on a chart's mark (TIN-760, DESIGN.md 13.2): a point of a line chart or a bar, drawn in SVG. The
 * content script finds the chart's labels (with their boxes) and the mark; this file decides whether the
 * drawing is a chart at all (chartAxes: a value axis, and a category axis or data labels) and says what the
 * person sees at the mark: its series, its category and its value. Typed by what it touches rather than by
 * the DOM, so the tests run it on plain objects, as read.ts does.
 *
 * A value is exact only when it is visible text that belongs to the mark: its own accessible text, or a data
 * label on it or at its end. Otherwise it is read from the mark's place against the value axis and marked
 * approximate, and only where that can be trusted (three ticks or more on a straight line, or two with a
 * zero, which a log axis cannot show). A tooltip is never used: an HTML5 drag does not move the chart's
 * hover, so a tooltip on screen is about another point. A part that cannot be told is left out.
 */
import type { Rect } from "./read.ts";

/**
 * What a label of the chart is, from the chart's own markup (classes, for Highcharts and d3 alike): an axis
 * label, a data label, a legend item, the chart's title, its tooltip, something else it draws (a subtitle,
 * an axis title, credits), or null when the markup does not say.
 */
export type LabelRole = "axis" | "data" | "legend" | "title" | "tooltip" | "other" | null;

export interface ChartLabel {
  text: string;
  box: Rect;
  role: LabelRole;
  /** The series it belongs to (Highcharts `highcharts-series-N`), when the markup says. */
  series: number | null;
}

export interface ChartMark {
  box: Rect;
  /** A bar (or column, or stack segment) grows from a baseline; a point sits at its value. Told by the series' shape, never by proportions. */
  kind: "point" | "bar";
  series: number | null;
  /** Its own accessible text: aria-label, <title> or <desc>. */
  accessible: string | null;
  /** The other marks of its series (their boxes): bars that share an edge with it show where the baseline is. */
  siblings: readonly Rect[];
}

export interface Chart {
  labels: readonly ChartLabel[];
  /** How many series the chart draws (one: the title names the series). */
  series: number;
  /** Whether the markup says the bars run across (Highcharts' bar series), when it says. */
  horizontal: boolean | null;
}

/** A drawing confirmed as a chart: its value axis (with its numbers), its category axis, its data labels. */
export interface Axes {
  /** Values go up (a column of numbers); otherwise across (a row). */
  vertical: boolean;
  valueAxis: ChartLabel[];
  numbers: ChartNumber[];
  categoryAxis: ChartLabel[] | null;
  dataLabels: ChartLabel[];
  decimal: "," | "." | null;
}

export interface MarkReading {
  kind: "point" | "bar";
  series: string | null;
  category: string | null;
  value: string | null;
  /** The value was read from the mark's place on the value axis, not from text the chart draws. */
  approximate: boolean;
  /** What the reading says it pointed at: the parts that are known, joined by " · ". */
  text: string;
}

/** Said after an approximate value. */
export const APPROXIMATE = "(approximate, read from the chart's position)";

// ---- numbers as charts draw them ----

/** A number's scale by its suffix: "1 000M", "8G", "3k". "MM" is the Spanish millions. "B" is billions. */
const SCALE: Record<string, number> = { "": 1, k: 1e3, K: 1e3, M: 1e6, MM: 1e6, G: 1e9, B: 1e9, T: 1e12, "%": 1 };

export interface ChartNumber {
  /** The number, its scale applied (930M is 930000000; 87,67% is 87.67). */
  value: number;
  /** Its suffix: "", "k", "M", "%"... */
  unit: string;
  /** What comes before it: "$", "US$", "€", or "". */
  prefix: string;
  /** The decimal separator it shows, when it shows one. */
  decimal: "," | "." | null;
  /** The thousands separator it shows, when it shows one: " ", ".", ",", "'". */
  group: string | null;
}

const NUMBER = /^((?:[A-Z]{0,3}[$€£¥₹])?)\s*([+\-−]?)\s*(\d(?:[\d\s  .,']*\d)?)\s*(MM|[kKMGBT%])?$/;

/**
 * A label's number, or null when it is not one. With a decimal separator given (the chart's, decimalOf),
 * only that one is the decimal. Without one: when both "." and "," show, the last is the decimal; one that
 * shows more than once groups thousands; one that shows once is a decimal unless exactly three digits follow
 * it ("1.000" and "1,000" are a thousand, "98,51" and "1,5" decimals). Whatever groups thousands (a space,
 * also no-break and thin, ".", "," or "'") must group them: one to three digits, then groups of exactly
 * three, one separator throughout ("1 000M", "1.000.000"); "1.2.3", or "98,51" where "," groups, is no number.
 */
export function parseNumber(text: string, decimal?: "," | "." | null): ChartNumber | null {
  const m = NUMBER.exec(text.trim());
  if (!m) return null;
  const [, prefix = "", sign = "", raw = "", unit = ""] = m;
  const count = (c: string) => raw.split(c).length - 1;
  let dec: "," | "." | null = null;
  if (decimal) dec = count(decimal) ? decimal : null;
  else if (count(".") && count(",")) dec = raw.lastIndexOf(".") > raw.lastIndexOf(",") ? "." : ",";
  else if (count(".") || count(",")) {
    const c = count(".") ? "." : ",";
    dec = count(c) > 1 || /^\d{3}$/.test(raw.slice(raw.indexOf(c) + 1)) ? null : c;
  }
  if (dec && count(dec) > 1) return null;
  const int = dec ? raw.slice(0, raw.indexOf(dec)) : raw;
  const frac = dec ? raw.slice(raw.indexOf(dec) + 1) : "";
  if (dec && !/^\d+$/.test(frac)) return null;
  const seps = new Set(int.replace(/\d/g, "").replace(/[\s  ]/g, " "));
  if (seps.size > 1) return null;
  const group = seps.size ? [...seps][0]! : null;
  if (group && !int.replace(/[\s  ]/g, " ").split(group).every((g, i) => (i === 0 ? /^\d{1,3}$/ : /^\d{3}$/).test(g))) return null;
  const n = Number(`${int.replace(/\D/g, "")}${frac ? `.${frac}` : ""}`);
  if (!Number.isFinite(n)) return null;
  return { value: (sign === "-" || sign === "−" ? -n : n) * SCALE[unit]!, unit, prefix, decimal: dec, group };
}

/**
 * The decimal separator a chart's numbers show, or null when none tells: a separator followed by other than
 * three digits ("98,51%", "1,5", "0.25"). Given only labels that are numbers themselves (ticks and data
 * labels), never a title or a legend ("Crecimiento 1.5%").
 */
export function decimalOf(texts: readonly string[]): "," | "." | null {
  for (const t of texts) {
    if (!parseNumber(t)) continue;
    const m = /\d([.,])(\d+)(?!\d)/.exec(t);
    if (m && m[2]!.length !== 3 && !/\d[.,]\d+[.,]\d/.test(t)) return m[1] as "," | ".";
  }
  return null;
}

/**
 * A value in the way the value axis writes its numbers: the unit its ticks other than zero share (a zero
 * tick is often a bare "0" on a percentage axis), its prefix, its largest scale the value reaches ("930M",
 * not "0.93G" on an axis of M and G), its separators, rounded to a hundredth of the axis's step.
 */
export function formatLike(value: number, axis: readonly ChartNumber[]): string {
  const ticks = axis.filter((n) => n.value !== 0).length ? axis.filter((n) => n.value !== 0) : axis;
  const percent = ticks.some((n) => n.unit === "%");
  const units = [...new Set(ticks.map((n) => n.unit))].sort((a, b) => SCALE[a]! - SCALE[b]!);
  let unit = percent ? "%" : (units[0] ?? "");
  if (!percent) for (const u of units) if (Math.abs(value) >= SCALE[u]!) unit = u;
  const scale = SCALE[unit]!;
  const sorted = [...new Set(axis.map((n) => n.value))].sort((a, b) => a - b);
  const steps = sorted.slice(1).map((v, i) => v - sorted[i]!).filter((d) => d > 0);
  const step = steps.length ? Math.min(...steps) : Math.abs(value) || 1;
  const exp = Math.floor(Math.log10(step / scale / 100));
  const resolution = 10 ** exp;
  const n = Math.round(value / scale / resolution) * resolution;
  const decimals = Math.max(0, -exp);
  const decimal = axis.find((a) => a.decimal)?.decimal ?? (axis.some((a) => a.group === ".") ? "," : ".");
  const group = axis.find((a) => a.group)?.group ?? null;
  let [int = "0", frac = ""] = Math.abs(n).toFixed(decimals).split(".");
  frac = frac.replace(/0+$/, "");
  if (group && int.length > 3) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const prefix = ticks.find((a) => a.prefix)?.prefix ?? "";
  return `${n < 0 ? "-" : ""}${prefix}${int}${frac ? decimal + frac : ""}${unit}`;
}

// ---- the chart's axes ----

const cx = (r: Rect) => (r.left + r.right) / 2;
const cy = (r: Rect) => (r.top + r.bottom) / 2;
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

/** A line of labels that are all numbers, two of them different at least: a value axis. */
function numeric(line: readonly ChartLabel[], decimal: "," | "." | null): boolean {
  const values = line.map((l) => parseNumber(l.text, decimal));
  return values.every((v) => v !== null) && new Set(values.map((v) => v!.value)).size > 1;
}

/** The longest line. */
function longest(found: readonly ChartLabel[][]): ChartLabel[] | null {
  let pick: ChartLabel[] | null = null;
  for (const line of found) if (!pick || line.length > pick.length) pick = line;
  return pick;
}

/**
 * Whether a drawing is a chart, and its axes: a value axis (two numbers or more in one aligned line), and a
 * category axis (two labels or more in a line the other way) or data labels. Null otherwise: then no shape
 * in it is a mark, and a drop there reads as any other drop does. The decimal separator is told from the
 * labels that are numbers themselves among ticks and data labels.
 */
export function chartAxes(chart: Chart): Axes | null {
  const labels = chart.labels.filter((l) => fold(l.text) && l.role !== "tooltip" && l.role !== "other");
  const hinted = labels.some((l) => l.role === "axis");
  const decimal = decimalOf(labels.filter((l) => l.role === "axis" || l.role === "data" || l.role === null).map((l) => l.text));
  const axisLabels = labels.filter((l) => (hinted ? l.role === "axis" : l.role === null));
  const option = (vertical: boolean): Axes | null => {
    const valueAxis = longest((vertical ? columns : rows)(axisLabels).filter((l) => numeric(l, decimal)));
    if (!valueAxis) return null;
    const rest = axisLabels.filter((l) => !valueAxis.includes(l));
    const categoryAxis = longest((vertical ? rows : columns)(rest));
    const taken = new Set([...valueAxis, ...(categoryAxis ?? [])]);
    const dataLabels = labels.filter((l) => (l.role === "data" || (!hinted && l.role === null && !taken.has(l))) && parseNumber(l.text, decimal));
    if (!categoryAxis && !dataLabels.length) return null;
    return { vertical, valueAxis, numbers: valueAxis.map((l) => parseNumber(l.text, decimal)!), categoryAxis, dataLabels, decimal };
  };
  const up = option(true);
  const across = option(false);
  if (chart.horizontal === true) return across ?? up;
  if (chart.horizontal === false) return up ?? across;
  return up ?? across;
}

/**
 * A value read from a place along the axis against the axis's numbers, by the straight line through them.
 * Null when that cannot be trusted: fewer than three ticks, unless there are two and one is zero (a log
 * axis cannot show zero), or ticks that do not lie on one line (a log axis, labels out of place).
 */
export function interpolate(points: ReadonlyArray<{ pos: number; value: number }>, pos: number): number | null {
  if (points.length < 2 || (points.length === 2 && !points.some((p) => p.value === 0))) return null;
  const n = points.length;
  const mp = points.reduce((s, p) => s + p.pos, 0) / n;
  const mv = points.reduce((s, p) => s + p.value, 0) / n;
  const spp = points.reduce((s, p) => s + (p.pos - mp) ** 2, 0);
  if (!spp) return null;
  const slope = points.reduce((s, p) => s + (p.pos - mp) * (p.value - mv), 0) / spp;
  if (!slope) return null;
  const range = Math.max(...points.map((p) => p.value)) - Math.min(...points.map((p) => p.value));
  if (points.some((p) => Math.abs(mv + slope * (p.pos - mp) - p.value) > range * 0.02)) return null;
  return mv + slope * (pos - mp);
}

const fold = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Where a bar's baseline is along the value axis: the edge it shares with other bars of its series (they
 * grow from the same line), else the axis's zero when the axis shows one. Null when neither tells.
 */
export function baselineOf(mark: ChartMark, axes: Axes, points: ReadonlyArray<{ pos: number; value: number }>): number | null {
  const ends: Array<(r: Rect) => number> = axes.vertical ? [(r) => r.top, (r) => r.bottom] : [(r) => r.left, (r) => r.right];
  const shared = ends.map((end) => mark.siblings.filter((s) => Math.abs(end(s) - end(mark.box)) <= 1).length);
  if (shared[0] !== shared[1]) return ends[shared[0]! > shared[1]! ? 0 : 1]!(mark.box);
  return points.find((p) => p.value === 0)?.pos ?? null;
}

/**
 * Whether a shape covers most of the plot the way no single data mark does: across most of the category
 * axis (a plot band, an area's fill, a background). Only with three categories or more, which a mark spans one of.
 */
export function coversPlot(box: Rect, axes: Axes): boolean {
  const cats = axes.categoryAxis;
  if (!cats || cats.length < 3) return false;
  const along = axes.vertical ? (r: Rect) => [r.left, r.right] : (r: Rect) => [r.top, r.bottom];
  const centres = cats.map((l) => (axes.vertical ? cx(l.box) : cy(l.box)));
  const span = Math.max(...centres) - Math.min(...centres);
  const [a, b] = along(box);
  return b! - a! >= span * 0.6;
}

/**
 * What the person sees at a mark of a confirmed chart, or null when it is not a mark (it covers most of
 * the plot) or the chart tells neither its category nor its value (the drop then reads as any other).
 * `omit` is a text the reading already gives (its heading), left out of the parts.
 */
export function describeMark(mark: ChartMark, chart: Chart, axes: Axes, omit?: string | null): MarkReading | null {
  if (coversPlot(mark.box, axes)) return null;
  const { vertical, valueAxis, categoryAxis, decimal } = axes;
  const labels = chart.labels.filter((l) => fold(l.text));
  const along = vertical ? cx : cy;

  // The category: the axis label in line with the mark, within half the space between two labels.
  let category: string | null = null;
  if (categoryAxis) {
    const centres = categoryAxis.map((l) => along(l.box)).sort((a, b) => a - b);
    const gaps = centres.slice(1).map((c, i) => c - centres[i]!).filter((g) => g > 0);
    const size = vertical ? mark.box.right - mark.box.left : mark.box.bottom - mark.box.top;
    const reach = gaps.length ? Math.min(...gaps) / 2 : size / 2 + 2;
    let nearest: ChartLabel | null = null;
    for (const l of categoryAxis) if (!nearest || Math.abs(along(l.box) - along(mark.box)) < Math.abs(along(nearest.box) - along(mark.box))) nearest = l;
    if (nearest && Math.abs(along(nearest.box) - along(mark.box)) <= reach) category = fold(nearest.text);
  }

  // The series: its legend item; with one series, the chart's title.
  let series: string | null = null;
  if (mark.series !== null) series = fold(labels.find((l) => l.role === "legend" && l.series === mark.series)?.text ?? "") || null;
  if (!series && chart.series <= 1) {
    const titles = labels.filter((l) => l.role === "title");
    if (titles.length) series = fold(titles[0]!.text) || null;
    else if (!labels.some((l) => l.role === "axis")) {
      // Markup that does not say: a single label above the axes and the mark, not a number.
      const axisLabels = [...valueAxis, ...(categoryAxis ?? [])];
      const top = Math.min(...axisLabels.map((l) => l.box.top), mark.box.top);
      const above = labels.filter((l) => l.role === null && !axisLabels.includes(l) && l.box.bottom <= top && !parseNumber(l.text, decimal));
      if (above.length === 1) series = fold(above[0]!.text);
    }
  }

  const points = valueAxis.map((l, i) => ({ pos: vertical ? cy(l.box) : cx(l.box), value: axes.numbers[i]!.value }));
  const baseline = mark.kind === "bar" ? baselineOf(mark, axes, points) : null;
  // A bar's value is at its end away from the baseline.
  const ends = vertical ? [mark.box.top, mark.box.bottom] : [mark.box.left, mark.box.right];
  const end = baseline === null ? null : Math.abs(ends[0]! - baseline) >= Math.abs(ends[1]! - baseline) ? ends[0]! : ends[1]!;

  // The value: exact only from visible text that belongs to the mark.
  let value: string | null = null;
  let approximate = false;
  const accessible = fold(mark.accessible ?? "");
  if (accessible) value = accessible;
  if (!value) {
    const owned = (l: ChartLabel) => l.series === null || mark.series === null || l.series === mark.series;
    let found: { label: ChartLabel; gap: number } | null = null;
    for (const l of axes.dataLabels.filter(owned)) {
      let gap: number;
      if (mark.kind === "bar") {
        // In line with the bar, and on it or just past its end (either end when the baseline is unknown).
        const across = vertical ? cx(l.box) : cy(l.box);
        const [lo, hi] = vertical ? [mark.box.left, mark.box.right] : [mark.box.top, mark.box.bottom];
        if (across < lo - 2 || across > hi + 2) continue;
        const [from, to] = vertical ? [l.box.top, l.box.bottom] : [l.box.left, l.box.right];
        const inside = Math.max(0, Math.min(to, ends[1]!) - Math.max(from, ends[0]!)) > 0;
        const past = (e: number) => (e === ends[0] ? Math.max(0, e - to) : Math.max(0, from - e));
        const beyond = end === null ? Math.min(past(ends[0]!), past(ends[1]!)) : past(end);
        // Past the baseline's side is another bar's label, or none.
        const wrongSide = end !== null && !inside && (end === ends[0] ? from >= ends[1]! : to <= ends[0]!);
        if (wrongSide) continue;
        gap = inside ? 0 : beyond;
      } else {
        // A point's label sits above or below it, centred on it.
        if (cx(l.box) < mark.box.left - 4 || cx(l.box) > mark.box.right + 4) continue;
        gap = Math.max(0, l.box.top - mark.box.bottom, mark.box.top - l.box.bottom);
      }
      if (gap <= 24 && (!found || gap < found.gap)) found = { label: l, gap };
    }
    if (found) value = fold(found.label.text);
  }
  if (!value) {
    const pos = mark.kind === "bar" ? end : vertical ? cy(mark.box) : cx(mark.box);
    const read = pos === null ? null : interpolate(points, pos);
    if (read !== null) {
      value = `≈ ${formatLike(read, axes.numbers)} ${APPROXIMATE}`;
      approximate = true;
    }
  }

  if (!category && !value) return null;
  const said = (part: string | null) => !!part && ((omit && fold(omit) === part) || (accessible && part !== accessible && accessible.includes(part)));
  if (said(series)) series = null;
  if (said(category)) category = null;
  const text = [series, category, value].filter(Boolean).join(" · ");
  return { kind: mark.kind, series, category, value, approximate, text };
}

// ---- labels drawn twice ----

/** What isOutlineCopy needs of an SVG text element. */
export interface SvgText {
  tagName: string;
  getAttribute(name: string): string | null;
  textContent: string | null;
  /** Whether it is drawn with a stroke only (a halo around the letters): a stroke, and a fill that is none, transparent or the stroke's own colour. */
  strokeOnly: boolean;
  /** Whether it is drawn with a stroke at all. */
  stroked: boolean;
}

/**
 * Whether an SVG text element is the outline copy of a label drawn twice: a halo drawn under the label so
 * it reads on any background. Highcharts marks it `highcharts-text-outline`; otherwise a text or tspan drawn
 * with a stroke only, beside an unstroked twin with the same words at the same place. A real label (filled)
 * is never one.
 */
export function isOutlineCopy(el: SvgText, siblings: readonly SvgText[]): boolean {
  if (/(^|\s)highcharts-text-outline(\s|$)/.test(el.getAttribute("class") ?? "")) return true;
  const tag = el.tagName.toLowerCase();
  if ((tag !== "text" && tag !== "tspan") || !el.strokeOnly || !el.textContent?.trim()) return false;
  const at = (e: SvgText) => `${e.getAttribute("x")} ${e.getAttribute("y")} ${e.getAttribute("dx")} ${e.getAttribute("dy")} ${e.getAttribute("transform")}`;
  return siblings.some((s) => s !== el && s.tagName.toLowerCase() === tag && !s.stroked && s.textContent === el.textContent && at(s) === at(el));
}
