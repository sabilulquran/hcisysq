/**
 * LOAN-002: the kasbon approval chain the owner decided on 2026-11-18.
 *
 *   approver unit -> Kepala Keuangan -> Direktur -> Ketua Yayasan -> Bendahara Yayasan
 *   ( -> Pembina, when the principal exceeds the threshold )
 *
 * The direct manager drops out. Staf Keuangan keeps disbursement only and is never an approval
 * step, so LOAN-001 D-14's separation of duties is untouched.
 *
 * Nothing here reads a job title. Each seat is a key HC mapped to an ORG-004 position stable key
 * in the registry (migration 0168), and the threshold is a dated configuration row (also 0168),
 * not a constant here — changing it is a row, not a release.
 */

import type { Pool, PoolClient } from "pg";

import {
  APPROVAL_SEAT_LABELS,
  type ApprovalSeatKey,
} from "../organization/approval-seats.js";
import type { ApprovalSeatAuthoritySource } from "../organization/domain.js";
import { toRupiah } from "./domain.js";

type Queryable = Pool | PoolClient;

/** The owner's order, below the threshold. Pembina is appended on top above it. */
export const LOAN_BASE_SEAT_KEYS: readonly ApprovalSeatKey[] = [
  "KEPALA_KEUANGAN",
  "DIREKTUR",
  "KETUA_YAYASAN",
  "BENDAHARA_YAYASAN",
];

/** "ada misalnya plafon tertentu pembina juga masuk approval teratas" — topmost, so last. */
export const LOAN_THRESHOLD_SEAT_KEY: ApprovalSeatKey = "PEMBINA";

const SEAT_SOURCES: Readonly<Record<ApprovalSeatKey, ApprovalSeatAuthoritySource>> = {
  KEPALA_KEUANGAN: "SEAT_KEPALA_KEUANGAN",
  DIREKTUR: "SEAT_DIREKTUR",
  KETUA_YAYASAN: "SEAT_KETUA_YAYASAN",
  BENDAHARA_YAYASAN: "SEAT_BENDAHARA_YAYASAN",
  PEMBINA: "SEAT_PEMBINA",
};

export function seatSource(seatKey: ApprovalSeatKey): ApprovalSeatAuthoritySource {
  return SEAT_SOURCES[seatKey];
}

/** The label a step shows. An organ account has no name in HCIS, so the seat is what is shown. */
export function seatLabelForSource(sources: readonly string[]): string | null {
  for (const [seatKey, source] of Object.entries(SEAT_SOURCES)) {
    if (sources.includes(source)) return APPROVAL_SEAT_LABELS[seatKey as ApprovalSeatKey];
  }
  return null;
}

/**
 * D-17 DRAFT: the principal must *exceed* the threshold for the Pembina step; a loan exactly at
 * the threshold stops at Bendahara Yayasan.
 */
export function loanApprovalSeatKeys(
  principal: bigint,
  pembinaThreshold: bigint,
): ApprovalSeatKey[] {
  return principal > pembinaThreshold
    ? [...LOAN_BASE_SEAT_KEYS, LOAN_THRESHOLD_SEAT_KEY]
    : [...LOAN_BASE_SEAT_KEYS];
}

export class LoanApprovalPolicyError extends Error {
  constructor(readonly code: "LOAN_APPROVAL_POLICY_NOT_CONFIGURED", message: string) {
    super(message);
    this.name = "LoanApprovalPolicyError";
  }
}

/**
 * The Pembina threshold in force on `date` (migration 0168 seeds the DRAFT Rp5.000.000 row).
 * No row at all is a configuration error, not a silent "no threshold": guessing here would either
 * add an approval nobody asked for or drop one the owner required.
 */
export async function loadPembinaThreshold(db: Queryable, date: string): Promise<bigint> {
  const result = await db.query<{ threshold: string }>(
    `SELECT pembina_threshold_amount::text AS threshold
     FROM employee_loan_approval_policy_versions
     WHERE effective_from <= $1::date
     ORDER BY effective_from DESC, created_at DESC
     LIMIT 1`,
    [date],
  );
  const row = result.rows[0];
  if (!row) {
    throw new LoanApprovalPolicyError(
      "LOAN_APPROVAL_POLICY_NOT_CONFIGURED",
      "Ambang persetujuan Pembina belum dikonfigurasi. Hubungi Human Capital.",
    );
  }
  return toRupiah(row.threshold);
}
