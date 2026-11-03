/**
 * The public landing, laid out like hue.tineira.com (hue-switch-console app/page.tsx): header,
 * hero with a drawing, a numbered list beside a card, a strip of facts, "what you need" cards,
 * three steps, a closing card. It opens no sandbox: that happens when the visitor enters the demo.
 */
import type { ReactNode } from "react";
import { AppLink, CARD_HEADER, EYEBROW, H2, ICON_BUTTON, LogoMark, PAPER_URL, PaperIcon, PartRow, PRIMARY, SECONDARY, SPEC_URL, ThemeToggle } from "../ui.tsx";
import { JoinCard } from "./join-visuals.tsx";
import { PinDiagram } from "./pin-diagram.tsx";

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

const STEPS = [
  { title: "Connect your agent", text: "Open the demo and copy your MCP URL into your agent, as a remote MCP server. No account and no login: the secret in the URL is your agent's access to your sandbox." },
  { title: "Point at something", text: "Drag your agent's mark from the top bar onto a bar, a step of the bridge or a customer row. The chip next to the mark says pinned, then seen." },
  { title: "Ask with what you know", text: "Give your agent your MRR file, then ask about “this”. It answers with numbers the app never had." },
];

function StepVisual({ index }: { index: number }) {
  const box = "flex h-[180px] items-center justify-center rounded-2xl border border-line bg-cream px-5";
  if (index === 0) {
    return (
      <div className={box}>
        <div className="w-full max-w-[280px] rounded-[10px] border border-line bg-background font-mono text-xs">
          <div className="border-b border-line px-3 py-[9px] text-muted">Remote MCP server</div>
          <div className="truncate px-3 py-2.5">
            …/mcp/<span className="text-muted">7f3a…</span>/<span className="text-filament">c41e…</span>
          </div>
        </div>
      </div>
    );
  }
  if (index === 1) {
    return (
      <div className={box}>
        <div className="relative flex h-[110px] items-end gap-2">
          {[44, 58, 50, 72, 66, 88].map((h, i) => (
            <span key={i} className={`block w-5 rounded-[3px] border border-foreground ${i === 4 ? "bg-filament-soft outline-2 outline-offset-2 outline-dashed outline-filament" : "bg-line"}`} style={{ height: h }} />
          ))}
          <span className="absolute -top-2 left-[106px] grid h-[22px] w-[22px] place-items-center rounded-[4px] bg-foreground font-mono text-[9px] font-semibold text-cream">CC</span>
          <span className="absolute -top-3 left-[136px] rounded-full bg-filament-soft px-2 py-0.5 text-[11px] text-filament">pinned</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`${box} flex-col items-stretch gap-2`}>
      <div className="self-end rounded-2xl rounded-br-md bg-filament-soft px-3 py-2 text-[13px]">How much MRR is this?</div>
      <div className="self-start rounded-2xl rounded-bl-md border border-line bg-background px-3 py-2 text-[13px]">
        <span className="font-semibold">$48,210.37</span> <span className="text-muted">across 121 customers; best per seat: cus_0042.</span>
      </div>
    </div>
  );
}

function NeedArt({ kind }: { kind: "agent" | "url" | "file" }) {
  if (kind === "agent") {
    return (
      <div className="flex h-full items-center justify-center gap-3">
        {["CC", "GP", "GR", "CU"].map((t, i) => (
          <span key={t} className={`grid h-11 w-11 place-items-center rounded-lg font-mono text-[13px] font-semibold ${i === 0 ? "bg-foreground text-cream" : "border border-foreground bg-cream text-foreground"}`}>
            {t}
          </span>
        ))}
      </div>
    );
  }
  if (kind === "url") {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="w-full max-w-[260px] rounded-[10px] border border-foreground bg-cream font-mono text-[11px]">
          <div className="flex items-center justify-between border-b border-line px-3 py-2 text-muted">
            <span>mcp url</span>
            <span className="text-filament">copy</span>
          </div>
          <div className="truncate px-3 py-2.5">https://…/mcp/7f3a…/c41e…</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-[240px] rounded-[10px] border border-foreground bg-cream font-mono text-[11px]">
        <div className="border-b border-line px-3 py-2 text-muted">mrr-by-customer.csv</div>
        {[
          ["customer_id", "month", "mrr"],
          ["cus_0042", "2026-03", "1,204.37"],
          ["cus_0107", "2026-03", "318.92"],
        ].map((row, i) => (
          <div key={i} className={`grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-1.5 ${i === 0 ? "text-muted" : ""}`}>
            {row.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const NEEDS: { label: string; title: string; text: string; art: "agent" | "url" | "file" }[] = [
  { label: "01 · Agent", title: "An AI agent that speaks MCP", text: "Any client that accepts a remote MCP server by URL (Streamable HTTP): Claude Code, claude.ai, ChatGPT, Grok, Cursor and others.", art: "agent" },
  { label: "02 · URL", title: "Your MCP URL from the demo", text: "Each visitor gets a private sandbox with synthetic data and one URL per agent. It is deleted after 6 hours without use.", art: "url" },
  { label: "03 · What you know", title: "Something you know that the app does not", text: "The demo gives you a file of MRR per customer, standing in for your billing data. Give it to your agent, never to the app.", art: "file" },
];

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
            <AppLink href="/how-to" className="inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-line bg-background px-3.5 text-sm font-medium hover:border-filament">
              Open the demo
            </AppLink>
          </header>

          <section className="grid items-center gap-[clamp(28px,4cqi,56px)] py-14 min-[860px]:min-h-[calc(100svh-60px)] min-[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] min-[860px]:py-6">
            <div className="flex flex-col items-start gap-6">
              <p className={EYEBROW}>Preprint · Model Context Protocol</p>
              <h1 className="text-balance text-[clamp(40px,5.2cqi,64px)] font-semibold leading-none tracking-[-0.035em]">Point your AI agent at what you see.</h1>
              <p className="max-w-[34em] text-pretty text-[clamp(16px,1.5cqi,18px)] leading-[1.55] text-muted">
                Drag your agent's mark onto a number, a row or one step of a chart, and ask about “this”. The app shares a key, never the screen. Your own agent reads the data behind it with the access it already has, and adds what it knows about you.
              </p>
              <div className="flex flex-wrap gap-2.5">
                <AppLink href="/how-to" className={PRIMARY}>
                  Try the demo
                </AppLink>
                <a href={PAPER_URL} target="_blank" rel="noopener noreferrer" className={`${SECONDARY} gap-2`}>
                  <PaperIcon />
                  Read the paper
                </a>
              </div>
              <p className="text-sm text-muted">No sign-up. You get a private sandbox with synthetic data, deleted after 6 hours without use.</p>
              <AppLink href="/how-to" className="text-[15px] font-medium text-filament hover:underline">
                Read the how-to →
              </AppLink>
            </div>
            <PinDiagram />
          </section>
        </div>

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

        <section aria-label="Why it works this way" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,230px),1fr))] border-y border-line">
          {FACTS.map((fact) => (
            <div key={fact.title} className="flex flex-col gap-1.5 py-[22px] pr-5">
              <h2 className="text-[15px] font-semibold">{fact.title}</h2>
              <p className="text-pretty text-sm leading-normal text-muted">{fact.text}</p>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-7">
          <h2 className={H2}>What you need</h2>
          <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
            {NEEDS.map((card) => (
              <li key={card.label} className="flex flex-col overflow-hidden rounded-[20px] border border-line bg-cream">
                <div className={CARD_HEADER}>
                  <span>{card.label}</span>
                </div>
                <div aria-hidden="true" className="bp-grid relative h-[230px] border-b border-line">
                  <NeedArt kind={card.art} />
                </div>
                <div className="flex flex-col gap-1.5 px-[18px] pb-5 pt-4">
                  <h3 className="text-lg font-semibold">{card.title}</h3>
                  <p className="text-pretty text-[15px] leading-normal text-muted">{card.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-7">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className={H2}>From URL to answer in three steps</h2>
            <AppLink href="/how-to" className="text-[15px] font-medium text-filament hover:underline">
              Full how-to →
            </AppLink>
          </div>
          <ol className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-3.5">
                <StepVisual index={i} />
                <span className="font-mono text-xs text-filament">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="text-lg font-semibold">{step.title}</h3>
                <p className="text-pretty text-[15px] leading-normal text-muted">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-wrap items-center justify-between gap-6 rounded-3xl border border-line bg-cream p-[clamp(24px,4cqi,44px)]">
          <div className="flex flex-[1_1_320px] flex-col gap-2">
            <h2 className="text-[clamp(24px,2.6cqi,32px)] font-semibold leading-[1.15] tracking-[-0.02em]">Try it with your own agent.</h2>
            <p className="text-[15px] leading-normal text-muted">Five minutes, no account. The how-to walks you through connecting, pointing and asking, with your own URL in it.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <AppLink href="/how-to" className={PRIMARY}>
              Open the demo
            </AppLink>
            <a href={PAPER_URL} target="_blank" rel="noopener noreferrer" className={`${SECONDARY} gap-2`}>
              <PaperIcon />
              Read the paper
            </a>
          </div>
        </section>

        <p className="mb-8 max-w-[52em] text-xs leading-normal text-muted">
          Pulse is a fictional product and its data is synthetic. Claude, ChatGPT, Grok and Cursor are trademarks of their owners; this project is independent and not affiliated with or endorsed by them.
        </p>
      </main>
    </div>
  );
}
