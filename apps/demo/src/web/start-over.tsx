/**
 * Start over (TIN-411): wipe this site's demo data after a confirm, to test from zero. Each APC v2
 * site can only wipe its own (its cookie is its own, and httpOnly), so the dialog says which other
 * sites to start over in too, and that the agent keeps the dock's server until the person removes it.
 * Shared by the dock, Pulse's v2 deploy and Signals; styled with system colors so it fits all three.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { askToDisconnectPrompt } from "./qr.tsx";

/** The APC v2 sites, by name and address: what the dialog tells the person to wipe too. */
export const V2_SITES = [
  { name: "Agent dock", host: "v2.apc.tineira.com", url: import.meta.env.DEV ? "http://localhost:5200/" : "https://v2.apc.tineira.com/" },
  { name: "Pulse", host: "pulse.v2.apc.tineira.com", url: import.meta.env.DEV ? "http://localhost:5199/agents" : "https://pulse.v2.apc.tineira.com/agents" },
  { name: "Signals", host: "signals.v2.apc.tineira.com", url: import.meta.env.DEV ? "http://localhost:5201/" : "https://signals.v2.apc.tineira.com/" },
] as const;

/**
 * A site opened with ?start_over=1 (a link from another site's dialog, TIN-412) opens its Start over
 * dialog. It still asks: a link never wipes anything on its own.
 */
export const START_OVER_PARAM = "start_over";
export const startOverAsked = () => new URLSearchParams(location.search).has(START_OVER_PARAM);
// Read once, when the page loads: an app may rewrite its address (its route) before the dialog mounts.
let asked = startOverAsked();

const box: CSSProperties = {
  maxWidth: 420,
  width: "calc(100vw - 32px)",
  padding: 18,
  border: "1px solid color-mix(in srgb, CanvasText 18%, transparent)",
  borderRadius: 14,
  background: "Canvas",
  color: "CanvasText",
  font: "14px/1.5 system-ui, sans-serif",
};
const button: CSSProperties = { font: "inherit", fontSize: 13, padding: "5px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid color-mix(in srgb, CanvasText 25%, transparent)", background: "Canvas", color: "CanvasText" };
/** The trigger, for a site that gives it no class of its own: it inherits the page's colors. */
const trigger: CSSProperties = { font: "inherit", fontSize: 13, padding: "5px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid currentColor", background: "transparent", color: "inherit", opacity: 0.85 };
const danger: CSSProperties = { ...button, background: "#c0392b", borderColor: "#c0392b", color: "#fff" };

/**
 * A "Start over" link and its confirm dialog. site: this site's name in V2_SITES. wipes: what goes.
 * reset: the server call that deletes this site's data and cookie; then the page clears its own
 * storage (and service worker, caches) and reloads from the top.
 */
export function StartOver(props: { site: (typeof V2_SITES)[number]["name"]; wipes: string[]; reset: () => Promise<unknown>; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const disconnect = askToDisconnectPrompt("APC", V2_SITES[0].host);
  const others = V2_SITES.filter((s) => s.name !== props.site);
  useEffect(() => {
    if (!asked) return;
    asked = false;
    const url = new URL(location.href);
    url.searchParams.delete(START_OVER_PARAM);
    history.replaceState(history.state, "", url);
    dialog.current?.showModal();
  }, []);
  const go = async () => {
    setBusy(true);
    try {
      await props.reset();
    } catch {
      // the data may be gone already; the page still clears and reloads
    }
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // storage off
    }
    try {
      for (const r of (await navigator.serviceWorker?.getRegistrations()) ?? []) await r.unregister();
      for (const k of (await caches?.keys()) ?? []) await caches.delete(k);
    } catch {
      // no service worker or cache here
    }
    location.href = "/";
  };
  return (
    <>
      <button type="button" {...(props.className === undefined ? { style: trigger } : { className: props.className })} onClick={() => dialog.current?.showModal()} title={`Delete this ${props.site}'s demo data and start from zero`}>
        Start over
      </button>
      <dialog ref={dialog} style={box} aria-labelledby="start-over-title" onClick={(e) => e.target === dialog.current && !busy && dialog.current?.close()}>
        <h2 id="start-over-title" style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 600, textTransform: "none", letterSpacing: "normal", color: "CanvasText" }}>
          Start over in {props.site}?
        </h2>
        <p style={{ margin: "0 0 6px" }}>This deletes, on this site only:</p>
        <ul style={{ margin: "0 0 10px", paddingLeft: 20 }}>
          {props.wipes.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <p style={{ margin: "0 0 6px" }}>
          <b>To start from zero everywhere</b>, do the same on the other sites (each opens in a new tab and asks you there):
        </p>
        <ul style={{ margin: "0 0 10px", paddingLeft: 20 }}>
          {others.map((s) => (
            <li key={s.name}>
              <a href={`${s.url}?${START_OVER_PARAM}=1`} target="_blank" rel="noreferrer" style={{ color: "LinkText" }}>
                Start over in {s.name}
              </a>{" "}
              <span style={{ opacity: 0.7 }}>({s.host})</span>
            </li>
          ))}
        </ul>
        <p style={{ margin: "0 0 6px" }}>And remove the "APC" server from your agent: its URL stops working once the dock starts over. Paste this to your agent:</p>
        <div style={{ display: "flex", gap: 8, alignItems: "stretch", margin: "0 0 14px" }}>
          <code style={{ flex: 1, minWidth: 0, padding: "6px 8px", borderRadius: 8, font: "12px/1.45 ui-monospace, monospace", whiteSpace: "pre-wrap", background: "color-mix(in srgb, CanvasText 7%, transparent)" }}>{disconnect}</code>
          <button
            type="button"
            style={button}
            onClick={() => {
              void navigator.clipboard?.writeText(disconnect);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" style={button} disabled={busy} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="button" style={danger} disabled={busy} onClick={() => void go()}>
            {busy ? "Deleting…" : `Delete and start over`}
          </button>
        </div>
      </dialog>
    </>
  );
}
