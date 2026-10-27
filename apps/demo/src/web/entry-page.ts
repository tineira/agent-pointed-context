/** Public entry pages never mount the sandbox gate, including trailing-slash URLs. */
export function entryPage(pathname: string): "chooser" | "v1" | "sandbox" {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/" ? "chooser" : path === "/v1" ? "v1" : "sandbox";
}
