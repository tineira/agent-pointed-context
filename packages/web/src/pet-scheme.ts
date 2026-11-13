/**
 * The pet's colours on light and dark pages (TIN-878), pure so they are tested without a browser.
 *
 * - **Light** is the pet as the dock always drew it: a dark body with a white outline, white eyes and a
 *   white shine.
 * - **Dark** is the inverse: a near-white body (never pure white), a dark outline and eyes, and a shine
 *   tuned to a light body (a soft highlight and a faint shade toward the edge, so it still reads round).
 *   The badge's white disc gets a thin dark outline, so it reads on the light body.
 * - The orange ring and "!", the orbit, the zz and the read check are the same in both: they are the
 *   state marks.
 *
 * `scheme` is "light", "dark" or "auto" (follows `prefers-color-scheme`). An app with its own theme
 * switch passes its theme. An app with a strict palette tints the body and the line (outline, eyes, wink)
 * with `tint`, or with the custom properties `--apc-pet-body` and `--apc-pet-line` (hex colours).
 */
import { BODY, BODY_GREY } from "./pet-pose.ts";

export type PetScheme = "light" | "dark" | "auto";

export interface PetPalette {
  /** The body at full colour, and the grey it fades to when offline. */
  body: string;
  bodyGrey: string;
  /** The body's outline, the eyes and the wink. */
  line: string;
  /** The shine: a radial gradient from `shineFrom` (the highlight) to `shineTo` (the edge). */
  shineFrom: { color: string; opacity: number };
  shineTo: { color: string; opacity: number };
  /** The outline of the badge's white disc, or null for none. */
  badgeOutline: string | null;
}

/** An app's own colours for the pet, as hex (#rgb or #rrggbb); anything else is ignored. */
export interface PetTint {
  body?: string | null;
  line?: string | null;
}

/** The dark pet's body: near-white, never pure white. */
export const PET_DARK_BODY = "#e8e9ec";
/** The dark pet's outline and eyes. */
export const PET_DARK_LINE = "#1b1e25";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A hex colour as #rrggbb, or null when it is not one. */
export function petHex(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v || !HEX.test(v)) return null;
  return v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join("")}`.toLowerCase() : v.toLowerCase();
}

/** The scheme the pet is drawn in: "auto" follows the page's `prefers-color-scheme`. */
export function resolvePetScheme(scheme: PetScheme | null | undefined, prefersDark: boolean): "light" | "dark" {
  if (scheme === "dark" || scheme === "light") return scheme;
  return scheme === "auto" && prefersDark ? "dark" : "light";
}

/** The palette of a scheme, with the app's tint on top. */
export function petPalette(scheme: "light" | "dark", tint: PetTint | null = null): PetPalette {
  const body = petHex(tint?.body);
  const line = petHex(tint?.line);
  if (scheme === "light") {
    const l = line ?? "#ffffff";
    return { body: body ?? BODY, bodyGrey: BODY_GREY, line: l, shineFrom: { color: "#ffffff", opacity: 0.22 }, shineTo: { color: "#ffffff", opacity: 0 }, badgeOutline: null };
  }
  const l = line ?? PET_DARK_LINE;
  return { body: body ?? PET_DARK_BODY, bodyGrey: BODY_GREY, line: l, shineFrom: { color: "#ffffff", opacity: 0.55 }, shineTo: { color: l, opacity: 0.1 }, badgeOutline: l };
}

const rgb = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));

/** The body's fill: `body` faded toward `bodyGrey` by `grey` (0 colour .. 1 grey), as pet-pose.ts mixes the light one. */
export function petFill(palette: Pick<PetPalette, "body" | "bodyGrey">, grey: number): string {
  const [a, b] = [rgb(palette.body), rgb(palette.bodyGrey)];
  const k = Math.min(1, Math.max(0, grey));
  return `rgb(${a.map((v, i) => Math.round(v + (b[i]! - v) * k)).join(",")})`;
}
