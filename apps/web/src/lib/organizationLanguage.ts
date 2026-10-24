// ORG-008-1: operator vocabulary for Struktur Organisasi.
//
// The backend keeps ORG-004 enums, codes, and stable keys; this module is the only place that turns
// them into the operator wording fixed by the ORG-008 spec (§3 kamus istilah, §7 pesan masalah).
// Nothing here changes resolver semantics, effective dating, approval snapshots, or rollout.

import type {
  OrganizationDraftStatus,
  OrganizationPosition,
  OrganizationRolloutConfiguration,
  OrganizationValidationIssue,
  OrganizationVacancyPolicy,
} from "@/lib/organizationDesigner";

const NODE_TYPE_LABELS: Record<string, string> = {
  FOUNDATION: "Yayasan",
  DIRECTORATE: "Bidang",
  UNIT: "Sekolah/Unit",
  DIVISION: "Divisi",
  DEPARTMENT: "Bagian",
  TEAM: "Tim",
};

/** Unknown node types must never leak the raw enum onto the main screen (acceptance ORG-008-J). */
export function organizationNodeTypeLabel(nodeType: string): string {
  return NODE_TYPE_LABELS[nodeType.trim().toUpperCase()] ?? "Unit lainnya";
}

const VACANCY_POLICY_LABELS: Record<OrganizationVacancyPolicy, string> = {
  CLIMB_TO_PARENT: "Bila kosong: naik ke atasan berikutnya",
  REQUIRE_ACTING_OR_BLOCK: "Bila kosong: wajib ada Plt, kalau tidak pengajuan ditahan",
  BLOCK: "Bila kosong: pengajuan ditahan",
};

export function organizationVacancyPolicyLabel(policy: OrganizationVacancyPolicy): string {
  return VACANCY_POLICY_LABELS[policy] ?? VACANCY_POLICY_LABELS.CLIMB_TO_PARENT;
}

const AUTHORITY_LABELS: Record<string, string> = {
  LEADER: "Pemimpin unit",
  UNIT_APPROVER: "Penyetuju cuti unit",
  SUPERVISORY_PARENT: "Melapor ke",
  GOVERNANCE_APPROVER: "Penyetuju khusus untuk jabatan ini",
  OVERSIGHT_PARENT: "Diberi tahu setelah disetujui",
};

export function organizationAuthorityLabel(authorityType: string): string {
  return AUTHORITY_LABELS[authorityType] ?? "Kewenangan lain";
}

/**
 * Operator wording for a change set. PUBLISHED depends on whether its effective date has arrived,
 * so the caller supplies today's Jakarta business date and a formatter for the date itself.
 */
export function organizationDraftStatusLabel(
  status: OrganizationDraftStatus,
  input?: { effectiveOn?: string; today?: string; formatDate?: (value: string) => string },
): string {
  if (status === "DRAFT") return "Sedang disusun";
  if (status === "VALIDATED") return "Siap diterbitkan";
  const effectiveOn = input?.effectiveOn;
  const today = input?.today;
  if (effectiveOn && today && effectiveOn > today) {
    const shown = input?.formatDate ? input.formatDate(effectiveOn) : effectiveOn;
    return `Terjadwal berlaku ${shown}`;
  }
  return "Berlaku";
}

const ISSUE_SENTENCES: Record<string, (name: string | null) => string> = {
  PRIMARY_MEMBERSHIP_OVERLAP: (name) =>
    name
      ? `${name} tercatat di lebih dari satu unit pada periode yang sama. Pilih satu unit.`
      : "Ada pegawai yang tercatat di lebih dari satu unit pada periode yang sama. Pilih satu unit.",
  PRIMARY_INCUMBENCY_OVERLAP: (name) =>
    name
      ? `Jabatan ${name} punya dua pejabat pada periode yang sama.`
      : "Ada jabatan yang punya dua pejabat pada periode yang sama.",
  AUTHORITY_BINDING_OVERLAP: (name) =>
    name
      ? `Unit ${name} punya dua pemimpin atau penyetuju untuk periode yang sama. Hapus salah satu.`
      : "Ada unit dengan dua pemimpin atau penyetuju untuk periode yang sama. Hapus salah satu.",
  STRUCTURAL_NODE_CYCLE: (name) =>
    name
      ? `Hubungan induk unit berputar dan kembali ke ${name}.`
      : "Hubungan induk antar unit berputar kembali ke dirinya sendiri.",
  SUPERVISORY_POSITION_CYCLE: (name) =>
    name
      ? `Hubungan melapor berputar dan kembali ke ${name}.`
      : "Hubungan melapor berputar kembali ke jabatan yang sama.",
  AUTHORITY_LOOP: (name) =>
    name
      ? `Rantai kewenangan berputar dan kembali ke ${name}.`
      : "Rantai kewenangan berputar kembali ke titik yang sama.",
  INACTIVE_INCUMBENT: (name) =>
    name
      ? `${name} sudah tidak aktif tetapi masih tercatat menjabat.`
      : "Ada pejabat yang sudah tidak aktif tetapi masih tercatat menjabat.",
  AUTHORITY_NOT_CONFIGURED: (name) =>
    name
      ? `Unit ${name} dan unit di atasnya belum punya pemimpin.`
      : "Ada unit yang bersama unit di atasnya belum punya pemimpin.",
  MEMBERSHIP_NOT_CONFIGURED: (name) =>
    name ? `${name} belum punya unit.` : "Ada pegawai yang belum punya unit.",
  AMBIGUOUS_MEMBERSHIP: (name) =>
    name ? `${name} anggota lebih dari satu unit.` : "Ada pegawai yang menjadi anggota lebih dari satu unit.",
  AUTHORITY_VACANT: (name) =>
    name
      ? `Jabatan ${name} kosong dan aturannya menahan pengajuan.`
      : "Ada jabatan kosong yang aturannya menahan pengajuan.",
  ACTING_AUTHORITY_REQUIRED: (name) =>
    name ? `Jabatan ${name} kosong dan wajib Plt.` : "Ada jabatan kosong yang wajib diisi Plt.",
  AUTHORITY_INELIGIBLE: (name) =>
    name
      ? `${name} menjadi atasan tetapi belum punya akun HCIS aktif atau izin menyetujui.`
      : "Ada atasan yang belum punya akun HCIS aktif atau izin menyetujui.",
  AUTHORITY_SELF_RESOLUTION: (name) =>
    name
      ? `${name} akan menjadi atasan dirinya sendiri. Periksa "Melapor ke" jabatannya.`
      : 'Ada pegawai yang akan menjadi atasan dirinya sendiri. Periksa "Melapor ke" jabatannya.',
  AUTHORITY_TRAVERSAL_LIMIT: () =>
    "Rantai atasan terlalu panjang; periksa hubungan melapor antar jabatan.",
  INVALID_AUTHORITY_PRINCIPAL: (name) =>
    name
      ? `Jabatan ${name} belum punya pejabat yang dapat dipakai sebagai atasan.`
      : "Ada jabatan tanpa pejabat yang dapat dipakai sebagai atasan.",
  PRIMARY_STRUCTURAL_EDIT_REQUIRES_REVIEW: (name) =>
    name
      ? `${name} memegang lebih dari satu jabatan. Tentukan jabatan utamanya dulu.`
      : "Pejabat ini memegang lebih dari satu jabatan. Tentukan jabatan utamanya dulu.",
  ACCOUNT_HELD_POSITION_EDIT_REQUIRES_REVIEW: (name) =>
    name
      ? `Jabatan ${name} dipegang akun Dewan dan belum bisa diubah di sini.`
      : "Jabatan ini dipegang akun Dewan dan belum bisa diubah di sini.",
  ORGANIZATION_DRAFT_BASE_STALE: (name) =>
    name
      ? `Struktur sudah diubah oleh "${name}". Perbarui perubahan ini dulu.`
      : "Struktur sudah diubah oleh perubahan lain. Perbarui perubahan ini dulu.",
  ORGANIZATION_DRAFT_CHANGED: (name) =>
    name
      ? `Perubahan ini baru saja diubah ${name}. Muat ulang halaman.`
      : "Perubahan ini baru saja diubah orang lain. Muat ulang halaman.",
};

/** Prefix families whose exact code varies per referenced entity (INVALID_NODE_PARENT, ...). */
function invalidReferenceSentence(code: string, name: string | null): string | null {
  if (!/^INVALID_.*(PARENT|REFERENCE)$/.test(code)) return null;
  return name
    ? `${name} menunjuk ke unit atau jabatan yang sudah tidak ada.`
    : "Ada item yang menunjuk ke unit atau jabatan yang sudah tidak ada.";
}

/**
 * Turns one validation issue into an operator sentence. `resolveName` looks the referenced item up in
 * the loaded chart; when it returns null the sentence stays truthful instead of inventing a name.
 */
export function organizationIssueSentence(
  issue: Pick<OrganizationValidationIssue, "code" | "itemKey">,
  resolveName?: (itemKey: string) => string | null,
): string {
  const name = issue.itemKey && resolveName ? resolveName(issue.itemKey) : null;
  const sentence = ISSUE_SENTENCES[issue.code];
  if (sentence) return sentence(name);
  const reference = invalidReferenceSentence(issue.code, name);
  if (reference) return reference;
  return name
    ? `${name} belum dapat diproses. Hubungi dukungan teknis dengan detail teknis di bawah.`
    : "Ada masalah struktur yang belum dapat dijelaskan di layar ini. Hubungi dukungan teknis dengan detail teknis di bawah.";
}

const API_MESSAGES: Record<string, string> = {
  ORGANIZATION_DRAFT_NOT_FOUND:
    "Perubahan struktur ini tidak ditemukan. Mungkin sudah diterbitkan atau dihapus.",
  ORGANIZATION_DRAFT_NOT_EDITABLE:
    "Perubahan ini sudah diperiksa sehingga tidak bisa diubah lagi. Buat perubahan baru untuk memperbaikinya.",
  ORGANIZATION_DRAFT_NOT_VALIDATED:
    'Perubahan ini harus diperiksa dulu. Tekan "Periksa" sebelum menerbitkan.',
  ORGANIZATION_RESOLUTION_FAILED:
    "Atasan belum bisa ditentukan untuk pegawai ini. Periksa pemimpin unit dan jabatan kosongnya.",
  INVALID_EFFECTIVE_DATE: "Tanggal berlaku tidak dapat dibaca. Pilih tanggal lagi.",
  INVALID_ORGANIZATION_DRAFT: "Nama perubahan dan tanggal berlaku wajib diisi.",
  FORBIDDEN: "Anda tidak punya izin untuk tindakan ini.",
  UNAUTHENTICATED: "Sesi Anda sudah berakhir. Masuk kembali untuk melanjutkan.",
};

/** Operator wording for an API failure; falls back to the caller's sentence, never to the raw code. */
export function organizationApiMessage(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  const direct = API_MESSAGES[code];
  if (direct) return direct;
  const issueSentence = ISSUE_SENTENCES[code];
  if (issueSentence) return issueSentence(null);
  return fallback;
}

export type OrganizationSeatEditability = {
  editable: boolean;
  /** Short badge wording; null while the seat is editable. */
  badge: string | null;
  /** Why it is read-only and what resolves it, in operator wording. */
  reason: string | null;
};

/**
 * ORG-008-1 §4.8: a seat the API will refuse must say so before it is opened, not after a 409.
 * Mirrors exactly the two refusals in `PUT /drafts/:id/incumbencies`: an account-held position
 * (holder_source = ACCOUNT, or an account principal already recorded on it) and a holder recorded as
 * the primary structural seat of someone holding several seats.
 */
export function organizationSeatEditability(position: OrganizationPosition): OrganizationSeatEditability {
  const incumbents = [position.primaryIncumbent, position.actingIncumbent].filter(
    (item): item is NonNullable<typeof item> => Boolean(item),
  );
  if (position.holderSource === "ACCOUNT" || incumbents.some((item) => item.accountId)) {
    return {
      editable: false,
      badge: "Belum bisa diubah di sini",
      reason:
        "Jabatan ini dipegang akun Dewan. Pejabatnya belum bisa diubah dari layar ini sampai pemetaan akun Dewan diputuskan.",
    };
  }
  if (incumbents.some((item) => item.isPrimaryStructural)) {
    return {
      editable: false,
      badge: "Belum bisa diubah di sini",
      reason:
        "Pejabat ini memegang lebih dari satu jabatan. Jabatan utamanya harus ditentukan lebih dulu sebelum pejabatnya diubah di sini.",
    };
  }
  return { editable: true, badge: null, reason: null };
}

export type OrganizationModeBanner = {
  tone: "info" | "warning";
  /** True only when zero rollout rows exist, which is the one state this screen can prove. */
  certain: boolean;
  title: string;
  detail: string;
};

const ROLLOUT_MODE_WORDING: Record<string, string> = {
  LEGACY: "data atasan lama",
  SHADOW: "uji banding (data lama tetap dipakai)",
  STRUCTURE: "struktur ini",
};

/**
 * ORG-008-1 §4.1 banner. `GET /admin/organization/rollout` returns only the newest row regardless of
 * workflow, unit, or effective date, while the resolver picks the row effective for that workflow and
 * unit. So this screen may state LEGACY as a fact only while no rollout row exists at all — the
 * endpoint then answers with its default object and no `updatedAt`. ORG-008-2 extends the endpoint
 * per workflow; until then any configured row is reported as "not verifiable here" rather than guessed.
 */
export function organizationModeBanner(
  rollout: OrganizationRolloutConfiguration | null,
  options?: { loadFailed?: boolean; pending?: boolean },
): OrganizationModeBanner {
  if (options?.pending && !options.loadFailed && !rollout) {
    return {
      tone: "info",
      certain: false,
      title: "Memeriksa mode persetujuan...",
      detail: "Sebentar lagi halaman ini menyatakan apakah persetujuan cuti memakai data atasan lama atau struktur.",
    };
  }
  if (options?.loadFailed || !rollout) {
    return {
      tone: "warning",
      certain: false,
      title: "Mode persetujuan tidak dapat dimuat.",
      detail:
        "Halaman ini tidak dapat memastikan apakah persetujuan cuti memakai data atasan lama atau struktur. Coba muat ulang halaman.",
    };
  }
  if (rollout.updatedAt === undefined) {
    return {
      tone: "info",
      certain: true,
      title: "Persetujuan cuti saat ini memakai data atasan lama.",
      detail:
        "Sumbernya Detail Pegawai dan Konfigurasi Cuti. Struktur di halaman ini belum dipakai untuk persetujuan, dan menerbitkan struktur tidak mengubahnya.",
    };
  }
  const wording = ROLLOUT_MODE_WORDING[rollout.mode] ?? "pengaturan yang belum dikenali";
  return {
    tone: "warning",
    certain: false,
    title: "Mode persetujuan tidak dapat dipastikan dari halaman ini.",
    detail: `Sudah ada pengaturan rollout yang tercatat (${wording}), tetapi halaman ini belum dapat menampilkan mode yang berlaku untuk setiap unit dan jenis pengajuan. Periksa pengaturan rollout sebelum menyimpulkan.`,
  };
}
