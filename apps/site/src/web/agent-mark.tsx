/**
 * The two-eyed APC agent mark from the site prototype. Eyes track the pointer when motion is
 * allowed, setting --ex / --ey via CSSOM (no inline style attributes).
 */
import { useEffect, useId } from "react";

let trackerUsers = 0;
let px = 0;
let py = 0;
let eyeRaf = 0;

function updateEyes() {
  eyeRaf = 0;
  for (const svg of document.querySelectorAll<SVGSVGElement>("svg[data-eye-track='true']")) {
    if (svg.getClientRects().length === 0) continue;
    const r = svg.getBoundingClientRect();
    const dx = px - (r.left + r.width / 2);
    const dy = py - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, d / 160) * 2.4;
    svg.style.setProperty("--ex", ((dx / d) * k).toFixed(2));
    svg.style.setProperty("--ey", ((dy / d) * k).toFixed(2));
  }
}

function onPointerMove(e: PointerEvent) {
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  px = e.clientX;
  py = e.clientY;
  if (!eyeRaf) eyeRaf = requestAnimationFrame(updateEyes);
}

function useEyeTracking(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    trackerUsers += 1;
    if (trackerUsers === 1) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
    }
    return () => {
      trackerUsers -= 1;
      if (trackerUsers === 0) {
        window.removeEventListener("pointermove", onPointerMove);
        if (eyeRaf) {
          cancelAnimationFrame(eyeRaf);
          eyeRaf = 0;
        }
      }
    };
  }, [enabled]);
}

export function AgentMark(props: { size?: number; track?: boolean; className?: string }) {
  const { size = 28, track = false, className } = props;
  const gradId = useId();
  useEyeTracking(track);

  return (
    <svg
      className={className ? `site-mark ${className}` : "site-mark"}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      data-eye-track={track ? "true" : undefined}
    >
      <defs>
        <radialGradient id={gradId} cx="38%" cy="28%" r="80%">
          <stop offset="0" stopColor="#4a505e" />
          <stop offset="0.55" stopColor="#23262e" />
          <stop offset="1" stopColor="#0e0f13" />
        </radialGradient>
      </defs>
      <path
        d="M24 3.5c10.6 0 19.5 7.6 19.5 19.2 0 12.4-8.2 21.8-20.3 21.8C11.6 44.5 4.5 36 4.5 24.6 4.5 12.6 12.6 3.5 24 3.5Z"
        fill={`url(#${gradId})`}
        stroke="rgb(255 255 255 / 0.5)"
        strokeWidth="1.2"
      />
      <g className="site-mark-lid">
        <g className="site-mark-pupils">
          <rect x="16.6" y="18.5" width="4.4" height="9.6" rx="2.2" fill="#fff" />
          <rect x="27" y="18.5" width="4.4" height="9.6" rx="2.2" fill="#fff" />
        </g>
      </g>
    </svg>
  );
}
