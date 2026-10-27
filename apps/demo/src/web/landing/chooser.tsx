/** Public connection chooser. Neither this page nor the V1 landing opens a sandbox. */
import { AppLink, ICON_BUTTON, LogoMark, PAPER_URL, PaperIcon, ThemeToggle } from "../ui.tsx";
import "./chooser.css";

const COMPARISON = [
  ["plug", "Your agent connects to", "Each app, one by one", "Your dock, once"],
  ["stack", "Adding your 20th app", "One more connection in your agent", "Drop your agent on it and allow it"],
  ["apps", "Works with", "Apps that implement the standard", "Those apps, plus any web page"],
  ["join", "Two apps together", "Yes, with both connections", "Yes, through one"],
  ["devices", "Runs on", "Web apps", "Web and desktop apps · dock on web and Windows, Mac and Linux later"],
  ["hand", "You drag from", "Inside each app", "Your dock"],
  ["route", "Your data goes", "App to your agent", "Through your dock to your agent"],
] as const;

const ICONS = {
  plug: "M8 3v4m8-4v4M6 7h12v3a6 6 0 0 1-6 6v5m-6-11V7",
  stack: "m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4",
  apps: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  join: "M3 5h5l8 14h5M3 19h5L16 5h5m-3-3 3 3-3 3m0 8 3 3-3 3",
  devices: "M3 3h14v12H3zM7 20h6m-3-5v5M17 9h5v12h-5z",
  hand: "M8 12V5a2 2 0 0 1 4 0v6-2a2 2 0 0 1 4 0v2-1a2 2 0 0 1 4 0v5c0 4-2 6-6 6h-2c-2 0-3-1-4-3l-4-6a2 2 0 0 1 3-2l3 3",
  route: "M4 5h10a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h11m-3-3 3 3-3 3",
};

function RowIcon({ name }: { name: keyof typeof ICONS }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>;
}

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
            <path d="M135 78C190 78 210 29 307 29" />
            <path d="M135 90H307" />
            <path d="M135 102C190 102 210 151 307 151" />
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


export function Chooser() {
  return (
    <main className="chooser-page">
      <header className="flex items-center gap-2 pt-5">
        <AppLink href="/" className="mr-auto flex items-center gap-2.5">
          <LogoMark /><span className="whitespace-nowrap text-[15px] font-semibold tracking-[-0.01em]">Agent Pointed Context</span>
        </AppLink>
        <a href={PAPER_URL} target="_blank" rel="noopener noreferrer" aria-label="Read the paper" title="Read the paper" className={ICON_BUTTON}><PaperIcon /></a>
        <ThemeToggle />
      </header>
      <h1>Bring your own agent to any app</h1>
      <section className="chooser-cards" aria-label="Choose a connection model">
        <AppLink href="/v1" className="chooser-card">
          <span className="chooser-version">V1</span>
          <h2>Connect app by app</h2>
          <ConnectionDiagram />
          <p>One connection in your agent for each app. Try it on Pulse.</p>
          <span className="chooser-card-link">See how V1 works <span aria-hidden="true">→</span></span>
        </AppLink>
        <a href="https://v2.apc.tineira.com" className="chooser-card chooser-card-accent">
          <span className="chooser-version">V2</span>
          <h2>Connect once</h2>
          <ConnectionDiagram once />
          <p>One connection to your dock. Drop your agent on any app or page.</p>
          <span className="chooser-card-link">See how V2 works <span aria-hidden="true">→</span></span>
        </a>
      </section>
      <section className="chooser-comparison" aria-labelledby="compare-title">
        <h2 id="compare-title">Compare the two ways</h2>
        <div className="chooser-table-card">
          <table>
            <caption className="sr-only">Connect app by app (V1) and connect once (V2)</caption>
            <colgroup><col style={{ width: "30%" }} /><col style={{ width: "35%" }} /><col style={{ width: "35%" }} /></colgroup>
            <thead><tr><td /><th scope="col">Connect app by app <span>V1</span></th><th scope="col">Connect once <span>V2</span></th></tr></thead>
            <tbody>{COMPARISON.map(([icon, label, perApp, once]) => <tr key={label}>
              <th scope="row"><span className="comparison-label"><RowIcon name={icon} />{label}</span></th>
              <td><span className="comparison-mobile-version">V1</span>{perApp}</td>
              <td><span className="comparison-mobile-version">V2</span>{once}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
