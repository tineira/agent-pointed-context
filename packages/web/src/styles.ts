/**
 * Attaches a component's CSS to a document or shadow root once, using a constructable
 * `CSSStyleSheet` (`adoptedStyleSheets`) so pages with a strict Content-Security-Policy
 * (`style-src 'self'`, no `'unsafe-inline'`) do not block it.
 *
 * Where constructable stylesheets are unavailable (older browsers or minimal test DOMs),
 * falls back to injecting a `<style>` element, which needs a page that allows inline style.
 */

export type StyleRoot = Document | ShadowRoot;

const adoptedByRoot = new WeakMap<object, Map<string, CSSStyleSheet>>();

/** Returns the shadow root or document an element lives in, defaulting to `document`. */
export function styleRootOf(el: { getRootNode?: () => unknown; ownerDocument?: Document | null } | null | undefined): StyleRoot {
  const root = typeof el?.getRootNode === "function" ? el.getRootNode() : null;
  if (root && typeof root === "object" && ("adoptedStyleSheets" in root || "head" in root || "host" in root)) {
    return root as StyleRoot;
  }
  return el?.ownerDocument ?? document;
}

/**
 * Fallback for environments without constructable `CSSStyleSheet` / `adoptedStyleSheets`:
 * injects a `<style id="...">` element once into the root. Needs a page whose CSP allows inline style.
 */
function injectStyleFallback(id: string, css: string, root: StyleRoot): void {
  const existing = "getElementById" in root && typeof root.getElementById === "function" ? root.getElementById(id) : null;
  if (existing) return;
  const doc = "createElement" in root && typeof root.createElement === "function" ? root : (root as ShadowRoot).ownerDocument ?? document;
  const style = doc.createElement("style");
  style.id = id;
  style.textContent = css;
  if ("head" in root && root.head) root.head.append(style);
  else if ("append" in root && typeof root.append === "function") root.append(style);
}

/**
 * Adopts `css` once under `id` on `root` (defaults to `document`) via `adoptedStyleSheets`,
 * falling back to `injectStyleFallback` where constructable stylesheets are unavailable.
 */
export function adoptStyle(id: string, css: string, root: StyleRoot = document): void {
  const adopted = (root as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets;
  const win = "defaultView" in root ? root.defaultView : (root as ShadowRoot).ownerDocument?.defaultView;
  const SheetCtor = (win as (Window & typeof globalThis) | null)?.CSSStyleSheet ?? globalThis.CSSStyleSheet;

  if (Array.isArray(adopted) && typeof SheetCtor === "function" && typeof SheetCtor.prototype?.replaceSync === "function") {
    let sheets = adoptedByRoot.get(root);
    const existing = sheets?.get(id);
    if (existing && adopted.includes(existing)) return;
    try {
      const sheet = new SheetCtor();
      sheet.replaceSync(css);
      try {
        // Prefer in-place ObservableArray mutation (Chrome 99+, Firefox 101+, Safari 16.4+)
        // to avoid WebKit bug 254844 (Safari 16.4-17.0 dropping earlier sheets on reassignment).
        // Fall back to array replacement for older Chromium (73-98) where adoptedStyleSheets was frozen.
        adopted.push(sheet);
      } catch {
        (root as { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets = [...adopted, sheet];
      }
      if (!sheets) {
        sheets = new Map();
        adoptedByRoot.set(root, sheets);
      }
      sheets.set(id, sheet);
      return;
    } catch {
      // Constructable stylesheets threw (e.g. non-constructable CSSStyleSheet); fall through to <style>.
    }
  }

  injectStyleFallback(id, css, root);
}
