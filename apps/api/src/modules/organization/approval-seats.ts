/**
 * LOAN-002 / APR-002: the approval seat registry (migration 0177).
 *
 * Owner decision 2026-11-18 names a fixed kasbon chain by seat — Kepala Keuangan, Direktur, Ketua
 * Yayasan, Bendahara Yayasan, Pembina. A seat is not a job title: the approval resolver must never
 * match title text (AUTH-010-K, docs/domain/access-model.md §342, employee-loans.md D-01), so HC
 * maps each seat key to an ORG-004 position stable key, dated, exactly as ATT-011 D-10 maps an
 * overtime rule to a seat (migration 0146, `overtime-rule-seat-warnings.ts`).
 *
 * The system never guesses the mapping. An unmapped seat is a configuration error that names the
 * seat, and `approvalSeatReadiness` lets HC see it before anyone is blocked.
 */

import type { OrganizationSnapshot } from "./domain.js";
import { isEffective } from "./jakarta-date.js";
import type { OrganizationQueryable } from "./repository.js";

/** The closed set. Adding a seat is a migration (0177's CHECK) and a change here, never data. */
export const APPROVAL_SEAT_KEYS = [
  "KEPALA_KEUANGAN",
  "DIREKTUR",
  "KETUA_YAYASAN",
  "BENDAHARA_YAYASAN",
  "PEMBINA",
] as const;
export type ApprovalSeatKey = (typeof APPROVAL_SEAT_KEYS)[number];

/** For operator sentences only. Never read to resolve anything. */
export const APPROVAL_SEAT_LABELS: Readonly<Record<ApprovalSeatKey, string>> = {
  KEPALA_KEUANGAN: "Kepala Keuangan",
  DIREKTUR: "Direktur",
  KETUA_YAYASAN: "Ketua Yayasan",
  BENDAHARA_YAYASAN: "Bendahara Yayasan",
  PEMBINA: "Pembina",
};

export function isApprovalSeatKey(value: string): value is ApprovalSeatKey {
  return (APPROVAL_SEAT_KEYS as readonly string[]).includes(value);
}

export interface ApprovalSeatMapping {
  seatKey: ApprovalSeatKey;
  positionKey: string;
  seatLabel: string;
}

/**
 * The mappings in force on `date`. One open row per seat is held by the unique index in 0177, so a
 * seat appears at most once; a seat with no row in force is simply absent.
 */
export async function loadApprovalSeatMappings(
  db: OrganizationQueryable,
  date: string,
): Promise<ApprovalSeatMapping[]> {
  const result = await db.query<ApprovalSeatMapping>(
    `SELECT seat_key AS "seatKey", position_key::text AS "positionKey", seat_label AS "seatLabel"
     FROM organization_approval_seats
     WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to >= $1::date)
     ORDER BY seat_key`,
    [date],
  );
  return result.rows.filter((row) => isApprovalSeatKey(row.seatKey));
}

export class ApprovalSeatError extends Error {
  constructor(
    readonly code: "APPROVAL_SEAT_UNMAPPED",
    readonly seatKey: ApprovalSeatKey,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalSeatError";
  }
}

/**
 * Turns the seat keys a workflow asks for into position stable keys, in the order given. Fails
 * closed on the first unmapped seat, naming it: with a fixed chain one missing mapping blocks every
 * request in the institution, so the error has to say which seat HC must map (employee-loans.md
 * §16 D-18).
 */
export function resolveApprovalSeatPositions(
  mappings: readonly ApprovalSeatMapping[],
  seatKeys: readonly ApprovalSeatKey[],
): Array<{ seatKey: ApprovalSeatKey; positionKey: string }> {
  const byKey = new Map(mappings.map((item) => [item.seatKey, item]));
  return seatKeys.map((seatKey) => {
    const mapping = byKey.get(seatKey);
    if (!mapping) {
      throw new ApprovalSeatError(
        "APPROVAL_SEAT_UNMAPPED",
        seatKey,
        `Kursi persetujuan ${APPROVAL_SEAT_LABELS[seatKey]} belum dipetakan ke jabatan. `
        + "Human Capital memetakannya di Pengaturan > Kursi persetujuan.",
      );
    }
    return { seatKey, positionKey: mapping.positionKey };
  });
}

export type ApprovalSeatState =
  | "READY"
  | "UNMAPPED"
  | "POSITION_NOT_IN_FORCE"
  | "VACANT"
  /**
   * LOAN-002 D-19: the seat is mapped and occupied, but by the person the readiness was asked
   * about. Their own kasbon cannot travel this chain. Reported as its own state so the answer is
   * "here is what has to be arranged", not a bare refusal.
   */
  | "SEAT_HELD_BY_REQUESTER";

/** Who the readiness is being judged for, when it is judged for someone. */
export interface ApprovalSeatRequester {
  employeeId: string;
  /** Organ accounts that are the same person (ORG-013-1 butir 5 matches them by e-mail). */
  accountIds?: readonly string[];
}

export interface ApprovalSeatReadiness {
  seatKey: ApprovalSeatKey;
  state: ApprovalSeatState;
  positionKey: string | null;
  /** What HC chose, kept for display. Null when the seat has no mapping at all. */
  seatLabel: string | null;
  /** The seat's title in the structure in force, when the position is still there. */
  positionTitle: string | null;
  unitName: string | null;
  /** ORG-013: an account-held seat resolves to a Foundation Board account, not an employee. */
  holderSource: "EMPLOYEE" | "ACCOUNT" | null;
}

/**
 * What HC sees before anyone is blocked: every seat in the closed set with its state against the
 * published structure in force on `date`. Read-only, and it never edits or blocks anything — the
 * designer warns, HC decides, as ORG-008-12 (decision O-8) has it for overtime rules.
 */
export function approvalSeatReadiness(
  mappings: readonly ApprovalSeatMapping[],
  snapshot: OrganizationSnapshot | null,
  date: string,
  requester?: ApprovalSeatRequester | undefined,
): ApprovalSeatReadiness[] {
  const byKey = new Map(mappings.map((item) => [item.seatKey, item]));
  return APPROVAL_SEAT_KEYS.map((seatKey): ApprovalSeatReadiness => {
    const mapping = byKey.get(seatKey);
    if (!mapping) {
      return {
        seatKey, state: "UNMAPPED", positionKey: null, seatLabel: null,
        positionTitle: null, unitName: null, holderSource: null,
      };
    }
    const base = {
      seatKey, positionKey: mapping.positionKey, seatLabel: mapping.seatLabel,
    };
    const position = snapshot?.positions.find((item) => item.stableKey === mapping.positionKey);
    if (!position || !position.active || !isEffective(position.effectiveFrom, position.effectiveTo, date)) {
      return {
        ...base, state: "POSITION_NOT_IN_FORCE",
        positionTitle: position?.title ?? null, unitName: null, holderSource: null,
      };
    }
    const unitName = snapshot?.nodes.find((node) => node.stableKey === position.nodeKey)?.name ?? null;
    const holderSource = position.holderSource ?? "EMPLOYEE";
    // PRIMARY or ACTING, like every other authority lookup. A seat with neither is vacant, and a
    // fixed seat never climbs to its parent, so a vacancy here stops the whole chain.
    const incumbents = (snapshot?.incumbencies ?? []).filter((item) =>
      item.positionKey === position.stableKey
      && (item.kind === "PRIMARY" || item.kind === "ACTING")
      && isEffective(item.effectiveFrom, item.effectiveTo, date)
      && (holderSource === "ACCOUNT" ? Boolean(item.accountId) : Boolean(item.employeeId)));
    // N1: the state must follow the incumbent the resolver would actually pick, not "every
    // incumbent". `resolvePosition` tries PRIMARY first and only falls through to ACTING when the
    // PRIMARY one is absent or ineligible — and hitting the requester is not ineligibility, it
    // throws. So a seat held by the requester as PRIMARY with someone else ACTING is refused at
    // submission; reporting READY there would tell HC all is well on exactly the configuration
    // this state exists to point at.
    const requesterAccounts = new Set(requester?.accountIds ?? []);
    const isRequester = (item: { employeeId: string | null; accountId?: string | null }) =>
      (item.employeeId !== null && item.employeeId === requester?.employeeId)
      || (item.accountId !== null && item.accountId !== undefined && requesterAccounts.has(item.accountId));
    const resolved = incumbents.find((item) => item.kind === "PRIMARY") ?? incumbents[0];
    const heldByRequester = requester !== undefined && resolved !== undefined && isRequester(resolved);
    return {
      ...base,
      state: heldByRequester ? "SEAT_HELD_BY_REQUESTER" : incumbents.length > 0 ? "READY" : "VACANT",
      positionTitle: position.title,
      unitName,
      holderSource,
    };
  });
}
