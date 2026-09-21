import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { getCurrentSession, landingPath } from "@/lib/auth";
import { canAccessAdminPath, canAccessEmployeeHcPath } from "@/lib/authorization";
import { AccountActivationPage } from "@/pages/AccountActivationPage";
import { AdminAccessPage } from "@/pages/AdminAccessPage";
import {
  AdminAdmsDeviceBiometricsRoutePage,
  AdminAdmsDeviceCommandsRoutePage,
  AdminAdmsDeviceDiagnosticsRoutePage,
  AdminAdmsDeviceOperationsRoutePage,
  AdminAdmsDeviceOverviewRoutePage,
  AdminAdmsDeviceSettingsRoutePage,
  AdminAdmsDeviceTransactionsRoutePage,
  AdminAdmsDeviceUsersRoutePage,
} from "@/pages/AdminAdmsDeviceRoutePages";
import { AdminAdmsBackOfficePage } from "@/pages/AdminAdmsBackOfficePage";
import { AdminAdmsGlobalTransactionsPage } from "@/pages/AdminAdmsGlobalTransactionsPage";
import { AdminAdmsDevicesPage } from "@/pages/AdminAdmsDevicesPage";
import { AdminAttendancePage } from "@/pages/AdminAttendancePage";
import { AdminAttendanceAssignmentsPage, AdminAttendanceLocationsPage, AdminAttendanceSchedulesPage } from "@/pages/AdminAttendanceConfigPages";
import { AdminAttendanceClarificationsPage, AdminAttendanceMobileEvidencePage } from "@/pages/AdminAttendanceReviewPages";
import { AdminAttendanceReportsV2Page } from "@/pages/AdminAttendanceReportsV2Page";
import { AdminAttendanceShiftSwapsPage } from "@/pages/AdminAttendanceShiftSwapsPage";
import { AdminAttendanceOvertimePage } from "@/pages/AdminAttendanceOvertimePage";
import { AdminAttendanceRosterPage } from "@/pages/AdminAttendanceRosterPage";
import { AdminAttendanceWorkforceOverviewPage } from "@/pages/AdminAttendanceWorkforceOverviewPage";
import { AdminComingSoonPage } from "@/pages/AdminComingSoonPage";
import { AdminEmployeeDetailRoutePage } from "@/pages/AdminEmployeeDetailRoutePage";
import { AdminEmployeeImportHistoryPage } from "@/pages/AdminEmployeeImportHistoryPage";
import { AdminEmployeeImportPage } from "@/pages/AdminEmployeeImportPage";
import { AdminEmployeesPage } from "@/pages/AdminEmployeesPage";
import { AdminLeaveCalendarPage } from "@/pages/AdminLeaveCalendarPage";
import { AdminLeaveConfigurationPage } from "@/pages/AdminLeaveConfigurationPage";
import { AdminOrganizationPage } from "@/pages/AdminOrganizationPage";
import { AdminPage } from "@/pages/AdminPage";
import { AdminPayslipsPage } from "@/pages/AdminPayslipsPage";
import { AdminServicesPage } from "@/pages/AdminServicesPage";
import { EmployeeApprovalsPage } from "@/pages/EmployeeApprovalsPage";
import { EmployeeComingSoonPage } from "@/pages/EmployeeComingSoonPage";
import { EmployeeAttendancePage } from "@/pages/EmployeeAttendancePage";
import { EmployeeMobileAttendancePage } from "@/pages/EmployeeMobileAttendancePage";
import { EmployeeNotificationsPage } from "@/pages/EmployeeNotificationsPage";
import { EmployeeShiftSwapPage } from "@/pages/EmployeeShiftSwapPage";
import { EmployeeAttendanceResolutionPage } from "@/pages/EmployeeAttendanceResolutionPage";
import { EmployeeDashboardPage } from "@/pages/EmployeeDashboardPage";
import { EmployeeLeavePage } from "@/pages/EmployeeLeavePage";
import { EmployeePayslipsPage } from "@/pages/EmployeePayslipsPage";
import { EmployeePlannedLeavePage } from "@/pages/EmployeePlannedLeavePage";
import { EmployeeSpecialLeavePage } from "@/pages/EmployeeSpecialLeavePage";
import { EmployeeServicesPage } from "@/pages/EmployeeServicesPage";
import { FoundationBoardPage } from "@/pages/FoundationBoardPage";
import { HcAttendanceResolutionPage } from "@/pages/HcAttendanceResolutionPage";
import { HcLeaveValidationPage } from "@/pages/HcLeaveValidationPage";
import { HcPlannedLeavePage } from "@/pages/HcPlannedLeavePage";
import { LoginPage } from "@/pages/LoginPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import type { PrincipalType } from "@/types/hcis";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFoundPage,
});

async function requirePrincipal(expected: PrincipalType) {
  const session = await getCurrentSession();
  if (!session) throw redirect({ to: "/" });
  if (session.principal.principalType !== expected) throw notFound();
  return session;
}

async function requireAdminPath(path: string) {
  const session = await getCurrentSession();
  if (!session) throw redirect({ to: "/" });
  if (!canAccessAdminPath(session, path)) throw notFound();
  return session;
}

async function requireEmployeeHcPath(path: string) {
  const session = await getCurrentSession();
  if (!session) throw redirect({ to: "/" });
  if (!canAccessEmployeeHcPath(session, path)) throw notFound();
  return session;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    const session = await getCurrentSession();
    if (session) throw redirect({ to: landingPath(session) });
  },
  component: LoginPage,
});

const activationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activate",
  component: AccountActivationPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeDashboardPage,
});

const employeeAttendanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/attendance",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeAttendancePage,
});

const employeeMobileAttendanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/attendance/clock",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeMobileAttendancePage,
});

const employeeShiftSwapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/attendance/shift-swap",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeShiftSwapPage,
});

const employeeNotificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/notifications",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeNotificationsPage,
});

const employeeLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/leave",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeLeavePage,
});

const employeePayslipsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/payslips",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeePayslipsPage,
});

const employeeSpecialLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/leave/special",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeSpecialLeavePage,
});

const employeePlannedLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/leave/planned",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeePlannedLeavePage,
});

const employeeAttendanceResolutionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/attendance-resolution",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeAttendanceResolutionPage,
});

const employeeApprovalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/approvals",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeApprovalsPage,
});

const employeeServicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/services",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeServicesPage,
});

const employeeComingSoonRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/services/$serviceKey",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: EmployeeComingSoonPage,
});

const hcLeaveValidationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/hc/leave",
  beforeLoad: () => requireEmployeeHcPath("/app/hc/leave"),
  component: HcLeaveValidationPage,
});

const hcPlannedLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/hc/planned-leave",
  beforeLoad: () => requireEmployeeHcPath("/app/hc/planned-leave"),
  component: HcPlannedLeavePage,
});

const hcAttendanceResolutionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/hc/attendance-resolution",
  beforeLoad: () => requireEmployeeHcPath("/app/hc/attendance-resolution"),
  component: HcAttendanceResolutionPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: () => requireAdminPath("/admin"),
  component: AdminPage,
});

const adminEmployeesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employees",
  beforeLoad: () => requireAdminPath("/admin/employees"),
  component: AdminEmployeesPage,
});

const adminEmployeeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employees/$employeeId",
  beforeLoad: () => requireAdminPath("/admin/employees/$employeeId"),
  component: AdminEmployeeDetailRoutePage,
});

const adminEmployeeImportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employees/import",
  beforeLoad: () => requireAdminPath("/admin/employees/import"),
  component: AdminEmployeeImportPage,
});

const adminEmployeeImportHistoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employees/imports",
  beforeLoad: () => requireAdminPath("/admin/employees/imports"),
  component: AdminEmployeeImportHistoryPage,
});

const adminOrganizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/organization",
  beforeLoad: () => requireAdminPath("/admin/organization"),
  component: AdminOrganizationPage,
});

const adminAttendanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance",
  beforeLoad: () => requireAdminPath("/admin/attendance"),
  component: AdminAttendancePage,
});

const adminAttendanceWorkforceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce"),
  component: AdminAttendanceWorkforceOverviewPage,
});

const adminAttendanceLocationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce/locations",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce/locations"),
  component: AdminAttendanceLocationsPage,
});

const adminAttendanceSchedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce/schedules",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce/schedules"),
  component: AdminAttendanceSchedulesPage,
});

const adminAttendanceAssignmentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce/assignments",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce/assignments"),
  component: AdminAttendanceAssignmentsPage,
});

const adminAttendanceRosterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce/roster",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce/roster"),
  component: AdminAttendanceRosterPage,
});

const adminAttendanceClarificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce/clarifications",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce/clarifications"),
  component: AdminAttendanceClarificationsPage,
});

const adminAttendanceMobileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce/mobile",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce/mobile"),
  component: AdminAttendanceMobileEvidencePage,
});


const adminAttendanceOvertimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce/overtime",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce/overtime"),
  component: AdminAttendanceOvertimePage,
});

const adminAttendanceShiftSwapsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce/shift-swaps",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce/shift-swaps"),
  component: AdminAttendanceShiftSwapsPage,
});

const adminAttendanceReportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/workforce/reports",
  beforeLoad: () => requireAdminPath("/admin/attendance/workforce/reports"),
  component: AdminAttendanceReportsV2Page,
});

const adminAdmsBackOfficeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/adms",
  beforeLoad: () => requireAdminPath("/admin/attendance/adms"),
  component: AdminAdmsBackOfficePage,
});


const adminAdmsGlobalTransactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/adms/transactions",
  beforeLoad: () => requireAdminPath("/admin/attendance/adms/transactions"),
  component: AdminAdmsGlobalTransactionsPage,
});

const adminAdmsDevicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices",
  beforeLoad: () => requireAdminPath("/admin/attendance/devices"),
  component: AdminAdmsDevicesPage,
});

const adminAdmsDeviceOverviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId",
  beforeLoad: () => requireAdminPath("/admin/attendance/devices/$deviceId"),
  component: AdminAdmsDeviceOverviewRoutePage,
});

const adminAdmsDeviceUsersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/users",
  beforeLoad: () => requireAdminPath("/admin/attendance/devices/$deviceId/users"),
  component: AdminAdmsDeviceUsersRoutePage,
});

const adminAdmsDeviceBiometricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/biometrics",
  beforeLoad: () => requireAdminPath("/admin/attendance/devices/$deviceId/biometrics"),
  component: AdminAdmsDeviceBiometricsRoutePage,
});

const adminAdmsDeviceTransactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/transactions",
  beforeLoad: () => requireAdminPath("/admin/attendance/devices/$deviceId/transactions"),
  component: AdminAdmsDeviceTransactionsRoutePage,
});

const adminAdmsDeviceCommandsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/commands",
  beforeLoad: () => requireAdminPath("/admin/attendance/devices/$deviceId/commands"),
  component: AdminAdmsDeviceCommandsRoutePage,
});

const adminAdmsDeviceOperationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/operations",
  beforeLoad: () => requireAdminPath("/admin/attendance/devices/$deviceId/operations"),
  component: AdminAdmsDeviceOperationsRoutePage,
});

const adminAdmsDeviceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/settings",
  beforeLoad: () => requireAdminPath("/admin/attendance/devices/$deviceId/settings"),
  component: AdminAdmsDeviceSettingsRoutePage,
});

const adminAdmsDeviceDiagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/diagnostics",
  beforeLoad: () => requireAdminPath("/admin/attendance/devices/$deviceId/diagnostics"),
  component: AdminAdmsDeviceDiagnosticsRoutePage,
});

const adminLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/leave",
  beforeLoad: () => requireAdminPath("/admin/leave"),
  component: AdminLeaveConfigurationPage,
});

const adminLeaveCalendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/leave/calendar",
  beforeLoad: () => requireAdminPath("/admin/leave/calendar"),
  component: AdminLeaveCalendarPage,
});

const adminPayslipsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/payslips",
  beforeLoad: () => requireAdminPath("/admin/payslips"),
  component: AdminPayslipsPage,
});

const adminAccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/access",
  beforeLoad: () => requireAdminPath("/admin/access"),
  component: AdminAccessPage,
});

const adminServicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/services",
  beforeLoad: () => requireAdminPath("/admin"),
  component: AdminServicesPage,
});

const adminComingSoonRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/services/$serviceKey",
  beforeLoad: () => requireAdminPath("/admin"),
  component: AdminComingSoonPage,
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/board",
  beforeLoad: () => requirePrincipal("FOUNDATION_BOARD"),
  component: FoundationBoardPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  activationRoute,
  appRoute,
  employeeAttendanceRoute,
  employeeMobileAttendanceRoute,
  employeeShiftSwapRoute,
  employeeNotificationsRoute,
  employeeLeaveRoute,
  employeePayslipsRoute,
  employeeSpecialLeaveRoute,
  employeePlannedLeaveRoute,
  employeeAttendanceResolutionRoute,
  employeeApprovalsRoute,
  employeeServicesRoute,
  employeeComingSoonRoute,
  hcLeaveValidationRoute,
  hcPlannedLeaveRoute,
  hcAttendanceResolutionRoute,
  adminRoute,
  adminEmployeesRoute,
  adminEmployeeDetailRoute,
  adminEmployeeImportRoute,
  adminEmployeeImportHistoryRoute,
  adminOrganizationRoute,
  adminAttendanceRoute,
  adminAttendanceWorkforceRoute,
  adminAttendanceLocationsRoute,
  adminAttendanceSchedulesRoute,
  adminAttendanceAssignmentsRoute,
  adminAttendanceRosterRoute,
  adminAttendanceClarificationsRoute,
  adminAttendanceMobileRoute,
  adminAttendanceOvertimeRoute,
  adminAttendanceShiftSwapsRoute,
  adminAttendanceReportsRoute,
  adminAdmsBackOfficeRoute,
  adminAdmsGlobalTransactionsRoute,
  adminAdmsDevicesRoute,
  adminAdmsDeviceOverviewRoute,
  adminAdmsDeviceUsersRoute,
  adminAdmsDeviceBiometricsRoute,
  adminAdmsDeviceTransactionsRoute,
  adminAdmsDeviceCommandsRoute,
  adminAdmsDeviceOperationsRoute,
  adminAdmsDeviceSettingsRoute,
  adminAdmsDeviceDiagnosticsRoute,
  adminLeaveRoute,
  adminLeaveCalendarRoute,
  adminPayslipsRoute,
  adminAccessRoute,
  adminServicesRoute,
  adminComingSoonRoute,
  boardRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
