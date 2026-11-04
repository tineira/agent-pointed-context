import { APC_DEFAULT_MCP_PATH, APC_STANDARD_VERSION, type ApcManifest, type ApcProfile } from "@tineira/apc-protocol";

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
 * tool may read it (`access-control-allow-origin: *`), and caches may keep it for five minutes.
 */
export function apcJsonResponse(manifest: ApcManifest): Response {
  return Response.json(manifest, { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
}
