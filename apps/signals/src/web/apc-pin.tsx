/** The standard pin badge (TIN-482, `<apc-pin>` from @apc/web) in React: the icon is the agent's mark from the dock. */
import { definePinBadge, type ApcPinElement } from "@apc/web";
import { createElement, useEffect, useRef } from "react";

definePinBadge();

export function ApcPin(props: { id: string; name: string; icon: string | null | undefined; seen: boolean; onUnpin: (grantId: string) => void }) {
  const ref = useRef<ApcPinElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const unpin = (e: Event) => latest.current.onUnpin((e as CustomEvent<{ id: string }>).detail.id);
    el.addEventListener("apc-unpin", unpin);
    return () => el.removeEventListener("apc-unpin", unpin);
  }, []);
  useEffect(() => {
    if (ref.current) ref.current.agent = { id: props.id, name: props.name, icon: props.icon, seen: props.seen };
  });
  return createElement("apc-pin", { ref });
}
