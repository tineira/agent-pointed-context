/**
 * Pulse's part of the agent manual: the prompt `guide` serves apcGuide(PULSE_GUIDE). The published
 * pulse-agent skill documents V1 and is generated from the frozen copy in apps/v1 (TIN-604), not from here.
 */
export const PULSE_GUIDE = {
  appName: "Pulse",
  extra: `## Pulse

- Pulse is product analytics for a SaaS: customers (external ids cus_NNNN, the same ids as the person's billing), plans, regions, seats and monthly activity. It holds no revenue.
- A figure's get_figure result lists inputs.customers, the ids behind the number. When the person has their own file (for example mrr-by-customer.csv), join it on your side: match those ids in their file and answer with numbers Pulse never had.
- Their file stays with them. Never upload it to Pulse, and never put its values in a Pulse tool argument.
- Have a name of your own? Call set_agent_name once.`,
};
