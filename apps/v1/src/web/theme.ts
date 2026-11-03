/**
 * Light and dark, as on hue.tineira.com: Slate Light and Slate. The choice is a per-viewer
 * convenience in localStorage; with none stored, the system's preference wins. index.html applies
 * it before first paint so there is no flash.
 */
export const THEME_STORAGE_KEY = "apc-theme";
export type ThemeId = "slate-light" | "slate";

export function currentTheme(): ThemeId {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "slate" || set === "slate-light") return set;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "slate" : "slate-light";
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute("data-theme", id);
  document.documentElement.setAttribute("data-scheme", id === "slate" ? "dark" : "light");
}

export function chooseTheme(id: ThemeId): void {
  applyTheme(id);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // private mode or blocked storage: the theme still applies for this page
  }
}
