// What a built site page carries that the site's CSP (apps/site/src/worker/csp.ts, TIN-1013) would block or must
// never allow: an inline script without a matching 'sha256-…' in script-src, an inline event handler, a
// javascript: URL, an inline <style> or style attribute (style-src has no 'unsafe-inline'), and a script,
// stylesheet or media file from another origin. Pure; scripts/site-routes.mjs runs it on every built page after
// `pnpm build`, and scripts/test/site-csp.test.mjs checks it on fixtures.
import { createHash } from "node:crypto";

/** The 'sha256-…' sources a policy's script-src allows (default-src when script-src is absent). */
export function scriptHashes(csp) {
  const directives = new Map(
    csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name.toLowerCase(), sources]),
  );
  const sources = directives.get("script-src") ?? directives.get("default-src") ?? [];
  return new Set(sources.filter((source) => /^'sha256-[A-Za-z0-9+/]+=*'$/.test(source)).map((source) => source.slice(1, -1)));
}

/** The CSP source for an inline script's exact text, as a browser hashes it. */
export const inlineHash = (text) => `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;

/** Each start tag of the page with its attributes, in order. Built pages only: escaped code (&lt;…) is text, not a tag. */
function tags(html) {
  const out = [];
  for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g)) {
    const attrs = [];
    for (const attr of match[2].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs.push({ name: attr[1].toLowerCase(), value: attr[2] ?? attr[3] ?? attr[4] ?? "" });
    }
    out.push({ name: match[1].toLowerCase(), attrs, end: match.index + match[0].length });
  }
  return out;
}

const decode = (value) =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&amp;/gi, "&");

/** A URL on another origin (absolute or protocol-relative); a same-origin path or a data: URL is not one. */
const foreign = (url) => /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url) && !/^\s*data:/i.test(url);

/**
 * Everything on the page the policy would block or must never allow, one line each; an empty list is a pass.
 * @param {string} html a built page
 * @param {string} csp the policy it is served with
 * @returns {string[]}
 */
export function cspViolations(html, csp) {
  const allowed = scriptHashes(csp);
  const found = [];
  for (const tag of tags(html)) {
    const attr = (name) => tag.attrs.find((a) => a.name === name);
    for (const { name, value } of tag.attrs) {
      if (/^on[a-z]+$/.test(name)) found.push(`inline event handler ${name} on <${tag.name}>`);
      if (name === "style") found.push(`inline style attribute on <${tag.name}>`);
      if (["href", "src", "action", "formaction", "xlink:href", "data", "srcdoc"].includes(name) && /^\s*javascript:/i.test(decode(value).replace(/[\s\u0000-\u001f]/g, ""))) {
        found.push(`javascript: URL in ${name} on <${tag.name}>`);
      }
    }
    if (tag.name === "script") {
      const close = html.indexOf("</script", tag.end);
      const text = html.slice(tag.end, close === -1 ? html.length : close);
      const src = attr("src");
      if (src) {
        if (foreign(src.value)) found.push(`script from another origin: ${src.value}`);
        if (text.trim()) found.push(`<script src="${src.value}"> also carries inline text`);
      } else if (!allowed.has(inlineHash(text))) {
        found.push(`inline <script> without a matching hash in script-src (${inlineHash(text)}): ${text.trim().slice(0, 60)}`);
      }
    }
    if (tag.name === "style") found.push("inline <style> element (style-src has no 'unsafe-inline')");
    if (tag.name === "link" && /\bstylesheet\b/i.test(attr("rel")?.value ?? "") && foreign(attr("href")?.value ?? "")) {
      found.push(`stylesheet from another origin: ${attr("href").value}`);
    }
    if (["img", "video", "audio", "source", "track", "iframe", "embed", "object"].includes(tag.name)) {
      for (const name of ["src", "poster", "data"]) {
        const value = attr(name)?.value;
        if (value && foreign(value)) found.push(`<${tag.name} ${name}> from another origin: ${value}`);
      }
    }
  }
  return found;
}

/** The Content-Security-Policy value _headers gives the rule `/*`, or null. */
export function headersFileCsp(text) {
  let inAll = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inAll = line.trim() === "/*";
    else if (inAll) {
      const match = /^\s+Content-Security-Policy:\s*(.+?)\s*$/i.exec(line);
      if (match) return match[1];
    }
  }
  return null;
}
