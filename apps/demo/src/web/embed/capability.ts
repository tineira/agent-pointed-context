/**
 * The build's capability check for the hero view (TIN-1070, design TIN-1063 § 6.3 item 5): the chunks the hero loads
 * must not name a Pulse action the hero may not reach. Its own grant (mint, pin, unpin, its view) is all it may call;
 * Revoke, Start over, Allow (the dock's pairing and Connect), Wake and Settings stay in the full app, which no site may
 * frame. Pure, so vite.config.ts runs it on the bundle and a test runs it on fakes.
 */

/** What the check reads of each built chunk (Rollup's OutputChunk, the part it needs). */
export interface BuiltChunk {
  fileName: string;
  name: string;
  isEntry: boolean;
  imports: readonly string[];
  dynamicImports: readonly string[];
  code: string;
}

/** The paths of the actions the hero must never reach. */
export const EMBED_FORBIDDEN = ["/revoke", "/reset", "/hub/pair", "/connect/dock", "/wake", "/settings"] as const;

/** The name of the hero's entry in vite.config.ts (`rollupOptions.input`). */
export const EMBED_ENTRY = "embedHero";

/** The hero's chunks: its entry and every chunk it imports, statically or not. */
export function embedChunks(chunks: readonly BuiltChunk[]): BuiltChunk[] {
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  const entry = chunks.find((c) => c.isEntry && c.name === EMBED_ENTRY);
  if (!entry) return [];
  const seen = new Map<string, BuiltChunk>();
  const walk = (chunk: BuiltChunk) => {
    if (seen.has(chunk.fileName)) return;
    seen.set(chunk.fileName, chunk);
    for (const file of [...chunk.imports, ...chunk.dynamicImports]) {
      const next = byFile.get(file);
      if (next) walk(next);
    }
  };
  walk(entry);
  return [...seen.values()];
}

/** What is wrong, one line each; empty when the hero's chunks pass. A build with no hero entry is wrong too. */
export function embedCapabilityProblems(chunks: readonly BuiltChunk[]): string[] {
  const mine = embedChunks(chunks);
  if (!mine.length) return [`no "${EMBED_ENTRY}" entry in the build`];
  return mine.flatMap((c) => EMBED_FORBIDDEN.filter((path) => c.code.includes(path)).map((path) => `${c.fileName} names "${path}"`));
}
