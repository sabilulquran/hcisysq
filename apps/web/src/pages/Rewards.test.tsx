// REWARD-001 screens rendered as markup, with synthetic data: source states, a round with its
// decision buttons, the employee views, the certificate check, and the Al-Qur'an link.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { canAccessAdminPath } from "@/lib/authorization";
import { getEmployeeService } from "@/lib/employeeServices";
import {
  monthLabel,
  previousMonth,
  publishBlocker,
  seatGroups,
  sourceMessage,
  type Candidate,
  type RoundDetail,
  type SourceState,
} from "@/lib/rewards";
import { QURAN_APP_URL } from "@/lib/sqCore";
import { RoundDetailView, SourceBanner } from "@/pages/AdminRewardsPage";
import { MyAwardsList, QuranLinkCard, RecipientsList } from "@/pages/EmployeeRewardsPage";
import { CertificateCheckView } from "@/pages/PublicRewardVerifyPage";
import type { AuthSession } from "@/types/hcis";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "c1", category: "FOUNDATION", unitRef: "", unitName: null, seat: 1, rank: 1, pages: 120.5, activeDays: 25, khatam: 1,
    labels: [], personRef: "hcis:employee:00000000-0000-4000-8000-000000000001", employeeId: "e1", employeeName: "Siti Aminah",
    employeeNumber: "NIP-001", employeeUnitName: "SMPIT", status: "CANDIDATE", unresolvedReason: null, declineReason: null,
    decidedAt: null, decidedByName: null, replacesCandidateId: null, replaced: false, ...overrides,
  };
}

function round(overrides: Partial<RoundDetail> = {}): RoundDetail {
  return {
    id: "r1", month: "2026-10", status: "PENDING_DECISION", sourceKind: "QURAN_API", snapshotVersion: "snap-v1",
    snapshotFinalizedAt: null, directoryVersion: null, directoryAsOf: null, directoryStale: false, fetchedAt: "2026-11-03T00:00:00Z",
    createdAt: "2026-11-03T00:00:00Z", cancelReason: null, publishedAt: null, publishedByName: null, announcementId: null,
    importNote: null, importRowCount: null, importedByName: null, snapshotRowCount: 40,
    candidates: [candidate()], awards: [], outbox: [],
    viewer: { canManage: true, decidableCandidateIds: ["c1"], isImporter: false },
    ...overrides,
  };
}

const noop = () => {};

describe("REWARD-001 admin screen", () => {
  it("says honestly that the source is not there yet, and never invents candidates", () => {
    const source: SourceState = { status: "NOT_CONFIGURED", latestFinalMonth: "2026-10", manualImportOpen: true, fetch: null };
    const html = renderToStaticMarkup(<SourceBanner source={source} />);
    expect(html).toContain("Sumber belum tersedia");
    expect(html).toContain("impor snapshot bulanan dari CSV");
    expect(sourceMessage("UNAVAILABLE").title).toBe("Papan skor belum bisa diambil");
    const exhausted = renderToStaticMarkup(<SourceBanner source={{ ...source, status: "UNAVAILABLE", fetch: {
      month: "2026-10", attempts: 72, lastAttemptAt: null, lastOutcome: "REWARD_SOURCE_UNAVAILABLE", exhaustedAt: "2026-11-06T00:00:00Z",
    } }} />);
    expect(exhausted).toContain("Gunakan Susun ulang");
  });

  it("shows numbers, labels and the decision buttons the API allows", () => {
    const html = renderToStaticMarkup(<RoundDetailView round={round({
      candidates: [candidate({ labels: ["AUTO", "SELF_REPORTED"] }), candidate({ id: "c2", status: "UNRESOLVED", unresolvedReason: "UNKNOWN_PERSON", employeeId: null, employeeName: null })],
    })} busy={false} onAction={noop} />);
    expect(html).toContain("Siti Aminah");
    expect(html).toContain("Sebagian otomatis, mandiri");
    expect(html).toContain("Tetapkan");
    expect(html).toContain("Tidak ditetapkan");
    expect(html).toContain("Orang di papan skor tidak dikenal di HCIS.");
    expect(html).toContain("Ambil peringkat berikutnya");
    expect(html).toContain("Masih ada kandidat yang belum diputuskan.");
  });

  it("offers no decision to a reader, nor on a published round", () => {
    const reader = renderToStaticMarkup(<RoundDetailView round={round({ viewer: { canManage: false, decidableCandidateIds: [], isImporter: false } })} busy={false} onAction={noop} />);
    expect(reader).not.toContain("Tetapkan");
    expect(reader).not.toContain("Terbitkan");
    const published = renderToStaticMarkup(<RoundDetailView round={round({
      status: "PUBLISHED", candidates: [candidate({ status: "AWARDED" })],
      viewer: { canManage: true, decidableCandidateIds: [], isImporter: false },
      awards: [{ id: "a1", candidateId: "c1", employeeId: "e1", category: "FOUNDATION", categoryLabel: "Terbaik Tilawah Yayasan — Peringkat 1",
        recipientName: "Siti Aminah", status: "ACTIVE", revokeReason: null, revokedAt: null, certificateReady: false, awardedAt: "2026-11-05T00:00:00Z" }],
      outbox: [{ id: "o1", awardId: "a1", effect: "CERTIFICATE", status: "FAILED", attempts: 8, lastError: "Error", nextAttemptAt: "2026-11-05T00:00:00Z", doneAt: null }],
    })} busy={false} onAction={noop} />);
    expect(published).not.toContain("Terbitkan");
    expect(published).toContain("Cabut");
    expect(published).toContain("Belum terkirim");
    expect(published).toContain("Kirim ulang");
  });

  it("labels a manual import and a stale directory", () => {
    const html = renderToStaticMarkup(<RoundDetailView round={round({
      sourceKind: "MANUAL_IMPORT", importNote: "Rekap koordinator", importRowCount: 12, importedByName: "Admin HC", directoryStale: true,
      viewer: { canManage: true, decidableCandidateIds: [], isImporter: true },
    })} busy={false} onAction={noop} />);
    expect(html).toContain("Impor manual CSV (sementara)");
    expect(html).toContain("Rekap koordinator");
    expect(html).toContain("Direktori Organisasi tertinggal");
    expect(html).toContain("tidak dapat memutuskan kandidatnya");
  });

  it("groups seats and explains why publication waits", () => {
    const groups = seatGroups([
      candidate(), candidate({ id: "c3", seat: 3, rank: 4, replacesCandidateId: "c2" }),
      candidate({ id: "c4", category: "UNIT", unitRef: "hcis:org-node:x", unitName: "SMPIT" }),
    ]);
    expect(groups.map((group) => group.title)).toEqual(["Yayasan — Peringkat 1", "Yayasan — Peringkat 3", "Unit SMPIT"]);
    expect(publishBlocker({ status: "PENDING_DECISION", candidates: [candidate({ status: "DECLINED" })] })).toBe("Belum ada kandidat yang ditetapkan.");
    expect(publishBlocker({ status: "PENDING_DECISION", candidates: [candidate({ status: "AWARDED" }), candidate({ status: "UNRESOLVED" })] })).toBeNull();
  });

  it("opens the admin screen only with reward.read; Super Admin compatibility never carries it", () => {
    const session = (principalType: "EMPLOYEE" | "SUPER_ADMIN", permissions: string[]) => ({
      principal: { id: "p", email: "p@example.invalid", principalType },
      authorization: { organizationPermissions: permissions },
    }) as unknown as AuthSession;
    expect(canAccessAdminPath(session("EMPLOYEE", ["reward.read"]), "/admin/rewards")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["reward.read", "reward.manage"]), "/admin")).toBe(true);
    expect(canAccessAdminPath(session("EMPLOYEE", ["performance.read"]), "/admin/rewards")).toBe(false);
    expect(canAccessAdminPath(session("SUPER_ADMIN", ["employees.manage"]), "/admin/rewards")).toBe(false);
  });
});

describe("REWARD-001 employee screens", () => {
  it("lists recipients without any score, and one's own awards with the certificate", () => {
    const recipients = renderToStaticMarkup(<RecipientsList items={[{
      id: "a1", month: "2026-10", monthLabel: "Oktober 2026", category: "UNIT", categoryLabel: "Terbaik Tilawah SMPIT", recipientName: "Siti Aminah", unitName: "SMPIT",
    }]} />);
    expect(recipients).toContain("Terbaik Tilawah SMPIT · Oktober 2026");
    expect(recipients).not.toMatch(/halaman|Peringkat \d+ dari/);
    expect(renderToStaticMarkup(<RecipientsList items={[]} />)).toContain("Belum ada penerima");

    const mine = renderToStaticMarkup(<MyAwardsList items={[
      { id: "a1", month: "2026-10", monthLabel: "Oktober 2026", category: "UNIT", categoryLabel: "Terbaik Tilawah SMPIT", status: "ACTIVE", revokeReason: null, certificateReady: true },
      { id: "a2", month: "2026-09", monthLabel: "September 2026", category: "UNIT", categoryLabel: "Terbaik Tilawah SMPIT", status: "REVOKED", revokeReason: "Koreksi data", certificateReady: true },
    ]} />);
    expect(mine).toContain('href="/api/me/rewards/a1/certificate"');
    expect(mine).not.toContain("/api/me/rewards/a2/certificate");
    expect(mine).toContain("Dicabut: Koreksi data");
  });

  it("the Al-Qur'an menu and service are a link to the application, not its data", () => {
    expect(renderToStaticMarkup(<QuranLinkCard />)).toContain(`href="${QURAN_APP_URL}"`);
    expect(QURAN_APP_URL).toBe("https://quran.sabilulquran.or.id");
    expect(getEmployeeService("quran")?.href).toBe(QURAN_APP_URL);
    expect(getEmployeeService("rewards")?.href).toBe("/app/rewards");
  });

  it("the public certificate check shows validity, name, category and month only", () => {
    const valid = renderToStaticMarkup(<CertificateCheckView result={{
      status: "VALID", recipientName: "Siti Aminah", categoryLabel: "Terbaik Tilawah SMPIT", month: "2026-10", monthLabel: "Oktober 2026",
    }} />);
    expect(valid).toContain("Sertifikat sah");
    const revoked = renderToStaticMarkup(<CertificateCheckView result={{
      status: "REVOKED", recipientName: "Siti Aminah", categoryLabel: "Terbaik Tilawah SMPIT", month: "2026-10", monthLabel: "Oktober 2026",
    }} />);
    expect(revoked).toContain("sudah dicabut");
  });

  it("formats months in Indonesian and picks last month in WIB", () => {
    expect(monthLabel("2026-01")).toBe("Januari 2026");
    expect(previousMonth(new Date("2026-11-30T18:00:00Z"))).toBe("2026-11");
    expect(previousMonth(new Date("2026-01-10T00:00:00Z"))).toBe("2025-12");
  });
});
