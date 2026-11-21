import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { defined, doc, El } from "./fake-dom.ts";
import { defineAgentBar } from "../src/agents-bar.ts";
import { definePinBadge } from "../src/pin-badge.ts";
import { adoptStyle, styleRootOf } from "../src/styles.ts";
import { createPet } from "../src/pet.ts";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("No source in packages/web/src injects <style> or sets a style attribute outside the documented fallback (TIN-1065)", () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts")).sort();
  assert.ok(files.length > 0, "expected source files in packages/web/src");

  const createStyleRe = /\bcreateElement\s*\(\s*["'`]style["'`]/g;
  const setStyleAttrRe = /\bsetAttribute\s*\(\s*["'`]style["'`]/g;
  const inlineStyleAttrRe = /\bstyle\s*=\s*["']/g;

  for (const file of files) {
    const src = readFileSync(join(SRC_DIR, file), "utf8");
    // Strip block and line comments so prose in comments is not mistaken for code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

    assert.equal(code.match(setStyleAttrRe), null, `${file} must not call setAttribute("style", ...)`);
    assert.equal(code.match(inlineStyleAttrRe), null, `${file} must not emit inline style="..." attributes`);

    if (file === "styles.ts") {
      // Only the documented injectStyleFallback function may call createElement("style").
      const fallbackStart = code.indexOf("function injectStyleFallback(");
      assert.ok(fallbackStart !== -1, "styles.ts must define injectStyleFallback");
      const fallbackEnd = code.indexOf("\nexport function adoptStyle(", fallbackStart);
      assert.ok(fallbackEnd !== -1, "styles.ts must define adoptStyle after injectStyleFallback");
      const outsideFallback = code.slice(0, fallbackStart) + code.slice(fallbackEnd);
      assert.equal(outsideFallback.match(createStyleRe), null, "styles.ts must not call createElement(\"style\") outside injectStyleFallback");
      const insideFallback = code.slice(fallbackStart, fallbackEnd);
      assert.equal((insideFallback.match(createStyleRe) ?? []).length, 1, "injectStyleFallback should have the single fallback createElement(\"style\")");
    } else {
      assert.equal(code.match(createStyleRe), null, `${file} must not call createElement("style") directly; use adoptStyle()`);
    }
  }
});

class FakeCSSStyleSheet {
  cssText = "";
  replaceSync(text: string): void {
    this.cssText = text;
  }
}

test("adoptStyle uses constructable CSSStyleSheet via root.defaultView and prefers push() with frozen-array fallback", () => {
  class GlobalCSSStyleSheet {
    cssText = "";
    replaceSync(text: string): void {
      this.cssText = text;
    }
  }
  class DocCSSStyleSheet extends FakeCSSStyleSheet {}

  const prevSheet = globalThis.CSSStyleSheet;
  (globalThis as Record<string, unknown>).CSSStyleSheet = GlobalCSSStyleSheet;
  try {
    const head = new El("head");
    const adoptedList: FakeCSSStyleSheet[] = [];
    const rootDoc = {
      head,
      defaultView: { CSSStyleSheet: DocCSSStyleSheet },
      adoptedStyleSheets: adoptedList,
      getElementById: () => null,
      createElement: () => {
        throw new Error("createElement must not be called when adoptedStyleSheets is supported");
      },
    } as unknown as Document;

    adoptStyle("test-sheet", ".a { color: red; }", rootDoc);
    adoptStyle("test-sheet", ".a { color: red; }", rootDoc);

    const sheets = (rootDoc as unknown as { adoptedStyleSheets: FakeCSSStyleSheet[] }).adoptedStyleSheets;
    assert.equal(sheets, adoptedList, "prefers in-place push() without replacing adoptedStyleSheets");
    assert.equal(sheets.length, 1, "one adopted sheet per root for the same id");
    assert.ok(sheets[0] instanceof DocCSSStyleSheet, "takes the Document defaultView.CSSStyleSheet branch");
    assert.equal(sheets[0]!.cssText, ".a { color: red; }");
    assert.equal(head.children.length, 0, "no <style> element created");

    // A second root (e.g. a ShadowRoot) adopts its own sheet independently via ownerDocument.defaultView.
    const shadowRoot = {
      host: new El("div"),
      ownerDocument: rootDoc,
      adoptedStyleSheets: [] as FakeCSSStyleSheet[],
      getElementById: () => null,
    } as unknown as ShadowRoot;

    adoptStyle("test-sheet", ".a { color: red; }", shadowRoot);
    adoptStyle("test-sheet", ".a { color: red; }", shadowRoot);
    const shadowSheets = (shadowRoot as unknown as { adoptedStyleSheets: FakeCSSStyleSheet[] }).adoptedStyleSheets;
    assert.equal(shadowSheets.length, 1);
    assert.ok(shadowSheets[0] instanceof DocCSSStyleSheet);
    assert.equal(shadowSheets[0]!.cssText, ".a { color: red; }");
    assert.equal(sheets.length, 1);

    assert.equal(styleRootOf({ getRootNode: () => shadowRoot, ownerDocument: rootDoc }), shadowRoot);

    // Older Chromium (73-98): frozen adoptedStyleSheets throws on push() and falls back to reassignment.
    const frozenDoc = {
      head: new El("head"),
      defaultView: { CSSStyleSheet: DocCSSStyleSheet },
      adoptedStyleSheets: Object.freeze([] as FakeCSSStyleSheet[]),
      getElementById: () => null,
      createElement: () => {
        throw new Error("createElement must not be called on frozen-array fallback");
      },
    } as unknown as Document;

    adoptStyle("frozen-sheet", ".f { display: flex; }", frozenDoc);
    const replaced = (frozenDoc as unknown as { adoptedStyleSheets: FakeCSSStyleSheet[] }).adoptedStyleSheets;
    assert.equal(replaced.length, 1, "frozen adoptedStyleSheets falls back to array replacement");
    assert.equal(replaced[0]!.cssText, ".f { display: flex; }");
  } finally {
    if (prevSheet === undefined) delete (globalThis as Record<string, unknown>).CSSStyleSheet;
    else (globalThis as Record<string, unknown>).CSSStyleSheet = prevSheet;
  }
});

test("<apc-agents> in a shadow root adopts document-level padding on ownerDocument and element rules on the shadow root (TIN-1065)", () => {
  defineAgentBar();
  const ApcAgents = defined.get("apc-agents");
  assert.ok(ApcAgents, "defineAgentBar registers apc-agents");

  const ownerHtml = new El("html");
  const ownerDoc = {
    documentElement: ownerHtml,
    head: new El("head"),
    defaultView: {
      CSSStyleSheet: FakeCSSStyleSheet,
      matchMedia: () => ({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    adoptedStyleSheets: [] as FakeCSSStyleSheet[],
    getElementById: () => null,
    createElement: () => {
      throw new Error("createElement must not be called when adoptedStyleSheets is supported");
    },
  } as unknown as Document;

  const shadowRoot = {
    host: new El("div"),
    ownerDocument: ownerDoc,
    adoptedStyleSheets: [] as FakeCSSStyleSheet[],
    getElementById: () => null,
  } as unknown as ShadowRoot;

  const bar = new ApcAgents() as El & {
    connectedCallback(): void;
    disconnectedCallback(): void;
    getRootNode: () => unknown;
    offsetHeight: number;
  };
  Object.defineProperty(bar, "ownerDocument", { value: ownerDoc, configurable: true });
  Object.defineProperty(bar, "isConnected", { value: true, configurable: true });
  bar.getRootNode = () => shadowRoot;
  bar.offsetHeight = 48;

  bar.connectedCallback();

  const shadowSheets = (shadowRoot as unknown as { adoptedStyleSheets: FakeCSSStyleSheet[] }).adoptedStyleSheets;
  const docSheets = (ownerDoc as unknown as { adoptedStyleSheets: FakeCSSStyleSheet[] }).adoptedStyleSheets;

  assert.equal(shadowSheets.length, 1, "element rules adopted on the shadow root");
  assert.match(shadowSheets[0]!.cssText, /apc-agents\s*\{/);
  assert.doesNotMatch(shadowSheets[0]!.cssText, /html\.apc-bar-fixed\s+body/, "document-level rule must not live only on the shadow root");

  assert.equal(docSheets.length, 1, "document-level padding rule adopted on ownerDocument");
  assert.match(docSheets[0]!.cssText, /html\.apc-bar-fixed\s+body\s*\{[^}]*padding-bottom:/);

  assert.equal(ownerHtml.classes.has("apc-bar-fixed"), true, "apc-bar-fixed set on ownerDocument.documentElement");
  assert.equal(ownerHtml.style.getPropertyValue("--apc-bar-height"), "48px", "--apc-bar-height set on ownerDocument.documentElement");
  assert.equal(doc.documentElement.classes.has("apc-bar-fixed"), false, "module document.documentElement is untouched");

  bar.disconnectedCallback();
  assert.equal(ownerHtml.classes.has("apc-bar-fixed"), false, "disconnect clears apc-bar-fixed on ownerDocument");
  assert.equal(ownerHtml.style.getPropertyValue("--apc-bar-height"), "", "disconnect clears --apc-bar-height on ownerDocument");
});

test("<apc-pin> adopts its stylesheet via adoptedStyleSheets with no <style> element on the strict path (TIN-1065)", () => {
  definePinBadge();
  const ApcPin = defined.get("apc-pin");
  assert.ok(ApcPin, "definePinBadge registers apc-pin");

  const strictHead = new El("head");
  const strictDoc = {
    head: strictHead,
    defaultView: { CSSStyleSheet: FakeCSSStyleSheet },
    adoptedStyleSheets: [] as FakeCSSStyleSheet[],
    getElementById: (id: string) => strictHead.children.find((c) => c instanceof El && c.attrs.get("id") === id) ?? null,
    createElement: (tag: string) => {
      if (tag === "style") throw new Error("strict path must not inject <style>");
      return new El(tag);
    },
  } as unknown as Document;

  const pin = new ApcPin() as El & {
    connectedCallback(): void;
    getRootNode: () => unknown;
  };
  Object.defineProperty(pin, "ownerDocument", { value: strictDoc, configurable: true });
  pin.getRootNode = () => strictDoc;
  pin.connectedCallback();

  const sheets = (strictDoc as unknown as { adoptedStyleSheets: FakeCSSStyleSheet[] }).adoptedStyleSheets;
  assert.equal(sheets.length, 1, "one adopted stylesheet for <apc-pin>");
  assert.match(sheets[0]!.cssText, /apc-pin\s*\{/);
  assert.equal(strictDoc.getElementById("apc-pin-style"), null, "no <style id='apc-pin-style'> on strict path");
});

test("adoptStyle falls back to a single <style> element when adoptedStyleSheets is unavailable", () => {
  const head = new El("head");
  const legacyDoc = {
    head,
    getElementById: (id: string) => head.children.find((c) => c instanceof El && c.attrs.get("id") === id) ?? null,
    createElement: (tag: string) => {
      const e = new El(tag);
      Object.defineProperty(e, "id", { set: (v: string) => e.setAttribute("id", v) });
      return e;
    },
  } as unknown as Document;

  adoptStyle("legacy-sheet", ".b { display: block; }", legacyDoc);
  adoptStyle("legacy-sheet", ".b { display: block; }", legacyDoc);

  assert.equal(head.children.length, 1, "fallback injects one <style> element");
  const styleEl = head.children[0] as El;
  assert.equal(styleEl.tagName, "STYLE");
  assert.equal(styleEl.getAttribute("id"), "legacy-sheet");
  assert.equal(styleEl.textContent, ".b { display: block; }");
});

test("createPet sizes the SVG via CSSOM style.setProperty, never setAttribute('style', ...)", () => {
  const win = globalThis.window as unknown as Record<string, unknown>;
  const prevWinDoc = win.document;
  const prevMatchMedia = win.matchMedia;
  win.document = doc;
  win.matchMedia = (q: string) => ({
    matches: q.includes("reduced-motion"),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  const setAttrCalls: Array<[string, string]> = [];
  const origSetAttr = El.prototype.setAttribute;
  El.prototype.setAttribute = function (k: string, v: string) {
    setAttrCalls.push([k, v]);
    return origSetAttr.call(this, k, v);
  };
  try {
    const pet = createPet({ state: "idle", label: "Claude" }, doc as unknown as Document);
    assert.equal(
      setAttrCalls.filter(([k]) => k.toLowerCase() === "style").length,
      0,
      "createPet must not call setAttribute('style', ...)",
    );
    const svg = pet.element as unknown as El;
    assert.equal(svg.style.getPropertyValue("width"), "var(--apc-pet-size, 100%)");
    assert.equal(svg.style.getPropertyValue("height"), "var(--apc-pet-size, 100%)");

    pet.update({ size: 48 });
    assert.equal(svg.style.getPropertyValue("width"), "");
    assert.equal(svg.style.getPropertyValue("height"), "");
    assert.equal(svg.getAttribute("width"), "48");
    assert.equal(svg.getAttribute("height"), "48");
    pet.destroy();
  } finally {
    El.prototype.setAttribute = origSetAttr;
    win.document = prevWinDoc;
    win.matchMedia = prevMatchMedia;
  }
});
