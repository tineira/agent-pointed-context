/**
 * The dock's first run (TIN-403): your dock, connect your agent, create your world. The dock comes
 * first because the agent connects to the dock, not to the apps, and the world lives in the dock: it
 * is the seed every app opens on, so Pulse and Signals invent the same reality without knowing
 * each other. Choosing the world ends the first run; Change world brings that step back.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";
import { askYourAgentPrompt, Qr, SCAN_HINT } from "../../../demo/src/web/qr.tsx";

export interface SetupAgent {
  id: string;
  name: string;
  client_name: string | null;
  client_ua: string | null;
  client_icon: string | null;
  mcp_url: string;
  waiting: boolean;
}

/**
 * The apps the dock opens, each as its own page, all on the dock's seed (TIN-393): the same world in
 * every app, while the apps know nothing of each other. The agent does the joining.
 */
export const APPS = [
  {
    name: "Pulse",
    url: import.meta.env.DEV ? "http://localhost:5199/overview" : "https://pulse.v2.apc.tineira.com/overview",
    glyph: (
      <svg viewBox="0 0 32 32" width="22" height="22">
        <rect x="4" y="8" width="20" height="20" rx="5" fill="none" stroke="currentColor" strokeWidth="3.5" />
        <circle cx="24" cy="8" r="5.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    name: "Signals",
    url: import.meta.env.DEV ? "http://localhost:5201/" : "https://signals.v2.apc.tineira.com/",
    glyph: (
      <svg viewBox="0 0 28 28" width="22" height="22">
        <circle cx="14" cy="14" r="11.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="14" cy="14" r="5.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="14" cy="14" r="2" fill="currentColor" />
      </svg>
    ),
  },
];

export const appUrl = (app: (typeof APPS)[number], seed: number) => `${app.url}?seed=${seed}`;

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0]!;

export function CopyRow(props: { text: string; label?: string; block?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="row copy-row">
      <code className={props.block ? "url url-block" : "url"}>{props.text}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(props.text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? "Copied" : (props.label ?? "Copy")}
      </button>
    </div>
  );
}

/** How to connect one agent to the dock: its MCP URL, the prompt for an agent that does not know how, the QR. */
export function ConnectAgent(props: { agent: SetupAgent }) {
  const { agent } = props;
  return (
    <div className="connect">
      <p>Add this URL to your agent as a remote MCP server (Streamable HTTP). No login: the access is in the URL, so keep it to yourself. Leave any OAuth or API key fields empty.</p>
      <CopyRow text={agent.mcp_url} />
      <p>Don't know how to connect an MCP server? Paste this to your agent:</p>
      <CopyRow text={askYourAgentPrompt(agent.mcp_url)} label="Copy prompt" block />
      <div className="qr-row">
        <Qr text={agent.mcp_url} />
        <p>{SCAN_HINT}</p>
      </div>
    </div>
  );
}

/** Install the dock as an app (Chrome and Edge offer it; elsewhere use the browser's menu). Hidden once installed. */
export function Install(props: { label?: string }) {
  const [prompt, setPrompt] = useState<(Event & { prompt(): Promise<void> }) | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setPrompt(e as Event & { prompt(): Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", on);
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);
  if (!prompt) return null;
  return (
    <button type="button" className="primary" onClick={() => void prompt.prompt().then(() => setPrompt(null))}>
      {props.label ?? "Install"}
    </button>
  );
}

const STEPS = ["Your dock", "Connect your agent", "Create your world"] as const;

/**
 * Open both apps on the world. Both windows open inside the click, before any network call, since
 * a browser lets a click open a window only while it lasts. A browser that allows one window per
 * click blocks the second: the caller is told, and points the person at that app's button.
 */
function openApps(seed: number): string[] {
  const blocked: string[] = [];
  for (const app of APPS) {
    const w = window.open(appUrl(app, seed), "_blank");
    if (w) w.opener = null;
    else blocked.push(app.name);
  }
  return blocked;
}

/** The world step: a seed the person can keep or change, and why it is there. */
function World(props: { seed: number; change: boolean; onBack: () => void; onOpen: (seed: number) => void }) {
  const [text, setText] = useState(String(props.seed));
  const n = Number(text);
  const valid = /^\d{1,10}$/.test(text) && n < 2 ** 32;
  const pulse = APPS[0]!;
  return (
    <>
      <p>
        Pulse and Signals are separate apps with sample data. The world makes them invent the same reality: the churn you see in Pulse lines up with the competitor offers and our ads in Signals. The apps share nothing; only your agent sees both and joins them. The same number gives anyone the same world.
      </p>
      <label className="world">
        <span>World</span>
        <input value={text} inputMode="numeric" maxLength={10} aria-invalid={!valid} onChange={(e) => setText(e.target.value.trim())} />
        <button type="button" title="A new random world" onClick={() => setText(String(randomSeed()))}>
          New
        </button>
      </label>
      {!valid && <p className="warn">A whole number from 0 to 4294967295.</p>}
      {props.change && <p>Changing it gives each app new data: their pins and views go; your agents and their pairings stay.</p>}
      <div className="row">
        <button type="button" onClick={props.onBack}>
          {props.change ? "Cancel" : "Back"}
        </button>
        <button type="button" className="primary" disabled={!valid} onClick={() => props.onOpen(n)}>
          Open Pulse and Signals
        </button>
      </div>
      <div className="row small">
        <span className="muted">Pulse for desktop?</span>
        <button type="button" disabled={!valid} title="The Pulse link on this world, to paste in Pulse for desktop" onClick={() => void navigator.clipboard?.writeText(appUrl(pulse, n))}>
          Copy the Pulse link
        </button>
      </div>
    </>
  );
}

/**
 * The first run, or only its world step (Change world). onDone gets the apps the browser did not let
 * the click open, if any.
 */
export function Setup(props: { agent: SetupAgent | undefined; seed: number; only?: "world"; onWorld: (seed: number) => Promise<void>; onDone: (blocked: string[]) => void }) {
  const [step, setStep] = useState(props.only === "world" ? 2 : 0);
  const { agent } = props;
  const connected = !!agent?.client_name;
  const open = (seed: number) => {
    const blocked = openApps(seed);
    void props.onWorld(seed).then(() => props.onDone(blocked));
  };
  let body: ReactNode;
  if (step === 0) {
    body = (
      <>
        <p>This is your agent dock. Your agents live here: connect each one once, then drag it onto anything in an APC app to point it at what you see. The apps have no agent of their own.</p>
        <p>Install the dock as an app to keep it at hand; Float keeps your agents on top of other windows.</p>
        <div className="row">
          <Install label="Install the dock" />
          <button type="button" className="primary" onClick={() => setStep(1)}>
            Next
          </button>
        </div>
      </>
    );
  } else if (step === 1) {
    body = (
      <>
        {agent && (
          <div className="setup-agent">
            <span className="chip">
              <AgentIcon clientName={agent.client_name} clientUa={agent.client_ua} clientIcon={agent.client_icon} motion={!connected ? "off" : agent.waiting ? "waiting" : "idle"} size={40} />
            </span>
            <span>{connected ? <span className="ok">{agent.name} is connected ✓</span> : "Waiting for your agent…"}</span>
          </div>
        )}
        {/* Once the agent connects, the instructions have done their job: the tile keeps them. */}
        {agent && !connected && <ConnectAgent agent={agent} />}
        <div className="row">
          <button type="button" onClick={() => setStep(0)}>
            Back
          </button>
          <button type="button" className={connected ? "primary" : ""} onClick={() => setStep(2)}>
            {connected ? "Next" : "Skip for now"}
          </button>
        </div>
      </>
    );
  } else {
    body = <World seed={props.seed} change={props.only === "world"} onBack={() => (props.only === "world" ? props.onDone([]) : setStep(1))} onOpen={open} />;
  }
  return (
    <section className="setup" aria-label={props.only === "world" ? "Change world" : "Set up your dock"}>
      {props.only === "world" ? (
        <h2 className="setup-title">Change world</h2>
      ) : (
        <ol className="setup-steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "on" : i < step ? "done" : ""}>
              <span>{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      )}
      {body}
    </section>
  );
}
