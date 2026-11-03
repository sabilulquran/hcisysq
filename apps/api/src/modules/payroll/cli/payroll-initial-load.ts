// PAY-003-MIG initial load of payroll reference data (docs/domain/payroll-initial-data-load.md).
// Dry-run unless --apply is given; the plan always runs in a READ ONLY transaction.
// Prints counts, codes, policy keys and the file's own row identifiers only:
// never a name, NIP, amount or account number.
// Production use: docs/development/mi8vps-hcis-release.md §4.11.
//
//   npm --workspace @hcis/api run payroll:initial-load -- --file <input.json>
//       [--actor-account <uuid>] [--apply]

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { loadConfig } from "../../../config/env.js";
import { createPool } from "../../../db/pool.js";
import { InitialLoadRefused, parseInitialLoadFile, planHasErrors, runInitialLoad } from "../initial-load.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]) {
  let file: string | null = null;
  let actorAccountId: string | null = null;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--file") file = argv[++index] ?? null;
    else if (arg === "--actor-account") actorAccountId = argv[++index] ?? null;
    else throw new Error(`Argumen tidak dikenal: ${arg}`);
  }
  if (!file) throw new Error("--file <berkas.json> wajib diisi.");
  if (!file.toLowerCase().endsWith(".json")) throw new Error("Berkas masukan harus .json.");
  if (actorAccountId !== null && !UUID.test(actorAccountId)) throw new Error("--actor-account harus berupa UUID akun.");
  return { file: resolve(file), actorAccountId, apply };
}

const args = parseArgs(process.argv.slice(2));
const raw: unknown = JSON.parse(await readFile(args.file, "utf8"));
const file = parseInitialLoadFile(raw);
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

try {
  const summary = await runInitialLoad(pool, {
    file,
    apply: args.apply,
    actorAccountId: args.actorAccountId,
    sourceName: basename(args.file),
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!args.apply) {
    console.log(
      planHasErrors(summary)
        ? "Dry-run: tidak ada data yang ditulis. Rencana memuat galat; --apply akan ditolak sampai galat diselesaikan."
        : "Dry-run: tidak ada data yang ditulis. Tambahkan --apply --actor-account <uuid> untuk menyimpan.",
    );
  }
} catch (error) {
  if (error instanceof InitialLoadRefused) {
    console.log(JSON.stringify(error.report, null, 2));
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
