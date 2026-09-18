export type LeaveApprovalSource =
  | "DIRECT_MANAGER"
  | "UNIT_APPROVER"
  | "GOVERNANCE_APPROVER";

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
) {
  const principalType = principal.principalType ?? "EMPLOYEE";
  const key = principalType === "ACCOUNT" ? principal.accountId : principal.employeeId;
  if (!key) {
    throw new LeaveApprovalConfigurationError(
      "APPROVAL_CHAIN_EMPTY",
      "Rantai approval berisi principal yang tidak valid.",
    );
  }
  const existing = steps.find((step) =>
    (step.principalType ?? "EMPLOYEE") === principalType &&
    (principalType === "ACCOUNT" ? step.accountId === key : step.employeeId === key));
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
  const steps: LeaveApprovalStep[] = [];
  for (const authority of input.authorities) {
    if ((authority.principalType ?? "EMPLOYEE") === "EMPLOYEE"
        && authority.employeeId === input.requesterEmployeeId) continue;
    addStep(steps, authority, authority.source);
  }

  if (steps.length === 0) {
    throw new LeaveApprovalConfigurationError(
      "APPROVAL_CHAIN_EMPTY",
      "Rantai approval tidak memiliki approver yang valid.",
    );
  }
  return steps;
}
