/**
 * An optional recipe for a dock grant's secret (APC 0.10, section 5 of the Dock design): derived from a key
 * the app keeps, so the app stores only a hash and a salt, which cannot rebuild the secret without the key.
 * Web Crypto only (Workers, Node 20+, Deno, Bun).
 *
 * - **K**: at least 32 random bytes, kept as a secret of the app's deployment.
 * - **`appTag`**: a fixed lowercase tag for the app, without `|` (letters, digits, `.`, `_` and `-`). It is
 *   immutable: changing it is the same as rotating K.
 * - **salt**: 16 random bytes, base64url without padding (22 characters; `newDockSalt`), new for each grant.
 * - **grantId**: the app's id for the grant, without `|`.
 * - **The secret** is `base64url_unpadded(HMAC-SHA256(K, "<appTag>-dock-v1|<grantId>|<salt>")[0..16])`: 22
 *   characters, 128 bits (`deriveDockSecret`).
 * - **Storage**: `dockSecretHash(secret)`, SHA-256 of the secret's ASCII bytes as lowercase hex (the same as
 *   `secretHash`), and the salt. Look grants up by a unique index on the hash; never compare the secret in
 *   plaintext. An in-memory comparison compares digests in constant time.
 * - **Rotating K** silently ends every dock grant at its next confirm (`not_paired`, then a new consent), and
 *   direct calls get 404: a mass end, not a kill switch and not routine. To rotate without that, keep a key
 *   id per grant and derive with the grant's key.
 */

/** The fewest bytes of K. */
export const DOCK_SECRET_KEY_MIN_BYTES = 32;
/** The salt's length in bytes (22 characters of unpadded base64url). */
export const DOCK_SECRET_SALT_BYTES = 16;

const APP_TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** 16 bytes as unpadded base64url: 21 free characters and a last one whose low 4 bits are zero. */
const SALT = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const GRANT_ID = /^[^|]{1,256}$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new salt for a grant: 16 random bytes, base64url without padding. */
export function newDockSalt(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(DOCK_SECRET_SALT_BYTES)));
}

/**
 * A grant's secret, derived (the recipe above): `base64url_unpadded(HMAC-SHA256(key, "<appTag>-dock-v1|<grantId>|<salt>")[0..16])`.
 * Throws on a key under 32 bytes, an `appTag` that is not lowercase or holds `|`, a `grantId` with `|`, or
 * a salt that is not 16 bytes of unpadded base64url: a recipe that runs on bad inputs is not the recipe.
 */
export async function deriveDockSecret(key: Uint8Array | ArrayBuffer, appTag: string, grantId: string, salt: string): Promise<string> {
  const raw = key instanceof Uint8Array ? key : new Uint8Array(key);
  if (raw.byteLength < DOCK_SECRET_KEY_MIN_BYTES) throw new RangeError(`deriveDockSecret: the key needs at least ${DOCK_SECRET_KEY_MIN_BYTES} bytes`);
  if (!APP_TAG.test(appTag)) throw new TypeError("deriveDockSecret: appTag is a fixed lowercase tag of letters, digits, '.', '_' and '-'");
  if (!GRANT_ID.test(grantId)) throw new TypeError("deriveDockSecret: grantId is 1 to 256 characters without '|'");
  if (!SALT.test(salt)) throw new TypeError("deriveDockSecret: salt is 16 bytes as unpadded base64url (22 characters)");
  const hmacKey = await crypto.subtle.importKey("raw", raw.slice(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${appTag}-dock-v1|${grantId}|${salt}`));
  return base64url(new Uint8Array(mac).slice(0, 16));
}

/**
 * What the app stores for a grant's secret: SHA-256 of its ASCII bytes, as lowercase hex (the same value as
 * `secretHash`, which the give-back and the revoked answer use). Throws on a secret that is not printable ASCII.
 */
export async function dockSecretHash(secret: string): Promise<string> {
  if (!/^[\x21-\x7e]{1,512}$/.test(secret)) throw new TypeError("dockSecretHash: the secret is 1 to 512 printable ASCII characters");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
