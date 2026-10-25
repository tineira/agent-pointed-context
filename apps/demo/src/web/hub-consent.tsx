/**
 * APC v2 (TIN-382): an agent dropped from a dock that Pulse does not know yet. Pulse asks the person
 * first, on its own page: may this agent read Pulse, and how much? On yes, Pulse makes a grant and
 * hands it to the dock's hub; the dock then asks too, and the agent reads Pulse only after both.
 */
import type { AgentDrag } from "@apc/web";
import type { FocusTarget } from "@apc/protocol";
import { useState } from "react";
import { REGIONS, type Region } from "../model/seed.ts";
import type { Api } from "./api.ts";

export interface PendingDrop {
  drag: AgentDrag & { hub: string; ticket: string };
  target: FocusTarget;
  at: number;
}

const ERRORS: Record<string, string> = {
  ticket_expired: "The drag is too old (a pairing ticket lasts 60 seconds). Drag the agent from the dock again.",
  hub_not_allowed: "Pulse does not pair with that dock.",
  hub_unreachable: "The dock did not answer. Try again in a moment.",
  app_not_allowed: "The dock does not pair with this Pulse.",
};

export function HubConsent(props: { api: Api; drop: PendingDrop; onDone: (notice: string | null) => void }) {
  const [region, setRegion] = useState<Region | "">("");
  const [busy, setBusy] = useState(false);
  const host = new URL(props.drop.drag.hub).host;
  const allow = async () => {
    setBusy(true);
    try {
      const r = await props.api.hubPair({ hub: props.drop.drag.hub, agent: props.drop.drag.agent, ticket: props.drop.drag.ticket, region: region || null, target: props.drop.target });
      props.onDone(r.ok ? `Paired with the dock at ${host}. Allow it there too, then ask your agent about "this".` : `Not paired: ${ERRORS[r.error ?? ""] ?? r.error}`);
    } catch (error) {
      props.onDone(`Not paired: ${String(error)}`);
    }
  };
  return (
    <div className="tour-backdrop" role="dialog" aria-modal="true" aria-labelledby="hub-consent-title">
      <div className="tour-modal">
        <h2 id="hub-consent-title">Let an agent from your dock read Pulse?</h2>
        <p>
          You dropped an agent from the dock at <b>{host}</b>. If you allow it, Pulse gives that dock its own access, the dock asks you once more, and from then on that agent reads Pulse when you point it here.
        </p>
        <label className="flex items-center gap-2 text-sm">
          Access
          <select className="rounded-md border border-line bg-background px-2 py-1" value={region} onChange={(e) => setRegion(e.target.value as Region | "")}>
            <option value="">All of Pulse</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r.toUpperCase()} only
              </option>
            ))}
          </select>
        </label>
        <div className="tour-actions">
          <button type="button" className="tour-primary" disabled={busy} onClick={() => void allow()}>
            {busy ? "Pairing…" : "Allow"}
          </button>
          <button type="button" className="tour-skip" disabled={busy} onClick={() => props.onDone(null)}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
