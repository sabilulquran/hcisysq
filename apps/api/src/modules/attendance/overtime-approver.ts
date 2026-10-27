import type { Pool, PoolClient } from "pg";

import {
  OrganizationAuthorityResolver,
  OrganizationResolutionError,
  OrganizationRolloutService,
  PostgresOrganizationRepository,
} from "../organization/index.js";

// ATT-011-6b-1 §7.3: who is an employee's direct supervisor for overtime. The same resolver as leave
// (APR-001) with one DIRECT_MANAGER step: ORG-002 data while the OVERTIME workflow is LEGACY, the
// ORG-004 structure when it is STRUCTURE. The result is snapshotted on the request; a later structure
// change never moves it. No silent fallback to HC and no self-approval.

type Db = Pool | PoolClient;

export class OvertimeApproverError extends Error {
  constructor(readonly code: "OVERTIME_APPROVER_UNRESOLVED", message: string) {
    super(message);
  }
}

export type OvertimeApprover = {
  supervisorEmployeeId: string;
  snapshot: { mode: string; authoritativeSource: string; source: string; path: string[]; incumbentKind: string };
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
      workflowKey: "OVERTIME",
      requesterEmployeeId: employeeId,
      effectiveDate: workDate,
      legacy: { directManagerEmployeeId: legacy.rows[0]?.directManagerEmployeeId ?? null, unitApproverEmployeeId: null },
      authorityRequirement: "LINE_AND_UNIT",
    });
  } catch (error) {
    if (error instanceof OrganizationResolutionError) throw new OvertimeApproverError("OVERTIME_APPROVER_UNRESOLVED", UNRESOLVED);
    throw error;
  }
  const sourcesOf = (authority: (typeof result.authorities)[number]) => authority.sources ?? [authority.source];
  // DRAFT: when the structure applies a governance approver instead of the line, that person decides.
  const authority = result.authorities.find((item) => sourcesOf(item).includes("DIRECT_MANAGER"))
    ?? result.authorities.find((item) => sourcesOf(item).includes("GOVERNANCE_APPROVER"));
  if (!authority || authority.employeeId === employeeId) throw new OvertimeApproverError("OVERTIME_APPROVER_UNRESOLVED", UNRESOLVED);
  const active = await db.query("SELECT 1 FROM employees WHERE id = $1 AND status = 'active'", [authority.employeeId]);
  if (!active.rows[0]) throw new OvertimeApproverError("OVERTIME_APPROVER_UNRESOLVED", UNRESOLVED);
  return {
    supervisorEmployeeId: authority.employeeId,
    snapshot: {
      mode: result.mode,
      authoritativeSource: result.authoritativeSource,
      source: authority.source,
      path: authority.path,
      incumbentKind: authority.incumbentKind,
    },
  };
}
