import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  redirect,
  type ParsedLocation,
} from "@tanstack/react-router";

import { legacyAttendanceRedirects } from "@/lib/attendanceNavigation";
import { getCurrentSession, landingPath, loginSearch, type LoginSearch } from "@/lib/auth";
import { canAccessAdminPath, canAccessBoard, canAccessEmployeeHcPath } from "@/lib/authorization";
import { AccountActivationPage } from "@/pages/AccountActivationPage";
import { AdminAccessPage } from "@/pages/AdminAccessPage";
import {
  AdminAdmsDeviceBiometricsRoutePage,
  AdminAdmsDeviceCommandsRoutePage,
  AdminAdmsDeviceDataRoutePage,
  AdminAdmsDeviceDiagnosticsRoutePage,
  AdminAdmsDeviceOperationsRoutePage,
  AdminAdmsDeviceMaintenanceRoutePage,
  AdminAdmsDeviceOverviewRoutePage,
  AdminAdmsDeviceSettingsRoutePage,
  AdminAdmsDeviceTransactionsRoutePage,
  AdminAdmsDeviceUsersRoutePage,
} from "@/pages/AdminAdmsDeviceRoutePages";
import { AdminAdmsBackOfficePage } from "@/pages/AdminAdmsBackOfficePage";
import { AdminAdmsGlobalTransactionsPage } from "@/pages/AdminAdmsGlobalTransactionsPage";
import { AdminAdmsDevicesPage } from "@/pages/AdminAdmsDevicesPage";
import { AdminAdmsAuditPage } from "@/pages/AdminAdmsAuditPage";
import { AdminAdmsHealthPage } from "@/pages/AdminAdmsHealthPage";
import { AdminAdmsJobsPage } from "@/pages/AdminAdmsJobsPage";
import { AdminAdmsUsersManagementPage } from "@/pages/AdminAdmsUsersManagementPage";
import { AdminAttendanceActionQueuePage } from "@/pages/AdminAttendanceActionQueuePage";
import { AdminAttendanceCorrectionsPage } from "@/pages/AdminAttendanceCorrectionsPage";
import { AdminAttendanceAssignmentsPage, AdminAttendanceLocationsPage, AdminAttendanceSchedulesPage } from "@/pages/AdminAttendanceConfigPages";
import { AdminAttendanceDailyPage } from "@/pages/AdminAttendanceDailyPage";
import { AdminAttendanceReportPrintPage } from "@/pages/AdminAttendanceReportPrintPage";
import { AdminAttendanceReportsPage } from "@/pages/AdminAttendanceReportsPage";
import { AdminAttendanceShiftSwapsPage } from "@/pages/AdminAttendanceShiftSwapsPage";
import { AdminAttendanceOvertimePage } from "@/pages/AdminAttendanceOvertimePage";
import { AdminAttendanceRosterPage } from "@/pages/AdminAttendanceRosterPage";
import { AdminAttendancePlannerPage } from "@/pages/AdminAttendancePlannerPage";
import { AdminAttendanceSummaryPage } from "@/pages/AdminAttendanceSummaryPage";
import { AdminComingSoonPage } from "@/pages/AdminComingSoonPage";
import { AdminEmployeeDetailRoutePage } from "@/pages/AdminEmployeeDetailRoutePage";
import { AdminEmployeeImportHistoryPage } from "@/pages/AdminEmployeeImportHistoryPage";
import { AdminDecisionDocumentsPage } from "@/pages/AdminDecisionDocumentsPage";
import { AdminEmploymentConsistencyPage } from "@/pages/AdminEmploymentConsistencyPage";
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

// Signed-out visitors go to the login entry with the page they asked for, so that Akun SQ
// sign-in can bring them back to it.
function signInRedirect(location: ParsedLocation) {
  return redirect({ to: "/", search: { returnTo: location.href } });
}

async function requirePrincipal(location: ParsedLocation, expected: PrincipalType) {
  const session = await getCurrentSession();
  if (!session) throw signInRedirect(location);
  if (session.principal.principalType !== expected) throw notFound();
  return session;
}

async function requireAdminPath(location: ParsedLocation, path: string) {
  const session = await getCurrentSession();
  if (!session) throw signInRedirect(location);
  if (!canAccessAdminPath(session, path)) throw notFound();
  return session;
}

async function requireBoardAccess(location: ParsedLocation) {
  const session = await getCurrentSession();
  if (!session) throw signInRedirect(location);
  if (!canAccessBoard(session)) throw notFound();
  return session;
}

async function requireEmployeeHcPath(location: ParsedLocation, path: string) {
  const session = await getCurrentSession();
  if (!session) throw signInRedirect(location);
  if (!canAccessEmployeeHcPath(session, path)) throw notFound();
  return session;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): LoginSearch => loginSearch(search),
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
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeDashboardPage,
});

const employeeAttendanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/attendance",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeAttendancePage,
});

const employeeMobileAttendanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/attendance/clock",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeMobileAttendancePage,
});

const employeeShiftSwapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/attendance/shift-swap",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeShiftSwapPage,
});

const employeeNotificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/notifications",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeNotificationsPage,
});

const employeeLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/leave",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeLeavePage,
});

const employeePayslipsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/payslips",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeePayslipsPage,
});

const employeeSpecialLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/leave/special",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeSpecialLeavePage,
});

const employeePlannedLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/leave/planned",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeePlannedLeavePage,
});

const employeeAttendanceResolutionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/attendance-resolution",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeAttendanceResolutionPage,
});

const employeeApprovalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/approvals",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeApprovalsPage,
});

const employeeServicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/services",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeServicesPage,
});

const employeeComingSoonRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/services/$serviceKey",
  beforeLoad: ({ location }) => requirePrincipal(location, "EMPLOYEE"),
  component: EmployeeComingSoonPage,
});

const hcLeaveValidationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/hc/leave",
  beforeLoad: ({ location }) => requireEmployeeHcPath(location, "/app/hc/leave"),
  component: HcLeaveValidationPage,
});

const hcPlannedLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/hc/planned-leave",
  beforeLoad: ({ location }) => requireEmployeeHcPath(location, "/app/hc/planned-leave"),
  component: HcPlannedLeavePage,
});

const hcAttendanceResolutionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/hc/attendance-resolution",
  beforeLoad: ({ location }) => requireEmployeeHcPath(location, "/app/hc/attendance-resolution"),
  component: HcAttendanceResolutionPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin"),
  component: AdminPage,
});

const adminEmployeesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employees",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/employees"),
  component: AdminEmployeesPage,
});

const adminEmployeeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employees/$employeeId",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/employees/$employeeId"),
  component: AdminEmployeeDetailRoutePage,
});

const adminEmployeeImportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employees/import",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/employees/import"),
  component: AdminEmployeeImportPage,
});

const adminEmployeeImportHistoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employees/imports",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/employees/imports"),
  component: AdminEmployeeImportHistoryPage,
});

const adminEmploymentConsistencyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employment/consistency",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/employment/consistency"),
  component: AdminEmploymentConsistencyPage,
});

const adminDecisionDocumentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/decision-documents",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/decision-documents"),
  component: AdminDecisionDocumentsPage,
});

const adminOrganizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/organization",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/organization"),
  component: AdminOrganizationPage,
});

// ATT-011-1: "Waktu & Kehadiran" sections (docs/domain/attendance-operational-simplification-spec.md §3).
const adminAttendanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance"),
  component: AdminAttendanceSummaryPage,
});

const adminAttendanceShiftsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/shifts",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/shifts"),
  component: AdminAttendanceSchedulesPage,
});

const adminAttendanceSchedulePatternsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/schedules",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/schedules"),
  component: AdminAttendanceAssignmentsPage,
});

const adminAttendanceScheduleCalendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/schedules/calendar",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/schedules/calendar"),
  component: AdminAttendancePlannerPage,
});

const adminAttendanceScheduleDatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/schedules/dates",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/schedules/dates"),
  component: AdminAttendanceRosterPage,
});

const adminAttendanceShiftSwapsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/schedules/swaps",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/schedules/swaps"),
  component: AdminAttendanceShiftSwapsPage,
});

const adminAttendanceDailyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/daily",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/daily"),
  component: AdminAttendanceDailyPage,
});

const adminAttendanceActionQueueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/action-queue",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/action-queue"),
  component: AdminAttendanceActionQueuePage,
});

const adminAttendanceCorrectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/corrections",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/corrections"),
  component: AdminAttendanceCorrectionsPage,
});

const adminAttendanceReportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/reports",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/reports"),
  component: AdminAttendanceReportsPage,
});

// ATT-014 §19.2: the standalone print document, without the admin shell.
const adminAttendanceReportPrintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/reports/print",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/reports/print"),
  component: AdminAttendanceReportPrintPage,
});

const adminAttendanceOvertimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/overtime",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/overtime"),
  component: AdminAttendanceOvertimePage,
});

const adminAttendanceLocationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/settings/locations",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/settings/locations"),
  component: AdminAttendanceLocationsPage,
});

// Routes before ATT-011 stay reachable for at least one release and forward to their new home.
const adminAttendanceLegacyRoutes = Object.entries(legacyAttendanceRedirects).map(([path, target]) => createRoute({
  getParentRoute: () => rootRoute,
  path,
  beforeLoad: () => {
    throw redirect({ href: target, replace: true });
  },
}));

const adminAdmsBackOfficeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/adms",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/adms"),
  component: AdminAdmsBackOfficePage,
});


const adminAdmsGlobalTransactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/adms/transactions",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/adms/transactions"),
  component: AdminAdmsGlobalTransactionsPage,
});

const adminAdmsUsersManagementRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/adms/users",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/adms/users"),
  component: AdminAdmsUsersManagementPage,
});

const adminAdmsJobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/adms/jobs",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/adms/jobs"),
  component: AdminAdmsJobsPage,
});

const adminAdmsHealthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/adms/health",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/adms/health"),
  component: AdminAdmsHealthPage,
});

const adminAdmsAuditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/adms/audit",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/adms/audit"),
  component: AdminAdmsAuditPage,
});

const adminAdmsDevicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices"),
  component: AdminAdmsDevicesPage,
});

const adminAdmsDeviceOverviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId"),
  component: AdminAdmsDeviceOverviewRoutePage,
});

const adminAdmsDeviceUsersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/users",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId/users"),
  component: AdminAdmsDeviceUsersRoutePage,
});

const adminAdmsDeviceBiometricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/biometrics",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId/biometrics"),
  component: AdminAdmsDeviceBiometricsRoutePage,
});

const adminAdmsDeviceDataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/data",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId/data"),
  component: AdminAdmsDeviceDataRoutePage,
});

const adminAdmsDeviceTransactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/transactions",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId/transactions"),
  component: AdminAdmsDeviceTransactionsRoutePage,
});

const adminAdmsDeviceCommandsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/commands",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId/commands"),
  component: AdminAdmsDeviceCommandsRoutePage,
});

const adminAdmsDeviceOperationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/operations",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId/operations"),
  component: AdminAdmsDeviceOperationsRoutePage,
});

const adminAdmsDeviceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/settings",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId/settings"),
  component: AdminAdmsDeviceSettingsRoutePage,
});

const adminAdmsDeviceMaintenanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/maintenance",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId/maintenance"),
  component: AdminAdmsDeviceMaintenanceRoutePage,
});

const adminAdmsDeviceDiagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/attendance/devices/$deviceId/diagnostics",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/attendance/devices/$deviceId/diagnostics"),
  component: AdminAdmsDeviceDiagnosticsRoutePage,
});

const adminLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/leave",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/leave"),
  component: AdminLeaveConfigurationPage,
});

const adminLeaveCalendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/leave/calendar",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/leave/calendar"),
  component: AdminLeaveCalendarPage,
});

const adminPayslipsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/payslips",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/payslips"),
  component: AdminPayslipsPage,
});

const adminAccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/access",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin/access"),
  component: AdminAccessPage,
});

const adminServicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/services",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin"),
  component: AdminServicesPage,
});

const adminComingSoonRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/services/$serviceKey",
  beforeLoad: ({ location }) => requireAdminPath(location, "/admin"),
  component: AdminComingSoonPage,
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/board",
  beforeLoad: ({ location }) => requireBoardAccess(location),
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
  adminEmploymentConsistencyRoute,
  adminDecisionDocumentsRoute,
  adminOrganizationRoute,
  adminAttendanceRoute,
  adminAttendanceShiftsRoute,
  adminAttendanceSchedulePatternsRoute,
  adminAttendanceScheduleCalendarRoute,
  adminAttendanceScheduleDatesRoute,
  adminAttendanceShiftSwapsRoute,
  adminAttendanceDailyRoute,
  adminAttendanceActionQueueRoute,
  adminAttendanceCorrectionsRoute,
  adminAttendanceReportsRoute,
  adminAttendanceReportPrintRoute,
  adminAttendanceOvertimeRoute,
  adminAttendanceLocationsRoute,
  ...adminAttendanceLegacyRoutes,
  adminAdmsBackOfficeRoute,
  adminAdmsGlobalTransactionsRoute,
  adminAdmsUsersManagementRoute,
  adminAdmsJobsRoute,
  adminAdmsHealthRoute,
  adminAdmsAuditRoute,
  adminAdmsDevicesRoute,
  adminAdmsDeviceOverviewRoute,
  adminAdmsDeviceUsersRoute,
  adminAdmsDeviceBiometricsRoute,
  adminAdmsDeviceDataRoute,
  adminAdmsDeviceTransactionsRoute,
  adminAdmsDeviceCommandsRoute,
  adminAdmsDeviceOperationsRoute,
  adminAdmsDeviceSettingsRoute,
  adminAdmsDeviceMaintenanceRoute,
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
