/**
 * What a reading takes from a page beyond its rendered text (TIN-422, DESIGN.md 13.2): the words behind
 * an image or a formula, a table cell's column header and row, and the form state at the drop point
 * (TIN-571). Typed by what they touch rather than by the DOM, so the tests run them on plain objects.
 */

import { autocompleteSecret, FIELD_LABEL_MAX, FIELD_VALUE_MAX, FIELDS_MAX, FORM_TEXT_MAX, namesSecret, valueSecret, type FormField, type FormReading } from "../../dock/src/worker/reading.ts";

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
  /** Its accessible label: aria-labelledby, aria-label, its label elements, title or placeholder. */
  label: string | null;
  /** For a radio, the group's label (legend, radiogroup label) and its group's key; null otherwise. */
  group: string | null;
  groupKey: string | null;
  name: string | null;
  id: string | null;
  autocomplete: string | null;
  placeholder: string | null;
  checked: boolean;
  /** A text field's value, or the selected options' text of a select. */
  value: string;
  /** The control the person dropped on. */
  pointed: boolean;
}

/** Text-like input types whose value goes into a reading; every other type (password, hidden, file, buttons) never does. */
export const TEXT_TYPES = new Set(["", "text", "email", "tel", "url", "search", "number", "date", "time", "datetime-local", "month", "week", "textarea"]);

/** Whether a control never goes into a reading, whatever it holds: a password, a card, a one-time code, an account, an id. */
export function secretControl(c: Pick<Control, "kind" | "type" | "label" | "group" | "name" | "id" | "autocomplete" | "placeholder" | "value">): boolean {
  if (c.type === "password") return true;
  if (autocompleteSecret(c.autocomplete)) return true;
  if (namesSecret(c.name, c.id, c.label, c.placeholder, c.kind === "radio" ? c.group : null)) return true;
  return c.kind === "text" && valueSecret(c.value);
}

const cut = (text: string | null, max: number) => {
  const t = text?.replace(/\s+/g, " ").trim() ?? "";
  return t ? t.slice(0, max) : null;
};

/**
 * The form state a reading carries (TIN-571), from the controls around the drop point, the pointed one
 * first: the chosen radio of each group (or the pointed one, chosen or not), every checkbox, a select's
 * chosen options, and text fields that hold something. Hidden inputs never get here. A secret field is
 * counted in left_out, never read; past FIELDS_MAX or FORM_TEXT_MAX the rest are counted in more. Null
 * when there is nothing to say.
 */
export function formState(controls: readonly Control[]): FormReading | null {
  const fields: FormField[] = [];
  let leftOut = 0;
  let more = 0;
  let size = 0;
  const ordered = [...controls.filter((c) => c.pointed), ...controls.filter((c) => !c.pointed)];
  const groupsTaken = new Set<string>();
  for (const c of ordered) {
    if (c.type === "hidden") continue;
    if (c.kind === "text" && !TEXT_TYPES.has(c.type) && c.type !== "password") continue;
    if (c.kind === "radio" && !c.checked && !c.pointed) continue;
    if (c.kind === "radio" && c.checked && c.groupKey) {
      if (groupsTaken.has(c.groupKey)) continue;
      groupsTaken.add(c.groupKey);
    }
    // An empty field says nothing; an empty password field is still counted, as it is there.
    if ((c.kind === "text" || c.kind === "select") && !c.value.trim() && c.type !== "password") continue;
    if (secretControl(c)) {
      leftOut++;
      continue;
    }
    const label = cut(c.kind === "radio" ? (c.group ?? c.name) : (c.label ?? c.name), FIELD_LABEL_MAX);
    const value =
      c.kind === "radio" ? cut(`${c.label ?? (c.value || "an option")}${c.checked ? "" : " (not selected)"}`, FIELD_VALUE_MAX)
      : c.kind === "checkbox" ? (c.checked ? "checked" : "not checked")
      : cut(c.value, FIELD_VALUE_MAX);
    if (!value) continue;
    const length = (label?.length ?? 0) + value.length;
    if (fields.length >= FIELDS_MAX || size + length > FORM_TEXT_MAX) {
      more++;
      continue;
    }
    size += length;
    fields.push({ label, value, pointed: c.pointed });
  }
  return fields.length || leftOut || more ? { fields, left_out: leftOut, more } : null;
}
