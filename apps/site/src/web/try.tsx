/**
 * /try (TIN-627; after the Dock left, TIN-1061; the new design, TIN-1068): the walk the winning prototype's #/try
 * view shows (round 3). A hero with one CTA to Pulse's Agents page, then the four steps that do not overlap (open
 * an app, connect your agent to it, point and ask, then a second app) beside the two app cards with the person's
 * agent joining between them, the starter question as its two moves, and the Revoke note. Nothing to install and
 * no third party: the agent connects to each app's own MCP address, as the standard's Direct profile says.
 *
 * Pulse already connected (TIN-1072): when the visitor's agent connected in the landing's real hero, this tab holds
 * a hint (pulse-status.ts: the session storage key "apc:site:pulse-status", written from the frame's `apc:pulse-status`,
 * at most 6 h old, the name cleaned again on read). Then the Pulse card shows a check and "<agent> connected" (or
 * "Connected directly") and links Pulse's overview, the steps up to pointing are done in the hero, and Signals'
 * step is "start here" (the `.try-step.done`, `.try-step.next`, `.try-app.on` and `.try-conn` rules in pages.css).
 * Without a valid hint, the unconnected walk, unchanged. The hint is never a secret and never an auth check.
 *
 * Every "Open Pulse" on the site goes where the shared connection state says (TIN-1087, pulse-status.ts): Overview when
 * connected, Agents otherwise; the main button reads "Open Pulse" once there is nothing left to connect.
 */
import { AgentMark } from "./agent-mark.tsx";
import { APPS } from "./demo-apps.tsx";
import { usePulseView } from "./pulse-status.ts";
import { useScrollReveals } from "./reveal.ts";
import { SiteBackdrop, SiteFooter, SiteHeader } from "./site.tsx";

const [PULSE, SIGNALS] = APPS as [(typeof APPS)[number], (typeof APPS)[number]];
/** Where each app makes an agent and gives its MCP address: Pulse's Agents page, Signals' Connect panel. */
const PULSE_CONNECT = PULSE.url.replace(/overview$/, "agents");
const SIGNALS_CONNECT = `${SIGNALS.url}?connect`;
/** The cross-app question in the demos' fixed shared world (TIN-621): an offer in Signals, a customer who left in Pulse. */
const TRY_POST = `${SIGNALS.url}?post=post_013`;
const TRY_CUSTOMER = PULSE.url.replace(/overview$/, "customers/cus_0048");
/** Each card names the origin its app lives on (localhost in dev, the real host in production). */
const host = (url: string) => new URL(url).host;

const TRY_STEPS = [
  { title: "Open Pulse", text: "A demo app: product analytics for a made-up SaaS. It opens a private copy for you." },
  { title: "Connect your agent", text: "In Pulse's Agents page, make an agent and copy its MCP address, or the prompt that asks your agent to add it. Add it to Claude, ChatGPT or Grok as a remote MCP server." },
  { title: "Point and ask", text: "Drag your agent's mark from Pulse's agent bar onto a bar, a customer or a step, and ask about \"this\". On a phone, tap the mark, then the thing." },
  { title: "Add a second app", text: "Connect the same agent to Signals, with Signals' own address. Point at something in each and ask how they connect: your agent does the joining, and the two apps share nothing." },
];

/** The steps the hero already did once Pulse is connected (open, connect, point), and the one to start with: Signals. */
const DONE_IN_HERO = 3;
const stepClass = (i: number, connected: boolean) => (!connected ? "try-step rv" : i < DONE_IN_HERO ? "try-step done rv" : i === DONE_IN_HERO ? "try-step next rv" : "try-step rv");

export function TryPage() {
  useScrollReveals();
  // The shared connection state (pulse-status.ts): the hint for this tab, and where "Open Pulse" goes (TIN-1087).
  const pulse = usePulseView();
  return (
    <div className="site-shell">
      <SiteBackdrop />
      <div className="site-page">
        <SiteHeader page="try" />
        <main className="landing">
          <section className="page-hero">
            <p className="page-eyebrow">
              <i aria-hidden="true" />Try it
            </p>
            <h1>
              Your agent, two demo apps, <em>one drag.</em>
            </h1>
            <p className="page-lede">You need an agent that can add a remote MCP server. The demo is free and its data is made up. No account, nothing to install.</p>
            <div className="page-cta-row">
              <a className="btn primary" href={pulse.openHref}>
                {pulse.connected ? "Open Pulse" : "Open Pulse and connect your agent"} <span aria-hidden="true">↗</span>
              </a>
            </div>
          </section>

          <section className="try-grid">
            <ol className="try-steps">
              {TRY_STEPS.map((s, i) => (
                <li className={stepClass(i, pulse.connected)} key={s.title}>
                  <span className="n">{i + 1}</span>
                  <div>
                    <b>{s.title}</b>
                    <p>{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="try-side">
              <div className={pulse.connected ? "try-app on rv" : "try-app rv"}>
                <div className="row">
                  {PULSE.glyph}
                  <b>Pulse</b>
                  {pulse.connected ? (
                    <span className="try-conn">
                      <i aria-hidden="true" />
                      {pulse.agentName ? `${pulse.agentName} connected` : "Connected directly"}
                    </span>
                  ) : (
                    <span className="try-host">{host(PULSE.url)}</span>
                  )}
                </div>
                <p>Product analytics for a SaaS: customers, plans, seats, monthly activity.</p>
                <div className="try-links">
                  {pulse.connected ? (
                    <a href={pulse.openHref}>
                      Open Pulse <span aria-hidden="true">↗</span>
                    </a>
                  ) : (
                    <>
                      <a href={PULSE.url.replace(/overview$/, "")}>
                        Open Pulse <span aria-hidden="true">↗</span>
                      </a>
                      <a href={PULSE_CONNECT}>
                        Connect an agent <span aria-hidden="true">↗</span>
                      </a>
                    </>
                  )}
                </div>
              </div>
              <div className="rv">
                <svg className="try-wires" viewBox="0 0 400 54" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M200 0V54" />
                </svg>
                <div className="try-joiner">
                  <AgentMark size={40} track />
                  your agent does the joining · the apps share nothing
                </div>
                <svg className="try-wires" viewBox="0 0 400 54" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M200 54V0" />
                </svg>
              </div>
              <div className="try-app rv">
                <div className="row">
                  {SIGNALS.glyph}
                  <b>Signals</b>
                  <span className="try-host">{host(SIGNALS.url)}</span>
                </div>
                <p>A market feed: what competitors launch, price and say.</p>
                <div className="try-links">
                  <a href={SIGNALS.url}>
                    Open Signals <span aria-hidden="true">↗</span>
                  </a>
                  <a href={SIGNALS_CONNECT}>
                    Connect an agent <span aria-hidden="true">↗</span>
                  </a>
                </div>
              </div>
            </div>
          </section>

          <section className="try-starter rv">
            <div>
              <span className="landing-who">A question to start with</span>
              <h3>One offer, one customer who left.</h3>
            </div>
            <div className="try-move">
              <small>First, in Signals</small>
              <p>
                Drop your agent on <a href={TRY_POST}>Tallyfin's offer to Team teams in North America</a> and ask:
              </p>
              <span className="try-ask">Which of our customers did this offer take?</span>
            </div>
            <div className="try-move">
              <small>Then, in Pulse</small>
              <p>
                Point it at <a href={TRY_CUSTOMER}>Deep Harbor Logistics</a>, a customer who left, and ask:
              </p>
              <span className="try-ask">How do the two connect?</span>
            </div>
          </section>

          <p className="try-aside rv">
            <b>Cut it off any time.</b> Each app lists your agents on its own page, with Revoke: the agent loses that app at once, and keeps the other.
          </p>
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
