// TRIP-002 D-22: the per diem feature is locked until someone turns it on, and it can only be
// turned on when the readiness check passes. Spec: docs/domain/trip-advance-per-diem.md §10.
// Owner decision, 2026-11-24.
//
// Why this exists. Migration 0172 brings the per diem path to life the moment it runs; with an
// empty golongan map every estimate, every new advance and every settlement answers 409
// TRIP_PER_DIEM_GOLONGAN_UNMAPPED. That is not "locked", that is broken, and it used to be held
// back by a gate that blocked *every* release, including ones that never touch trip advances.
// The check belongs to the feature's own switch, not to the release.
//
// What the lock does and does not shut. The two doors INTO the feature are shut while it is off:
// the per diem estimate and a new advance. Approval, disbursement and settlement are left open
// on purpose, so switching the feature off never strands money that is already out — but that
// also means `POST /admin/trip-advances/:id/settle` still prices a live advance from the
// golongan map as it stands at settlement time. An advance already out therefore depends on its
// golongan whether the switch is on or off, which is why the release gate keeps checking live
// advances even while the feature is off (scripts/mi8/release-mi8.sh, trip_002_gate_verdict).
//
// The readiness query below asks the same question as scripts/mi8/sql/trip-002-golongan-gate.sql,
// which the release script runs on the device: both mirror resolveGolongan() and bindingsOn(),
// and both anchor on the Asia/Jakarta date (the Mi8 database runs in Asia/Jakarta, verified
// read-only on 2026-11-24, so its current_date and today() here are the same day). They are not
// identical, and the differences are deliberate:
//
//   * only this one has RATE_MISSING. The release gate has no equivalent arm, because 0172 seeds
//     all six decree rates and trip_per_diem_rates is append-only, so a release cannot take a
//     rate away. Activation can still meet a world where someone never added one.
//   * this one is asked of the date the API computes; the release gate asks the device.
//
// Change the shared part of one and change the other; scripts/mi8/test-trip-002-gate.sh and
// apps/api/test/trip-per-diem-activation.postgres.test.ts cover the same scenarios on purpose.

import type { Pool, PoolClient } from "pg";

type Queryable = Pool | PoolClient;

export type ActivationState = "ACTIVE" | "INACTIVE";

export type ReadinessSeverity = "FAIL" | "WARN";

export type ReadinessKind =
  | "CATALOGUE_EMPTY"
  | "CLASSIFICATION_UNMAPPED"
  | "EMPLOYEE_UNRESOLVED"
  | "ADVANCE_UNRESOLVED"
  | "RATE_MISSING"
  | "CLASSIFICATION_UNMAPPED_FUTURE";

export interface ReadinessFinding {
  severity: ReadinessSeverity;
  kind: ReadinessKind;
  detail: string;
  /** How many findings of this kind there are in all, before the list was cut to `SAMPLE`. */
  total: number;
}

export interface ActivationRecord {
  state: ActivationState;
  changedAt: string | null;
  changedByName: string | null;
  reason: string | null;
}

/** The state in force: the last row written, or INACTIVE when nobody has written one. */
export async function perDiemActivation(db: Queryable): Promise<ActivationRecord> {
  const result = await db.query<{
    state: ActivationState; changedAt: string; changedByName: string | null; reason: string | null;
  }>(
    `SELECT activation.state, activation.changed_at AS "changedAt", activation.reason,
            changer.full_name AS "changedByName"
       FROM trip_per_diem_activation activation
       LEFT JOIN accounts account ON account.id = activation.changed_by_account_id
       LEFT JOIN employees changer ON changer.id = account.employee_id
      ORDER BY activation.recorded_seq DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return { state: "INACTIVE", changedAt: null, changedByName: null, reason: null };
  return { state: row.state, changedAt: row.changedAt, changedByName: row.changedByName, reason: row.reason };
}

export async function perDiemIsActive(db: Queryable): Promise<boolean> {
  return (await perDiemActivation(db)).state === "ACTIVE";
}

// Lists are cut here, not in the caller: an empty map names every employee of the foundation and
// neither a screen nor an audit row needs that.
const SAMPLE = 20;

/**
 * Everything that would make the per diem path refuse somebody on `on`.
 *
 * FAIL stops activation. WARN is reported and does not: a classification published for a future
 * date breaks nothing today, but it will on its own date if nobody maps it first.
 */
export async function perDiemReadiness(db: Queryable, on: string): Promise<ReadinessFinding[]> {
  const result = await db.query<ReadinessFinding>(
    `WITH
     -- Who can ask for an advance. Deliberately NOT narrowed further than the runtime route:
     -- this must be a superset of it, never a smaller set. management_scope is not tested
     -- because the route does not test it either, and an active account is not required
     -- because an employee whose account is activated tomorrow must already resolve today.
     eligible AS (
       SELECT employee.id, employee.employee_number
         FROM employees employee
        WHERE employee.status = 'active' AND employee.removed_at IS NULL
     ),
     -- Advances still in flight settle against their own departure date, which may be in the
     -- past and may name a classification that has since been closed.
     live_advance AS (
       SELECT advance.id::text AS advance_id, advance.employee_id, trip.start_on
         FROM trip_advances advance
         JOIN business_trip_requests trip ON trip.id = advance.business_trip_id
        WHERE advance.status NOT IN ('SETTLED', 'REJECTED', 'CANCELLED')
     ),
     subject AS (
       SELECT 'EMPLOYEE' AS kind, eligible.id AS employee_id, $1::date AS on_date,
              eligible.employee_number AS label
         FROM eligible
       UNION ALL
       SELECT 'ADVANCE', live_advance.employee_id, live_advance.start_on,
              live_advance.advance_id || ' berangkat ' || to_char(live_advance.start_on, 'YYYY-MM-DD')
         FROM live_advance
     ),
     -- bindingsOn() followed by the golongan map, as one set: voided placements do not count,
     -- the seat must really be in force on that date, and the structure is read from the change
     -- set published for that date.
     unresolved AS (
       SELECT subject.kind, subject.label
         FROM subject
        WHERE NOT EXISTS (
          SELECT 1
            FROM employments employment
            JOIN employment_placements placement
              ON placement.employment_id = employment.id
             AND placement.voided_by_action_id IS NULL
             AND placement.effective_from <= subject.on_date
             AND (placement.effective_to IS NULL OR placement.effective_to >= subject.on_date)
            LEFT JOIN LATERAL (
              SELECT change_set.id
                FROM organization_change_sets change_set
               WHERE change_set.status = 'PUBLISHED' AND change_set.effective_on <= subject.on_date
               ORDER BY change_set.effective_on DESC, change_set.published_at DESC,
                        change_set.created_at DESC, change_set.id DESC
               LIMIT 1
            ) effective_change_set ON true
            LEFT JOIN organization_positions position_row
              ON position_row.change_set_id = effective_change_set.id
             AND position_row.stable_key = placement.org_position_key
             AND position_row.active
             AND position_row.effective_from <= subject.on_date
             AND (position_row.effective_to IS NULL OR position_row.effective_to >= subject.on_date)
            JOIN trip_per_diem_golongan_map map
              ON map.job_classification_code
                 = COALESCE(placement.job_classification_code, position_row.job_classification_code)
           WHERE employment.employee_id = subject.employee_id
             AND employment.voided_by_action_id IS NULL
             AND (employment.started_on IS NULL OR employment.started_on <= subject.on_date)
             AND (employment.ended_on IS NULL OR employment.ended_on >= subject.on_date))
     ),
     classification_today AS (
       SELECT classification.code
         FROM job_classifications classification
        WHERE classification.active AND classification.effective_from <= $1::date
          AND (classification.effective_to IS NULL OR classification.effective_to >= $1::date)
     ),
     classification_future AS (
       SELECT classification.code, classification.effective_from
         FROM job_classifications classification
        WHERE classification.active AND classification.effective_from > $1::date
     ),
     -- A golongan somebody actually resolves to, and therefore needs a rate for. LUAR_NEGERI is
     -- a code without a rate on purpose (SK Lampiran 1), so only the two paying wilayah count.
     reachable_golongan AS (
       SELECT DISTINCT map.golongan FROM trip_per_diem_golongan_map map
     ),
     finding AS (
       SELECT 1 AS ord, 'FAIL' AS severity, 'CATALOGUE_EMPTY' AS kind,
              'Tidak ada klasifikasi jabatan ORG-011 yang berlaku hari ini, sehingga tidak seorang pegawai pun memperoleh golongan.' AS detail
        WHERE NOT EXISTS (SELECT 1 FROM classification_today)
       UNION ALL
       SELECT 2, 'FAIL', 'CLASSIFICATION_UNMAPPED', classification_today.code
         FROM classification_today
        WHERE NOT EXISTS (SELECT 1 FROM trip_per_diem_golongan_map map
                           WHERE map.job_classification_code = classification_today.code)
       UNION ALL
       SELECT 3, 'FAIL', 'EMPLOYEE_UNRESOLVED', unresolved.label
         FROM unresolved WHERE unresolved.kind = 'EMPLOYEE'
       UNION ALL
       SELECT 4, 'FAIL', 'ADVANCE_UNRESOLVED', unresolved.label
         FROM unresolved WHERE unresolved.kind = 'ADVANCE'
       UNION ALL
       SELECT 5, 'FAIL', 'RATE_MISSING', reachable_golongan.golongan || ' ' || wilayah.code
         FROM reachable_golongan
         CROSS JOIN (VALUES ('DALAM_DAERAH'), ('LUAR_DAERAH')) AS wilayah(code)
        WHERE NOT EXISTS (SELECT 1 FROM trip_per_diem_rates rate
                           WHERE rate.golongan = reachable_golongan.golongan
                             AND rate.wilayah = wilayah.code
                             AND rate.effective_from <= $1::date)
       UNION ALL
       SELECT 6, 'WARN', 'CLASSIFICATION_UNMAPPED_FUTURE',
              classification_future.code || ' berlaku ' || to_char(classification_future.effective_from, 'YYYY-MM-DD')
         FROM classification_future
        WHERE NOT EXISTS (SELECT 1 FROM trip_per_diem_golongan_map map
                           WHERE map.job_classification_code = classification_future.code)
     ),
     ranked AS (
       SELECT finding.ord, finding.severity, finding.kind, finding.detail,
              row_number() OVER (PARTITION BY finding.ord ORDER BY finding.detail) AS seq,
              count(*) OVER (PARTITION BY finding.ord) AS total
         FROM finding
     )
     SELECT ranked.severity, ranked.kind, ranked.detail, ranked.total::int AS total
       FROM ranked WHERE ranked.seq <= $2::int
     UNION ALL
     SELECT ranked.severity, ranked.kind, 'dan ' || (ranked.total - $2::int)::text || ' lagi',
            ranked.total::int
       FROM ranked WHERE ranked.seq = $2::int AND ranked.total > $2::int
     ORDER BY 1, 2, 3`,
    [on, SAMPLE],
  );
  return result.rows;
}

export function readinessBlockers(findings: ReadinessFinding[]): ReadinessFinding[] {
  return findings.filter((finding) => finding.severity === "FAIL");
}

/**
 * What goes into the audit row: counts, never the list of people (D-17).
 *
 * The count is `total`, not the number of rows that survived the cut to `SAMPLE`. Counting rows
 * would cap every kind at 21 and quietly understate what the decision was taken against.
 */
export function readinessSummary(findings: ReadinessFinding[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const finding of findings) summary[finding.kind] = finding.total;
  return summary;
}
