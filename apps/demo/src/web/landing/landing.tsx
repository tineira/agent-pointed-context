import { AppLink, ICON_BUTTON, LogoMark, PAPER_URL, PaperIcon, ThemeToggle } from "../ui.tsx";
import "./chooser.css";

const COMPARISON = [
  ["Your agent connects to", "Each app, one connection per app", "Your dock, once"],
  ["Adding your 20th app", "One more connection set up in your agent", "Drop your agent on it and allow it"],
  ["Works with", "Apps that implement the standard", "Apps that implement the standard, plus any web page with the extension"],
  ["Reading two apps together", "Yes, with both connections", "Yes, through one connection"],
  ["Runs on", "Web apps today; the standard also fits desktop apps", "Web and desktop apps. Your dock runs on the web and as a Windows app; Mac and Linux later"],
  ["You drag your agent from", "Inside each app", "Your dock: a window, Float, or Windows"],
  ["Your data goes", "From each app to your agent", "Through your dock to your agent"],
];

/** Generic examples keep the standard separate from the demo apps. */
function ConnectionDiagram({ once = false }: { once?: boolean }) {
  const marker = once ? "once-arrow" : "per-app-arrow";
  return (
    <figure className="chooser-diagram">
      <svg viewBox="0 0 440 180" role="img" aria-label={once ? "Your agent connects to your dock, which connects to a web app, a desktop app and any page with the extension" : "Your agent makes a separate connection to each of three apps"}>
        <defs>
          <marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0 0 7 3.5 0 7" fill="none" stroke="currentColor" />
          </marker>
        </defs>
        <g className="diagram-arrows" fill="none" stroke="currentColor" markerEnd={`url(#${marker})`}>
          {once ? <>
            <path d="M91 90H120" />
            <path d="M255 90H278V29H307" />
            <path d="M255 90H307" />
            <path d="M255 90H278V151H307" />
          </> : <>
            <path d="M135 90H192V29H307" />
            <path d="M135 90H307" />
            <path d="M135 90H192V151H307" />
          </>}
        </g>
        <rect className="diagram-box" x={once ? 4 : 15} y="68" width={once ? 87 : 120} height="44" rx="8" />
        <text x={once ? 47.5 : 75} y="94" textAnchor="middle">Your agent</text>
        {once && <>
          <rect className="diagram-dock" x="125" y="51" width="130" height="78" rx="8" />
          <g className="diagram-dock-text" textAnchor="middle">
            <text x="190" y="76" className="diagram-title">Your dock</text>
            <text x="190" y="97" className="diagram-platform">Web · Windows</text>
            <text x="190" y="114" className="diagram-platform">Mac, Linux later</text>
          </g>
        </>}
        {[29, 90, 151].map((y, i) => (
          <g key={y}>
            <rect className="diagram-box" x="312" y={y - 22} width="124" height="44" rx="8" strokeDasharray={once && i === 2 ? "5 4" : undefined} />
            {once && i < 2 && <g fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <rect x="323" y={y - 8} width="16" height="12" rx="1.5" />
              {i === 0 ? <path d={`M323 ${y - 4}h16`} /> : <path d={`M331 ${y + 4}v4m-5 0h10`} />}
            </g>}
            <text x={once && i < 2 ? 385 : 374} y={y + 4} textAnchor="middle">{once ? ["Web app", "Desktop app", "Any page"][i] : "App"}</text>
          </g>
        ))}
      </svg>
      <figcaption>{once ? "drop your agent on an app to add it" : "one connection in your agent per app"}</figcaption>
    </figure>
  );
}

/** Public chooser: no session calls, cookie checks or imports from v2. */
export function Landing() {
  return (
    <div className="chooser">
      <header className="chooser-header">
        <AppLink href="/" className="chooser-brand"><LogoMark /><span>Agent Pointed Context</span></AppLink>
        <a href={PAPER_URL} target="_blank" rel="noopener noreferrer" aria-label="Read the paper" title="Read the paper" className={ICON_BUTTON}><PaperIcon /></a>
        <ThemeToggle />
      </header>
      <main>
        <section className="chooser-intro" aria-labelledby="chooser-title">
          <h1 id="chooser-title">Bring your own agent to any app</h1>
          <p>Point it at a chart, a row or a paragraph and ask about “this”. No built-in assistant needed. Two ways to try the standard:</p>
        </section>
        <div className="chooser-cards">
          <article className="chooser-card" aria-labelledby="per-app-title">
            <span className="chooser-version">V1</span>
            <h2 id="per-app-title">Connect app by app</h2>
            <p>Each app that implements the standard gives your agent its own connection. Try it on Pulse, our example app.</p>
            <ConnectionDiagram />
            <div className="chooser-card-foot">
              <p>About a minute</p>
              <AppLink href="/how-to" className="chooser-button">Try it on Pulse <span aria-hidden="true">→</span></AppLink>
            </div>
          </article>
          <article className="chooser-card" aria-labelledby="once-title">
            <span className="chooser-version">V2</span>
            <h2 id="once-title">Connect once</h2>
            <p>Connect your agent once, to your dock. Drop it on any app that implements the standard, on the web or on your desktop, or on any web page with the extension.</p>
            <ConnectionDiagram once />
            <div className="chooser-card-foot">
              <p>Try it on Pulse (web or Windows) and Signals</p>
              <a href="https://v2.apc.tineira.com" className="chooser-button">Open your dock <span aria-hidden="true">→</span></a>
            </div>
          </article>
        </div>
        <section className="chooser-comparison" aria-labelledby="compare-title">
          <h2 id="compare-title">Compare the two ways</h2>
          <table>
            <caption className="sr-only">Connect app by app (V1) and connect once (V2)</caption>
            <thead><tr><td /><th scope="col">Connect app by app <span>(V1)</span></th><th scope="col">Connect once <span>(V2)</span></th></tr></thead>
            <tbody>{COMPARISON.map(([label, perApp, once]) => <tr key={label}><th scope="row">{label}</th><td>{perApp}</td><td>{once}</td></tr>)}</tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
