// Customer-facing text never carries an internal ticket number (TIN-992): no "TIN-411" in a dialog, a tooltip, a
// tool description sent to an agent or a docs page. Code comments may cite them; strings, JSX text and the served docs
// pages may not. The scan strips comments (// and /* */, <!-- --> in markup) and reports what is left.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const TICKET = /\bTIN-\d+/g;

/** The source trees whose strings reach people or agents; apps/v1 is frozen (the paper describes it). */
const CODE_ROOTS = [
  "apps/demo/src",
  "apps/dock/src",
  "apps/signals/src",
  "apps/extension/src",
  "apps/desktop",
  "packages/protocol/src",
  "packages/server/src",
  "packages/web/src",
  "packages/conformance/src",
];
const CODE_EXT = /\.(ts|tsx|mjs|js|cs)$/;
const MARKUP_EXT = /\.(html|axaml)$/;
/** Served as they are: every line is customer-facing. */
const DOCS_ROOT = "apps/dock/src/docs/pages";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "bin" || name === "obj") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * The text with its comments blanked out (newlines kept, so line numbers hold). A small scanner: code, strings ('
 * and " end at a newline, ` spans lines), line and block comments. It errs towards keeping text (an apostrophe in JSX
 * text opens a "string" to the end of its line), so it can report too much, never too little outside comments. A `//`
 * right after a `:` is a URL's, not a comment: JSX text is unquoted, so `https://` there must not hide the rest.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let mode = "code";
  let quote = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/" && src[i - 1] !== ":") mode = "line";
      else if (c === "/" && n === "*") mode = "block";
      else if (c === "'" || c === '"' || c === "`") {
        mode = "string";
        quote = c;
      }
      if (mode === "line" || mode === "block") {
        out += "  ";
        i += 2;
        continue;
      }
      out += c;
    } else if (mode === "string") {
      if (c === "\\") {
        out += c + (n ?? "");
        i += 2;
        continue;
      }
      if (c === quote || (c === "\n" && quote !== "`")) mode = "code";
      out += c;
    } else if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      } else out += " ";
    } else {
      if (c === "*" && n === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? c : " ";
    }
    i++;
  }
  return out;
}

const stripMarkupComments = (src) => src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));

function hits(file, text) {
  const found = [];
  text.split("\n").forEach((line, k) => {
    for (const m of line.matchAll(TICKET)) found.push(`${relative(root, file).replaceAll("\\", "/")}:${k + 1}: ${m[0]}: ${line.trim().slice(0, 120)}`);
  });
  return found;
}

test("the scanner keeps strings and drops comments", () => {
  const src = 'const a = "see (TIN-1)"; // TIN-2\n/* TIN-3\n TIN-4 */ <p>Pulse\'s (TIN-5)</p>\nconst u = "https://x/y"; // TIN-6\n{/* TIN-7 */}\n<p>See https://x.example (TIN-8)</p>';
  const left = stripComments(src);
  assert.deepEqual([...left.matchAll(TICKET)].map((m) => m[0]), ["TIN-1", "TIN-5", "TIN-8"]);
  assert.equal(left.split("\n").length, src.split("\n").length);
});

test("no customer-facing string carries an internal ticket number", () => {
  const found = [];
  for (const r of CODE_ROOTS) {
    for (const f of walk(join(root, r))) {
      if (CODE_EXT.test(f)) found.push(...hits(f, stripComments(readFileSync(f, "utf8"))));
      else if (MARKUP_EXT.test(f)) found.push(...hits(f, stripMarkupComments(readFileSync(f, "utf8"))));
    }
  }
  for (const f of walk(join(root, DOCS_ROOT))) if (f.endsWith(".md")) found.push(...hits(f, stripMarkupComments(readFileSync(f, "utf8"))));
  assert.deepEqual(found, [], `Internal ticket numbers in customer-facing text (cite them in a comment instead):\n${found.join("\n")}`);
});
