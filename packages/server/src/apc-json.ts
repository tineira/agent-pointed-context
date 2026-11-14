import { APC_DEFAULT_MCP_PATH, APC_JSON_PAIRING_MAX_AGE_S, APC_STANDARD_VERSION, endpointRule, parseApcManifest, type ApcEndpointProfile, type ApcManifest, type ApcProfile } from "@tineira/apc-protocol";

/** An entry of `mcp.endpoints` an app declares (APC 0.11): an exact path, or one ending in `/{secret}`, and its profiles. */
export interface ApcEndpointDeclaration {
  path: string;
  profiles: readonly ApcEndpointProfile[];
}

/**
 * Where the app's MCP URLs live. Either `mcpPath` alone (APC 0.5; `/mcp/` when left out), or `endpoints` (APC 0.11)
 * with `mcpPath` given on purpose: the path older readers still go by, every endpoint inside it, or `null` to serve
 * the endpoints alone (readers before 0.11 then refuse the file).
 */
export type ApcMcpDeclaration = { mcpPath?: string; endpoints?: undefined } | { endpoints: readonly ApcEndpointDeclaration[]; mcpPath: string | null };

/**
 * An app's `apc.json` (APC 0.5, `ApcManifest` in @tineira/apc-protocol), from what it already declares: its
 * name, its origin, the profiles it offers (`parseProfiles(env.APC_PROFILES)`), where its MCP URLs
 * live, and, with the Direct profile, the page where the person connects an agent directly.
 *
 * With `endpoints` (APC 0.11) it checks what the caller wrote and throws rather than serve a file a reader would
 * refuse or read otherwise: an endpoint outside `mcpPath`, a path listed twice, an entry no 0.11 reader would use
 * (another path form), a profile word it does not know, or `dock` on a path without `{secret}`. The profiles
 * offered right now play no part: an entry may list `dock` while the app is not pairing (M8), and `profiles` may
 * be empty.
 */
export function apcManifest(o: { name: string; origin: string; profiles: readonly ApcProfile[]; connect?: string } & ApcMcpDeclaration): ApcManifest {
  if (typeof o.mcpPath === "string") checkMcpPath(o.mcpPath);
  const mcp: ApcManifest["mcp"] = {};
  if (o.endpoints) {
    // Given on purpose, also from plain JavaScript: a path for older readers, or null to leave it out.
    if (o.mcpPath === undefined) throw new Error("apcManifest: with endpoints, give mcpPath: the path readers before 0.11 go by, or null to leave it out");
    if (o.mcpPath !== null) mcp.path = o.mcpPath;
    mcp.endpoints = o.endpoints.map((e) => ({ ...e, profiles: [...e.profiles] }));
    checkEndpoints(o.origin, mcp);
  } else mcp.path = o.mcpPath ?? APC_DEFAULT_MCP_PATH;
  const manifest: ApcManifest = { name: o.name, standard: APC_STANDARD_VERSION, origin: o.origin, profiles: [...o.profiles], mcp };
  if (o.profiles.includes("direct")) manifest.direct = { connect: new URL(o.connect ?? "/", o.origin).href };
  return manifest;
}

/**
 * `mcp.path` is a prefix that starts and ends with `/` (APC 0.5): every grant's MCP URL starts with origin + path.
 * Said here, at start, in words that name the fix, rather than as a file every reader refuses.
 */
function checkMcpPath(path: string): void {
  if (!path.startsWith("/") || !path.endsWith("/") || path.length > 200 || path.split("/").some((s) => s === "." || s === "..")) {
    const fix = path.startsWith("/") && !path.endsWith("/") ? `: write "${path}/". An exact endpoint at "${path}" (a URL every grant shares, a bearer token naming the grant) is still covered: list it in endpoints, or serve it at mcpPath without its last /` : "";
    throw new Error(`apcManifest: mcpPath "${path}" must start and end with / (it is a prefix: every grant's MCP URL starts with origin + mcpPath)${fix}`);
  }
}

function checkEndpoints(origin: string, mcp: ApcManifest["mcp"]): void {
  if (mcp.endpoints!.length === 0) throw new Error("apcManifest: endpoints is empty: the file would cover no MCP URL, mcpPath or not");
  // The rest of the file as a reader would see it, with every profile, so only what the caller wrote is judged.
  const probe = parseApcManifest({ name: "probe", standard: APC_STANDARD_VERSION, origin, profiles: ["dock"], mcp }, origin);
  if (!probe.ok) throw new Error(`apcManifest: ${probe.detail}`);
  for (const entry of mcp.endpoints!) {
    const extra = Object.keys(entry).filter((k) => k !== "path" && k !== "profiles");
    if (extra.length) throw new Error(`apcManifest: ${entry.path} has ${extra.join(", ")}: an entry is path and profiles only`);
    const rule = endpointRule(entry);
    if (!rule) throw new Error(`apcManifest: ${entry.path} is not an endpoint a 0.11 reader uses (an exact path, or one ending in /{secret}, with no trailing /)`);
    if (!entry.profiles.length) throw new Error(`apcManifest: ${entry.path} lists no profile`);
    for (const p of entry.profiles) {
      if (!rule.profiles.includes(p as ApcEndpointProfile)) throw new Error(`apcManifest: ${entry.path} lists ${p}, which readers ignore there (dock needs a path ending in /{secret})`);
    }
  }
}

/**
 * `GET /.well-known/apc.json`: the manifest as JSON. Public and the same for everyone, so any page or
 * tool may read it (`access-control-allow-origin: *`), and caches may keep it for a minute
 * (`APC_JSON_PAIRING_MAX_AGE_S`; five minutes before APC 0.10): a hub decides a pairing on a copy at most
 * that old (M8, H7), so an app that stops offering `dock` stops being paired within the minute. List `dock`
 * in `profiles` only while the app can pair right now (its Dock config is present).
 */
export function apcJsonResponse(manifest: ApcManifest): Response {
  return Response.json(manifest, { headers: { "cache-control": `public, max-age=${APC_JSON_PAIRING_MAX_AGE_S}`, "access-control-allow-origin": "*" } });
}
