// EMP-005 baseline CLI (spec §8.2). Dry-run unless --apply is given.
// Prints counts and issue codes only: no names, NIP, or other personal data.
// Production use requires explicit owner approval (OPS-MI8-REL-001 runbook).
//
//   npm --workspace @hcis/api run employment:baseline -- [--apply] [--cutoff YYYY-MM-DD]
//       [--employee <uuid> ...] [--rerun]
//
// Baseline category correction (spec §8.2, "Koreksi kategori baseline"): keeps the
// employment and its id, changes only the baseline term's category.
//
//   npm --workspace @hcis/api run employment:baseline -- --reclassify <CATEGORY>
//       --reason "<why>" --employee <uuid> ... [--actor-account <uuid>] [--apply]

import { loadConfig } from "../../../config/env.js";
import { createPool } from "../../../db/pool.js";
import { EMPLOYMENT_CATEGORIES, isIsoDate, type EmploymentCategory } from "../domain/index.js";
import { jakartaToday } from "../infrastructure/postgres-employment-store.js";
import { reclassifyBaseline, runEmploymentBaseline } from "../application/baseline-service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]) {
  const employeeIds: string[] = [];
  let apply = false;
  let rerun = false;
  let cutoff = jakartaToday();
  let reclassify: string | null = null;
  let reason: string | null = null;
  let actorAccountId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--rerun") rerun = true;
    else if (arg === "--cutoff") cutoff = argv[++index] ?? "";
    else if (arg === "--employee") employeeIds.push(argv[++index] ?? "");
    else if (arg === "--reclassify") reclassify = argv[++index] ?? "";
    else if (arg === "--reason") reason = argv[++index] ?? "";
    else if (arg === "--actor-account") actorAccountId = argv[++index] ?? "";
    else throw new Error(`Argumen tidak dikenal: ${arg}`);
  }
  if (!isIsoDate(cutoff)) throw new Error("--cutoff harus berformat YYYY-MM-DD.");
  if (employeeIds.some((id) => !UUID.test(id))) throw new Error("--employee harus berupa UUID pegawai.");
  if (actorAccountId !== null && !UUID.test(actorAccountId)) throw new Error("--actor-account harus berupa UUID akun.");
  if (rerun && employeeIds.length === 0) throw new Error("--rerun membutuhkan minimal satu --employee.");
  if (reclassify !== null) {
    if (rerun) throw new Error("--reclassify tidak dapat digabung dengan --rerun.");
    if (!(EMPLOYMENT_CATEGORIES as readonly string[]).includes(reclassify)) {
      throw new Error(`--reclassify harus salah satu dari ${EMPLOYMENT_CATEGORIES.join(", ")}.`);
    }
    if (employeeIds.length === 0) throw new Error("--reclassify membutuhkan minimal satu --employee.");
    if (!reason) throw new Error("--reclassify membutuhkan --reason.");
  }
  return {
    apply,
    rerun,
    cutoff,
    employeeIds,
    reclassify: reclassify as EmploymentCategory | null,
    reason: reason ?? "",
    actorAccountId,
  };
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

try {
  const summary = args.reclassify
    ? await reclassifyBaseline(pool, {
        apply: args.apply,
        employeeIds: args.employeeIds,
        category: args.reclassify,
        reason: args.reason,
        actorAccountId: args.actorAccountId,
      })
    : await runEmploymentBaseline(pool, {
        apply: args.apply,
        rerun: args.rerun,
        cutoff: args.cutoff,
        ...(args.employeeIds.length ? { employeeIds: args.employeeIds } : {}),
      });
  console.log(JSON.stringify(summary, null, 2));
  if (!args.apply) console.log("Dry-run: tidak ada data yang ditulis. Tambahkan --apply untuk menyimpan.");
} finally {
  await pool.end();
}
