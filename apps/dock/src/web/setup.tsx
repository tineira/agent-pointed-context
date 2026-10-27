import { useEffect, useState, type ReactNode } from "react";
import type { DockAgent } from "./agent-page.tsx";
import type { Onboarding } from "../onboarding.ts";
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

/**
 * Pulse for desktop, per platform (TIN-406): each build of main replaces the file on the
 * pulse-desktop prerelease, so the link never changes. macOS (TIN-398) and Linux (TIN-399) are one
 * line each when they exist.
 */
export const DESKTOP = [{ label: "Windows", match: /Windows/, url: "https://github.com/tineira/agent-pointed-context/releases/download/pulse-desktop/PulseDesktop.exe", note: "Unsigned for now: Windows asks once (More info, then Run anyway)." }];

/** An example app beside the dock; a tab remains the fallback when popups are blocked. */
export function OpenApp(props: { app: (typeof APPS)[number]; seed: number; onOpened?: () => void }) {
  return (
    <a className="launch-app" href={appUrl(props.app, props.seed)} target="_blank" rel="noreferrer" onClick={(e) => {
      props.onOpened?.();
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || DESKTOP_SHELL || screen.availWidth < 820) return;
      const left = Math.min(window.screenX + window.outerWidth + 12, Math.max(0, screen.availWidth - 390));
      const w = window.open(appUrl(props.app, props.seed), `apc-example-${props.app.name}`, `popup,width=${Math.max(390, screen.availWidth - left)},height=${screen.availHeight},left=${left},top=0`);
      if (w) e.preventDefault();
    }}>
      <span className="launch-icon" aria-hidden="true">{props.app.glyph}</span>
      Open {props.app.name}
    </a>
  );
}

/** Changing the seed is a separate menu action, never a first-run step. */
export function World(props: { seed: number; onDone: () => void; onWorld: (seed: number) => Promise<void> }) {
  const [text, setText] = useState(String(props.seed));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const n = Number(text);
  const valid = /^\d{1,10}$/.test(text) && n < 2 ** 32;
  return (
    <section className="setup" aria-label="Change world">
      <h2 className="setup-title">Change world</h2>
      <p>Pulse and Signals are example apps. They invent the same company from this number, so the churn in Pulse lines up with the offers in Signals. The apps share nothing; your agent joins them.</p>
      <label className="world">
        <span>World</span>
        <input value={text} inputMode="numeric" maxLength={10} aria-invalid={!valid} onChange={(e) => setText(e.target.value.trim())} />
        <button type="button" disabled={busy} title="A new random world" onClick={() => setText(String(randomSeed()))}>New</button>
      </label>
      {!valid && <p className="warn">A whole number from 0 to 4294967295.</p>}
      <p>Changing it gives each app new data: their pins and views go; your agents and their pairings stay. Reopen the apps from the dock afterwards.</p>
      {error && <p role="alert" className="warn">Could not change the world. Try again.</p>}
      <div className="row">
        <button type="button" disabled={busy} onClick={props.onDone}>Cancel</button>
        <button type="button" className="primary" disabled={!valid || busy} onClick={() => {
          setBusy(true);
          setError(false);
          void props.onWorld(n).then(props.onDone, () => { setError(true); setBusy(false); });
        }}>{busy ? "Saving…" : "Save world"}</button>
      </div>
    </section>
  );
}

const TITLES = ["Connect your agent", "Point it at something", "Add a second app", "Any page", "Keep it at hand"];

/** Persistent, order-independent first run. The hub, never a Next button, checks each item. */
export function Setup(props: { agents: DockAgent[]; seed: number; progress: Onboarding; keepAtHand: ReactNode }) {
  const { agents, progress } = props;
  const connected = progress.connected || agents.some((a) => !!a.client_name);
  const done = [connected, progress.pin_read, progress.second_app, progress.reading_sent, progress.kept];
  const first = done.findIndex((d) => !d);
  const [chosen, setChosen] = useState<number | null>(() => new URLSearchParams(location.search).has("float") ? 4 : null);
  const active = chosen ?? first;
  const pulse = agents.flatMap((a) => a.pairings).filter((p) => p.kind === "app" && p.app.origin === new URL(APPS[0]!.url).origin);
  const pulsePending = pulse.some((p) => p.status === "pending");
  const pulsePaired = pulse.some((p) => p.status === "paired");
  const [openedPulse, setOpenedPulse] = useState(false);
  const bodies = [
    <div key="connect">
      <p>Drag the plug above into your agent’s chat and send. Or add its URL as a remote MCP server.</p>
      {!agents.length && <p>Add an agent below to get its plug and connection URL.</p>}
      {agents.filter((a) => !a.client_name).map((a) => <ConnectAgent key={a.id} agent={a} />)}
      {connected && <p className="ok">Your agent connected. This is the only connection it needs.</p>}
    </div>,
    <div key="point">
      <p>Try Pulse, an example app with made-up company data. Drag your agent from the dock onto a bar.</p>
      <OpenApp app={APPS[0]!} seed={props.seed} onOpened={() => setOpenedPulse(true)} />
      <ol className="allow-guide" aria-live="polite">
        <li className={pulsePaired || pulsePending ? "ok" : ""}>Pulse asks: <b>Allow</b>. Choose the access you want it to have.</li>
        <li className={pulsePending ? "current" : pulsePaired ? "ok" : ""}>{pulsePending ? "Now your dock asks: " : "Then your dock asks: "}<b>Allow</b>. Check the app and its address in the request above.</li>
      </ol>
      {openedPulse && !pulsePaired && !pulsePending && <p>In Pulse, drop your agent on a bar to see its Allow prompt. Then return here for the dock’s Allow.</p>}
      <p>Ask your agent: <b>what is this?</b></p>
      <p className="small-note">Both Allows protect your data. Only allow the app you meant to open.</p>
      {pulsePaired && <p className="ok">Pulse is paired. Point at a bar and ask your agent about it.</p>}
    </div>,
    <div key="second">
      <p>Signals is a second example app: a market feed from the same company’s world. Drop your agent on a post, then ask what explains the churn.</p>
      <OpenApp app={APPS[1]!} seed={props.seed} />
      <p>Allow in Signals, then in the dock. Your agent uses the same connection to read both apps and join what they say. No new MCP connection needed.</p>
    </div>,
    <div key="page">
      <p>Add the extension, then drop your agent on any paragraph. Allow the site in the extension and this browser in the dock when asked.</p>
      <a href="https://github.com/tineira/agent-pointed-context/blob/main/README.md#status" target="_blank" rel="noreferrer">Developer install — extension instructions</a>
      <p className="small-note">The extension is not in the stores yet. This checks itself when your first page reading is sent.</p>
    </div>,
    <div key="keep">
      <p>Optional. Keep your agent nearby with Float or install the dock as an app.</p>
      {props.keepAtHand}
      {!DESKTOP_SHELL && <p className="small-note">Float needs Chrome or Edge on a computer. To install, use your browser’s install option if no Install button appears.</p>}
      {DOCK_DESKTOP.offered && <><a className="download" href={DOCK_DESKTOP.url}>Get the dock for Windows</a><p>Your agents float on top of every window as desktop pets. {DESKTOP_SHORTCUT} shows and hides them.</p><p className="small-note">{DOCK_DESKTOP.note}</p></>}
      {DESKTOP_SHELL && <p>Your desktop pets are already at hand. {DESKTOP_SHORTCUT} shows and hides them.</p>}
      {DESKTOP.filter((d) => d.match.test(navigator.userAgent)).map((d) => <div className="choice" key={d.label}>
        <a className="download" href={d.url}>Try Pulse for {d.label}</a>
        <p>Open it and paste this link, then drag your agent onto a bar in the app:</p>
        <CopyRow text={appUrl(APPS[0]!, props.seed)} />
        <p className="small-note">{d.note}</p>
      </div>)}
    </div>,
  ];
  return <section className="setup checklist" aria-label="Try your dock">
    <h2 className="setup-title">Try your dock</h2>
    <p>Nothing to install first. Each item checks itself as you try it, in any order.</p>
    <ol className="checklist-items">
      {TITLES.map((title, i) => <li key={title} className={done[i] ? "done" : ""}>
        <button type="button" className="checklist-toggle" aria-expanded={active === i} aria-controls={`try-dock-${i}`} onClick={() => setChosen(active === i ? -1 : i)}>
          <span className="checklist-check" aria-label={done[i] ? "Complete" : "Not yet"}>{done[i] ? "✓" : i + 1}</span>
          <span>{title}{i === 4 && <small> · optional</small>}</span>
          <span className="checklist-caret" aria-hidden="true">{active === i ? "−" : "+"}</span>
        </button>
        <div id={`try-dock-${i}`} className="checklist-body" hidden={active !== i}>{bodies[i]}</div>
      </li>)}
    </ol>
  </section>;
}
