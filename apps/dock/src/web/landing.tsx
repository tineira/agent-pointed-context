/**
 * The landing of apc.tineira.com (TIN-420, TIN-605, TIN-620): what APC is, from the hero alone (a line and a
 * short silent clip of the drag), then two paths. Try it is for people using an AI agent: the dock, the two demo
 * apps and the direct way in a note. Build it is for people building an app: Direct from the app's side, a real
 * focus, and the docs. Everyone sees it (TIN-610); a visitor who already has a dock also gets "Your dock" in the
 * top bar.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";
import { FOCUS_EXAMPLE } from "./landing-example.ts";
import { APPS, DESKTOP } from "./setup.tsx";

const DOCK = "/dock";
/** The standard's docs (TIN-611): spec, integration guide, conformance. */
const DOCS = "/docs";
const REPO = "https://github.com/tineira/agent-pointed-context";
const PAPER = "https://doi.org/10.5281/zenodo.23382909";
/** The companion record: the design records and the payload specification. */
const RECORDS = "https://doi.org/10.5281/zenodo.23383101";
const VIDEO = "https://youtu.be/pb46Sd0UOtM";
const [PULSE, SIGNALS] = APPS as [(typeof APPS)[number], (typeof APPS)[number]];
/** A live Direct app (TIN-578): Signals, with its Connect panel open. */
const DIRECT_TRY = `${SIGNALS.url}?connect`;
/** The cross-app question in the demos' fixed shared world (TIN-621): an offer in Signals, a customer who left in Pulse. */
const TRY_POST = `${SIGNALS.url}?post=post_013`;
const TRY_CUSTOMER = PULSE.url.replace(/overview$/, "customers/cus_0048");

/**
 * The hero clip: rendered from the November 2026 promo's own Remotion scene (the media repo), silent, without
 * captions; served from the dock's assets (public/media) with their usual headers. Never a YouTube embed: its
 * cookies would break the one-cookie promise.
 */
const CLIP = { webm: "/media/apc-hero.webm", mp4: "/media/apc-hero.mp4", poster: "/media/apc-hero-poster.jpg", width: 1280, height: 640 };
const CLIP_ALT = "An agent is dragged onto the March bar of a revenue chart. Asked what is behind the bar, it reads every customer in it and answers: $41,200 from 38 customers.";

/** The agents named under the hero, by their logos (products.ts). */
const AGENTS = [
  { brand: "claude", name: "Claude" },
  { brand: "openai", name: "ChatGPT" },
  { brand: "cursor", name: "Cursor" },
  { brand: "grok", name: "Grok" },
];

const TRY_STEPS = [
  { title: "Open your dock", text: "A small page that holds your agent and follows you from app to app. It is yours alone: no account, one cookie, nothing to install." },
  { title: "Connect your agent", text: "Add one MCP server to Claude, ChatGPT, Cursor or Grok. That single connection is all it needs." },
  { title: "Open Pulse or Signals", text: "From this page, below. Drop your agent on something there, and allow it in the app and in your dock." },
  { title: "Point and ask", text: "Drag your agent from the dock onto a bar, a customer or a headline, and ask about \"this\". Point at something in the other app and ask how the two connect." },
];

const BUILD_STEPS = [
  { title: "Serve your own MCP endpoint", text: <>Each agent gets its own grant and MCP URL from your app: <code>get_current_view</code> and <code>wait_for_focus</code> beside your own tools. Nothing sits between your app and the agent.</> },
  { title: "Make things pointable", text: <>Charts, rows and paragraphs carry <code>data-focus</code>, ids and keys only. A drop becomes a focus that names the exact tool call that reads it.</> },
  { title: "Pass the conformance suite", text: <><code>@tineira/apc-conformance</code> checks the view, the pin, the focus format and revoke through your MCP endpoint.</> },
];

const REFS = [
  { title: "Docs", text: "The standard, in five pages", href: DOCS },
  { title: "Integration guide", text: "Integrate your app in an afternoon", href: `${DOCS}/integrate` },
  { title: "Spec", text: "The core, the Direct and Dock profiles, the focus format", href: `${DOCS}/spec` },
  { title: "Payload specification", text: "With the design records, on Zenodo", href: RECORDS },
  { title: "Design record", text: "What is built and why: DESIGN.md", href: `${REPO}/blob/main/DESIGN.md` },
  { title: "Paper", text: "Letting a person point an AI agent at what they see", href: PAPER },
  { title: "Code", text: "github.com/tineira/agent-pointed-context, MIT", href: REPO },
];

function Cta() {
  return (
    <a className="landing-cta big" href={DOCK} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || screen.availWidth < 820) return;
      // A compact dock beside this page, so Pulse or Signals opens from here next to it.
      if (window.open(DOCK, "apc-dock", "popup,width=420,height=780,left=0,top=0")) e.preventDefault();
    }}>
      Open your dock
    </a>
  );
}

/** Whether the visitor asks for less motion, kept current. */
function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduce, setReduce] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const on = () => setReduce(list.matches);
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, []);
  return reduce;
}

/** The muted loop of the drag; under reduced motion, its poster frame and no video at all. */
function HeroClip() {
  const reduce = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!video) return;
    // React sets `muted` as a property only; some browsers autoplay only with the attribute.
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    if (paused) video.pause();
    else void video.play().catch(() => undefined);
  }, [video, paused]);
  return (
    <figure className="landing-stage">
      {reduce || failed ? (
        <img src={CLIP.poster} width={CLIP.width} height={CLIP.height} alt={CLIP_ALT} />
      ) : (
        <>
          <video ref={setVideo} autoPlay muted loop playsInline preload="auto" poster={CLIP.poster} width={CLIP.width} height={CLIP.height} aria-label={CLIP_ALT} onError={(e) => {
            // A browser that says it plays WebM but cannot decode it gets the MP4; one that cannot play either, the poster.
            const v = e.currentTarget;
            if (v.currentSrc.endsWith(".webm")) {
              v.src = CLIP.mp4;
              void v.play().catch(() => undefined);
            } else setFailed(true);
          }}>
            <source src={CLIP.webm} type="video/webm" />
            <source src={CLIP.mp4} type="video/mp4" />
          </video>
          <button type="button" className="landing-stage-toggle" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? "Play" : "Pause"}
          </button>
        </>
      )}
    </figure>
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

function Steps(props: { steps: { title: string; text: ReactNode }[] }) {
  return (
    <ol className="landing-steps">
      {props.steps.map((s, i) => (
        <li key={s.title}>
          <span className="landing-n">{i + 1}</span>
          <div>
            <b>{s.title}</b>
            <p>{s.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Landing() {
  const hasDock = useHasDock();
  return (
    <main className="landing">
      <header className="landing-head">
        <span className="kicker">Agent Pointed Context</span>
        <nav className="landing-nav" aria-label="Site">
          {hasDock && <a href={DOCK}>Your dock</a>}
          <a href="#try">Try it</a>
          <a href="#build">Build it</a>
          <a href={DOCS}>Docs</a>
          <a href={REPO}>GitHub</a>
        </nav>
      </header>

      <section className="landing-hero">
        <h1>Point your AI agent at what you see</h1>
        <p className="landing-lede">
          Drag your agent onto a chart, a row or a paragraph and ask about "this". It reads the data underneath, through access it already has. No screen sharing.
        </p>
        <HeroClip />
        <a className="landing-watch" href={VIDEO}>
          <span aria-hidden="true">▶</span> Watch the full video
        </a>
        <ul className="landing-agents" aria-label="Works with">
          {AGENTS.map((a) => (
            <li key={a.brand}>
              <span aria-hidden="true">
                <AgentIcon clientName={null} brandId={a.brand} size={16} />
              </span>
              {a.name}
            </li>
          ))}
          <li>any agent that takes an MCP server</li>
        </ul>
      </section>

      <div className="landing-paths">
        <div className="landing-path">
          <span className="landing-who">For people using an AI agent</span>
          <h2>Try it</h2>
          <p>Use your own agent on two demo apps. A few minutes, made-up data, no account.</p>
          <div className="row">
            <a className="landing-cta" href="#try">Try the demo →</a>
          </div>
        </div>
        <div className="landing-path">
          <span className="landing-who">For people building an app</span>
          <h2>Build it</h2>
          <p>Make your app pointable. It serves its own MCP endpoint, and what the person points at goes from your app to their agent, never through us.</p>
          <div className="row">
            <a className="landing-cta ghost" href="#build">Add APC to your app →</a>
            <a className="small" href={`${DOCS}/integrate`}>Integration guide</a>
          </div>
        </div>
      </div>

      <section id="try">
        <span className="landing-eyebrow">Try it</span>
        <h2 className="landing-title">Your agent, two demo apps, one drag</h2>
        <p className="landing-sub">You need an agent that can add a remote MCP server. The demo is free and its data is made up.</p>
        <Steps steps={TRY_STEPS} />
        <div className="row landing-try-cta">
          <Cta />
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
        <p className="landing-note">
          <b>A question to start with.</b> In Signals, drop your agent on <a href={TRY_POST}>Tallyfin's offer to Team teams in North America</a> and ask "Which of our customers did this offer take?". Then point it at <a href={TRY_CUSTOMER}>Deep Harbor Logistics</a> in Pulse, a customer who left, and ask how the two connect.
        </p>
        <p className="landing-note">
          <b>Any web page, too.</b> With the <a href="/extension">browser extension</a>, you can drop your agent on a page that knows nothing of APC: it reads the part you pointed at.
        </p>
        <p className="landing-note">
          <b>An app gave you its own MCP address?</b> Add it to your agent directly instead, with no dock in between: <a href={DIRECT_TRY}>Signals has one</a>. Same drag, and the same agent connected both ways shows as one.
        </p>
      </section>

      <section id="build">
        <span className="landing-eyebrow">Build it</span>
        <h2 className="landing-title">Make your app pointable</h2>
        <p className="landing-sub">
          APC is an open standard over MCP. Your app keeps its data and answers the person's agent with just what they pointed at, through its own tools.
        </p>
        <Steps steps={BUILD_STEPS} />
        <p className="landing-sub landing-example-caption">
          What an agent connected to Pulse receives when the person drops it on March in the chart of active customers: <a href={`${DOCS}/spec#the-pin-and-the-focus-format`}>the focus</a>, ids and keys only, and the call that reads it.
        </p>
        <pre className="landing-code">
          <code>{JSON.stringify(FOCUS_EXAMPLE, null, 2)}</code>
        </pre>
        <p className="landing-note">
          <b>Works with the dock too.</b> An app that speaks the standard can also be paired with a person's dock, which relays its tools, so they connect their agent once. <a href={`${DOCS}/integrate#12-dock-agents-dragged-from-a-dock`}>Pairing with a dock</a>
        </p>
        <ul className="landing-refs">
          {REFS.map((r) => (
            <li key={r.title}>
              <a href={r.href}>
                <b>{r.title}</b>
                <span>{r.text}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="landing-title">What your agent can and cannot see</h2>
        <ul className="landing-see">
          <li>Only what you pointed at, in apps you paired, after you allowed it in the app and in the dock.</li>
          <li>No screenshots and no screen sharing: each app answers with its own data, through its own tools.</li>
          <li>Each app keeps its data. The agent does the joining, in your conversation.</li>
          <li>You can remove an agent or an app from the dock at any time, and start over on every site.</li>
        </ul>
      </section>

      <footer className="landing-foot">
        <a href={DOCS}>Docs: the spec and how to integrate an app</a>
        <a href={REPO}>GitHub</a>
        <a className="muted" href="/v1/">Version 1, as described in the paper →</a>
      </footer>
    </main>
  );
}
