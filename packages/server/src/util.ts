/**
 * Shared internals of the Dock helpers (not exported from the package entry, but `badContentLength`, which
 * `hub-client.ts` re-exports): the bare-origin rule (M1, M9) and the capped body reader (M4, M7).
 */

/**
 * A bare origin as written (M1, M9): printable ASCII with no userinfo, backslash, query or fragment, no path
 * but `/`, and written exactly as its own origin (an optional "/" after it), so no default port, upper case,
 * dot segment (`/.`, `/..`) or control character that `new URL` would normalize away. Null otherwise. (A trailing dot
 * is kept by `new URL`: `https://host.` is its own origin, and the exact allowlist match refuses it.)
 */
export function bareOrigin(raw: string): URL | null {
  if (raw.length > 200 || !/^[\x21-\x7e]+$/.test(raw) || /[@\\?#]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  if (raw !== url.origin && raw !== `${url.origin}/`) return null;
  return url;
}

/** A present `content-length` that is not digits only, or is over the cap (M4). An absent one is fine. */
export function badContentLength(headers: Headers, cap: number): boolean {
  const declared = headers.get("content-length");
  return declared !== null && (!/^\d+$/.test(declared) || Number(declared) > cap);
}

/**
 * A body as bytes, at most `cap` of them (the decoded stream), or null past it: the stream is cancelled at the
 * cap and the rest is never read. With `expired`, each read races it (one deadline for the whole body, M3).
 * On a stream error or the deadline the stream is cancelled and the error is thrown.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number, expired?: Promise<never>): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await (expired ? Promise.race([reader.read(), expired]) : reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Bytes as strict UTF-8, or null when they are not. */
export function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}
