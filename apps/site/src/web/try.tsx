/**
 * /try (TIN-627; after the Dock left, TIN-1061): the demo, for people using an AI agent. Four steps that do not
 * overlap (open an app, connect your agent to it, point and ask, then a second app), each demo app by its own
 * link and its own Connect page, and the question to start with standing out. Nothing to install and no third
 * party: the agent connects to each app's own MCP address, as the standard's Direct profile says.
 */
import { SiteFooter, SiteHeader, Steps } from "./site.tsx";
import { APPS } from "./demo-apps.tsx";

const [PULSE, SIGNALS] = APPS as [(typeof APPS)[number], (typeof APPS)[number]];
/** Where each app makes an agent and gives its MCP address: Pulse's Agents page, Signals' Connect panel. */
const PULSE_CONNECT = PULSE.url.replace(/overview$/, "agents");
const SIGNALS_CONNECT = `${SIGNALS.url}?connect`;
/** The cross-app question in the demos' fixed shared world (TIN-621): an offer in Signals, a customer who left in Pulse. */
const TRY_POST = `${SIGNALS.url}?post=post_013`;
const TRY_CUSTOMER = PULSE.url.replace(/overview$/, "customers/cus_0048");

const TRY_STEPS = [
  { title: "Open Pulse", text: "A demo app: product analytics for a made-up SaaS. It opens a private copy for you. No account, nothing to install." },
  { title: "Connect your agent", text: "In Pulse's Agents page, make an agent and copy its MCP address, or the prompt that asks your agent to add it. Add it to Claude, ChatGPT, Cursor or Grok as a remote MCP server." },
  { title: "Point and ask", text: "Drag your agent's mark from Pulse's agent bar onto a bar, a customer or a step, and ask about \"this\". On a phone, tap the mark, then the thing." },
  { title: "Add a second app", text: "Connect the same agent to Signals, with Signals' own address. Point at something in each and ask how they connect: your agent does the joining, and the two apps share nothing." },
];

export function TryPage() {
  return (
    <main className="landing">
      <SiteHeader page="try" />

      <section>
        <h1 className="landing-eyebrow">Try it</h1>
        <p className="landing-title">Your agent, two demo apps, one drag</p>
        <p className="landing-sub">You need an agent that can add a remote MCP server. The demo is free and its data is made up.</p>
        <Steps steps={TRY_STEPS} />
        <div className="landing-try-cta">
          <div className="row">
            <a className="landing-cta big" href={PULSE_CONNECT}>Open Pulse and connect your agent</a>
          </div>
        </div>
        <div className="landing-cards">
          <div className="landing-card">
            <div className="row">
              {PULSE.glyph}
              <b>Pulse</b>
            </div>
            <p>Product analytics for a SaaS: customers, plans, seats, monthly activity.</p>
            <div className="row small">
              <a href={PULSE.url.replace(/overview$/, "")}>Open Pulse</a>
              <a href={PULSE_CONNECT}>Connect an agent</a>
            </div>
          </div>
          <div className="landing-card">
            <div className="row">
              {SIGNALS.glyph}
              <b>Signals</b>
            </div>
            <p>A market feed: what competitors launch, price and say. Point your agent at a headline here and a customer in Pulse, and ask what it means for them.</p>
            <div className="row small">
              <a href={SIGNALS.url}>Open Signals</a>
              <a href={SIGNALS_CONNECT}>Connect an agent</a>
            </div>
          </div>
        </div>
        <div className="landing-starter">
          <span className="landing-who">A question to start with</span>
          <p>
            In Signals, drop your agent on <a href={TRY_POST}>Tallyfin's offer to Team teams in North America</a> and ask "Which of our customers did this offer take?". Then point it at <a href={TRY_CUSTOMER}>Deep Harbor Logistics</a> in Pulse, a customer who left, and ask how the two connect.
          </p>
        </div>
        <div className="landing-asides">
          <p>
            <b>Cut it off any time.</b> Each app lists your agents on its own page, with Revoke: the agent loses that app at once, and keeps the other.
          </p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
