import type { Api, SandboxState } from "./api.ts";
import { AddAgentButtons, AgentCard, CompatTable, Copy, DownloadCsv } from "./pages.tsx";

function Step(props: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="card step">
      <h2>
        <span className="step-n">{props.n}</span> {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function Expect(props: { children: React.ReactNode }) {
  return (
    <p className="expect">
      <strong>You should see:</strong> {props.children}
    </p>
  );
}

/** The walkthrough, with the visitor's own URL, file and live results in it. */
export function HowTo(props: { api: Api; sid: string; state: SandboxState; initials: Map<string, string>; onChanged: () => void; go: (screen: "overview" | "customers" | "agents") => void }) {
  const { api, sid, state, initials } = props;
  const first = state.grants.find((g) => !g.regions) ?? state.grants[0]!;
  const mark = initials.get(first.id) ?? "AG";
  return (
    <>
      <section className="card intro">
        <h2>Point your own AI agent at what you see</h2>
        <p>
          Pulse is a small analytics app for a fictional SaaS, with synthetic data. In a few minutes you will connect <em>your own</em> AI agent to it, point that agent at things on the screen, and ask about "this". Pulse never sends your agent a picture of the screen: it
          sends a key, and your agent reads the facts behind it with its own tools. Pulse never sees your chat or your files.
        </p>
        <p className="hint">
          This is the demo of <a href="https://doi.org/10.5281/zenodo.23382909">Agent Pointed Context</a>. Your sandbox is private to this browser and is deleted after 6 hours without use.
        </p>
      </section>

      <Step n={1} title="Connect your agent">
        <p>Add this URL to your agent as a remote MCP server (Streamable HTTP). There is no login: the secret in the URL gives your agent read access to this sandbox only.</p>
        <AgentCard sid={sid} grant={first} initials={mark} />
        <ul>
          <li>
            <strong>Claude Code:</strong> run
            <Copy text={`claude mcp add --transport http pulse ${`${location.origin}/mcp/${sid}/${first.secret}`}`} />
          </li>
          <li>
            <strong>claude.ai or Claude Desktop:</strong> Settings → Connectors → Add custom connector, and paste the URL.
          </li>
          <li>
            <strong>Any other agent</strong> (ChatGPT, Grok, Cursor, Codex…): wherever it accepts a remote MCP server by URL.
          </li>
        </ul>
        <p>
          Trying more than one agent? Give each its own URL, so each gets its own mark and you can tell which one answered. The URLs are on the <button className="link" onClick={() => props.go("agents")}>Agents</button> page.
        </p>
        <AddAgentButtons api={api} state={state} onChanged={props.onChanged} />
        <Expect>
          once your agent connects, its mark in the top right shows its initials (for example <span className="mark-inline">CC</span> for Claude Code) and lights up each time it uses a tool.
        </Expect>
      </Step>

      <Step n={2} title="Point your agent at something">
        <p>
          Drag your agent's mark <span className="mark-inline">{mark}</span> from the top right onto anything on the{" "}
          <button className="link" onClick={() => props.go("overview")}>
            Overview
          </button>{" "}
          or{" "}
          <button className="link" onClick={() => props.go("customers")}>
            Customers
          </button>{" "}
          page: a bar, a step of the customer bridge, a customer row, a single cell. While you drag, everything you can point at shows a dashed outline; the target under the mark turns solid.
        </p>
        <ul>
          <li>Each agent has one pin. A new drop replaces it; the × next to the mark removes it.</li>
          <li>Your agent receives only a key for what you pointed at, never the picture or the numbers. It reads the numbers itself, under its own access.</li>
        </ul>
        <Expect>
          the target keeps a blue outline and the chip next to the mark says <span className="pin">pinned</span>. When your agent reads the pin, the chip turns to <span className="pin seen">seen</span>.
        </Expect>
      </Step>

      <Step n={3} title="Ask what it can see, or let it wait">
        <p>
          <strong>Ask:</strong> <q>What am I looking at in Pulse?</q>
        </p>
        <p className="hint">Your agent calls get_current_view and gets your screen as identifiers (page, month, filters, a selected customer) plus your pin, if there is one.</p>
        <p>
          <strong>Or let it wait:</strong> <q>Wait until I point you at something in Pulse, then tell me what it is.</q>
        </p>
        <p className="hint">
          Your agent calls wait_for_focus, which holds for up to 45 seconds: drop the mark while it waits. If it times out, ask it to wait again. Some agents cap how long one tool call may take.
        </p>
        <p>
          <strong>Already talking with your agent?</strong> You need neither. Point, then ask about "this": the pin also travels on your agent's next tool call, with a note that you pointed.
        </p>
        <Expect>the agent describes the page and the thing you pointed at, and the chip turns to seen.</Expect>
      </Step>

      <Step n={4} title="A simple example">
        <ol>
          <li>
            Open{" "}
            <button className="link" onClick={() => props.go("overview")}>
              Overview
            </button>
            . In <em>Customer bridge</em>, drag your mark onto the red <strong>Churned</strong> step.
          </li>
          <li>
            Ask: <q>Why is this number what it is? Who are these customers?</q>
          </li>
        </ol>
        <Expect>
          your agent reads the bridge for that month, says how many customers churned out of how many at the start, and lists them with their plan, region and seats. The answer comes from the data behind the step, not from a picture of it.
        </Expect>
      </Step>

      <Step n={5} title="Bring what you know: MRR per customer">
        <p>
          Pulse does not know revenue. In real life you would have it in your billing system or a spreadsheet, and you would not hand it to an analytics vendor. This file stands in for that knowledge:
        </p>
        <DownloadCsv seed={state.seed} />
        <ol>
          <li>Give the file to your agent, not to Pulse: attach it in the chat, or put it in the folder your agent works in.</li>
          <li>
            On{" "}
            <button className="link" onClick={() => props.go("overview")}>
              Overview
            </button>
            , drag your mark onto a bar of <em>Active customers per month</em>.
          </li>
          <li>
            Ask: <q>How much MRR is this, and which customer has the best MRR per seat?</q>
          </li>
        </ol>
        <Expect>
          your agent gets the customers and seats behind the bar from Pulse, matches their ids with your file, and gives you the total MRR and the ranking. Pulse never receives an MRR value: the matching happens in your agent.
        </Expect>
      </Step>

      <Step n={6} title="See what your agents did">
        <p className="hint">Live from this sandbox's log. "Envelopes" are tool results that told your agent you pointed; "Followed next" counts pins whose exact call your agent made.</p>
        <CompatTable api={api} initials={initials} refreshKey={state} />
      </Step>
    </>
  );
}
