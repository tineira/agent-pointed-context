import { SITE_PAGES } from "../site-pages.ts";

export function PathsSection() {
  return (
    <div className="landing-paths rv">
      <div className="landing-path">
        <span className="landing-who">For people using an AI agent</span>
        <h3>Try it</h3>
        <p>Connect your own agent to two demo apps and point it at a chart. A few minutes, made-up data, no account.</p>
        <div className="row">
          <a className="landing-cta" href={SITE_PAGES.try.path}>Try the demo →</a>
        </div>
      </div>
      <div className="landing-path">
        <span className="landing-who">For people building an app</span>
        <h3>Build it</h3>
        <p>Make your app pointable. It serves its own MCP endpoint, and what the person points at goes from your app straight to their agent.</p>
        <div className="row">
          <a className="landing-cta ghost" href={SITE_PAGES.build.path}>Add APC to your app →</a>
        </div>
      </div>
    </div>
  );
}
