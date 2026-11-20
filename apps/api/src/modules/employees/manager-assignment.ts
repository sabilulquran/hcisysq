// ORG-001: aturan penetapan atasan langsung (`employees.direct_manager_employee_id`).
//
// Berkas ini adalah satu-satunya tempat aturan itu ditulis. Jalur satuan
// (PATCH /admin/employees/:employeeId/manager) dan jalur massal
// (POST /admin/employees/manager-assignments/*) memanggil evaluator yang sama,
// jadi keduanya tidak dapat berbeda tanpa ada test yang merah.
//
// Aturan yang dijaga (ORG-001-B, EMP-005 S2B §8.7):
//   - pegawai tidak boleh menjadi atasan dirinya sendiri;
//   - atasan harus pegawai yang ada dan berstatus aktif;
//   - penetapan tidak boleh membentuk siklus pada reporting line;
//   - baris yang ditandai di luar pengelolaan HCIS tidak boleh ditulis dan
//     tidak boleh ditunjuk sebagai atasan.
//
// Pemeriksaan siklus dikerjakan di memori atas seluruh reporting line, bukan
// satu query rekursif per baris. Itu yang membuat satu berkas berisi A->B dan
// B->A tertangkap: siklus yang tidak dibentuk oleh baris mana pun sendirian.

import type { Pool, PoolClient } from "pg";

import { OUTSIDE_HCIS_CODE, OUTSIDE_HCIS_MESSAGE } from "./management-scope.js";

type Db = Pick<Pool, "query"> | PoolClient;

export interface EmployeeManagerFacts {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  managementScope: "MANAGED" | "OUTSIDE_HCIS";
  directManagerEmployeeId: string | null;
}

export const MANAGER_ASSIGNMENT_MESSAGES = {
  SELF_MANAGER_FORBIDDEN: "Pegawai tidak dapat menjadi atasan langsung dirinya sendiri.",
  EMPLOYEE_NOT_FOUND: "Pegawai tidak ditemukan.",
  MANAGER_NOT_FOUND: "NIP atasan tidak terdaftar pada master pegawai.",
  MANAGER_NOT_ACTIVE: "Atasan langsung harus merupakan pegawai aktif.",
  REPORTING_LINE_CYCLE: "Assignment ini akan membentuk siklus pada reporting line.",
  [OUTSIDE_HCIS_CODE]: OUTSIDE_HCIS_MESSAGE,
} as const;

export type ManagerAssignmentRefusalCode = keyof typeof MANAGER_ASSIGNMENT_MESSAGES;

export interface ManagerAssignmentEntry {
  /** Penanda baris milik pemanggil; dikembalikan apa adanya. */
  key: string;
  employeeId: string;
  managerEmployeeId: string | null;
}

export type ManagerAssignmentOutcome =
  | { status: "unchanged"; employee: EmployeeManagerFacts; manager: EmployeeManagerFacts | null }
  | {
      status: "change";
      employee: EmployeeManagerFacts;
      from: EmployeeManagerFacts | null;
      to: EmployeeManagerFacts | null;
    }
  | { status: "refused"; code: ManagerAssignmentRefusalCode; message: string };

function refuse(code: ManagerAssignmentRefusalCode): ManagerAssignmentOutcome {
  return { status: "refused", code, message: MANAGER_ASSIGNMENT_MESSAGES[code] };
}

/**
 * Menilai satu atau banyak penetapan sekaligus terhadap keadaan data yang
 * diberikan. Murni: tidak menyentuh database, jadi preview dan apply menilai
 * dengan kode yang persis sama.
 *
 * `currentEdges` adalah reporting line yang berlaku saat ini untuk seluruh
 * pegawai (anak -> atasan). Semua baris yang lolos pemeriksaan dasar dipasang
 * lebih dulu, baru siklus dicari; dengan begitu A->B dan B->A dalam satu berkas
 * tertangkap meski masing-masing baris sah bila dikirim sendiri.
 *
 * Urutan pemeriksaan sengaja sama dengan jalur satuan sebelum ORG-001 massal
 * ada: diri sendiri, pegawai tidak ada, atasan tidak ada/tidak aktif, siklus,
 * lalu penanda di luar pengelolaan HCIS.
 */
export function evaluateManagerAssignments(
  entries: readonly ManagerAssignmentEntry[],
  facts: ReadonlyMap<string, EmployeeManagerFacts>,
  currentEdges: ReadonlyMap<string, string>,
): Map<string, ManagerAssignmentOutcome> {
  const outcomes = new Map<string, ManagerAssignmentOutcome>();
  const accepted: ManagerAssignmentEntry[] = [];

  for (const entry of entries) {
    if (entry.managerEmployeeId && entry.managerEmployeeId === entry.employeeId) {
      outcomes.set(entry.key, refuse("SELF_MANAGER_FORBIDDEN"));
      continue;
    }
    const employee = facts.get(entry.employeeId);
    if (!employee) {
      outcomes.set(entry.key, refuse("EMPLOYEE_NOT_FOUND"));
      continue;
    }
    const manager = entry.managerEmployeeId ? facts.get(entry.managerEmployeeId) : null;
    if (entry.managerEmployeeId && !manager) {
      outcomes.set(entry.key, refuse("MANAGER_NOT_FOUND"));
      continue;
    }
    if (manager && manager.status !== "active") {
      outcomes.set(entry.key, refuse("MANAGER_NOT_ACTIVE"));
      continue;
    }
    accepted.push(entry);
  }

  // Reporting line sesudah seluruh berkas diterapkan.
  const proposed = new Map(currentEdges);
  for (const entry of accepted) {
    if (entry.managerEmployeeId) proposed.set(entry.employeeId, entry.managerEmployeeId);
    else proposed.delete(entry.employeeId);
  }

  for (const entry of accepted) {
    const employee = facts.get(entry.employeeId)!;
    const manager = entry.managerEmployeeId ? facts.get(entry.managerEmployeeId)! : null;

    if (manager && reachesThroughReportingLine(proposed, manager.id, employee.id)) {
      outcomes.set(entry.key, refuse("REPORTING_LINE_CYCLE"));
      continue;
    }

    // EMP-005 S2B §8.7: baris yang ditandai hanya dapat dibaca, dan tidak boleh
    // ditunjuk sebagai atasan siapa pun.
    if (employee.managementScope === "OUTSIDE_HCIS" || manager?.managementScope === "OUTSIDE_HCIS") {
      outcomes.set(entry.key, refuse(OUTSIDE_HCIS_CODE));
      continue;
    }

    if (employee.directManagerEmployeeId === (manager?.id ?? null)) {
      outcomes.set(entry.key, { status: "unchanged", employee, manager });
      continue;
    }

    const from = employee.directManagerEmployeeId
      ? facts.get(employee.directManagerEmployeeId) ?? null
      : null;
    outcomes.set(entry.key, { status: "change", employee, from, to: manager });
  }

  return outcomes;
}

/** Menelusuri ke atas dari `startId`; true bila `targetId` ada di jalurnya. */
function reachesThroughReportingLine(
  edges: ReadonlyMap<string, string>,
  startId: string,
  targetId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = startId;
  while (current) {
    if (current === targetId) return true;
    // Data lama yang sudah melingkar tidak boleh membuat penelusuran ini abadi.
    if (seen.has(current)) return false;
    seen.add(current);
    current = edges.get(current);
  }
  return false;
}

const FACT_COLUMNS = `
  id,
  employee_number AS "employeeNumber",
  full_name AS "fullName",
  status,
  management_scope AS "managementScope",
  direct_manager_employee_id AS "directManagerEmployeeId"
`;

export async function loadEmployeeManagerFactsByIds(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, EmployeeManagerFacts>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const result = await db.query<EmployeeManagerFacts>(
    `SELECT ${FACT_COLUMNS} FROM employees WHERE id = ANY($1::uuid[])`,
    [unique],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

/** Dikunci oleh pemanggil berarti: dibaca di dalam transaksi yang sudah memegang baris. */
export async function loadEmployeeManagerFactsByNumbers(
  db: Db,
  employeeNumbers: readonly string[],
): Promise<Map<string, EmployeeManagerFacts>> {
  const unique = [...new Set(employeeNumbers)];
  if (unique.length === 0) return new Map();
  const result = await db.query<EmployeeManagerFacts>(
    `SELECT ${FACT_COLUMNS} FROM employees WHERE employee_number = ANY($1::text[])`,
    [unique],
  );
  return new Map(result.rows.map((row) => [row.employeeNumber, row]));
}

/**
 * Seluruh reporting line yang berlaku (anak -> atasan). Satu query untuk
 * berapa pun baris yang dinilai; tanpa ini pemeriksaan siklus akan menjadi satu
 * query rekursif per baris.
 */
export async function loadReportingLineEdges(db: Db): Promise<Map<string, string>> {
  const result = await db.query<{ id: string; directManagerEmployeeId: string }>(
    `SELECT id, direct_manager_employee_id AS "directManagerEmployeeId"
       FROM employees
      WHERE direct_manager_employee_id IS NOT NULL`,
  );
  return new Map(result.rows.map((row) => [row.id, row.directManagerEmployeeId]));
}
