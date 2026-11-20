// What a built site page carries that the site's CSP (apps/site/src/worker/csp.ts, TIN-1013) would block or must
// never allow: an inline script without a matching 'sha256-…' in script-src, an inline event handler, a
// javascript: URL, an inline <style> or style attribute (style-src has no 'unsafe-inline'), a <base> element, a form
// that posts elsewhere, and a script, stylesheet, preload, icon or media file (srcset included) from another origin
// or scheme. Tags are read with a small tokenizer that follows the browser's rules (TIN-1036). Pure; scripts/site-routes.mjs runs it on every built page after
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

const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";
// Elements whose content is text up to their own end tag, so a "<" inside never opens a tag (HTML's raw-text and
// RCDATA elements). <plaintext> turns the rest of the page into text.
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);

/**
 * Each start tag of the page with its attributes, in order, read the way a browser's tokenizer reads them (TIN-1036):
 * a tag name ends at whitespace, "/" or ">", and a "/" between attributes separates them as whitespace does, so
 * `<svg/onload=…>`, `<script/x>` and `<img src="x"/onclick=…>` are read as the browser reads them. Comments,
 * doctypes, end tags and the text of raw-text elements are skipped. Built pages only: escaped code (&lt;…) is text.
 */
export function tags(html) {
  const out = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    i = lt + 1;
    if (html.startsWith("!--", i)) {
      const close = html.indexOf("-->", i + 3);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (html[i] === "!" || html[i] === "?" || html[i] === "/") {
      const close = html.indexOf(">", i);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(html[i] ?? "")) continue;
    let name = "";
    while (i < n && !isSpace(html[i]) && html[i] !== "/" && html[i] !== ">") name += html[i++];
    const attrs = [];
    for (;;) {
      while (i < n && (isSpace(html[i]) || html[i] === "/")) i++;
      if (i >= n || html[i] === ">") break;
      let attrName = html[i++]; // a first "=" is kept as part of the name, as a browser does
      while (i < n && !isSpace(html[i]) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") attrName += html[i++];
      let j = i;
      while (j < n && isSpace(html[j])) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < n && isSpace(html[j])) j++;
        if (html[j] === '"' || html[j] === "'") {
          const close = html.indexOf(html[j], j + 1);
          value = html.slice(j + 1, close === -1 ? n : close);
          j = close === -1 ? n : close + 1;
        } else {
          const from = j;
          while (j < n && !isSpace(html[j]) && html[j] !== ">") j++;
          value = html.slice(from, j);
        }
        i = j;
      }
      attrs.push({ name: attrName.toLowerCase(), value });
    }
    const tag = { name: name.toLowerCase(), attrs, end: Math.min(i + 1, n) };
    out.push(tag);
    i = tag.end;
    if (tag.name === "plaintext") break;
    if (RAW_TEXT.has(tag.name)) {
      const close = html.slice(i).search(new RegExp(`</${tag.name}[\\s/>]`, "i"));
      i = close === -1 ? n : i + close;
    }
  }
  return out;
}

const decode = (value) =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&colon;/gi, ":")
    .replace(/&sol;/gi, "/")
    .replace(/&bsol;/gi, "\\")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&amp;/gi, "&");

/** A URL as a browser reads it: entities decoded, tabs and newlines dropped, leading spaces and controls trimmed. */
const resolveUrl = (url) => decode(url).replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+/, "");

/**
 * A URL that is not a path on this origin: it has a scheme (https:, data:, blob:, javascript:…) or is
 * protocol-relative (a browser reads "\" as "/"). A data: URL counts unless the directive allows data:, as img-src does.
 */
const offOrigin = (url, { data = false } = {}) => {
  const resolved = resolveUrl(url);
  if (data && /^data:/i.test(resolved)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(resolved) || /^[\\/]{2}/.test(resolved);
};

/** The URL of each srcset candidate, without its width or density descriptor. */
const srcsetUrls = (value) =>
  decode(value)
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);

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
      const close = html.slice(tag.end).search(/<\/script[\s/>]/i);
      const text = html.slice(tag.end, close === -1 ? html.length : tag.end + close);
      const src = attr("src");
      if (src) {
        if (offOrigin(src.value)) found.push(`script from another origin or scheme: ${src.value}`);
        if (text.trim()) found.push(`<script src="${src.value}"> also carries inline text`);
      } else if (!allowed.has(inlineHash(text))) {
        found.push(`inline <script> without a matching hash in script-src (${inlineHash(text)}): ${text.trim().slice(0, 60)}`);
      }
    }
    if (tag.name === "style") found.push("inline <style> element (style-src has no 'unsafe-inline')");
    if (tag.name === "base") found.push("<base> element (base-uri is 'none')");
    if (tag.name === "link") {
      const rels = (attr("rel")?.value ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const loads = rels.filter((rel) => LOADING_RELS.has(rel));
      const href = attr("href")?.value;
      // An icon is an image, which img-src allows as data:; every other loading rel is a script, style or fetch.
      const data = loads.length > 0 && loads.every((rel) => IMAGE_RELS.has(rel));
      if (loads.length && href && offOrigin(href, { data })) found.push(`<link rel="${rels.join(" ")}"> from another origin or scheme: ${href}`);
      for (const url of srcsetUrls(attr("imagesrcset")?.value ?? "")) {
        if (loads.length && offOrigin(url, { data: true })) found.push(`<link imagesrcset> from another origin: ${url}`);
      }
    }
    if (tag.name === "form" || tag.name === "button" || tag.name === "input") {
      for (const name of ["action", "formaction"]) {
        const value = attr(name)?.value;
        // A javascript: action is reported above; anything else off this origin is blocked by form-action 'self'.
        if (value && offOrigin(value) && !/^javascript:/i.test(resolveUrl(value).replace(/[\s\u0000-\u001f]/g, ""))) {
          found.push(`<${tag.name} ${name}> posts to another origin: ${value}`);
        }
      }
    }
    if (MEDIA_TAGS.has(tag.name)) {
      for (const name of ["src", "poster", "data"]) {
        const value = attr(name)?.value;
        // img-src allows data:, so an image source may be one; media, frame and object sources may not.
        const image = name === "poster" || tag.name === "img" || (tag.name === "input" && name === "src");
        if (value && offOrigin(value, { data: image })) found.push(`<${tag.name} ${name}> from another origin: ${value}`);
      }
      for (const url of srcsetUrls(attr("srcset")?.value ?? "")) {
        if (offOrigin(url, { data: true })) found.push(`<${tag.name} srcset> from another origin: ${url}`);
      }
    }
  }
  return found;
}

// <link> rels that make the browser fetch the href (a stylesheet, script, image or other resource); alternate,
// canonical and the like only name a page.
const LOADING_RELS = new Set(["stylesheet", "modulepreload", "preload", "prefetch", "icon", "apple-touch-icon", "mask-icon", "manifest"]);
const IMAGE_RELS = new Set(["icon", "apple-touch-icon", "mask-icon"]);
const MEDIA_TAGS = new Set(["img", "video", "audio", "source", "track", "iframe", "embed", "object", "input", "frame"]);

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
