// EMP-005 S5 projection refresh CLI (spec §8.4). Dry-run unless --apply.
// Prints counts only: no names, NIP, or other personal data. On Mi8VPS there is
// no cron or systemd, so the daily run is scheduled by sq-core-worker.sh
// (DRAFT: ops decision recorded in the implementation plan).
//
//   npm --workspace @hcis/api run employment:refresh-projection -- [--apply]
//       [--date YYYY-MM-DD] [--all] [--employee <uuid> ...]

import { loadConfig } from "../../../config/env.js";
import { createPool } from "../../../db/pool.js";
import { isIsoDate } from "../domain/index.js";
import { runProjectionRefresh } from "../application/projection-service.js";
import { jakartaToday } from "../infrastructure/postgres-employment-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]) {
  const employeeIds: string[] = [];
  let apply = false;
  let all = false;
  let date = jakartaToday();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--all") all = true;
    else if (arg === "--date") date = argv[++index] ?? "";
    else if (arg === "--employee") employeeIds.push(argv[++index] ?? "");
    else throw new Error(`Argumen tidak dikenal: ${arg}`);
  }
  if (!isIsoDate(date)) throw new Error("--date harus berformat YYYY-MM-DD.");
  if (employeeIds.some((id) => !UUID.test(id))) throw new Error("--employee harus berupa UUID pegawai.");
  return { apply, all, date, employeeIds };
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

try {
  const summary = await runProjectionRefresh(pool, {
    date: args.date,
    scope: args.all ? "all" : "due",
    apply: args.apply,
    ...(args.employeeIds.length ? { employeeIds: args.employeeIds } : {}),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.applied) process.stdout.write("Dry-run: tidak ada yang ditulis. Tambahkan --apply untuk menerapkan.\n");
} finally {
  await pool.end();
}
