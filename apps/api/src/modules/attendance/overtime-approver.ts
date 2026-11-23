import type { Pool, PoolClient } from "pg";

import {
  OrganizationAuthorityResolver,
  OrganizationResolutionError,
  OrganizationRolloutService,
  PostgresOrganizationRepository,
} from "../organization/index.js";
import type { OrganizationWorkflowKey } from "../organization/workflow-keys.js";
import { legibleAuthorityError } from "../leave/organization-authority.js";

const OVERTIME_WORKFLOW_KEY: OrganizationWorkflowKey = "OVERTIME";

// ATT-011-6b-1 §7.3: who is an employee's direct supervisor for overtime. The same resolver as leave
// (APR-001) with one DIRECT_MANAGER step: ORG-002 data while the OVERTIME workflow is LEGACY, the
// ORG-004 structure when it is STRUCTURE. The result is snapshotted on the request; a later structure
// change never moves it. No silent fallback to HC and no self-approval.

type Db = Pool | PoolClient;

export class OvertimeApproverError extends Error {
  /**
   * ORG-004 D-R5: `code` bukan lagi satu nilai. Galat resolver diteruskan apa adanya — terutama
   * `APPROVER_ACCOUNT_NOT_READY`, yang berarti akun atasannya belum aktif, bukan bagannya kurang.
   * `OVERTIME_APPROVER_UNRESOLVED` tetap kode untuk keadaan yang memang "atasannya belum tercatat".
   */
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type OvertimeApprover = {
  supervisorEmployeeId: string;
  snapshot: { mode: string; authoritativeSource: string; source: string; path: string[]; incumbentKind: string; shadow?: unknown };
};

const UNRESOLVED = "Atasan Anda belum tercatat. Hubungi HC.";

export async function resolveOvertimeApprover(db: Db, employeeId: string, workDate: string): Promise<OvertimeApprover> {
  const legacy = await db.query<{ directManagerEmployeeId: string | null }>(
    `SELECT direct_manager_employee_id AS "directManagerEmployeeId" FROM employees WHERE id = $1`,
    [employeeId],
  );
  const repository = new PostgresOrganizationRepository(db);
  const rollout = new OrganizationRolloutService(repository, new OrganizationAuthorityResolver(repository));
  let result;
  try {
    result = await rollout.resolveAuthorities({
      workflowKey: OVERTIME_WORKFLOW_KEY,
      requesterEmployeeId: employeeId,
      effectiveDate: workDate,
      legacy: { directManagerEmployeeId: legacy.rows[0]?.directManagerEmployeeId ?? null, unitApproverEmployeeId: null },
      authorityRequirement: "LINE_AND_UNIT",
    });
  } catch (error) {
    // ORG-004 D-R5: dulu setiap galat resolver diganti "Atasan Anda belum tercatat. Hubungi HC."
    // Sejak kursi yang pejabatnya ada tetapi akunnya belum aktif menolak alih-alih dilewati, kalimat
    // itu menjadi keliru untuk keadaan yang paling sering terjadi: pegawainya disuruh membereskan
    // bagan padahal yang kurang adalah aktivasi akun atasannya. Jadi kode dan kalimat resolver
    // diteruskan apa adanya, dan kalimat lama hanya dipakai untuk galat yang tidak punya kalimat
    // sendiri untuk dibaca pegawai.
    if (error instanceof OrganizationResolutionError) {
      const legible = await legibleAuthorityError(db, error);
      // Kalimat yang tidak ditulis ulang masih berbahasa Inggris dan untuk operator, bukan untuk
      // pegawai, jadi untuk itu kalimat lama tetap dipakai.
      throw legible.message === error.message
        ? new OvertimeApproverError("OVERTIME_APPROVER_UNRESOLVED", UNRESOLVED)
        : new OvertimeApproverError(legible.code, legible.message);
    }
    throw error;
  }
  const sourcesOf = (authority: (typeof result.authorities)[number]) => authority.sources ?? [authority.source];
  // DRAFT: when the structure applies a governance approver instead of the line, that person decides.
  const authority = result.authorities.find((item) => sourcesOf(item).includes("DIRECT_MANAGER"))
    ?? result.authorities.find((item) => sourcesOf(item).includes("GOVERNANCE_APPROVER"));
  if (!authority?.employeeId || authority.employeeId === employeeId) throw new OvertimeApproverError("OVERTIME_APPROVER_UNRESOLVED", UNRESOLVED);
  // EMP-005 S2B §8.7: a supervisor outside HCIS management reads as not active.
  const active = await db.query(
    "SELECT 1 FROM employees WHERE id = $1 AND status = 'active' AND management_scope = 'MANAGED'",
    [authority.employeeId],
  );
  if (!active.rows[0]) throw new OvertimeApproverError("OVERTIME_APPROVER_UNRESOLVED", UNRESOLVED);
  return {
    supervisorEmployeeId: authority.employeeId,
    snapshot: {
      mode: result.mode,
      authoritativeSource: result.authoritativeSource,
      source: authority.source,
      path: authority.path,
      incumbentKind: authority.incumbentKind,
      // SHADOW: the legacy answer decides; the structural comparison is kept for review, as leave does.
      ...(result.shadow ? { shadow: result.shadow } : {}),
    },
  };
}
