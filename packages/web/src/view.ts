import type { FocusParams } from "@apc/protocol";

export interface ReportedView {
  screen: string;
  params: FocusParams;
  selection: { kind: string; id: string } | null;
}

/**
 * Report the screen as identifiers, debounced (1 s by default) and only while
 * the tab is visible. The host's endpoint applies the allowlist; this only
 * avoids sending what would be dropped anyway.
 */
export function createViewReporter(send: (view: ReportedView) => void, debounceMs = 1000): (view: ReportedView) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = "";
  let pending: ReportedView | null = null;

  const flush = () => {
    timer = null;
    if (!pending || document.visibilityState !== "visible") return;
    const key = JSON.stringify(pending);
    if (key === last) return;
    last = key;
    send(pending);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && pending) {
      last = "";
      flush();
    }
  });

  return (view) => {
    pending = view;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };
}
