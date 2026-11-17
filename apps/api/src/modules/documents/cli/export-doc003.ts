// DOC-004 §4: one-way export of the DOC-003 book for the Sekretariat cutover
// (SQ-Hub SEK-IMPL-001 §14 langkah 8). Read-only; the shape is exactly the
// `eksporDoc003Schema` that the Sekretariat importer validates.
//
// Preview (nothing written, counts only):
//   npm --workspace @hcis/api run documents:export-doc003
// Write the file the operator carries to SQ Hub:
//   npm --workspace @hcis/api run documents:export-doc003 -- --out /tmp/doc003.json
//
// The only identity that leaves HCIS is `hcis:employee:<uuid>` (DOC-004 C-04):
// no names, NIP, e-mail, or letter contents.

import { writeFileSync } from "node:fs";

import { loadConfig } from "../../../config/env.js";
import { createPool } from "../../../db/pool.js";
import { buildEkspor, ringkasan, validateEkspor, type BarisDoc003 } from "../doc003-export.js";

function parseArgs(argv: string[]): { out: string | null } {
  let out: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") out = argv[++index] ?? "";
    else throw new Error(`Argumen tidak dikenal: ${arg}`);
  }
  if (out !== null && out.trim() === "") throw new Error("--out membutuhkan nama berkas.");
  return { out };
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

try {
  // Every query is ordered, so two runs of the same book produce the same bytes (DOC-004 §10).
  const types = await pool.query<BarisDoc003["types"][number]>(
    "SELECT code, label FROM letter_types ORDER BY code",
  );
  const issuers = await pool.query<BarisDoc003["issuers"][number]>(
    "SELECT code, name, kind FROM letter_issuers ORDER BY code",
  );
  const grants = await pool.query<BarisDoc003["grants"][number]>(
    `SELECT i.code AS issuer_code, g.employee_id, g.reason
       FROM letter_number_grants g
       JOIN letter_issuers i ON i.id = g.issuer_id
      WHERE g.revoked_at IS NULL
      ORDER BY i.code, g.employee_id`,
  );
  const counters = await pool.query<BarisDoc003["counters"][number]>(
    `SELECT i.code AS issuer_code, c.type_code, c.period_key, c.last_sequence
       FROM letter_number_counters c
       JOIN letter_issuers i ON i.id = c.issuer_id
      ORDER BY i.code, c.type_code, c.period_key`,
  );
  const numbers = await pool.query<BarisDoc003["numbers"][number]>(
    `SELECT n.id, i.code AS issuer_code, n.type_code, n.period_key, n.sequence, n.letter_number,
            to_char(n.letter_date, 'YYYY-MM-DD') AS letter_date, n.subject, n.recipient, n.status,
            n.void_reason, n.requested_by_employee_id
       FROM letter_numbers n
       JOIN letter_issuers i ON i.id = n.issuer_id
      ORDER BY i.code, n.type_code, n.period_key, n.sequence`,
  );

  const ekspor = buildEkspor({
    types: types.rows,
    issuers: issuers.rows,
    grants: grants.rows,
    counters: counters.rows,
    numbers: numbers.rows,
  });

  const problems = validateEkspor(ekspor);
  if (problems.length > 0) {
    console.error(`Ekspor dibatalkan, ${problems.length} masalah:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    const hitung = ringkasan(ekspor);
    console.log(`jenis            : ${hitung.jenis}`);
    console.log(`penerbit         : ${hitung.penerbit}`);
    console.log(`grant aktif      : ${hitung.grantAktif}`);
    console.log(`penghitung       : ${hitung.penghitung}`);
    console.log(`nomor terpakai   : ${hitung.nomorTerpakai}`);
    console.log(`nomor dibatalkan : ${hitung.nomorDibatalkan}`);
    console.log(`nomor seluruhnya : ${hitung.nomorSeluruhnya}`);
    console.log("urut tertinggi per penerbit, jenis, tahun:");
    for (const baris of hitung.urutTertinggi) console.log(`  ${baris.kunci} = ${baris.nilai}`);

    if (args.out === null) {
      console.log("\nPratinjau: berkas tidak ditulis. Tambahkan --out <berkas.json> untuk mengambil datanya.");
    } else {
      writeFileSync(args.out, `${JSON.stringify(ekspor, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      console.log(`\nBerkas ditulis: ${args.out}`);
    }
  }
} finally {
  await pool.end();
}
