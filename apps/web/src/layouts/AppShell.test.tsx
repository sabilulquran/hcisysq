import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell, EmployeeHumanCapitalNavigation } from "@/layouts/AppShell";
import type { AuthSession } from "@/types/hcis";

const employee = {
  name: "Pegawai Sintetis",
  initials: "PS",
  position: "Staf",
  unit: "Unit Sintetis",
};

function renderShell() {
  return renderToStaticMarkup(
    <AppShell user={employee}>
      <div>Konten</div>
    </AppShell>,
  );
}

function session(permissions: string[]): AuthSession {
  return {
    principal: { id: "synthetic", email: "synthetic@example.invalid", principalType: "EMPLOYEE" },
    expiresAt: "2099-01-01T00:00:00Z",
    authorization: { organizationPermissions: permissions },
  };
}

describe("AppShell Human Capital navigation", () => {
  it("fails closed when there is no authenticated permission context", () => {
    const html = renderToStaticMarkup(
      <EmployeeHumanCapitalNavigation session={null} activeItem="Beranda" />,
    );
    expect(html).not.toContain("href=");
  });

  it("derives each Human Capital entry from backend permissions", () => {
    const leaveOnly = renderToStaticMarkup(
      <EmployeeHumanCapitalNavigation session={session(["leave.validate"])} activeItem="Validasi Cuti" />,
    );
    expect(leaveOnly).toContain('href="/app/hc/leave"');
    expect(leaveOnly).toContain('href="/app/hc/planned-leave"');
    expect(leaveOnly).not.toContain('href="/app/hc/attendance-resolution"');

    const full = renderToStaticMarkup(
      <EmployeeHumanCapitalNavigation
        session={session(["leave.validate", "attendance.resolution.manage"])}
        activeItem="Penyelesaian Kehadiran"
        mobile
      />,
    );
    expect(full).toContain('aria-label="Tugas Human Capital"');
    expect(full).toContain('href="/app/hc/leave"');
    expect(full).toContain('href="/app/hc/planned-leave"');
    expect(full).toContain('href="/app/hc/attendance-resolution"');
  });
});

describe("AppShell account affordances", () => {
  it("renders account-menu triggers in both the sidebar and responsive header", () => {
    const html = renderShell();

    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Menu akun Pegawai Sintetis"');
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("AppShell employee service discovery", () => {
  it("keeps mobile navigation bounded and uses one catalog entrypoint for planned services", () => {
    const html = renderShell();

    expect(html).toContain('href="/app/services"');
    expect(html).toContain(">Lainnya<");
    expect(html).not.toContain('href="/app/services#time-attendance"');
    expect(html).not.toContain('href="/app/services#finance"');
    expect(html).not.toContain('href="/app/services#employee-services"');
    expect(html).not.toContain(">Roadmap<");
    expect(html).not.toContain('href="#"');
    expect(html).toContain('href="/app/notifications"');

    const mobile = html.split('aria-label="Navigasi mobile pegawai"')[1]?.split("</nav>")[0] ?? "";
    expect(mobile.match(/href=/g)).toHaveLength(5);
  });
});

describe("AppShell SQ brand lockup", () => {
  it("shows the star, HCIS and the gold wordmark in the sidebar and the compact header", () => {
    const html = renderShell();

    expect(html).toContain('class="h-11 w-11 shrink-0 object-contain"');
    expect(html).toContain('class="h-9 w-9 shrink-0 object-contain"');
    expect(html.match(/sq-wordmark-gold/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("Human Capital Information System");
  });

  it("marks service navigation with category accents while the active item stays primary", () => {
    const html = renderShell();

    expect(html).toContain("bg-cat-attendance-soft text-cat-attendance");
    expect(html).toContain("bg-cat-leave-soft text-cat-leave");
    expect(html).toContain("bg-cat-pay-soft text-cat-pay");
    expect(html).toContain("bg-cat-task-soft text-cat-task");
    expect(html).toMatch(/aria-current="page" class="[^"]*bg-brand-primary-pale text-brand-primary-deep/);
  });
});
