import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell, EmployeeHumanCapitalNavigation } from "@/layouts/AppShell";
import { AdminNavigation } from "@/layouts/AdminShell";
import { EmployeeAttendanceNavigation } from "@/components/attendance/EmployeeAttendanceNavigation";
import { AttendanceWorkforceNavigation } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { DeviceDetailNavigation } from "@/components/attendance/device-admin/DeviceDetailShell";
import { getEmployeeService } from "@/lib/employeeServices";
import { getAdminService } from "@/lib/adminServices";
import type { AuthSession } from "@/types/hcis";

const employee = { name: "Synthetic Employee", initials: "SE", position: "Staff", unit: "Synthetic Unit" };
const session = (permissions: string[]): AuthSession => ({
  principal: { id: "synthetic", email: "synthetic@example.invalid", principalType: "EMPLOYEE" },
  expiresAt: "2099-01-01T00:00:00Z", authorization: { organizationPermissions: permissions },
});

describe("employee attendance discoverability", () => {
  it.each(["Kehadiran", "Clock In/Out", "Tukar Shift"])("shows the attendance actions from %s while retaining five mobile destinations", (activeItem) => {
    const html = renderToStaticMarkup(<AppShell user={employee} activeItem={activeItem}><p>Synthetic content</p></AppShell>);
    expect(html).toContain('aria-label="Layanan kehadiran pegawai"');
    expect(html).toContain('href="/app/attendance/clock"');
    expect(html).toContain('href="/app/attendance/shift-swap"');
    const mobile = html.split('aria-label="Navigasi mobile pegawai"')[1]?.split("</nav>")[0] ?? "";
    expect(mobile.match(/href=/g)).toHaveLength(5);
  });
  it("does not hide attendance actions beyond a horizontal scroll strip", () => {
    const html = renderToStaticMarkup(<EmployeeAttendanceNavigation currentPath="/app/attendance/shift-swap" />);
    expect(html).toContain('href="/app/attendance/shift-swap" aria-current="page"');
    expect(html).not.toContain("overflow-x-auto");
    expect(html).toContain("min-h-11");
  });
  it("keeps Human Capital tasks discoverable on mobile from backend-derived permissions", () => {
    const actor = session(["leave.validate", "attendance.resolution.manage"]);
    const html = renderToStaticMarkup(
      <EmployeeHumanCapitalNavigation session={actor} activeItem="Validasi Cuti" mobile />,
    );
    expect(html).toContain('aria-label="Tugas Human Capital"');
    expect(html).toContain('href="/app/hc/leave"');
    expect(html).toContain('href="/app/hc/planned-leave"');
    expect(html).toContain('href="/app/hc/attendance-resolution"');
    expect(html).toContain("lg:hidden");
  });

  it("links implemented services to real routes while reminders remain a proposal", () => {
    expect(getEmployeeService("overtime")?.stage).toBe("available");
    expect(getEmployeeService("overtime")?.href).toBe("/app/attendance");
    expect(getEmployeeService("work-schedule")?.href).toBe("/app/attendance");
    expect(getEmployeeService("shift-swap")?.href).toBe("/app/attendance/shift-swap");
    expect(getEmployeeService("notifications")?.stage).toBe("available");
    expect(getEmployeeService("notifications")?.href).toBe("/app/notifications");
    expect(getEmployeeService("reminders")?.stage).toBe("discovery");
    expect(getEmployeeService("clock-in")?.details ?? []).not.toContain("Face recognition");
  });
});

describe("HC and device-operator navigation", () => {
  it("keeps implemented admin attendance modules out of Coming Soon", () => {
    expect(getAdminService("shift-exchange")?.stage).toBe("available");
    expect(getAdminService("shift-exchange")?.href).toBe("/admin/attendance/workforce/shift-swaps");
    expect(getAdminService("adms")?.stage).toBe("available");
    expect(getAdminService("adms")?.href).toBe("/admin/attendance/adms");
    expect(getAdminService("mobile-attendance")?.details ?? []).not.toContain("Face recognition");
  });

  it("wraps ADMS detail tabs and hides links that the session cannot open", () => {
    const readOnly = renderToStaticMarkup(
      <DeviceDetailNavigation
        baseHref="/admin/attendance/devices/synthetic-device"
        section="overview"
        session={session(["attendance.devices.read"])}
      />,
    );
    expect(readOnly).toContain("flex-wrap");
    expect(readOnly).not.toContain("overflow-x-auto");
    expect(readOnly).not.toContain("/biometrics");
    expect(readOnly).not.toContain("/settings");
    expect(readOnly).not.toContain("/operations");

    const hcAdmin = renderToStaticMarkup(
      <DeviceDetailNavigation
        baseHref="/admin/attendance/devices/synthetic-device"
        section="settings"
        session={session([
          "attendance.devices.read",
          "attendance.devices.configure",
          "attendance.devices.operate",
          "attendance.devices.export",
        ])}
      />,
    );
    expect(hcAdmin).toContain("/settings");
    expect(hcAdmin).toContain("/operations");
    expect(hcAdmin).not.toContain("/biometrics");
  });

  it.each([false, true])("shows HC shift approval in compact=%s without granting ADMS", (compact) => {
    const html = renderToStaticMarkup(<AdminNavigation active="attendance-shift-swaps" session={session(["attendance.shift_swap.manage"])} compact={compact} />);
    expect(html).toContain('href="/admin/attendance/workforce/shift-swaps"');
    expect(html).toContain("ADMS sudah terpasang");
    expect(html).not.toContain('href="/admin/attendance/devices"');
    expect(html).not.toContain('href="/admin/attendance/adms"');
  });
  it("offers ADMS fleet, registry and global transactions only to a device reader", () => {
    const html = renderToStaticMarkup(<AdminNavigation active="attendance-adms" session={session(["attendance.devices.read"])} />);
    for (const path of ["/admin/attendance/adms", "/admin/attendance/devices", "/admin/attendance/adms/transactions"]) expect(html).toContain(`href="${path}"`);
    expect(html).not.toContain('href="/admin/attendance/workforce/shift-swaps"');
  });
  it("wraps permitted workspace links and fails closed before session resolution", () => {
    const unresolved = renderToStaticMarkup(<AttendanceWorkforceNavigation section="shift-swaps" session={null} />);
    expect(unresolved).not.toContain("href=");
    const html = renderToStaticMarkup(<AttendanceWorkforceNavigation section="shift-swaps" session={session(["attendance.shift_swap.manage"])} />);
    expect(html).toContain("flex-wrap");
    expect(html).not.toContain("overflow-x-auto");
    expect(html).toContain('href="/admin/attendance/workforce/shift-swaps"');
    expect(html).not.toContain('href="/admin/attendance/workforce/locations"');
  });
});
