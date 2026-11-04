/**
 * Byte ranges for the dock's media (TIN-623). Workers static assets answer a `Range` request with the whole file
 * as `200`, without `Accept-Ranges` or `Content-Range`, and Safari (macOS and iOS) will not play a `<video>`
 * source that does not answer `206`. So /media/* runs the Worker first, which fetches the file from ASSETS and
 * cuts the range out of it here.
 *
 * One range is served (`bytes=a-b`, `a-`, `-n`); several ranges get the whole file as `200`, which RFC 9110
 * allows. The rules for what cannot be satisfied follow Cloudflare's own cache (its "Range request behavior"
 * page): `bytes=`, `bytes=-0`, inverted bounds, a start at or past the end, and any range on an empty file
 * answer `416` with `Content-Range: bytes *\/size`. A header that cannot be parsed, or names another unit, is
 * ignored.
 */

/** A range to serve, inclusive at both ends, as in `Content-Range`. */
export type ByteRange = { start: number; end: number };

/**
 * What a `Range` header asks of a file of `size` bytes: a range, "unsatisfiable" (answer 416), or null (ignore
 * the header and send the whole file).
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (header === null) return null;
  const m = header.trim().match(/^bytes\s*=\s*(.*)$/i);
  if (!m) return null;
  const set = m[1]!.trim();
  if (set === "") return "unsatisfiable";
  if (set.includes(",")) return null;
  const spec = set.match(/^(\d*)\s*-\s*(\d*)$/);
  if (!spec) return null;
  const [first, last] = [spec[1]!, spec[2]!];
  if (first === "" && last === "") return null;
  const number = (digits: string) => (digits === "" ? null : Number(digits));
  const [a, b] = [number(first), number(last)];
  if ((a !== null && !Number.isSafeInteger(a)) || (b !== null && !Number.isSafeInteger(b))) return null;
  if (a === null) {
    // A suffix: the last b bytes, or the whole file when it is shorter.
    if (b === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - b!), end: size - 1 };
  }
  if (a >= size || (b !== null && b < a)) return "unsatisfiable";
  return { start: a, end: b === null ? size - 1 : Math.min(b, size - 1) };
}

/**
 * Whether an `If-Range` value still names this file: a strong ETag that matches exactly, or the exact
 * Last-Modified date. A weak ETag never matches (RFC 9110, 13.1.5). No `If-Range` counts as a match.
 */
export function ifRangeMatches(ifRange: string | null, headers: Headers): boolean {
  if (ifRange === null) return true;
  const value = ifRange.trim();
  if (value.startsWith("W/")) return false;
  if (value.startsWith('"')) return value === headers.get("etag")?.trim();
  const modified = headers.get("last-modified");
  return modified !== null && value === modified.trim();
}

/**
 * The response for a GET or HEAD of a media file, given the asset's own response to the same request. Anything
 * but a plain 200 (a 304, a 404, a redirect) and the SPA's HTML fallback for a missing file pass through as
 * they are; a 200 says `Accept-Ranges: bytes`, and becomes a 206 or a 416 when the request asks for a range.
 * The asset's headers (Content-Type, ETag, Last-Modified, Cache-Control) are kept.
 *
 * For a HEAD, `asset` may be the asset's answer to a GET (the asset layer's HEAD has no Content-Length, so the
 * Worker asks with GET): its body is never sent, only counted when the asset gives no length.
 */
export async function withByteRanges(request: Request, asset: Response): Promise<Response> {
  if (asset.status !== 200 || (request.method !== "GET" && request.method !== "HEAD")) return asset;
  if (/^text\/html\b/i.test(asset.headers.get("content-type") ?? "")) return asset;
  const encoding = asset.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return asset;
  const head = request.method === "HEAD";
  const headers = new Headers(asset.headers);
  headers.set("accept-ranges", "bytes");
  const header = request.headers.get("range");
  const ranged = header !== null && ifRangeMatches(request.headers.get("if-range"), asset.headers);
  if (!head && !ranged) return new Response(asset.body, { status: 200, statusText: asset.statusText, headers });

  // The file's size: its Content-Length, or else its bytes, counted (inside the runtime a fetched body's length
  // is not always a header). The media files are small (well under a MB): a range is cut from the body in memory.
  const length = asset.headers.get("content-length");
  let size = length !== null && /^\d+$/.test(length) ? Number(length) : null;
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  if (size === null && asset.body) {
    bytes = new Uint8Array(await asset.arrayBuffer());
    size = bytes.byteLength;
  }
  /** The bytes from..to (exclusive) to send: none for a HEAD, the asset's own stream for the whole file. */
  const body = async (from: number, to: number) => {
    if (head || to === from) {
      if (!bytes) await asset.body?.cancel();
      return null;
    }
    if (!bytes && from === 0 && to === size) return asset.body;
    bytes ??= new Uint8Array(await asset.arrayBuffer());
    return from === 0 && to === bytes.byteLength ? bytes : bytes.slice(from, to);
  };
  // No size at all (a HEAD the asset answered without one): say what the asset said.
  if (size === null) return new Response(null, { status: 200, statusText: asset.statusText, headers });
  headers.set("content-length", String(size));
  const range = ranged ? parseRange(header, size) : null;
  if (range === null) return new Response(await body(0, size), { status: 200, statusText: asset.statusText, headers });

  if (range === "unsatisfiable") {
    await body(0, 0);
    headers.delete("content-type");
    headers.set("content-range", `bytes */${size}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("content-length", String(range.end - range.start + 1));
  return new Response(await body(range.start, range.end + 1), { status: 206, headers });
}
