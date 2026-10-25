import { BRANDS, brandFor, colorFor, type AgentMotion } from "./agent-brands.ts";

/** A small robot, for a client with no curated logo and no icon of its own. */
const BOT_PATH =
  "M11 2h2v2.07A7 7 0 0 1 19 11v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a7 7 0 0 1 6-6.93V2Zm-2.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM2 12h2v5H2v-5Zm18 0h2v5h-2v-5Z";

/**
 * An unplugged plug: an agent whose client has not connected yet. It says what to do next, which the
 * generic bot did not (TIN-407). Lucide's "unplug" icon (ISC license, lucide.dev).
 */
function Unplugged(props: { className: string; size: number; label: string }) {
  return (
    <svg className={props.className} width={props.size} height={props.size} viewBox="0 0 24 24" role="img" aria-label={`${props.label}, not connected`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m19 5 3-3" />
      <path d="m2 22 3-3" />
      <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
      <path d="M7.5 13.5 10 11" />
      <path d="M10.5 16.5 13 14" />
      <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
    </svg>
  );
}

/**
 * An agent's icon: the curated logo for its client, else the raster icon it sent, else a bot
 * colored from its name; an agent no client has connected to yet is an unplugged plug. motion animates it (styles.css, .agent-icon-*); reduced motion stops it.
 */
export function AgentIcon(props: { clientName: string | null; clientUa?: string | null; clientIcon?: string | null; motion?: AgentMotion; size?: number; brandId?: string }) {
  const { clientName, clientIcon, motion = "idle", size = 20 } = props;
  // brandId draws a brand's logo with no client behind it (the How-to's logo row).
  const brand = props.brandId ? (BRANDS.find((b) => b.id === props.brandId) ?? null) : brandFor(clientName, props.clientUa);
  const cls = `agent-icon agent-icon-${motion}`;
  const label = brand?.name ?? clientName ?? "Agent";
  const logo = brand?.logo;
  if (logo && "parts" in logo) {
    return (
      <svg className={cls} width={size} height={size} viewBox={logo.viewBox} role="img" aria-label={label}>
        {logo.parts.map((p, i) => (
          <path key={i} d={p.d} fill={p.fill ?? "currentColor"} fillRule={p.evenodd ? "evenodd" : undefined} clipRule={p.evenodd ? "evenodd" : undefined} />
        ))}
      </svg>
    );
  }
  if (logo) return <img className={cls} src={logo.image} width={size} height={size} alt={label} />;
  if (clientIcon) return <img className={cls} src={clientIcon} width={size} height={size} alt={label} />;
  if (!clientName) return <Unplugged className={cls} size={size} label={label} />;
  return (
    <svg className={cls} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
      <path d={BOT_PATH} fill={colorFor(clientName)} />
    </svg>
  );
}
