// Public demo/download links copied from Dock setup; no runtime dependency on the hub.
export const APPS = [
  {
    name: "Pulse",
    url: import.meta.env.DEV ? "http://localhost:5199/overview" : "https://pulse.apc.tineira.com/overview",
    glyph: (
      <svg viewBox="0 0 32 32" width="22" height="22">
        <rect x="4" y="8" width="20" height="20" rx="5" fill="none" stroke="currentColor" strokeWidth="3.5" />
        <circle cx="24" cy="8" r="5.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    name: "Signals",
    url: import.meta.env.DEV ? "http://localhost:5201/" : "https://signals.apc.tineira.com/",
    glyph: (
      <svg viewBox="0 0 28 28" width="22" height="22">
        <circle cx="14" cy="14" r="11.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="14" cy="14" r="5.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="14" cy="14" r="2" fill="currentColor" />
      </svg>
    ),
  },
];

export const DESKTOP_SHELL = (window as { __APC_SHELL__?: string }).__APC_SHELL__ === "desktop";
export const DOCK_DESKTOP = {
  url: "https://github.com/tineira/agent-pointed-context/releases/download/dock-desktop/APCDockSetup.exe",
  note: "Unsigned for now: Windows asks once (More info, then Run anyway).",
  offered: !DESKTOP_SHELL && /Windows/.test(navigator.userAgent),
};

export const DESKTOP = [{ label: "Windows", match: /Windows/, url: "https://github.com/tineira/agent-pointed-context/releases/download/pulse-desktop/PulseDesktop.exe", note: "Unsigned for now: Windows asks once (More info, then Run anyway)." }];
