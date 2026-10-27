// PostgreSQL adapter for EMP-005/EMP-006 history (spec §8). Business rules live
// in ../domain; this file only loads rows, writes planned rows, and audits in
// the same transaction. DATE columns are read as text to keep calendar dates.

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  ActionRecord,
  BaselinePlan,
  BaselineSource,
  EmploymentHistory,
  EmploymentRecord,
  PlacementRecord,
  RowChange,
  TermRecord,
} from "../domain/index.js";

export type EmploymentRolloutMode = "OFF" | "SHADOW" | "AUTHORITATIVE";

type Db = Pick<Pool, "query"> | PoolClient;

export function jakartaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function getRolloutMode(db: Db): Promise<{ mode: EmploymentRolloutMode; changedAt: string | null }> {
  const result = await db.query<{ mode: EmploymentRolloutMode; changedAt: Date }>(
    `SELECT mode, changed_at AS "changedAt" FROM employment_rollout_settings WHERE id = 1`,
  );
  const row = result.rows[0];
  return row ? { mode: row.mode, changedAt: row.changedAt.toISOString() } : { mode: "OFF", changedAt: null };
}

export async function audit(
  db: Db,
  event: { actorAccountId: string | null; action: string; entityType: string; entityId: string | null; employeeId: string | null; payload: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `INSERT INTO employment_audit_events (id, actor_account_id, action, entity_type, entity_id, employee_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [randomUUID(), event.actorAccountId, event.action, event.entityType, event.entityId, event.employeeId, JSON.stringify(event.payload)],
  );
}

export async function setRolloutMode(
  client: PoolClient,
  mode: EmploymentRolloutMode,
  reason: string,
  actorAccountId: string,
): Promise<{ from: EmploymentRolloutMode; to: EmploymentRolloutMode }> {
  const current = await client.query<{ mode: EmploymentRolloutMode }>(
    "SELECT mode FROM employment_rollout_settings WHERE id = 1 FOR UPDATE",
  );
  const from = current.rows[0]?.mode ?? "OFF";
  await client.query(
    `INSERT INTO employment_rollout_settings (id, mode, reason, changed_by_account_id, changed_at)
     VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, reason = EXCLUDED.reason,
       changed_by_account_id = EXCLUDED.changed_by_account_id, changed_at = now()`,
    [mode, reason, actorAccountId],
  );
  await audit(client, {
    actorAccountId,
    action: "employment.mode.changed",
    entityType: "employment_rollout",
    entityId: null,
    employeeId: null,
    payload: { from, to: mode, reasonLength: reason.length },
  });
  return { from, to: mode };
}

interface SourceRow {
  employeeId: string;
  employeeStatus: "active" | "inactive" | "resigned";
  removed: boolean;
  startedOn: string | null;
  endedOn: string | null;
  employmentStatusText: string | null;
  employmentTypeText: string | null;
  legacyUnitId: string | null;
  legacyPositionId: string | null;
  positionName: string | null;
  functionalPosition: string | null;
  structuralPosition: string | null;
  sourceImportJobId: string | null;
  sourceSnapshotId: string | null;
  sourceData: Record<string, string | null> | null;
}

/** Master rows with their latest import source snapshot (spec §8.2 step 0). */
export async function loadBaselineSources(db: Db, employeeIds?: string[]): Promise<BaselineSource[]> {
  const result = await db.query<SourceRow>(
    `SELECT e.id AS "employeeId", e.status AS "employeeStatus", (e.removed_at IS NOT NULL) AS removed,
            e.started_on::text AS "startedOn", e.ended_on::text AS "endedOn",
            e.employment_status AS "employmentStatusText", e.employment_type AS "employmentTypeText",
            e.organizational_unit_id AS "legacyUnitId", e.position_id AS "legacyPositionId",
            p.name AS "positionName", e.functional_position AS "functionalPosition",
            e.structural_position AS "structuralPosition",
            coalesce(snapshot.import_job_id, e.source_last_import_job_id) AS "sourceImportJobId",
            snapshot.id AS "sourceSnapshotId", snapshot.source_data AS "sourceData"
     FROM employees e
     LEFT JOIN positions p ON p.id = e.position_id
     LEFT JOIN LATERAL (
       SELECT s.id, s.import_job_id, s.source_data
       FROM employee_import_source_snapshots s
       WHERE s.employee_id = e.id
       ORDER BY s.imported_at DESC, s.row_number DESC
       LIMIT 1
     ) snapshot ON true
     WHERE ($1::uuid[] IS NULL OR e.id = ANY($1::uuid[]))
     ORDER BY e.employee_number`,
    [employeeIds ?? null],
  );
  return result.rows.map((row) => ({
    employeeId: row.employeeId,
    employeeStatus: row.employeeStatus,
    removed: row.removed,
    startedOn: row.startedOn,
    endedOn: row.endedOn,
    employmentStatusText: row.employmentStatusText,
    employmentTypeText: row.employmentTypeText,
    legacyUnitId: row.legacyUnitId,
    legacyPositionId: row.legacyPositionId,
    positionName: row.positionName,
    functionalPosition: row.functionalPosition,
    structuralPosition: row.structuralPosition,
    sourceImportJobId: row.sourceImportJobId,
    sourceSnapshotId: row.sourceSnapshotId,
    sourceClassification: row.sourceData
      ? {
          statusActive: row.sourceData["STATUS AKTIF"] ?? null,
          employmentStatus: row.sourceData["STATUS KEPEGAWAIAN"] ?? null,
          employmentType: row.sourceData["JENIS KEPEGAWAIAN"] ?? null,
          endedOn: row.sourceData["TAHUN KELUAR (TTTT-BB)"] ?? null,
        }
      : null,
  }));
}

export async function loadHistories(db: Db, employeeIds?: string[]): Promise<Map<string, EmploymentHistory>> {
  const filter = employeeIds ?? null;
  const [employments, terms, placements, actions] = await Promise.all([
    db.query<EmploymentRecord>(
      `SELECT id, employee_id AS "employeeId", legal_entity_key AS "legalEntityKey", staff_type AS "staffType",
              started_on::text AS "startedOn", start_basis AS "startBasis", service_start_on::text AS "serviceStartOn",
              ended_on::text AS "endedOn", end_basis AS "endBasis", end_precision AS "endPrecision",
              end_reason AS "endReason", (voided_by_action_id IS NOT NULL) AS voided, version
       FROM employments WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1::uuid[]))`,
      [filter],
    ),
    db.query<TermRecord & { employeeId: string }>(
      `SELECT t.id, t.employment_id AS "employmentId", t.sequence, t.category,
              t.effective_from::text AS "effectiveFrom", t.effective_to::text AS "effectiveTo",
              t.contract_reference AS "contractReference", (t.voided_by_action_id IS NOT NULL) AS voided,
              e.employee_id AS "employeeId"
       FROM employment_terms t JOIN employments e ON e.id = t.employment_id
       WHERE ($1::uuid[] IS NULL OR e.employee_id = ANY($1::uuid[]))`,
      [filter],
    ),
    db.query<{
      id: string; employmentId: string; employeeId: string; kind: "PRIMARY" | "ADDITIONAL";
      orgNodeKey: string | null; legacyUnitId: string | null; orgPositionKey: string | null; legacyPositionId: string | null;
      jobTitleLabel: string; effectiveFrom: string; effectiveTo: string | null;
      effectiveFromBasis: "RECORDED" | "BASELINE_ASSUMED"; voided: boolean;
    }>(
      `SELECT p.id, p.employment_id AS "employmentId", e.employee_id AS "employeeId", p.kind,
              p.org_node_key AS "orgNodeKey", p.legacy_unit_id AS "legacyUnitId",
              p.org_position_key AS "orgPositionKey", p.legacy_position_id AS "legacyPositionId",
              p.job_title_label AS "jobTitleLabel", p.effective_from::text AS "effectiveFrom",
              p.effective_to::text AS "effectiveTo", p.effective_from_basis AS "effectiveFromBasis",
              (p.voided_by_action_id IS NOT NULL) AS voided
       FROM employment_placements p JOIN employments e ON e.id = p.employment_id
       WHERE ($1::uuid[] IS NULL OR e.employee_id = ANY($1::uuid[]))`,
      [filter],
    ),
    db.query<ActionRecord & { employeeId: string; recordedAtDate: Date }>(
      `SELECT id, employee_id AS "employeeId", employment_id AS "employmentId", action_type AS "actionType",
              effective_on::text AS "effectiveOn", state, reverses_action_id AS "reversesActionId",
              recorded_at AS "recordedAtDate", row_changes AS "rowChanges"
       FROM employment_actions WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1::uuid[]))`,
      [filter],
    ),
  ]);

  const histories = new Map<string, EmploymentHistory>();
  const historyOf = (employeeId: string) => {
    let history = histories.get(employeeId);
    if (!history) {
      history = { employeeId, employments: [], terms: [], placements: [], actions: [] };
      histories.set(employeeId, history);
    }
    return history;
  };
  for (const row of employments.rows) historyOf(row.employeeId).employments.push(row);
  for (const { employeeId, ...row } of terms.rows) historyOf(employeeId).terms.push(row);
  for (const row of placements.rows) {
    const placement: PlacementRecord = {
      id: row.id,
      employmentId: row.employmentId,
      kind: row.kind,
      unitRef: row.orgNodeKey ? { kind: "ORG_NODE", key: row.orgNodeKey } : { kind: "LEGACY_UNIT", id: row.legacyUnitId! },
      positionRef: row.orgPositionKey
        ? { kind: "ORG_POSITION", key: row.orgPositionKey }
        : row.legacyPositionId
          ? { kind: "LEGACY_POSITION", id: row.legacyPositionId }
          : null,
      jobTitleLabel: row.jobTitleLabel,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      effectiveFromBasis: row.effectiveFromBasis,
      voided: row.voided,
    };
    historyOf(row.employeeId).placements.push(placement);
  }
  for (const { employeeId, recordedAtDate, ...row } of actions.rows) {
    historyOf(employeeId).actions.push({ ...row, recordedAt: recordedAtDate.toISOString(), rowChanges: row.rowChanges as RowChange[] });
  }
  return histories;
}

/** Writes one baseline plan and its audit event; caller owns the transaction. */
export async function insertBaseline(
  client: PoolClient,
  plan: Extract<BaselinePlan, { outcome: "BASELINE" }>,
  actorAccountId: string | null,
): Promise<void> {
  const { employment, term, placement, action } = plan;
  await client.query(
    `INSERT INTO employments (id, employee_id, legal_entity_key, staff_type, started_on, start_basis, service_start_on,
       ended_on, end_basis, end_precision, end_reason, source, opened_by_action_id)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, 'BASELINE_FROM_MASTER', $11)`,
    [
      employment.id, employment.employeeId, employment.staffType, employment.startedOn, employment.startBasis,
      employment.serviceStartOn, employment.endedOn, employment.endBasis, employment.endPrecision, employment.endReason, action.id,
    ],
  );
  await client.query(
    `INSERT INTO employment_actions (id, employee_id, employment_id, action_type, effective_on, new_snapshot, row_changes,
       source_import_job_id, source_snapshot_id, recorded_by_account_id)
     VALUES ($1, $2, $3, 'BASELINE', NULL, $4::jsonb, $5::jsonb, $6, $7, $8)`,
    [
      action.id, employment.employeeId, employment.id,
      JSON.stringify({ category: term.category, termFrom: term.effectiveFrom, termTo: term.effectiveTo, placement: placement ? { jobTitleLabel: placement.jobTitleLabel } : null }),
      JSON.stringify(action.rowChanges), action.sourceImportJobId, action.sourceSnapshotId, actorAccountId,
    ],
  );
  await client.query(
    `INSERT INTO employment_terms (id, employment_id, sequence, category, effective_from, effective_to, opened_by_action_id)
     VALUES ($1, $2, 1, $3, $4, $5, $6)`,
    [term.id, employment.id, term.category, term.effectiveFrom, term.effectiveTo, action.id],
  );
  if (placement) {
    await client.query(
      `INSERT INTO employment_placements (id, employment_id, kind, legacy_unit_id, legacy_position_id, job_title_label,
         functional_label, structural_label, effective_from, effective_from_basis, opened_by_action_id)
       VALUES ($1, $2, 'PRIMARY', $3, $4, $5, $6, $7, $8, 'BASELINE_ASSUMED', $9)`,
      [
        placement.id, employment.id,
        placement.unitRef.kind === "LEGACY_UNIT" ? placement.unitRef.id : null,
        placement.positionRef?.kind === "LEGACY_POSITION" ? placement.positionRef.id : null,
        placement.jobTitleLabel, plan.placementLabels.functionalLabel, plan.placementLabels.structuralLabel,
        placement.effectiveFrom, action.id,
      ],
    );
  }
  await audit(client, {
    actorAccountId,
    action: "employment.baseline.created",
    entityType: "employment",
    entityId: employment.id,
    employeeId: employment.employeeId,
    payload: { employmentId: employment.id, issueCodes: plan.issues, sourceImportJobId: action.sourceImportJobId },
  });
}

/**
 * Removes baseline rows for employments whose only action is BASELINE
 * (spec §8.6). Real actions are never purged. Caller owns the transaction.
 */
export async function purgeBaseline(client: PoolClient, employeeIds?: string[]): Promise<number> {
  await client.query("SET LOCAL hcis.employment_baseline_purge = 'on'");
  const targets = await client.query<{ id: string }>(
    `SELECT e.id FROM employments e
     WHERE ($1::uuid[] IS NULL OR e.employee_id = ANY($1::uuid[]))
       AND NOT EXISTS (
         SELECT 1 FROM employment_actions a WHERE a.employment_id = e.id AND a.action_type <> 'BASELINE'
       )
     FOR UPDATE`,
    [employeeIds ?? null],
  );
  const ids = targets.rows.map((row) => row.id);
  if (ids.length === 0) return 0;
  await client.query("DELETE FROM employment_placements WHERE employment_id = ANY($1::uuid[])", [ids]);
  await client.query("DELETE FROM employment_terms WHERE employment_id = ANY($1::uuid[])", [ids]);
  await client.query("DELETE FROM employment_actions WHERE employment_id = ANY($1::uuid[])", [ids]);
  await client.query("DELETE FROM employments WHERE id = ANY($1::uuid[])", [ids]);
  return ids.length;
}

export interface TimelineEntry {
  id: string;
  actionType: string;
  effectiveOn: string | null;
  state: "RECORDED" | "REVERSED";
  reversesActionId: string | null;
  reversedByActionId: string | null;
  reasonCode: string | null;
  previousSnapshot: Record<string, unknown>;
  newSnapshot: Record<string, unknown>;
  recordedAt: string;
  documents: Array<{ id: string; kind: string; number: string; type: string | null }>;
}

/** Timeline without reason notes (restricted, spec §9). */
export async function loadTimeline(db: Db, employeeId: string): Promise<TimelineEntry[]> {
  const result = await db.query<Omit<TimelineEntry, "recordedAt"> & { recordedAt: Date }>(
    `SELECT a.id, a.action_type AS "actionType", a.effective_on::text AS "effectiveOn", a.state,
            a.reverses_action_id AS "reversesActionId",
            (SELECT r.id FROM employment_actions r WHERE r.reverses_action_id = a.id) AS "reversedByActionId",
            a.reason_code AS "reasonCode", a.previous_snapshot AS "previousSnapshot", a.new_snapshot AS "newSnapshot",
            a.recorded_at AS "recordedAt",
            coalesce((
              SELECT json_agg(json_build_object('id', d.id, 'kind', d.document_kind, 'number', d.document_number,
                       'type', coalesce(d.pk_type, d.sk_type)) ORDER BY d.signed_on)
              FROM employment_action_documents ad JOIN employment_decision_documents d ON d.id = ad.document_id
              WHERE ad.action_id = a.id
            ), '[]'::json) AS documents
     FROM employment_actions a
     WHERE a.employee_id = $1
     ORDER BY a.effective_on DESC NULLS LAST, a.recorded_at DESC`,
    [employeeId],
  );
  return result.rows.map((row) => ({ ...row, recordedAt: row.recordedAt.toISOString() }));
}

export interface ExpiringContract {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  unitName: string | null;
  category: string;
  endsOn: string;
  sequence: number;
  daysLeft: number;
}

/**
 * Kontrak yang akan berakhir, termasuk yang sudah lewat tanpa tindak lanjut
 * (spec §13.4, §6.2: tidak pernah berakhir sendiri).
 *
 * Term yang sedang berlaku dipilih tanpa melihat apakah ia punya tanggal
 * akhir: menyaring term tanpa akhir lebih dulu membuat pilihan jatuh ke
 * kontrak lama yang sudah ditutup, sehingga pegawai yang baru diangkat tetap
 * terus muncul sebagai kontrak lewat tempo. Term yang tanggal mulainya belum
 * diketahui (data awal) tetap dihitung: tanggal akhirnya sama butuh keputusan.
 */
export async function listExpiringContracts(
  db: Db,
  input: { today: string; withinDays: number; unitId: string | null; page: number; pageSize: number },
): Promise<{ total: number; rows: ExpiringContract[] }> {
  const filters = input.unitId ? "AND e.organizational_unit_id = $4::uuid" : "";
  const params: unknown[] = [input.today, input.withinDays, input.pageSize * (input.page - 1)];
  if (input.unitId) params.push(input.unitId);

  const currentTerm = `
    WITH current_term AS (
      SELECT DISTINCT ON (em.employee_id)
             em.employee_id, t.effective_to, t.category, t.sequence
      FROM employments em
      JOIN employment_terms t ON t.employment_id = em.id AND t.voided_by_action_id IS NULL
      WHERE em.voided_by_action_id IS NULL
        AND em.ended_on IS NULL
        AND (t.effective_from IS NULL OR t.effective_from <= $1::date)
      ORDER BY em.employee_id, t.effective_from DESC NULLS LAST, t.sequence DESC
    )`;
  const where = `
    WHERE ct.effective_to IS NOT NULL
      AND ct.effective_to <= $1::date + $2::int ${filters}`;

  const [rows, count] = await Promise.all([
    db.query<ExpiringContract>(
      `${currentTerm}
       SELECT ct.employee_id AS "employeeId", e.employee_number AS "employeeNumber", e.full_name AS "fullName",
              u.name AS "unitName", ct.category, ct.effective_to::text AS "endsOn", ct.sequence,
              (ct.effective_to - $1::date)::int AS "daysLeft"
       FROM current_term ct
       JOIN employees e ON e.id = ct.employee_id AND e.removed_at IS NULL
       LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
       ${where}
       ORDER BY ct.effective_to, e.full_name, ct.employee_id
       LIMIT ${input.pageSize} OFFSET $3`,
      params,
    ),
    // Dihitung terpisah agar halaman yang melewati batas tetap melaporkan
    // jumlah sebenarnya, bukan nol.
    db.query<{ total: number }>(
      `${currentTerm}
       SELECT count(*)::int AS total
       FROM current_term ct
       JOIN employees e ON e.id = ct.employee_id AND e.removed_at IS NULL
       ${where}`,
      input.unitId ? [input.today, input.withinDays, 0, input.unitId] : [input.today, input.withinDays, 0],
    ),
  ]);
  return { total: count.rows[0]?.total ?? 0, rows: rows.rows };
}
