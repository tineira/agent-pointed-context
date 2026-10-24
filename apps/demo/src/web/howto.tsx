/**
 * The how-to, presented like hue.tineira.com/how-to (hue-switch-console app/how-to/how-to-guide.tsx):
 * what to do (tabs), then numbered steps on a line, each with what your screen or your agent shows
 * at that point. One connect flow for every agent (TIN-360). The visitor's own URL and file are in it.
 */
import { useEffect, useState, type ReactNode } from "react";
import { BRANDS } from "./agent-brands.ts";
import { AgentIcon } from "./agent-icon.tsx";
import { mcpUrl, type Api, type SandboxState } from "./api.ts";
import { AddAgentButtons, AgentCard, askYourAgentPrompt, CopyField, defaultGrant, QrRow } from "./connect.tsx";
import { CompatTable, DownloadCsv } from "./pages.tsx";
import { FileCard, JoinMini } from "./landing/join-visuals.tsx";
import { AppLink, GROUP_LABEL } from "./ui.tsx";

const TOPICS = ["connect", "point", "ask", "examples"] as const;
type Topic = (typeof TOPICS)[number];

const TOPIC_INFO: Record<Topic, { label: string; hint: string }> = {
  connect: { label: "Connect", hint: "Add your MCP URL" },
  point: { label: "Point", hint: "Drag your agent's mark" },
  ask: { label: "Ask or wait", hint: "What it sees, or wait for a pin" },
  examples: { label: "Bring what you know", hint: "The MRR example, and more" },
};


function readQuery(): Topic | null {
  const topic = new URLSearchParams(location.search).get("topic");
  return (TOPICS as readonly string[]).includes(topic ?? "") ? (topic as Topic) : null;
}

function hrefFor(topic: Topic | null): string {
  return topic ? `/how-to?topic=${topic}` : "/how-to";
}

/** The agents we have a logo for, then "+ others": decoration that says any MCP agent works, not a menu. */
const LOGO_ROW = ["claude", "claude-duet", "openai", "grok", "grok-bot", "gemini", "antigravity", "cursor", "kimi", "zai"];

function LogoRow() {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Agents with a logo here; any MCP agent works">
      {LOGO_ROW.map((id) => {
        const brand = BRANDS.find((b) => b.id === id);
        if (!brand) return null;
        return (
          <span key={id} className="mark mark-logo" style={{ cursor: "default" }} title={brand.name}>
            <AgentIcon clientName={null} brandId={id} seed="how-to" />
          </span>
        );
      })}
      <span className="inline-flex h-7 items-center rounded-md border border-line px-2 text-xs text-muted">+ others</span>
    </div>
  );
}

// ---- small pieces ----

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true" className={`shrink-0 text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
      <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" />
    </svg>
  );
}

function Prompt({ text }: { text: string }) {
  return <CopyField text={text} label="Copy prompt" />;
}

function Mark({ text, dim = false, accent = false }: { text: string; dim?: boolean; accent?: boolean }) {
  return (
    <span className={`grid h-[26px] w-[26px] place-items-center rounded-[4px] font-mono text-[10px] font-semibold ${accent ? "bg-filament text-filament-ink" : "bg-foreground text-cream"} ${dim ? "opacity-40" : ""}`}>
      {text}
    </span>
  );
}

function Snippet({ children }: { children: string }) {
  return <pre className="w-full overflow-x-auto rounded-md border border-line bg-cream px-2.5 py-2 text-left font-mono text-[10.5px] leading-[1.55]">{children}</pre>;
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-xs text-muted">You need</span>
      {items.map((need) => (
        <span key={need} className="rounded-full border border-line px-2 py-1 text-xs">
          {need}
        </span>
      ))}
    </div>
  );
}

interface StepDef {
  title: string;
  where?: { label: string; href: string };
  body: ReactNode;
  note?: ReactNode;
  now?: { label: string; content: ReactNode; caption?: string };
}

/** Numbered steps on a line, then a green done card (hue: SetupSection). */
function Steps({ steps, done }: { steps: StepDef[]; done: { title: string; text: ReactNode } }) {
  return (
    <ol className="flex flex-col">
      {steps.map((step, i) => (
        <li key={step.title} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-4">
          <div className="flex flex-col items-center">
            <span className="mt-4 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-filament-soft text-xs font-semibold tabular-nums text-filament">{i + 1}</span>
            <span className="mt-1.5 w-px flex-1 bg-line" />
          </div>
          <div className="mb-3 flex flex-wrap gap-4 rounded-xl border border-line bg-cream p-4 text-sm">
            <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-2">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">{step.title}</span>
                {step.where ? (
                  <AppLink href={step.where.href} className="text-xs text-filament underline underline-offset-2">
                    {step.where.label}
                  </AppLink>
                ) : null}
              </p>
              <div className="flex flex-col gap-2.5 text-muted">{step.body}</div>
              {step.note ? <p className="border-t border-line pt-2 text-xs text-muted">{step.note}</p> : null}
            </div>
            {step.now ? (
              <div className="flex flex-[1_1_148px] flex-col items-center gap-2.5 self-start rounded-[10px] bg-background p-3 text-center sm:flex-[0_0_200px]">
                <span className={`${GROUP_LABEL} text-balance`}>{step.now.label}</span>
                <div className="flex min-h-16 w-full items-center justify-center">{step.now.content}</div>
                {step.now.caption ? <span className="text-xs text-balance">{step.now.caption}</span> : null}
              </div>
            ) : null}
          </div>
        </li>
      ))}
      <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-4">
        <div className="flex justify-center">
          <span className="mt-4 flex h-6 w-6 items-center justify-center rounded-full bg-ok-soft text-ok">
            <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.58l7.3-7.3a1 1 0 0 1 1.4 0Z" />
            </svg>
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-ok/40 bg-ok-soft p-4 text-sm">
          <span className="font-semibold text-ok">{done.title}</span>
          <span className="text-muted">{done.text}</span>
        </div>
      </li>
    </ol>
  );
}

function Section(props: { id: string; title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <section id={props.id} className="flex scroll-mt-6 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">{props.title}</h2>
        <p className="text-sm text-muted">{props.lead}</p>
      </div>
      {props.children}
    </section>
  );
}

// ---- the four topics ----

interface Ctx {
  api: Api;
  sid: string;
  state: SandboxState;
  initials: Map<string, string>;
  activity: number;
  onChanged: () => void;
}

function ConnectTopic({ api, sid, state, initials, onChanged }: Ctx) {
  const grant = defaultGrant(state);
  const url = mcpUrl(sid, grant);
  const others = state.grants.filter((g) => g.id !== grant.id);
  const mine = initials.get(grant.id) ?? "AG";
  const connected = !!grant.client_name;
  const markPanel = {
    label: "Top bar shows now",
    content: (
      <div className="flex items-center gap-2">
        <span className="mark mark-logo" title={mine}>
          <AgentIcon clientName={grant.client_name} clientIcon={grant.client_icon} seed={grant.id} motion={connected ? "idle" : "off"} />
        </span>
        <span className="text-left text-xs">{connected ? `Connected as ${grant.client_name}` : "Waiting for your agent"}</span>
      </div>
    ),
  };
  return (
    <Section id="connect" title="Connect your agent" lead="About two minutes, once per agent. The sandbox, its URL and its log last 6 hours after you last use them.">
      <Chips items={["An agent that speaks MCP", "This page open in this browser"]} />
      <Steps
        steps={[
          {
            title: "Add this URL to your agent",
            body: (
              <>
                <span>Copy it and add it to your agent as a remote MCP server (Streamable HTTP). No login: the access is in the URL. Leave any OAuth or API key fields empty.</span>
                <CopyField text={url} />
                <QrRow text={url} />
              </>
            ),
            note: "Keep it to yourself. Anyone with it can read this sandbox's synthetic data, but only this browser can point.",
          },
          {
            title: "Don't know how to connect an MCP server? Ask your agent.",
            body: (
              <>
                <span>Paste this to your agent. It already has your URL in it.</span>
                <Prompt text={askYourAgentPrompt(url)} />
              </>
            ),
            note: "The server also offers a prompt named guide, the manual for your agent. If your agent lists MCP prompts, pick it once per session.",
          },
          {
            title: "Check it",
            body: (
              <span>
                Once it's connected, ask it: <em>what am I looking at?</em>
              </span>
            ),
            now: markPanel,
          },
          {
            title: "One URL per agent",
            body: (
              <>
                <span>Trying several agents? Give each its own URL, so each gets its own mark and you can tell which one answered. A new agent's URL and QR show up here; all URLs are on the Agents page.</span>
                <AddAgentButtons api={api} state={state} onChanged={onChanged} />
                {others.map((g) => (
                  <AgentCard key={g.id} sid={sid} grant={g} initials={initials.get(g.id)} compact />
                ))}
              </>
            ),
            where: { label: "Agents", href: "/agents" },
          },
        ]}
        done={{ title: "Your agent's logo shows in the top bar.", text: <>Once your agent connects, its logo replaces the grey mark, and it moves each time your agent uses a tool.</> }}
      />
    </Section>
  );
}

function PointTopic({ initials, state }: Ctx) {
  const grant = defaultGrant(state);
  const mine = initials.get(grant.id) ?? "AG";
  return (
    <Section id="point" title="Point your agent at something" lead="Pointing is one gesture, and it sends your agent a key, not a picture. It reads the numbers itself, under its own access.">
      <Steps
        steps={[
          {
            title: "Open a page with data",
            where: { label: "Overview", href: "/overview" },
            body: <span>Overview has the active customers per month and the customer bridge; Customers has one row per customer. Everything with a number on it can be pointed at.</span>,
          },
          {
            title: "Drag your agent's mark onto it",
            body: <span>Press on your mark in the top right and drag it onto a bar, a step of the bridge, a customer row or a single cell. While you drag, everything you can point at shows a dashed outline; the target under the mark turns solid.</span>,
            note: "Each agent has one pin. A new drop replaces it, and the × next to the mark removes it.",
            now: {
              label: "Screen shows now",
              content: (
                <div className="relative flex h-[64px] items-end gap-1.5">
                  {[24, 32, 28, 40, 36, 48].map((h, i) => (
                    <span key={i} className={`block w-3.5 rounded-[2px] border border-foreground ${i === 4 ? "bg-filament-soft outline-2 outline-offset-1 outline-dashed outline-filament" : "bg-line"}`} style={{ height: h }} />
                  ))}
                  <span className="absolute -top-3 left-[72px]">
                    <Mark text={mine} />
                  </span>
                </div>
              ),
              caption: "The target is outlined",
            },
          },
          {
            title: "Watch the chip next to your mark",
            body: (
              <span>
                It says <span className="rounded-full bg-filament-soft px-2 py-0.5 text-xs text-filament">pinned</span> until your agent reads the pin, then <span className="rounded-full bg-ok-soft px-2 py-0.5 text-xs text-ok">seen</span>.
              </span>
            ),
            now: {
              label: "Top bar shows now",
              content: (
                <div className="flex items-center gap-2">
                  <Mark text={mine} />
                  <span className="rounded-full bg-filament-soft px-2 py-0.5 text-xs text-filament">pinned ×</span>
                </div>
              ),
            },
          },
        ]}
        done={{ title: "Your agent has a pin waiting.", text: "It learns about it on its next tool call, or right away when you ask it about “this”." }}
      />
    </Section>
  );
}

function AskTopic(_: Ctx) {
  return (
    <Section id="ask" title="Ask what it sees, or let it wait" lead="Your agent reads your screen as identifiers and your pin as a key, then fetches the facts behind them.">
      <Steps
        steps={[
          {
            title: "Ask what you are looking at",
            body: (
              <>
                <span>Ask your agent:</span>
                <Prompt text="What am I looking at in Pulse?" />
                <span>It calls get_current_view: your page, month and filters, at most one selected customer, and your pin if there is one. Reading the pin marks it seen.</span>
              </>
            ),
            now: { label: "Your agent gets", content: <Snippet>{'{ "view": {\n  "screen": "overview",\n  "params": { "month": "2026-09" } },\n  "focus": { "kind": "figure", … } }'}</Snippet> },
          },
          {
            title: "Or let it wait for a pin",
            body: (
              <>
                <span>Ask:</span>
                <Prompt text="Wait until I point you at something in Pulse, then tell me what it is." />
                <span>It calls wait_for_focus, which holds for 25 seconds by default (50 at most). Drop your mark while it waits.</span>
              </>
            ),
            note: "If it times out, ask it to wait again. Some agents cap how long one tool call may take.",
            now: { label: "Your agent gets", content: <Snippet>{'{ "focus": { "kind": "customer",\n    "id": "cus_0042", … },\n  "timed_out": false }'}</Snippet> },
          },
          {
            title: "Already talking? Just point",
            body: <span>You need neither of the above in a conversation. Point, then ask about “this”: the pin also travels on your agent's next tool call, with a note that you pointed. After it answers, it waits for your next pin by itself while this page is open and you share your view.</span>,
            now: { label: "Any tool result carries", content: <Snippet>{'"attention": {\n  "focus": { … },\n  "note": "The person pinned\n   you to something…" }'}</Snippet> },
          },
        ]}
        done={{ title: "Your agent describes what you pointed at.", text: "And the chip next to your mark turns to seen." }}
      />
    </Section>
  );
}

function ExamplesTopic(ctx: Ctx) {
  const [open, setOpen] = useState(-1);
  const giveIt = <span>Attach it to your conversation with your agent, or save it where your agent reads files. Do not upload it to Pulse: there is nowhere to, on purpose.</span>;
  const more: Array<{ title: string; steps: ReactNode[] }> = [
    {
      title: "Why did these customers leave?",
      steps: [
        <>
          Open{" "}
          <AppLink href="/overview" className="text-filament underline underline-offset-2">
            Overview
          </AppLink>
          . In Customer bridge, drag your mark onto the red <span className="font-medium text-foreground">Churned</span> step.
        </>,
        <>Ask: “Why is this number what it is? Who are these customers?”</>,
        <>Your agent reads the bridge for that month and lists the churned customers with their plan, region and seats. The answer comes from the data behind the step, not from a picture of it.</>,
      ],
    },
    {
      title: "What does a restricted agent see?",
      steps: [
        <>
          In{" "}
          <AppLink href={hrefFor("connect")} className="text-filament underline underline-offset-2">
            Connect
          </AppLink>
          , step 3 (or on{" "}
          <AppLink href="/agents" className="text-filament underline underline-offset-2">
            Agents
          </AppLink>
          ), add a restricted agent (LATAM only); its URL and QR appear right there. Connect it with that URL.
        </>,
        <>Point it at a bar of Active customers per month, over all regions, and ask how many customers it is.</>,
        <>It answers for LATAM only and says the figure was cut to what it may see. Pointing never grants access.</>,
      ],
    },
  ];
  return (
    <>
      <section id="bring" className="flex scroll-mt-6 flex-col overflow-hidden rounded-2xl border border-filament/50 bg-cream">
        <div className="flex flex-wrap items-center gap-5 border-b border-filament/30 bg-filament-soft px-5 py-5">
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-filament">The one the app can't answer alone</span>
            <h2 className="text-xl font-semibold tracking-tight">Bring what you know: MRR per customer</h2>
            <p className="text-sm text-muted">
              Pulse knows customers and seats, not revenue. You know revenue, and keep it to yourself. Your agent gets the customer ids behind a figure from Pulse, matches them with your file, and answers with numbers Pulse never had. This is the reason to point <em>your own</em> agent.
            </p>
          </div>
        </div>
        <div className="p-4 sm:p-5">
          <Steps
            steps={[
              {
                title: "Download your file",
                body: (
                  <>
                    <span>It stands in for your billing export: one row per customer and month, keyed by the same customer id Pulse uses. Your browser makes it; Pulse's server has no revenue data at all.</span>
                    <div>
                      <DownloadCsv seed={ctx.state.seed} />
                    </div>
                  </>
                ),
                now: { label: "You have now", content: <FileCard compact /> },
              },
              {
                title: "Give it to your agent, not to Pulse",
                body: giveIt,
                now: {
                  label: "Your agent has now",
                  content: (
                    <div className="flex flex-col items-center gap-1.5">
                      <span className="rounded-full border border-filament bg-cream px-2.5 py-1 font-mono text-[11px]">mrr-by-customer.csv</span>
                      <span className="text-[11px] text-muted">Pulse: nothing new</span>
                    </div>
                  ),
                },
              },
              {
                title: "Point at a bar of Active customers per month",
                where: { label: "Overview", href: "/overview" },
                body: <span>Drag your mark onto any month. The pin carries the figure's key and month; your agent will fetch the customers behind it.</span>,
              },
              {
                title: "Ask with both",
                body: (
                  <>
                    <Prompt text="How much MRR is this, and which customer has the best MRR per seat?" />
                    <span>Your agent calls get_figure (the customer ids and seats in that bar), reads your file, and matches them on customer_id.</span>
                  </>
                ),
                now: { label: "Your agent joins", content: <JoinMini /> },
              },
            ]}
            done={{
              title: "Your agent answers with numbers Pulse never had.",
              text: (
                <>
                  Total MRR for the bar and the best customer per seat. Check for yourself: in this sandbox's{" "}
                  <a href={ctx.api.eventsUrl} className="text-filament underline underline-offset-2">
                    log
                  </a>
                  , no MRR value appears in anything your agent sent to Pulse.
                </>
              ),
            }}
          />
        </div>
      </section>

      <Section id="more" title="More to try" lead="Shorter, and Pulse could answer these on its own: they show the pointer, not the join.">
        <div className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-cream text-sm">
          {more.map((task, i) => {
            const expanded = open === i;
            return (
              <div key={task.title}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? -1 : i)}
                  className="flex min-h-11 w-full cursor-pointer touch-manipulation items-center justify-between gap-3 px-4 py-3.5 text-left font-medium hover:bg-filament-soft/40"
                >
                  <span>{task.title}</span>
                  <Chevron open={expanded} />
                </button>
                {expanded ? (
                  <ol className="flex flex-col gap-2 px-4 pb-4">
                    {task.steps.map((step, j) => (
                      <li key={j} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 text-muted">
                        <span className="text-xs font-semibold leading-5 tabular-nums text-filament">{j + 1}</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            );
          })}
        </div>
      </Section>

      <Section id="results" title="What your agents did" lead="Live from this sandbox's log: whether each agent connected, whether pins reached it, how it read them, and whether it made the call the pin named.">
        <div className="overflow-hidden rounded-xl border border-line bg-cream p-2">
          <CompatTable api={ctx.api} initials={ctx.initials} grants={ctx.state.grants} refreshKey={ctx.activity} />
        </div>
      </Section>
    </>
  );
}

// ---- the guide ----

export function HowTo(props: { api: Api; sid: string; state: SandboxState; initials: Map<string, string>; activity: number; onChanged: () => void }) {
  const [topic, setTopic] = useState(readQuery);
  useEffect(() => {
    const onPop = () => setTopic(readQuery());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (next: Topic) => {
    history.pushState(null, "", hrefFor(next));
    setTopic(next);
  };
  const shownTopic: Topic = topic ?? "connect";
  const ctx: Ctx = props;
  const nextOf: Partial<Record<Topic, Topic>> = { connect: "point", point: "ask", ask: "examples" };
  const next = nextOf[shownTopic];

  return (
    <div className="flex w-full flex-col gap-5">
      <section className="flex flex-col gap-3">
        <LogoRow />
        <h1 className="text-2xl font-semibold tracking-tight">How-to</h1>
        <p className="text-sm text-muted">Connect your own agent, point it at things, and ask about them. The steps are the same for any agent that speaks MCP.</p>
      </section>

      <div className="grid grid-cols-2 gap-2 min-[600px]:grid-cols-4" role="radiogroup" aria-label="What you want to do">
        {TOPICS.map((id) => {
          const on = id === shownTopic;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => go(id)}
              className={`flex min-w-0 cursor-pointer touch-manipulation flex-col gap-0.5 rounded-[10px] border px-3 py-2.5 text-left ${on ? "border-filament bg-filament-soft" : "border-line hover:bg-cream"}`}
            >
              <span className={`text-[13.5px] font-semibold ${on ? "text-filament" : ""}`}>{TOPIC_INFO[id].label}</span>
              <span className="text-[11.5px] leading-snug text-muted">{TOPIC_INFO[id].hint}</span>
            </button>
          );
        })}
      </div>

      <div key={shownTopic} className="flex flex-col gap-8 border-t border-line pt-6">
        {shownTopic === "connect" ? <ConnectTopic {...ctx} /> : shownTopic === "point" ? <PointTopic {...ctx} /> : shownTopic === "ask" ? <AskTopic {...ctx} /> : <ExamplesTopic {...ctx} />}
        {next ? (
          <button
            type="button"
            onClick={() => {
              go(next);
              window.scrollTo({ top: 0 });
            }}
            className="cursor-pointer self-start text-sm font-medium text-filament underline underline-offset-2"
          >
            Next: {TOPIC_INFO[next].label} →
          </button>
        ) : null}
      </div>
    </div>
  );
}
