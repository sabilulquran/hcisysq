// PAY-003-MIG initial load of payroll reference data (docs/domain/payroll-initial-data-load.md).
// Dry-run unless --apply is given; the plan always runs in a READ ONLY transaction.
// Prints counts, codes, policy keys and the file's own row identifiers only:
// never a name, NIP, amount or account number, not even in an error.
// Production use: docs/development/mi8vps-hcis-release.md §4.11.
//
//   npm --workspace @hcis/api run payroll:initial-load -- --file <input.json>
//       [--actor-account <uuid>] [--apply]

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { loadConfig } from "../../../config/env.js";
import { createPool } from "../../../db/pool.js";
import {
  InitialLoadPartial,
  InitialLoadRefused,
  parseInitialLoadFile,
  planHasErrors,
  runInitialLoad,
} from "../initial-load.js";

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

async function readInput(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    // Node's own message quotes the text around the fault, which can be a NIP,
    // a name or an account number.
    throw new Error("Berkas masukan bukan JSON yang valid.");
  }
}

const args = parseArgs(process.argv.slice(2));
const file = parseInitialLoadFile(await readInput(args.file));
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
  process.exitCode = 1;
  if (error instanceof InitialLoadRefused) {
    console.log(JSON.stringify(error.report, null, 2));
    console.error(error.message);
  } else if (error instanceof InitialLoadPartial) {
    console.log(JSON.stringify(error.report, null, 2));
    console.error(`${error.message} (SQLSTATE ${error.errorCode})`);
  } else {
    // A database error's detail can quote a whole row; print only what identifies it.
    const { code, constraint } = error as { code?: string; constraint?: string };
    console.error(
      code
        ? `Galat basis data ${code}${constraint ? ` pada ${constraint}` : ""}.`
        : error instanceof Error
          ? error.message
          : "Galat tidak dikenal.",
    );
  }
} finally {
  await pool.end();
}
