/**
 * Wake on pin (TIN-962, experimental), on a Grok bot agent's tile: the person pastes the webhook trigger of a Grok Bot
 * automation, and the dock calls it when they point the agent while it is not calling, so the bot starts a run and reads
 * the pin. Shown whenever the agent reports as Grok bot, and whenever a webhook is set (so Turn off is always there).
 */
import { useId, useState } from "react";
import { CopyRow } from "./setup.tsx";
import { WAKE_DAY_MAX, WAKE_GAP_MS, WAKE_ROUTINE_NAME, WAKE_ROUTINE_PROMPT } from "../wake-shared.ts";

/** The limits as the panel says them. */
const LIMITS_TEXT = `at most one every ${WAKE_GAP_MS / 1000} s, ${WAKE_DAY_MAX} a day`;

/** What the dock says of the agent's webhook; never its key. */
export interface DockWake {
  url_tail: string;
  status: "ok" | "broken" | "error" | "paused" | "limit" | null;
  status_at: string | null;
  sent_at: string | null;
}


const STATUS_TEXT: Record<NonNullable<DockWake["status"]>, string> = {
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
};

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function WakeOnPin(props: {
  wake: DockWake | null;
  set: (body: { url: string; key: string }) => Promise<{ ok?: boolean; error?: string }>;
  clear: () => Promise<unknown>;
  test: () => Promise<{ ok?: boolean; error?: string; status?: string }>;
  refresh: () => void;
}) {
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
      setNote("Couldn't reach your dock.");
    } finally {
      setBusy(false);
      props.refresh();
    }
  };

  const w = props.wake;
  return (
    <div className="wake">
      <p className="wake-lead">When you point this agent while it isn't working, the dock wakes it through a Grok Bot webhook. Each wake starts a new Grok Bot run ({LIMITS_TEXT}).</p>
      {w ? (
        <>
          <p className="wake-state">
            On, trigger …{w.url_tail}
            {w.sent_at ? ` · last wake ${when(w.sent_at)}` : ""}
          </p>
          {w.status && <p className={w.status === "ok" ? "wake-status ok" : "wake-status warn"}>{STATUS_TEXT[w.status]}</p>}
          <div className="row">
            <button type="button" disabled={busy || w.status === "paused"} onClick={() => void run(async () => {
              const r = await props.test();
              return TEST_TEXT[r.ok ? (r.status ?? "error") : (r.error ?? "error")] ?? "The test didn't go through.";
            })}>
              Send a test
            </button>
            <button type="button" disabled={busy} onClick={() => void run(async () => (await props.clear(), "Turned off."))}>
              Turn off
            </button>
          </div>
        </>
      ) : (
        <form
          className="wake-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await props.set({ url, key });
              if (r.ok) {
                setUrl("");
                setKey("");
                return "On. Send a test to check it.";
              }
              return r.error === "not_offered" ? "This agent no longer reports as Grok bot." : "That isn't a Grok Bot webhook URL and key. Copy both from the trigger's settings.";
            });
          }}
        >
          <label htmlFor={urlId}>Webhook URL (POST to)</label>
          <input id={urlId} type="url" value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="https://api2.cursor.sh/automations/webhook/…" autoComplete="off" spellCheck={false} />
          <label htmlFor={keyId}>Key</label>
          <input id={keyId} type="password" value={key} onChange={(e) => setKey(e.currentTarget.value)} autoComplete="new-password" spellCheck={false} />
          <div className="row">
            <button type="submit" disabled={busy || !url.trim() || !key.trim()}>
              Save
            </button>
          </div>
        </form>
      )}
      {note && <p className="wake-note" role="status">{note}</p>}
      <p className="wake-lead">Ask Grok bot to set it up (it creates the routine and tells you where its URL and key are), or create a routine named “{WAKE_ROUTINE_NAME}” with a webhook trigger and these instructions:</p>
      <CopyRow text={WAKE_ROUTINE_PROMPT} block />
    </div>
  );
}
