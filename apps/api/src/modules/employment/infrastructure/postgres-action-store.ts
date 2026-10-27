// EMP-005 S5: writes one planned employment action (spec §6, §8.4, §11). The
// plan comes from the pure planner; this file only turns it into rows, keeps
// the nine projected `employees` columns in step inside the same transaction,
// and audits. No business rule lives here.

import type { Pool, PoolClient } from "pg";

import {
  DEFAULT_EMPLOYMENT_POLICY,
  projectEmployee,
  resolveEmployment,
  type ActionPlan,
  type DecisionDocumentRef,
  type EmployeeProjection,
  type EmploymentHistory,
  type RowChange,
  type RowTable,
} from "../domain/index.js";
import { deactivateAccountsForEndedEmployment } from "../../auth/employment-access.js";
import { audit, loadHistories } from "./postgres-employment-store.js";

type Db = Pick<Pool, "query"> | PoolClient;

const TABLE_OF: Readonly<Record<RowTable, string>> = {
  EMPLOYMENT: "employments",
  TERM: "employment_terms",
  PLACEMENT: "employment_placements",
};

/** Columns a SET change may touch, per table. Anything else fails closed. */
const SETTABLE: Readonly<Record<RowTable, Readonly<Record<string, string>>>> = {
  EMPLOYMENT: { endedOn: "ended_on", endReason: "end_reason", endBasis: "end_basis", endPrecision: "end_precision" },
  TERM: { effectiveTo: "effective_to" },
  PLACEMENT: { effectiveTo: "effective_to" },
};

/** Tables whose rows record the action that closed them. */
const CLOSES_ROW: Readonly<Record<RowTable, boolean>> = { EMPLOYMENT: false, TERM: true, PLACEMENT: true };

export class EmploymentVersionConflict extends Error {
  constructor() {
    super("EMPLOYMENT_VERSION_CONFLICT");
    this.name = "EmploymentVersionConflict";
  }
}

/** The decision documents an action links, as the planner needs to see them. */
export async function loadDecisionDocumentRefs(db: Db, ids: string[]): Promise<DecisionDocumentRef[]> {
  if (ids.length === 0) return [];
  const result = await db.query<DecisionDocumentRef>(
    `SELECT id, document_kind AS kind, pk_type AS "pkType", sk_type AS "skType", employee_id AS "employeeId",
            contract_from::text AS "contractFrom", contract_to::text AS "contractTo", category
     FROM employment_decision_documents WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return result.rows;
}

export interface RecordedActionRef {
  id: string;
  employeeId: string;
  actionType: string;
  effectiveOn: string | null;
}

/**
 * A replayed Idempotency-Key returns the original action instead of writing
 * again. The caller compares the employee and the action type: the same key
 * reused for another employee is a client bug, and answering "already done"
 * would silently drop that second action.
 */
export async function findActionByIdempotencyKey(db: Db, key: string): Promise<RecordedActionRef | null> {
  const result = await db.query<RecordedActionRef>(
    `SELECT id, employee_id AS "employeeId", action_type AS "actionType", effective_on::text AS "effectiveOn"
     FROM employment_actions WHERE idempotency_key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

/**
 * Locks the employment row and checks the optimistic token the operator saw.
 * HIRE has no employment yet, so it locks the employee row instead: two
 * concurrent hires would otherwise both pass the "no active employment" check.
 */
async function lockTarget(client: PoolClient, plan: ActionPlan): Promise<void> {
  if (plan.newEmployment) {
    await client.query("SELECT id FROM employees WHERE id = $1 FOR UPDATE", [plan.employeeId]);
    return;
  }
  const current = await client.query<{ version: number }>(
    "SELECT version FROM employments WHERE id = $1 FOR UPDATE",
    [plan.employmentId],
  );
  const version = current.rows[0]?.version;
  if (version === undefined || (plan.expectedVersion !== null && version !== plan.expectedVersion)) {
    throw new EmploymentVersionConflict();
  }
}

async function applyRowChanges(client: PoolClient, plan: ActionPlan): Promise<void> {
  for (const change of plan.rowChanges as RowChange[]) {
    if (change.op === "OPEN") continue;
    const table = TABLE_OF[change.table];
    if (change.op === "VOID") {
      await client.query(`UPDATE ${table} SET voided_by_action_id = $2 WHERE id = $1`, [change.id, plan.actionId]);
      continue;
    }
    const columns = SETTABLE[change.table];
    const assignments: string[] = [];
    const values: unknown[] = [change.id];
    for (const [field, value] of Object.entries(change.next)) {
      const column = columns[field];
      if (!column) throw new Error(`Unsupported SET field ${change.table}.${field}`);
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) continue;
    // Closing a term or placement records which action closed it, so the
    // history explains itself and S7 can reverse exactly what was closed.
    if (CLOSES_ROW[change.table] && "effectiveTo" in change.next) {
      values.push(plan.actionId);
      assignments.push(`closed_by_action_id = $${values.length}`);
    }
    await client.query(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = $1`, values);
  }
}

/**
 * A new employment goes in before the action, because the action references it;
 * its own `opened_by_action_id` points the other way and is deferred.
 */
async function insertNewEmployment(client: PoolClient, plan: ActionPlan): Promise<void> {
  if (plan.newEmployment) {
    const employment = plan.newEmployment;
    await client.query(
      `INSERT INTO employments (id, employee_id, legal_entity_key, staff_type, started_on, start_basis, service_start_on,
         ended_on, end_basis, end_precision, end_reason, source, opened_by_action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ACTION', $12)`,
      [
        employment.id, employment.employeeId, employment.legalEntityKey, employment.staffType, employment.startedOn,
        employment.startBasis, employment.serviceStartOn, employment.endedOn, employment.endBasis,
        employment.endPrecision, employment.endReason, plan.actionId,
      ],
    );
  }
}

/** Terms and placements reference the action directly, so they follow it. */
async function insertNewRows(client: PoolClient, plan: ActionPlan): Promise<void> {
  for (const term of plan.newTerms) {
    await client.query(
      `INSERT INTO employment_terms (id, employment_id, sequence, category, effective_from, effective_to,
         contract_reference, opened_by_action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [term.id, term.employmentId, term.sequence, term.category, term.effectiveFrom, term.effectiveTo,
        term.contractReference, plan.actionId],
    );
  }
  for (const placement of plan.newPlacements) {
    await client.query(
      `INSERT INTO employment_placements (id, employment_id, kind, org_node_key, legacy_unit_id, org_position_key,
         legacy_position_id, job_title_label, effective_from, effective_to, effective_from_basis, opened_by_action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'RECORDED', $11)`,
      [
        placement.id, placement.employmentId, placement.kind,
        placement.unitRef.kind === "ORG_NODE" ? placement.unitRef.key : null,
        placement.unitRef.kind === "LEGACY_UNIT" ? placement.unitRef.id : null,
        placement.positionRef?.kind === "ORG_POSITION" ? placement.positionRef.key : null,
        placement.positionRef?.kind === "LEGACY_POSITION" ? placement.positionRef.id : null,
        placement.jobTitleLabel, placement.effectiveFrom, placement.effectiveTo, plan.actionId,
      ],
    );
  }
}

/**
 * Re-projects the nine legacy `employees` columns of one employee from the
 * history as it now stands (spec §8.4). Returns the values written, or null
 * when the employee has no history to speak for them.
 */
export async function refreshProjection(
  client: PoolClient,
  employeeId: string,
  date: string,
): Promise<EmployeeProjection | null> {
  const history = (await loadHistories(client, [employeeId])).get(employeeId);
  if (!history) return null;
  const resolved = resolveEmployment(history, date, DEFAULT_EMPLOYMENT_POLICY);
  const current = await client.query<{ functionalPosition: string | null; structuralPosition: string | null }>(
    `SELECT functional_position AS "functionalPosition", structural_position AS "structuralPosition"
     FROM employees WHERE id = $1`,
    [employeeId],
  );
  // A placement carries these two labels only when it came from the master
  // baseline. Where it does not, the stored values are kept rather than
  // cleared: the history has nothing to say about them, and the import guard
  // means no later import would bring them back.
  const stored = resolved.primaryPlacement
    ? (
        await client.query<{ functionalLabel: string | null; structuralLabel: string | null }>(
          `SELECT functional_label AS "functionalLabel", structural_label AS "structuralLabel"
           FROM employment_placements WHERE id = $1`,
          [resolved.primaryPlacement.id],
        )
      ).rows[0] ?? null
    : null;
  const labels = {
    functionalLabel: stored?.functionalLabel ?? current.rows[0]?.functionalPosition ?? null,
    structuralLabel: stored?.structuralLabel ?? current.rows[0]?.structuralPosition ?? null,
  };
  const projection = projectEmployee(resolved, labels);
  if (!projection) return null;
  await client.query(
    `UPDATE employees SET status = $2, employment_status = $3, employment_type = $4,
       organizational_unit_id = $5, position_id = $6, functional_position = $7, structural_position = $8,
       started_on = $9, ended_on = $10, updated_at = now()
     WHERE id = $1`,
    [
      employeeId, projection.status, projection.employmentStatus, projection.employmentType,
      projection.organizationalUnitId, projection.positionId, projection.functionalPosition,
      projection.structuralPosition, projection.startedOn, projection.endedOn,
    ],
  );
  return projection;
}

export interface PersistActionInput {
  plan: ActionPlan;
  actorAccountId: string;
  idempotencyKey: string;
  reasonNote: string | null;
  acknowledgedWarnings: readonly string[];
  /** Asia/Jakarta business date the projection is computed for. */
  today: string;
}

export interface PersistedAction {
  actionId: string;
  projection: EmployeeProjection | null;
  /** EMP-005 D-15: accounts this action deactivated, if the last day has passed. */
  deactivatedAccountIds: string[];
}

/**
 * EMP-005 §8.5.1: a termination whose last day has passed deactivates the
 * linked HCIS accounts in the same transaction. A future last day is left to
 * the daily job, and the preview tells the operator the date. No other action
 * ever touches an account.
 */
async function applyTerminationAccountEffect(
  client: PoolClient,
  plan: ActionPlan,
  today: string,
): Promise<string[]> {
  if (plan.actionType !== "TERMINATION") return [];
  if (plan.effectiveOn === null || plan.effectiveOn >= today) return [];
  const accountIds = await deactivateAccountsForEndedEmployment(client, plan.employeeId);
  if (accountIds.length > 0) {
    await audit(client, {
      actorAccountId: null,
      action: "employment.account.deactivated",
      entityType: "employment_action",
      entityId: plan.actionId,
      employeeId: plan.employeeId,
      payload: { accountCount: accountIds.length, cause: "employment_termination", endedOn: plan.effectiveOn },
    });
  }
  return accountIds;
}

/**
 * Writes the plan, the action, its document links, the projection and the audit
 * events in the caller's transaction (spec §11: all or nothing).
 */
export async function persistAction(client: PoolClient, input: PersistActionInput): Promise<PersistedAction> {
  const { plan } = input;
  await lockTarget(client, plan);
  await insertNewEmployment(client, plan);
  await client.query(
    `INSERT INTO employment_actions (id, employee_id, employment_id, action_type, effective_on, reason_code, reason_note,
       previous_snapshot, new_snapshot, row_changes, acknowledged_warning_codes, reverses_action_id, idempotency_key,
       recorded_by_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::text[], $12, $13, $14)`,
    [
      plan.actionId, plan.employeeId, plan.employmentId, plan.actionType, plan.effectiveOn, plan.reasonCode,
      input.reasonNote, JSON.stringify(plan.previousSnapshot), JSON.stringify(plan.newSnapshot),
      JSON.stringify(plan.rowChanges), [...input.acknowledgedWarnings], plan.reversesActionId, input.idempotencyKey,
      input.actorAccountId,
    ],
  );
  await insertNewRows(client, plan);
  await applyRowChanges(client, plan);
  if (!plan.newEmployment) {
    await client.query("UPDATE employments SET version = version + 1 WHERE id = $1", [plan.employmentId]);
  }
  if (plan.reversesActionId) {
    await client.query("UPDATE employment_actions SET state = 'REVERSED' WHERE id = $1", [plan.reversesActionId]);
  }
  for (const documentId of plan.documentIds) {
    await client.query(
      "INSERT INTO employment_action_documents (action_id, document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [plan.actionId, documentId],
    );
  }

  const projection = await refreshProjection(client, plan.employeeId, input.today);
  const deactivatedAccountIds = await applyTerminationAccountEffect(client, plan, input.today);
  await audit(client, {
    actorAccountId: input.actorAccountId,
    action: "employment.action.recorded",
    entityType: "employment_action",
    entityId: plan.actionId,
    employeeId: plan.employeeId,
    payload: {
      actionType: plan.actionType,
      effectiveOn: plan.effectiveOn,
      reasonCode: plan.reasonCode,
      documentCount: plan.documentIds.length,
      warnings: plan.warnings,
      projectedStatus: projection?.status ?? null,
      deactivatedAccounts: deactivatedAccountIds.length,
    },
  });
  return { actionId: plan.actionId, projection, deactivatedAccountIds };
}

/** Employees whose projection may change on `date` (scheduled actions, contract ends). */
export async function employeesNeedingProjection(db: Db, date: string): Promise<string[]> {
  const result = await db.query<{ employeeId: string }>(
    `SELECT DISTINCT e.employee_id AS "employeeId"
     FROM employments e
     WHERE e.voided_by_action_id IS NULL
       AND (e.started_on = $1::date OR e.ended_on = $1::date OR e.ended_on = $1::date - 1
            OR EXISTS (SELECT 1 FROM employment_terms t
                       WHERE t.employment_id = e.id AND t.voided_by_action_id IS NULL
                         AND (t.effective_from = $1::date OR t.effective_to = $1::date - 1))
            OR EXISTS (SELECT 1 FROM employment_placements p
                       WHERE p.employment_id = e.id AND p.voided_by_action_id IS NULL
                         AND (p.effective_from = $1::date OR p.effective_to = $1::date - 1)))
     ORDER BY 1`,
    [date],
  );
  return result.rows.map((row) => row.employeeId);
}

/**
 * Employees whose employment columns history owns in AUTHORITATIVE (spec §8.1).
 * EMP-004 import must leave those nine columns alone for them; everything else
 * in the master (name, contact, education) stays import's to write.
 */
export async function loadEmploymentManagedEmployeeIds(db: Db): Promise<Set<string>> {
  const mode = await db.query<{ mode: string }>("SELECT mode FROM employment_rollout_settings WHERE id = 1");
  if (mode.rows[0]?.mode !== "AUTHORITATIVE") return new Set();
  const result = await db.query<{ employeeId: string }>(
    `SELECT DISTINCT employee_id AS "employeeId" FROM employments WHERE voided_by_action_id IS NULL`,
  );
  return new Set(result.rows.map((row) => row.employeeId));
}

/** Employees whose stored columns no longer equal the projection (consistency report). */
export async function loadProjectedEmployeeIds(db: Db): Promise<string[]> {
  const result = await db.query<{ employeeId: string }>(
    `SELECT DISTINCT employee_id AS "employeeId" FROM employments WHERE voided_by_action_id IS NULL ORDER BY 1`,
  );
  return result.rows.map((row) => row.employeeId);
}

export type { EmploymentHistory };
