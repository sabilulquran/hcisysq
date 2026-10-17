export interface BoardDashboardData {
  // ORG-010 D7: the actor's e-mail is no longer returned.
  actor: {
    principalType: "FOUNDATION_BOARD" | "EMPLOYEE";
  };
  generatedAt: string;
  employees: {
    active: number;
    inactive: number;
    resigned: number;
    total: number;
  };
  entitlementGroups: {
    education: number;
    nonEducation: number;
    unclassified: number;
  };
  approvalReadiness: {
    activeEmployees: number;
    withDirectManager: number;
    withoutDirectManager: number;
    activeUnits: number;
    unitsWithApprover: number;
    unitsWithoutApprover: number;
  };
  workflow: {
    leaveInReview: number;
    hcValidationPending: number;
    attendanceResolutionOpen: number;
  };
  movements: {
    startedThisYear: number;
    endedThisYear: number;
  };
  unitDistribution: Array<{
    unitName: string;
    employeeCount: number;
  }>;
  employmentStatus: Array<{
    employmentStatus: string;
    employeeCount: number;
  }>;
  unavailableModules: {
    attendance: boolean;
    payroll: boolean;
  };
}

export class BoardDashboardApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BoardDashboardApiError";
  }
}

export async function getBoardDashboard(): Promise<BoardDashboardData> {
  const response = await fetch("/api/board/dashboard", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  const body = (await response.json().catch(() => null)) as
    | BoardDashboardData
    | { code?: string; message?: string }
    | null;
  if (response.ok) return body as BoardDashboardData;
  const error = body as { code?: string; message?: string } | null;
  throw new BoardDashboardApiError(
    response.status,
    error?.code ?? "BOARD_DASHBOARD_FAILED",
    error?.message ?? "Dashboard Organ Yayasan tidak dapat dimuat.",
  );
}
