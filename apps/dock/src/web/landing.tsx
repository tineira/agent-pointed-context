/**
 * The landing of apc.tineira.com (TIN-420, TIN-605): the APC standard, its two ways to connect side by side,
 * how the dock works, the demo apps, and the way in. Everyone sees it (TIN-610); a visitor who already has a dock
 * also gets "Open your dock" in the top bar and the hero.
 */
import { useEffect, useState } from "react";
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";
import { APPS, DESKTOP } from "./setup.tsx";

const DOCK = "/dock";
/** The standard's docs (TIN-611): spec, integration guide, conformance. */
const DOCS = "/docs";
const REPO = "https://github.com/tineira/agent-pointed-context";
const [PULSE, SIGNALS] = APPS as [(typeof APPS)[number], (typeof APPS)[number]];
/** "Connect app by app" leads to a live Direct app: Signals, with its Connect panel open. */
const DIRECT_TRY = `${SIGNALS.url}?connect`;
/** A few of the agents that connect, by their logos (products.ts). */
const BRANDS = ["claude", "openai", "gemini", "grok", "cursor", "kimi", "zai"];

const STEPS = [
  { title: "Open your dock", text: "Your agent dock is a small page that holds your agents. It is yours alone: no account, one cookie, nothing to install first." },
  { title: "Connect your agent", text: "Add one MCP server to your agent (Claude, ChatGPT, Cursor, Grok…). That single connection is all it ever needs." },
  { title: "Try an example app", text: "The checklist opens Pulse on a ready-made demo world. Drop your agent on a bar, allow it in Pulse and then in your dock, and ask: what is this?" },
  { title: "Point", text: "Drag your agent from the dock onto a bar, a customer, a headline. Ask about \"this\". Point somewhere else in another app, and ask how the two connect." },
];

const DIRECT_STEPS = [
  { title: "The app gives you a connection", text: "An app that speaks the standard shows an MCP address of its own for your agent. Nothing sits between the two." },
  { title: "Add it to your agent", text: "Paste that one address into your agent, as you would any remote MCP server. Each app you want your agent to read gets its own." },
  { title: "Point", text: "In the app, drag your agent's mark onto a chart, a row or a paragraph and ask about \"this\". The app answers your agent directly with just what you pointed at, and the content never passes through us." },
];

function Cta(props: { big?: boolean }) {
  return (
    <a className={`landing-cta${props.big ? " big" : ""}`} href={DOCK} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || screen.availWidth < 820) return;
      // One window per click: the next click in the checklist opens Pulse beside this compact dock.
      if (window.open(DOCK, "apc-dock", "popup,width=420,height=780,left=0,top=0")) e.preventDefault();
    }}>
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

/** Whether this visitor already has a dock (the Worker answers by cookie, TIN-610); false until it says so, and if it fails. */
function useHasDock(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/dock/mine", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { has_dock?: unknown } | null) => live && setHas(body?.has_dock === true))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return has;
}

export function Landing() {
  const hasDock = useHasDock();
  return (
    <main className="landing">
      <header className="landing-head">
        <span className="kicker">Agent Pointed Context</span>
        <span className="row small">
          {hasDock && <Cta />}
          <a href={DOCS}>Docs</a>
          <a href={REPO}>GitHub</a>
        </span>
      </header>

      <section className="landing-hero">
        <div>
          <h1>Point your own AI agent at what you see</h1>
          <p>
            Agent Pointed Context is a standard for pointing an AI agent at a chart, a row or a paragraph in an app and asking about "this", without sharing the screen. Connect your agent once, or app by app: you choose.
          </p>
          <div className="row">
            {hasDock ? <Cta big /> : <a className="landing-cta big" href="#ways">Choose how to connect</a>}
            <span className="muted">You need an agent that can add a remote MCP server. Free demo, made-up data.</span>
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

      <section id="ways">
        <h2>Two ways to connect</h2>
        <div className="landing-cards">
          <div className="landing-card">
            <div className="row">
              <b>Connect once</b>
            </div>
            <p>Dock: one connection in your agent, to your agent dock. Drag it onto any app you paired and it follows your focus from app to app.</p>
            <div className="row">
              <Cta />
              <a className="small" href="#dock">How the dock works</a>
            </div>
          </div>
          <div className="landing-card">
            <div className="row">
              <b>Connect app by app</b>
            </div>
            <p>Direct: each app gives your agent its own connection. The content goes from the app to your agent and never passes through us.</p>
            <div className="row">
              {/* A live Direct app (TIN-578): Signals opens with its Connect panel. */}
              <a className="landing-cta" href={DIRECT_TRY}>Connect to Signals</a>
              <a className="small" href="#direct">How Direct works</a>
            </div>
          </div>
        </div>
      </section>

      <section id="dock">
        <h2>How Connect once works</h2>
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

      <section id="direct">
        <h2>How Connect app by app works</h2>
        <ol className="landing-steps">
          {DIRECT_STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="landing-n">{i + 1}</span>
              <div>
                <b>{s.title}</b>
                <p>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="muted small-note">
          Try it on <a href={DIRECT_TRY}>Signals</a> or Pulse: both demo apps below take agents both ways, and the same agent connected both ways shows as one. The details are in the <a href={`${REPO}/blob/main/DESIGN.md`}>design record</a>.
        </p>
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
            The docs: <a href={DOCS}>the standard, how to integrate your app, and its conformance suite</a>
          </li>
          <li>
            The paper: <a href="https://doi.org/10.5281/zenodo.23382909">Agent Pointed Context: letting a person point an AI agent at what they see, without sharing the screen</a>
          </li>
          <li>
            The design records and payload specification: <a href="https://doi.org/10.5281/zenodo.23383101">Zenodo</a>, and <a href={`${REPO}/blob/main/DESIGN.md`}>DESIGN.md</a>
          </li>
          <li>
            The code: <a href={REPO}>github.com/tineira/agent-pointed-context</a>
          </li>
        </ul>
      </section>

      <footer className="landing-foot">
        <Cta />
        <a href={DOCS}>Docs: the spec and how to integrate an app</a>
        <a className="muted" href="/v1/">Version 1, as described in the paper →</a>
      </footer>
    </main>
  );
}
