/**
 * What a reading takes from a page beyond its rendered text (TIN-422, DESIGN.md 13.2): the words behind
 * an image or a formula, a table cell's column header and row, and the form state inside the outline
 * (TIN-571, TIN-619). Typed by what they touch rather than by the DOM, so the tests run them on plain objects.
 */

import { autocompleteCredential, autocompleteSecret, CODE_LEFT_OUT, codeSecret, namesCredential, namesSecret, textSecret, type FieldCandidate } from "../../dock/src/worker/reading.ts";

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
  /** The control right under the pointer. */
  pointed: boolean;
  /** Whether the person sees it (controlVisible). */
  visible: boolean;
}

/** Text-like input types whose value may go into a reading; every other type (hidden, file, buttons) never does, and a password only as CODE_LEFT_OUT. */
export const TEXT_TYPES = new Set(["", "text", "email", "tel", "url", "search", "number", "date", "time", "datetime-local", "month", "week", "textarea"]);

type ControlWords = Pick<Control, "kind" | "type" | "label" | "group" | "name" | "id" | "autocomplete" | "placeholder" | "value">;

/**
 * What a control holds, by its markup and its words (TIN-619): "credential" for a password or a
 * one-time code (a card's security code too), which never goes in any mode; "sensitive" for a card,
 * account or id number, which goes only as the person chose; null otherwise.
 */
export function classify(c: ControlWords): "credential" | "sensitive" | null {
  const labels = [c.label, c.placeholder, c.kind === "radio" ? c.group : null];
  if (c.type === "password" || autocompleteCredential(c.autocomplete) || namesCredential(c.name, c.id, ...labels) || codeSecret(c.value, c.name, c.id, ...labels)) return "credential";
  if (autocompleteSecret(c.autocomplete) || namesSecret("name", c.name, c.id) || namesSecret("label", ...labels) || textSecret(c.value) || textSecret(c.label)) return "sensitive";
  return null;
}

/** Whether a control's markup or words say it holds a secret of either kind. */
export function secretControl(c: ControlWords): boolean {
  return classify(c) !== null;
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
  /**
   * Whether its box shows inside the outlined element's box, once cut to every box around it that clips
   * what overflows it (showsIn); undefined when no outline is in question.
   */
  inOutline?: boolean;
}

/** Below this effective opacity, an element is taken as not seen. */
export const OPACITY_MIN = 0.1;

/** A box in the viewport's coordinates. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** Everywhere: what an element is clipped to when nothing clips it. */
export const ANYWHERE: Rect = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
export const intersect = (a: Rect, b: Rect): Rect => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
/** Whether a box shows inside a clip by more than a pixel each way: the person can see some of it. */
/** Whether a box lies wholly inside a clip, give or take a pixel: nothing of it is cut off. */
export const within = (box: Rect, clip: Rect): boolean => box.left >= clip.left - 1 && box.top >= clip.top - 1 && box.right <= clip.right + 1 && box.bottom <= clip.bottom + 1;
export const showsIn = (box: Rect, clip: Rect): boolean => {
  const i = intersect(box, clip);
  return i.right - i.left > 1 && i.bottom - i.top > 1;
};

/** A partly clipped token longer than this many UTF-16 units is dropped, not cut: the cut needs its grapheme boundaries in memory. */
export const TOKEN_CUT_MAX = 200000;
/** A token on one line, partly cut, stays whole when it is no longer than this and has no character of a script written without spaces between words in it: an ordinary word. */
export const WORD_UNITS_MAX = 32;
/** The scripts written without spaces between words: a run of them on one line is a phrase, not a word, so it is cut to what shows. */
const NO_SPACE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Where each grapheme of a text starts, and its end last: a surrogate pair or a combining mark is never split. */
function boundaries(text: string): number[] {
  const at: number[] = [];
  if (segmenter) for (const g of segmenter.segment(text)) at.push(g.index);
  else {
    let i = 0;
    for (const c of text) {
      at.push(i);
      i += c.length;
    }
  }
  at.push(text.length);
  return at;
}

/** How many lines a token's rects lie on: rects whose vertical extents overlap by half the smaller one share a line (a BiDi run or a tag boundary on one line adds none). */
function linesOf(rects: Rect[]): number {
  const lines: Rect[] = [];
  for (const r of rects) {
    const same = lines.find((l) => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) >= Math.min(l.bottom - l.top, r.bottom - r.top) / 2);
    if (same) {
      same.top = Math.min(same.top, r.top);
      same.bottom = Math.max(same.bottom, r.bottom);
    } else lines.push({ ...r });
  }
  return lines.length;
}

/**
 * The part of a text that shows inside a clip, word by word (TIN-622). `rectsOf(start, end)` gives the
 * client rects of that slice of the text. One rule for a token with no space: sent whole only when every
 * one of its rects lies within the clip; skipped when none shows (before any per-part work); otherwise cut
 * to the parts that show. The cut bisects the token down to its graphemes (a surrogate pair or a combining
 * mark is never split), so it asks about few parts however long the token is, a slice with no rect showing
 * is dropped whole and one wholly within is kept whole, and the kept parts are joined with no space: scripts
 * written without spaces (CJK, Thai, Lao, Khmer, Burmese) have none to put back. Graphemes, not `Intl.Segmenter` words: a CJK dictionary word can itself straddle a
 * line break, and a grapheme never does.
 *
 * One exception, to keep an ordinary word readable (TIN-622): a token on a single line, partly cut by
 * the clip's edge, stays whole when it is at most WORD_UNITS_MAX units long and has no character of a script written without spaces (Han, Kana,
 * Hangul, Thai, Lao, Khmer, Myanmar) in it. A token
 * over TOKEN_CUT_MAX units that is partly cut is dropped.
 */
export function visibleWords(data: string, rectsOf: (start: number, end: number) => Rect[], clip: Rect): string {
  let out = "";
  let pending = "";
  const solid = (r: Rect) => r.right > r.left && r.bottom > r.top;
  for (const m of data.matchAll(/\s+|\S+/g)) {
    if (/^\s/.test(m[0])) {
      pending = m[0];
      continue;
    }
    const token = m[0];
    const rects = rectsOf(m.index, m.index + token.length).filter(solid);
    let kept = "";
    if (!rects.some((r) => showsIn(r, clip))) kept = "";
    else if (rects.every((r) => within(r, clip))) kept = token;
    else if (linesOf(rects) === 1 && token.length <= WORD_UNITS_MAX && !NO_SPACE_SCRIPTS.test(token)) kept = token;
    else if (token.length <= TOKEN_CUT_MAX) {
      const at = boundaries(token);
      // The root slice is the whole token, whose rects are already in hand.
      const cut = (lo: number, hi: number, known?: Rect[]): string => {
        const part = token.slice(at[lo], at[hi]);
        const found = known ?? rectsOf(m.index + at[lo]!, m.index + at[hi]!).filter(solid);
        if (!found.some((r) => showsIn(r, clip))) return "";
        if (hi - lo === 1 || found.every((r) => within(r, clip))) return part;
        const mid = (lo + hi) >> 1;
        return cut(lo, mid) + cut(mid, hi);
      };
      kept = cut(0, at.length - 1, rects);
    }
    if (kept) out += (out ? pending : "") + kept;
    pending = "";
  }
  return out;
}

/** What a CSS filter does to opacity: opacity(0.5) or opacity(50%), multiplied; 1 without one. */
export function filterOpacity(filter: string): number {
  let out = 1;
  for (const m of filter.matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g)) out *= m[2] ? Number(m[1]) / 100 : Number(m[1]);
  return out;
}

/** Whether a clip-path leaves nothing of an element to see. */
export const clipPathHides = (clipPath: string) => /inset\(\s*(50|100)%|circle\(\s*0|polygon\(\s*0px 0px\s*\)/.test(clipPath);

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
  if (clipPathHides(s.clipPath)) return true;
  // Outside the outline, or cut off by a box around it that clips what overflows it (TIN-619).
  return s.inOutline === false;
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

/** The most fields the content script hands on from one outline; the rest are counted in more. */
export const FIELDS_SENT = 200;

/**
 * The form state inside the outline (TIN-571, TIN-619), the control under the pointer first, then in the
 * page's order: what was typed in each field the person can see, the chosen radio of each group (or the
 * one under the pointer, chosen or not), every checkbox, a select's chosen options. A control the person
 * cannot see is never read. A password or a one-time code goes only as CODE_LEFT_OUT; a sensitive value
 * goes with its value and `sensitive: true`, for the service worker to keep or leave out as the person
 * chose (chooseSensitive). The filters and caps are shapeFields, which the service worker and the hub run.
 */
export function formState(controls: readonly Control[]): { fields: FieldCandidate[]; left_out: number; more: number } | null {
  const ordered = [...controls.filter((c) => c.pointed), ...controls.filter((c) => !c.pointed)];
  const groupsTaken = new Set<string>();
  const fields: FieldCandidate[] = [];
  let more = 0;
  const add = (field: FieldCandidate) => {
    if (fields.length >= FIELDS_SENT) more++;
    else fields.push(field);
  };
  for (const c of ordered) {
    if (c.type === "hidden" || !c.visible) continue;
    const kind = classify(c);
    if (c.kind === "text") {
      if (!TEXT_TYPES.has(c.type) && c.type !== "password") continue;
      if (!c.value.trim()) continue;
      const label = c.label ?? c.placeholder ?? c.name;
      // A password or a code never leaves the page: only that it is there.
      if (kind === "credential") add({ kind: "typed", label, value: CODE_LEFT_OUT, pointed: c.pointed, credential: true });
      else add({ kind: "typed", label, value: c.value, pointed: c.pointed, ...(kind === "sensitive" ? { sensitive: true as const } : {}) });
      continue;
    }
    if (c.kind === "radio" && !c.checked && !c.pointed) continue;
    if (c.kind === "radio" && c.checked && c.groupKey) {
      if (groupsTaken.has(c.groupKey)) continue;
      groupsTaken.add(c.groupKey);
    }
    if (c.kind === "select" && !c.value.trim()) continue;
    const label = c.kind === "radio" ? (c.group ?? c.name) : (c.label ?? c.name);
    const value = c.kind === "radio" ? `${c.label ?? (c.value || "an option")}${c.checked ? "" : " (not selected)"}` : c.kind === "checkbox" ? (c.checked ? "checked" : "not checked") : c.value;
    if (kind === "credential") add({ kind: "choice", label, value: CODE_LEFT_OUT, pointed: c.pointed, credential: true });
    else add({ kind: "choice", label, value, pointed: c.pointed, ...(kind === "sensitive" ? { sensitive: true as const } : {}) });
  }
  return fields.length || more ? { fields, left_out: 0, more } : null;
}

/** The most controls a form's card may hold, and the most elements the content script looks through for them. */
export const CARD_CONTROLS_MAX = 50;

/**
 * The outline around a form control, or around the label of one (TIN-619): from `start`, the largest
 * ancestor that holds the same controls and no others (a radio's whole group counts as one), whose text
 * is not most of the page. On a Google Form that is the question's card, title and answer together.
 * `controls` gives an element's control keys, or null when there are too many to say; `text` its text
 * length; `up` its parent, across shadow roots; `top` whether it is the page itself.
 */
export function cardOf<E>(start: E, own: ReadonlySet<string>, up: (e: E) => E | null, controls: (e: E) => ReadonlySet<string> | null, text: (e: E) => number, top: (e: E) => boolean, textMax: number): E {
  let card = start;
  for (let at = up(start); at && !top(at); at = up(at)) {
    const keys = controls(at);
    if (!keys || keys.size !== own.size || [...keys].some((k) => !own.has(k))) break;
    if (text(at) > textMax) break;
    card = at;
  }
  return card;
}

/** A box of text bigger than this is most of the page, not what the person pointed at. */
export const BOX_MAX = 4000;
/**
 * A box with less text than this is a scrap, not a block (TIN-697): a badge ("5", "New"), a separator, an
 * icon's word. The climb goes past it to the box around it, and takes it only when nothing else will do.
 */
export const BOX_MIN = 16;

/** What blockAbove asks of each element on its way up. */
export interface Climb<E> {
  up: (e: E) => E | null;
  /** Whether it is the page itself (body, html), where the climb stops. */
  top: (e: E) => boolean;
  /** An inline box with no alternative text of its own: its words belong to the box around it. */
  inline: (e: E) => boolean;
  /** One item of a list or grid (isItem): a card, which is a block whatever its text. */
  item: (e: E) => boolean;
  /** The length of its text as the person sees it, spaces folded; past BOX_MAX it may stop counting. */
  text: (e: E) => number;
}

/** One item of a list, grid or table: an article, a list item, a figure, a table row, or an element with the role of one. */
export const isItem = (tag: string, role: string | null): boolean => ["article", "li", "figure", "tr"].includes(tag.toLowerCase()) || role === "article" || role === "listitem" || role === "row";

/**
 * The block of text around an element that is no block of text itself (TIN-697): a photo, an empty link
 * stretched over a card to make all of it clickable, a wrapper. From `start` up, the nearest box with
 * BOX_MIN characters of text or more, or an item (isItem) with any. When the boxes around that one hold
 * the same text up to an item, the item: a card's wrappers give the card itself, while a post's text in
 * a page of nothing else stays the post's text, not the page's main box. A box with more than BOX_MAX
 * characters is most of the page: the climb stops there. When it stops with nothing found, the first
 * scrap of text it passed, or null (the page).
 */
export function blockAbove<E>(start: E, c: Climb<E>): E | null {
  let scrap: E | null = null;
  for (let at: E | null = start; at && !c.top(at); at = c.up(at)) {
    if (c.inline(at)) continue;
    const n = c.text(at);
    if (!n) continue;
    if (n > BOX_MAX) return scrap;
    if (n < BOX_MIN && !c.item(at)) {
      scrap ??= at;
      continue;
    }
    if (c.item(at)) return at;
    for (let p = c.up(at); p && !c.top(p); p = c.up(p)) {
      if (c.inline(p)) continue;
      if (c.text(p) !== n) break;
      if (c.item(p)) return p;
    }
    return at;
  }
  return scrap;
}

/** A heading: h1 to h6, or an element with the heading role. */
export const isHeading = (tag: string, role: string | null): boolean => /^h[1-6]$/i.test(tag) || role === "heading";

/**
 * Whose headings stay its own: an item of a list or grid (isItem), and a section, aside or nav. A heading
 * inside one names that one, never what comes after it.
 */
export const ownsHeadings = (tag: string, role: string | null): boolean => isItem(tag, role) || ["section", "aside", "nav"].includes(tag.toLowerCase());

/** What headingOf asks of the page. */
export interface Outline<E> {
  up: (e: E) => E | null;
  children: (e: E) => readonly E[];
  /** A heading the person sees (isHeading, with text). */
  heading: (e: E) => boolean;
  /** ownsHeadings. */
  owns: (e: E) => boolean;
  /** A control that can title the box it tops (isTitleControl), that the person sees, with a value to show that is not a secret. */
  title?: (e: E) => boolean;
  /** An element that shows nothing: no words, no control, no image. */
  blank?: (e: E) => boolean;
  /** The words a box is named by, from its own markup: aria-labelledby (the element's words the person sees) or aria-label. */
  named?: (e: E) => string | null;
}

/**
 * Whether a control is the kind a panel is titled by: a dropdown that picks the view or dimension it shows
 * (TIN-766). A select that shows one choice, a `role=combobox` that is not a typed field, or a button that
 * opens a listbox. Never a typed field (its words are the person's), nor a list that shows all its options.
 */
export function isTitleControl(tag: string, role: string | null, popup: string | null, multiple: boolean): boolean {
  const t = tag.toLowerCase();
  if (t === "select") return !multiple;
  if (t === "input" || t === "textarea") return false;
  if (role === "combobox") return true;
  return (t === "button" || role === "button") && popup === "listbox";
}

/** What a select shows as its choice: the one chosen option's own text, never the others; null when none or several are chosen or it has no words. */
export function selectTitle(options: readonly { text: string; selected: boolean }[]): string | null {
  const chosen = options.filter((o) => o.selected);
  return chosen.length === 1 ? chosen[0]!.text.replace(/\s+/g, " ").trim() || null : null;
}

/** The first (or last) heading in an element, in the page's order, past the ones inside an element that owns its headings; `top` counts as one. */
function headingIn<E>(e: E, t: Outline<E>, last: boolean, top: E | null): E | null {
  const kids = last ? [...t.children(e)].reverse() : t.children(e);
  for (const c of kids) {
    if (t.heading(c) || c === top) return c;
    if (t.owns(c)) continue;
    const h = headingIn(c, t, last, top);
    if (h) return h;
  }
  return null;
}

/**
 * The control that titles a box (TIN-766): the first thing the box shows, directly or inside one wrapper
 * (a toolbar, a header row), when that is a title control (Outline.title). A heading, an item or section,
 * or any other first thing means the box has no such control, and a control further in is a filter of its
 * body, not its title.
 */
function topTitle<E>(box: E, t: Outline<E>, depth = 0): E | null {
  if (!t.title) return null;
  for (const c of t.children(box)) {
    if (t.blank?.(c)) continue;
    if (t.title(c)) return c;
    if (depth > 0 || t.heading(c) || t.owns(c)) return null;
    return topTitle(c, t, depth + 1);
  }
  return null;
}

/** What titles a block: an element of the page, or words from a box's own markup. */
export type Title<E> = { el: E } | { label: string };

/**
 * The title an element is under (TIN-697, TIN-766): the heading it is in or is; else its own first
 * heading, as a card's title, past the headings of the items inside it; else, going up, in each box it is
 * in, the nearest heading before it among what surrounds it, never one inside an item, section, aside or
 * nav it is not in (ownsHeadings); leaving an item or section it is in with none found, that one's own
 * first heading, as a photo above a card's title is under that title. In a grid of cards, a card is under
 * its own title or the grid's heading, never under the card before it.
 *
 * A box is titled by what it declares before the page's order is used (TIN-766): a heading, the control
 * that tops it (topTitle: a dropdown that picks what the box shows counts as its heading), or its own
 * markup (aria-labelledby, aria-label; Outline.named). Each is looked for in the box before the box
 * before it, so a block is never put under the title of the panel next to its own, whose title it can
 * not see: a box that has a title of its own keeps the block in it.
 */
export function titleOf<E>(el: E, t: Outline<E>): Title<E> | null {
  for (let at: E | null = el; at; at = t.up(at)) if (t.heading(at)) return { el: at };
  const own = headingIn(el, t, false, topTitle(el, t));
  if (own) return { el: own };
  const self = t.named?.(el);
  if (self) return { label: self };
  for (let child = el, at = t.up(el); at; child = at, at = t.up(at)) {
    const top = topTitle(at, t);
    const kids = t.children(at);
    for (let i = kids.indexOf(child) - 1; i >= 0; i--) {
      const s = kids[i]!;
      if (t.heading(s) || s === top) return { el: s };
      if (t.owns(s)) continue;
      const h = headingIn(s, t, true, top);
      if (h) return { el: h };
    }
    if (t.owns(at)) {
      const h = headingIn(at, t, false, top);
      if (h) return { el: h };
    }
    const label = t.named?.(at);
    if (label) return { label };
  }
  return null;
}

/** The heading element an element is under (titleOf), when it is an element of the page. */
export function headingOf<E>(el: E, t: Outline<E>): E | null {
  const found = titleOf(el, t);
  return found && "el" in found ? found.el : null;
}
