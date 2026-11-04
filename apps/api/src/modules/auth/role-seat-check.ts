// AUTH-015 (ADR-0007, owner decision 2026-11-04): a role follows the seats it is linked to.
//
// Whoever holds a linked seat today (primary or Plt) holds the role, evaluated by the permission
// engine on every request (hcis_seat_permissions, migration 0139). This module only builds what the
// Akses screen shows about that: per role, its seats, who sits in each and whether the role is in
// force for them yet, and which direct grants do not follow any seat.
//
// It replaces the ORG-008-9 comparison, which only warned because AUTH-011 then forbade deriving
// administrative permission from a position. The "seated but without the role" warning is gone:
// a seat holder now has the role. What remains worth warning about is:
//   - a seat holder for whom the role is not in force (no account, account not active, employee not
//     active) — the seat is filled but nobody can act on it;
//   - a direct grant held by someone who sits in none of the role's seats — that grant will not
//     move when the seat changes hands, which is exactly what the owner wanted to stop relying on.
//
// Pure: rows in, report out. The route loads the rows.

import type { OrganizationSnapshot } from "../organization/domain.js";
import { isEffective } from "../organization/jakarta-date.js";

/** An account whose direct role assignment is effective today, as the permission engine counts it. */
export interface RoleSeatHolder {
  accountId: string;
  employeeId: string | null;
  name: string;
}

/** One row of hcis_seat_role_holders for this role, with the employee's name. */
export interface SeatHolderRow {
  positionKey: string;
  employeeId: string;
  name: string;
  kind: "PRIMARY" | "ACTING";
  accountId: string | null;
  accountStatus: string | null;
  employeeActive: boolean;
}

export interface RoleSeatLinkRow {
  positionKey: string;
  reason: string;
  setAt: string;
}

export type SeatNotEffectiveReason = "NO_ACCOUNT" | "ACCOUNT_NOT_ACTIVE" | "EMPLOYEE_NOT_ACTIVE";

export interface RoleSeatIncumbent {
  employeeId: string;
  name: string;
  kind: "PRIMARY" | "ACTING";
  accountId: string | null;
  /** The role is in force for this person right now. */
  roleEffective: boolean;
  notEffectiveReason: SeatNotEffectiveReason | null;
  /** The person also holds a direct grant of the same role. */
  alsoDirect: boolean;
}

export type RoleSeatStatus = "NO_PUBLISHED_STRUCTURE" | "SEAT_NOT_IN_STRUCTURE" | "SEAT_VACANT" | "HELD";

export interface RoleSeat {
  positionKey: string;
  title: string | null;
  unitName: string | null;
  reason: string;
  setAt: string;
  status: RoleSeatStatus;
  incumbents: RoleSeatIncumbent[];
}

export type RoleSeatMismatch =
  | { kind: "DIRECT_HOLDER_NOT_SEATED"; accountId: string; employeeId: string | null; name: string }
  | {
      kind: "SEAT_HOLDER_NOT_EFFECTIVE";
      positionKey: string;
      employeeId: string;
      name: string;
      incumbentKind: "PRIMARY" | "ACTING";
      reason: SeatNotEffectiveReason;
    };

export interface RoleSeatCheck {
  roleKey: string;
  roleName: string;
  asOf: string;
  seats: RoleSeat[];
  /** Direct grants in force today. */
  holders: RoleSeatHolder[];
  mismatches: RoleSeatMismatch[];
}

function notEffectiveReason(row: SeatHolderRow): SeatNotEffectiveReason | null {
  if (!row.accountId) return "NO_ACCOUNT";
  if (!row.employeeActive) return "EMPLOYEE_NOT_ACTIVE";
  if (row.accountStatus !== "active") return "ACCOUNT_NOT_ACTIVE";
  return null;
}

export function computeRoleSeatCheck(input: {
  roleKey: string;
  roleName: string;
  asOf: string;
  links: RoleSeatLinkRow[];
  snapshot: OrganizationSnapshot | null;
  /** Direct grants of this role in force today. */
  holders: RoleSeatHolder[];
  /** hcis_seat_role_holders rows for this role. */
  seatHolders: SeatHolderRow[];
}): RoleSeatCheck {
  const directEmployeeIds = new Set(input.holders.flatMap((holder) => holder.employeeId ? [holder.employeeId] : []));
  const seats: RoleSeat[] = input.links.map((link) => {
    const base = { positionKey: link.positionKey, reason: link.reason, setAt: link.setAt };
    if (!input.snapshot) {
      return { ...base, title: null, unitName: null, status: "NO_PUBLISHED_STRUCTURE", incumbents: [] };
    }
    const position = input.snapshot.positions.find((item) =>
      item.stableKey === link.positionKey && item.active
      && isEffective(item.effectiveFrom, item.effectiveTo, input.asOf));
    if (!position) {
      return { ...base, title: null, unitName: null, status: "SEAT_NOT_IN_STRUCTURE", incumbents: [] };
    }
    const unitName = input.snapshot.nodes.find((node) => node.stableKey === position.nodeKey)?.name ?? null;
    const incumbents = input.seatHolders
      .filter((row) => row.positionKey === link.positionKey)
      .map((row) => {
        const reason = notEffectiveReason(row);
        return {
          employeeId: row.employeeId,
          name: row.name,
          kind: row.kind,
          accountId: row.accountId,
          roleEffective: reason === null,
          notEffectiveReason: reason,
          alsoDirect: directEmployeeIds.has(row.employeeId),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      ...base, title: position.title, unitName,
      status: incumbents.length === 0 ? "SEAT_VACANT" : "HELD", incumbents,
    };
  });

  const seatedEmployeeIds = new Set(seats.flatMap((seat) => seat.incumbents.map((item) => item.employeeId)));
  const mismatches: RoleSeatMismatch[] = [];
  // Only meaningful once the role follows at least one seat; without a link a direct grant is the
  // only way to hold the role and is not a discrepancy.
  if (seats.length > 0) {
    for (const holder of input.holders) {
      if (!holder.employeeId || !seatedEmployeeIds.has(holder.employeeId)) {
        mismatches.push({
          kind: "DIRECT_HOLDER_NOT_SEATED", accountId: holder.accountId, employeeId: holder.employeeId, name: holder.name,
        });
      }
    }
  }
  for (const seat of seats) {
    for (const incumbent of seat.incumbents) {
      if (incumbent.notEffectiveReason === null) continue;
      mismatches.push({
        kind: "SEAT_HOLDER_NOT_EFFECTIVE",
        positionKey: seat.positionKey,
        employeeId: incumbent.employeeId,
        name: incumbent.name,
        incumbentKind: incumbent.kind,
        reason: incumbent.notEffectiveReason,
      });
    }
  }

  return {
    roleKey: input.roleKey,
    roleName: input.roleName,
    asOf: input.asOf,
    seats,
    holders: input.holders,
    mismatches,
  };
}
