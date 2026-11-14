/**
 * The APC pet in the dock (TIN-483): one animated character for every agent, with the agent's logo (the
 * PNG badge the dock draws, TIN-388) on a white disc at its bottom right. The Windows pets, the web
 * Float and the dock's tiles all draw this one component. The character, its states, its motion (one
 * requestAnimationFrame loop per window, stopped while hidden, slow when calm, still with reduced motion)
 * and its colours are `@tineira/apc-web`'s (TIN-878), the same pet every APC app shows; this file only
 * wraps it for React and feeds it the hub's data.
 *
 * The dock draws the light pet (`scheme: "light"`), as it always has, on its light and dark pages.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPet, petPhase, petState, pinPhase, watchRead, type PetHandle, type PetState, type ReadWatch } from "@tineira/apc-web";
import { brandFor } from "../../../demo/src/web/agent-brands.ts";
import type { DockAgent } from "./agent-page.tsx";

/**
 * The character in a given state, `size` px square; `badge` is the agent's logo as a PNG data URI
 * (none: no badge). `phase` offsets its clock, so pets side by side do not breathe in step.
 */
export function ApcPet(props: { state: PetState; badge: string | null; label: string; size: number; phase?: number; /** The name is written next to it: hide it from screen readers. */ decorative?: boolean }) {
  const host = useRef<HTMLSpanElement>(null);
  const pet = useRef<PetHandle | null>(null);
  const look = { state: props.state, badge: props.badge ? { image: props.badge } : null, label: props.label, size: props.size, decorative: !!props.decorative };
  // A layout effect, so the first frame is drawn before the browser paints (no blank frame).
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const p = createPet({ ...look, phase: props.phase ?? 0, scheme: "light" }, el.ownerDocument);
    el.append(p.element);
    pet.current = p;
    return () => {
      p.destroy();
      p.element.remove();
      pet.current = null;
    };
  }, []);
  useEffect(() => {
    pet.current?.update(look);
  }, [props.state, props.badge, props.label, props.size, props.decorative]);
  // The SVG is the host's only child and lays out as if it were the host (the dock's .apc-pet styles it).
  return <span ref={host} style={{ display: "contents" }} />;
}

/**
 * An agent's pet: the character in the state the hub's data gives it. `dragging` is local to the
 * page (the person holds the pet). The pin the agent just read shows as "read" for a few seconds.
 */
export function AgentPet(props: { agent: DockAgent; size: number; dragging?: boolean; decorative?: boolean }) {
  const a = props.agent;
  const focus = a.focus ? { pinned_at: a.focus.pinned_at, seen: a.focus.seen } : null;
  const watch = useRef<ReadWatch | null | undefined>(undefined);
  const now = Date.now();
  watch.current = watchRead(watch.current, focus, now);
  const [, tick] = useState(0);
  const until = watch.current?.seen ? watch.current.until : 0;
  useEffect(() => {
    if (until <= Date.now()) return;
    const h = setTimeout(() => tick((n) => n + 1), until - Date.now() + 20);
    return () => clearTimeout(h);
  }, [until]);
  // The hub knows when a wait_for_focus is in flight (a.waiting): the dock never guesses it.
  const state = petState({
    connected: !!a.client_name,
    waiting: a.waiting,
    busy: a.busy,
    pin: pinPhase(watch.current, now),
    requests: a.pairings.filter((p) => p.status === "pending").length,
    dragging: !!props.dragging,
  });
  // The hub's badge once it has one; before, the logo the client sent or the curated raster logo (an SVG-only brand waits for the hub's PNG).
  const logo = brandFor(a.client_name, a.client_ua)?.logo;
  const badge = a.badge ?? a.client_icon ?? (logo && "image" in logo ? logo.image : null);
  return <ApcPet state={state} badge={badge} label={a.name} size={props.size} phase={petPhase(a.id)} decorative={props.decorative} />;
}
