import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminNavigation } from "@/layouts/AdminShell";
import { canAccessAdminPath, canAccessBoard, canAccessEmployeeHcPath, canManageRoleAssignments } from "@/lib/authorization";
import { landingPath } from "@/lib/auth";
import type { AuthSession, PrincipalType } from "@/types/hcis";

function session(principalType: PrincipalType, permissions: string[]): AuthSession {
  return { principal: { id: "synthetic", email: "synthetic@example.invalid", principalType },
    expiresAt: "2099-01-01T00:00:00Z", authorization: { organizationPermissions: permissions } };
}
const hcAdmin = [
  "employees.manage", "employees.read.all", "leave.validate", "leave.evidence.read",
  "attendance.resolution.read", "attendance.resolution.manage", "payslips.import", "payslips.publish",
  "organization.manage", "access.manage", "leave.configuration.manage",
  "attendance.records.manage", "attendance.schedule.manage", "attendance.policy.manage",
  "attendance.clarification.manage", "attendance.reports.read", "attendance.overtime.manage",
  "attendance.shift_swap.manage", "attendance.devices.read", "attendance.devices.configure",
  "attendance.devices.operate", "attendance.devices.export",
];
const workforcePermissions = ["attendance.schedule.manage", "attendance.policy.manage", "attendance.clarification.manage", "attendance.reports.read", "attendance.overtime.manage", "attendance.shift_swap.manage"];

describe("EMP-012 employee cards in the admin menu", () => {
  it("lists Kartu Pegawai for an employee_cards.manage holder, even with nothing else", () => {
    for (const compact of [false, true]) {
      const holder = renderToStaticMarkup(<AdminNavigation active="employee-cards" session={session("EMPLOYEE", ["employee_cards.manage"])} compact={compact} />);
      expect(holder).toContain('href="/admin/employee-cards"');
      expect(holder).toContain('aria-current="page"');
    }
  });

  it("hides it from HC permissions without employee_cards.manage and from the legacy Super Admin", () => {
    expect(renderToStaticMarkup(<AdminNavigation active="overview" session={session("EMPLOYEE", hcAdmin)} />)).not.toContain('href="/admin/employee-cards"');
    expect(renderToStaticMarkup(<AdminNavigation active="overview" session={session("SUPER_ADMIN", hcAdmin)} />)).not.toContain('href="/admin/employee-cards"');
  });
});

describe("EMP-011 employee documents", () => {
  it("lists Dokumen Pegawai only for an employee_documents.read holder, even with nothing else", () => {
    const holder = renderToStaticMarkup(<AdminNavigation active="employee-documents" session={session("EMPLOYEE", ["employee_documents.read"])} />);
    expect(holder).toContain('href="/admin/employee-documents"');
    expect(canAccessAdminPath(session("EMPLOYEE", ["employee_documents.read"]), "/admin")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["employee_documents.read"]), "/admin/employee-documents")).toBe(true);
  });

  it("D-09: never through other HC permissions, a unit role or the legacy Super Admin", () => {
    const neighbours = session("EMPLOYEE", [...hcAdmin, "employees.read.unit", "employment.read", "documents.read", "employee_cards.manage"]);
    expect(canAccessAdminPath(neighbours, "/admin/employee-documents")).toBe(false);
    expect(renderToStaticMarkup(<AdminNavigation active="overview" session={neighbours} />)).not.toContain('href="/admin/employee-documents"');
    expect(canAccessAdminPath(session("SUPER_ADMIN", hcAdmin), "/admin/employee-documents")).toBe(false);
    expect(canAccessAdminPath(session("FOUNDATION_BOARD", ["employee_documents.read"]), "/admin/employee-documents")).toBe(false);
  });
});

describe("DOC-002-F document corrector", () => {
  const corrector = session("EMPLOYEE", ["documents.read", "documents.correct"]);

  it("reaches the admin shell and the documents screen with its own role alone", () => {
    // The shell used to bounce this role to "/", so the one account that may revoke a letter
    // could never open the screen that revokes it.
    expect(canAccessAdminPath(corrector, "/admin")).toBe(true);
    expect(canAccessAdminPath(corrector, "/admin/documents")).toBe(true);
    expect(canAccessAdminPath(corrector, "/admin/employees")).toBe(false);
  });

  it("finds the screen in the menu, which an account without documents.read does not", () => {
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(<AdminNavigation active="documents" session={corrector} compact={compact} />);
      expect(html).toContain('href="/admin/documents"');
      expect(html).not.toContain('href="/admin/employees"');
      const other = renderToStaticMarkup(
        <AdminNavigation active="overview" session={session("EMPLOYEE", ["employees.manage"])} compact={compact} />,
      );
      expect(other).not.toContain('href="/admin/documents"');
    }
  });

  it("does not open the shell to documents.correct without documents.read", () => {
    expect(canAccessAdminPath(session("EMPLOYEE", ["documents.correct"]), "/admin")).toBe(false);
  });
});

describe("PAY-003 payroll screens", () => {
  const board = session("FOUNDATION_BOARD", ["board.read"]);
  const employee = session("EMPLOYEE", ["payslips.read.own"]);

  it("opens for exactly the permissions the API lets read a period", () => {
    // PERIOD_READ_PERMISSIONS in the payroll lifecycle. Opening it wider would
    // show a menu entry that leads to a 403.
    for (const permission of [
      "payroll.periods.manage",
      "payroll.approve",
      "payroll.reopen.approve",
      "payroll.payments.confirm",
      "payroll.reports.read.organization",
    ]) {
      expect(canAccessAdminPath(session("EMPLOYEE", [permission]), "/admin/payroll")).toBe(true);
    }
  });

  it("stays closed to a permission that may act on a period but not read one", () => {
    for (const permission of ["payroll.calculate", "payroll.inputs.manage", "payroll.submit", "payroll.transfers.read.organization"]) {
      expect(canAccessAdminPath(session("EMPLOYEE", [permission]), "/admin/payroll")).toBe(false);
    }
  });

  it("covers the period screen as well as the list", () => {
    const director = session("EMPLOYEE", ["payroll.approve"]);
    expect(canAccessAdminPath(director, "/admin/payroll/8a1f")).toBe(true);
  });

  it("stays closed to the Foundation Board and to an ordinary employee", () => {
    expect(canAccessAdminPath(board, "/admin/payroll")).toBe(false);
    expect(canAccessAdminPath(employee, "/admin/payroll")).toBe(false);
  });

  it("opens the reference screen for the permissions that own the reference data", () => {
    // A different set from the periods: finance holds the loan register and
    // nothing else here, human capital the policy and the profiles.
    for (const permission of ["payroll.policies.manage", "payroll.loans.manage", "payroll.profiles.manage"]) {
      expect(canAccessAdminPath(session("EMPLOYEE", [permission]), "/admin/payroll/reference")).toBe(true);
    }
  });

  it("does not let a period reader into the reference data", () => {
    // Approving a period is not the same as rewriting the policy it was
    // calculated with.
    expect(canAccessAdminPath(session("EMPLOYEE", ["payroll.approve"]), "/admin/payroll/reference")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["payroll.reports.read.organization"]), "/admin/payroll/reference")).toBe(false);
  });

  it("does not let a reference permission into the period screens", () => {
    expect(canAccessAdminPath(session("EMPLOYEE", ["payroll.loans.manage"]), "/admin/payroll")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["payroll.profiles.manage"]), "/admin/payroll/8a1f")).toBe(false);
  });

  it("is not opened by holding a payslip permission", () => {
    expect(canAccessAdminPath(session("EMPLOYEE", ["payslips.import", "payslips.publish"]), "/admin/payroll")).toBe(false);
  });
});

describe("AUTH-011 backend-derived admin navigation", () => {
  it("shows intended HC admin surfaces in both desktop and compact menus", () => {
    const actor = session("EMPLOYEE", hcAdmin);
    expect(landingPath(actor)).toBe("/app");
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(<AdminNavigation active="overview" session={actor} compact={compact} />);
      for (const path of ["/admin/employees", "/admin/organization", "/admin/access", "/admin/attendance", "/admin/payslips", "/admin/leave"]) {
        expect(html).toContain(`href="${path}"`);
        expect(canAccessAdminPath(actor, path)).toBe(true);
      }
      expect(html).toContain('href="/admin/attendance/adms"');
      expect(html).toContain("Mesin Fingerprint");
      expect(html).not.toContain('href="/admin/attendance/devices"');
      expect(html).not.toContain("Transaksi Lintas Mesin");
    }
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/operations")).toBe(true);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/diagnostics")).toBe(false);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/settings")).toBe(true);
    // DOC-001/DOC-002: the screen follows documents.read alone, not the rest of this fixture.
    expect(canAccessAdminPath(actor, "/admin/documents")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["documents.read"]), "/admin/documents")).toBe(true);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/documents")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["announcements.read"]), "/admin/announcements")).toBe(true);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/announcements")).toBe(false);
    expect(canAccessAdminPath(actor, "/admin/trips")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["trips.read"]), "/admin/trips")).toBe(true);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/trips")).toBe(false);
    // ATT-015: HC-only, never through Super Admin legacy compatibility.
    expect(canAccessAdminPath(actor, "/admin/attendance/arrangements")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["attendance.arrangements.read"]), "/admin/attendance/arrangements")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["attendance.schedule.manage"]), "/admin/attendance/arrangements")).toBe(false);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/attendance/arrangements")).toBe(false);
    expect(canAccessAdminPath(actor, "/admin/performance")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["performance.read"]), "/admin/performance")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["performance.manage"]), "/admin/performance")).toBe(false);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/performance")).toBe(false);
    expect(canAccessAdminPath(actor, "/admin/loans")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["loans.read"]), "/admin/loans")).toBe(true);
    // LOAN-001: Finance holding only the loan register still reaches the admin shell.
    expect(canAccessAdminPath(session("EMPLOYEE", ["loans.read", "loans.manage"]), "/admin")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["payroll.loans.manage"]), "/admin/loans")).toBe(false);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/loans")).toBe(false);
    // EMP-012: employee_cards.manage only; other HC permissions and Super Admin legacy do not open it.
    expect(canAccessAdminPath(actor, "/admin/employee-cards")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["employee_cards.manage"]), "/admin/employee-cards")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["employee_cards.manage"]), "/admin/employee-cards/print")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["employee_cards.manage"]), "/admin")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["employees.manage", "documents.manage"]), "/admin/employee-cards")).toBe(false);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/employee-cards/print")).toBe(false);
    // ORG-012: committees.read only; other HC permissions and Super Admin legacy do not open it.
    expect(canAccessAdminPath(actor, "/admin/committees")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["committees.read"]), "/admin/committees")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["committees.read"]), "/admin")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["committees.manage"]), "/admin/committees")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["organization.manage", "training.manage"]), "/admin/committees")).toBe(false);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/committees")).toBe(false);
    expect(canAccessAdminPath(session("FOUNDATION_BOARD", ["committees.read"]), "/admin/committees")).toBe(false);
    // HELP-001: help.manage only; other HC permissions and Super Admin legacy do not open it.
    expect(canAccessAdminPath(actor, "/admin/help")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["help.manage"]), "/admin/help")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["help.manage"]), "/admin")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["announcements.manage", "training.manage"]), "/admin/help")).toBe(false);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/help")).toBe(false);
    expect(canAccessAdminPath(actor, "/admin/training")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["training.read"]), "/admin/training")).toBe(true);
    expect(canAccessAdminPath(session("SUPER_ADMIN", []), "/admin/training")).toBe(false);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/data")).toBe(true);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/maintenance")).toBe(true);
    expect(canAccessAdminPath(actor, "/admin/attendance/devices/opaque/biometrics")).toBe(false);
    expect(canAccessEmployeeHcPath(actor, "/app/hc/leave")).toBe(true);
    expect(canAccessEmployeeHcPath(actor, "/app/hc/planned-leave")).toBe(true);
    // LEAVE-009: the critical-leave queue opens for HC; the API checks leave.hc.approve.
    expect(canAccessEmployeeHcPath(actor, "/app/hc/critical-leave")).toBe(true);
    expect(canAccessEmployeeHcPath(session("EMPLOYEE", []), "/app/hc/critical-leave")).toBe(false);
    expect(canAccessAdminPath(actor, "/admin/leave/critical-periods")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["leave.validate"]), "/admin/leave/critical-periods")).toBe(false);
    expect(canAccessEmployeeHcPath(actor, "/app/hc/attendance-resolution")).toBe(true);
    // Owner decision 2026-10-16: HC admins reach /admin/access but cannot grant or remove roles.
    expect(hcAdmin).not.toContain("access.roles.assign");
    expect(canManageRoleAssignments(actor)).toBe(false);
  });

  it("does not infer permissions from Employee, operational HC or legacy principal labels", () => {
    for (const actor of [session("EMPLOYEE", []), session("EMPLOYEE", ["leave.validate"]), session("SUPER_ADMIN", [])]) {
      expect(canAccessAdminPath(actor, "/admin")).toBe(false);
      expect(canAccessAdminPath(actor, "/admin/access")).toBe(false);
      expect(renderToStaticMarkup(<AdminNavigation active="overview" session={actor} />)).not.toContain("href=");
    }
    expect(canAccessEmployeeHcPath(session("EMPLOYEE", ["leave.validate"]), "/app/hc/leave")).toBe(true);
    expect(canAccessEmployeeHcPath(session("EMPLOYEE", ["leave.validate"]), "/app/hc/attendance-resolution")).toBe(false);
    expect(canAccessEmployeeHcPath(session("EMPLOYEE", []), "/app/hc/leave")).toBe(false);
    expect(canAccessEmployeeHcPath(session("FOUNDATION_BOARD", ["leave.validate"]), "/app/hc/leave")).toBe(false);
    const missingContext: AuthSession = { principal: session("SUPER_ADMIN", []).principal, expiresAt: "2099-01-01T00:00:00Z" };
    expect(canAccessAdminPath(missingContext, "/admin")).toBe(false);
    expect(landingPath(session("EMPLOYEE", []))).toBe("/app");
  });

  it("exposes attendance workspace child routes and ADMS back office by explicit permissions", () => {
    const workforce = session("EMPLOYEE", workforcePermissions);
    for (const path of [
      "/admin/attendance",
      "/admin/attendance/shifts",
      "/admin/attendance/schedules",
      "/admin/attendance/schedules/dates",
      "/admin/attendance/schedules/swaps",
      "/admin/attendance/daily",
      "/admin/attendance/corrections",
      "/admin/attendance/reports",
      "/admin/attendance/overtime",
      "/admin/attendance/settings/locations",
    ]) {
      expect(canAccessAdminPath(workforce, path)).toBe(true);
    }
    expect(canAccessAdminPath(workforce, "/admin/attendance/adms")).toBe(false);
    // Pre-ATT-011 paths are redirects now, never screens of their own.
    expect(canAccessAdminPath(workforce, "/admin/attendance/workforce/reports")).toBe(false);
    expect(canAccessAdminPath(workforce, "/admin/attendance/settings/recalculate")).toBe(false);
    expect(canAccessAdminPath(workforce, "/admin/attendance/calculation")).toBe(false);
    expect(canAccessAdminPath(workforce, "/admin/attendance/clarifications")).toBe(false);
    expect(canAccessAdminPath(workforce, "/admin/attendance/mobile-evidence")).toBe(false);

    const deviceOperator = session("EMPLOYEE", ["attendance.devices.read"]);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/adms")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/adms/transactions")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices/id/operations")).toBe(true);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices/id/diagnostics")).toBe(false);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices/id/settings")).toBe(false);
    expect(canAccessAdminPath(deviceOperator, "/admin/attendance/devices/id/biometrics")).toBe(false);
    const html = renderToStaticMarkup(<AdminNavigation active="attendance-adms" session={deviceOperator} />);
    expect(html).toContain('href="/admin/attendance/adms"');
    expect(html).not.toContain('href="/admin/attendance/devices"');
  });

  it("keeps Board governance-only and honors trusted legacy compatibility context", () => {
    const board = session("FOUNDATION_BOARD", []);
    expect(landingPath(board)).toBe("/board");
    expect(canAccessAdminPath(board, "/admin/payslips")).toBe(false);
    const legacy = session("SUPER_ADMIN", [...hcAdmin, "attendance.devices.read", "attendance.devices.configure", "attendance.devices.biometrics", "attendance.devices.technical"]);
    expect(landingPath(legacy)).toBe("/admin");
    expect(renderToStaticMarkup(<AdminNavigation active="overview" session={legacy} />)).toContain('href="/admin/attendance/adms"');
    expect(canAccessAdminPath(legacy, "/admin/attendance/devices/id/biometrics")).toBe(true);
    expect(canAccessAdminPath(legacy, "/admin/attendance/devices/id/operations")).toBe(true);
    expect(canAccessAdminPath(legacy, "/admin/attendance/devices/id/diagnostics")).toBe(true);
    expect(canAccessAdminPath(legacy, "/admin/unknown")).toBe(false);
    expect(canManageRoleAssignments(legacy)).toBe(false);
    expect(canManageRoleAssignments(session("SUPER_ADMIN", [...hcAdmin, "access.roles.assign"]))).toBe(true);
  });
});

describe("default landing by principal persona", () => {
  it.each([
    ["Foundation Board", session("FOUNDATION_BOARD", hcAdmin), "/board"],
    ["ordinary employee", session("EMPLOYEE", []), "/app"],
    ["employee with admin capability", session("EMPLOYEE", hcAdmin), "/app"],
    ["non-Employee with admin capability", session("SUPER_ADMIN", hcAdmin), "/admin"],
  ] as const)("lands %s at the expected path", (_label, actor, expected) => {
    expect(landingPath(actor)).toBe(expected);
  });
});

describe("ORG-010 /board route eligibility", () => {
  it("allows FOUNDATION_BOARD and an Employee with board.read, and denies everyone else", () => {
    expect(canAccessBoard(session("FOUNDATION_BOARD", []))).toBe(true);
    expect(canAccessBoard(session("EMPLOYEE", ["board.read"]))).toBe(true);
    expect(canAccessBoard(session("EMPLOYEE", []))).toBe(false);
    expect(canAccessBoard(session("EMPLOYEE", hcAdmin))).toBe(false);
    expect(canAccessBoard(session("SUPER_ADMIN", ["board.read"]))).toBe(false);
    expect(canAccessBoard(null)).toBe(false);
  });

  it("keeps landing paths and adds no admin path for board.read", () => {
    const viewer = session("EMPLOYEE", ["board.read"]);
    expect(landingPath(viewer)).toBe("/app");
    expect(canAccessAdminPath(viewer, "/admin")).toBe(false);
    expect(landingPath(session("FOUNDATION_BOARD", []))).toBe("/board");
    expect(canAccessAdminPath(session("FOUNDATION_BOARD", ["board.read"]), "/admin")).toBe(false);
  });
});

describe("RPT-001 Laporan HR", () => {
  const unitScoped = (permissions: string[]): AuthSession => ({
    ...session("EMPLOYEE", []), authorization: { organizationPermissions: [], unitPermissions: permissions },
  });

  it("opens the shell and the screen for either report role, organization- or unit-scoped", () => {
    for (const actor of [
      session("EMPLOYEE", ["reports.read.organization"]),
      session("EMPLOYEE", ["reports.read.organization", "reports.export.organization"]),
      unitScoped(["reports.read.organization"]),
    ]) {
      expect(canAccessAdminPath(actor, "/admin")).toBe(true);
      expect(canAccessAdminPath(actor, "/admin/reports")).toBe(true);
      expect(canAccessAdminPath(actor, "/admin/employees")).toBe(false);
      const html = renderToStaticMarkup(<AdminNavigation active="reports" session={actor} />);
      expect(html).toContain('href="/admin/reports"');
      expect(html).not.toContain('href="/admin/access"');
    }
  });

  it("stays closed to HC, Super Admin, the board and export alone", () => {
    expect(canAccessAdminPath(session("EMPLOYEE", hcAdmin), "/admin/reports")).toBe(false);
    expect(canAccessAdminPath(session("SUPER_ADMIN", hcAdmin), "/admin/reports")).toBe(false);
    expect(canAccessAdminPath(session("FOUNDATION_BOARD", ["reports.read.organization"]), "/admin/reports")).toBe(false);
    expect(canAccessAdminPath(unitScoped(["reports.export.organization"]), "/admin/reports")).toBe(false);
    // A unit-scoped hint never opens any other screen.
    expect(canAccessAdminPath(unitScoped(["reports.read.organization", "employees.manage"]), "/admin/employees")).toBe(false);
    const html = renderToStaticMarkup(<AdminNavigation active="overview" session={session("EMPLOYEE", hcAdmin)} />);
    expect(html).not.toContain('href="/admin/reports"');
  });
});
