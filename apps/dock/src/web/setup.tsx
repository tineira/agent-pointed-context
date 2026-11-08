import { useEffect, useState, type ReactNode } from "react";
import type { DockAgent } from "./agent-page.tsx";
import { setupProgress, type Onboarding } from "../onboarding.ts";
import { askYourAgentPrompt, Qr, SCAN_HINT } from "../../../demo/src/web/qr.tsx";
import { InstallIcon } from "./icons.tsx";

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
 * The demo apps, each its own site (the landing page links them). The dock no longer opens them (TIN-621):
 * it is a working product, and the demo apps are onboarding. They show one world to everyone, so each opens
 * on its own, in any order, while the apps know nothing of each other. The agent does the joining. The
 * checklist still knows Pulse's origin, to follow its pairing.
 */
export const APPS = [
  {
    name: "Pulse",
    url: import.meta.env.DEV ? "http://localhost:5199/overview" : "https://pulse.apc.tineira.com/overview",
    glyph: (
      <svg viewBox="0 0 32 32" width="22" height="22">
        <rect x="4" y="8" width="20" height="20" rx="5" fill="none" stroke="currentColor" strokeWidth="3.5" />
        <circle cx="24" cy="8" r="5.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    name: "Signals",
    url: import.meta.env.DEV ? "http://localhost:5201/" : "https://signals.apc.tineira.com/",
    glyph: (
      <svg viewBox="0 0 28 28" width="22" height="22">
        <circle cx="14" cy="14" r="11.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="14" cy="14" r="5.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="14" cy="14" r="2" fill="currentColor" />
      </svg>
    ),
  },
];

/** Where the demo apps are offered (TIN-621): the APC home page, the dock's landing. */
const HOME = "/";

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
export function Install(props: { label?: string; children?: (button: ReactNode) => ReactNode }) {
  const [prompt, setPrompt] = useState<(Event & { prompt(): Promise<void> }) | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setPrompt(e as Event & { prompt(): Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", on);
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);
  const button = prompt ? (
    <button type="button" className="primary icon-button" title="Install the dock as an app" onClick={() => void prompt.prompt().then(() => setPrompt(null))}>
      <InstallIcon />
      <span className="icon-label">{props.label ?? "Install"}</span>
    </button>
  ) : null;
  return props.children ? props.children(button) : button;
}

/**
 * Pulse for desktop, per platform (TIN-406): each build of main replaces the file on the
 * pulse-desktop prerelease, so the link never changes. macOS (TIN-398) and Linux (TIN-399) are one
 * line each when they exist.
 */
export const DESKTOP = [{ label: "Windows", match: /Windows/, url: "https://github.com/tineira/agent-pointed-context/releases/download/pulse-desktop/PulseDesktop.exe", note: "Unsigned for now: Windows asks once (More info, then Run anyway)." }];

const TITLES = ["Connect your agent", "Point it at something", "Add a second app", "Any page", "Keep it at hand"];
/**
 * Persistent, order-independent first run. The hub, never a Next button, checks each item. Folded to
 * one line that says how far along it is (TIN-701); `open` and `toggle` are the dock's, so its menu
 * can open it too.
 */
export function Setup(props: { agents: DockAgent[]; progress: Onboarding; keepAtHand: ReactNode; open: boolean; toggle: () => void }) {
  const { agents } = props;
  const { done, count, ready, connected } = setupProgress(agents, props.progress);
  const first = done.findIndex((d) => !d);
  const [chosen, setChosen] = useState<number | null>(() => new URLSearchParams(location.search).has("float") ? 4 : null);
  const active = chosen ?? first;
  const pulse = agents.flatMap((a) => a.pairings).filter((p) => p.kind === "app" && p.app.origin === new URL(APPS[0]!.url).origin);
  const pulsePending = pulse.some((p) => p.status === "pending");
  const pulsePaired = pulse.some((p) => p.status === "paired");
  const bodies = [
    <div key="connect">
      <p>Drag the plug above into your agent’s chat and send. Or add its URL as a remote MCP server.</p>
      {!agents.length && <p>Add an agent with <b>+</b> below to get its plug and connection URL.</p>}
      {agents.filter((a) => !a.client_name).map((a) => <ConnectAgent key={a.id} agent={a} />)}
      {connected && <p className="ok">Your agent connected. This is the only connection it needs.</p>}
    </div>,
    <div key="point">
      <p>Open an app that speaks APC and drag your agent from the dock onto something in it. To try one, open Pulse, an example app with made-up company data, from the <a href={HOME} target="_blank" rel="noreferrer">APC home page</a>, and drop your agent on a bar.</p>
      <ol className="allow-guide" aria-live="polite">
        <li className={pulsePaired || pulsePending ? "ok" : ""}>Pulse asks: <b>Allow</b>. Choose the access you want it to have.</li>
        <li className={pulsePending ? "current" : pulsePaired ? "ok" : ""}>{pulsePending ? "Now your dock asks: " : "Then your dock asks: "}<b>Allow</b>. Check the app and its address in the request above.</li>
      </ol>
      <p>Ask your agent: <b>what is this?</b></p>
      <p className="small-note">Both Allows protect your data. Only allow the app you meant to open.</p>
      {pulsePaired && <p className="ok">Pulse is paired. Point at a bar and ask your agent about it.</p>}
    </div>,
    <div key="second">
      <p>Signals, a second example app on the <a href={HOME} target="_blank" rel="noreferrer">APC home page</a>, is a market feed about the same company as Pulse. Drop your agent on a post, then ask what explains the churn.</p>
      <p>Allow in Signals, then in the dock. Your agent uses the same connection to read both apps and join what they say. No new MCP connection needed.</p>
      {DESKTOP.filter((d) => d.match.test(navigator.userAgent)).map((d) => <div className="choice" key={d.label}>
        <a className="download" href={d.url}>Or try Pulse for {d.label}</a>
        <p>A native app: open it, then drag your agent onto a bar. It shows the same data as Pulse on the web.</p>
        <p className="small-note">{d.note}</p>
      </div>)}
    </div>,
    <div key="page">
      <p>Add the extension, then drop your agent on any paragraph. Allow the site in the extension and this browser in the dock when asked.</p>
      <a href="/extension" target="_blank" rel="noreferrer">Add the browser extension — step by step</a>
      <p className="small-note">The extension is not in the stores yet. This checks itself when your first page reading is sent.</p>
    </div>,
    <div key="keep">
      <p>Optional. Keep your agent nearby with Float or install the dock as an app.</p>
      {props.keepAtHand}
      {!DESKTOP_SHELL && <p className="small-note">Float needs Chrome or Edge on a computer. To install, use your browser’s install option if no Install button appears.</p>}
      {DOCK_DESKTOP.offered && <><a className="download" href={DOCK_DESKTOP.url}>Get the dock for Windows</a><p>Your agents float on top of every window as desktop pets. {DESKTOP_SHORTCUT} shows and hides them.</p><p className="small-note">{DOCK_DESKTOP.note}</p></>}
      {DESKTOP_SHELL && <p>Your desktop pets are already at hand. {DESKTOP_SHORTCUT} shows and hides them.</p>}
    </div>,
  ];
  return <section id="try-your-dock" className={`setup checklist${props.open ? " open" : ""}${ready ? " ready" : ""}`} aria-label="Try your dock">
    <h2 className="setup-heading">
    <button type="button" className="setup-toggle" aria-expanded={props.open} aria-controls="try-dock-items" onClick={props.toggle}>
      {ready ? <><span className="setup-ok" aria-hidden="true">✓</span><span className="setup-title">Dock ready</span><span className="setup-progress">see steps</span></>
        : <><span className="setup-title">Try your dock</span><span className="setup-progress">{count} of {TITLES.length}</span></>}
      <span className="checklist-caret" aria-hidden="true">{props.open ? "−" : "+"}</span>
    </button>
    </h2>
    <div id="try-dock-items" className="setup-items" hidden={!props.open}>
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
    </div>
  </section>;
}
