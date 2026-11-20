// ORG-001: dry-run dan penerapan penetapan atasan langsung secara massal.
//
// Dry-run wajib dan terpisah dari penerapan. Penerapan menilai ulang seluruh
// berkas di dalam transaksi yang sudah mengunci baris pegawai yang disebut,
// lalu membandingkan token preview; bila data sudah bergeser di bawah preview,
// penerapan ditolak seluruhnya, bukan diam-diam mengerjakan sesuatu yang lain.
//
// Tidak ada penerapan sebagian: satu baris tidak sah menolak seluruh berkas.

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  evaluateManagerAssignments,
  loadEmployeeManagerFactsByIds,
  loadEmployeeManagerFactsByNumbers,
  loadReportingLineEdges,
  MANAGER_ASSIGNMENT_MESSAGES,
  type EmployeeManagerFacts,
  type ManagerAssignmentEntry,
} from "../manager-assignment.js";
import type { ManagerAssignmentSourceRow } from "../infrastructure/parse-manager-assignment-csv.js";
import { resolveChartManagers } from "./manager-assignment-chart.js";

type Db = Pick<Pool, "query"> | PoolClient;

export interface ManagerAssignmentPersonRef {
  employeeNumber: string;
  fullName: string;
}

export type ManagerAssignmentRowOutcome = "unchanged" | "change" | "refused";

export interface ManagerAssignmentPreviewRow {
  rowNumber: number;
  employeeNumber: string;
  employeeName: string | null;
  managerNumber: string | null;
  outcome: ManagerAssignmentRowOutcome;
  fromManager: ManagerAssignmentPersonRef | null;
  toManager: ManagerAssignmentPersonRef | null;
  code: string | null;
  message: string | null;
  /**
   * ORG-004: atasan menurut bagan organisasi terbit. **Usulan, bukan keputusan** —
   * ia tidak pernah diterapkan sendiri, tidak masuk token, dan hanya dihitung
   * saat dry-run. HC tetap harus menuliskannya di berkas agar berlaku.
   */
  chartManager: ManagerAssignmentPersonRef | null;
  /** Dari mana resolver ORG-004 mendapatkannya; null bila tidak dapat ditentukan. */
  chartSource: string | null;
  /** Kode alasan saat bagan tidak dapat menentukan atasan; null bila berhasil. */
  chartIssue: string | null;
  /**
   * true bila atasan tujuan baris ini sama dengan kata bagan, false bila berbeda,
   * null bila tidak dapat dibandingkan (bagan tidak menjawab, atau baris ditolak
   * sebelum punya tujuan).
   */
  chartAgrees: boolean | null;
}

export interface ManagerAssignmentPreview {
  previewToken: string;
  rowCount: number;
  unchangedCount: number;
  changeCount: number;
  /**
   * Bagian dari `changeCount` yang akan menghapus atasan (sel `-`), dihitung
   * tersendiri supaya kecelakaan find/replace yang mengisi seluruh kolom atasan
   * dengan `-` terbaca dari ringkasan, bukan hanya dari tabelnya.
   */
  clearCount: number;
  /**
   * Baris yang tujuannya berbeda dari kata bagan organisasi terbit. Informasi
   * paling berharga di layar ini: di sinilah berkas HC dan ORG-004 berselisih.
   */
  differsFromChartCount: number;
  /** Baris yang bagannya punya usulan sementara berkasnya belum menyebut atasan. */
  chartSuggestionCount: number;
  refusedCount: number;
  /** true bila tidak ada baris yang ditolak; hanya preview begini yang boleh diterapkan. */
  applicable: boolean;
  rows: ManagerAssignmentPreviewRow[];
}

export interface ManagerAssignmentApplyResult {
  batchId: string;
  previewToken: string;
  rowCount: number;
  appliedCount: number;
  unchangedCount: number;
}

export class ManagerAssignmentBatchError extends Error {
  constructor(
    readonly code: "MANAGER_ASSIGNMENT_BATCH_INVALID" | "MANAGER_ASSIGNMENT_PREVIEW_STALE",
    message: string,
    readonly preview: ManagerAssignmentPreview,
  ) {
    super(message);
    this.name = "ManagerAssignmentBatchError";
  }
}

function personRef(facts: EmployeeManagerFacts): ManagerAssignmentPersonRef {
  return { employeeNumber: facts.employeeNumber, fullName: facts.fullName };
}

/**
 * Token preview: sidik jari dari isi berkas ditambah keadaan setiap pegawai yang
 * disebut berkas itu (id, status, penanda pengelolaan, atasan saat ini). Berubah
 * salah satunya, token tidak lagi cocok dan penerapan ditolak.
 *
 * Reporting line pegawai lain sengaja tidak masuk token: perubahan atasan orang
 * yang tidak disebut berkas ini tidak membatalkan preview HC.
 *
 * Batasnya harus dinyatakan apa adanya. Penerapan memang menilai ulang seluruh
 * aturan di dalam transaksi, tetapi reporting line dibaca **tanpa kunci**;
 * `FOR UPDATE` hanya memegang baris pegawai yang disebut berkas. Penilaian ulang
 * itu menutup jendela sampai pembacaannya sendiri, bukan sampai commit. Penulisan
 * bersamaan atas pegawai di luar berkas — termasuk dari jalur satuan, yang tidak
 * memegang kunci apa pun dan karenanya dapat meng-commit keputusan basi sesudah
 * kita membaca — masih dapat membentuk siklus yang tidak terlihat oleh keduanya.
 * Menutupnya menuntut kunci atas seluruh reporting line atau satu kunci penasihat
 * untuk setiap penulisan atasan, dan itu keputusan tersendiri, bukan sesuatu yang
 * boleh disiratkan sudah beres di sini.
 */
function previewToken(
  sourceRows: readonly ManagerAssignmentSourceRow[],
  facts: ReadonlyMap<string, EmployeeManagerFacts>,
): string {
  const numbers = [...new Set(
    sourceRows.flatMap((row) => [row.employeeNumber, row.managerNumber ?? ""]).filter(Boolean),
  )].sort();

  const material = JSON.stringify({
    v: 1,
    rows: sourceRows.map((row) => [row.rowNumber, row.employeeNumber, row.managerNumber]),
    state: numbers.map((number) => {
      const person = facts.get(number);
      return person
        ? [number, person.id, person.status, person.managementScope, person.directManagerEmployeeId]
        : [number, null];
    }),
  });

  return createHash("sha256").update(material).digest("hex");
}

export async function buildManagerAssignmentPreview(
  db: Db,
  sourceRows: readonly ManagerAssignmentSourceRow[],
  // ORG-004: usulan dari bagan hanya dihitung untuk dry-run. Penerapan memanggil
  // fungsi yang sama tanpa ini, supaya resolver tidak pernah dijalankan di dalam
  // transaksi tulis dan supaya hasilnya tidak dapat memengaruhi token.
  options: { withChartSuggestions?: boolean } = {},
): Promise<ManagerAssignmentPreview> {
  const numbers = sourceRows
    .flatMap((row) => [row.employeeNumber, row.managerNumber])
    .filter((value): value is string => Boolean(value));

  const [factsByNumber, currentEdges] = await Promise.all([
    loadEmployeeManagerFactsByNumbers(db, numbers),
    loadReportingLineEdges(db),
  ]);
  const factsById = new Map([...factsByNumber.values()].map((person) => [person.id, person]));

  // Atasan lama belum tentu disebut berkas, padahal preview harus menyebut nama
  // atasan lama dan atasan baru. Satu query tambahan untuk seluruh berkas.
  const currentManagerIds = [...factsByNumber.values()]
    .map((person) => person.directManagerEmployeeId)
    .filter((id): id is string => Boolean(id) && !factsById.has(id!));
  for (const person of (await loadEmployeeManagerFactsByIds(db, currentManagerIds)).values()) {
    factsById.set(person.id, person);
  }

  const rows = new Map<number, ManagerAssignmentPreviewRow>();
  const entries: ManagerAssignmentEntry[] = [];

  for (const source of sourceRows) {
    const employee = source.employeeNumber ? factsByNumber.get(source.employeeNumber) : undefined;
    const base: ManagerAssignmentPreviewRow = {
      rowNumber: source.rowNumber,
      employeeNumber: source.employeeNumber,
      employeeName: employee?.fullName ?? null,
      managerNumber: source.managerNumber,
      outcome: "refused",
      fromManager: null,
      toManager: null,
      code: null,
      message: null,
      chartManager: null,
      chartSource: null,
      chartIssue: null,
      chartAgrees: null,
    };

    if (source.issue) {
      rows.set(source.rowNumber, { ...base, code: source.issue.code, message: source.issue.message });
      continue;
    }
    if (!employee) {
      rows.set(source.rowNumber, {
        ...base,
        code: "EMPLOYEE_NOT_FOUND",
        message: MANAGER_ASSIGNMENT_MESSAGES.EMPLOYEE_NOT_FOUND,
      });
      continue;
    }

    const manager = source.managerNumber ? factsByNumber.get(source.managerNumber) : null;
    if (source.managerNumber && !manager) {
      rows.set(source.rowNumber, {
        ...base,
        code: "MANAGER_NOT_FOUND",
        message: MANAGER_ASSIGNMENT_MESSAGES.MANAGER_NOT_FOUND,
      });
      continue;
    }

    rows.set(source.rowNumber, base);
    entries.push({
      key: String(source.rowNumber),
      employeeId: employee.id,
      managerEmployeeId: manager?.id ?? null,
    });
  }

  const outcomes = evaluateManagerAssignments(entries, factsById, currentEdges);
  for (const entry of entries) {
    const outcome = outcomes.get(entry.key)!;
    const row = rows.get(Number(entry.key))!;
    if (outcome.status === "refused") {
      rows.set(row.rowNumber, { ...row, outcome: "refused", code: outcome.code, message: outcome.message });
      continue;
    }
    if (outcome.status === "unchanged") {
      rows.set(row.rowNumber, {
        ...row,
        outcome: "unchanged",
        fromManager: outcome.manager ? personRef(outcome.manager) : null,
        toManager: outcome.manager ? personRef(outcome.manager) : null,
      });
      continue;
    }
    rows.set(row.rowNumber, {
      ...row,
      outcome: "change",
      fromManager: outcome.from ? personRef(outcome.from) : null,
      toManager: outcome.to ? personRef(outcome.to) : null,
    });
  }

  let ordered = sourceRows.map((source) => rows.get(source.rowNumber)!);

  if (options.withChartSuggestions) {
    ordered = await attachChartSuggestions(db, ordered, factsByNumber, factsById);
  }

  return {
    previewToken: previewToken(sourceRows, factsByNumber),
    rowCount: ordered.length,
    unchangedCount: ordered.filter((row) => row.outcome === "unchanged").length,
    changeCount: ordered.filter((row) => row.outcome === "change").length,
    clearCount: ordered.filter((row) => row.outcome === "change" && row.toManager === null).length,
    differsFromChartCount: ordered.filter((row) => row.chartAgrees === false).length,
    // Baris yang sel atasannya dibiarkan kosong — satu-satunya keadaan "berkas
    // belum menyebut siapa pun" — dan bagannya punya jawaban untuk disalin HC.
    // Sel `-` tidak termasuk: itu keputusan HC untuk mengosongkan, bukan
    // kekosongan yang perlu diisi.
    chartSuggestionCount: ordered.filter(
      (row) => row.chartManager !== null && row.code === "MANAGER_NUMBER_REQUIRED",
    ).length,
    refusedCount: ordered.filter((row) => row.outcome === "refused").length,
    applicable: ordered.length > 0 && ordered.every((row) => row.outcome !== "refused"),
    rows: ordered,
  };
}

/**
 * ORG-004: menempelkan atasan menurut bagan terbit pada setiap baris, dan
 * menandai di mana berkas HC berbeda dari bagan.
 *
 * Usulan ini tidak mengubah outcome satu baris pun dan tidak masuk token: baris
 * yang berkasnya tidak menyebut atasan tetap ditolak seperti sebelumnya. Yang
 * ditambahkan hanyalah apa yang dapat dibaca HC sebelum ia menuliskannya sendiri.
 */
async function attachChartSuggestions(
  db: Db,
  rows: readonly ManagerAssignmentPreviewRow[],
  factsByNumber: ReadonlyMap<string, EmployeeManagerFacts>,
  factsById: Map<string, EmployeeManagerFacts>,
): Promise<ManagerAssignmentPreviewRow[]> {
  const subjects = [...new Set(rows.map((row) => row.employeeNumber))]
    .map((number) => factsByNumber.get(number))
    .filter((person): person is EmployeeManagerFacts => Boolean(person));
  if (subjects.length === 0) return [...rows];

  const suggestions = await resolveChartManagers(db, subjects);

  // Atasan usulan belum tentu disebut berkas; pratinjau berbicara dalam NIP,
  // jadi yang belum dikenal dinamai dari master pegawai sekali untuk semua.
  const unknown = [...suggestions.values()]
    .map((item) => item.managerEmployeeId)
    .filter((id): id is string => Boolean(id) && !factsById.has(id!));
  for (const person of (await loadEmployeeManagerFactsByIds(db, unknown)).values()) {
    factsById.set(person.id, person);
  }

  return rows.map((row) => {
    const employee = factsByNumber.get(row.employeeNumber);
    const suggestion = employee ? suggestions.get(employee.id) : undefined;
    if (!suggestion) return row;

    const chartPerson = suggestion.managerEmployeeId ? factsById.get(suggestion.managerEmployeeId) ?? null : null;
    const chartManager = chartPerson ? personRef(chartPerson) : null;
    // Dibandingkan hanya bila ada dua hal untuk dibandingkan. Baris yang ditolak
    // sebelum punya tujuan, dan bagan yang tidak menjawab, keduanya null.
    const comparable = suggestion.managerEmployeeId !== null
      && (row.outcome === "change" || row.outcome === "unchanged");
    const target = row.toManager ? factsByNumber.get(row.toManager.employeeNumber)?.id ?? null : null;

    return {
      ...row,
      chartManager,
      chartSource: suggestion.source,
      chartIssue: suggestion.issue,
      chartAgrees: comparable ? target === suggestion.managerEmployeeId : null,
    };
  });
}

export async function applyManagerAssignments(
  pool: Pool,
  input: {
    actorAccountId: string;
    sourceRows: readonly ManagerAssignmentSourceRow[];
    previewToken: string;
    sourceFilename: string;
    checksumSha256: string;
  },
): Promise<ManagerAssignmentApplyResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Baris pegawai yang disebut berkas dikunci lebih dulu, dalam urutan id yang
    // tetap, supaya penilaian ulang membaca keadaan yang tidak lagi bergerak.
    const numbers = [...new Set(
      input.sourceRows
        .flatMap((row) => [row.employeeNumber, row.managerNumber])
        .filter((value): value is string => Boolean(value)),
    )];
    if (numbers.length > 0) {
      await client.query(
        `SELECT id FROM employees WHERE employee_number = ANY($1::text[]) ORDER BY id FOR UPDATE`,
        [numbers],
      );
    }

    const preview = await buildManagerAssignmentPreview(client, input.sourceRows);

    // Token diperiksa lebih dulu. Berkas yang ditukar antara dry-run dan
    // konfirmasi juga membuat token tidak cocok; menilai `applicable` duluan
    // akan menjawab "ada baris yang ditolak" padahal yang sebenarnya terjadi
    // adalah preview-nya sudah tidak berlaku atas berkas ini.
    if (preview.previewToken !== input.previewToken) {
      await client.query("ROLLBACK");
      throw new ManagerAssignmentBatchError(
        "MANAGER_ASSIGNMENT_PREVIEW_STALE",
        "Berkas atau data pegawai sudah berbeda dari dry-run yang dikonfirmasi. Jalankan dry-run lagi lalu periksa hasilnya.",
        preview,
      );
    }
    if (!preview.applicable) {
      await client.query("ROLLBACK");
      throw new ManagerAssignmentBatchError(
        "MANAGER_ASSIGNMENT_BATCH_INVALID",
        "Berkas masih memuat baris yang ditolak, jadi tidak ada satu pun perubahan yang diterapkan.",
        preview,
      );
    }

    const batchId = randomUUID();
    const changes = preview.rows.filter((row) => row.outcome === "change");

    if (changes.length > 0) {
      const facts = await loadEmployeeManagerFactsByNumbers(
        client,
        changes.flatMap((row) => [row.employeeNumber, row.managerNumber ?? ""]).filter(Boolean),
      );
      const employeeIds = changes.map((row) => facts.get(row.employeeNumber)!.id);
      const managerIds = changes.map((row) =>
        row.toManager ? facts.get(row.toManager.employeeNumber)!.id : null,
      );
      const previousManagerIds = changes.map(
        (row) => facts.get(row.employeeNumber)!.directManagerEmployeeId,
      );

      // Satu pernyataan untuk seluruh berkas, bukan satu query per baris.
      await client.query(
        `UPDATE employees AS e
            SET direct_manager_employee_id = v.manager_id, updated_at = now()
           FROM unnest($1::uuid[], $2::uuid[]) AS v(employee_id, manager_id)
          WHERE e.id = v.employee_id`,
        [employeeIds, managerIds],
      );

      // ORG-001 audit: satu peristiwa `employee.manager.updated` per pegawai,
      // dengan atasan lama dan atasan baru, persis seperti jalur satuan.
      await client.query(
        `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
         SELECT v.event_id, $2, 'employee.manager.updated', 'employee', v.employee_id, v.payload
           FROM unnest($1::uuid[], $3::uuid[], $4::jsonb[]) AS v(event_id, employee_id, payload)`,
        [
          changes.map(() => randomUUID()),
          input.actorAccountId,
          employeeIds,
          changes.map((row, index) =>
            JSON.stringify({
              managerEmployeeId: managerIds[index],
              previousManagerEmployeeId: previousManagerIds[index],
              source: "BULK_CSV",
              batchId,
            }),
          ),
        ],
      );
    }

    await client.query(
      `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
       VALUES ($1, $2, 'employee.manager.batch_applied', 'employee_manager_batch', $3, $4::jsonb)`,
      [
        randomUUID(),
        input.actorAccountId,
        batchId,
        JSON.stringify({
          previewToken: preview.previewToken,
          sourceFilename: input.sourceFilename,
          checksumSha256: input.checksumSha256,
          rowCount: preview.rowCount,
          appliedCount: changes.length,
          unchangedCount: preview.unchangedCount,
          appliedEmployeeNumbers: changes.map((row) => row.employeeNumber),
        }),
      ],
    );

    await client.query("COMMIT");
    return {
      batchId,
      previewToken: preview.previewToken,
      rowCount: preview.rowCount,
      appliedCount: changes.length,
      unchangedCount: preview.unchangedCount,
    };
  } catch (error) {
    if (!(error instanceof ManagerAssignmentBatchError)) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}
