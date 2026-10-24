/**
 * Pulse's part of the agent manual. The prompt `guide` serves apcGuide(PULSE_GUIDE),
 * and skills/pulse-agent/SKILL.md is generated from the same text
 * (node scripts/build-skill.mjs; a test keeps them identical).
 */
export const PULSE_GUIDE = {
  appName: "Pulse",
  extra: `## Pulse

- Pulse is product analytics for a SaaS: customers (external ids cus_NNNN, the same ids as the person's billing), plans, regions, seats and monthly activity. It holds no revenue.
- A figure's get_figure result lists inputs.customers, the ids behind the number. When the person has their own file (for example mrr-by-customer.csv), join it on your side: match those ids in their file and answer with numbers Pulse never had.
- Their file stays with them. Never upload it to Pulse, and never put its values in a Pulse tool argument.
- Have a name of your own? Call set_agent_name once.`,
};

/** The skill's front matter: the skills CLI and the agents read name and description to decide when to load it. */
export const SKILL_FRONT_MATTER = `---
name: pulse-agent
description: Load in any session connected to a Pulse or Agent Pointed Context MCP server (tools get_current_view and wait_for_focus). How to read what the person points at, when to wait for their next pin, and the rules for their own files and restricted access.
---
`;
