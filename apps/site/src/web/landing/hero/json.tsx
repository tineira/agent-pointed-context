/**
 * Small JSON on the hero's stage: keys, strings, numbers and literals as spans (React text, never HTML), and the
 * focus card the agent window shows after get_current_view.
 */
import { useId, useState, type ReactNode } from "react";
import type { HeroFocus } from "./data.ts";

/** A value as one line of JSON, with a space after every colon and comma. */
export function inlineJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`).join(", ")} }`;
}

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:null|true|false)\b|-?\d+(?:\.\d+)?|…/g;

/** JSON text with its tokens coloured. */
export function Json(props: { text: string }): ReactNode {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of props.text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (start > at) out.push(props.text.slice(at, start));
    if (m[1] && m[2] !== undefined) out.push(<span key={start} className="hero-json-key">{m[1]}</span>, m[2]);
    else if (m[1]) out.push(<span key={start} className="hero-json-str">{m[1]}</span>);
    else out.push(<span key={start} className="hero-json-lit">{m[0]}</span>);
    at = start + m[0].length;
  }
  if (at < props.text.length) out.push(props.text.slice(at));
  return <>{out}</>;
}

/** The keys the card shows first: what the target is, and the call that reads it. */
const MAJOR = new Set(["kind", "params", "next", "next_args"]);
const CALL = new Set(["next", "next_args"]);

/** The focus, as the agent received it: the target and the call that reads it, the other keys a click away. */
export function FocusCard(props: { focus: HeroFocus }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const entries = Object.entries(props.focus);
  const more = entries.filter(([k]) => !MAJOR.has(k)).length;
  return (
    <div className="hero-focus">
      <div className="hero-focus-head">
        <span>focus · ids and keys only</span>
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? "fewer keys" : `+ ${more} more keys`}
        </button>
      </div>
      <pre id={id}>
        {"{\n"}
        {entries
          .filter(([k]) => open || MAJOR.has(k))
          .map(([k, v], i, shown) => {
            const line = <Json text={`  ${JSON.stringify(k)}: ${inlineJson(v)}`} />;
            return (
              <span key={k} className={CALL.has(k) ? "hero-focus-call" : undefined}>
                {line}
                {i < shown.length - 1 ? ",\n" : "\n"}
              </span>
            );
          })}
        {"}"}
      </pre>
    </div>
  );
}
