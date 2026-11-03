// Writes skills/pulse-agent/SKILL.md from the one source of the manual: apcGuide() in
// packages/server/src/prompts.ts with Pulse's part in apps/demo/src/worker/guide.ts. The MCP
// prompt `guide` serves the same text. apps/demo/test/guide.test.ts fails when they drift.
// usage: node scripts/build-skill.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apcGuide } from "../packages/server/src/prompts.ts";
import { PULSE_GUIDE, SKILL_FRONT_MATTER } from "../apps/demo/src/worker/guide.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "skills", "pulse-agent", "SKILL.md");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${SKILL_FRONT_MATTER}\n${apcGuide(PULSE_GUIDE)}`);
console.log(`wrote ${file}`);
