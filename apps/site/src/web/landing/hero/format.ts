/** One line of JSON for the hero's tool calls and results, with a space after every colon and comma. */
export function inlineJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`).join(", ")} }`;
}
