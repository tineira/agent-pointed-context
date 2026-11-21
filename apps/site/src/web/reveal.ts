/**
 * Scroll reveals: content is always visible by default (never hidden if JavaScript fails or
 * IntersectionObserver is unavailable), and completely static under prefers-reduced-motion.
 * When active, only elements currently below the initial viewport receive `.rv-wait` and rise
 * into place once they intersect.
 */
import { useEffect } from "react";

export interface RevealElementLike {
  classList: {
    add: (token: string) => void;
    remove: (token: string) => void;
    contains: (token: string) => boolean;
  };
  getBoundingClientRect: () => { top: number };
}

export interface ObserverEntryLike<T extends RevealElementLike = RevealElementLike> {
  isIntersecting: boolean;
  target: T;
}

export interface ObserverLike<T extends RevealElementLike = RevealElementLike> {
  observe: (el: T) => void;
  unobserve: (el: T) => void;
  disconnect: () => void;
}

export interface InitRevealsOptions<T extends RevealElementLike = RevealElementLike> {
  elements: readonly T[];
  viewportHeight: number;
  reducedMotion: boolean;
  createObserver: ((onEntries: (entries: readonly ObserverEntryLike<T>[]) => void) => ObserverLike<T>) | null;
}

export function initReveals<T extends RevealElementLike>(options: InitRevealsOptions<T>): () => void {
  const { elements, viewportHeight, reducedMotion, createObserver } = options;

  const revealAll = () => {
    for (const el of elements) {
      el.classList.remove("rv-wait");
      el.classList.add("rv-in");
    }
  };

  if (reducedMotion || !createObserver || elements.length === 0) {
    revealAll();
    return () => undefined;
  }

  const pending = new Set<T>();
  const observer = createObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.remove("rv-wait");
      entry.target.classList.add("rv-in");
      pending.delete(entry.target);
      observer.unobserve(entry.target);
    }
  });

  const fold = viewportHeight * 0.95;
  for (const el of elements) {
    if (el.getBoundingClientRect().top <= fold) {
      el.classList.remove("rv-wait");
      el.classList.add("rv-in");
    } else {
      el.classList.add("rv-wait");
      pending.add(el);
      observer.observe(el);
    }
  }

  return () => {
    observer.disconnect();
    for (const el of pending) {
      el.classList.remove("rv-wait");
      el.classList.add("rv-in");
    }
    pending.clear();
  };
}

export function useScrollReveals(): void {
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    const elements = [...document.querySelectorAll<HTMLElement>(".rv")];

    const start = () =>
      initReveals<Element>({
        elements,
        viewportHeight: window.innerHeight,
        reducedMotion: mq?.matches ?? false,
        createObserver:
          typeof IntersectionObserver === "function"
            ? (cb) => new IntersectionObserver((entries) => cb(entries), { rootMargin: "0px 0px -6% 0px" })
            : null,
      });

    let cleanup = start();
    const onMotionChange = () => {
      cleanup();
      cleanup = start();
    };
    mq?.addEventListener("change", onMotionChange);
    return () => {
      mq?.removeEventListener("change", onMotionChange);
      cleanup();
    };
  }, []);
}
