// LEAVE-UX-001: pengajuan cuti tampil sebagai wizard, satu langkah per layar.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WizardDone } from "@/components/leave/WizardDone";
import { WizardSteps } from "@/components/leave/WizardSteps";

describe("LEAVE-UX-001 leave wizard", () => {
  it("marks only the current step and checks off finished steps", () => {
    const html = renderToStaticMarkup(
      <WizardSteps steps={["Pilih kondisi", "Isi data", "Periksa", "Selesai"]} current={2} />,
    );
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^]*Periksa/);
    expect(html).not.toMatch(/>1</);
    expect(html).not.toMatch(/>2</);
    expect(html).toContain(">4<");
  });

  it("shows a dedicated confirmation screen after submission", () => {
    const html = renderToStaticMarkup(
      <WizardDone title="Pengajuan terkirim" message="Menunggu persetujuan.">
        <a href="/app/leave">Lihat status pengajuan</a>
      </WizardDone>,
    );
    expect(html).toContain("Pengajuan terkirim");
    expect(html).toContain('href="/app/leave"');
  });
});
