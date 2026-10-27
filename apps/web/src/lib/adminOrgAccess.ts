import { AdminApiError } from "@/lib/adminEmployees";

export interface OrganizationUnitSummary {
  id: string;
  name: string;
  employeeCount: number;
  activeCount: number;
}

export interface PositionSummary {
  id: string;
  name: string;
  employeeCount: number;
  activeCount: number;
}

export interface OrganizationAdminResponse {
  units: OrganizationUnitSummary[];
  positions: PositionSummary[];
  reportingLines: {
    activeEmployees: number;
    assignedManagers: number;
    missingManagers: number;
  };
}

export interface RoleAssignment {
  id: string;
  accountId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  scopeType: "own" | "unit" | "organization";
  organizationalUnitId: string | null;
  organizationalUnitName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  reason: string | null;
  createdAt: string;
}

export interface EmployeeDetailResponse {
  employee: {
    id: string;
    employeeNumber: string;
    fullName: string;
    status: "active" | "inactive" | "resigned";
    employmentStatus: string | null;
    unitId: string | null;
    unitName: string | null;
    positionId: string | null;
    positionName: string | null;
    email: string | null;
    phone: string | null;
    education: string | null;
    startedOn: string | null;
    endedOn: string | null;
    managerEmployeeId: string | null;
    managerEmployeeNumber: string | null;
    managerFullName: string | null;
    accountId: string | null;
    accountEmail: string | null;
    accountStatus: "invited" | "active" | "suspended" | "inactive" | null;
  };
  managerCandidates: Array<{
    id: string;
    employeeNumber: string;
    fullName: string;
    unitName: string | null;
    positionName: string | null;
  }>;
  assignments: RoleAssignment[];
}

export interface AccessRole {
  id: string;
  roleKey: string;
  name: string;
  description: string | null;
  permissions: string[];
}

export interface AccessAccount {
  id: string;
  employeeId: string | null;
  email: string;
  principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
  status: "invited" | "active" | "suspended" | "inactive";
  employeeNumber: string | null;
  employeeName: string | null;
  employeeStatus: "active" | "inactive" | "resigned" | null;
  unitName: string | null;
  createdAt: string;
  assignments: RoleAssignment[];
}

export interface AccessAdminResponse {
  /** One page of accounts with their role assignments (ENG-LIST-001). */
  accounts: AccessAccount[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
  roles: AccessRole[];
  units: Array<{ id: string; name: string }>;
  summary: {
    accounts: number;
    active: number;
    invited: number;
    unaccountedActiveEmployees: number;
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const body = (await response.json().catch(() => null)) as
    | { code?: string; message?: string }
    | null;
  throw new AdminApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan tidak dapat diproses.",
  );
}

export async function getOrganizationAdmin(): Promise<OrganizationAdminResponse> {
  const response = await fetch("/api/admin/organization", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson<OrganizationAdminResponse>(response);
}

export async function getEmployeeDetail(employeeId: string): Promise<EmployeeDetailResponse> {
  const response = await fetch(`/api/admin/employees/${employeeId}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson<EmployeeDetailResponse>(response);
}

export async function updateEmployeeContact(
  employeeId: string,
  input: { email: string | null; phone: string | null },
): Promise<{ employeeId: string; email: string | null; phone: string | null; accountEmailChanged: false }> {
  const response = await fetch(`/api/admin/employees/${employeeId}/contact`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function updateDirectManager(
  employeeId: string,
  managerEmployeeId: string | null,
): Promise<{ employeeId: string; managerEmployeeId: string | null }> {
  const response = await fetch(`/api/admin/employees/${employeeId}/manager`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ managerEmployeeId }),
  });
  return readJson(response);
}

export interface AccessAdminQuery {
  q?: string;
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
}

export async function getAccessAdmin(query: AccessAdminQuery = {}): Promise<AccessAdminResponse> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.includeInactive) params.set("includeInactive", "true");
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  const suffix = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/admin/access${suffix}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson<AccessAdminResponse>(response);
}

export async function prepareEmployeeAccount(input: {
  employeeId: string;
  email?: string;
}): Promise<{
  id: string;
  employeeId: string;
  email: string;
  principalType: "EMPLOYEE";
  status: "invited";
}> {
  const response = await fetch("/api/admin/access/employee-accounts", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function updateAccountStatus(
  accountId: string,
  status: "invited" | "active" | "suspended" | "inactive",
): Promise<{ id: string; status: string }> {
  const response = await fetch(`/api/admin/access/accounts/${accountId}/status`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ status }),
  });
  return readJson(response);
}

export async function createRoleAssignment(
  accountId: string,
  input: {
    roleId: string;
    scopeType: "own" | "unit" | "organization";
    organizationalUnitId?: string | null;
    startsOn?: string | null;
    endsOn?: string | null;
    reason?: string | null;
  },
): Promise<{ id: string }> {
  const response = await fetch(`/api/admin/access/accounts/${accountId}/role-assignments`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function removeRoleAssignment(assignmentId: string): Promise<void> {
  const response = await fetch(`/api/admin/access/role-assignments/${assignmentId}`, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  await readJson<void>(response);
}

/** ORG-008-9: who holds the Kepala HC role against who holds the Kepala HC seat. Read-only. */
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
  seat: { positionKey: string; title: string | null; unitName: string | null; reason: string; setAt: string } | null;
  status: RoleSeatStatus;
  holders: Array<{ accountId: string; employeeId: string | null; name: string }>;
  incumbents: Array<{ employeeId: string; name: string; kind: "PRIMARY" | "ACTING"; accountId: string | null; hasRole: boolean }>;
  mismatches: RoleSeatMismatch[];
}

export async function getRoleSeatChecks(): Promise<{ items: RoleSeatCheck[] }> {
  const response = await fetch("/api/admin/access/role-seat-checks", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

/** Super Admin only. `positionKey: null` clears the seat; nothing is granted or revoked either way. */
export async function setRoleSeatLink(
  roleKey: string,
  input: { positionKey: string | null; reason: string },
): Promise<RoleSeatCheck> {
  const response = await fetch(`/api/admin/access/role-seat-links/${roleKey}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return readJson(response);
}
