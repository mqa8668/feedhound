// Bun run --cwd apps/agent rollup:backfill --from <iso> --to <iso>
// Runs the hourly rollup sequentially for every full hour in [from, to).
import { createDb } from "@feedhound/db";
import { floorToHour, runRollup } from "../src/jobs/rollup";

const HOUR_MS = 3_600_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const from = arg("from");
const to = arg("to");
if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
  console.error("usage: rollup:backfill --from <iso> --to <iso>");
  process.exit(2);
}

const handle = createDb();
try {
  const end = floorToHour(new Date(to)).getTime();
  let n = 0;
  let errors = 0;
  for (let t = floorToHour(new Date(from)).getTime(); t < end; t += HOUR_MS) {
    errors += (await runRollup(handle, { hourTs: new Date(t) })).errors;
    n++;
  }
  console.log(`rolled up ${n} hours, ${errors} team failures`);
  if (errors > 0) process.exitCode = 1;
} finally {
  await handle.close();
}
