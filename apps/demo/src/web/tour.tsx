/**
 * The guided first run (TIN-361): from "your agent is connected" to the moment it follows a new pin
 * on its own, then Bring what you know. The step comes from the sandbox (worker/tour.ts); the
 * person's answers go back to it, so a reload resumes and a skip sticks. Modals open and close the
 * run; the steps between are a corner panel and an arrow, so the chart stays free for dragging.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AgentIcon } from "./agent-icon.tsx";
import type { Api, GrantState, SandboxState } from "./api.ts";
import { CopyField } from "./connect.tsx";
import { GIVE_IT, MRR_PROMPT } from "./howto.tsx";
import { DownloadCsv } from "./pages.tsx";
import { isSeen } from "./pin-badges.tsx";
import { AppLink } from "./ui.tsx";

export const TOUR_PROMPT = "Tell me what I'm looking at in Pulse. After you answer, keep waiting for me to point you at something else; stop after 3 waits with no change.";
/** How long a moved pin may wait unread before the guide suggests asking. */
const NUDGE_MS = 20_000;

function Skip({ api, onChanged }: { api: Api; onChanged: () => void }) {
  return (
    <button
      type="button"
      className="tour-skip"
      onClick={async () => {
        await api.tour("skip");
        onChanged();
      }}
    >
      Skip guide
    </button>
  );
}

function Mark({ grant }: { grant: GrantState }) {
  return (
    <span className="mark mark-logo tour-mark">
      <AgentIcon clientName={grant.client_name} clientUa={grant.client_ua} clientIcon={grant.client_icon} />
    </span>
  );
}

/** An arrow from the agent's mark in the top bar to the selected month's bar, redrawn as the page moves. */
function Arrow({ grantId }: { grantId: string }) {
  const [pts, setPts] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  useEffect(() => {
    const measure = () => {
      const from = document.querySelector(`header [data-apc-mark][data-grant="${grantId}"]`)?.getBoundingClientRect();
      const to = (document.querySelector(".chart .bar-selected") ?? document.querySelector(".chart .bar"))?.getBoundingClientRect();
      if (!from || !to || to.bottom < 0 || to.top > innerHeight) return setPts(null);
      setPts({ x1: from.left + from.width / 2, y1: from.bottom + 6, x2: to.left + to.width / 2, y2: to.top + Math.min(24, to.height / 2) });
    };
    measure();
    const id = setInterval(measure, 250);
    addEventListener("scroll", measure, true);
    return () => {
      clearInterval(id);
      removeEventListener("scroll", measure, true);
    };
  }, [grantId]);
  if (!pts) return null;
  const { x1, y1, x2, y2 } = pts;
  const cx = (x1 + x2) / 2 - 80;
  const cy = Math.min(y1, y2) + 40;
  return (
    <svg className="tour-arrow" aria-hidden="true">
      <defs>
        <marker id="tour-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" />
        </marker>
      </defs>
      <path d={`M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}`} markerEnd="url(#tour-head)" />
    </svg>
  );
}

export function Tour(props: { api: Api; state: SandboxState; names: Map<string, string>; screen: string; onOverview: () => void; onChanged: () => void }) {
  const { api, state, onChanged } = props;
  const [, tick] = useState(0);
  const { step, grant_id } = state.tour;
  useEffect(() => {
    if (step !== "read_once") return;
    const id = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, [step]);
  const grant = state.grants.find((g) => g.id === grant_id);
  // The guide teaches v1 (drag the top-bar mark); Pulse's APC v2 deploy is driven from the dock (TIN-382).
  if (step === "off" || step === "connect" || !grant || state.v2) return null;
  const name = props.names.get(grant.id) ?? "Your agent";
  const onOverview = props.screen === "overview";

  if (step === "connected" || step === "read_twice") {
    return (
      <div className="tour-backdrop" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <div className="tour-modal">
          {step === "connected" ? (
            <>
              <div className="flex items-center gap-3">
                <Mark grant={grant} />
                <h2 id="tour-title">✓ {name} is connected</h2>
              </div>
              <p>Next, point it at something. Drag its mark from the top bar onto a chart in Overview, and ask about "this".</p>
              <div className="tour-actions">
                <button
                  type="button"
                  className="tour-primary"
                  onClick={async () => {
                    await api.tour("ack");
                    props.onOverview();
                    onChanged();
                  }}
                >
                  Go to Overview
                </button>
                <Skip api={api} onChanged={onChanged} />
              </div>
            </>
          ) : (
            <>
              <h2 id="tour-title">{name} follows your pointer. Now bring what you know.</h2>
              <p>Pulse knows customers and seats, not revenue. You know revenue. Your agent joins the two on its side and answers with numbers Pulse never had.</p>
              <ol className="tour-steps">
                <li>
                  <span>Download your file (it stands in for your billing export).</span>
                  <DownloadCsv seed={state.seed} />
                </li>
                <li>{GIVE_IT}</li>
                <li>
                  <span>Point at a bar of Active customers per month, and ask:</span>
                  <CopyField text={MRR_PROMPT} label="Copy prompt" />
                </li>
              </ol>
              <div className="tour-actions">
                <button
                  type="button"
                  className="tour-primary"
                  onClick={async () => {
                    await api.tour("done");
                    onChanged();
                  }}
                >
                  Got it
                </button>
                <AppLink href="/how-to?topic=examples" className="tour-link">
                  More examples →
                </AppLink>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // The corner panel for the steps in between.
  let title: string;
  let body: ReactNode;
  if (!onOverview) {
    title = "Point your agent";
    body = (
      <>
        <p>The guide continues on Overview, where the charts are.</p>
        <button type="button" className="tour-primary" onClick={props.onOverview}>
          Go to Overview
        </button>
      </>
    );
  } else if (step === "point") {
    title = "Point your agent";
    body = (
      <p>
        Drag <Mark grant={grant} /> from the top bar onto a month of Active customers.
      </p>
    );
  } else if (step === "pinned") {
    title = "Now ask it";
    body = (
      <>
        <p>Paste this to {name}:</p>
        <CopyField text={TOUR_PROMPT} label="Copy prompt" />
      </>
    );
  } else {
    const pending = grant.pin && !isSeen(grant.pin);
    const waited = pending && Date.now() - Date.parse(grant.pin!.pinned_at) > NUDGE_MS;
    title = "✓ It read your pin";
    body = (
      <>
        <p>
          Now drag the mark to another month, <strong>without writing to it</strong>. {name} should notice on its own.
        </p>
        {waited && (
          <p className="tour-nudge">
            Didn't react on its own? Some agents don't keep waiting. Ask it: <em>and this?</em>
          </p>
        )}
      </>
    );
  }
  return (
    <>
      {onOverview && step === "point" && <Arrow grantId={grant.id} />}
      <aside className="tour-panel" aria-label="Guide">
        <div className="tour-panel-head">
          <span className="tour-kicker">Guide</span>
          <Skip api={api} onChanged={onChanged} />
        </div>
        <h3>{title}</h3>
        {body}
      </aside>
    </>
  );
}
