/**
 * The dock's control icons (TIN-699): drawn with currentColor, sized by their button, hidden from
 * screen readers. Every button that shows one names itself (aria-label or a visually hidden label).
 */
const props = { width: 16, height: 16, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

/** Float: a small window on top of a bigger one; drawn empty (filled = false) for an agent that does not float. */
export function FloatIcon(p: { filled?: boolean }) {
  const filled = p.filled ?? true;
  return (
    <svg {...props}>
      <rect x="2" y="4" width="16" height="12" rx="2" />
      <rect x="10" y="9.5" width="6" height="4.5" rx="1" {...(filled ? { fill: "currentColor", stroke: "none" } : { strokeWidth: 1.3, strokeDasharray: "2 1.5" })} />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...props}>
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg {...props} stroke="none" fill="currentColor">
      <circle cx="4.5" cy="10" r="1.6" />
      <circle cx="10" cy="10" r="1.6" />
      <circle cx="15.5" cy="10" r="1.6" />
    </svg>
  );
}

export function InstallIcon() {
  return (
    <svg {...props}>
      <path d="M10 3v9M6 8.5 10 12.5l4-4M4 16h12" />
    </svg>
  );
}
