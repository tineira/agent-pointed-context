/**
 * The handoff card (TIN-901, `<apc-handoff>` from @tineira/apc-web) in React: the pairing code in its own block, the
 * time left and Cancel, from the person's Allow until their dock has the code. Signals shows it where the consent was.
 */
import { defineHandoff, type ApcHandoffElement, type HandoffPairing, type HandoffStrings } from "@tineira/apc-web";
import { createElement, useEffect, useRef } from "react";

defineHandoff();

export function ApcHandoff(props: {
  host: string;
  pairing: HandoffPairing | null;
  message?: string | null;
  onCancel: () => void;
  strings?: Partial<HandoffStrings>;
  /** The id of the card's title, for the dialog around it (aria-labelledby). */
  titleId?: string;
  /** Inside a dialog: focus moves to the card whenever it is drawn anew. */
  autoFocus?: boolean;
}) {
  const ref = useRef<ApcHandoffElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cancel = () => latest.current.onCancel();
    el.addEventListener("apc-cancel", cancel);
    return () => el.removeEventListener("apc-cancel", cancel);
  }, []);
  // Strings first, and on their own: a new object reaches the element even when nothing else changed.
  useEffect(() => {
    if (ref.current) ref.current.strings = props.strings ?? null;
  }, [props.strings]);
  // Only when something shown changed: the element redraws on every set.
  const key = JSON.stringify([props.host, props.pairing, props.message ?? null, props.titleId ?? null, props.autoFocus ?? false]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.autoFocus = latest.current.autoFocus ?? false;
    el.titleId = latest.current.titleId ?? "";
    el.host = latest.current.host;
    el.message = latest.current.message ?? null;
    el.pairing = latest.current.pairing;
  }, [key]);
  return createElement("apc-handoff", { ref });
}
