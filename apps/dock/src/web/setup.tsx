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
      <CopyRow text={askYourAgentPrompt(agent.mcp_url, "APC")} label="Copy prompt" block />
      <div className="qr-row">
        <Qr text={agent.mcp_url} />
        <p>{SCAN_HINT}</p>
      </div>
    </div>
  );
}

/**
 * The APC dock for Windows (#84) loads the dock in its own windows: the dock, marked by a script the
 * app runs on every load (so it holds through Start over), which needs no Install or Float, and each
 * agent as a desktop pet with ?view=pet&agent=<id> (TIN-479, pet.tsx). Its builds before the pets
 * opened an always-on-top strip with ?view=strip, which still works.
 */
export const DESKTOP_SHELL = (window as { __APC_SHELL__?: string }).__APC_SHELL__ === "desktop";
/** The global shortcut the desktop dock registers (SHORTCUT in apps/dock-desktop/src/main.rs). */
export const DESKTOP_SHORTCUT = "Alt+Shift+Space";

/**
 * The APC dock for Windows (#84), offered on Windows outside the app itself: each build of main
 * replaces the installer on the dock-desktop prerelease, so the link never changes.
 */
export const DOCK_DESKTOP = {
  url: "https://github.com/tineira/agent-pointed-context/releases/download/dock-desktop/APCDockSetup.exe",
  note: "Unsigned for now: Windows asks once (More info, then Run anyway).",
  offered: !DESKTOP_SHELL && /Windows/.test(navigator.userAgent),
};

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

const STEPS = ["Your dock", "Connect your agent", "Create your world", "Open Pulse", "Open Signals"] as const;
const WORLD = 2;

/**
 * Pulse for desktop, per platform (TIN-406): each build of main replaces the file on the
 * pulse-desktop prerelease, so the link never changes. macOS (TIN-398) and Linux (TIN-399) are one
 * line each when they exist.
 */
export const DESKTOP = [{ label: "Windows", match: /Windows/, url: "https://github.com/tineira/agent-pointed-context/releases/download/pulse-desktop/PulseDesktop.exe", note: "Unsigned for now: Windows asks once (More info, then Run anyway)." }];

/**
 * An app on the world, as a plain link: a click on a link opens its tab, where a script opening a
 * second window from the same click is blocked (TIN-406). So each app has its own step.
 */
function OpenApp(props: { app: (typeof APPS)[number]; seed: number; onOpened: () => void }) {
  return (
    <a className="launch-app" href={appUrl(props.app, props.seed)} target="_blank" rel="noreferrer" onClick={props.onOpened}>
      <span className="launch-icon" aria-hidden="true">
        {props.app.glyph}
      </span>
      Open {props.app.name}
    </a>
  );
}

/** The world step: a seed the person can keep or change, and why it is there. */
function World(props: { seed: number; change: boolean; onBack: () => void; onNext: (seed: number) => void }) {
  const [text, setText] = useState(String(props.seed));
  const n = Number(text);
  const valid = /^\d{1,10}$/.test(text) && n < 2 ** 32;
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
        <button type="button" className="primary" disabled={!valid} onClick={() => props.onNext(n)}>
          Next
        </button>
      </div>
    </>
  );
}

/** Pulse on the world: in the browser, or as an app on this computer. */
function OpenPulse(props: { seed: number; onBack: () => void; onNext: () => void }) {
  const [opened, setOpened] = useState(false);
  const pulse = APPS[0]!;
  const here = DESKTOP.find((d) => d.match.test(navigator.userAgent));
  return (
    <>
      <p>Pulse is product analytics: customers, the customer bridge, active customers each month. Open it in the browser, or as an app on this computer; either one takes your agent from the dock.</p>
      <div className="choice">
        <b>In the browser</b>
        <OpenApp app={pulse} seed={props.seed} onOpened={() => setOpened(true)} />
      </div>
      <div className="choice">
        <b>On this computer</b>
        {DESKTOP.map((d) => (
          <a key={d.label} className="download" href={d.url} onClick={() => setOpened(true)}>
            Download Pulse for {d.label}
          </a>
        ))}
        {!here && <p>For {DESKTOP.map((d) => d.label).join(" and ")} only, for now; macOS and Linux are next.</p>}
        <p>Then open it and paste this link, Pulse on your world:</p>
        <CopyRow text={appUrl(pulse, props.seed)} />
        {DESKTOP.map((d) => (
          <p key={d.label} className="small-note">
            {d.note}
          </p>
        ))}
      </div>
      <div className="row">
        <button type="button" onClick={props.onBack}>
          Back
        </button>
        <button type="button" className={opened ? "primary" : ""} onClick={props.onNext}>
          {opened ? "Next" : "Skip"}
        </button>
      </div>
    </>
  );
}

/** Signals on the same world, and the end of the run. */
function OpenSignals(props: { seed: number; onBack: () => void; onDone: () => void }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <p>Signals is a market feed from the same world: competitor offers aimed at a region and plan, and our ads with a promo code. Drag your agent onto a post there too, then ask it what explains the churn in Pulse.</p>
      <OpenApp app={APPS[1]!} seed={props.seed} onOpened={() => setOpened(true)} />
      <div className="row">
        <button type="button" onClick={props.onBack}>
          Back
        </button>
        <button type="button" className={opened ? "primary" : ""} onClick={props.onDone}>
          Done
        </button>
      </div>
    </>
  );
}

/**
 * The first run, or from its world step on (Change world): the world, then each app in its own step.
 * Choosing the world saves it (and ends the first run for the hub); onDone goes back to the dock.
 */
export function Setup(props: { agent: SetupAgent | undefined; seed: number; only?: "world"; onWorld: (seed: number) => Promise<void>; onDone: () => void }) {
  const change = props.only === "world";
  const [step, setStep] = useState(change ? WORLD : 0);
  const [seed, setSeed] = useState(props.seed);
  const { agent } = props;
  const connected = !!agent?.client_name;
  let body: ReactNode;
  if (step === 0) {
    body = (
      <>
        <p>This is your agent dock. Your agents live here: connect each one once, then drag it onto anything in an APC app to point it at what you see. The apps have no agent of their own.</p>
        {DESKTOP_SHELL ? (
          <p>Your agents also float on top of every window, each on its own: drag one onto an app to point it, or onto any empty spot to move it there. {DESKTOP_SHORTCUT} shows and hides them, and so does the APC Dock icon in the tray.</p>
        ) : (
          <p>Install the dock as an app to keep it at hand; Float keeps your agents on top of other windows.</p>
        )}
        {DOCK_DESKTOP.offered && (
          <>
            <p>On Windows, the dock is also an app of its own: your agents float on top of every window, {DESKTOP_SHORTCUT} shows and hides them, and it lives in the tray.</p>
            <a className="download" href={DOCK_DESKTOP.url}>
              Get the dock for Windows
            </a>
            <p className="small-note">{DOCK_DESKTOP.note}</p>
          </>
        )}
        <div className="row">
          {!DESKTOP_SHELL && <Install label="Install the dock" />}
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
            <span
              className="chip"
              draggable={!connected}
              title={connected ? undefined : "Drag me into your agent's chat"}
              onDragStart={(e) => {
                // TIN-408: before it connects, the agent drags as its connect prompt.
                e.dataTransfer.setData("text/plain", askYourAgentPrompt(agent.mcp_url, "APC"));
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <AgentIcon clientName={agent.client_name} clientUa={agent.client_ua} clientIcon={agent.client_icon} motion={!connected ? "off" : agent.waiting ? "waiting" : "idle"} size={40} />
            </span>
            <span>{connected ? <span className="ok">{agent.name} is connected ✓</span> : <>Waiting for your agent… <span className="muted">The quickest way: drag this plug into your agent's chat and send.</span></>}</span>
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
  } else if (step === WORLD) {
    body = (
      <World
        seed={seed}
        change={change}
        onBack={() => (change ? props.onDone() : setStep(1))}
        onNext={(n) => {
          setSeed(n);
          void props.onWorld(n).then(() => setStep(3));
        }}
      />
    );
  } else if (step === 3) {
    body = <OpenPulse seed={seed} onBack={() => setStep(WORLD)} onNext={() => setStep(4)} />;
  } else {
    body = <OpenSignals seed={seed} onBack={() => setStep(3)} onDone={props.onDone} />;
  }
  return (
    <section className="setup" aria-label={change ? "Change world" : "Set up your dock"}>
      {change && <h2 className="setup-title">Change world</h2>}
      <ol className="setup-steps">
        {STEPS.map((name, i) =>
          change && i < WORLD ? null : (
            <li key={name} className={i === step ? "on" : i < step ? "done" : ""}>
              <span>{change ? i - WORLD + 1 : i + 1}</span>
              {name}
            </li>
          ),
        )}
      </ol>
      {body}
    </section>
  );
}
