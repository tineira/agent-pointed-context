/**
 * The public landing, laid out like hue.tineira.com (hue-switch-console app/page.tsx): header,
 * hero with a drawing, a choice of connection models, and the sections explaining the standard.
 * It opens no sandbox: that happens when the visitor enters the demo.
 */
import type { ReactNode } from "react";
import { AppLink, CARD_HEADER, EYEBROW, H2, ICON_BUTTON, LogoMark, PAPER_URL, PaperIcon, PartRow, PRIMARY, SPEC_URL, ThemeToggle } from "../ui.tsx";
import { JoinCard } from "./join-visuals.tsx";
import { PinDiagram } from "./pin-diagram.tsx";
import "./chooser.css";

const BRING = [
  { n: "1", name: "Pulse knows the product", text: "Customers, plans, regions, seats and activity. It does not know revenue, and it should not." },
  { n: "2", name: "You know the money", text: "Revenue per customer lives in your billing system or a spreadsheet, and you never hand it to an analytics vendor." },
  { n: "=", name: "Your agent has both", text: "Point at a figure: your agent gets the customer ids behind it from Pulse, matches them with your file, and answers what neither side could alone." },
];

const FACTS: { title: string; text: ReactNode }[] = [
  { title: "Your own agent", text: "Claude, ChatGPT, Grok, Cursor or any agent that speaks MCP. The app hosts no model and no chat." },
  { title: "Keys, not pixels", text: "The app sends a key for what you pointed at, never a screenshot, text or amounts. Your agent reads the rest with its own tools." },
  { title: "Same access, same number", text: "Every read passes the grant your agent already has, and the app recomputes a figure with the function that drew it." },
  { title: "What you know stays yours", text: "Your agent joins the app's data with what it knows about you. The app never receives your side." },
];

const CHANNELS = [
  { name: "View", text: "The screen you are on, as identifiers: page, month, filters, at most one selected row. Your agent asks for it when you say “this”." },
  { name: "Pin", text: "Drag your agent's mark onto a row, a cell or one step of a computed figure. The pin carries a key and the exact tool call that reads it." },
  { name: "Presence", text: "Each agent is a mark on screen, and lights up on what it reads. You see which agent is at work, and where." },
];

const FOCUS_JSON = `{
  "kind": "figure",
  "part": "step:churned",
  "params": { "key": "customer_bridge",
              "month": "2026-03" },
  "next": "get_figure",
  "next_args": { "key": "customer_bridge",
                 "params": { "month": "2026-03",
                             "step": "churned" } },
  "part_note": "churned is one of the five
    steps in values; its customers are in
    breakdown.churned."
}`;

const COMPARISON = [
  ["Your agent connects to", "Each app, one connection per app", "Your dock, once"],
  ["Adding your 20th app", "One more connection set up in your agent", "Drop your agent on it and allow it"],
  ["Works with", "Apps that implement the standard", "Apps that implement the standard, plus any web page with the extension"],
  ["Reading two apps together", "Yes, with both connections", "Yes, through one connection"],
  ["Runs on", "Web apps today; the standard also fits desktop apps", "Web and desktop apps. Your dock runs on the web and as a Windows app; Mac and Linux later"],
  ["You drag your agent from", "Inside each app", "Your dock: a window, Float, or Windows"],
  ["Your data goes", "From each app to your agent", "Through your dock to your agent"],
];

/** Generic examples keep the standard separate from the demo apps. */
function ConnectionDiagram({ once = false }: { once?: boolean }) {
  const marker = once ? "once-arrow" : "per-app-arrow";
  return (
    <figure className="chooser-diagram">
      <svg viewBox="0 0 440 180" role="img" aria-label={once ? "Your agent connects to your dock, which connects to a web app, a desktop app and any page with the extension" : "Your agent makes a separate connection to each of three apps"}>
        <defs>
          <marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0 0 7 3.5 0 7" fill="none" stroke="currentColor" />
          </marker>
        </defs>
        <g className="diagram-arrows" fill="none" stroke="currentColor" markerEnd={`url(#${marker})`}>
          {once ? <>
            <path d="M91 90H120" />
            <path d="M255 90H278V29H307" />
            <path d="M255 90H307" />
            <path d="M255 90H278V151H307" />
          </> : <>
            <path d="M135 78C190 78 210 29 307 29" />
            <path d="M135 90H307" />
            <path d="M135 102C190 102 210 151 307 151" />
          </>}
        </g>
        <rect className="diagram-box" x={once ? 4 : 15} y="68" width={once ? 87 : 120} height="44" rx="8" />
        <text x={once ? 47.5 : 75} y="94" textAnchor="middle">Your agent</text>
        {once && <>
          <rect className="diagram-dock" x="125" y="51" width="130" height="78" rx="8" />
          <g className="diagram-dock-text" textAnchor="middle">
            <text x="190" y="76" className="diagram-title">Your dock</text>
            <text x="190" y="97" className="diagram-platform">Web · Windows</text>
            <text x="190" y="114" className="diagram-platform">Mac, Linux later</text>
          </g>
        </>}
        {[29, 90, 151].map((y, i) => (
          <g key={y}>
            <rect className="diagram-box" x="312" y={y - 22} width="124" height="44" rx="8" strokeDasharray={once && i === 2 ? "5 4" : undefined} />
            {once && i < 2 && <g fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <rect x="323" y={y - 8} width="16" height="12" rx="1.5" />
              {i === 0 ? <path d={`M323 ${y - 4}h16`} /> : <path d={`M331 ${y + 4}v4m-5 0h10`} />}
            </g>}
            <text x={once && i < 2 ? 385 : 374} y={y + 4} textAnchor="middle">{once ? ["Web app", "Desktop app", "Any page"][i] : "App"}</text>
          </g>
        ))}
      </svg>
      <figcaption>{once ? "drop your agent on an app to add it" : "one connection in your agent per app"}</figcaption>
    </figure>
  );
}

export function Landing() {
  return (
    <div className="@container flex w-full flex-1 flex-col">
      <main className="mx-auto box-border flex w-full max-w-[1200px] flex-col gap-[clamp(56px,8cqi,104px)] px-[clamp(18px,4cqi,48px)]">
        <div>
          <header className="flex items-center gap-2 pt-5">
            <AppLink href="/" className="mr-auto flex items-center gap-2.5">
              <LogoMark />
              <span className="whitespace-nowrap text-[15px] font-semibold tracking-[-0.01em]">Agent Pointed Context</span>
            </AppLink>
            <a href={PAPER_URL} target="_blank" rel="noopener noreferrer" aria-label="Read the paper" title="Read the paper" className={ICON_BUTTON}>
              <PaperIcon />
            </a>
            <ThemeToggle />
          </header>

          <section className="grid items-center gap-[clamp(28px,4cqi,56px)] py-14 min-[860px]:min-h-[calc(100svh-60px)] min-[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] min-[860px]:py-6">
            <div className="flex flex-col items-start gap-6">
              <p className={EYEBROW}>Preprint · Model Context Protocol</p>
              <h1 className="text-balance text-[clamp(40px,5.2cqi,64px)] font-semibold leading-none tracking-[-0.035em]">Point your AI agent at what you see.</h1>
              <p className="max-w-[34em] text-pretty text-[clamp(16px,1.5cqi,18px)] leading-[1.55] text-muted">
                Drag your agent's mark onto a number, a row or one step of a chart, and ask about “this”. The app shares a key, never the screen. Your own agent reads the data behind it with the access it already has, and adds what it knows about you.
              </p>
            </div>
            <PinDiagram />
          </section>
        </div>

        <section id="choose" className="chooser-section" aria-labelledby="chooser-title">
          <div className="chooser-intro">
            <h2 id="chooser-title">Bring your own agent to any app</h2>
            <p>Point it at a chart, a row or a paragraph and ask about “this”. No built-in assistant needed. Two ways to try the standard:</p>
          </div>
          <div className="chooser-cards">
            <article className="chooser-card" aria-labelledby="per-app-title">
              <span className="chooser-version">V1</span>
              <h3 id="per-app-title">Connect app by app</h3>
              <p>Each app that implements the standard gives your agent its own connection. Try it on Pulse, our example app.</p>
              <ConnectionDiagram />
              <div className="chooser-card-foot">
                <p>About a minute</p>
                <AppLink href="/how-to" className="chooser-button">Try it on Pulse <span aria-hidden="true">→</span></AppLink>
              </div>
            </article>
            <article className="chooser-card" aria-labelledby="once-title">
              <span className="chooser-version">V2</span>
              <h3 id="once-title">Connect once</h3>
              <p>Connect your agent once, to your dock. Drop it on any app that implements the standard, on the web or on your desktop, or on any web page with the extension.</p>
              <ConnectionDiagram once />
              <div className="chooser-card-foot">
                <p>Try it on Pulse (web or Windows) and Signals</p>
                <a href="https://v2.apc.tineira.com" className="chooser-button">Open your dock <span aria-hidden="true">→</span></a>
              </div>
            </article>
          </div>
        </section>

        <section id="bring" className="grid items-center gap-[clamp(28px,4cqi,56px)] min-[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="flex flex-col gap-5">
            <span className={EYEBROW}>Why your own agent</span>
            <h2 className={H2}>Your agent knows things the app never will.</h2>
            <p className="text-pretty text-[clamp(16px,1.5cqi,18px)] leading-[1.55] text-muted">
              An assistant built into an app only knows the app. The agent you already use has your files, your other tools and your memory. Point it at a figure and it puts the two together, on its side. The app never receives yours.
            </p>
            <ol className="flex flex-col border-t border-line">
              {BRING.map((b) => (
                <PartRow key={b.name} n={b.n} name={b.name} text={b.text} active={b.n === "="} />
              ))}
            </ol>
            <div className="flex flex-wrap gap-2.5">
              <AppLink href="/how-to?topic=examples" className={PRIMARY}>
                Try it with your MRR file
              </AppLink>
            </div>
          </div>
          <JoinCard />
        </section>

        <section aria-label="Why it works this way" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,230px),1fr))] border-y border-line">
          {FACTS.map((fact) => (
            <div key={fact.title} className="flex flex-col gap-1.5 py-[22px] pr-5">
              <h2 className="text-[15px] font-semibold">{fact.title}</h2>
              <p className="text-pretty text-sm leading-normal text-muted">{fact.text}</p>
            </div>
          ))}
        </section>

        <section className="grid items-start gap-[clamp(28px,4cqi,56px)] min-[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="flex flex-col gap-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted">APC · 3 channels</span>
            <h3 className="text-balance text-[clamp(22px,2.2cqi,28px)] font-semibold leading-[1.15] tracking-[-0.02em]">Three small channels. Keys only, never pixels.</h3>
            <ol className="flex flex-col border-t border-line">
              {CHANNELS.map((c, i) => (
                <PartRow key={c.name} n={String(i + 1)} name={c.name} text={c.text} active={i === 1} />
              ))}
              <PartRow n="→" name="Bring what you know" text="The ids behind every figure are the join keys: the same ids your other systems use." link={{ href: "/how-to?topic=examples", label: "Try it →" }} />
            </ol>
          </div>
          <article className="overflow-hidden rounded-[20px] border border-line bg-cream">
            <div className={CARD_HEADER}>
              <span>Wire · what your agent receives</span>
              <span>~400 bytes</span>
            </div>
            <pre className="overflow-x-auto px-[18px] py-4 font-mono text-[12.5px] leading-[1.6] text-foreground">{FOCUS_JSON}</pre>
            <div className="border-t border-line px-[18px] py-3 text-sm text-muted">
              That is the whole pin. Your agent calls <code className="font-mono text-foreground">next</code> with <code className="font-mono text-foreground">next_args</code>, under its own access, and gets the customers behind the step.{" "}
              <a href={SPEC_URL} target="_blank" rel="noopener noreferrer" className="text-filament hover:underline">
                Payload spec ↗
              </a>
            </div>
          </article>
        </section>

        <section className="chooser-comparison" aria-labelledby="compare-title">
          <h2 id="compare-title">Compare the two ways</h2>
          <table>
            <caption className="sr-only">Connect app by app (V1) and connect once (V2)</caption>
            <thead><tr><td /><th scope="col">Connect app by app <span>(V1)</span></th><th scope="col">Connect once <span>(V2)</span></th></tr></thead>
            <tbody>{COMPARISON.map(([label, perApp, once]) => <tr key={label}><th scope="row">{label}</th><td>{perApp}</td><td>{once}</td></tr>)}</tbody>
          </table>
        </section>

        <p className="mb-8 max-w-[52em] text-xs leading-normal text-muted">
          Pulse is a fictional product and its data is synthetic. Claude, ChatGPT, Grok and Cursor are trademarks of their owners; this project is independent and not affiliated with or endorsed by them.
        </p>
      </main>
    </div>
  );
}
