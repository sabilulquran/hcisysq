import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell } from "@/layouts/AppShell";

const employee = {
  name: "Pegawai Sintetis",
  initials: "PS",
  position: "Staf",
  unit: "Unit Sintetis",
};

function renderWithHcCapability(humanCapitalOrganization: boolean) {
  return renderToStaticMarkup(
    <AppShell
      user={employee}
      capabilities={{ humanCapitalOrganization }}
    >
      <div>Konten</div>
    </AppShell>,
  );
}

describe("AppShell organization-wide Human Capital navigation", () => {
  it("does not expose global HC navigation without the organization capability", () => {
    const html = renderWithHcCapability(false);

    expect(html).not.toContain('href="/app/hc/leave"');
    expect(html).not.toContain('href="/app/hc/planned-leave"');
    expect(html).not.toContain('href="/app/hc/attendance-resolution"');
  });

  it("exposes global HC navigation with the organization capability", () => {
    const html = renderWithHcCapability(true);

    expect(html).toContain('href="/app/hc/leave"');
    expect(html).toContain('href="/app/hc/planned-leave"');
    expect(html).toContain('href="/app/hc/attendance-resolution"');
  });
});

describe("AppShell account affordances", () => {
  it("renders account-menu triggers in both the sidebar and responsive header", () => {
    const html = renderWithHcCapability(false);

    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Menu akun Pegawai Sintetis"');
    expect(html).toContain('aria-expanded="false"');
  });
});


describe("AppShell employee service discovery", () => {
  it("keeps mobile navigation bounded and uses one catalog entrypoint for planned services", () => {
    const html = renderWithHcCapability(false);

    expect(html).toContain('href="/app/services"');
    expect(html).toContain(">Lainnya<");
    expect(html).not.toContain('href="/app/services#time-attendance"');
    expect(html).not.toContain('href="/app/services#finance"');
    expect(html).not.toContain('href="/app/services#employee-services"');
    expect(html).not.toContain(">Roadmap<");
    expect(html).not.toContain('href="#"');
  });
});
