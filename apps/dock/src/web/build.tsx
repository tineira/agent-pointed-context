/**
 * The developer's pages (TIN-626, TIN-627). /build chooses: Direct and Dock as two equal cards (what each means
 * for the app's users, pros and cons), a strip for shipping both, and the references. /build/direct and
 * /build/dock are each enough to start: what every app implements, what the profile adds, the real focus an
 * agent receives, and the profile's references. /build/both covers declaring both profiles, `apc_link`, the
 * linked agent in the bar and the hint that offers the dock to a Direct user. The profiles are independent
 * (TIN-576): neither is built on the other. Every claim here comes from the spec (src/docs/pages/spec.md), the
 * integration guide's tested example (src/docs/examples/orders-app.ts) and the packages; apps/dock/test/landing.test.ts
 * checks the snippets and the links.
 */
import type { ReactNode } from "react";
import { DOCK_FOCUS_EXAMPLE, FOCUS_EXAMPLE } from "./landing-example.ts";
import { Code, SiteFooter, SiteHeader, Steps } from "./site.tsx";
import { DESIGN, DOCS, PAPER, RECORDS, REPO, SITE_PAGES, type SitePage } from "./site-pages.ts";

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** What every APC app implements, whatever its profiles: the core. */
const CORE_STEPS = [
  { title: "Serve an MCP endpoint", text: <>Each agent gets its own grant, and an MCP URL whose last segment is the grant's secret. <code>get_current_view</code> and <code>wait_for_focus</code> sit beside your own tools, and every tool runs inside one wrapper: revoke, <code>attention</code>, presence, <code>then</code>.</> },
  { title: "Make things pointable", text: <>Charts, rows and paragraphs carry <code>data-focus</code>, ids and keys only. A drop becomes a focus that names the exact tool call that reads it.</> },
  { title: "Say what you are, and let the person revoke", text: <><code>/.well-known/apc.json</code> names your origin, your profiles and where your MCP URLs live. Revoke in your page cuts an agent at once, and calls nobody.</> },
  { title: "Pass the conformance suite", text: <><code>@tineira/apc-conformance</code> checks the view, the pin, the focus format and revoke through your MCP endpoint, on each profile you offer.</> },
];

const PROFILES = {
  direct: {
    page: "build-direct" as SitePage,
    name: "Direct",
    title: "Connect app by app",
    users: "Each person adds your app's own MCP address to their agent. There is no dock: their agent's mark lives in your page, and they drag it from there.",
    pros: ["Nothing sits between your app and the agent: what the person points at goes straight from your app to their agent.", "The simplest to ship: no pairing, no hub.", "No dependency on anyone's dock."],
    cons: ["Each person adds one MCP address per app they use.", "They point their agent from each app's own page."],
  },
  dock: {
    page: "build-dock" as SitePage,
    name: "Dock",
    title: "Connect once",
    users: "Each person connects their agent once, to their own dock, and drags it from the dock onto your app and any other app they paired.",
    pros: ["One connection follows the person across every paired app.", "One place to follow what the agent reads, and one identity across apps."],
    cons: ["Adds a pairing step: the person allows your app in your page and in their dock.", "The dock relays your tools, so your results reach the agent through it.", "Until the dock lists your app as verified, the person sees a \"Not verified\" warning first."],
  },
} as const;

const SHIP_BOTH = "Let each person choose: Direct for whoever uses only your app, Dock for whoever uses several. The same agent on both paths shows as one.";

const REF_GROUPS = [
  {
    title: "Start here",
    refs: [
      { title: "Integration guide", text: "Integrate your app in an afternoon, on both profiles", href: `${DOCS}/integrate` },
      { title: "Docs", text: "The standard, in five pages", href: DOCS },
    ],
  },
  {
    title: "Deep dive",
    refs: [
      { title: "Spec", text: "The core, the Direct and Dock profiles, the focus format", href: `${DOCS}/spec` },
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

/** Each profile page's own references: the guide's section, the spec's section, the suite. */
const PROFILE_REFS = {
  direct: [
    { title: "Integration guide: Direct", href: `${DOCS}/integrate#4-direct-an-agent-per-grant` },
    { title: "Spec: the Direct profile", href: `${DOCS}/spec#the-direct-profile` },
    { title: "Conformance suite", href: `${DOCS}/conformance` },
  ],
  dock: [
    { title: "Integration guide: Dock", href: `${DOCS}/integrate#12-dock-agents-dragged-from-a-dock` },
    { title: "Spec: the Dock profile", href: `${DOCS}/spec#the-dock-profile` },
    { title: "Conformance suite", href: `${DOCS}/conformance` },
  ],
  both: [
    { title: "Spec: apc_link", href: `${DOCS}/spec#apc_link` },
    { title: "Integration guide: the agent bar", href: `${DOCS}/integrate#9-the-agent-bar-and-pinning` },
    { title: "Conformance suite", href: `${DOCS}/conformance` },
  ],
};

/** The calls `apc_link` takes in an app, as in the integration guide's Orders (src/docs/examples/orders-app.ts). */
export const LINK_SNIPPET = `// A connection arrives (initialize): note its MCP client.
this.links.arrived(grant.id, grant.client);

// Around every tool: the offer, at most once per MCP session.
const offer = result.isError ? null : await this.links.offer(grant.id, tool);
return offer ? attachApcLink(result, offer) : result;

// With both profiles: the tool the agent answers on its other connection.
registerApcLinkTool(server, { appName: "Orders", redeem: (code) => this.links.redeem(grant.id, code) });`;

/** Both profiles declared, as Signals does: its wrangler.jsonc, and its apc.json (apps/signals/src/worker/index.ts). */
export const PROFILES_SNIPPET = `// wrangler.jsonc
"vars": { "APC_PROFILES": "direct,dock" }

// GET /.well-known/apc.json
app.get("/.well-known/apc.json", (c) => apcJsonResponse(apcManifest({ name: "Signals", origin: new URL(c.req.url).origin, profiles: parseProfiles(c.env.APC_PROFILES), connect: "/?connect" })));`;

function Back() {
  return (
    <p className="landing-back">
      <a href={SITE_PAGES.build.path}>← Build it: choose a profile</a>
    </p>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="landing-block">
      <h2 className="landing-h2">{props.title}</h2>
      {props.children}
    </section>
  );
}

function Refs(props: { refs: readonly { title: string; href: string }[] }) {
  return (
    <ul className="landing-reflist">
      {props.refs.map((r) => (
        <li key={r.href}>
          <a href={r.href}>{r.title} →</a>
        </li>
      ))}
    </ul>
  );
}

function ShipBothNext(props: { other: "Direct" | "Dock" }) {
  return (
    <a className="landing-both" href={SITE_PAGES["build-both"].path}>
      <span>
        <b>Want the other path too? Ship both.</b> Add {props.other} later without redoing anything: the same tools, the same focus format and the same core serve both.
      </span>
      <span className="landing-both-go" aria-hidden="true">→</span>
    </a>
  );
}

export function BuildPage() {
  return (
    <main className="landing">
      <SiteHeader page="build" />
      <section>
        <p className="landing-back">
          New to APC? <a href={SITE_PAGES.try.path}>Try the demo first →</a>
        </p>
        <h1 className="landing-eyebrow">Build it</h1>
        <p className="landing-title">Make your app pointable</p>
        <p className="landing-sub">
          APC is an open standard over MCP. Your app keeps its data and answers the person's agent with just what they pointed at, through its own tools. Choose how agents reach your app.
        </p>
        <div className="landing-profiles">
          {(["direct", "dock"] as const).map((key) => {
            const p = PROFILES[key];
            return (
              <div className="landing-path" key={key}>
                <span className="landing-who">{p.name}</span>
                <h3>{p.title}</h3>
                <p>{p.users}</p>
                <div className="landing-procon">
                  <b>Pros</b>
                  <ul className="landing-pros">{p.pros.map((t) => <li key={t}>{t}</li>)}</ul>
                  <b>Cons</b>
                  <ul className="landing-cons">{p.cons.map((t) => <li key={t}>{t}</li>)}</ul>
                </div>
                <div className="row">
                  <a className="landing-cta ghost" href={SITE_PAGES[p.page].path}>Build {p.name} →</a>
                </div>
              </div>
            );
          })}
        </div>
        <a className="landing-both" href={SITE_PAGES["build-both"].path}>
          <span>
            <b>Ship both.</b> {SHIP_BOTH}
          </span>
          <span className="landing-both-go">How to ship both →</span>
        </a>
      </section>

      <section>
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

      <SiteFooter onPage={BUILD_LINKS} />
    </main>
  );
}

export function BuildDirectPage() {
  return (
    <main className="landing">
      <SiteHeader page="build-direct" />
      <section>
        <Back />
        <h1 className="landing-eyebrow">The Direct profile</h1>
        <p className="landing-title">Connect app by app</p>
        <p className="landing-sub">
          The agent connects to your app's own MCP URL. There is no dock: the agent's mark lives in your page, where the person drags it onto what they mean.
        </p>
      </section>

      <Section title="What every app implements">
        <Steps steps={CORE_STEPS} />
      </Section>

      <Section title="What Direct adds">
        <ul className="landing-list">
          <li><b>A grant per agent.</b> The person makes an agent in your page; your server makes a grant with a secret of 128 random bits, the last segment of that agent's MCP URL (<code>newDirectGrant</code> in <code>@tineira/apc-server</code>). The URL is the access: Streamable HTTP, no OAuth.</li>
          <li><b>The agent list.</b> Where the person makes and names agents and copies the URL, or a prompt that asks their agent to add it (<code>&lt;apc-direct-agents&gt;</code> in <code>@tineira/apc-web</code>). An agent names itself on <code>initialize</code> until the person renames it.</li>
          <li><b>The agent bar, always in full.</b> <code>&lt;apc-agents&gt;</code> shows each Direct agent's mark, its pin and Revoke: your page is the only place the person sees and points it. On a phone it stays in the page, at the bottom.</li>
          <li><b>In <code>apc.json</code></b>, <code>"direct"</code> among the profiles, and <code>direct.connect</code>: the page on your origin where the person connects an agent.</li>
        </ul>
      </Section>

      <Section title="What the agent receives">
        <p className="landing-sub landing-example-caption">
          The focus an agent connected to Pulse gets when the person drops it on March in the chart of active customers: <a href={`${DOCS}/spec#the-pin-and-the-focus-format`}>the focus format</a>, ids and keys only, and the call that reads it.
        </p>
        <Code label="The focus from Pulse">{json(FOCUS_EXAMPLE)}</Code>
      </Section>

      <Section title="References">
        <Refs refs={PROFILE_REFS.direct} />
      </Section>

      <ShipBothNext other="Dock" />
      <SiteFooter />
    </main>
  );
}

export function BuildDockPage() {
  return (
    <main className="landing">
      <SiteHeader page="build-dock" />
      <section>
        <Back />
        <h1 className="landing-eyebrow">The Dock profile</h1>
        <p className="landing-title">Connect once</p>
        <p className="landing-sub">
          The agent connects once, to the person's dock. The person drags it from the dock onto your app, and onto any other app they paired.
        </p>
      </section>

      <Section title="What every app implements">
        <Steps steps={CORE_STEPS} />
      </Section>

      <Section title="What Dock adds">
        <ul className="landing-list">
          <li><b>Take the drop.</b> The dock puts the agent on a drag of type <code>application/x-apc-agent</code> with <code>{"{ v: 1, agent, hub, ticket }"}</code>: a public handle, the hub's origin and a ticket that works once, for 240 seconds. No secret, no MCP URL. Your page sends every dock drop to your server.</li>
          <li><b>Consent on your server.</b> For an agent it holds no grant for, your server answers <code>consent_required</code> with a nonce; your page asks the person, and only the Allow that brings the nonce back makes a grant (<code>DockConsent</code> in <code>@tineira/apc-server</code>). Since APC 0.9 the consent also shows a pairing code, which the person types in their dock to allow it there.</li>
          <li><b>Pair with the hub.</b> Your server hands the grant to the hub, server to server: <code>POST {"{hub}"}/apc/pair</code> with the ticket, the agent, your app, the MCP URL and the pairing code, and keeps the grant only when the hub answers that it holds the code (<code>pairWithHub</code>). The person allows it in their dock too, with the code. On every later drop, <code>POST {"{hub}"}/apc/confirm</code>; when the person unpairs in the dock, the hub calls your <code>POST /apc/revoke</code>.</li>
          <li><b>In <code>apc.json</code></b>, <code>"dock"</code> among the profiles, and an <code>mcp.path</code> that covers the MCP URL you send: the hub reads it before it pairs. Until the hub lists your app as verified, the person sees a warning with your domain first, and your results reach the agent marked untrusted.</li>
        </ul>
      </Section>

      <Section title="What the agent receives">
        <p className="landing-sub landing-example-caption">
          Your app returns the same focus on both profiles. Pulse's, when the person drops their agent on March in the chart of active customers:
        </p>
        <Code label="The focus Pulse returns">{json(FOCUS_EXAMPLE)}</Code>
        <p className="landing-sub landing-example-caption">
          Through the dock, the hub adds the app it came from and rewrites the call that reads it to its own <code>call_app_tool</code> (or to <code>pulse__get_figure</code>, with the same arguments, when the agent's client lists the relayed tools):
        </p>
        <Code label="The same focus, through the dock">{json(DOCK_FOCUS_EXAMPLE)}</Code>
      </Section>

      <Section title="References">
        <Refs refs={PROFILE_REFS.dock} />
      </Section>

      <ShipBothNext other="Direct" />
      <SiteFooter />
    </main>
  );
}

export function BuildBothPage() {
  return (
    <main className="landing">
      <SiteHeader page="build-both" />
      <section>
        <Back />
        <h1 className="landing-eyebrow">Ship both</h1>
        <p className="landing-title">Direct and Dock, in one app</p>
        <p className="landing-sub">
          {SHIP_BOTH} Each profile is complete on its own (<a href={SITE_PAGES["build-direct"].path}>Direct</a>, <a href={SITE_PAGES["build-dock"].path}>Dock</a>); this is what shipping both adds.
        </p>
      </section>

      <Section title="Declare both profiles">
        <p className="landing-sub">
          Your <code>apc.json</code> lists <code>"profiles": ["direct", "dock"]</code>. In the reference apps the one place that decides it is <code>APC_PROFILES</code>, read with <code>parseProfiles</code> from <code>@tineira/apc-server</code>: unset or blank means both, and a word it does not know fails closed to no profile at all, so a typo never opens a path you meant to keep shut.
        </p>
        <Code label="Signals declares both profiles">{PROFILES_SNIPPET}</Code>
      </Section>

      <Section title="One agent on both paths: apc_link">
        <ul className="landing-list">
          <li><b>The offer.</b> When a connection arrives with the same MCP client as one already connected on the other path, your app puts <code>{"apc_link: { code, expires_in, note }"}</code> on a result of the new connection, at most once per MCP session. On the Dock path it rides on one of your own tools, never a core tool.</li>
          <li><b>The answer.</b> The agent calls <code>{"apc_link({ code })"}</code> on its other connection: directly, or through the dock as <code>&lt;app&gt;__apc_link</code>. Your app answers <code>{"{ linked: true, note }"}</code>, or the tool error <code>link_refused</code> with a reason.</li>
          <li><b>The code</b> has at least 96 random bits and works once, for 120 seconds, only on a different connection on the opposite path that it was offered to. Your app keeps only its hash. An agent that ignores it stays two agents.</li>
          <li><b>Which client.</b> On Direct, <code>clientInfo.name</code> of the agent's <code>initialize</code>. Through a dock, the hub names the agent's own client in <code>_meta["apc.tineira.com/agent_client"]</code>, to verified apps only.</li>
        </ul>
        <p className="landing-sub landing-example-caption">
          With <code>ApcLinks</code> from <code>@tineira/apc-server</code>, it is three calls, as in the integration guide's Orders:
        </p>
        <Code label="apc_link in an app">{LINK_SNIPPET}</Code>
      </Section>

      <Section title="The linked agent in the agent bar">
        <ul className="landing-list">
          <li><code>&lt;apc-agents&gt;</code> shows the agent once, tagged <b>direct + dock</b>, when you give it both <code>paths</code>, with Unlink (the event <code>apc-unlink</code>).</li>
          <li>Linking grants nothing. Each path keeps its own grant, trimming and pin; Revoke on the linked agent cuts both grants.</li>
          <li>With any agent that came directly, the bar stays in full. When every agent came through a dock, the person may collapse it to a small indicator of who is reading; it never hides.</li>
        </ul>
      </Section>

      <Section title="Offer the dock to Direct users (optional)">
        <p className="landing-sub">
          While an agent that came only directly is connected, the bar shows a quiet hint, "Use this agent across apps with the dock", until the person dismisses or follows it, once per browser. It is on by default; turn it off with <code>dockHint = null</code>, or <code>dock-hint="off"</code> on <code>&lt;apc-agents&gt;</code>.
        </p>
      </Section>

      <Section title="Test it">
        <p className="landing-sub">
          The conformance suite runs the <code>apc_link</code> checks in process, given a <code>link</code> adapter for an app that offers both profiles; from the command line they are reported as SKIP.
        </p>
        <Refs refs={PROFILE_REFS.both} />
      </Section>

      <SiteFooter />
    </main>
  );
}
