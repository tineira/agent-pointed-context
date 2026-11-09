/**
 * A drop on a chart's mark (TIN-760, DESIGN.md 13.2): a point of a line chart or a bar, drawn in SVG. The
 * content script finds the mark and what the chart draws around it (its labels, with their boxes); this
 * file says what the person sees at that mark: its series, its category and its value. Typed by what it
 * touches rather than by the DOM, so the tests run it on plain objects, as read.ts does.
 *
 * The value, in this order: the mark's own accessible text (aria-label, <title>, <desc>); a data label drawn
 * on the mark or at its end (exact, as drawn); a tooltip visible at the drop, when it names the mark's
 * category; otherwise the mark's place read against two or more numbers of the value axis, marked
 * approximate. A part that cannot be told is left out, never guessed.
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
  series: number | null;
  /** Its own accessible text: aria-label, <title> or <desc>. */
  accessible: string | null;
}

export interface Chart {
  labels: readonly ChartLabel[];
  /** How many series the chart draws (one: the title names the series). */
  series: number;
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
 * A label's number, or null when it is not one. Spaces (also no-break and thin spaces) between digits
 * group thousands: "1 000M" is 1000 million. With a decimal separator given (the chart's, decimalOf), the
 * other of "." and "," groups thousands. Without one: when both show, the last is the decimal; one that
 * shows more than once groups thousands; one that shows once is a decimal unless exactly three digits
 * follow it ("1.000" and "1,000" are a thousand, "98,51" and "1,5" decimals).
 */
export function parseNumber(text: string, decimal?: "," | "." | null): ChartNumber | null {
  const m = NUMBER.exec(text.trim());
  if (!m) return null;
  const [, prefix = "", sign = "", raw = "", unit = ""] = m;
  let group: string | null = /\d[\s  ]\d/.test(raw) ? " " : raw.includes("'") ? "'" : null;
  let digits = raw.replace(/[\s  ']/g, "");
  const count = (c: string) => digits.split(c).length - 1;
  let dec: "," | "." | null = null;
  if (count(".") || count(",")) {
    if (decimal) dec = digits.includes(decimal) ? decimal : null;
    else if (count(".") && count(",")) dec = digits.lastIndexOf(".") > digits.lastIndexOf(",") ? "." : ",";
    else {
      const c = count(".") ? "." : ",";
      dec = count(c) > 1 || /^\d{3}$/.test(digits.slice(digits.indexOf(c) + 1)) ? null : c;
    }
    if (dec && count(dec) > 1) return null;
    if (!dec && count(".") && count(",")) return null;
    for (const c of [".", ","]) if (c !== dec && count(c)) group = c;
    digits = digits.replace(/[.,]/g, (c) => (c === dec ? "." : ""));
  }
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return { value: (sign === "-" || sign === "−" ? -n : n) * SCALE[unit]!, unit, prefix, decimal: dec, group };
}

/**
 * The decimal separator a chart's labels show, or null when none tells: a separator followed by other
 * than three digits ("98,51%", "1,5", "0.25").
 */
export function decimalOf(texts: readonly string[]): "," | "." | null {
  for (const t of texts) {
    const m = /\d([.,])(\d+)(?!\d)/.exec(t);
    if (m && m[2]!.length !== 3 && !/\d[.,]\d+[.,]\d/.test(t)) return m[1] as "," | ".";
  }
  return null;
}

/**
 * A value in the way the value axis writes its numbers: its prefix, its largest scale the value reaches
 * ("930M", not "0.93G" on an axis of M and G), its separators, rounded to a hundredth of the axis's step.
 */
export function formatLike(value: number, axis: readonly ChartNumber[]): string {
  const percent = axis.some((n) => n.unit === "%");
  const units = [...new Set(axis.map((n) => n.unit).filter((u) => u !== "%"))].sort((a, b) => SCALE[a]! - SCALE[b]!);
  let unit = percent ? "%" : (units[0] ?? "");
  for (const u of units) if (Math.abs(value) >= SCALE[u]!) unit = u;
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
  const prefix = axis.find((a) => a.prefix)?.prefix ?? "";
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

/** The longest line, the nearest to the mark among the longest. */
function best(found: readonly ChartLabel[][], distance: (line: readonly ChartLabel[]) => number): ChartLabel[] | null {
  let pick: ChartLabel[] | null = null;
  for (const line of found) if (!pick || line.length > pick.length || (line.length === pick.length && distance(line) < distance(pick))) pick = line;
  return pick;
}

/**
 * A value read from the mark's place (pos, along the axis) against the axis's numbers, by the straight
 * line through them. Null when they do not lie on one (a log axis, labels out of place).
 */
export function interpolate(points: ReadonlyArray<{ pos: number; value: number }>, pos: number): number | null {
  if (points.length < 2) return null;
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
 * What the person sees at a mark of a chart, or null when the chart tells neither its category nor its
 * value (the drop then takes the whole chart). `omit` is a text the reading already gives (its heading),
 * left out of the parts.
 */
export function describeMark(mark: ChartMark, chart: Chart, omit?: string | null): MarkReading | null {
  const w = mark.box.right - mark.box.left;
  const h = mark.box.bottom - mark.box.top;
  const kind: MarkReading["kind"] = (w >= 2.5 * h && w > 12) || (h >= 2.5 * w && h > 12) ? "bar" : "point";
  const labels = chart.labels.filter((l) => fold(l.text));
  const decimal = decimalOf(labels.map((l) => l.text));
  const hinted = labels.some((l) => l.role === "axis");
  const axisLabels = labels.filter((l) => (hinted ? l.role === "axis" : l.role === null));

  // Which way the chart runs: by its value axis (a column of numbers: values go up), else by the mark's shape.
  const numericColumns = columns(axisLabels).filter((l) => numeric(l, decimal));
  const numericRows = rows(axisLabels).filter((l) => numeric(l, decimal));
  const vertical = numericColumns.length && !numericRows.length ? true : numericRows.length && !numericColumns.length ? false : !(kind === "bar" && w > h);

  const along = vertical ? cx : cy;
  const across = vertical ? cy : cx;
  const valueAxis = best(vertical ? numericColumns : numericRows, (line) => Math.abs(along(line[0]!.box) - along(mark.box)));
  const rest = axisLabels.filter((l) => !valueAxis?.includes(l));
  const categoryAxis = best(vertical ? rows(rest) : columns(rest), (line) => Math.abs(across(line[0]!.box) - across(mark.box)));

  // The category: the axis label in line with the mark, within half the space between two labels.
  let category: string | null = null;
  if (categoryAxis) {
    const centres = categoryAxis.map((l) => along(l.box)).sort((a, b) => a - b);
    const gaps = centres.slice(1).map((c, i) => c - centres[i]!).filter((g) => g > 0);
    const reach = gaps.length ? Math.min(...gaps) / 2 : (vertical ? w : h) / 2 + 2;
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
    else if (!hinted) {
      // Markup that does not say: a single word line above everything else the chart draws, not a number.
      const axes = [...(valueAxis ?? []), ...(categoryAxis ?? [])];
      const top = Math.min(...axes.map((l) => l.box.top), mark.box.top);
      const above = labels.filter((l) => l.role === null && !axes.includes(l) && l.box.bottom <= top && !parseNumber(l.text, decimal));
      if (above.length === 1) series = fold(above[0]!.text);
    }
  }

  // The value, exact when the chart says it.
  let value: string | null = null;
  let approximate = false;
  const accessible = fold(mark.accessible ?? "");
  if (accessible) value = accessible;
  if (!value) {
    const axisSet = new Set([...(valueAxis ?? []), ...(categoryAxis ?? [])]);
    const candidates = labels.filter((l) => (l.role === "data" || (l.role === null && !axisSet.has(l))) && parseNumber(l.text, decimal) && (l.series === null || mark.series === null || l.series === mark.series));
    const runsAcross = kind === "bar" && !vertical;
    let found: { label: ChartLabel; gap: number } | null = null;
    for (const l of candidates) {
      const inLine = runsAcross ? cy(l.box) >= mark.box.top - 2 && cy(l.box) <= mark.box.bottom + 2 : cx(l.box) >= mark.box.left - 4 && cx(l.box) <= mark.box.right + 4;
      if (!inLine) continue;
      const gap = runsAcross ? Math.max(0, l.box.left - mark.box.right, mark.box.left - l.box.right) : Math.max(0, l.box.top - mark.box.bottom, mark.box.top - l.box.bottom);
      if (gap <= 24 && (!found || gap < found.gap)) found = { label: l, gap };
    }
    if (found) value = fold(found.label.text);
  }
  if (!value) {
    const tip = fold(labels.filter((l) => l.role === "tooltip").map((l) => l.text).join(" "));
    if (tip && (!category || tip.includes(category))) value = tip;
  }
  if (!value && valueAxis) {
    const numbers = valueAxis.map((l) => parseNumber(l.text, decimal)!);
    const points = valueAxis.map((l, i) => ({ pos: vertical ? cy(l.box) : cx(l.box), value: numbers[i]!.value }));
    let read: number | null = null;
    if (kind === "bar") {
      // A bar's value is at its end: of its two ends, the one further from zero.
      const ends = (vertical ? [mark.box.top, mark.box.bottom] : [mark.box.left, mark.box.right]).map((p) => interpolate(points, p));
      if (ends[0] !== null && ends[1] !== null) read = Math.abs(ends[0]!) >= Math.abs(ends[1]!) ? ends[0]! : ends[1]!;
    } else read = interpolate(points, vertical ? cy(mark.box) : cx(mark.box));
    if (read !== null) {
      value = `≈ ${formatLike(read, numbers)} ${APPROXIMATE}`;
      approximate = true;
    }
  }

  if (!category && !value) return null;
  const said = (part: string | null) => !!part && ((omit && fold(omit) === part) || (accessible && part !== accessible && accessible.includes(part)));
  if (said(series)) series = null;
  if (said(category)) category = null;
  const text = [series, category, value].filter(Boolean).join(" · ");
  return { kind, series, category, value, approximate, text };
}

// ---- labels drawn twice ----

/** What isOutlineCopy needs of an SVG text element. */
export interface SvgText {
  tagName: string;
  getAttribute(name: string): string | null;
  textContent: string | null;
  /** Whether it is drawn with a stroke (a halo around the letters). */
  stroked: boolean;
}

/**
 * Whether an SVG text element is the outline copy of a label drawn twice: a halo drawn under the label
 * so it reads on any background. Highcharts marks it `highcharts-text-outline`; otherwise a stroked
 * text or tspan beside one with the same words at the same place, unstroked.
 */
export function isOutlineCopy(el: SvgText, siblings: readonly SvgText[]): boolean {
  if (/(^|\s)highcharts-text-outline(\s|$)/.test(el.getAttribute("class") ?? "")) return true;
  const tag = el.tagName.toLowerCase();
  if ((tag !== "text" && tag !== "tspan") || !el.stroked || !el.textContent?.trim()) return false;
  const at = (e: SvgText) => `${e.getAttribute("x")} ${e.getAttribute("y")} ${e.getAttribute("transform")}`;
  return siblings.some((s) => s !== el && s.tagName.toLowerCase() === tag && !s.stroked && s.textContent === el.textContent && at(s) === at(el));
}
