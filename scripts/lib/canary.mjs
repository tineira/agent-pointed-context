// The canary matcher behind scripts/canary.mjs: which of the person's MRR values appear in a sandbox's event log.

/** The mrr column (third) of mrr-by-customer.csv, header skipped, as distinct strings in file order. */
export function mrrValues(csv) {
  const values = new Set();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const value = line.split(",")[2]?.trim();
    if (value) values.add(value);
  }
  return [...values];
}

/** How one value may be written: as is, with a thousands separator, and without ".00". */
export function spellings(value) {
  const [int, dec] = value.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = new Set([value, dec === undefined ? grouped : `${grouped}.${dec}`]);
  if (dec !== undefined && /^0+$/.test(dec)) out.add(int).add(grouped);
  return [...out];
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether the text holds the spelling as a whole number: no digit (or digit
 * group) runs on either side, so "40.12" does not match inside "08:40.123Z".
 */
function holds(text, spelling) {
  return new RegExp(`(?<!\\d|\\d[.,])${escape(spelling)}(?!\\d|[.,]\\d)`).test(text);
}

/** The values found anywhere in the raw log text, plus what the log holds: inbound events and their args bytes. */
export function canary(log, csv) {
  const values = mrrValues(csv);
  const found = values.filter((value) => spellings(value).some((s) => holds(log, s)));
  let inbound = 0;
  let argsBytes = 0;
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "inbound") continue;
    inbound += 1;
    argsBytes += new TextEncoder().encode(JSON.stringify(event.args ?? null)).length;
  }
  return { values: values.length, found, inbound, args_bytes: argsBytes };
}
