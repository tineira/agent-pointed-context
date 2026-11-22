/**
 * /try (TIN-627; after the Dock left, TIN-1061; the design, TIN-1068), in two phases since TIN-1094, built from Fable's
 * accepted prototype. The hero maps the page with two cards. Phase 1, "Try APC", is three steps in one app (open Pulse,
 * connect your agent, point and ask) beside step 3's examples, "What 'this' can mean": a bar, a customer and a step of
 * the bridge, each drawn with the demo world's own numbers (try-examples.ts), a deep link into Pulse and two questions.
 * A line ends phase 1. Phase 2, optional and unnumbered, is a dashed card: Signals with one "Open Signals" button to
 * its Connect panel (TIN-1091) and the cross-app question. Then the Revoke note. Nothing to install and no third
 * party: the agent connects to each app's own MCP address, as the standard's Direct profile says.
 *
 * "Open Pulse" is a button inside step 1 (TIN-1090), and goes where the shared connection state says (TIN-1087,
 * pulse-status.ts): Pulse's overview when the visitor's agent is connected, its Agents page otherwise.
 *
 * Pulse already connected (TIN-1072): when the visitor's agent connected in the landing's real hero, this tab holds a
 * hint (pulse-status.ts: the session storage key "apc:site:pulse-status", written from the frame's
 * `apc:pulse-status`, at most 6 h old, the name cleaned again on read). Then the hero says who is connected (the
 * `.try-status` pill), only "Connect your agent" is done ("done on the home page"), and "Open Pulse" stays where to
 * start (the `.try-step.done` and `.try-step.next` rules in pages.css). The hint is never a secret and never an auth
 * check. Signals has no state on this page: the site cannot know it (TIN-1091).
 */
import { AgentMark } from "./agent-mark.tsx";
import { APPS } from "./demo-apps.tsx";
import { PULSE_ORIGIN } from "../pulse-origin.ts";
import { usePulseView } from "./pulse-status.ts";
import { useScrollReveals } from "./reveal.ts";
import { SiteBackdrop, SiteFooter, SiteHeader } from "./site.tsx";
import { TRY_BAR, TRY_BRIDGE, TRY_CUSTOMER_ROW } from "./try-examples.ts";

const [PULSE, SIGNALS] = APPS as [(typeof APPS)[number], (typeof APPS)[number]];
/** Signals' Connect panel: its one button, connected or not (TIN-1091). */
const SIGNALS_CONNECT = `${SIGNALS.url}?connect`;
/** Every link into Pulse is on the origin "Open Pulse" uses (pulse-status.ts). */
const inPulse = (path: string) => `${PULSE_ORIGIN}${path}`;
/** The cross-app question in the demos' fixed shared world (TIN-621): `TRY_POST`, an offer in Signals, and `TRY_CUSTOMER`, a customer who left in Pulse. */
const TRY_POST = `${SIGNALS.url}?post=post_013`;
const TRY_CUSTOMER = inPulse("/customers/cus_0048");
/** Each app names the origin it lives on (the real host in production). */
const host = (url: string) => new URL(url).host;
/** Every link to an app opens it in a new tab, so the steps and the examples stay open beside it (TIN-1090). */
const OUT = { target: "_blank", rel: "noopener" } as const;

/** The steps of phase 1. When connected, only "Connect your agent" is done, and "Open Pulse" is where to start. */
const STEPS = ["open", "connect", "point"] as const;
type Step = (typeof STEPS)[number];
const stepClass = (step: Step, connected: boolean) => (!connected ? "try-step rv" : step === "connect" ? "try-step done rv" : step === "open" ? "try-step next rv" : "try-step rv");

/** The chart's bars, to scale (the tallest is 60 of the drawing's 96 units), with the pointed month in the accent. */
const BAR_MAX = Math.max(...TRY_BAR.series);
const BAR_ON = 11;

function BarsArt() {
  return (
    <div className="try-ex-bars">
      <svg viewBox="0 0 252 96" preserveAspectRatio="xMidYMax meet">
        {TRY_BAR.series.map((v, i) => {
          const h = Math.round((v / BAR_MAX) * 60);
          return <rect key={i} className={i === BAR_ON ? "on" : undefined} x={1 + 14 * i} y={92 - h} width="10" height={h} rx="2" />;
        })}
        <text x={6 + 14 * BAR_ON} y="12" textAnchor="middle">
          {TRY_BAR.active}
        </text>
      </svg>
      <AgentMark size={26} className="try-ex-pin" />
    </div>
  );
}

function CustomerArt() {
  return (
    <div className="try-ex-row">
      <span className="mono">{TRY_CUSTOMER_ROW.id}</span>
      <b>{TRY_CUSTOMER_ROW.name}</b>
      <span>{TRY_CUSTOMER_ROW.plan}</span>
      <span>{TRY_CUSTOMER_ROW.region}</span>
      <span className="num">{TRY_CUSTOMER_ROW.seats}</span>
      <AgentMark size={26} className="try-ex-pin" />
    </div>
  );
}

function BridgeArt() {
  return (
    <ol className="try-ex-bridge">
      {TRY_BRIDGE.steps.map((s) => (
        <li key={s.step} className={s.step === TRY_BRIDGE.pointed ? "on" : undefined}>
          <b>{s.value}</b>
          <span>{s.label}</span>
          {s.step === TRY_BRIDGE.pointed && <AgentMark size={26} className="try-ex-pin" />}
        </li>
      ))}
    </ol>
  );
}

function Asks(props: { asks: readonly string[] }) {
  return (
    <ul className="try-asks">
      {props.asks.map((a) => (
        <li className="try-ask" key={a}>
          {a}
        </li>
      ))}
    </ul>
  );
}

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
              Your agent, a demo app, <em>one drag.</em>
            </h1>
            <p className="page-lede">You need an agent that can add a remote MCP server. The demo is free and its data is made up. No account, nothing to install.</p>
            {pulse.connected && (
              <p className="try-status">
                <span className="try-conn">
                  <i aria-hidden="true" />
                  {pulse.agentName ? `${pulse.agentName} connected` : "Connected directly"}
                </span>
                <span>
                  to Pulse, from the home page.<span className="try-status-more"> Start at step 1: it opens ready to point.</span>
                </span>
              </p>
            )}
            <nav className="try-rail" aria-label="On this page">
              <a href="#phase-1">
                <small>Phase 1</small>
                <b>Try APC</b>
                <span>One app. Open it, connect, point, ask.</span>
              </a>
              <a href="#phase-2" className="opt">
                <small>
                  Phase 2 <i>optional</i>
                </small>
                <b>Get even more out of APC</b>
                <span>The same agent across two apps that share nothing.</span>
              </a>
            </nav>
          </section>

          <section className="try-phase" id="phase-1" aria-labelledby="phase-1-title">
            <header className="try-phase-head">
              <p className="landing-who">Phase 1</p>
              <h2 id="phase-1-title">Try APC</h2>
              <p>Three steps in one app. It ends when your agent answers about the thing you pointed at.</p>
            </header>

            <div className="try-grid">
              <ol className="try-steps">
                <li className={stepClass("open", pulse.connected)}>
                  <span className="n">1</span>
                  <div>
                    <b>Open Pulse</b>
                    <p>
                      {pulse.connected
                        ? "Your agent is already connected, so Pulse opens on its overview, with the charts to point at."
                        : "A demo app: product analytics for a made-up SaaS, with its customers, plans, seats and monthly activity. It opens a private copy for you, on its Agents page."}
                    </p>
                    <p className="try-step-cta">
                      <a className="btn primary" href={pulse.openHref} {...OUT}>
                        Open Pulse <span aria-hidden="true">↗</span>
                      </a>
                      <span className="try-host">{host(PULSE_ORIGIN)}</span>
                    </p>
                  </div>
                </li>
                <li className={stepClass("connect", pulse.connected)}>
                  <span className="n">2</span>
                  <div>
                    <b>Connect your agent</b>
                    {pulse.connected ? (
                      <p>
                        <span className="try-conn-sentence">{pulse.agentName ? `${pulse.agentName} is connected to Pulse.` : "Your agent is connected to Pulse."}</span> Nothing to do here.
                      </p>
                    ) : (
                      <p>On Pulse's Agents page, make an agent and copy its MCP address, or the prompt that asks your agent to add it. Add it to Claude, ChatGPT or Grok as a remote MCP server.</p>
                    )}
                  </div>
                </li>
                <li className={stepClass("point", pulse.connected)}>
                  <span className="n">3</span>
                  <div>
                    <b>Point and ask</b>
                    <p>Drag your agent's mark from Pulse's agent bar onto a bar, a customer or a step, and ask about "this". On a phone, tap the mark, then the thing.</p>
                    <p className="try-step-note">Your agent gets what you pointed at as an identifier, and reads the data behind it. No screenshot.</p>
                  </div>
                </li>
              </ol>

              <div className="try-examples" role="group" aria-labelledby="examples-title">
                <div className="try-examples-head">
                  <p className="landing-who">
                    <span className="landing-n" aria-hidden="true">
                      3
                    </span>
                    Step 3, in practice
                  </p>
                  <h3 id="examples-title">What "this" can mean</h3>
                </div>

                <article className="try-ex rv">
                  <div className="try-ex-art" aria-hidden="true">
                    <BarsArt />
                  </div>
                  <div className="try-ex-body">
                    <small>A bar of a chart</small>
                    <p>
                      Drop your agent on{" "}
                      <a href={inPulse(TRY_BAR.path)} {...OUT}>
                        {TRY_BAR.label}
                      </a>{" "}
                      in "Active customers per month" and ask:
                    </p>
                    <Asks asks={TRY_BAR.asks} />
                  </div>
                </article>

                <article className="try-ex rv">
                  <div className="try-ex-art" aria-hidden="true">
                    <CustomerArt />
                  </div>
                  <div className="try-ex-body">
                    <small>A customer</small>
                    <p>
                      Open Customers and drop your agent on a row, say{" "}
                      <a href={inPulse(TRY_CUSTOMER_ROW.path)} {...OUT}>
                        {TRY_CUSTOMER_ROW.name}
                      </a>
                      , and ask:
                    </p>
                    <Asks asks={TRY_CUSTOMER_ROW.asks} />
                  </div>
                </article>

                <article className="try-ex rv">
                  <div className="try-ex-art" aria-hidden="true">
                    <BridgeArt />
                  </div>
                  <div className="try-ex-body">
                    <small>A step of the bridge</small>
                    <p>
                      In "Customer bridge", drop your agent on the Churned step of{" "}
                      <a href={inPulse(TRY_BRIDGE.path)} {...OUT}>
                        {TRY_BRIDGE.label}
                      </a>{" "}
                      and ask:
                    </p>
                    <Asks asks={TRY_BRIDGE.asks} />
                  </div>
                </article>
              </div>
            </div>

            <p className="try-end">
              <i aria-hidden="true" />
              <span>
                <b>That is APC.</b> You pointed, and your agent read the data behind it. You can stop here.
              </span>
            </p>
          </section>

          <section className="try-more rv" id="phase-2" aria-labelledby="phase-2-title">
            <header className="try-more-head">
              <p className="landing-who">
                Phase 2 <span className="try-opt">Optional</span>
              </p>
              <h2 id="phase-2-title">
                Get even more out of APC: <em>two apps that share nothing.</em>
              </h2>
              <p>Pulse can tell your agent who left in September. It can't say why. Signals, a second demo app, is a market feed: what competitors launch, price and say. Connect the same agent to both and it does the joining.</p>
            </header>

            <div className="try-more-grid">
              <div className="try-more-col">
                <div className="try-app">
                  <div className="row">
                    {SIGNALS.glyph}
                    <b>Signals</b>
                    <span className="try-host">{host(SIGNALS.url)}</span>
                  </div>
                  <p>It opens with an agent already made and its MCP address showing. Add that address to the same agent you used in Pulse, as a second remote MCP server.</p>
                  <a className="btn ghost" href={SIGNALS_CONNECT} {...OUT}>
                    Open Signals <span aria-hidden="true">↗</span>
                  </a>
                </div>

                <div className="try-join" aria-hidden="true">
                  <span className="try-join-app">{PULSE.glyph}Pulse</span>
                  <svg className="try-wires h" viewBox="0 0 100 4" preserveAspectRatio="none">
                    <path d="M0 2H100" />
                  </svg>
                  <AgentMark size={40} track />
                  <svg className="try-wires h" viewBox="0 0 100 4" preserveAspectRatio="none">
                    <path d="M100 2H0" />
                  </svg>
                  <span className="try-join-app">{SIGNALS.glyph}Signals</span>
                </div>
                <p className="try-join-cap">your agent does the joining · the apps share nothing</p>
              </div>

              <div className="try-more-col try-cross">
                <div>
                  <span className="landing-who">A question across both</span>
                  <h3>One offer, one customer who left.</h3>
                </div>
                <div className="try-move">
                  <small>First, in Signals</small>
                  <p>
                    Drop your agent on{" "}
                    <a href={TRY_POST} {...OUT}>
                      Tallyfin's offer to Team teams in North America
                    </a>{" "}
                    and ask:
                  </p>
                  <span className="try-ask">Which of our customers did this offer take?</span>
                </div>
                <div className="try-move">
                  <small>Then, in Pulse</small>
                  <p>
                    Point it at{" "}
                    <a href={TRY_CUSTOMER} {...OUT}>
                      Deep Harbor Logistics
                    </a>
                    , a customer who left, and ask:
                  </p>
                  <span className="try-ask">How do the two connect?</span>
                </div>
              </div>
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
