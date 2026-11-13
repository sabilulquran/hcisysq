import { getCurrentSession } from "@/lib/auth";
import type { AuthSession } from "@/types/hcis";

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
    /** ORG-010 amendment 2026-11-13: set with code ORGAN_PORTAL_ONLY. */
    readonly organPortalUrl: string | null = null,
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
    | { code?: string; message?: string; organPortalUrl?: string }
    | null;
  if (response.ok) return body as BoardDashboardData;
  const error = body as { code?: string; message?: string; organPortalUrl?: string } | null;
  throw new BoardDashboardApiError(
    response.status,
    error?.code ?? "BOARD_DASHBOARD_FAILED",
    error?.message ?? "Dashboard Organ Yayasan tidak dapat dimuat.",
    typeof error?.organPortalUrl === "string" ? error.organPortalUrl : null,
  );
}

/**
 * ORG-010 amendment 2026-11-13: what /board shows. With ORGAN_PORTAL_URL set on HCIS, an organ
 * account gets the approvals only and the dashboard is never requested. The API's 403
 * ORGAN_PORTAL_ONLY leads to the same view when /auth/me did not carry the link.
 */
export type BoardPageState =
  | { kind: "approvals-only"; principalType: string; organPortalUrl: string | null }
  | { kind: "dashboard"; principalType: string; data: BoardDashboardData }
  | { kind: "error"; principalType: string; message: string };

interface BoardPageSources {
  getSession: () => Promise<AuthSession | null>;
  getDashboard: () => Promise<BoardDashboardData>;
}

export async function loadBoardPage(
  sources: BoardPageSources = { getSession: getCurrentSession, getDashboard: getBoardDashboard },
): Promise<BoardPageState> {
  const session = await sources.getSession().catch(() => null);
  const principalType = session?.principal.principalType ?? "UNKNOWN";
  if (principalType === "FOUNDATION_BOARD" && session?.organPortalUrl) {
    return { kind: "approvals-only", principalType, organPortalUrl: session.organPortalUrl };
  }
  try {
    return { kind: "dashboard", principalType, data: await sources.getDashboard() };
  } catch (cause) {
    if (cause instanceof BoardDashboardApiError && cause.code === "ORGAN_PORTAL_ONLY") {
      return { kind: "approvals-only", principalType, organPortalUrl: cause.organPortalUrl };
    }
    return {
      kind: "error",
      principalType,
      message: cause instanceof BoardDashboardApiError ? cause.message : "Dashboard Organ Yayasan tidak dapat dimuat.",
    };
  }
}
