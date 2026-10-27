// EMP-005 S5 compatibility projection (spec §8.4). The nine `employees` columns
// that import used to own are derived here from the resolved history, so legacy
// consumers keep reading the same shape. Pure: the store writes the result.

import type { EmploymentCategory, StaffType } from "./model.js";
import type { ResolvedEmployment } from "./resolver.js";

/**
 * Canonical master text per category (spec §4.2.1). An unclassified term writes
 * no text: inventing one would claim a classification nobody decided.
 */
export const CATEGORY_MASTER_TEXT: Readonly<Record<EmploymentCategory, string | null>> = {
  TETAP: "Pegawai Tetap",
  KONTRAK: "Pegawai Kontrak",
  KONTRAK_HONORER: "Pegawai Kontrak Honorer",
  MAGANG: "Magang",
  PERCOBAAN: "Masa Percobaan",
  LEPAS: "Pegawai Lepas",
  BELUM_DIKLASIFIKASIKAN: null,
};

export const STAFF_TYPE_MASTER_TEXT: Readonly<Record<StaffType, string>> = {
  PENDIDIK: "Tenaga Pendidik",
  KEPENDIDIKAN: "Tenaga Kependidikan",
};

/** Labels a placement row carries for the two legacy position columns. */
export interface PlacementLabels {
  functionalLabel: string | null;
  structuralLabel: string | null;
}

export interface EmployeeProjection {
  status: "active" | "inactive" | "resigned";
  employmentStatus: string | null;
  employmentType: string | null;
  organizationalUnitId: string | null;
  positionId: string | null;
  functionalPosition: string | null;
  structuralPosition: string | null;
  startedOn: string | null;
  endedOn: string | null;
}

/**
 * The nine columns for one employee, or null when history cannot speak for the
 * employee yet (no employment at all): import stays the writer in that case.
 */
export function projectEmployee(
  resolved: ResolvedEmployment,
  labels: PlacementLabels,
): EmployeeProjection | null {
  const { projection } = resolved;
  if (projection.status === null) return null;
  const staffType = resolved.employment?.staffType ?? null;
  return {
    status: projection.status,
    employmentStatus: projection.category ? CATEGORY_MASTER_TEXT[projection.category] : null,
    employmentType: staffType ? STAFF_TYPE_MASTER_TEXT[staffType] : null,
    organizationalUnitId: projection.legacyUnitId,
    positionId: projection.legacyPositionId,
    functionalPosition: labels.functionalLabel,
    structuralPosition: labels.structuralLabel,
    startedOn: projection.startedOn,
    endedOn: projection.endedOn,
  };
}

/** The fields EMP-004 import must leave alone once history is authoritative (§8.1). */
export const PROJECTED_IMPORT_FIELDS = [
  "status",
  "employmentStatus",
  "employmentType",
  "organizationalUnitId",
  "positionId",
  "functionalPosition",
  "structuralPosition",
  "startedOn",
  "endedOn",
] as const satisfies readonly (keyof EmployeeProjection)[];
