/**
 * Pulse's v2 deploy takes agents only from a dock (TIN-402): no agent of its own, no MCP URL to
 * connect. What stays is how to point an agent here; the dock manages the agents (TIN-410).
 * apc.tineira.com keeps connect.tsx and the how-to.
 */
import type { SandboxState } from "./api.ts";

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
