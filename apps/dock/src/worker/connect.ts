/** Step 1 is shared by the Worker router and the Durable Object, before any ticket lookup. */
export function connectInput(body: unknown, readerOrigin: string | null, readerAllowed: (origin: string | null) => boolean, development: boolean) {
  const b = body as { ticket?: unknown; agent?: unknown; app?: { origin?: unknown }; reader?: unknown; label?: unknown } | null;
  if (!b || typeof b.ticket !== "string" || typeof b.agent !== "string" || !/^[\w.:-]{1,128}$/.test(b.agent)) return { ok: false as const, error: "invalid" };
  const reader = b.reader === true;
  if ((reader && b.app !== undefined) || (!reader && b.reader !== undefined) || (b.label !== undefined && (!reader || typeof b.label !== "string"))) return { ok: false as const, error: "invalid" };
  const origin = reader ? readerOrigin : typeof b.app?.origin === "string" ? b.app.origin : null;
  if (reader) {
    if (!readerAllowed(origin)) return { ok: false as const, error: "reader_not_allowed" };
  } else {
    try {
      const url = new URL(origin!);
      if (url.origin !== origin || (url.protocol !== "https:" && !(development && url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)))) return { ok: false as const, error: "app_not_allowed" };
    } catch { return { ok: false as const, error: "app_not_allowed" }; }
  }
  return { ok: true as const, ticket: b.ticket, agent: b.agent, origin: origin!, reader,
    label: typeof b.label === "string" ? b.label.replace(/[\p{C}]/gu, "").trim().slice(0, 40) : "" };
}
