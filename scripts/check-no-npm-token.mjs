// Fails when any npm token is configured (TIN-612): the publish workflow uses npm trusted publishing (OIDC), and a
// token in the environment or in an .npmrc could be used instead of it. Never prints a token's value, only where
// one was found.
//   node scripts/check-no-npm-token.mjs
// It looks at: NODE_AUTH_TOKEN and any npm_config_* variable naming an auth key; `npm config list` (which shows a
// set _authToken as "(protected)", for every config file npm reads, with `npm config get` refusing protected
// keys on npm 11+); and the .npmrc files directly (the user config, $NPM_CONFIG_USERCONFIG or ~/.npmrc, and the
// project's .npmrc in the current folder).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** An auth key in .npmrc syntax, also how `npm config list` prints one: `//host/:_authToken = (protected)`. */
const AUTH_KEY = /(^|[:/])(_authToken|_auth|_password)\s*=/im;
const found = [];

// 1. The environment.
if ((process.env.NODE_AUTH_TOKEN ?? "") !== "") found.push("the environment variable NODE_AUTH_TOKEN");
for (const name of Object.keys(process.env)) {
  if (/^npm_config_/i.test(name) && /(_authtoken|_auth|_password)$/i.test(name) && process.env[name]) found.push(`the environment variable ${name}`);
}

// 2. What npm itself reads (every config file and the environment), as `npm config list` shows it.
const listed =
  process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", '"npm config list"'], { encoding: "utf8", windowsVerbatimArguments: true })
    : spawnSync("npm", ["config", "list"], { encoding: "utf8" });
if (listed.status !== 0) {
  console.error(`check-no-npm-token: npm config list failed (exit ${listed.status}); cannot tell whether a token is configured`);
  process.exit(1);
}
if (AUTH_KEY.test(listed.stdout ?? "")) found.push("npm's config (npm config list shows an auth key)");

// 3. The .npmrc files, read directly.
const userconfig = process.env.NPM_CONFIG_USERCONFIG || process.env.npm_config_userconfig || join(homedir(), ".npmrc");
for (const file of [...new Set([resolve(userconfig), resolve(".npmrc")])]) {
  if (existsSync(file) && AUTH_KEY.test(readFileSync(file, "utf8"))) found.push(`the file ${file}`);
}

if (found.length) {
  console.error(`check-no-npm-token: an npm token is configured in ${[...new Set(found)].join("; ")}. Trusted publishing uses OIDC and no token: remove it.`);
  process.exit(1);
}
console.log("check-no-npm-token: no npm token configured");
