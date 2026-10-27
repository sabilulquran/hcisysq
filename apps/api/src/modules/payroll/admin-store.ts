/**
 * PAY-003 reference data: versioned policy, compensation profiles and loans.
 *
 * All three are effective-dated or append-only: a change opens a new row and
 * closes the previous one, so a past period stays recomputable exactly as it was
 * paid (specification section 3).
 */

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { writeAudit } from "./store.js";

export type PolicyRow = {
  id: string;
  policyKey: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  payload: unknown;
  source: string;
  note: string | null;
  createdAt: string;
};

export async function listPolicyVersions(pool: Pool, policyKey?: string): Promise<PolicyRow[]> {
  const { rows } = await pool.query<PolicyRow>(
    `SELECT id, policy_key AS "policyKey",
            to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
            to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo",
            payload, source, note, created_at AS "createdAt"
     FROM payroll_policy_versions
     WHERE ($1::text IS NULL OR policy_key = $1)
     ORDER BY policy_key, effective_from DESC`,
    [policyKey ?? null],
  );
  return rows;
}

export type NewPolicyVersion = {
  policyKey: string;
  effectiveFrom: string;
  payload: unknown;
  source: string;
  note?: string | null | undefined;
};

/**
 * Opens a new version of one policy. The version it supersedes is closed the day
 * before, so the two never overlap and nothing is overwritten: an earlier period
 * keeps reading the version that was effective when it was paid.
 */
export async function openPolicyVersion(
  pool: Pool,
  version: NewPolicyVersion,
  actorAccountId: string,
): Promise<PolicyRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE payroll_policy_versions
       SET effective_to = ($2::date - 1)
       WHERE policy_key = $1
         AND effective_to IS NULL
         AND effective_from < $2::date`,
      [version.policyKey, version.effectiveFrom],
    );

    const id = randomUUID();
    const { rows } = await client.query<PolicyRow>(
      `INSERT INTO payroll_policy_versions(id, policy_key, effective_from, payload, source, note, created_by_account_id)
       VALUES ($1, $2, $3::date, $4::jsonb, $5, $6, $7)
       RETURNING id, policy_key AS "policyKey",
                 to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
                 to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo",
                 payload, source, note, created_at AS "createdAt"`,
      [
        id,
        version.policyKey,
        version.effectiveFrom,
        JSON.stringify(version.payload),
        version.source,
        version.note ?? null,
        actorAccountId,
      ],
    );

    await writeAudit(client, {
      actorAccountId,
      action: "payroll.policy.version_opened",
      periodId: null,
      payload: { policy_key: version.policyKey, effective_from: version.effectiveFrom },
    });

    await client.query("COMMIT");
    return rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type CompensationProfileRow = {
  id: string;
  employmentId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  education: string | null;
  workPattern: string | null;
  unitRef: string | null;
  functionalPositionRef: string | null;
  structuralPositionRef: string | null;
  teachingHoursPerWeek: string | null;
  spouseCount: number;
  childCount: number;
  registeredDependants: number;
  specialQualificationTarget: string | null;
  annualPerformanceRate: string | null;
  monthlyPerformanceRate: string | null;
  bpjsSegment: string;
  bpjsActiveFrom: string | null;
  bpjsExtraFamilyOverride: number | null;
  bpjsExtraFamilyOverrideReason: string | null;
  bpjsDecisionReference: string | null;
  ptkpStatus: string | null;
  pjMediaRatePerContent: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  recordedAt: string;
};

const PROFILE_COLUMNS = `
  id, employment_id AS "employmentId",
  to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
  to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo",
  education, work_pattern AS "workPattern", unit_ref AS "unitRef",
  functional_position_ref AS "functionalPositionRef",
  structural_position_ref AS "structuralPositionRef",
  teaching_hours_per_week AS "teachingHoursPerWeek",
  spouse_count AS "spouseCount", child_count AS "childCount",
  registered_dependants AS "registeredDependants",
  special_qualification_target AS "specialQualificationTarget",
  annual_performance_rate AS "annualPerformanceRate",
  monthly_performance_rate AS "monthlyPerformanceRate",
  bpjs_segment AS "bpjsSegment",
  to_char(bpjs_active_from, 'YYYY-MM-DD') AS "bpjsActiveFrom",
  bpjs_extra_family_override AS "bpjsExtraFamilyOverride",
  bpjs_extra_family_override_reason AS "bpjsExtraFamilyOverrideReason",
  bpjs_decision_reference AS "bpjsDecisionReference",
  ptkp_status AS "ptkpStatus",
  pj_media_rate_per_content AS "pjMediaRatePerContent",
  bank_account_number AS "bankAccountNumber", bank_account_name AS "bankAccountName",
  recorded_at AS "recordedAt"
`;

export async function listCompensationProfiles(
  pool: Pool,
  employmentId: string,
): Promise<CompensationProfileRow[]> {
  const { rows } = await pool.query<CompensationProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM payroll_compensation_profiles
     WHERE employment_id = $1 ORDER BY effective_from DESC`,
    [employmentId],
  );
  return rows;
}

export type NewCompensationProfile = {
  employmentId: string;
  effectiveFrom: string;
  education?: string | null | undefined;
  workPattern?: string | null | undefined;
  unitRef?: string | null | undefined;
  functionalPositionRef?: string | null | undefined;
  structuralPositionRef?: string | null | undefined;
  teachingHoursPerWeek?: number | null | undefined;
  spouseCount?: number | undefined;
  childCount?: number | undefined;
  registeredDependants?: number | undefined;
  specialQualificationTarget?: number | null | undefined;
  annualPerformanceRate?: number | null | undefined;
  monthlyPerformanceRate?: number | null | undefined;
  bpjsSegment?: string | undefined;
  bpjsActiveFrom?: string | null | undefined;
  bpjsExtraFamilyOverride?: number | null | undefined;
  bpjsExtraFamilyOverrideReason?: string | null | undefined;
  bpjsDecisionReference?: string | null | undefined;
  ptkpStatus?: string | null | undefined;
  pjMediaRatePerContent?: number | null | undefined;
  bankAccountNumber?: string | null | undefined;
  bankAccountName?: string | null | undefined;
};

/**
 * Opens a compensation profile that applies from a date, closing the one it
 * supersedes the day before. History is never rewritten (specification section 3).
 */
export async function openCompensationProfile(
  pool: Pool,
  profile: NewCompensationProfile,
  actorAccountId: string,
): Promise<CompensationProfileRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE payroll_compensation_profiles
       SET effective_to = ($2::date - 1)
       WHERE employment_id = $1 AND effective_to IS NULL AND effective_from < $2::date`,
      [profile.employmentId, profile.effectiveFrom],
    );

    const { rows } = await client.query<CompensationProfileRow>(
      `INSERT INTO payroll_compensation_profiles(
         id, employment_id, effective_from, education, work_pattern, unit_ref,
         functional_position_ref, structural_position_ref, teaching_hours_per_week,
         spouse_count, child_count, registered_dependants, special_qualification_target,
         annual_performance_rate, monthly_performance_rate, bpjs_segment, bpjs_active_from,
         bpjs_extra_family_override, bpjs_extra_family_override_reason, bpjs_decision_reference,
         ptkp_status, pj_media_rate_per_content, bank_account_number, bank_account_name,
         recorded_by_account_id)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17::date, $18, $19, $20, $21, $22, $23, $24, $25)
       RETURNING ${PROFILE_COLUMNS}`,
      [
        randomUUID(),
        profile.employmentId,
        profile.effectiveFrom,
        profile.education ?? null,
        profile.workPattern ?? null,
        profile.unitRef ?? null,
        profile.functionalPositionRef ?? null,
        profile.structuralPositionRef ?? null,
        profile.teachingHoursPerWeek ?? null,
        profile.spouseCount ?? 0,
        profile.childCount ?? 0,
        profile.registeredDependants ?? 0,
        profile.specialQualificationTarget ?? null,
        profile.annualPerformanceRate ?? null,
        profile.monthlyPerformanceRate ?? null,
        profile.bpjsSegment ?? "BELUM_TERDAFTAR",
        profile.bpjsActiveFrom ?? null,
        profile.bpjsExtraFamilyOverride ?? null,
        profile.bpjsExtraFamilyOverrideReason ?? null,
        profile.bpjsDecisionReference ?? null,
        profile.ptkpStatus ?? null,
        profile.pjMediaRatePerContent ?? null,
        profile.bankAccountNumber ?? null,
        profile.bankAccountName ?? null,
        actorAccountId,
      ],
    );

    // Identifiers and the effective date only: a profile carries a bank account
    // and family details, none of which belong in an audit payload (section 8).
    await writeAudit(client, {
      actorAccountId,
      action: "payroll.profile.opened",
      periodId: null,
      employmentId: profile.employmentId,
      payload: { effective_from: profile.effectiveFrom },
    });

    await client.query("COMMIT");
    return rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type LoanRow = {
  id: string;
  employeeId: string;
  employeeNumber: string | null;
  fullName: string;
  grantedOn: string;
  principal: string;
  instalment: string | null;
  note: string | null;
  closedAt: string | null;
  deducted: string;
  outstanding: string;
};

const LOAN_COLUMNS = `
  l.id, l.employee_id AS "employeeId",
  emp.employee_number AS "employeeNumber", emp.full_name AS "fullName",
  to_char(l.granted_on, 'YYYY-MM-DD') AS "grantedOn",
  l.principal::text AS principal, l.instalment::text AS instalment, l.note, l.closed_at AS "closedAt",
  coalesce(paid.total, 0)::text AS deducted,
  (l.principal - coalesce(paid.total, 0))::text AS outstanding
`;

/**
 * Only an instalment belonging to a period that actually reached approval counts
 * against the balance (specification section 3.4). A deduction typed into a
 * period that is still being worked on, and then dropped, must not shrink the
 * loan for ever.
 */
export const FINAL_PERIOD_STATES = ["APPROVED", "PAYMENT_CONFIRMED", "PUBLISHED", "REOPEN_REQUESTED"];

const LOAN_PAID = `
  LEFT JOIN LATERAL (
    SELECT sum(d.amount) AS total
    FROM payroll_loan_deductions d
    JOIN payroll_periods p ON p.id = d.period_id
    WHERE d.loan_id = l.id AND p.state = ANY(ARRAY['APPROVED', 'PAYMENT_CONFIRMED', 'PUBLISHED', 'REOPEN_REQUESTED'])
  ) paid ON true
`;

/**
 * The loan register, a page at a time (ENG-LIST-001). The register grows with
 * every kasbon ever granted, so it is never read whole: finance filters by
 * employee, or walks it page by page with the total in hand.
 */
export async function listLoans(
  pool: Pool,
  options: { employeeId?: string | null; page: number; pageSize: number },
): Promise<{ loans: LoanRow[]; total: number }> {
  const employeeId = options.employeeId ?? null;
  const { rows } = await pool.query<LoanRow>(
    `SELECT ${LOAN_COLUMNS} FROM payroll_loans l
     JOIN employees emp ON emp.id = l.employee_id
     ${LOAN_PAID}
     WHERE ($1::uuid IS NULL OR l.employee_id = $1)
     ORDER BY l.granted_on DESC, l.id
     LIMIT $2 OFFSET $3`,
    [employeeId, options.pageSize, (options.page - 1) * options.pageSize],
  );
  // Counted with the same filter, so the pager never promises a page that the
  // filter would leave empty.
  const { rows: counted } = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM payroll_loans l
     WHERE ($1::uuid IS NULL OR l.employee_id = $1)`,
    [employeeId],
  );
  return { loans: rows, total: counted[0]?.total ?? 0 };
}

export type PayrollEmploymentRow = {
  employmentId: string;
  employeeId: string;
  employeeNumber: string | null;
  fullName: string;
  startedOn: string;
  endedOn: string | null;
  profileCount: number;
};

/**
 * The employments a compensation profile can be opened against, searched by
 * name or employee number (ENG-LIST-001: a picker over employees is a
 * typeahead, never a dropdown of everyone).
 */
export async function listPayrollEmployments(
  pool: Pool,
  options: { q?: string | null; page: number; pageSize: number },
): Promise<{ employments: PayrollEmploymentRow[]; total: number }> {
  const q = (options.q ?? "").trim();
  const pattern = q.length > 0 ? `%${q}%` : null;
  const { rows } = await pool.query<PayrollEmploymentRow>(
    `SELECT e.id AS "employmentId", e.employee_id AS "employeeId",
            emp.employee_number AS "employeeNumber", emp.full_name AS "fullName",
            to_char(e.started_on, 'YYYY-MM-DD') AS "startedOn",
            to_char(e.ended_on, 'YYYY-MM-DD') AS "endedOn",
            coalesce(profiles.total, 0)::int AS "profileCount"
     FROM employments e
     JOIN employees emp ON emp.id = e.employee_id
     LEFT JOIN LATERAL (
       SELECT count(*) AS total FROM payroll_compensation_profiles p WHERE p.employment_id = e.id
     ) profiles ON true
     WHERE ($1::text IS NULL OR emp.full_name ILIKE $1 OR emp.employee_number ILIKE $1)
     ORDER BY emp.employee_number, e.started_on DESC
     LIMIT $2 OFFSET $3`,
    [pattern, options.pageSize, (options.page - 1) * options.pageSize],
  );
  const { rows: counted } = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total
     FROM employments e
     JOIN employees emp ON emp.id = e.employee_id
     WHERE ($1::text IS NULL OR emp.full_name ILIKE $1 OR emp.employee_number ILIKE $1)`,
    [pattern],
  );
  return { employments: rows, total: counted[0]?.total ?? 0 };
}

export type NewLoan = {
  employeeId: string;
  grantedOn: string;
  principal: number;
  instalment?: number | null | undefined;
  note?: string | null | undefined;
};

export async function createLoan(pool: Pool, loan: NewLoan, actorAccountId: string): Promise<LoanRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = randomUUID();
    await client.query(
      `INSERT INTO payroll_loans(id, employee_id, granted_on, principal, instalment, note, recorded_by_account_id)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7)`,
      [id, loan.employeeId, loan.grantedOn, loan.principal, loan.instalment ?? null, loan.note ?? null, actorAccountId],
    );
    await writeAudit(client, {
      actorAccountId,
      action: "payroll.loan.created",
      periodId: null,
      payload: { loan_id: id, granted_on: loan.grantedOn },
    });
    await client.query("COMMIT");
    const { rows } = await pool.query<LoanRow>(
      `SELECT ${LOAN_COLUMNS} FROM payroll_loans l
       JOIN employees emp ON emp.id = l.employee_id
       ${LOAN_PAID} WHERE l.id = $1`,
      [id],
    );
    return rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** An amount of 0 removes the instalment for this period. */
export type LoanDeductionWrite = { loanId: string; amount: number };

export type LoanDeductionOutcome =
  | { ok: true; written: number; removed: number }
  | {
      ok: false;
      code:
        | "PAYROLL_LOAN_LOCKED"
        | "PAYROLL_LOAN_NOT_FOUND"
        | "PAYROLL_LOAN_CLOSED"
        | "PAYROLL_PERIOD_NOT_FOUND"
        | "PAYROLL_LOAN_EXCEEDS_BALANCE";
    };

/**
 * Sets this period's instalments. Loans are locked once the period has left the
 * collecting phase, so whoever confirms a payment cannot change the deduction it
 * rests on (specification section 2).
 */
export async function setLoanDeductions(
  pool: Pool,
  periodId: string,
  writes: readonly LoanDeductionWrite[],
  actorAccountId: string,
): Promise<LoanDeductionOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const period = await client.query<{ state: string }>(
      "SELECT state FROM payroll_periods WHERE id = $1 FOR UPDATE",
      [periodId],
    );
    const state = period.rows[0]?.state;
    if (state === undefined) {
      await client.query("ROLLBACK");
      return { ok: false, code: "PAYROLL_PERIOD_NOT_FOUND" };
    }
    if (state !== "COLLECTING" && state !== "DRAFT") {
      await client.query("ROLLBACK");
      return { ok: false, code: "PAYROLL_LOAN_LOCKED" };
    }

    let written = 0;
    let removed = 0;

    for (const write of writes) {
      if (write.amount === 0) {
        const { rowCount } = await client.query(
          "DELETE FROM payroll_loan_deductions WHERE loan_id = $1 AND period_id = $2",
          [write.loanId, periodId],
        );
        removed += rowCount ?? 0;
        continue;
      }

      // Lock the loan too: two periods can be collecting at once, and without
      // this each could pass its own balance check and together exceed the
      // principal.
      const loan = await client.query<{ closedAt: string | null }>(
        `SELECT closed_at AS "closedAt" FROM payroll_loans WHERE id = $1 FOR UPDATE`,
        [write.loanId],
      );
      if (loan.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, code: "PAYROLL_LOAN_NOT_FOUND" };
      }
      if (loan.rows[0]!.closedAt !== null) {
        await client.query("ROLLBACK");
        return { ok: false, code: "PAYROLL_LOAN_CLOSED" };
      }

      const balance = await loanBalanceExcluding(client, write.loanId, periodId);
      if (balance === null) {
        await client.query("ROLLBACK");
        return { ok: false, code: "PAYROLL_LOAN_NOT_FOUND" };
      }
      if (write.amount > balance) {
        await client.query("ROLLBACK");
        return { ok: false, code: "PAYROLL_LOAN_EXCEEDS_BALANCE" };
      }
      await client.query(
        `INSERT INTO payroll_loan_deductions(id, loan_id, period_id, amount, recorded_by_account_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (loan_id, period_id) DO UPDATE SET
           amount = EXCLUDED.amount,
           recorded_by_account_id = EXCLUDED.recorded_by_account_id,
           recorded_at = now()`,
        [randomUUID(), write.loanId, periodId, write.amount, actorAccountId],
      );
      written += 1;
    }

    await writeAudit(client, {
      actorAccountId,
      action: "payroll.loan.deductions_recorded",
      periodId,
      payload: { written, removed },
    });

    await client.query("COMMIT");
    return { ok: true, written, removed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * What is left to repay, counting only instalments from periods that reached
 * approval and ignoring whatever this period itself deducts.
 */
async function loanBalanceExcluding(
  client: PoolClient,
  loanId: string,
  periodId: string,
): Promise<number | null> {
  const { rows } = await client.query<{ balance: string }>(
    `SELECT (l.principal - coalesce((
       SELECT sum(d.amount)
       FROM payroll_loan_deductions d
       JOIN payroll_periods p ON p.id = d.period_id
       WHERE d.loan_id = l.id
         AND d.period_id <> $2
         AND p.state = ANY($3::text[])
     ), 0))::text AS balance
     FROM payroll_loans l WHERE l.id = $1 AND l.closed_at IS NULL`,
    [loanId, periodId, FINAL_PERIOD_STATES],
  );
  return rows[0] ? Number(rows[0].balance) : null;
}
