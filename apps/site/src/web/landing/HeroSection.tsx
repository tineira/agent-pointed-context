import { SITE_PAGES, VIDEO } from "../site-pages.ts";
import { HeroStage } from "./HeroStage.tsx";
import { TryMeArrow } from "./hero/try-me.ts";

/**
 * The hero: what APC is and the two ways in, beside the stage (HeroStage, its own step). The full video is a link to
 * YouTube, never an embed: its cookies would break the one-cookie promise. The "Try me" arrow (TIN-1103) sits in the
 * grid, between the copy and the stage, and places itself.
 */
export function HeroSection() {
  return (
    <section className="landing-hero">
      <div className="wrap landing-hero-grid">
        <div className="landing-hero-copy">
          <p className="landing-eyebrow landing-dot">An open standard, built on MCP</p>
          <h1>
            Point your AI agent at <em>what you see.</em>
          </h1>
          <p className="landing-lede">
            Drag your agent onto a chart, a row or a paragraph and ask about "this". It reads the data underneath, through access it already has. <b>No screen sharing.</b>
          </p>
          <div className="landing-cta-row">
            <a className="btn primary" href={SITE_PAGES.try.path}>
              Try the demo <span className="landing-arr" aria-hidden="true">→</span>
            </a>
            <a className="btn ghost" href={SITE_PAGES.build.path}>Add APC to your app</a>
          </div>
          <a className="landing-watch" href={VIDEO} target="_blank" rel="noopener">
            <span aria-hidden="true">▶</span> Watch the full video
          </a>
        </div>
        <div className="landing-hero-stage">
          <HeroStage />
        </div>
        <TryMeArrow />
      </div>
    </section>
  );
}
