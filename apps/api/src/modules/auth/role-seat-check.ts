// ORG-008-9 (owner decision 2026-10-27): does the Kepala HC role sit with whoever holds the Kepala HC
// seat in the published structure?
//
// The role is granted by hand and the seat changes hands in the structure, so the two can drift
// apart: a previous seat holder keeps the role, or a new one never receives it. AUTH-011 forbids a
// position from granting administrative permission, so this only compares and reports. It never
// grants, revokes or suggests a grant on its own.
//
// An acting holder (Plt) counts as a legitimate seat holder, exactly like the primary holder
// (owner decision 2026-10-27).
//
// Pure: rows in, report out. The route loads the rows.

import type { OrganizationSnapshot } from "../organization/domain.js";
import { isEffective } from "../organization/jakarta-date.js";

/** An account whose role assignment is effective today, as the permission engine counts it. */
export interface RoleSeatHolder {
  accountId: string;
  employeeId: string | null;
  name: string;
}

/** The EMPLOYEE account of a seat holder, when there is one. */
export interface RoleSeatAccount {
  accountId: string;
  employeeId: string;
  status: string;
}

export interface RoleSeatIncumbent {
  employeeId: string;
  name: string;
  kind: "PRIMARY" | "ACTING";
  accountId: string | null;
  hasRole: boolean;
}

export type RoleSeatStatus =
  | "SEAT_NOT_SET"
  | "NO_PUBLISHED_STRUCTURE"
  | "SEAT_NOT_IN_STRUCTURE"
  | "SEAT_VACANT"
  | "CHECKED";

export type RoleSeatMismatch =
  | { kind: "HOLDER_NOT_SEATED"; accountId: string; employeeId: string | null; name: string }
  | {
      kind: "SEATED_WITHOUT_ROLE";
      employeeId: string;
      name: string;
      incumbentKind: "PRIMARY" | "ACTING";
      reason: "NO_ACCOUNT" | "ACCOUNT_NOT_ACTIVE" | "NO_ROLE";
    };

export interface RoleSeatCheck {
  roleKey: string;
  asOf: string;
  seat: {
    positionKey: string;
    title: string | null;
    unitName: string | null;
    reason: string;
    setAt: string;
  } | null;
  status: RoleSeatStatus;
  holders: RoleSeatHolder[];
  incumbents: RoleSeatIncumbent[];
  mismatches: RoleSeatMismatch[];
}

export function computeRoleSeatCheck(input: {
  roleKey: string;
  asOf: string;
  link: { positionKey: string; reason: string; setAt: string } | null;
  snapshot: OrganizationSnapshot | null;
  holders: RoleSeatHolder[];
  /** Employee names for every incumbent of the seat. */
  employeeNames: ReadonlyMap<string, string>;
  /** EMPLOYEE accounts of those incumbents. */
  accounts: RoleSeatAccount[];
}): RoleSeatCheck {
  const base = { roleKey: input.roleKey, asOf: input.asOf, holders: input.holders };
  if (!input.link) {
    return { ...base, seat: null, status: "SEAT_NOT_SET", incumbents: [], mismatches: [] };
  }
  const seatBase = { positionKey: input.link.positionKey, reason: input.link.reason, setAt: input.link.setAt };
  if (!input.snapshot) {
    return {
      ...base, seat: { ...seatBase, title: null, unitName: null },
      status: "NO_PUBLISHED_STRUCTURE", incumbents: [], mismatches: [],
    };
  }

  const position = input.snapshot.positions.find((item) =>
    item.stableKey === input.link!.positionKey
    && item.active
    && isEffective(item.effectiveFrom, item.effectiveTo, input.asOf));
  if (!position) {
    return {
      ...base, seat: { ...seatBase, title: null, unitName: null },
      status: "SEAT_NOT_IN_STRUCTURE", incumbents: [], mismatches: [],
    };
  }
  const unitName = input.snapshot.nodes.find((node) => node.stableKey === position.nodeKey)?.name ?? null;
  const seat = { ...seatBase, title: position.title, unitName };

  const holderEmployeeIds = new Set(input.holders.flatMap((holder) => holder.employeeId ? [holder.employeeId] : []));
  const incumbents: RoleSeatIncumbent[] = input.snapshot.incumbencies
    .filter((item) => item.positionKey === position.stableKey
      && item.employeeId
      && isEffective(item.effectiveFrom, item.effectiveTo, input.asOf))
    .map((item) => {
      const account = input.accounts.find((candidate) => candidate.employeeId === item.employeeId!);
      return {
        employeeId: item.employeeId!,
        name: input.employeeNames.get(item.employeeId!) ?? "Pegawai tidak dikenal",
        kind: item.kind,
        accountId: account?.accountId ?? null,
        hasRole: holderEmployeeIds.has(item.employeeId!),
      };
    });

  const seatedEmployeeIds = new Set(incumbents.map((item) => item.employeeId));
  const mismatches: RoleSeatMismatch[] = [];
  for (const holder of input.holders) {
    if (!holder.employeeId || !seatedEmployeeIds.has(holder.employeeId)) {
      mismatches.push({ kind: "HOLDER_NOT_SEATED", accountId: holder.accountId, employeeId: holder.employeeId, name: holder.name });
    }
  }
  for (const incumbent of incumbents) {
    if (incumbent.hasRole) continue;
    const account = input.accounts.find((candidate) => candidate.employeeId === incumbent.employeeId);
    mismatches.push({
      kind: "SEATED_WITHOUT_ROLE",
      employeeId: incumbent.employeeId,
      name: incumbent.name,
      incumbentKind: incumbent.kind,
      reason: !account ? "NO_ACCOUNT" : account.status !== "active" ? "ACCOUNT_NOT_ACTIVE" : "NO_ROLE",
    });
  }

  return {
    ...base,
    seat,
    status: incumbents.length === 0 ? "SEAT_VACANT" : "CHECKED",
    incumbents,
    mismatches,
  };
}
