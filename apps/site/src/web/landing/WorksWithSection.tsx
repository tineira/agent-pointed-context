import { AgentIcon } from "../agent-icon.tsx";

/**
 * The agents named under the hero, by their logos (agent-logos.ts, through model/products.ts). The Grok
 * bot's is the one raster logo of the row (GROK_BOT_PNG, TIN-365): the others are one-tone vector marks.
 */
const AGENTS = [
  { brand: "claude", name: "Claude" },
  { brand: "openai", name: "ChatGPT" },
  { brand: "grok", name: "Grok" },
  { brand: "grok-bot", name: "Grok bot" },
];

export function WorksWithSection() {
  return (
    <section className="wrap landing-works rv" aria-label="Compatible agents">
      <p className="landing-works-lab">Works with</p>
      <ul className="landing-agents">
        {AGENTS.map((a) => (
          <li key={a.brand}>
            <span aria-hidden="true">
              <AgentIcon clientName={null} brandId={a.brand} size={23} />
            </span>
            {a.name}
          </li>
        ))}
      </ul>
      <p className="landing-compat">and any agent that accepts a remote MCP server</p>
    </section>
  );
}
