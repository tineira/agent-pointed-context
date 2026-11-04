/** A public UI hint only. A page can forge this; it grants no access or checklist progress. */
export const EXTENSION_PRESENT = "data-apc-extension-installed";

/**
 * The installed extension's version (its manifest's, e.g. "0.2.131"), next to `EXTENSION_PRESENT`, so the dock
 * page can say when it is out of date. A hint like presence: it only decides whether a notice shows. Builds
 * before 0.2 set no version.
 */
export const EXTENSION_VERSION = "data-apc-extension-version";

export function markDockPresence(root: { setAttribute(name: string, value: string): void }, version: string): void {
  root.setAttribute(EXTENSION_PRESENT, "");
  root.setAttribute(EXTENSION_VERSION, version);
}

/**
 * Orders two extension versions as Chrome does (each dot-separated integer in turn, a missing one as 0):
 * negative when `a` is older, 0 when they are equal, positive when `a` is newer; NaN when either is not 1 to 4
 * dot-separated integers.
 */
export function compareExtensionVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d{1,5}(\.\d{1,5}){0,3}$/.test(v) ? v.split(".").map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return Number.NaN;
  for (let i = 0; i < 4; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Whether the dock page tells the person their extension is out of date: only when it reports a version
 * (`installed`) and the dock knows the latest one (`latest`, baked in when the dock was built), and the installed
 * one is older. A build too old to report a version, or a version that does not parse, shows nothing.
 */
export function extensionOutdated(installed: string | null, latest: string | null): boolean {
  if (!installed || !latest) return false;
  return compareExtensionVersions(installed, latest) < 0;
}
