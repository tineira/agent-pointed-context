/**
 * The docs' Markdown (apc.tineira.com/docs): a small parser for the subset the pages and the standard's
 * changelog use, into a tree the page renders as React elements (never as HTML strings). Pure, so the link
 * check (test/docs.test.ts) reads the same tree the page shows.
 *
 * Blocks: headings (with GitHub-style ids), paragraphs, lists (one level), fenced code, tables, quotes, and
 * `<!-- include file.ts#region -->`, which shows a region of an example in src/docs/examples (the samples are
 * real files, type-checked and tested). Inline: `code`, **strong**, *em*, [links](href).
 */

export type Inline = { t: "text"; v: string } | { t: "code"; v: string } | { t: "strong"; c: Inline[] } | { t: "em"; c: Inline[] } | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "heading"; level: number; id: string; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "code"; lang: string; v: string }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "quote"; c: Block[] }
  | { t: "include"; file: string; region: string | null };

const FENCE = /^```\s*([\w-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s{0,3}(?:([-*])|(\d{1,3})[.)])\s+(.*)$/;
const INCLUDE = /^<!--\s*include\s+([\w.-]+\.ts)(?:#([\w-]+))?\s*-->\s*$/;
const COMMENT = /^<!--.*-->\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || ITEM.test(line) || line.startsWith(">") || INCLUDE.test(line) || COMMENT.test(line) || line.trimStart().startsWith("|");

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  // A pipe inside `code` is not a cell border, nor is `\|` (GitHub's way to write one, in code too): it is a pipe.
  const out: string[] = [];
  let cell = "";
  let code = false;
  const chars = [...inner];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === "\\" && chars[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (ch === "`") code = !code;
    if (ch === "|" && !code) {
      out.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

/** The blocks of a Markdown text. Heading ids are unique within it, as GitHub makes them. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const ids = new Map<string, number>();
  const uniqueId = (base: string) => {
    const n = ids.get(base) ?? 0;
    ids.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ t: "code", lang: fence[1] ?? "", v: body.join("\n") });
      continue;
    }
    const include = line.match(INCLUDE);
    if (include) {
      blocks.push({ t: "include", file: include[1]!, region: include[2] ?? null });
      i++;
      continue;
    }
    if (COMMENT.test(line)) {
      i++;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const c = parseInline(heading[2]!);
      blocks.push({ t: "heading", level: heading[1]!.length, id: uniqueId(slugify(plainText(c))), c });
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const inner: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) inner.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push({ t: "quote", c: parseMarkdown(inner.join("\n")) });
      continue;
    }
    if (line.trimStart().startsWith("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const head = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trimStart().startsWith("|")) rows.push(cells(lines[i++]!).map(parseInline));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      const ordered = !item[1];
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const m = current.match(ITEM);
        if (m && !m[1] === ordered) {
          items.push(m[3]!);
          i++;
        } else if (current.trim() && !startsBlock(current) && items.length) {
          items[items.length - 1] += ` ${current.trim()}`;
          i++;
        } else if (!current.trim() && i + 1 < lines.length && (lines[i + 1]!.match(ITEM)?.[1] === undefined) === ordered && ITEM.test(lines[i + 1]!)) {
          i++; // a blank line between items of the same list
        } else break;
      }
      blocks.push({ t: "list", ordered, items: items.map(parseInline) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines[i]!))) para.push(lines[i++]!.trim());
    blocks.push({ t: "para", c: parseInline(para.join(" ")) });
  }
  return blocks;
}

const LINK = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^()\s]+)\)/;

/** The inline marks of one line of text. Anything that is not a mark stays text, `*` and `_` included. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const rest = src.slice(i);
    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#|<>-]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("**")) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] && src[i + 1] !== " " && src[i + 1] !== "*") {
      let end = src.indexOf("*", i + 1);
      while (end > 0 && src[end - 1] === " ") end = src.indexOf("*", end + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "em", c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const m = rest.match(LINK);
      if (m) {
        flush();
        out.push({ t: "link", href: m[2]!, c: parseInline(m[1]!) });
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** The text of inline marks, as a reader sees it. */
export function plainText(inline: Inline[]): string {
  return inline.map((n) => (n.t === "text" || n.t === "code" ? n.v : plainText(n.c))).join("");
}

/** A heading's id, as GitHub makes it: lower case, letters, digits, `_` and `-`, spaces as `-`. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

export const REPO = "https://github.com/tineira/agent-pointed-context";

/** The only schemes a link may have: anything else (`javascript:`, `data:`, `vbscript:`…) is never a link. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Where a link in a page goes, or null when it must not be a link. Site links (`/docs/spec`), anchors and
 * http(s) or mailto URLs stay; a relative link (`../../CHANGELOG.md`, as the standard's changelog has) is a
 * file in the repo, next to the page's source (`file`, its path in the repo), so it opens on GitHub. Any
 * other scheme is refused, however it is written: browsers drop whitespace and control characters from a
 * URL and ignore case, so `Java\tScript:` is still `javascript:`, and the check reads it the same way.
 */
export function resolveHref(href: string, file: string): string | null {
  const clean = href.replace(/[\u0000- \u007f-\u009f]/g, "");
  if (!clean) return null;
  const scheme = clean.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) return SAFE_SCHEMES.has(`${scheme[1]!.toLowerCase()}:`) ? clean : null;
  if (clean.startsWith("/") || clean.startsWith("#")) return clean;
  // A colon before any / ? or # would make a browser read a scheme anyway: not a relative path.
  if (/^[^/?#]*:/.test(clean)) return null;
  return `${REPO}/blob/main/${repoPath(clean, file)}`;
}

/** The element id a URL's #fragment names, or null. A malformed fragment (`#%E0%A4%A`) names nothing; it never throws. */
export function fragmentTarget(hash: string): string | null {
  if (!hash.startsWith("#") || hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

/** A relative link's path in the repo, with its #anchor, from the page's own path. */
export function repoPath(href: string, file: string): string {
  const [path = "", hash] = href.split("#", 2);
  const parts = file.split("/").slice(0, -1);
  for (const seg of path.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/") + (hash ? `#${hash}` : "");
}

/**
 * A region of an example file, as the page shows it: between `// #region name` and its `// #endregion`, with
 * the region markers inside it left out and the common indent removed; the whole file without markers when
 * `region` is null. Null when there is no such region.
 */
export function exampleRegion(source: string, region: string | null): string | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const marker = /^\s*\/\/ #(end)?region\b/;
  let picked: string[];
  if (region === null) picked = lines;
  else {
    const start = lines.findIndex((l) => new RegExp(`^\\s*// #region ${region}\\s*$`).test(l));
    if (start < 0) return null;
    let depth = 0;
    let end = -1;
    for (let j = start + 1; j < lines.length; j++) {
      const m = lines[j]!.match(marker);
      if (!m) continue;
      if (!m[1]) depth++;
      else if (depth === 0) {
        end = j;
        break;
      } else depth--;
    }
    if (end < 0) return null;
    picked = lines.slice(start + 1, end);
  }
  const shown = picked.filter((l) => !marker.test(l));
  while (shown.length && !shown[0]!.trim()) shown.shift();
  while (shown.length && !shown[shown.length - 1]!.trim()) shown.pop();
  const indent = Math.min(...shown.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return shown.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

/** Every link in the blocks, for the link check. */
export function linksOf(blocks: Block[]): string[] {
  const out: string[] = [];
  const walk = (inline: Inline[]) => {
    for (const n of inline) {
      if (n.t === "link") out.push(n.href);
      if (n.t === "strong" || n.t === "em" || n.t === "link") walk(n.c);
    }
  };
  for (const b of blocks) {
    if (b.t === "heading" || b.t === "para") walk(b.c);
    else if (b.t === "list") b.items.forEach(walk);
    else if (b.t === "table") [...b.head, ...b.rows.flat()].forEach(walk);
    else if (b.t === "quote") out.push(...linksOf(b.c));
  }
  return out;
}

/** The ids of the headings, quotes included. */
export function headingIds(blocks: Block[]): string[] {
  return blocks.flatMap((b) => (b.t === "heading" ? [b.id] : b.t === "quote" ? headingIds(b.c) : []));
}
