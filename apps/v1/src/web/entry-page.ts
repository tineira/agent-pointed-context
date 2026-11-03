import { stripBase } from "../base.ts";

/** V1's landing (/v1/) is public and never mounts the sandbox gate, including trailing-slash URLs. */
export function entryPage(pathname: string): "landing" | "sandbox" {
  const path = stripBase(pathname).replace(/\/+$/, "") || "/";
  return path === "/" ? "landing" : "sandbox";
}
