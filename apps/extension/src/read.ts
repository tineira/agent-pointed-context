/**
 * What a reading takes from a page beyond its rendered text (TIN-422, DESIGN.md 13.2): the words behind
 * an image or a formula, and a table cell's column header and row. Typed by what they touch rather
 * than by the DOM, so the tests run them on plain objects.
 */

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
