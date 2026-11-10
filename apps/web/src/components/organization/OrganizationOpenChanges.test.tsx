import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  OrganizationDiscardDialog,
  OrganizationOpenChangeConflict,
  OrganizationOpenChangeList,
} from "@/components/organization/OrganizationOpenChanges";
import type { OrganizationOpenChange } from "@/lib/organizationDesigner";

function text(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");
}

const stale: OrganizationOpenChange = {
  id: "change-stale",
  name: "Perubahan Lama Sintetis",
  effectiveOn: "2026-08-21",
  status: "VALIDATED",
  createdByName: "Admin Sintetis",
  createdAt: "2026-08-21T02:00:00Z",
  updatedAt: "2026-08-22T03:30:00Z",
};

const current: OrganizationOpenChange = { ...stale, id: "change-current", name: "Perubahan Sedang Dibuka", status: "DRAFT" };

const noop = () => undefined;

function list(overrides: Partial<Parameters<typeof OrganizationOpenChangeList>[0]> = {}) {
  return renderToStaticMarkup(
    <OrganizationOpenChangeList
      items={[stale, current]}
      total={2}
      page={1}
      loading={false}
      error={null}
      busy={false}
      currentDraftId="change-current"
      onOpen={noop}
      onDiscard={noop}
      onPageChange={noop}
      onRetry={noop}
      {...overrides}
    />,
  );
}

describe("ORG-008 follow-up: the refused start names the open change", () => {
  it("names it with its effective date and status, and offers both ways out", () => {
    const html = text(renderToStaticMarkup(
      <OrganizationOpenChangeConflict change={stale} busy={false} onOpen={noop} onDiscard={noop} />,
    ));
    expect(html).toContain('"Perubahan Lama Sintetis"');
    expect(html).toContain("21 Agu 2026");
    expect(html).toContain("Siap diterbitkan");
    expect(html).toContain("Buka perubahan itu");
    expect(html).toContain("Buang perubahan itu");
  });
});

describe("ORG-008 follow-up: Perubahan terbuka", () => {
  it("shows name, effective date, status, creator and last update with Buka and Buang", () => {
    const html = text(list());
    expect(html).toContain("Perubahan terbuka (2)");
    expect(html).toContain("Perubahan Lama Sintetis");
    expect(html).toContain("Berlaku mulai 21 Agu 2026");
    expect(html).toContain("Siap diterbitkan");
    expect(html).toContain("Disusun oleh Admin Sintetis");
    expect(html).toContain("Terakhir diubah 22 Agu 2026");
    expect(html).toContain("Buka");
    expect(html).toContain("Buang");
  });

  it("marks the change already open instead of offering to open it again", () => {
    const html = list();
    expect(html).toContain('aria-label="Buka Perubahan Lama Sintetis"');
    expect(html).not.toContain('aria-label="Buka Perubahan Sedang Dibuka"');
    expect(html).toContain('aria-label="Buang Perubahan Sedang Dibuka"');
    expect(text(html)).toContain("Sedang dibuka");
  });

  it("says plainly when nothing is open", () => {
    expect(text(list({ items: [], total: 0 }))).toContain("Tidak ada perubahan yang terbuka");
  });

  it("shows a failure with a retry, not an empty list", () => {
    const html = text(list({ items: [], total: 0, error: "Daftar perubahan terbuka tidak dapat dimuat." }));
    expect(html).toContain("Daftar perubahan terbuka tidak dapat dimuat.");
    expect(html).toContain("Coba lagi");
    expect(html).not.toContain("Tidak ada perubahan yang terbuka");
  });

  it("pages server-side when there is more than one page (ENG-LIST-001)", () => {
    expect(text(list({ total: 30 }))).toContain("Menampilkan 1–25 dari 30");
    expect(text(list())).not.toContain("Menampilkan");
  });
});

describe("ORG-008 follow-up: discarding asks for a reason", () => {
  it("requires a reason and says history is kept", () => {
    const html = renderToStaticMarkup(
      <OrganizationDiscardDialog change={stale} saving={false} error={null} onCancel={noop} onConfirm={noop} />,
    );
    expect(html).toMatch(/<textarea[^>]*name="reason"[^>]*required/);
    expect(html).toContain('maxLength="500"');
    expect(text(html)).toContain("Alasan membuang");
    expect(text(html)).toContain("riwayatnya tetap tersimpan");
    expect(text(html)).toContain("Buang perubahan");
  });

  it("shows why a discard was refused", () => {
    const html = text(renderToStaticMarkup(
      <OrganizationDiscardDialog change={stale} saving={false} error="Perubahan ini sudah diterbitkan." onCancel={noop} onConfirm={noop} />,
    ));
    expect(html).toContain("Perubahan ini sudah diterbitkan.");
  });
});
