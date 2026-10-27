/**
 * The APC v2 landing (TIN-420): what the agent dock is, how a person uses it, the demo apps, and the
 * way in. A visitor who already has a dock never sees it: the Worker sends them on to /dock.
 */
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";
import { APPS, DESKTOP } from "./setup.tsx";

const DOCK = "/dock";
const REPO = "https://github.com/tineira/agent-pointed-context";
const [PULSE, SIGNALS] = APPS as [(typeof APPS)[number], (typeof APPS)[number]];
/** A few of the agents that connect, by their logos (products.ts). */
const BRANDS = ["claude", "openai", "gemini", "grok", "cursor", "kimi", "zai"];

const STEPS = [
  { title: "Open your dock", text: "Your agent dock is a small page (or an installed app) that holds your agents. It is yours alone: no account, one cookie." },
  { title: "Connect your agent", text: "Add one MCP server to your agent (Claude, ChatGPT, Cursor, Grok…). That single connection is all it ever needs." },
  { title: "Create your world", text: "The demo apps fill with the same made-up company: customers in Pulse, competitor news in Signals." },
  { title: "Point", text: "Drag your agent from the dock onto a bar, a customer, a headline. Ask about \"this\". Point somewhere else in another app, and ask how the two connect." },
];

function Cta(props: { big?: boolean }) {
  return (
    <a className={`landing-cta${props.big ? " big" : ""}`} href={DOCK}>
      Open your dock
    </a>
  );
}

/** The idea in one picture: a dock with an agent, dragged onto two apps. */
function Picture() {
  return (
    <div className="landing-picture" aria-hidden="true">
      <div className="landing-dock">
        <span className="kicker">Agent dock</span>
        <span className="landing-agent">
          <AgentIcon clientName={null} brandId="claude" motion="waiting" size={34} />
        </span>
      </div>
      <svg className="landing-arrows" viewBox="0 0 120 120" preserveAspectRatio="none">
        <path d="M4 60 C 50 60, 60 22, 114 22" />
        <path d="M4 60 C 50 60, 60 98, 114 98" />
      </svg>
      <div className="landing-apps">
        {APPS.map((app) => (
          <div key={app.name} className="landing-app">
            {app.glyph}
            <span>{app.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <main className="landing">
      <header className="landing-head">
        <span className="kicker">Agent Pointed Context · v2</span>
        <a href={REPO}>GitHub</a>
      </header>

      <section className="landing-hero">
        <div>
          <h1>One agent across your apps. You point, it reads.</h1>
          <p>
            Connect your AI agent once, to your agent dock. Then drag it onto anything in any app you paired: it reads exactly what you pointed at, and joins what two apps say, while the apps never share their data with each other.
          </p>
          <div className="row">
            <Cta big />
            <span className="muted">Free demo, made-up data. Nothing to sign up for.</span>
          </div>
          <div className="landing-brands" aria-label="Works with any agent that takes an MCP server">
            {BRANDS.map((b) => (
              <AgentIcon key={b} clientName={null} brandId={b} size={20} />
            ))}
            <span className="muted">and any agent that takes an MCP server</span>
          </div>
        </div>
        <Picture />
      </section>

      <section>
        <h2>How it works</h2>
        <ol className="landing-steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="landing-n">{i + 1}</span>
              <div>
                <b>{s.title}</b>
                <p>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2>The demo apps</h2>
        <div className="landing-cards">
          <div className="landing-card">
            <div className="row">
              {PULSE.glyph}
              <b>Pulse</b>
            </div>
            <p>Product analytics for a SaaS: customers, plans, seats, monthly activity. On the web, or as a Windows app: the same drag works on the desktop.</p>
            <div className="row small">
              <a href={PULSE.url.replace(/overview$/, "")}>Open on the web</a>
              {DESKTOP.map((d) => (
                <a key={d.label} href={d.url}>
                  Download for {d.label}
                </a>
              ))}
            </div>
          </div>
          <div className="landing-card">
            <div className="row">
              {SIGNALS.glyph}
              <b>Signals</b>
            </div>
            <p>A market feed: what competitors launch, price and say. Point your agent at a headline here and a customer in Pulse, and ask what it means for them.</p>
            <div className="row small">
              <a href={SIGNALS.url}>Open on the web</a>
            </div>
          </div>
        </div>
        <p className="muted small-note">Open them from your dock: it sets up the same world in both.</p>
      </section>

      <section>
        <h2>What your agent can and cannot see</h2>
        <ul className="landing-list">
          <li>Only what you pointed at, in apps you paired, after you allowed it in the app and in the dock.</li>
          <li>No screenshots and no screen sharing: each app answers with its own data, through its own tools.</li>
          <li>Each app keeps its data. The agent does the joining, in your conversation.</li>
          <li>You can remove an agent or an app from the dock at any time, and start over on every site.</li>
        </ul>
      </section>

      <section>
        <h2>Read more</h2>
        <ul className="landing-list">
          <li>
            The paper: <a href="https://doi.org/10.5281/zenodo.23382909">Agent Pointed Context: letting a person point an AI agent at what they see, without sharing the screen</a>
          </li>
          <li>
            The design records and payload specification: <a href="https://doi.org/10.5281/zenodo.23383101">Zenodo</a>, and <a href={`${REPO}/blob/main/DESIGN.md`}>DESIGN.md</a>
          </li>
          <li>
            The code: <a href={REPO}>github.com/tineira/agent-pointed-context</a>
          </li>
          <li>
            Version 1, one app with its own agent: <a href="https://apc.tineira.com/v1">apc.tineira.com</a>
          </li>
        </ul>
      </section>

      <footer className="landing-foot">
        <Cta />
      </footer>
    </main>
  );
}
