import type { Pool, PoolClient } from "pg";

import {
  OrganizationAuthorityResolver,
  OrganizationResolutionError,
  OrganizationRolloutService,
  PostgresOrganizationRepository,
} from "./index.js";

// The line manager who rates or assesses an employee for one workflow: the same resolver as
// APR-001 and overtime (ORG-002 data while the workflow is LEGACY, the ORG-004 structure when it
// is STRUCTURE). An unresolved manager is not an error: the caller stores the item without one and
// HC assigns it. Used by PERF-001 (D-01) and TRAIN-001 R3 (E-14).

export interface ResolvedLineManager {
  employeeId: string | null;
  source: "DIRECT_MANAGER" | "GOVERNANCE_APPROVER" | null;
  snapshot: Record<string, unknown>;
}

export async function resolveLineManager(
  db: Pool | PoolClient,
  input: { workflowKey: string; employeeId: string; effectiveDate: string },
): Promise<ResolvedLineManager> {
  const { workflowKey, employeeId, effectiveDate } = input;
  const legacy = await db.query<{ directManagerEmployeeId: string | null }>(
    `SELECT direct_manager_employee_id AS "directManagerEmployeeId" FROM employees WHERE id = $1`,
    [employeeId],
  );
  const repository = new PostgresOrganizationRepository(db);
  const rollout = new OrganizationRolloutService(repository, new OrganizationAuthorityResolver(repository));
  let result;
  try {
    result = await rollout.resolveAuthorities({
      workflowKey,
      requesterEmployeeId: employeeId,
      effectiveDate,
      legacy: { directManagerEmployeeId: legacy.rows[0]?.directManagerEmployeeId ?? null, unitApproverEmployeeId: null },
      authorityRequirement: "LINE_AND_UNIT",
    });
  } catch (error) {
    if (error instanceof OrganizationResolutionError) {
      return { employeeId: null, source: null, snapshot: { unresolved: error.code, effectiveDate } };
    }
    throw error;
  }
  const sourcesOf = (authority: (typeof result.authorities)[number]) => authority.sources ?? [authority.source];
  const authority = result.authorities.find((item) => sourcesOf(item).includes("DIRECT_MANAGER"))
    ?? result.authorities.find((item) => sourcesOf(item).includes("GOVERNANCE_APPROVER"));
  const base = { mode: result.mode, authoritativeSource: result.authoritativeSource, effectiveDate };
  if (!authority || authority.employeeId === employeeId) {
    return { employeeId: null, source: null, snapshot: { ...base, unresolved: "DIRECT_MANAGER_MISSING" } };
  }
  // EMP-005 S2B §8.7: a manager outside HCIS management reads as not active.
  const active = await db.query(
    "SELECT 1 FROM employees WHERE id = $1 AND status = 'active' AND removed_at IS NULL AND management_scope = 'MANAGED'",
    [authority.employeeId],
  );
  if (!active.rows[0]) {
    return { employeeId: null, source: null, snapshot: { ...base, unresolved: "RATER_NOT_ACTIVE" } };
  }
  return {
    employeeId: authority.employeeId,
    source: sourcesOf(authority).includes("DIRECT_MANAGER") ? "DIRECT_MANAGER" : "GOVERNANCE_APPROVER",
    snapshot: { ...base, source: authority.source, path: authority.path, incumbentKind: authority.incumbentKind },
  };
}
