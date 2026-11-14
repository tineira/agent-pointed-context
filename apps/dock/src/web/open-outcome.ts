/**
 * What the page makes of the dock's answer to POST /api/dock (TIN-879): a dock to open, the chooser, or an error.
 * The chooser only ever comes from the server's own `no_dock`, never from another 404 or a 5xx, so a bad deploy
 * or a network fault is shown as an error and cannot look like a lost dock.
 */
export type OpenOutcome = { kind: "dock"; did: string } | { kind: "choose"; replaced: boolean } | { kind: "error"; status: number };

export function openOutcome(status: number, body: unknown): OpenOutcome {
  const b = (typeof body === "object" && body !== null ? body : {}) as { did?: unknown; error?: unknown; replaced?: unknown };
  if (status === 404 && b.error === "no_dock") return { kind: "choose", replaced: b.replaced === true };
  if (status >= 200 && status < 300 && typeof b.did === "string" && b.did) return { kind: "dock", did: b.did };
  return { kind: "error", status };
}
