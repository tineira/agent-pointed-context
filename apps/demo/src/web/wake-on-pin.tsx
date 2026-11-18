/**
 * Wake on pin in Direct mode (TIN-973, experimental), on Pulse's Agents screen: for an agent connected directly whose
 * client says it is Grok bot, the person pastes the webhook trigger of a Grok Bot routine, and Pulse calls it when they
 * point the agent while it is not calling, so the bot starts a run and reads the pin. One card per such agent, below the
 * list of agents (the list is @tineira/apc-web's element, which this page does not change), and wherever a webhook is
 * set, so Turn off stays reachable. `/agents#wake-<grant id>` (wake_on_pin's paste_at) opens one and brings it into view.
 */
import { useEffect, useId, useState } from "react";
import { WAKE_DAY_MAX, WAKE_GAP_MS, wakeAppPlace, wakeRoutinePrompt } from "../../../../packages/server/src/wake-shared.ts";
import type { Api, GrantState, PulseWake } from "./api.ts";
import { CopyField } from "./connect.tsx";
import { wakeAfterToggle, wakeCardOf, wakeLinkAtLoad, wakeOnHashChange, wakeScrollDue } from "./wake-hash.ts";

const PLACE = wakeAppPlace("Pulse");
const LIMITS_TEXT = `at most one every ${WAKE_GAP_MS / 1000} s, ${WAKE_DAY_MAX} a day`;

const STATUS_TEXT: Record<NonNullable<PulseWake["status"]>, string> = {
  ok: "Last wake went through.",
  broken: "Grok Bot refused the key, or the trigger is gone. Paste them again.",
  error: "The last wake didn't go through. The next pin tries again.",
  paused: "Paused: this agent no longer reports as Grok bot.",
  limit: `Today's ${WAKE_DAY_MAX} wakes are used up. Wakes start again tomorrow (UTC).`,
};

const TEST_TEXT: Record<string, string> = {
  ok: "Test sent. Grok Bot should start a run.",
  broken: "Grok Bot refused the key, or the trigger is gone.",
  error: "The test didn't go through.",
  too_soon: "Wait a few seconds between tests.",
  limit: `Today's ${WAKE_DAY_MAX} wakes are used up.`,
  no_webhook: "Set the webhook first.",
  paused: "This agent no longer reports as Grok bot.",
  unknown_grant: "This agent is gone.",
};

/** The Wake on pin section the address names now, or null. */
const wakeFromHash = (): string | null => wakeCardOf(location.hash);
/**
 * The section the address named when the page loaded: read once, as this module loads, because Pulse's routing and its
 * sandbox start can rewrite the address (dropping the hash) before the cards mount.
 */
const atLoad = wakeLinkAtLoad(typeof location === "undefined" ? null : location.hash);

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The cards, for the Direct agents that have Wake on pin offered or set; nothing when none has. */
export function WakeOnPinList(props: { api: Api; grants: GrantState[]; names: Map<string, string>; onChanged: () => void }) {
  const shown = props.grants.filter((g) => g.wake_offer || g.wake);
  // wake_on_pin's link: opens that agent's card and brings it into view, on load and in a page already open (hashchange).
  // The hash is then taken off the address, so a reload does not open it again; closing the card by hand closes it for good.
  const [open, setOpen] = useState(() => atLoad.mount(location.hash));
  // Whether the address still has to be scrolled to (the hash may already be gone from it, see atLoad).
  const [pending, setPending] = useState(() => open !== null);
  useEffect(() => {
    const onHash = () => {
      const next = wakeOnHashChange(location.hash);
      if (next) {
        setOpen(next.open);
        setPending(next.pending);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // The cards shown now: a card that comes later (an agent that just connected) is scrolled to when it appears.
  const ready = shown.map((g) => g.id).join(",");
  useEffect(() => {
    if (!wakeScrollDue(open, ready, pending)) return;
    const el = document.getElementById(open);
    if (!el) return;
    setPending(false);
    // Its top, below Pulse's sticky header: the open card can be taller than the window.
    el.scrollIntoView({ block: "start" });
    const bar = document.querySelector("header");
    if (bar && /sticky|fixed/.test(getComputedStyle(bar).position)) window.scrollBy(0, -bar.getBoundingClientRect().height - 8);
    if (wakeFromHash()) history.replaceState(history.state, "", location.pathname + location.search);
  }, [open, ready, pending]);
  if (!shown.length) return null;
  return (
    <section className="card">
      <h2>Wake on pin</h2>
      <p className="hint">
        For Grok bot connected directly: when you point it while it isn't working, Pulse wakes it through a Grok Bot webhook. Each wake starts a new Grok Bot run ({LIMITS_TEXT}). An agent that also has Wake on pin in your dock is woken by whichever of the two you pin.
      </p>
      {shown.map((g) => (
        <details
          key={g.id}
          id={`wake-${g.id}`}
          className="mt-2 rounded-lg border border-line px-3 py-2"
          open={open === `wake-${g.id}` || undefined}
          onToggle={(e) => {
            const next = wakeAfterToggle(open, `wake-${g.id}`, e.currentTarget.open);
            if (next !== open) setOpen(next);
          }}
        >
          <summary className="cursor-pointer font-medium">
            {props.names.get(g.id) ?? g.label}
            {g.wake ? " · on" : ""}
          </summary>
          <WakeOnPin api={props.api} grantId={g.id} wake={g.wake ?? null} onChanged={props.onChanged} />
        </details>
      ))}
    </section>
  );
}

function WakeOnPin(props: { api: Api; grantId: string; wake: PulseWake | null; onChanged: () => void }) {
  const urlId = useId();
  const keyId = useId();
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async (work: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      setNote(await work());
    } catch {
      setNote("Couldn't reach Pulse.");
    } finally {
      setBusy(false);
      props.onChanged();
    }
  };

  const w = props.wake;
  return (
    <div className="mt-2 flex flex-col gap-2 text-sm">
      {w ? (
        <>
          <p className="m-0">
            On, trigger …{w.url_tail}
            {w.sent_at ? ` · last wake ${when(w.sent_at)}` : ""}
          </p>
          {w.status && <p className={w.status === "ok" ? "m-0 text-muted" : "m-0"}>{STATUS_TEXT[w.status]}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || w.status === "paused"}
              onClick={() =>
                void run(async () => {
                  const r = await props.api.wakeTest(props.grantId);
                  return TEST_TEXT[r.ok ? (r.status ?? "error") : (r.error ?? "error")] ?? "The test didn't go through.";
                })
              }
            >
              Send a test
            </button>
            <button type="button" disabled={busy} onClick={() => void run(async () => {
              const r = await props.api.wakeClear(props.grantId);
              return r.ok ? "Turned off." : r.error === "unknown_grant" ? "This agent is gone." : "Couldn't turn it off.";
            })}>
              Turn off
            </button>
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await props.api.wakeSet(props.grantId, { url, key });
              if (r.ok) {
                setUrl("");
                setKey("");
                return "On. Send a test to check it.";
              }
              return r.error === "not_offered" ? "This agent no longer reports as Grok bot." : r.error === "unknown_grant" ? "This agent is gone." : "That isn't a Grok Bot webhook URL and key. Copy both from the trigger's settings.";
            });
          }}
        >
          <label htmlFor={urlId} className="text-muted">Webhook URL (POST to)</label>
          <input id={urlId} type="url" className="min-w-0 rounded-lg border border-line bg-background px-2 py-1.5" value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="https://api2.cursor.sh/automations/webhook/…" autoComplete="off" spellCheck={false} />
          <label htmlFor={keyId} className="text-muted">Key</label>
          <input id={keyId} type="password" className="min-w-0 rounded-lg border border-line bg-background px-2 py-1.5" value={key} onChange={(e) => setKey(e.currentTarget.value)} autoComplete="new-password" spellCheck={false} />
          <div className="mt-1">
            <button type="submit" disabled={busy || !url.trim() || !key.trim()}>
              Save
            </button>
          </div>
        </form>
      )}
      {note && (
        <p className="m-0" role="status">
          {note}
        </p>
      )}
      <p className="hint m-0">
        Ask Grok bot to set it up (it creates the routine and tells you where its URL and key are), or create a routine named “{PLACE.routineName}” with a webhook trigger and these instructions:
      </p>
      <CopyField text={wakeRoutinePrompt(PLACE)} />
    </div>
  );
}
