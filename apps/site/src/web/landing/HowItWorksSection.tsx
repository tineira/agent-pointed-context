import { AgentMark } from "../agent-mark.tsx";

/**
 * Inside a point: the three channels of the core (the spec's view, pin and presence), each with a small diagram in
 * SVG and CSS only and a sentence or two. How they are built stays in the docs.
 */
export function HowItWorksSection() {
  return (
    <section className="wrap landing-block">
      <div className="landing-head landing-head-split rv">
        <div>
          <p className="landing-idx">How it works</p>
          <h2>
            Inside a point<span className="landing-dotc">.</span>
          </h2>
        </div>
        <p>Three channels connect what you see to what your agent can read.</p>
      </div>
      <div className="landing-channels rv">
        <article>
          <svg className="landing-dg" viewBox="0 0 150 90" aria-hidden="true">
            <rect className="d-win" x="6" y="8" width="92" height="70" rx="6" />
            <path className="d-ln" d="M6 22h92" />
            <rect className="d-bar" x="18" y="52" width="11" height="18" rx="1.5" />
            <rect className="d-bar" x="35" y="42" width="11" height="28" rx="1.5" />
            <rect className="d-bar" x="52" y="47" width="11" height="23" rx="1.5" />
            <rect className="d-hot" x="69" y="34" width="11" height="36" rx="1.5" />
            <path className="d-wire" d="M98 30h14" />
            <rect className="d-chip" x="112" y="21" width="36" height="18" rx="9" />
            <text className="d-txt" x="130" y="33" textAnchor="middle">ids</text>
          </svg>
          <h3>View</h3>
          <p>The app says what you see as identifiers only: the screen, the period, the row you selected. Never the numbers or the text on it.</p>
        </article>
        <article>
          <svg className="landing-dg" viewBox="0 0 150 90" aria-hidden="true">
            <path className="d-ln" d="M8 78h100" />
            <rect className="d-bar" x="18" y="48" width="18" height="30" rx="2" />
            <rect className="d-hot" x="48" y="34" width="18" height="44" rx="2" />
            <rect className="d-bar" x="78" y="54" width="18" height="24" rx="2" />
            <rect className="d-dash" x="43" y="29" width="28" height="49" rx="4" />
            <g transform="translate(45 2)">
              <AgentMark size={24} />
            </g>
            <path className="d-wire" d="M71 44h20" />
            <rect className="d-chip" x="91" y="35" width="56" height="18" rx="9" />
            <text className="d-txt" x="119" y="47" textAnchor="middle">next call</text>
          </svg>
          <h3>Pin</h3>
          <p>Drag your agent's mark onto a bar, a row or a paragraph. The app hands your agent the exact tool call that reads it.</p>
        </article>
        <article>
          <svg className="landing-dg" viewBox="0 0 150 90" aria-hidden="true">
            <rect className="d-row" x="8" y="12" width="96" height="18" rx="4" />
            <rect className="d-ring" x="8" y="36" width="96" height="18" rx="4" />
            <rect className="d-lit" x="8" y="36" width="96" height="18" rx="4" />
            <rect className="d-row" x="8" y="60" width="96" height="18" rx="4" />
            <g transform="translate(112 32)">
              <AgentMark size={26} />
            </g>
          </svg>
          <h3>Presence</h3>
          <p>Your agent is a mark on the page, and what it reads lights up as it goes.</p>
        </article>
      </div>
    </section>
  );
}
