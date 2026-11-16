/**
 * The version of the APC standard: the contract an app and an agent share
 * (view, pin, presence, the focus format, `wait_for_focus`, the tools, the
 * drag payload, pairing). It is semver and separate from the software release
 * (the repo's tags v0.1.0 and v0.2.0): the software can ship a dozen times
 * without the contract changing. The 1.0.0 contract is frozen: a minor only
 * adds, and a major may break inside the deprecation window. Every contract
 * change adds an entry to `packages/protocol/CHANGELOG.md` and bumps this.
 */
export const APC_STANDARD_VERSION = "1.0.0";
