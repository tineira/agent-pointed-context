/** Step 1 is shared by the Worker router and the Durable Object, before any ticket lookup. */
export function connectInput(body: unknown, readerOrigin: string | null, readerAllowed: (origin: string | null) => boolean, development: boolean) {
  const b = body as { ticket?: unknown; agent?: unknown; app?: { origin?: unknown }; reader?: unknown; label?: unknown } | null;
  if (!b || typeof b.ticket !== "string" || typeof b.agent !== "string" || !/^[\w.:-]{1,128}$/.test(b.agent)) return { ok: false as const, error: "invalid" };
  const reader = b.reader === true;
  if ((reader && b.app !== undefined) || (!reader && b.reader !== undefined) || (b.label !== undefined && (!reader || typeof b.label !== "string"))) return { ok: false as const, error: "invalid" };
  // An app body must name its origin: one without it is malformed, not a refused app.
  if (!reader && typeof b.app?.origin !== "string") return { ok: false as const, error: "invalid" };
  const origin = reader ? readerOrigin : (b.app!.origin as string);
  if (reader) {
    if (!readerAllowed(origin)) return { ok: false as const, error: "reader_not_allowed" };
  } else {
    let url: URL;
    try { url = new URL(origin!); } catch { return { ok: false as const, error: "invalid" }; }
    if (url.origin !== origin) return { ok: false as const, error: "app_not_allowed" };
    const loopback = development && url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    if (url.protocol === "http:" && !loopback) return { ok: false as const, error: "https_required" };
    if (url.protocol !== "https:" && !loopback) return { ok: false as const, error: "app_not_allowed" };
  }
  return { ok: true as const, ticket: b.ticket, agent: b.agent, origin: origin!, reader,
    label: typeof b.label === "string" ? b.label.replace(/[\p{C}]/gu, "").trim().slice(0, 40) : "" };
}
