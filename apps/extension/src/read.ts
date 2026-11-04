/**
 * What a reading takes from a page beyond its rendered text (TIN-422, DESIGN.md 13.2): the words behind
 * an image or a formula, a table cell's column header and row, and the form state at the drop point
 * (TIN-571). Typed by what they touch rather than by the DOM, so the tests run them on plain objects.
 */

import { autocompleteSecret, codeSecret, namesSecret, shapeFields, type FieldCandidate, type FormReading } from "../../dock/src/worker/reading.ts";

/** Said in an image's place when it has no alternative text, so the agent knows something is missing. */
export const NO_ALT = "[image with no alt text]";

interface Described {
  tagName: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): { textContent: string | null } | null;
}

/**
 * What stands in for an image or a formula: its alternative text, "" for an image marked as decoration
 * (alt=""), or null when this element has none and its own content is all there is.
 */
export function altText(el: Described): string | null {
  const attr = (name: string) => el.getAttribute(name)?.trim() || null;
  const inner = (selector: string) => el.querySelector(selector)?.textContent?.trim() || null;
  const tag = el.tagName.toLowerCase();
  if (tag === "img") return attr("alt") ?? attr("aria-label") ?? (el.getAttribute("alt") === null ? NO_ALT : "");
  if (tag === "math") return attr("alttext") ?? attr("aria-label") ?? inner('annotation[encoding="application/x-tex"]');
  if (tag === "svg") return attr("aria-label") ?? inner("title");
  return null;
}

interface Cell {
  tagName: string;
  colSpan: number;
  rowSpan: number;
}

interface Table<C extends Cell> {
  rows: ArrayLike<{ cells: ArrayLike<C> }>;
}

/** The most places a table may fill: a page can ask for a million with a few spans. Past it, a cell has no context. */
const GRID_MAX = 200_000;

/** The table as a grid: grid[y][x] is the cell covering that place, across its spans. Null when it is too big. */
function grid<C extends Cell>(table: Table<C>): C[][] | null {
  const height = table.rows.length;
  const out: C[][] = Array.from({ length: height }, () => []);
  let left = GRID_MAX;
  for (let y = 0; y < height; y++) {
    let x = 0;
    for (const cell of Array.from(table.rows[y]!.cells)) {
      while (out[y]![x]) x++;
      // rowspan="0" runs to the end of the table section.
      const down = Math.min(cell.rowSpan || height, height - y);
      left -= down * cell.colSpan;
      if (left < 0) return null;
      for (let dy = 0; dy < down; dy++) for (let dx = 0; dx < cell.colSpan; dx++) out[y + dy]![x + dx] = cell;
      x += cell.colSpan;
    }
  }
  return out;
}

const isHeader = (cell: Cell) => cell.tagName.toLowerCase() === "th";

/**
 * A cell's place in its table: the nearest th above it in its column, and its row's first cell. Either
 * is null when the cell is that cell, and a header cell in a row of headers has no row of its own.
 * Only a real th counts as a column header: the first row of a plain table may well be data.
 */
export function tableContext<C extends Cell>(table: Table<C>, cell: C, text: (c: C) => string): { column: string | null; row: string | null } {
  const cells = grid(table);
  const y = cells?.findIndex((row) => row.includes(cell)) ?? -1;
  if (!cells || y < 0) return { column: null, row: null };
  const x = cells[y]!.indexOf(cell);
  let header: C | undefined;
  for (let up = y - 1; up >= 0 && !header; up--) {
    const above = cells[up]![x];
    if (above && isHeader(above)) header = above;
  }
  const first = cells[y]![0];
  const row = first && first !== cell && !(isHeader(cell) && isHeader(first)) ? first : undefined;
  return { column: header ? text(header).trim() || null : null, row: row ? text(row).trim() || null : null };
}

/**
 * A form control as the content script saw it at the drop (TIN-571): native or ARIA, described by
 * plain fields so the tests run formState on plain objects.
 */
export interface Control {
  kind: "radio" | "checkbox" | "select" | "text";
  /** The input's type, lowercased, or "select" / "textarea"; "aria" for an ARIA radio, checkbox or switch. */
  type: string;
  /** Its accessible label: aria-labelledby (in its own root, a shadow root too), aria-label, its label elements, title. */
  label: string | null;
  /** For a radio, the group's label (legend, radiogroup label) and its group's key; null otherwise. */
  group: string | null;
  groupKey: string | null;
  name: string | null;
  id: string | null;
  autocomplete: string | null;
  placeholder: string | null;
  checked: boolean;
  /** A text field's value, or the chosen options' text of a select. */
  value: string;
  /** The control the person dropped on. */
  pointed: boolean;
  /** Whether the person sees it (controlVisible). */
  visible: boolean;
}

/** Text-like input types whose value may go into a reading; every other type (password, hidden, file, buttons) never does. */
export const TEXT_TYPES = new Set(["", "text", "email", "tel", "url", "search", "number", "date", "time", "datetime-local", "month", "week", "textarea"]);

/** Whether a control's markup says it holds a secret: a password, a card, a one-time code, an account, an id. */
export function secretControl(c: Pick<Control, "kind" | "type" | "label" | "group" | "name" | "id" | "autocomplete" | "placeholder" | "value">): boolean {
  if (c.type === "password") return true;
  if (autocompleteSecret(c.autocomplete)) return true;
  if (codeSecret(c.value, c.name, c.id, c.placeholder)) return true;
  return namesSecret("name", c.name, c.id) || namesSecret("label", c.label, c.placeholder, c.kind === "radio" ? c.group : null);
}

/** Whether a control counts toward a wider group's size (pickScope): one formState could say something of. */
export function countable(c: Pick<Control, "kind" | "type" | "visible">): boolean {
  if (c.type === "hidden" || !c.visible) return false;
  return c.kind !== "text" || TEXT_TYPES.has(c.type) || c.type === "password";
}

/** What the content script measured of an element, for visuallyHidden. */
export interface Seen {
  /** checkVisibility with display, visibility and opacity: false when none of it shows. */
  checkVisible: boolean;
  /** Its effective opacity: its own times its ancestors'. */
  opacity: number;
  /** The alpha of its text colour (color, -webkit-text-fill-color): 0 when its text is transparent. */
  textAlpha: number;
  width: number;
  height: number;
  /** The box in page coordinates, and the page's size. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  pageWidth: number;
  pageHeight: number;
  /** Computed position, clip and clip-path. */
  position: string;
  clip: string;
  clipPath: string;
  /** It or an ancestor has aria-hidden="true". */
  ariaHidden: boolean;
}

/** Below this effective opacity, an element is taken as not seen. */
export const OPACITY_MIN = 0.1;

/**
 * Whether the person cannot see an element (TIN-571): not rendered, nearly transparent (an effective
 * opacity under 0.1), of no size (or 1 px, the screen-reader-only pattern), off the page, clipped away,
 * or hidden from assistive technology; for a field they type in (typed), also text in a transparent
 * colour. These are how a page keeps a field it does not show; a reading never reads such a field.
 */
export function visuallyHidden(s: Seen, typed = false): boolean {
  if (!s.checkVisible || s.ariaHidden || s.opacity < OPACITY_MIN) return true;
  if (typed && s.textAlpha < OPACITY_MIN) return true;
  if (s.width <= 1 || s.height <= 1) return true;
  if (s.right <= 0 || s.bottom <= 0 || s.left >= s.pageWidth || s.top >= s.pageHeight) return true;
  if ((s.position === "absolute" || s.position === "fixed") && s.clip !== "auto" && s.clip !== "") return true;
  return /inset\(\s*(50|100)%|circle\(\s*0|polygon\(\s*0px 0px\s*\)/.test(s.clipPath);
}

/**
 * Whether the person sees a control. Only a native radio or checkbox may be seen through a label they
 * see, since custom widgets hide that input under a styled label; a select, a field they type in and any
 * element with a role must be seen themselves.
 */
export function controlVisible(nativeChoice: boolean, typed: boolean, self: Seen, labels: readonly Seen[]): boolean {
  if (!visuallyHidden(self, typed)) return true;
  return nativeChoice && !self.ariaHidden && labels.some((l) => !visuallyHidden(l));
}

/** The most controls a wider group (a form, a role=group) may hold for its choices to go along. */
export const SCOPE_MAX = 25;

/**
 * Which ancestor of the drop point gives the choices (TIN-571), nearest first: the control's own group
 * (a fieldset or a radiogroup) whatever its size; without one, the nearest form or role=group, only when
 * it holds at most SCOPE_MAX controls. -1: none, so only the control dropped on (and its own radios).
 */
export function pickScope(ancestors: ReadonlyArray<{ kind: "own" | "wider"; controls: number }>): number {
  const own = ancestors.findIndex((a) => a.kind === "own");
  if (own >= 0) return own;
  const wider = ancestors.findIndex((a) => a.kind === "wider");
  return wider >= 0 && ancestors[wider]!.controls <= SCOPE_MAX ? wider : -1;
}

/**
 * The form state a reading carries (TIN-571), the pointed control first: the choices (the chosen radio
 * of each group, or the pointed one chosen or not; every checkbox; a select's chosen options) and the
 * typed value of the field dropped on, never of any other. A control the person cannot see is skipped.
 * A choice whose markup or text looks secret is counted in left_out; the typed value of the field dropped
 * on is said as LEFT_OUT then. The filters and caps are shapeFields, which the hub runs again.
 */
export function formState(controls: readonly Control[]): FormReading | null {
  const ordered = [...controls.filter((c) => c.pointed), ...controls.filter((c) => !c.pointed)];
  const groupsTaken = new Set<string>();
  const candidates: FieldCandidate[] = [];
  for (const c of ordered) {
    if (c.type === "hidden") continue;
    if (c.kind === "text") {
      if (!c.pointed || (!TEXT_TYPES.has(c.type) && c.type !== "password")) continue;
      // A password is said to be there, never read; another empty field says nothing.
      if (!c.value.trim() && c.type !== "password") continue;
      // A field dropped on that the person cannot see (a transparent field laid over the page): left out.
      candidates.push({ kind: "typed", label: c.label ?? c.placeholder ?? c.name, value: c.value || "-", pointed: true, secret: !c.visible || secretControl(c) });
      continue;
    }
    if (!c.visible) continue;
    if (c.kind === "radio" && !c.checked && !c.pointed) continue;
    if (c.kind === "radio" && c.checked && c.groupKey) {
      if (groupsTaken.has(c.groupKey)) continue;
      groupsTaken.add(c.groupKey);
    }
    if (c.kind === "select" && !c.value.trim()) continue;
    const label = c.kind === "radio" ? (c.group ?? c.name) : (c.label ?? c.name);
    const value = c.kind === "radio" ? `${c.label ?? (c.value || "an option")}${c.checked ? "" : " (not selected)"}` : c.kind === "checkbox" ? (c.checked ? "checked" : "not checked") : c.value;
    candidates.push({ kind: "choice", label, value, pointed: c.pointed, secret: secretControl(c) });
  }
  return shapeFields(candidates);
}

