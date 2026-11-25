import { AdminApiError } from "@/lib/adminEmployees";
import type {
  AnnualLeavePeriodKey,
  AnnualLeaveQuotaScheme,
} from "@/lib/employeeLeave";

export type LeaveEntitlementGroup = "education" | "non_education";

export interface LeavePolicySummary {
  key: string;
  name: string;
  requestMode: "individual" | "organization_event" | "dispensation";
  lineHandling: "approval" | "notify" | "none";
  hcHandling: "notify" | "validate" | "approve" | "none";
  entitlementGroup: LeaveEntitlementGroup | "all";
  minimumNoticeDays: number | null;
  evidenceRequirement: "none" | "required" | "required_deferred_allowed" | "conditional";
  emergencyNoticeAllowed: boolean;
  annualEntitlementDays?: number;
  eligibilityMonths?: number;
  /**
   * LEAVE-003 R2: no `periodLimitDays` here. The limit depends on the leave date, so it comes from
   * `annualQuota` on the same response.
   */
  carryForwardEnabled?: boolean;
  notes: string[];
}

export interface LeaveUnitConfiguration {
  id: string;
  name: string;
  activeEmployeeCount: number;
  approverEmployeeId: string | null;
  approverName: string | null;
}

export interface LeaveEmployeeConfiguration {
  id: string;
  fullName: string;
  employeeNumber: string;
  status: "active" | "inactive" | "resigned";
  unitId: string | null;
  unitName: string | null;
  positionName: string | null;
  directManagerEmployeeId: string | null;
  directManagerName: string | null;
  leaveEntitlementGroup: LeaveEntitlementGroup | null;
  /**
   * ORG-004 D-R6: sumber yang benar-benar dibaca runtime untuk orang ini **pada Cuti Tahunan**.
   * `STRUCTURE` berarti penyetujunya datang dari bagan, sehingga kolom atasan di baris ini tidak
   * dibaca alur itu. Mode rollout disimpan per kunci workflow, jadi alur lain (cuti terencana,
   * lembur, perjalanan dinas) dapat tetap `LEGACY` pada orang yang sama dan masih membacanya.
   */
  approvalSource?: "LEGACY" | "SHADOW" | "STRUCTURE";
}

/**
 * LEAVE-003 R2: the Cuti Tahunan quota rule as the API reports it, so the screen states what
 * submission actually enforces instead of a figure written into the page.
 */
export interface AnnualQuotaConfiguration {
  entitlementDays: number;
  quarterLimitDays: number;
  semesterLimitDays: number;
  /** The day the semester rule starts applying, by leave date; null while it never does. */
  semesterEffectiveFrom: string | null;
  /** The rule in force today. */
  scheme: "QUARTER" | "SEMESTER";
  periodLimitDays: number;
}

export interface LeaveConfigurationResponse {
  policies: LeavePolicySummary[];
  annualQuota?: AnnualQuotaConfiguration;
  units: LeaveUnitConfiguration[];
  employees: LeaveEmployeeConfiguration[];
  summary: {
    activeUnits: number;
    unitApproverConfigured: number;
    activeEmployees: number;
    directManagerConfigured: number;
    /** Bagian dari `directManagerConfigured` yang terpenuhi bagan, bukan kolom atasan lama. */
    structureRouted?: number;
    entitlementGroupConfigured: number;
  };
}

export interface LeaveApprovalPreviewResponse {
  employee: LeaveEmployeeConfiguration & {
    startedOn: string | null;
    unitApproverEmployeeId: string | null;
    unitApproverName: string | null;
  };
  referenceDate: string;
  approvalChain: Array<{
    employeeId: string;
    sources: Array<"DIRECT_MANAGER" | "UNIT_APPROVER">;
  }>;
  annualLeave: null | {
    annualEntitlementDays: number;
    eligibilityMonths: number;
    eligibleFrom: string;
    eligible: boolean;
    referenceDate: string;
    year: number;
    availableNowDays: number;
    /** LEAVE-003 R2: this endpoint reads the same year view, so it also reports semesters. */
    quotaScheme: AnnualLeaveQuotaScheme;
    semesterEffectiveFrom: string | null;
    currentPeriodKey: AnnualLeavePeriodKey;
    currentPeriodLimitDays: number;
    eligiblePeriodAllocationDaysInYear: number;
    carryForwardEnabled: false;
    periods: Array<{
      key: AnnualLeavePeriodKey;
      label: string;
      allocationDays: number;
      usedDays: number;
      remainingDays: number;
      usableFrom: string | null;
      status: "not_eligible" | "upcoming" | "current" | "closed";
    }>;
  };
  warnings: Array<{ code: string; message: string }>;
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  const body = (await response.json().catch(() => null)) as
    | { code?: string; message?: string }
    | null;
  throw new AdminApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan tidak dapat diproses.",
  );
}

export async function getLeaveConfiguration(): Promise<LeaveConfigurationResponse> {
  const response = await fetch("/api/admin/leave/configuration", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

export async function updateUnitLeaveApprover(
  unitId: string,
  employeeId: string | null,
): Promise<{ unitId: string; approverEmployeeId: string | null }> {
  const response = await fetch(`/api/admin/leave/units/${unitId}/approver`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ employeeId }),
  });
  return readJson(response);
}

export async function updateLeaveEntitlementGroup(
  employeeId: string,
  group: LeaveEntitlementGroup | null,
): Promise<{ employeeId: string; leaveEntitlementGroup: LeaveEntitlementGroup | null }> {
  const response = await fetch(
    `/api/admin/leave/employees/${employeeId}/entitlement-group`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ group }),
    },
  );
  return readJson(response);
}

export async function getLeaveApprovalPreview(
  employeeId: string,
  date?: string,
): Promise<LeaveApprovalPreviewResponse> {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  const suffix = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/admin/leave/employees/${employeeId}/preview${suffix}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}
