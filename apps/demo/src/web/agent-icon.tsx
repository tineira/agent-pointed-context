import { brandFor, colorFor, type AgentMotion } from "./agent-brands.ts";

/** A small robot, for a client with no curated logo and no icon of its own. */
const BOT_PATH =
  "M11 2h2v2.07A7 7 0 0 1 19 11v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a7 7 0 0 1 6-6.93V2Zm-2.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM2 12h2v5H2v-5Zm18 0h2v5h-2v-5Z";

/**
 * An agent's icon: the curated logo for its client, else the raster icon it sent, else a bot
 * colored from its name. motion animates it (styles.css, .agent-icon-*); reduced motion stops it.
 */
export function AgentIcon(props: { clientName: string | null; clientIcon?: string | null; motion?: AgentMotion; size?: number }) {
  const { clientName, clientIcon, motion = "idle", size = 20 } = props;
  const brand = brandFor(clientName);
  const cls = `agent-icon agent-icon-${motion}`;
  const label = brand?.name ?? clientName ?? "Agent";
  if (brand && "path" in brand.logo) {
    return (
      <svg className={cls} width={size} height={size} viewBox={brand.logo.viewBox} role="img" aria-label={label}>
        <path d={brand.logo.path} fill={brand.logo.color ?? "currentColor"} />
      </svg>
    );
  }
  if (brand && "monogram" in brand.logo) {
    return (
      <span className={`${cls} agent-icon-mono`} style={{ width: size, height: size, fontSize: size * (brand.logo.monogram.length > 1 ? 0.42 : 0.6), color: brand.logo.color ?? undefined }} role="img" aria-label={label}>
        {brand.logo.monogram}
      </span>
    );
  }
  if (clientIcon) return <img className={cls} src={clientIcon} width={size} height={size} alt={label} />;
  return (
    <svg className={cls} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
      <path d={BOT_PATH} fill={clientName ? colorFor(clientName) : "currentColor"} />
    </svg>
  );
}
