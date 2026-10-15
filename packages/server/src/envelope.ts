import type { Attention, FocusPayload, FocusRow } from "@apc/protocol";

export const ATTENTION_NOTE = "The person pinned you to something on their screen. Call get_current_view to read it and mark it seen.";

/** A tool result as MCP carries it: structured for the client, the same JSON as text for the model. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function toolResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function toolError(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: code, message }) }], isError: true };
}

/** The pin is unread while it was dropped after the last read that returned it. */
export function isUnread(row: FocusRow | null): row is FocusRow {
  return row !== null && (row.seen_at === null || row.seen_at < row.pinned_at);
}

export function attentionFor(focus: FocusPayload): Attention {
  return { focus, note: ATTENTION_NOTE };
}

/**
 * Put the envelope where the model sees it: a top-level key of the structured
 * result (never `_meta`, which some clients withhold from the model) and, for
 * clients that pass only the text content, the same key in the text.
 */
export function attachAttention(result: ToolResult, attention: Attention): ToolResult {
  const structured = result.structuredContent ? { ...result.structuredContent, attention } : undefined;
  const content = result.content.map((block, index) => {
    if (index !== 0 || block.type !== "text") return block;
    try {
      const parsed = JSON.parse(block.text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { type: "text" as const, text: JSON.stringify({ ...(parsed as object), attention }) };
      }
    } catch {
      // not JSON: fall through and append a block
    }
    return block;
  });
  const mirrored = content[0]?.text.includes('"attention"') ?? false;
  if (!mirrored) content.push({ type: "text", text: JSON.stringify({ attention }) });
  return { ...result, content, ...(structured ? { structuredContent: structured } : {}) };
}

export function envelopeBytes(attention: Attention | null): number {
  return attention ? new TextEncoder().encode(JSON.stringify(attention)).length : 0;
}
