import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountMenu } from "@/components/hcis/AccountMenu";
import { AppLauncher } from "@/components/shell/AppLauncher";
import { SpaceSwitcher } from "@/components/shell/SpaceSwitcher";
import { AppShell, EmployeeHumanCapitalNavigation } from "@/layouts/AppShell";
import { boardNavigationFor } from "@/layouts/boardNavigation";
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

describe("ORG-010 Panel Organ Yayasan entry", () => {
  it("is offered to an Employee only when /auth/me lists board.read", () => {
    expect(boardNavigationFor(session(["board.read"]))).toEqual([
      expect.objectContaining({ label: "Panel Organ Yayasan", href: "/board" }),
    ]);
    expect(boardNavigationFor(session([]))).toEqual([]);
    expect(boardNavigationFor(session(["leave.validate", "reports.read.organization"]))).toEqual([]);
    expect(boardNavigationFor(null)).toEqual([]);
  });
});

describe("AppShell account affordances", () => {
  it("renders exactly one account menu, in the header, and keeps the sidebar navigation only", () => {
    const html = renderShell();

    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Menu akun Pegawai Sintetis"');
    expect(html).toContain('aria-expanded="false"');
    const sidebar = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(sidebar).not.toContain("Menu akun");
    expect(sidebar).not.toContain("Keluar");
    expect(sidebar).not.toContain(">PS<");
  });

  it("puts the launcher with the way back to SQ Hub in the header and no admin link outside the switcher", () => {
    const html = renderShell();
    expect(html).toContain('aria-label="Buka peluncur aplikasi"');
    expect(html).not.toContain("Administrasi HCIS");
    expect(html).not.toContain('href="/admin"');
  });

  it("account menu holds identity, Akun SQ in SQ Hub, Tampilan and Keluar", () => {
    const html = renderToStaticMarkup(
      <AccountMenu user={{ name: "Pegawai Sintetis", initials: "PS", detail: "Staf · Unit Sintetis", roles: ["Staf", "Administrator HCIS"] }} previewOpen />,
    );
    expect(html).toContain('href="https://hub.sabilulquran.or.id/account"');
    expect(html).toContain("Akun SQ");
    expect(html).toContain("Terang");
    expect(html).toContain("Gelap");
    expect(html).toContain("Sistem");
    expect(html).toContain("Administrator HCIS");
    expect(html).toContain("Keluar");
    expect(html).not.toContain("Segera");
  });
});

describe("AppShell space switcher", () => {
  it("links both spaces as tabs", () => {
    const html = renderToStaticMarkup(<SpaceSwitcher space="admin" />);
    expect(html).toContain('role="tablist" aria-label="Pindah ruang"');
    expect(html).toContain('href="/app"');
    expect(html).toContain('href="/admin" role="tab" aria-selected="true"');
  });
});

describe("AppShell launcher", () => {
  it("lists SQ Hub first and marks HCIS as the current app", () => {
    const html = renderToStaticMarkup(<AppLauncher previewOpen />);
    expect(html.indexOf("SQ Hub")).toBeLessThan(html.indexOf(">HCIS<"));
    expect(html).toContain('href="https://hub.sabilulquran.or.id/"');
    expect(html).toContain("Di sini");
    expect(html).toContain('href="https://hub.sabilulquran.or.id/apps"');
    expect(html).toContain(">Lihat semua aplikasi<");
  });

  it("AUTH-013: shows the SQ Hub list in the shared grid with HCIS marked as here", () => {
    const html = renderToStaticMarkup(
      <AppLauncher
        previewOpen
        applications={[
          { key: "aset-sq", name: "Aset SQ", canonicalUrl: "https://aset.sabilulquran.or.id" },
          { key: "hcis", name: "HCIS", canonicalUrl: "https://hcis.sabilulquran.or.id" },
          { key: "spmb-sq", name: "SPMB", canonicalUrl: "https://spmb.sabilulquran.or.id" },
          { key: "lain", name: "Zakat", canonicalUrl: "https://zakat.sabilulquran.or.id" },
        ]}
      />,
    );
    expect(html.indexOf("SQ Hub")).toBeLessThan(html.indexOf(">Aset SQ<"));
    expect(html.indexOf(">Aset SQ<")).toBeLessThan(html.indexOf(">HCIS<"));
    expect(html.indexOf(">HCIS<")).toBeLessThan(html.indexOf(">SPMB<"));
    expect(html).toContain('href="https://aset.sabilulquran.or.id"');
    expect(html).toContain("bg-cat-service-soft text-cat-service");
    expect(html).toContain("bg-cat-leave-soft text-cat-leave");
    expect(html).toContain("bg-brand-primary-pale text-brand-primary-deep");
    expect(html).toContain('href="/app" aria-current="page"');
    expect(html).not.toContain('href="https://hcis.sabilulquran.or.id"');
    expect(html.match(/Di sini/g)).toHaveLength(1);
    expect(html).toContain("grid-cols-3");
  });

  it("AUTH-013: falls back to the HCIS tile alone when SQ Hub is unavailable or empty", () => {
    for (const applications of [null, []]) {
      const html = renderToStaticMarkup(<AppLauncher previewOpen applications={applications} />);
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toContain(">HCIS<");
      expect(html).toContain("Di sini");
      expect(html.match(/min-h-24/g)).toHaveLength(1);
    }
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
    expect(mobile.match(/href=/g)).toHaveLength(4);
  });
});

describe("AppShell SQ brand lockup", () => {
  it("shows the star, HCIS and the gold wordmark once, in the header", () => {
    const html = renderShell();

    expect(html).toContain('class="h-9 w-9 shrink-0 object-contain"');
    expect(html.match(/<img src="[^"]*sq-wordmark-gold/g)).toHaveLength(1);
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
