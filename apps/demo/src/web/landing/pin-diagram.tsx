import type { CSSProperties } from "react";
import { CARD_HEADER } from "../ui.tsx";

/**
 * The hero drawing, in the line style of the Round's exploded view on hue.tineira.com: an
 * agent's mark is dragged onto a bar (1), only a key travels (2), and the person's own agent
 * reads the data behind it with its own tools and joins it with what it already knows (3).
 * A 9 s CSS loop (theme.css, .pd-*); still with reduced motion.
 */
const BARS = [70, 84, 96, 92, 110, 124, 118, 132];
const TARGET = 5;
const BASE = 244;
const X0 = 48;
const STEP = 32;
const W = 20;

export function PinDiagram() {
  const tx = X0 + TARGET * STEP;
  const th = BARS[TARGET]!;
  const markStart = { x: 292, y: 6 };
  const markEnd = { x: tx - 1, y: BASE - th - 26 };
  const markStyle = { "--pd-dx": `${markEnd.x - markStart.x}px`, "--pd-dy": `${markEnd.y - markStart.y}px` } as CSSProperties;
  const ink = "var(--foreground)";
  const mute = "var(--muted)";
  const line = "var(--line)";
  const accent = "var(--filament)";
  const mono = { fontFamily: "var(--font-mono)" };

  return (
    <article className="relative w-full overflow-hidden rounded-[20px] border border-line bg-cream">
      <div className={CARD_HEADER}>
        <span>Pulse · one pin, end to end</span>
        <span>Example</span>
      </div>
      <div className="bp-grid relative aspect-[520/440] w-full">
        <svg viewBox="0 0 520 440" className="absolute inset-0 h-full w-full" role="img" aria-label="An agent's mark dragged onto a bar of a chart; a key with kind, key and month travels to the person's own agent, which reads the figure and joins it with the person's MRR file.">
          {/* The app's window */}
          <rect x="24" y="36" width="300" height="230" rx="10" fill="var(--cream)" stroke={ink} strokeWidth="1.3" />
          <line x1="24" y1="60" x2="324" y2="60" stroke={ink} strokeWidth="1" />
          {[38, 50, 62].map((cx) => (
            <circle key={cx} cx={cx} cy="48" r="3" fill="none" stroke={ink} strokeWidth="1" />
          ))}
          <text x="76" y="51.5" fontSize="10" fill={mute} style={mono}>
            pulse · active customers per month
          </text>
          <line x1="40" y1={BASE} x2="308" y2={BASE} stroke={mute} strokeWidth="1" />
          {BARS.map((h, i) => (
            <rect key={i} x={X0 + i * STEP} y={BASE - h} width={W} height={h} rx="2" fill={i === TARGET ? "var(--filament-soft)" : line} stroke={ink} strokeWidth="1.1" />
          ))}

          {/* What the person pointed at */}
          <rect className="pd-target" x={tx - 4} y={BASE - th - 4} width={W + 8} height={th + 8} rx="4" fill="none" stroke={accent} strokeWidth="1.6" strokeDasharray="4 3" />

          {/* The key travels: to the agent, never the pixels */}
          <path className="pd-wire" d={`M ${tx + W + 4} ${BASE - th + 30} C 300 ${BASE - th + 30}, 300 186, 338 186`} fill="none" stroke={accent} strokeWidth="1.4" />
          <path className="pd-wire" d="M 421 226 L 421 284" fill="none" stroke={accent} strokeWidth="1.4" />

          <g className="pd-key">
            <rect x="338" y="148" width="166" height="78" rx="8" fill="var(--cream)" stroke={ink} strokeWidth="1.2" />
            <text x="350" y="166" fontSize="8.5" fill={mute} letterSpacing="0.6" style={mono}>
              PIN · KEYS ONLY
            </text>
            {[
              ["kind", "figure"],
              ["key", "active_customers"],
              ["month", "2026-03"],
            ].map(([k, v], i) => (
              <text key={k} x="350" y={184 + i * 14} fontSize="10" fill={ink} style={mono}>
                <tspan fill={mute}>{k}: </tspan>
                {v}
              </text>
            ))}
          </g>

          {/* The person's own agent */}
          <rect x="300" y="286" width="204" height="124" rx="12" fill="var(--cream)" stroke={ink} strokeWidth="1.3" />
          <text x="316" y="305" fontSize="8.5" fill={mute} letterSpacing="0.6" style={mono}>
            YOUR AGENT
          </text>
          <g className="pd-read">
            <text x="316" y="326" fontSize="10" fill={ink} style={mono}>
              <tspan fill={accent}>get_figure</tspan> → 121 customers
            </text>
            <g transform="translate(316 336)">
              <path d="M0 0h8l3 3v10H0z" fill="none" stroke={ink} strokeWidth="1" strokeLinejoin="round" />
              <text x="16" y="10" fontSize="10" fill={ink} style={mono}>
                mrr.csv <tspan fill={mute}>· yours, not Pulse's</tspan>
              </text>
            </g>
          </g>
          <g className="pd-answer">
            <text x="316" y="380" fontSize="14" fontWeight="600" fill={ink}>
              $48,210.37 MRR
            </text>
            <text x="316" y="397" fontSize="10" fill={mute} style={mono}>
              best per seat: cus_0042
            </text>
          </g>

          {/* Callouts, as on the exploded view */}
          {[
            { n: 1, x: tx - 22, y: BASE - th - 40, lx: tx + 2, ly: BASE - th - 10 },
            { n: 2, x: 352, y: 128, lx: 360, ly: 148 },
            { n: 3, x: 282, y: 300, lx: 300, ly: 304 },
          ].map((c) => (
            <g key={c.n}>
              <line x1={c.x} y1={c.y} x2={c.lx} y2={c.ly} stroke={mute} strokeWidth="1" />
              <circle cx={c.x} cy={c.y} r="9" fill="var(--cream)" stroke={mute} strokeWidth="1.1" />
              <text x={c.x} y={c.y + 3.5} textAnchor="middle" fontSize="10" fill={mute} style={mono}>
                {c.n}
              </text>
            </g>
          ))}

          {/* The agent's mark, dragged from the top bar onto the bar */}
          <g className="pd-mark" style={markStyle}>
            <g transform={`translate(${markStart.x} ${markStart.y})`}>
              <circle className="pd-pulse" cx="11" cy="11" r="15" fill="none" stroke={accent} strokeWidth="2" />
              <rect width="22" height="22" rx="4" fill={ink} />
              <text x="11" y="14.5" textAnchor="middle" fontSize="9" fontWeight="600" fill="var(--cream)" style={mono}>
                CC
              </text>
            </g>
          </g>
        </svg>
      </div>
    </article>
  );
}
