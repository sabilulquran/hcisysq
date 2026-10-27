import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell, EmployeeHumanCapitalNavigation } from "@/layouts/AppShell";
import { AdminDeviceAccessNote, AdminNavigation } from "@/layouts/AdminShell";
import { EmployeeAttendanceNavigation } from "@/components/attendance/EmployeeAttendanceNavigation";
import { AttendanceSectionTabs } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { DeviceDetailNavigation } from "@/components/attendance/device-admin/DeviceDetailShell";
import { SavedFilterBar } from "@/components/attendance/device-admin/SavedFilterBar";
import { getEmployeeService } from "@/lib/employeeServices";
import { getAdminService, lockedNote } from "@/lib/adminServices";
import { AdminServiceTile } from "@/pages/AdminServicesPage";
import { canOpenAvailableAdminService } from "@/pages/AdminComingSoonPage";
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
    expect(mobile.match(/href=/g)).toHaveLength(4);
    expect(mobile).toContain(">Lainnya<");
  });
  it("does not hide attendance actions beyond a horizontal scroll strip", () => {
    const html = renderToStaticMarkup(<EmployeeAttendanceNavigation currentPath="/app/attendance/shift-swap" />);
    expect(html).toContain('href="/app/attendance/shift-swap" aria-current="page"');
    expect(html).toContain('href="/app/attendance#overtime"');
    expect(html).toContain('href="/app/attendance#clarifications"');
    expect(html).not.toContain("overflow-x-auto");
    expect(html).toContain("min-h-11");
  });
  it("keeps Persetujuan discoverable in the desktop shell without page-specific role hints", () => {
    const html = renderToStaticMarkup(
      <AppShell user={employee} activeItem="Beranda"><p>Synthetic content</p></AppShell>,
    );
    const desktop = html.split('aria-label="Navigasi mobile pegawai"')[0] ?? html;
    expect(desktop).toContain('href="/app/approvals"');
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
    expect(getEmployeeService("overtime")?.href).toBe("/app/attendance#overtime");
    expect(getEmployeeService("attendance-clarification")?.href).toBe("/app/attendance#clarifications");
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
    expect(getAdminService("shift-exchange")?.href).toBe("/admin/attendance/schedules/swaps");
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
    expect(readOnly).not.toContain("/diagnostics");

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
    expect(hcAdmin).not.toContain("/operations");
    expect(hcAdmin).not.toContain("/diagnostics");
    expect(hcAdmin).not.toContain("/biometrics");
  });

  it("keeps legacy available-service redirects permission-aware", () => {
    const adms = getAdminService("adms")!;
    expect(canOpenAvailableAdminService(adms, session(["employees.manage"]))).toBe(false);
    expect(canOpenAvailableAdminService(adms, session(["attendance.devices.read"]))).toBe(true);

    const shift = getAdminService("shift-exchange")!;
    expect(canOpenAvailableAdminService(shift, session(["attendance.shift_swap.manage"]))).toBe(true);
    expect(canOpenAvailableAdminService(shift, session(["attendance.schedule.manage"]))).toBe(false);
  });

  it("keeps available admin modules linked to operational GUI and permission-aware", () => {
    const shift = getAdminService("shift-exchange")!;
    const open = renderToStaticMarkup(<AdminServiceTile service={shift} canOpen />);
    expect(open).toContain('href="/admin/attendance/schedules/swaps"');
    expect(open).toContain("Tersedia");
    expect(open).not.toContain("Belum tersedia");

    const locked = renderToStaticMarkup(<AdminServiceTile service={getAdminService("adms")!} canOpen={false} />);
    expect(locked).not.toContain('href="/admin/attendance/adms"');
    expect(locked).toContain("akun ini belum memiliki akses");
  });

  it("names the roles that open a locked module instead of only refusing", () => {
    // PAY-003: payroll is deliberately outside the HC roles, so an HC admin who
    // finds the card locked has to be told which role to ask for.
    const payroll = renderToStaticMarkup(<AdminServiceTile service={getAdminService("payroll")!} canOpen={false} />);
    expect(payroll).toContain("Kepala Human Capital");
    expect(payroll).toContain("Direktur");
    expect(payroll).toContain("Kepala Keuangan");
    expect(payroll).toContain("administrator akses");

    // A module with no role list keeps the short sentence.
    expect(lockedNote(getAdminService("adms")!)).toBe("Tersedia di HCIS · akun ini belum memiliki akses");
  });

  it("keeps read-only ADMS saved filters non-mutating", () => {
    const html = renderToStaticMarkup(
      <SavedFilterBar deviceId="synthetic-device" viewKey="transactions" criteria={{ query: "" }} onApply={() => undefined} canManage={false} />,
    );
    expect(html).toContain("Mode baca saja");
    expect(html).not.toContain(">Hapus<");
    expect(html).not.toContain(">Simpan<");
    expect(html).toContain(">Terapkan<");
  });

  it.each([false, true])("shows HC shift approval in compact=%s without granting ADMS", (compact) => {
    const html = renderToStaticMarkup(<AdminNavigation active="attendance-schedules" session={session(["attendance.shift_swap.manage"])} compact={compact} />);
    // ATT-011: the Jadwal entry opens the only tab this account can load.
    expect(html).toContain('href="/admin/attendance/schedules/swaps"');
    expect(html).not.toContain('href="/admin/attendance/schedules"');
    // Sidebars hold navigation only; the device note is shown in page content instead.
    expect(html).not.toContain("Mesin Fingerprint belum dapat dibuka");
    expect(renderToStaticMarkup(<AdminDeviceAccessNote session={session(["attendance.shift_swap.manage"])} />)).toContain("Mesin Fingerprint belum dapat dibuka");
    expect(renderToStaticMarkup(<AdminDeviceAccessNote session={session(["attendance.devices.read"])} />)).toBe("");
    expect(html).not.toContain('href="/admin/attendance/devices"');
    expect(html).not.toContain('href="/admin/attendance/adms"');
  });
  it("offers one ADMS management entry to a device reader", () => {
    const html = renderToStaticMarkup(<AdminNavigation active="attendance-adms" session={session(["attendance.devices.read"])} />);
    expect(html).toContain('href="/admin/attendance/adms"');
    expect(html).toContain("Mesin Fingerprint");
    expect(html).not.toContain('href="/admin/attendance/devices"');
    expect(html).not.toContain('href="/admin/attendance/adms/transactions"');
    expect(html).not.toContain('href="/admin/attendance/schedules/swaps"');
    expect(html).not.toContain('href="/admin/attendance"');
  });
  it("wraps permitted workspace links and fails closed before session resolution", () => {
    const unresolved = renderToStaticMarkup(<AttendanceSectionTabs tab="swaps" session={null} />);
    expect(unresolved).not.toContain("href=");
    // A single reachable tab needs no sub-navigation.
    expect(renderToStaticMarkup(<AttendanceSectionTabs tab="swaps" session={session(["attendance.shift_swap.manage"])} />)).toBe("");
    const html = renderToStaticMarkup(<AttendanceSectionTabs tab="swaps" session={session(["attendance.shift_swap.manage", "attendance.schedule.manage"])} />);
    expect(html).toContain("flex-wrap");
    expect(html).not.toContain("overflow-x-auto");
    expect(html).toContain('href="/admin/attendance/schedules/swaps"');
    expect(html).toContain('href="/admin/attendance/schedules/dates"');
    expect(html).not.toContain('href="/admin/attendance/settings/locations"');
  });
});
