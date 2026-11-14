/**
 * /try (TIN-627): the demo, for people using an AI agent. Four steps that do not overlap (open an app and allow
 * the agent; then point and ask), the one button to the web dock with Dock for Windows beside it, Pulse and Signals
 * each by their own link (Pulse also for Windows), the question to start with standing out, and the browser
 * extension and Direct as quieter notes.
 */
import { SiteFooter, SiteHeader, Steps } from "./site.tsx";
import { DOCK } from "./site-pages.ts";
import { APPS, DESKTOP, DESKTOP_SHELL, DOCK_DESKTOP } from "./setup.tsx";
import { downloadPlatform } from "./download-platform.ts";

const [PULSE, SIGNALS] = APPS as [(typeof APPS)[number], (typeof APPS)[number]];
/** A live Direct app (TIN-578): Signals, with its Connect panel open. */
const DIRECT_TRY = `${SIGNALS.url}?connect`;
/** The cross-app question in the demos' fixed shared world (TIN-621): an offer in Signals, a customer who left in Pulse. */
const TRY_POST = `${SIGNALS.url}?post=post_013`;
const TRY_CUSTOMER = PULSE.url.replace(/overview$/, "customers/cus_0048");

const TRY_STEPS = [
  { title: "Your dock", text: "A small page that holds your agent and follows you from app to app. It is yours alone: no account, one cookie. Use it in the browser with nothing to install, or as an app for Windows. On another computer, choose Join when the dock first opens, with a code from the dock's menu, and your agent stays connected once." },
  { title: "Connect your agent", text: "Add one MCP server to Claude, ChatGPT, Cursor or Grok. That single connection is all it needs." },
  { title: "Open Pulse or Signals", text: "Open one from this page, below. The first time your agent arrives in it, allow it there, then in your dock." },
  { title: "Point and ask", text: "Drag your agent from the dock onto a bar, a customer or a headline, and ask about \"this\". Point at something in the other app and ask how the two connect." },
];

function Cta() {
  return (
    <a className="landing-cta big" href={DOCK} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || screen.availWidth < 820) return;
      // A compact dock beside this page, so Pulse or Signals opens from here next to it.
      if (window.open(DOCK, "apc-dock", "popup,width=420,height=780,left=0,top=0")) e.preventDefault();
    }}>
      Open the web dock
    </a>
  );
}

/**
 * Dock for Windows beside the web dock, by the same rule as the dock's own menu (downloadPlatform): a second,
 * quieter button on Windows, with its unsigned note; on another computer one line that still links it, for a
 * visitor who will install it on a Windows PC; nothing on a phone. Mac and Linux are a note, never a dead button.
 */
function DockForWindows() {
  const platform = downloadPlatform(navigator.userAgent, DESKTOP_SHELL);
  return platform.dock ? <a className="landing-cta big ghost" href={DOCK_DESKTOP.url}>Get the dock for Windows</a> : null;
}

function DockNote() {
  const platform = downloadPlatform(navigator.userAgent, DESKTOP_SHELL);
  if (platform.dock) return <p className="small-note">Dock for Windows is unsigned for now: Windows asks once (More info, then Run anyway). Mac and Linux later.</p>;
  if (platform.later) return <p className="small-note">Also as an app: <a href={DOCK_DESKTOP.url}>Dock for Windows</a>. Mac and Linux later.</p>;
  return null;
}

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
            <Cta />
            <DockForWindows />
          </div>
          <DockNote />
        </div>
        <div className="landing-cards">
          <div className="landing-card">
            <div className="row">
              {PULSE.glyph}
              <b>Pulse</b>
            </div>
            <p>Product analytics for a SaaS: customers, plans, seats, monthly activity. On the web, or as a Windows app: the same drag works on the desktop.</p>
            <div className="row small">
              <a href={PULSE.url.replace(/overview$/, "")}>Open Pulse</a>
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
              <a href={SIGNALS.url}>Open Signals</a>
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
            <b>Any web page, too.</b> With the <a href="/extension">browser extension</a>, you can drop your agent on a page that knows nothing of APC: it reads the part you pointed at.
          </p>
          <p>
            <b>An app gave you its own MCP address?</b> Add it to your agent directly instead, with no dock in between: <a href={DIRECT_TRY}>Signals has one</a>. Same drag, from the app's own page, and the same agent connected both ways shows as one.
          </p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
