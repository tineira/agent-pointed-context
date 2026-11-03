// Writes skills/pulse-agent/SKILL.md, the manual of V1 as published (the paper's demo at
// apc.tineira.com/v1), from the frozen copy in apps/v1 (TIN-604): apcGuide() in
// apps/v1/src/apc/server/prompts.ts with Pulse's part in apps/v1/src/worker/guide.ts. V1's MCP
// prompt `guide` serves the same text. apps/v1/test/guide.test.ts fails when they drift.
// usage: node scripts/build-skill.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apcGuide } from "../apps/v1/src/apc/server/prompts.ts";
import { PULSE_GUIDE, SKILL_FRONT_MATTER } from "../apps/v1/src/worker/guide.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "skills", "pulse-agent", "SKILL.md");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${SKILL_FRONT_MATTER}\n${apcGuide(PULSE_GUIDE)}`);
console.log(`wrote ${file}`);
