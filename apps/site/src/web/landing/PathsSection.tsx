import { APPS } from "../demo-apps.tsx";
import { usePulseView } from "../pulse-status.ts";
import { SITE_PAGES } from "../site-pages.ts";
import { ConnectedRow, ConnectedTick } from "./connected.ts";

/** The four packages an app builds with (packages/*, published as @tineira/apc-*). */
const PACKAGES = ["@tineira/apc-protocol", "@tineira/apc-server", "@tineira/apc-web", "@tineira/apc-conformance"];

/**
 * The one decision: try it with your own agent, or build it into your app. Each card is one link (its "go" line).
 * Once the visitor's agent is connected in the hero (TIN-1089), the Try it card shows Pulse with a check and says so.
 */
export function PathsSection() {
  const pulse = usePulseView();
  return (
    <section className="wrap landing-paths" aria-label="Try it or build it">
      <div className="landing-path landing-path-try rv">
        <p className="landing-who">For people using an AI agent</p>
        <h2>Try it</h2>
        <p>Connect your own agent to two demo apps and point it at a chart. A few minutes, made-up data, no account.</p>
        <ul className="landing-path-art" aria-label="The demo apps">
          {APPS.map((app) => (
            <li key={app.name} className={app.name === "Pulse" && pulse.connected ? "landing-chip on" : "landing-chip"}>
              <span className="landing-chip-glyph" aria-hidden="true">{app.glyph}</span>
              {app.name}
              {app.name === "Pulse" && pulse.connected && <ConnectedTick />}
            </li>
          ))}
        </ul>
        <ConnectedRow view={pulse} />
        <a className="landing-go" href={SITE_PAGES.try.path}>
          Try the demo <span aria-hidden="true">→</span>
        </a>
      </div>
      <div className="landing-path landing-path-build rv">
        <p className="landing-who">For people building an app</p>
        <h2>Build it</h2>
        <p>Make your app pointable. It serves its own MCP endpoint, and what the person points at goes from your app straight to their agent.</p>
        <ul className="landing-path-art" aria-label="The packages">
          {PACKAGES.map((pkg) => (
            <li key={pkg} className="landing-chip">{pkg}</li>
          ))}
        </ul>
        <a className="landing-go" href={SITE_PAGES.build.path}>
          Add APC to your app <span aria-hidden="true">→</span>
        </a>
      </div>
    </section>
  );
}
