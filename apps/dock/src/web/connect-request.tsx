/**
 * APC 0.13 Connect requests and "Connect an app" (TIN-916): shown on the dock page, an agent's page,
 * Float, the strip and the pet bubble.
 *
 * Approving an app Connect request calls `/api/d/:did/connects/:cr/approve` and opens the returned
 * `dock_connect` URL (carrying `#apc_connect=...`) in a new tab with `noopener`. If `window.open`
 * returns `null`, the card stays and offers a one-click `<a target="_blank" rel="noopener">Open ...</a>`
 * link until clicked or dismissed. Reader requests show the 4-digit check from the extension and
 * approve directly without opening a tab.
 */
import { useId, useState } from "react";
import { unverifiedWarning } from "../worker/trust.ts";
import { buttonsOff, connectCheckErrorText, type InFlight } from "./request-state.ts";
import { HostName, NotVerified, Verified } from "./unverified.tsx";

export interface DockConnect {
  id: string;
  kind: "app" | "reader";
  agent: string;
  origin: string;
  host: string;
  name: string;
  verified: boolean;
  check?: string;
  expires_at: number;
}

export interface BlockedConnect {
  id: string;
  agentId: string;
  agentName: string;
  origin: string;
  host: string;
  name: string;
  verified: boolean;
  url: string;
}

export interface ConnectCardItem {
  connect: DockConnect;
  agentName: string;
  inFlight?: InFlight;
  blockedUrl?: string;
}

export type ConnectAction = "approve" | "approve_unverified" | "deny";

export interface ConnectRequestProps {
  connect: DockConnect;
  agentName: string;
  inFlight?: InFlight;
  blockedUrl?: string | null;
  compact?: boolean;
  decide: (action: ConnectAction) => void;
  onOpenLink?: () => void;
  onDismiss?: () => void;
}

export function ConnectRequest(props: ConnectRequestProps) {
  const c = props.connect;
  const off = buttonsOff({ inFlight: props.inFlight });
  const appLabel = c.verified ? c.name : c.host;

  if (props.blockedUrl) {
    return (
      <>
        <p>
          Connect {c.verified ? <b>{c.name}</b> : <HostName host={c.host} />} to <b>{props.agentName}</b>?
        </p>
        {c.verified ? (
          <p className="muted request-host" data-request-host="">
            {c.host} <Verified />
          </p>
        ) : (
          <p>
            <NotVerified />
          </p>
        )}
        <p className="muted">Your browser blocked opening the new tab. Open it here to finish pairing:</p>
        <div className="row">
          <a href={props.blockedUrl} target="_blank" rel="noopener" className="connect-open" onClick={props.onOpenLink}>
            Open {appLabel}
          </a>
          <button type="button" onClick={props.onDismiss}>
            Dismiss
          </button>
        </div>
      </>
    );
  }

  if (c.kind === "reader") {
    return (
      <>
        <p>
          Connect the APC extension to <b>{props.agentName}</b>? Allow only if your extension shows{" "}
          <b className="join-check">{c.check}</b>.
        </p>
        <div className="row">
          <button type="button" disabled={off.deny} onClick={() => props.decide("deny")}>
            Deny
          </button>
          <button type="button" disabled={off.approve} onClick={() => props.decide("approve")}>
            Connect
          </button>
        </div>
      </>
    );
  }

  if (!c.verified) {
    const w = unverifiedWarning(c.host, c.name || null, props.agentName);
    return (
      <div className={`unverified-warning${props.compact ? " compact" : ""}`} role="alertdialog" aria-label={`${w.badge}: ${w.domain}`} aria-busy={off.approve}>
        <p className="unverified-domain">
          <HostName host={w.domain} />
        </p>
        <p>
          <NotVerified />
        </p>
        {w.declared && <p className="muted unverified-declared">{w.declared}</p>}
        <p>
          Connect <b>{w.domain}</b> to <b>{props.agentName}</b>? The dock has not verified who runs it.
        </p>
        <p className="unverified-risk">{w.risk}</p>
        <div className="row">
          <button type="button" className="primary" autoFocus disabled={off.deny} onClick={() => props.decide("deny")}>
            Deny
          </button>
          <button type="button" disabled={off.approve} onClick={() => props.decide("approve_unverified")}>
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <p>
        Connect <b>{c.name}</b> to <b>{props.agentName}</b>?
      </p>
      <p className="muted request-host" data-request-host="">
        {c.host} <Verified />
      </p>
      <div className="row">
        <button type="button" disabled={off.deny} onClick={() => props.decide("deny")}>
          Deny
        </button>
        <button type="button" className="primary" disabled={off.approve} onClick={() => props.decide("approve")}>
          Connect
        </button>
      </div>
    </>
  );
}

/**
 * "Connect an app" (APC 0.13): offers the verified apps from `DockState.apps[]` and a host field
 * with a Check step (`POST /api/d/:did/connects`). Creating a request is separate from Connect,
 * so the Check step can fetch `apc.json` and the Connect button opens the tab directly on click.
 */
export function ConnectApp(props: {
  apps: ReadonlyArray<{ origin: string; name: string }>;
  create: (host: string) => Promise<{ ok?: boolean; error?: unknown }>;
  refresh: () => void;
}) {
  const inputId = useId();
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async (target: string, clearField: boolean) => {
    const trimmed = target.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await props.create(trimmed);
      if (r?.ok === false) {
        setError(connectCheckErrorText(r.error));
      } else {
        if (clearField) setHost("");
        props.refresh();
      }
    } catch {
      setError(connectCheckErrorText("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect-app">
      {props.apps.length > 0 && (
        <div className="row connect-app-list">
          {props.apps.map((app) => (
            <button key={app.origin} type="button" disabled={busy} title={app.origin} onClick={() => void check(app.origin, false)}>
              {app.name}
            </button>
          ))}
        </div>
      )}
      <form
        className="connect-app-form"
        onSubmit={(e) => {
          e.preventDefault();
          void check(host, true);
        }}
      >
        <label htmlFor={inputId}>{props.apps.length > 0 ? "Or enter an app host" : "App host"}</label>
        <div className="row">
          <input
            id={inputId}
            type="text"
            value={host}
            onChange={(e) => setHost(e.currentTarget.value)}
            placeholder="app.example"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !host.trim()}>
            {busy ? "Checking…" : "Check"}
          </button>
        </div>
      </form>
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Combine live hub connect requests with any approved requests whose popup was blocked and awaits a click. */
export function mergeConnectItems(
  connects: ReadonlyArray<DockConnect>,
  blocked: ReadonlyArray<BlockedConnect>,
  agentName: (agentId: string) => string,
  inFlight: (id: string) => InFlight | undefined,
): ConnectCardItem[] {
  const blockedById = new Map(blocked.map((b) => [b.id, b]));
  const seen = new Set<string>();
  const items: ConnectCardItem[] = [];
  for (const c of connects) {
    seen.add(c.id);
    const b = blockedById.get(c.id);
    items.push({
      connect: c,
      agentName: agentName(c.agent),
      inFlight: inFlight(c.id),
      ...(b ? { blockedUrl: b.url } : {}),
    });
  }
  for (const b of blocked) {
    if (seen.has(b.id)) continue;
    items.push({
      connect: {
        id: b.id,
        kind: "app",
        agent: b.agentId,
        origin: b.origin,
        host: b.host,
        name: b.name,
        verified: b.verified,
        expires_at: 0,
      },
      agentName: b.agentName,
      blockedUrl: b.url,
    });
  }
  return items;
}
