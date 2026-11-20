// ORG-001 / ORG-004: usulan atasan yang dibaca dari bagan organisasi terbit.
//
// Koreksi 2026-11-20: kolom lama `direct_manager_employee_id` memang hampir
// kosong, tetapi bagan yang sudah terbit dapat menentukan atasan untuk hampir
// semua orang itu. Jadi jalur massal ini bukan tempat HC mengarang atasan dari
// nol; ia jalur cadangan mode LEGACY yang seharusnya memperlihatkan apa kata
// bagan lebih dulu.
//
// Resolusinya memakai resolver ORG-004 yang sudah ada lewat
// `buildOrganizationPeopleView` — tidak ada logika resolusi kedua di sini, dan
// tidak satu pun teks nama jabatan dibaca. Yang dikerjakan berkas ini hanyalah
// menerjemahkan hasil resolver ke bentuk yang dipakai pratinjau (NIP dan nama).
//
// Hasilnya **usulan**, bukan keputusan: ia tidak pernah ikut diterapkan, tidak
// masuk token pratinjau, dan tidak dihitung ulang saat penerapan.

import type { Pool, PoolClient } from "pg";

import {
  jakartaBusinessDate,
  PostgresOrganizationRepository,
  type OrganizationSnapshot,
} from "../../organization/index.js";
import {
  buildOrganizationPeopleView,
  RequestScopedEligibilityValidator,
  type OrganizationPersonEmployee,
} from "../../organization/read-model.js";
import type { EmployeeManagerFacts } from "../manager-assignment.js";

type Db = Pick<Pool, "query"> | PoolClient;

export interface ChartManagerSuggestion {
  /** Atasan menurut bagan terbit, atau null bila bagan tidak dapat menentukannya. */
  managerEmployeeId: string | null;
  /** Dari mana resolver mendapatkannya (OVERRIDE, ACTING, POSITION_PARENT, ...). */
  source: string | null;
  /** Kode alasan saat bagan tidak dapat menentukannya; null bila berhasil. */
  issue: string | null;
}

export const CHART_NO_STRUCTURE = "NO_PUBLISHED_STRUCTURE";

/**
 * Satu entri per pegawai yang diminta. Resolver dipanggil sekali per pegawai
 * dengan cache kelayakan satu permintaan — biaya yang sama dengan tab Pegawai
 * pada layar Struktur Organisasi, dan hanya dibayar oleh dry-run.
 */
export async function resolveChartManagers(
  db: Db,
  subjects: readonly EmployeeManagerFacts[],
  options: { asOf?: string } = {},
): Promise<Map<string, ChartManagerSuggestion>> {
  const suggestions = new Map<string, ChartManagerSuggestion>();
  if (subjects.length === 0) return suggestions;

  const asOf = options.asOf ?? jakartaBusinessDate();
  const repository = new PostgresOrganizationRepository(db);
  let snapshot: OrganizationSnapshot | null = null;
  try {
    snapshot = await repository.loadEffectiveSnapshot(asOf);
  } catch {
    snapshot = null;
  }

  if (!snapshot) {
    for (const subject of subjects) {
      suggestions.set(subject.id, { managerEmployeeId: null, source: null, issue: CHART_NO_STRUCTURE });
    }
    return suggestions;
  }

  // Hanya pegawai yang disebut berkas yang diresolusi. Nama atasan hasil
  // resolusi sengaja tidak diambil dari sini (pemanggil menamainya dari master
  // pegawai, karena pratinjau berbicara dalam NIP, bukan id).
  const employees: OrganizationPersonEmployee[] = subjects.map((subject) => ({
    id: subject.id,
    employeeNumber: subject.employeeNumber,
    fullName: subject.fullName,
    legacyUnitId: null,
    legacyUnitName: null,
    legacyDirectManagerEmployeeId: subject.directManagerEmployeeId,
    legacyDirectManagerName: null,
    legacyUnitApproverEmployeeId: null,
    legacyUnitApproverName: null,
  }));

  const rows = await buildOrganizationPeopleView({
    snapshot,
    employees,
    eligibility: new RequestScopedEligibilityValidator(repository),
    asOf,
  });

  for (const row of rows) {
    const issue = row.directManager
      ? null
      : row.issues.find((item) => item.scope === "DIRECT_MANAGER")?.code
        ?? row.issues.find((item) => item.scope === "MEMBERSHIP")?.code
        ?? "DIRECT_MANAGER_UNRESOLVED";
    suggestions.set(row.employeeId, {
      managerEmployeeId: row.directManager?.employeeId ?? null,
      source: row.source,
      issue,
    });
  }

  // Pegawai yang tidak terwakili sama sekali tetap mendapat jawaban.
  for (const subject of subjects) {
    if (!suggestions.has(subject.id)) {
      suggestions.set(subject.id, { managerEmployeeId: null, source: null, issue: "DIRECT_MANAGER_UNRESOLVED" });
    }
  }

  return suggestions;
}
