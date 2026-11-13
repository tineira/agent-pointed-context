import { APC_DEFAULT_MCP_PATH, APC_JSON_PAIRING_MAX_AGE_S, APC_STANDARD_VERSION, type ApcManifest, type ApcProfile } from "@tineira/apc-protocol";

/**
 * An app's `apc.json` (APC 0.5, `ApcManifest` in @tineira/apc-protocol), from what it already declares: its
 * name, its origin, the profiles it offers (`parseProfiles(env.APC_PROFILES)`), where its MCP URLs
 * live, and, with the Direct profile, the page where the person connects an agent directly.
 */
export function apcManifest(o: { name: string; origin: string; profiles: readonly ApcProfile[]; mcpPath?: string; connect?: string }): ApcManifest {
  const manifest: ApcManifest = { name: o.name, standard: APC_STANDARD_VERSION, origin: o.origin, profiles: [...o.profiles], mcp: { path: o.mcpPath ?? APC_DEFAULT_MCP_PATH } };
  if (o.profiles.includes("direct")) manifest.direct = { connect: new URL(o.connect ?? "/", o.origin).href };
  return manifest;
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
