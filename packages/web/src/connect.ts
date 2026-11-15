import { decodeApcConnect, type ApcConnectFragment } from "@tineira/apc-protocol";

/** Run synchronously before other scripts or redirects. Clears the fragment even when malformed. */
export function takeApcConnect(page: { location: Pick<Location, "hash" | "pathname" | "search">; history: Pick<History, "state" | "replaceState">; sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> } = window): ApcConnectFragment | null {
  const hash = page.location.hash;
  if (hash.startsWith("#apc_connect=")) {
    page.history.replaceState(page.history.state, "", page.location.pathname + page.location.search);
    page.sessionStorage.removeItem("apc_connect");
    const fragment = decodeApcConnect(hash);
    if (fragment) page.sessionStorage.setItem("apc_connect", JSON.stringify(fragment));
    return fragment;
  }
  const saved = page.sessionStorage.getItem("apc_connect");
  if (!saved) return null;
  try {
    // Validate stored data using the same wire decoder.
    const bytes = new TextEncoder().encode(saved);
    const base = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return decodeApcConnect("#apc_connect=" + base);
  } catch { return null; }
}
export function clearApcConnect(storage: Pick<Storage, "removeItem"> = sessionStorage): void {
  storage.removeItem("apc_connect");
}
