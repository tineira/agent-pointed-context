/**
 * The developer's page (TIN-626, TIN-627; one page since the Dock left, TIN-1061; lane D's calm layout, TIN-1068):
 * what every app implements as four numbered rows, beside the real focus an agent receives from Pulse; the four
 * packages; the guide links; and the open-list note. Every claim comes from the spec
 * (src/docs/pages/spec.md), the integration guide's tested example (src/docs/examples/orders-app.ts) and the
 * packages; scripts/test/site-focus.test.mjs and apps/site/test/pages.test.ts check the payload and the links.
 */
import { FOCUS_EXAMPLE } from "./landing-example.ts";
import { useScrollReveals } from "./reveal.ts";
import { SiteBackdrop, SiteFooter, SiteHeader } from "./site.tsx";
import { DOCK_PRODUCT, DOCS, PAPER, RECORDS, REPO, SITE_PAGES } from "./site-pages.ts";

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** What every APC app implements: the core. */
const CORE_STEPS = [
  { title: "Serve an MCP endpoint", text: <>Each agent gets its own grant, and an MCP URL whose last segment is the grant's secret. <code>get_current_view</code> and <code>wait_for_focus</code> sit beside your own tools, and every tool runs inside one wrapper: revoke, <code>attention</code>, presence, <code>then</code>.</> },
  { title: "Make things pointable", text: <>Charts, rows and paragraphs carry <code>data-focus</code>, ids and keys only. A drop becomes a focus that names the exact tool call that reads it, in <code>next</code> and <code>next_args</code>.</> },
  { title: "Publish apc.json and offer Revoke", text: <><code>/.well-known/apc.json</code> names your origin, your profiles and where your MCP URLs live. Revoke in your page cuts an agent at once, and calls nobody.</> },
  { title: "Pass the conformance suite", text: <><code>@tineira/apc-conformance</code> checks the view, the pin, the focus format and revoke through your MCP endpoint.</> },
] as const;

/** The four packages the standard ships as (packages/protocol, server, web, conformance). */
const PACKAGES = ["@tineira/apc-protocol", "@tineira/apc-server", "@tineira/apc-web", "@tineira/apc-conformance"] as const;

/** The guide row: the docs a builder starts with, then the record and the code. */
const GUIDES: readonly { title: string; href: string; out?: boolean }[] = [
  { title: "Integration guide", href: `${DOCS}/integrate` },
  { title: "Conformance suite", href: `${DOCS}/conformance` },
  { title: "Docs", href: DOCS },
  { title: "Spec", href: `${DOCS}/spec` },
  { title: "Payload specification", href: RECORDS, out: true },
  { title: "Paper", href: PAPER, out: true },
  { title: "GitHub", href: REPO, out: true },
];
/** Every link the /build body has, so its footer leaves them out. */
const BUILD_LINKS = GUIDES.map((g) => g.href);

export function BuildPage() {
  useScrollReveals();
  return (
    <div className="site-shell">
      <SiteBackdrop />
      <div className="site-page">
        <SiteHeader page="build" />
        <main className="landing">
          <section className="page-hero">
            <p className="page-back">
              New to APC? <a href={SITE_PAGES.try.path}>Try the demo first →</a>
            </p>
            <p className="page-eyebrow">
              <i aria-hidden="true" />Build it
            </p>
            <h1>
              Make your app <em>pointable.</em>
            </h1>
            <p className="page-lede">
              An APC app serves its own remote MCP endpoint. The person connects an agent to your app, and the agent reads through the tools you already have. Your app keeps its data.
            </p>
            <div className="page-cta-row">
              <a className="btn primary" href={`${DOCS}/integrate`}>
                Integrate your app in an afternoon <span aria-hidden="true">→</span>
              </a>
              <a className="btn ghost" href={`${DOCS}/spec`}>Read the spec</a>
            </div>
          </section>

          <section className="build-grid">
            <div className="rv">
              <h2 className="build-h2">What to implement</h2>
              <ol className="build-steps">
                {CORE_STEPS.map((s) => (
                  <li className="build-step" key={s.title}>
                    <h3>{s.title}</h3>
                    <p>{s.text}</p>
                  </li>
                ))}
              </ol>
            </div>
            <div className="build-code rv">
              <span className="build-code-idx">Example from Pulse · real output</span>
              <h3>What the agent receives</h3>
              <p>
                The focus an agent connected to Pulse gets when the person drops it on March in the chart of active
                customers: <a href={`${DOCS}/spec#the-pin-and-the-focus-format`}>the focus format</a>, ids and keys only, and the call that reads it.
              </p>
              <pre aria-label="The focus from Pulse">
                <code>{json(FOCUS_EXAMPLE)}</code>
              </pre>
            </div>
          </section>

          <div className="build-packages rv">
            <b>Packages</b>
            {PACKAGES.map((p) => (
              <span className="build-chip" key={p}>
                {p}
              </span>
            ))}
          </div>

          <nav className="build-guides rv" aria-label="Guides and references">
            {GUIDES.map((g) => (
              <a key={g.title} href={g.href}>
                {g.title} <span aria-hidden="true">{g.out ? "↗" : "→"}</span>
              </a>
            ))}
          </nav>

          <p className="build-note rv">
            <code>profiles</code> in <code>apc.json</code> is an open list. APC defines and checks <code>"direct"</code>; a
            profile it does not define is specified by whoever defines it, and an app that declares one also meets
            that profile's own spec.
            {DOCK_PRODUCT && <> The <a href={DOCK_PRODUCT.url}>{DOCK_PRODUCT.name}</a>, for one, defines <code>"dock"</code> in a protocol of its own.</>}
          </p>

          <p className="build-lic rv">Free and open: code MIT, docs and spec CC BY 4.0.</p>
        </main>
        <SiteFooter onPage={BUILD_LINKS} />
      </div>
    </div>
  );
}
