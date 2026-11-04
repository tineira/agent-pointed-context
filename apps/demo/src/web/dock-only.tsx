/**
 * How to reach Pulse on the standard's deploy: through a dock (TIN-402, the dock manages those agents,
 * TIN-410) and, where Pulse offers the Direct profile (APC_PROFILES, TIN-578), app by app, with the
 * agents made on the Agents screen.
 */
import type { SandboxState } from "./api.ts";
import { AppLink } from "./ui.tsx";

const dockName = (state: SandboxState) => state.hubs?.[0] ?? "your agent dock";

const STEPS = (dock: string) => [
  <>
    Open your agent dock (<strong>{dock}</strong>) and connect your agent there. Your agent lives in the dock, and the same agent can read every app you point it at.
  </>,
  <>Drag your agent's logo from the dock onto anything here: a bar, a step of the bridge, a whole chart, a customer.</>,
  <>Allow it here (all of Pulse, or one region), then in the dock. Next time, a drop just points it.</>,
  <>
    Ask your agent about "this". To point it somewhere else, drag again, from the dock or from its mark at the top right.
  </>,
];

/** On the data pages while no agent is here: the ways in (the dock, and Direct where Pulse offers it). */
export function DockHint(props: { state: SandboxState }) {
  if (props.state.grants.length > 0) return null;
  return (
    <section className="card connect-panel" aria-label="Point your agent here">
      <h2>Point your agent here</h2>
      <p className="hint">
        No agent can read Pulse yet. Drag your agent from your agent dock (<strong>{dockName(props.state)}</strong>) onto any chart or customer, and allow it here and in the dock.
        {props.state.profiles?.includes("direct") && (
          <>
            {" "}
            Or connect an agent to Pulse alone, with its own URL: <AppLink href="/agents">Agents →</AppLink>
          </>
        )}
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
      {props.state.profiles?.includes("direct") && (
        <section className="flex flex-col gap-2 border-t border-line pt-6 text-sm">
          <h2 className="text-base font-semibold">Or connect app by app</h2>
          <p className="text-muted">
            Connect an agent to Pulse alone: on <AppLink href="/agents">Agents</AppLink>, make an agent and paste its URL into your agent as a remote MCP server. Its mark shows at the top right; drag it onto anything here. The same agent connected both ways shows as one, if it agrees.
          </p>
        </section>
      )}
    </div>
  );
}
