/**
 * The semantic rungs an APR-001 chain can carry. The `SEAT_*` ones are LOAN-002's fixed approval
 * seats (migration 0177): Leave never produces them, but the snapshot helpers here are shared with
 * the loan routes, so the type has to admit them.
 */
export type LeaveApprovalSource =
  | "DIRECT_MANAGER"
  | "UNIT_APPROVER"
  | "GOVERNANCE_APPROVER"
  | "SEAT_KEPALA_KEUANGAN"
  | "SEAT_DIREKTUR"
  | "SEAT_KETUA_YAYASAN"
  | "SEAT_BENDAHARA_YAYASAN"
  | "SEAT_PEMBINA";

export interface LeaveApprovalStep {
  principalType?: "EMPLOYEE" | "ACCOUNT";
  employeeId: string | null;
  accountId?: string | null;
  sources: LeaveApprovalSource[];
}

export interface LeaveLineApprovalInput {
  requesterEmployeeId: string;
  directManagerEmployeeId: string | null | undefined;
  unitApproverEmployeeId: string | null | undefined;
}

export interface ResolvedLeaveAuthorityInput {
  requesterEmployeeId: string;
  authorities: ReadonlyArray<{
    principalType?: "EMPLOYEE" | "ACCOUNT";
    employeeId: string | null;
    accountId?: string | null;
    source: LeaveApprovalSource;
  }>;
  /**
   * LOAN-002 M2 (D-20 DRAFT): false keeps one step per rung even when the same person holds two of
   * them. Leave leaves this unset and keeps merging, which is right there — its rungs are a line of
   * authority, so one person standing on two of them is one approval. A fixed seat chain is a list
   * of mandates: collapsing two of them would shorten the chain the owner decided, silently.
   */
  mergeDuplicates?: boolean | undefined;
}

export class LeaveApprovalConfigurationError extends Error {
  constructor(
    readonly code:
      | "DIRECT_MANAGER_MISSING"
      | "DIRECT_MANAGER_SELF"
      | "UNIT_APPROVER_MISSING"
      | "UNIT_APPROVER_SELF"
      | "APPROVAL_CHAIN_EMPTY",
    message: string,
  ) {
    super(message);
    this.name = "LeaveApprovalConfigurationError";
  }
}

function addStep(
  steps: LeaveApprovalStep[],
  principal: {
    principalType?: "EMPLOYEE" | "ACCOUNT";
    employeeId: string | null;
    accountId?: string | null;
  },
  source: LeaveApprovalSource,
  /** LOAN-002 M2: false keeps one step per rung even when the same principal already has one. */
  merge = true,
) {
  const principalType = principal.principalType ?? "EMPLOYEE";
  const hasEmployee = Boolean(principal.employeeId);
  const hasAccount = Boolean(principal.accountId);
  if (hasEmployee === hasAccount
      || (principalType === "EMPLOYEE" && !hasEmployee)
      || (principalType === "ACCOUNT" && !hasAccount)) {
    throw new LeaveApprovalConfigurationError(
      "APPROVAL_CHAIN_EMPTY",
      "Rantai approval berisi principal yang ambigu atau tidak valid.",
    );
  }
  const key = principalType === "ACCOUNT" ? principal.accountId! : principal.employeeId!;
  const existing = merge ? steps.find((step) =>
    (step.principalType ?? "EMPLOYEE") === principalType &&
    (principalType === "ACCOUNT" ? step.accountId === key : step.employeeId === key)) : undefined;
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    return;
  }

  steps.push(principalType === "ACCOUNT"
    ? { principalType: "ACCOUNT", employeeId: null, accountId: key, sources: [source] }
    : { employeeId: key, sources: [source] });
}

export function resolveLeaveLineApprovalChain(
  input: LeaveLineApprovalInput,
): LeaveApprovalStep[] {
  if (!input.directManagerEmployeeId) {
    throw new LeaveApprovalConfigurationError(
      "DIRECT_MANAGER_MISSING",
      "Atasan langsung belum dikonfigurasi.",
    );
  }

  if (input.directManagerEmployeeId === input.requesterEmployeeId) {
    throw new LeaveApprovalConfigurationError(
      "DIRECT_MANAGER_SELF",
      "Atasan langsung tidak boleh menunjuk pegawai yang sama.",
    );
  }

  if (!input.unitApproverEmployeeId) {
    throw new LeaveApprovalConfigurationError(
      "UNIT_APPROVER_MISSING",
      "Approver unit belum dikonfigurasi.",
    );
  }

  const steps: LeaveApprovalStep[] = [];
  addStep(
    steps,
    { principalType: "EMPLOYEE", employeeId: input.directManagerEmployeeId, accountId: null },
    "DIRECT_MANAGER",
  );

  if (input.unitApproverEmployeeId !== input.requesterEmployeeId) {
    addStep(
      steps,
      { principalType: "EMPLOYEE", employeeId: input.unitApproverEmployeeId, accountId: null },
      "UNIT_APPROVER",
    );
  }

  if (steps.length === 0) {
    throw new LeaveApprovalConfigurationError(
      "APPROVAL_CHAIN_EMPTY",
      "Rantai approval tidak memiliki approver yang valid.",
    );
  }

  return steps;
}

/**
 * Applies APR-001's final defensive normalization at the Leave boundary.
 * The organization resolver normally removes self-approvals and duplicates,
 * but Leave repeats those protections before persisting its immutable snapshot.
 */
export function snapshotResolvedLeaveAuthorities(
  input: ResolvedLeaveAuthorityInput,
): LeaveApprovalStep[] {
  const merge = input.mergeDuplicates ?? true;
  const steps: LeaveApprovalStep[] = [];
  for (const authority of input.authorities) {
    if ((authority.principalType ?? "EMPLOYEE") === "EMPLOYEE"
        && authority.employeeId === input.requesterEmployeeId) continue;
    // Without merging each rung still goes through the same principal validation, so an ambiguous
    // or empty principal is refused exactly as it is on the merging path.
    addStep(steps, authority, authority.source, merge);
  }

  if (steps.length === 0) {
    throw new LeaveApprovalConfigurationError(
      "APPROVAL_CHAIN_EMPTY",
      "Rantai approval tidak memiliki approver yang valid.",
    );
  }
  return steps;
}
