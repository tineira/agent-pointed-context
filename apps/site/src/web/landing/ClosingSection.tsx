import { AgentMark } from "../agent-mark.tsx";
import { SITE_PAGES } from "../site-pages.ts";

/** The closing call to action: the same two ways in as the hero. */
export function ClosingSection() {
  return (
    <section className="landing-closing">
      <div className="wrap rv">
        <AgentMark size={72} track className="landing-closing-mark" />
        <h2>Point it at something.</h2>
        <p>Two demo apps, made-up data, no account. Or read what an app implements.</p>
        <div className="landing-cta-row">
          <a className="btn primary" href={SITE_PAGES.try.path}>
            Try the demo <span className="landing-arr" aria-hidden="true">→</span>
          </a>
          <a className="btn ghost" href={SITE_PAGES.build.path}>Add APC to your app</a>
        </div>
      </div>
    </section>
  );
}
