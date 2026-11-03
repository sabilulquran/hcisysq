// ORG-012: the client's request shaping, labels and the shared detail panel. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommitteeDetailPanel } from "@/components/committees/CommitteeDetailPanel";
import { ActivateForm } from "@/pages/AdminCommitteesPage";
import {
  committeeQuery,
  CommitteeRequestError,
  decreeLineUp,
  describeEvent,
  formatPeriod,
  listCommittees,
  participationQuery,
  roleLabel,
  type CommitteeDetail,
} from "@/lib/committees";

function detail(overrides: Partial<CommitteeDetail> = {}): CommitteeDetail {
  return {
    id: "c1", name: "Panitia Wisuda Tahfizh", category: "GRADUATION", description: null, organizer: "SMP Sabilul Qur'an",
    startOn: "2026-11-10", endOn: "2026-12-20", status: "ACTIVE", activatedAt: "2026-11-03T03:00:00Z",
    completedAt: null, cancelledAt: null, cancelReason: null, decreeMode: "ISSUED", decreeNumber: "001/SKP/YSQ/XI/2026",
    decreeDate: "2026-11-03", decreeStatus: "ISSUED", decreeSigner: { title: "Ketua Yayasan", name: "Ketua Yayasan Sintetis" },
    decreeSnapshot: {
      name: "Panitia Wisuda Tahfizh", category: "GRADUATION", organizer: "SMP Sabilul Qur'an", startOn: "2026-11-10", endOn: "2026-12-20",
      members: [{ fullName: "Ketua Sintetis", unitName: "SMP", role: "CHAIR", section: null }],
      carbonCopies: ["Kepala Human Capital Management"],
    },
    members: [
      { id: "m1", employeeId: "e1", fullName: "Ketua Sintetis", unitName: "SMP", role: "CHAIR", section: null, joinedOn: "2026-11-10", leftOn: null, endReason: null },
      { id: "m2", employeeId: "e2", fullName: "Anggota Baru", unitName: "SD", role: "SECTION_COORDINATOR", section: "Seksi Acara", joinedOn: "2026-11-12", leftOn: null, endReason: null },
      { id: "m3", employeeId: "e3", fullName: "Anggota Lama", unitName: null, role: "MEMBER", section: null, joinedOn: "2026-11-10", leftOn: "2026-11-11", endReason: "Pindah tugas" },
    ],
    myMemberIds: ["m2"],
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("ORG-012 client", () => {
  it("sends only the filters that are set, and waits for a two-letter search", () => {
    expect(committeeQuery({ status: "", category: "", year: "", q: "a" })).toBe("page=1&pageSize=25");
    expect(committeeQuery({ status: "ACTIVE", category: "EXAM", year: 2026, q: " ujian ", page: 2, pageSize: 50 }))
      .toBe("status=ACTIVE&category=EXAM&year=2026&q=ujian&page=2&pageSize=50");
    expect(participationQuery({ year: 2026, q: "Si" })).toBe("year=2026&page=1&pageSize=25&q=Si");
  });

  it("turns an API problem into an error that keeps its status, code and reasons", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "COMMITTEE_FORBIDDEN", message: "Anda tidak memiliki akses ke data kepanitiaan.",
    }), { status: 403 })));
    const failure = await listCommittees({}).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CommitteeRequestError);
    expect(failure).toMatchObject({ status: 403, code: "COMMITTEE_FORBIDDEN" });
  });

  it("labels roles, periods and history", () => {
    expect(roleLabel("SECTION_COORDINATOR", "Seksi Acara")).toBe("Koordinator Seksi · Seksi Acara");
    expect(roleLabel("CHAIR", null)).toBe("Ketua");
    expect(formatPeriod("2026-11-10", "2026-11-10")).toBe("10 Nov 2026");
    expect(describeEvent({
      id: "x", eventType: "committee.member.updated", employeeId: "e1", reason: null, occurredAt: "2026-11-03T03:00:00Z", actorName: null,
      metadata: { name: "Siti", before: { role: "CHAIR" }, after: { role: "MEMBER" } },
    })).toBe("Peran anggota diubah: Siti Ketua → Anggota");
    expect(describeEvent({
      id: "y", eventType: "committee.activated", employeeId: null, reason: null, occurredAt: "2026-11-03T03:00:00Z", actorName: null,
      metadata: { decreeNumber: "001/SKP/YSQ/XI/2026" },
    })).toBe("Kepanitiaan ditetapkan (SK 001/SKP/YSQ/XI/2026)");
  });

  it("prints the line-up fixed at activation, or the current one for an external decree", () => {
    expect(decreeLineUp(detail()).map((member) => member.fullName)).toEqual(["Ketua Sintetis"]);
    expect(decreeLineUp(detail({ decreeSnapshot: null, decreeMode: "EXTERNAL" })).map((member) => member.fullName))
      .toEqual(["Ketua Sintetis", "Anggota Baru"]);
  });
});

describe("ORG-012 detail panel", () => {
  it("shows the line-up, the member's history and a printable SK", () => {
    const html = renderToStaticMarkup(<CommitteeDetailPanel detail={detail()} />);
    expect(html).toContain("Susunan panitia (2)");
    expect(html).toContain("Riwayat anggota (1)");
    expect(html).toContain("SURAT KEPUTUSAN");
    expect(html).toContain("001/SKP/YSQ/XI/2026");
    expect(html).toContain("Cetak SK");
    // No contact data or pay is ever part of the panel.
    expect(html).not.toMatch(/telepon|gaji|honor/i);
  });

  it("marks a revoked decree and hides printing; an external decree has no paper", () => {
    const revoked = renderToStaticMarkup(<CommitteeDetailPanel detail={detail({ status: "CANCELLED", decreeStatus: "REVOKED", cancelReason: "Kegiatan ditiadakan." })} />);
    expect(revoked).toContain("DICABUT");
    expect(revoked).not.toContain("Cetak SK");
    expect(revoked).toContain("Alasan pembatalan");
    const external = renderToStaticMarkup(<CommitteeDetailPanel detail={detail({ decreeMode: "EXTERNAL", decreeSnapshot: null, decreeStatus: null })} />);
    expect(external).toContain("SK di luar HCIS");
    expect(external).not.toContain("SURAT KEPUTUSAN");
  });

  it("D-09: prints the Ketua Yayasan as signer and the Kepala HCM under Tembusan; an earlier SK prints as issued", () => {
    const html = renderToStaticMarkup(<CommitteeDetailPanel detail={detail()} />);
    expect(html).toContain("Ketua Yayasan Sintetis");
    expect(html).toMatch(/Tembusan:.*Kepala Human Capital Management/);
    const earlier = detail({
      decreeSigner: { title: "Kepala Human Capital Management", name: "Kepala HCM Lama" },
      decreeSnapshot: { ...detail().decreeSnapshot!, carbonCopies: undefined },
    });
    const old = renderToStaticMarkup(<CommitteeDetailPanel detail={earlier} />);
    expect(old).toContain("Kepala HCM Lama");
    expect(old).not.toContain("Tembusan");
  });

  it("has an empty state for a draft without members", () => {
    const html = renderToStaticMarkup(<CommitteeDetailPanel detail={detail({
      status: "DRAFT", members: [], decreeMode: null, decreeNumber: null, decreeStatus: null, decreeSnapshot: null, decreeSigner: null, decreeDate: null,
    })} />);
    expect(html).toContain("Belum ada anggota.");
    expect(html).not.toContain("SK panitia");
  });
});

describe("ORG-012 decree form", () => {
  const noop = () => {};
  it("D-09: offers the Ketua Yayasan first, asks its name when HCIS has none, and names the Direktur", () => {
    const html = renderToStaticMarkup(<ActivateForm busy={false} onCancel={noop} onSubmit={noop} signerOptions={[
      { signer: "FOUNDATION_CHAIR", title: "Ketua Yayasan", available: true, name: "Ketua Yayasan Sintetis", nameRequired: true },
      { signer: "DIRECTOR", title: "Direktur", available: true, name: "Direktur Sintetis", nameRequired: false },
    ]} />);
    expect(html).toContain("Penandatangan SK");
    expect(html).toMatch(/name="decree-signer"[^>]*checked=""[^>]*>[\s\S]*?Ketua Yayasan/);
    expect(html).toContain("Nama Ketua Yayasan sebagaimana tertulis di SK");
    expect(html).toContain('value="Ketua Yayasan Sintetis"');
    expect(html).toContain("Direktur Sintetis");
    expect(html).toContain("tembusan Kepala HCM");
    expect(html).not.toMatch(/ditandatangani Kepala HCM/);
  });

  it("D-09: with no signer available, issuing is blocked and the external SK stays open", () => {
    const html = renderToStaticMarkup(<ActivateForm busy={false} onCancel={noop} onSubmit={noop} signerOptions={[
      { signer: "FOUNDATION_CHAIR", title: "Ketua Yayasan", available: false, name: null, nameRequired: false },
      { signer: "DIRECTOR", title: "Direktur", available: false, name: null, nameRequired: false },
    ]} />);
    expect(html).toContain("Belum ada penandatangan yang dapat dipilih");
    expect(html).toMatch(/<button type="submit" disabled=""/);
    expect(html).toContain("SK sudah terbit di luar HCIS");
  });
});
