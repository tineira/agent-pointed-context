/**
 * Pulse's v2 deploy takes agents only from a dock (TIN-402): no agent of its own, no MCP URL to
 * connect. What stays is what an app owes the person: how to point an agent here, and which agents
 * can read it, with a way to take that away. apc.tineira.com keeps connect.tsx and the how-to.
 */
import { displayNames } from "./agent-brands.ts";
import { AgentIcon } from "./agent-icon.tsx";
import type { Api, SandboxState } from "./api.ts";
import { ago } from "./connect.tsx";
import { isSeen, pinLabel } from "./pin-badges.tsx";

const dockName = (state: SandboxState) => state.hubs?.[0] ?? "your agent dock";

const STEPS = (dock: string) => [
  <>
    Open your agent dock (<strong>{dock}</strong>) and connect your agent there. Pulse has no agent of its own: your agent lives in the dock, and the same agent can read every app you point it at.
  </>,
  <>Drag your agent's logo from the dock onto anything here: a bar, a step of the bridge, a whole chart, a customer.</>,
  <>Allow it here (all of Pulse, or one region), then in the dock. Next time, a drop just points it.</>,
  <>
    Ask your agent about "this". To point it somewhere else, drag again, from the dock or from its mark at the top right.
  </>,
];

/** On Overview while no dock agent is here: the one way in. */
export function DockHint(props: { state: SandboxState }) {
  if (props.state.grants.length > 0) return null;
  return (
    <section className="card connect-panel" aria-label="Point your agent here">
      <h2>Point your agent here</h2>
      <p className="hint">
        No agent can read Pulse yet. Drag your agent from your agent dock (<strong>{dockName(props.state)}</strong>) onto any chart or customer, and allow it here and in the dock.
      </p>
    </section>
  );
}

/** The How-to on the v2 deploy: four steps, all through the dock. */
export function DockHowTo(props: { state: SandboxState }) {
  return (
    <div className="flex w-full flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">How-to</h1>
        <p className="text-sm text-muted">Pulse is one of the apps your agent can read. You point it here from your agent dock.</p>
      </section>
      <ol className="flex flex-col gap-3 border-t border-line pt-6">
        {STEPS(dockName(props.state)).map((step, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line text-xs font-semibold text-filament">{i + 1}</span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The Agents screen's list on the v2 deploy: each dock agent that can read Pulse, and Remove. */
export function DockAgents(props: { api: Api; state: SandboxState; onChanged: () => void }) {
  const { state } = props;
  const names = displayNames(state.grants);
  const dockOf = (grantId: string) => {
    const hub = state.hub_links?.find((l) => l.grant_id === grantId)?.hub;
    try {
      return hub ? new URL(hub).host : null;
    } catch {
      return null;
    }
  };
  return (
    <section className="card">
      <h2>Agents that can read Pulse</h2>
      <p>
        Each came from an agent dock: you dropped it here and allowed it, here and in the dock. Remove takes its access away; its dock stops reading Pulse, and a new drop asks you again.
      </p>
      {state.grants.length === 0 && <p className="hint">None yet. Drag your agent from your agent dock ({dockName(state)}) onto any chart or customer.</p>}
      {state.grants.map((g) => {
        const active = ago(g.last_active_at);
        const dock = dockOf(g.id);
        return (
          <div key={g.id} className="grant">
            <div className="grant-head">
              <h3>
                <span className="mark-inline mark-logo">
                  <AgentIcon clientName={g.client_name} clientUa={g.client_ua} clientIcon={g.client_icon} motion={g.client_name ? "idle" : "off"} size={16} />
                </span>{" "}
                {names.get(g.id) ?? g.label}
                <span className="muted">
                  {dock ? ` · from ${dock}` : ""} · {g.regions ? `${g.regions.map((r) => r.toUpperCase()).join(", ")} only` : "all of Pulse"}
                </span>
              </h3>
              <span className="grant-meta">
                {active && <span>{active}</span>}
                {g.pin && <span className={isSeen(g.pin) ? "grant-pin seen" : "grant-pin"}>{isSeen(g.pin) ? `read your pin on ${pinLabel(g.pin)}` : `pinned to ${pinLabel(g.pin)}, not read yet`}</span>}
                <button
                  type="button"
                  className="link grant-toggle"
                  onClick={async () => {
                    if (!confirm(`Remove ${names.get(g.id) ?? g.label}? It can no longer read Pulse until you drop it here again.`)) return;
                    await props.api.removeAgent(g.id);
                    props.onChanged();
                  }}
                >
                  Remove
                </button>
              </span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
