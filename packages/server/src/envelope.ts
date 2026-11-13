import { APC_LINK_KEY, type ApcLinkOffer, type Attention, type FocusPayload, type FocusRow } from "@tineira/apc-protocol";

export const ATTENTION_NOTE = "The person pinned you to something on their screen. Call get_current_view to read it and mark it seen.";

/** The loop hint, carried only while a page of the person's is open and the grant was pinned lately (APC 0.8, `thenApplies`). */
export const THEN_NOTE = "When you have answered, call wait_for_focus: the person pinned you lately, is on the page and may point you at something else. Run it in the background if your client can; otherwise keep it short and never chain waits.";

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

/**
 * A tool error: `{ error, message }` in both `structuredContent` and `content[0].text` (the same JSON), with
 * `isError: true` (APC 0.10; before 0.10 the text only). The dock grant's `pairing` and `idle` errors use it.
 */
export function toolError(code: string, message: string): ToolResult {
  const data = { error: code, message };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
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
  return attachKey(result, "attention", attention);
}

/**
 * The loop hint, placed like the envelope: after answering, wait for the next
 * pin. The host says whether it applies (`thenApplies`: a page of the person's
 * is open and the grant was pinned lately); when not, the result is returned
 * unchanged, so an agent is not told to wait after every answer.
 */
export function attachThen(result: ToolResult, applies: boolean): ToolResult {
  return applies ? attachKey(result, "then", THEN_NOTE) : result;
}

/** An `apc_link` offer (APC 0.4), placed like the envelope: a top-level key of the structured result and of the text. */
export function attachApcLink(result: ToolResult, offer: ApcLinkOffer): ToolResult {
  return attachKey(result, APC_LINK_KEY, offer);
}

function attachKey(result: ToolResult, key: string, value: unknown): ToolResult {
  const structured = result.structuredContent ? { ...result.structuredContent, [key]: value } : undefined;
  let mirrored = false;
  const content = result.content.map((block, index) => {
    if (index !== 0 || block.type !== "text") return block;
    try {
      const parsed = JSON.parse(block.text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        mirrored = true;
        return { type: "text" as const, text: JSON.stringify({ ...(parsed as object), [key]: value }) };
      }
    } catch {
      // not JSON: fall through and append a block
    }
    return block;
  });
  if (!mirrored) content.push({ type: "text", text: JSON.stringify({ [key]: value }) });
  return { ...result, content, ...(structured ? { structuredContent: structured } : {}) };
}

export function envelopeBytes(attention: Attention | null): number {
  return attention ? new TextEncoder().encode(JSON.stringify(attention)).length : 0;
}

/** What the loop hint adds to a result's text, `,"then":"…"`; counted apart from the envelope. */
export function thenBytes(applies: boolean): number {
  return applies ? new TextEncoder().encode(`,"then":${JSON.stringify(THEN_NOTE)}`).length : 0;
}
