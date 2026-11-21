/**
 * Theme storage, system fallback, and the pre-paint script loaded in <head> (no flash under
 * script-src 'self', safe when localStorage throws).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { applyTheme, readStoredTheme, resolveTheme, subscribeTheme, THEME_STORAGE_KEY, writeStoredTheme, type Theme } from "../src/web/theme.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("readStoredTheme and writeStoredTheme handle valid, invalid, and throwing storage", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };

  assert.equal(readStoredTheme(storage), null);
  assert.equal(writeStoredTheme("light", storage), true);
  assert.equal(map.get(THEME_STORAGE_KEY), "light");
  assert.equal(readStoredTheme(storage), "light");

  map.set(THEME_STORAGE_KEY, "sepia");
  assert.equal(readStoredTheme(storage), null, "unknown stored value is ignored");

  const broken = {
    getItem: () => {
      throw new Error("SecurityError: blocked");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.equal(readStoredTheme(broken), null);
  assert.equal(writeStoredTheme("dark", broken), false);
});

test("resolveTheme prefers stored choice and otherwise follows prefers-color-scheme", () => {
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme(null, true), "light");
  assert.equal(resolveTheme(null, false), "dark");
});

test("applyTheme sets data-theme and notifies subscribers", () => {
  const seen: Theme[] = [];
  const unsub = subscribeTheme((t) => seen.push(t));
  const fakeRoot = { dataset: {} as DOMStringMap } as unknown as HTMLElement;
  applyTheme("light", fakeRoot);
  applyTheme("dark", fakeRoot);
  unsub();
  applyTheme("light", fakeRoot);
  assert.equal(fakeRoot.dataset.theme, "light");
  assert.deepEqual(seen, ["light", "dark"]);
});

test("index.html loads /site-assets/theme.js synchronously in <head> before the app bundle, with no inline script", () => {
  const html = read("apps/site/index.html");
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  assert.match(head, /<script src="\/site-assets\/theme\.js"><\/script>/);
  assert.doesNotMatch(head, /<script[^>]+(?:async|defer|type="module")/, "pre-paint script must block before first paint");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
});

test("public/site-assets/theme.js sets data-theme before paint and survives throwing localStorage", () => {
  const script = read("apps/site/public/site-assets/theme.js");
  assert.ok(script.includes(`"${THEME_STORAGE_KEY}"`), "uses shared storage key");

  const run = (opts: { stored?: string | null; throwStorage?: boolean; prefersLight: boolean }) => {
    const dataset: Record<string, string> = {};
    const sandbox = {
      document: { documentElement: { dataset } },
      matchMedia: (q: string) => ({ matches: q === "(prefers-color-scheme: light)" ? opts.prefersLight : false }),
      localStorage: {
        getItem: (key: string) => {
          if (opts.throwStorage) throw new Error("blocked");
          return key === THEME_STORAGE_KEY ? (opts.stored ?? null) : null;
        },
      },
    };
    vm.runInNewContext(script, sandbox);
    return dataset.theme;
  };

  assert.equal(run({ stored: "light", prefersLight: false }), "light");
  assert.equal(run({ stored: "dark", prefersLight: true }), "dark");
  assert.equal(run({ stored: null, prefersLight: true }), "light");
  assert.equal(run({ stored: null, prefersLight: false }), "dark");
  assert.equal(run({ stored: "bogus", prefersLight: true }), "light");
  assert.equal(run({ throwStorage: true, prefersLight: true }), "light");
  assert.equal(run({ throwStorage: true, prefersLight: false }), "dark");
});
