import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { activeCustomers, customerBridge, FIGURE_KEYS, FIGURES, FULL_SCOPE } from "../src/model/figures.ts";
import { generateDataset, MONTHS, REGIONS } from "../src/model/seed.ts";
import { figureAnswer, type Grant } from "../src/worker/domain.ts";

const data = generateDataset(42);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const owner: Grant = { id: "g_full", secret: "s", label: "Your agent", client_name: null, regions: null, created_at: "", last_active_at: null };

test("the data is deterministic from the seed", () => {
  assert.deepEqual(generateDataset(42), data);
  assert.notDeepEqual(generateDataset(43).customers, data.customers);
  assert.equal(data.customers.length, 200);
});

test("the bridge adds up in every month and region: start + new + reactivated - churned = end = active", () => {
  for (const month of MONTHS) {
    for (const region of [undefined, ...REGIONS]) {
      const args = { month, ...(region ? { region } : {}) };
      const { values } = customerBridge(data, args, FULL_SCOPE);
      assert.equal(values.start! + values.new! + values.reactivated! - values.churned!, values.end!, `${month} ${region ?? "all"}`);
      assert.equal(values.end, activeCustomers(data, args, FULL_SCOPE).values.active, `${month} ${region ?? "all"}`);
    }
  }
});

/**
 * C4, the guarantee the paper states: for the same data, parameters and scope,
 * get_figure returns the number the page draws. The page calls the model
 * functions; the server answers through the registry. Every key, every month.
 */
test("get_figure equals the page's own computation, for every figure key and month", () => {
  const page: Record<string, (month: string) => unknown> = {
    active_customers: (month) => activeCustomers(data, { month }, FULL_SCOPE),
    customer_bridge: (month) => customerBridge(data, { month }, FULL_SCOPE),
  };
  assert.deepEqual(Object.keys(page).sort(), [...FIGURE_KEYS].sort(), "every registered figure has a page computation in this test");
  for (const key of FIGURE_KEYS) {
    for (const month of MONTHS) {
      const answer = figureAnswer(data, owner, key, { month }, "https://demo.example");
      assert.ok(!("error" in answer), `${key} ${month}`);
      const drawn = page[key]!(month) as { values: unknown; breakdown: unknown; inputs: unknown };
      assert.deepEqual(answer.values, drawn.values, `${key} ${month} values`);
      assert.deepEqual(answer.breakdown, drawn.breakdown, `${key} ${month} breakdown`);
      assert.deepEqual(answer.inputs, drawn.inputs, `${key} ${month} inputs`);
    }
  }
});

async function sources(dir: string): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    out.push({ file, text: await readFile(file, "utf8") });
  }
  return out;
}

/**
 * Registry completeness, both ways (the static test the paper describes):
 * every figure key the page marks pointable is registered, and every
 * registered key is pointable somewhere on the page.
 */
test("every figure the page marks is registered, and every registered figure is marked", async () => {
  const used = new Set<string>();
  for (const { text } of await sources(path.join(root, "src/web"))) {
    for (const m of text.matchAll(/figureFocus\(\s*"([a-z_0-9]+)"/g)) used.add(m[1]!);
  }
  const registered = new Set(Object.keys(FIGURES));
  assert.deepEqual([...used].filter((k) => !registered.has(k)), [], "marked but not registered");
  assert.deepEqual([...registered].filter((k) => !used.has(k)), [], "registered but never marked");
  assert.equal(/data-focus["']?\s*[:=]/.test((await sources(path.join(root, "src/web"))).map((s) => s.text).join("\n")), false, "the page marks targets only through figureFocus / customerFocus");
});

test("bridge parts are the five steps, and a part names its slice of the breakdown", () => {
  const spec = FIGURES.customer_bridge;
  assert.ok(spec.partOk("step:churned"));
  assert.equal(spec.partOk("step:refunds"), false);
  assert.deepEqual(spec.nextParams({ month: "2026-03" }, "step:new"), { month: "2026-03", step: "new" });
  const slice = customerBridge(data, { month: "2026-03", step: "new" }, FULL_SCOPE);
  assert.deepEqual(Object.keys(slice.breakdown), ["new"]);
  assert.equal(slice.inputs.customers.length, slice.values.new);
});
