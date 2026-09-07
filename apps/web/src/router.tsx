import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { getCurrentSession, landingPath } from "@/lib/auth";
import { canAccessAdminPath } from "@/lib/authorization";
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
import { AdminAdmsDevicesPage } from "@/pages/AdminAdmsDevicesPage";
import { AdminAttendancePage } from "@/pages/AdminAttendancePage";
import { AdminEmployeeDetailRoutePage } from "@/pages/AdminEmployeeDetailRoutePage";
import { AdminEmployeeImportHistoryPage } from "@/pages/AdminEmployeeImportHistoryPage";
import { AdminEmployeeImportPage } from "@/pages/AdminEmployeeImportPage";
import { AdminEmployeesPage } from "@/pages/AdminEmployeesPage";
import { AdminLeaveCalendarPage } from "@/pages/AdminLeaveCalendarPage";
import { AdminLeaveConfigurationPage } from "@/pages/AdminLeaveConfigurationPage";
import { AdminOrganizationPage } from "@/pages/AdminOrganizationPage";
import { AdminPage } from "@/pages/AdminPage";
import { AdminPayslipsPage } from "@/pages/AdminPayslipsPage";
import { EmployeeApprovalsPage } from "@/pages/EmployeeApprovalsPage";
import { EmployeeAttendancePage } from "@/pages/EmployeeAttendancePage";
import { EmployeeAttendanceResolutionPage } from "@/pages/EmployeeAttendanceResolutionPage";
import { EmployeeDashboardPage } from "@/pages/EmployeeDashboardPage";
import { EmployeeLeavePage } from "@/pages/EmployeeLeavePage";
import { EmployeePayslipsPage } from "@/pages/EmployeePayslipsPage";
import { EmployeePlannedLeavePage } from "@/pages/EmployeePlannedLeavePage";
import { EmployeeSpecialLeavePage } from "@/pages/EmployeeSpecialLeavePage";
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

const hcLeaveValidationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/hc/leave",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: HcLeaveValidationPage,
});

const hcPlannedLeaveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/hc/planned-leave",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
  component: HcPlannedLeavePage,
});

const hcAttendanceResolutionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/hc/attendance-resolution",
  beforeLoad: () => requirePrincipal("EMPLOYEE"),
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
  employeeLeaveRoute,
  employeePayslipsRoute,
  employeeSpecialLeaveRoute,
  employeePlannedLeaveRoute,
  employeeAttendanceResolutionRoute,
  employeeApprovalsRoute,
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
