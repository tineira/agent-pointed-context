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

type Bytes = ReadableStream<Uint8Array>;

/**
 * At most this much of a file is read to learn its size when the asset layer does not give it (inside workerd its
 * GET has no Content-Length header). A larger file is sent whole, as 200 without Accept-Ranges.
 */
export const MAX_COUNTED = 16 * 1024 * 1024;

/**
 * The bytes from..to (exclusive) of a stream, streamed: the bytes before `from` are skipped, and once `to` is
 * reached the rest of the source is cancelled. Memory stays at one chunk whatever the file's size.
 */
export function sliceStream(source: Bytes, from: number, to: number): Bytes {
  const reader = source.getReader();
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (offset >= to) {
          controller.close();
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) return controller.close();
        const at = offset;
        offset += value.byteLength;
        const [a, b] = [Math.max(from - at, 0), Math.min(to - at, value.byteLength)];
        if (b > a) return controller.enqueue(value.subarray(a, b));
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** A stream that sends its length (workerd drops a Content-Length header set on a plain stream body). */
function fixedLength(stream: Bytes, length: number): Bytes {
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (!Fixed) return stream;
  const fixed = new Fixed(length);
  void stream.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

/** A stream of chunks already read, then the rest of the reader (if any). */
function replay(chunks: Uint8Array[], reader?: ReadableStreamDefaultReader<Uint8Array>): Bytes {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift();
      if (next) return controller.enqueue(next);
      const read = reader ? await reader.read() : { done: true as const, value: undefined };
      if (read.done) controller.close();
      else controller.enqueue(read.value);
    },
    cancel: (reason) => reader?.cancel(reason),
  });
}

/**
 * Counts a body of unknown size, reading at most `max` bytes: its size and its bytes again as a stream (none
 * when `keep` is false), or, past `max`, the whole body as a stream (null when not kept).
 */
async function count(body: Bytes, max: number, keep: boolean): Promise<{ size: number; body: Bytes | null } | { over: Bytes | null }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { size, body: keep ? replay(chunks) : null };
    size += value.byteLength;
    if (keep) chunks.push(value);
    if (size > max) {
      if (keep) return { over: replay(chunks, reader) };
      await reader.cancel();
      return { over: null };
    }
  }
}

/** The asset's answer as it is, without a body for a HEAD (the Worker asks the asset layer with GET). */
async function asIs(request: Request, asset: Response): Promise<Response> {
  if (request.method !== "HEAD" || asset.body === null) return asset;
  await asset.body.cancel();
  return new Response(null, { status: asset.status, statusText: asset.statusText, headers: asset.headers });
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
export async function withByteRanges(request: Request, asset: Response, maxCounted = MAX_COUNTED): Promise<Response> {
  const head = request.method === "HEAD";
  if (!head && request.method !== "GET") return asset;
  const encoding = asset.headers.get("content-encoding");
  const html = /^text\/html\b/i.test(asset.headers.get("content-type") ?? "");
  if (asset.status !== 200 || html || (encoding && encoding.toLowerCase() !== "identity")) return asIs(request, asset);
  const headers = new Headers(asset.headers);
  headers.set("accept-ranges", "bytes");
  const header = request.headers.get("range");
  const ranged = header !== null && ifRangeMatches(request.headers.get("if-range"), asset.headers);
  if (!head && !ranged) return new Response(asset.body, { status: 200, statusText: asset.statusText, headers });

  // The file's size: its Content-Length, or else its bytes, counted up to maxCounted.
  const length = asset.headers.get("content-length");
  let size = length !== null && /^\d+$/.test(length) ? Number(length) : null;
  let body: Bytes | null = asset.body;
  if (size === null && body) {
    const counted = await count(body, maxCounted, !head);
    if ("over" in counted) {
      headers.delete("accept-ranges");
      return new Response(counted.over, { status: 200, statusText: asset.statusText, headers });
    }
    ({ size, body } = counted);
  }
  // No size at all (a HEAD the asset answered without one): say what the asset said.
  if (size === null) return new Response(null, { status: 200, statusText: asset.statusText, headers });

  /** The bytes from..to (exclusive), streamed; none for a HEAD. */
  const send = async (from: number, to: number): Promise<Bytes | null> => {
    if (head || !body || to === from) {
      await body?.cancel();
      return null;
    }
    return fixedLength(from === 0 && to === size ? body : sliceStream(body, from, to), to - from);
  };
  headers.set("content-length", String(size));
  const range = ranged ? parseRange(header, size) : null;
  if (range === null) return new Response(await send(0, size), { status: 200, statusText: asset.statusText, headers });

  if (range === "unsatisfiable") {
    await send(0, 0);
    headers.delete("content-type");
    headers.set("content-range", `bytes */${size}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("content-length", String(range.end - range.start + 1));
  return new Response(await send(range.start, range.end + 1), { status: 206, headers });
}
