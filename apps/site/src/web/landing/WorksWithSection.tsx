import { AgentIcon } from "../agent-icon.tsx";

/** The agents named under the hero, by their logos (agent-logos.ts, through model/products.ts). */
const AGENTS = [
  { brand: "claude", name: "Claude" },
  { brand: "openai", name: "ChatGPT" },
  { brand: "cursor", name: "Cursor" },
  { brand: "grok", name: "Grok" },
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
