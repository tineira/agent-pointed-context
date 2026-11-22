/**
 * How to reach Pulse on the v2 deploy (TIN-1098): the profiles (APC_PROFILES) decide. Where Direct is
 * offered — the standard's deploy, "direct,dock" — the hint on the data pages and the How-to teach
 * connecting directly (direct-copy.ts), in the site's /try voice, and never invite anyone to an agent
 * dock. A dock-only deploy (no Direct) keeps the dock steps (TIN-402, the dock manages those agents,
 * TIN-410) until the 2.0 cut (TIN-1011). The replies to a real dock drop — the consent card, "Confirm in
 * your dock", the waiting cards (hub-consent.tsx) — are other components, and stay.
 */
import type { SandboxState } from "./api.ts";
import { AppLink } from "./ui.tsx";
import { CROSS_APP, pulseCustomerPath, signalsPostPath } from "../model/demo-world.ts";
import { DIRECT_HINT, DIRECT_INTRO, DIRECT_STEPS, directOffered } from "./direct-copy.ts";

/** Signals, the second demo app: its own site, opened by its own link (TIN-621). */
const SIGNALS = import.meta.env.DEV ? "http://localhost:5201" : "https://signals.apc.tineira.com";

/**
 * One question across both apps that works every time (TIN-621, CROSS_APP in demo-world.ts): Pulse and
 * Signals show the same world to everyone, so the post and the customer are always there, by the same links.
 */
export function CrossApp() {
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-6 text-sm" aria-label="Ask across apps">
      <h2 className="text-base font-semibold">Ask across apps</h2>
      <p className="text-muted">Pulse and Signals show the same made-up company to everyone. Open them in any order; your agent joins what they say.</p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5">
        <li>
          In Signals, open{" "}
          <a className="underline" href={`${SIGNALS}${signalsPostPath(CROSS_APP.post)}`} target="_blank" rel="noreferrer">
            {CROSS_APP.competitor}'s offer to Team teams in North America
          </a>{" "}
          and drop your agent on it.
        </li>
        <li>
          Ask: <strong>"{CROSS_APP.question}"</strong> It reads the offer in Signals and the churn here: in Sep 2026, five Team customers in North America left Pulse, among them <AppLink href={pulseCustomerPath(CROSS_APP.customer)}>{CROSS_APP.customerName}</AppLink> ({CROSS_APP.customer}), which had {CROSS_APP.seatsBefore} seats in Aug 2026.
        </li>
        <li>
          Or the other way round: drop your agent on <AppLink href={pulseCustomerPath(CROSS_APP.customer)}>{CROSS_APP.customerName}</AppLink> here and ask why they left.
        </li>
      </ol>
    </section>
  );
}

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

/** On the data pages while no agent is here: how to connect one — directly where Pulse offers it, through the dock on a dock-only deploy. */
export function DockHint(props: { state: SandboxState }) {
  if (props.state.grants.length > 0) return null;
  const direct = directOffered(props.state);
  return (
    <section className="card connect-panel" aria-label="Point your agent here">
      <h2>Point your agent here</h2>
      <p className="hint">
        {direct ? (
          <>
            {DIRECT_HINT}{" "}
            <AppLink href="/agents">Agents →</AppLink>
          </>
        ) : (
          <>No agent can read Pulse yet. Drag your agent from your agent dock (<strong>{dockName(props.state)}</strong>) onto any chart or customer, and allow it here and in the dock.</>
        )}
      </p>
    </section>
  );
}

/** The How-to on the v2 deploy: the Direct steps where Pulse offers Direct (the standard deploy), the dock steps on a dock-only deploy. */
export function DockHowTo(props: { state: SandboxState }) {
  const direct = directOffered(props.state);
  return (
    <div className="flex w-full flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">How-to</h1>
        <p className="text-sm text-muted">
          {direct ? DIRECT_INTRO : "Pulse is one of the apps your agent can read. You point it here from your agent dock."}
        </p>
      </section>
      <ol className="flex flex-col gap-3 border-t border-line pt-6">
        {(direct ? DIRECT_STEPS : STEPS(dockName(props.state))).map((step, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line text-xs font-semibold text-filament">{i + 1}</span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
      <CrossApp />
    </div>
  );
}
