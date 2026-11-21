/**
 * The developer's page (TIN-626, TIN-627; one page since the Dock left, TIN-1061). /build is enough to start: what
 * every app implements, how agents connect (the standard's one profile, Direct), the real focus an agent receives,
 * a note that `profiles` stays an open list for profiles others define, and the references. Every claim here
 * comes from the spec (src/docs/pages/spec.md), the integration guide's tested example
 * (src/docs/examples/orders-app.ts) and the packages; scripts/test/site-focus.test.mjs and
 * apps/site/test/landing.test.ts check the payload and the links.
 */
import type { ReactNode } from "react";
import { FOCUS_EXAMPLE } from "./landing-example.ts";
import { useScrollReveals } from "./reveal.ts";
import { Code, SiteBackdrop, SiteFooter, SiteHeader, Steps } from "./site.tsx";
import { DESIGN, DOCK_PRODUCT, DOCS, PAPER, RECORDS, REPO, SITE_PAGES } from "./site-pages.ts";

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** What every APC app implements: the core. */
const CORE_STEPS = [
  { title: "Serve an MCP endpoint", text: <>Each agent gets its own grant, and an MCP URL whose last segment is the grant's secret. <code>get_current_view</code> and <code>wait_for_focus</code> sit beside your own tools, and every tool runs inside one wrapper: revoke, <code>attention</code>, presence, <code>then</code>.</> },
  { title: "Make things pointable", text: <>Charts, rows and paragraphs carry <code>data-focus</code>, ids and keys only. A drop becomes a focus that names the exact tool call that reads it.</> },
  { title: "Say what you are, and let the person revoke", text: <><code>/.well-known/apc.json</code> names your origin, your profiles and where your MCP URLs live. Revoke in your page cuts an agent at once, and calls nobody.</> },
  { title: "Pass the conformance suite", text: <><code>@tineira/apc-conformance</code> checks the view, the pin, the focus format and revoke through your MCP endpoint.</> },
];

const REF_GROUPS = [
  {
    title: "Start here",
    refs: [
      { title: "Integration guide", text: "Integrate your app in an afternoon", href: `${DOCS}/integrate` },
      { title: "Conformance suite", text: "What it checks, and how to run it", href: `${DOCS}/conformance` },
      { title: "Docs", text: "The standard, in five pages", href: DOCS },
    ],
  },
  {
    title: "Deep dive",
    refs: [
      { title: "Spec", text: "The core, connecting agents, the focus format, apc.json", href: `${DOCS}/spec` },
      { title: "Payload specification", text: "With the design records, on Zenodo", href: RECORDS },
      { title: "Design record", text: "What is built and why: DESIGN.md", href: DESIGN },
      { title: "Paper", text: "Letting a person point an AI agent at what they see", href: PAPER },
    ],
  },
  {
    title: "Code",
    refs: [{ title: "GitHub", text: "github.com/tineira/agent-pointed-context, MIT", href: REPO }],
  },
];
/** Every link the /build body has, so its footer leaves them out. */
const BUILD_LINKS = REF_GROUPS.flatMap((g) => g.refs.map((r) => r.href));

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="landing-block rv">
      <h2 className="landing-h2">{props.title}</h2>
      {props.children}
    </section>
  );
}

export function BuildPage() {
  useScrollReveals();
  return (
    <div className="site-shell">
      <SiteBackdrop />
      <div className="site-page">
        <SiteHeader page="build" />
        <main className="landing">
          <section>
            <p className="landing-back">
              New to APC? <a href={SITE_PAGES.try.path}>Try the demo first →</a>
            </p>
            <h1 className="landing-eyebrow">Build it</h1>
            <p className="landing-title">Make your app pointable</p>
            <p className="landing-sub">
              APC is an open standard over MCP. Your app keeps its data and answers the person's agent with just what they pointed at, through its own tools. The agent connects to your app's own MCP address: nothing sits between you.
            </p>
          </section>

          <Section title="What every app implements">
            <Steps steps={CORE_STEPS} />
          </Section>

          <Section title="How agents connect">
            <ul className="landing-list">
              <li><b>A grant per agent.</b> The person makes an agent in your page; your server makes a grant with a secret of 128 random bits, the last segment of that agent's MCP URL (<code>newDirectGrant</code> in <code>@tineira/apc-server</code>). The URL is the access: Streamable HTTP, no OAuth.</li>
              <li><b>The agent list.</b> Where the person makes and names agents and copies the URL, or a prompt that asks their agent to add it (<code>&lt;apc-direct-agents&gt;</code> in <code>@tineira/apc-web</code>). An agent names itself on <code>initialize</code> until the person renames it.</li>
              <li><b>The agent bar.</b> <code>&lt;apc-agents&gt;</code> shows each agent's mark, its pin and Revoke: your page is where the person sees their agent and drags it onto what they mean. On a phone it stays in the page, at the bottom, and a tap pins.</li>
              <li><b>In <code>apc.json</code></b>, <code>"direct"</code> among the profiles, and <code>direct.connect</code>: the page on your origin where the person connects an agent.</li>
            </ul>
          </Section>

          <Section title="What the agent receives">
            <p className="landing-sub landing-example-caption">
              The focus an agent connected to Pulse gets when the person drops it on March in the chart of active customers: <a href={`${DOCS}/spec#the-pin-and-the-focus-format`}>the focus format</a>, ids and keys only, and the call that reads it.
            </p>
            <Code label="The focus from Pulse">{json(FOCUS_EXAMPLE)}</Code>
          </Section>

          <Section title="Other profiles">
            <p className="landing-sub">
              <code>profiles</code> in <code>apc.json</code> is an open list. APC defines and checks <code>"direct"</code>; a profile it does not define is specified by whoever defines it, and an app that declares one also meets that profile's own spec.
              {DOCK_PRODUCT && <> The <a href={DOCK_PRODUCT.url}>{DOCK_PRODUCT.name}</a>, for one, defines <code>"dock"</code> in a protocol of its own.</>}
            </p>
          </Section>

          <section className="rv">
            <h2 className="landing-title">References</h2>
            <div className="landing-refgroups">
              {REF_GROUPS.map((g) => (
                <div key={g.title}>
                  <h3 className="landing-eyebrow">{g.title}</h3>
                  <ul className="landing-refs">
                    {g.refs.map((r) => (
                      <li key={r.title}>
                        <a href={r.href}>
                          <b>{r.title}</b>
                          <span>{r.text}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </main>
        <SiteFooter onPage={BUILD_LINKS} />
      </div>
    </div>
  );
}
