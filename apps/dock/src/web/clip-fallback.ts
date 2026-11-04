/**
 * What the landing's hero clip does when something fails (TIN-620). A `<source>` that cannot be loaded fires
 * `error` on itself, not on the video (it does not bubble), and the browser moves on to the next one: only the
 * last one failing means no clip at all. A file that loads but cannot be decoded (a browser that claims WebM and
 * fails on it) fires `error` on the video: then the WebM gives way to the MP4, and the MP4 to the poster.
 */
export type ClipError = { on: "source"; last: boolean } | { on: "video"; currentSrc: string };

/** "wait": the browser tries the next source itself; "mp4": play the MP4 instead; "poster": show the poster frame. */
export type ClipFallback = "wait" | "mp4" | "poster";

export function clipFallback(error: ClipError): ClipFallback {
  if (error.on === "source") return error.last ? "poster" : "wait";
  return /\.webm(?:[?#]|$)/.test(error.currentSrc) ? "mp4" : "poster";
}
