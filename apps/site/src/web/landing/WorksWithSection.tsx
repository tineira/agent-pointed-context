import { AgentIcon } from "../agent-icon.tsx";

/** The agents named under the hero, by their logos (products.ts). */
const AGENTS = [
  { brand: "claude", name: "Claude" },
  { brand: "openai", name: "ChatGPT" },
  { brand: "cursor", name: "Cursor" },
  { brand: "grok", name: "Grok" },
];

export function WorksWithSection() {
  return (
    <section className="landing-works rv" aria-label="Compatible agents">
      <ul className="landing-agents" aria-label="Works with">
        {AGENTS.map((a) => (
          <li key={a.brand}>
            <span aria-hidden="true">
              <AgentIcon clientName={null} brandId={a.brand} size={16} />
            </span>
            {a.name}
          </li>
        ))}
        <li>any agent that takes an MCP server</li>
      </ul>
    </section>
  );
}
