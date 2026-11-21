/**
 * Theme management for the standard's site: follows prefers-color-scheme by default, with a
 * header toggle persisted per browser in localStorage (wrapped in try/catch so blocked storage
 * never breaks the page). A tiny blocking script at /site-assets/theme.js applies the same rule
 * before first paint under script-src 'self'.
 */
import { useCallback, useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "apc-theme";

export type Theme = "light" | "dark";

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

const listeners = new Set<(theme: Theme) => void>();

export function readStoredTheme(storage?: Pick<Storage, "getItem"> | null): Theme | null {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    const value = store?.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredTheme(theme: Theme, storage?: Pick<Storage, "setItem"> | null): boolean {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    if (!store) return false;
    store.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

export function resolveTheme(stored: Theme | null, prefersLight: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersLight ? "light" : "dark";
}

export function applyTheme(theme: Theme, root?: HTMLElement | null): void {
  const target = root === undefined ? (typeof document !== "undefined" ? document.documentElement : null) : root;
  if (target) target.dataset.theme = theme;
  for (const listener of listeners) listener(theme);
}

export function subscribeTheme(listener: (theme: Theme) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function prefersLightNow(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
}

export function currentTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.dataset.theme;
    if (attr === "light" || attr === "dark") return attr;
  }
  return resolveTheme(readStoredTheme(), prefersLightNow());
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [chosen, setChosen] = useState<boolean>(() => readStoredTheme() !== null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const unsub = subscribeTheme((next) => setTheme(next));
    if (typeof matchMedia !== "function") return unsub;
    const mq = matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (chosen || readStoredTheme() !== null) return;
      const next: Theme = mq.matches ? "light" : "dark";
      setTheme(next);
      applyTheme(next);
    };
    mq.addEventListener("change", onChange);
    return () => {
      unsub();
      mq.removeEventListener("change", onChange);
    };
  }, [chosen]);

  const toggleTheme = useCallback(() => {
    setChosen(true);
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      writeStoredTheme(next);
      applyTheme(next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
