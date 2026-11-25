import {
  ANNUAL_LEAVE_ELIGIBILITY_MONTHS,
  ANNUAL_LEAVE_ENTITLEMENT_DAYS,
  ANNUAL_LEAVE_MINIMUM_NOTICE_DAYS,
  type LeaveEntitlementGroup,
} from "./annual-leave-policy.js";

export type LeaveRequestMode = "individual" | "organization_event" | "dispensation";
export type LeaveLineHandling = "approval" | "notify" | "none";
export type LeaveHcHandling = "notify" | "validate" | "approve" | "none";
export type LeaveEvidenceRequirement =
  | "none"
  | "required"
  | "required_deferred_allowed"
  | "conditional";

export type LeavePolicyKey =
  | "academic_break"
  | "annual"
  | "foundation_collective"
  | "maternity"
  | "miscarriage"
  | "menstruation_rest"
  | "sick"
  | "employee_marriage"
  | "child_marriage"
  | "child_circumcision"
  | "spouse_childbirth"
  | "spouse_miscarriage"
  | "family_bereavement"
  | "hajj"
  | "unpaid"
  | "force_majeure";

export interface LeavePolicyDefinition {
  key: LeavePolicyKey;
  name: string;
  requestMode: LeaveRequestMode;
  lineHandling: LeaveLineHandling;
  hcHandling: LeaveHcHandling;
  entitlementGroup: LeaveEntitlementGroup | "all";
  minimumNoticeDays: number | null;
  evidenceRequirement: LeaveEvidenceRequirement;
  emergencyNoticeAllowed: boolean;
  annualEntitlementDays?: number;
  eligibilityMonths?: number;
  // LEAVE-003 R2 removed `periodLimitDays`: a quota limit that depends on the leave date cannot be
  // stated once in a static catalogue. It lives in the year view and in `annualQuota` instead.
  carryForwardEnabled?: boolean;
  notes: string[];
}

export const LEAVE_POLICY_CATALOG: readonly LeavePolicyDefinition[] = [
  {
    key: "academic_break",
    name: "Cuti Akhir Semester & Akhir Tahun Pelajaran",
    requestMode: "organization_event",
    lineHandling: "none",
    hcHandling: "none",
    entitlementGroup: "education",
    minimumNoticeDays: null,
    evidenceRequirement: "none",
    emergencyNoticeAllowed: false,
    notes: [
      "Ditetapkan mengikuti kalender akademik dan keputusan Yayasan.",
      "Menjadi pelaksanaan/pemenuhan hak cuti tahunan tenaga pendidikan.",
    ],
  },
  {
    key: "annual",
    name: "Cuti Tahunan",
    requestMode: "individual",
    lineHandling: "approval",
    hcHandling: "notify",
    entitlementGroup: "non_education",
    minimumNoticeDays: ANNUAL_LEAVE_MINIMUM_NOTICE_DAYS,
    evidenceRequirement: "none",
    emergencyNoticeAllowed: false,
    annualEntitlementDays: ANNUAL_LEAVE_ENTITLEMENT_DAYS,
    eligibilityMonths: ANNUAL_LEAVE_ELIGIBILITY_MONTHS,
    // LEAVE-003 R2: no `periodLimitDays` here. The limit depends on the leave date (3 per
    // three-month period, 6 per semester), so a constant in this static catalogue would publish a
    // rule the submission route does not enforce. The live figure is `annualLeave`
    // (`currentPeriodLimitDays`, and `allocationDays` per period) and, for HC, `annualQuota`.
    carryForwardEnabled: false,
    notes: [
      "Hak tahunan tetap ditampilkan sebagai 12 hari/tahun.",
      // LEAVE-003 R2: the quota period depends on the leave date, so the live figure comes from the
      // year view (`annualLeave`), not from this static catalogue entry.
      "Pemakaian dibatasi per periode kuota yang berlaku pada tanggal cuti.",
      "Periode sebelum tanggal genap 12 bulan tidak tersedia retroaktif.",
    ],
  },
  {
    key: "foundation_collective",
    name: "Cuti Bersama Yayasan",
    requestMode: "organization_event",
    lineHandling: "none",
    hcHandling: "none",
    entitlementGroup: "all",
    minimumNoticeDays: null,
    evidenceRequirement: "none",
    emergencyNoticeAllowed: false,
    notes: ["Bukan pengajuan individual dan tidak mengurangi hak cuti tahunan."],
  },
  {
    key: "maternity",
    name: "Cuti Hamil dan Melahirkan",
    requestMode: "individual",
    lineHandling: "notify",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: 30,
    evidenceRequirement: "required",
    emergencyNoticeAllowed: false,
    notes: ["HC memvalidasi dokumen medis/HPL dan periode yang dinyatakan."],
  },
  {
    key: "miscarriage",
    name: "Cuti Keguguran",
    requestMode: "individual",
    lineHandling: "notify",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: null,
    evidenceRequirement: "required_deferred_allowed",
    emergencyNoticeAllowed: true,
    notes: ["Kondisi darurat; administrasi dapat diselesaikan setelah kejadian."],
  },
  {
    key: "menstruation_rest",
    name: "Istirahat karena Haid",
    requestMode: "individual",
    lineHandling: "notify",
    hcHandling: "notify",
    entitlementGroup: "all",
    minimumNoticeDays: null,
    evidenceRequirement: "conditional",
    emergencyNoticeAllowed: true,
    notes: [
      "Tidak memakai H-7.",
      "HC dapat meminta pemeriksaan/keterangan medis untuk penggunaan berikutnya setelah penggunaan 2 bulan berturut-turut.",
    ],
  },
  {
    key: "sick",
    name: "Cuti Sakit",
    requestMode: "individual",
    lineHandling: "notify",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: null,
    evidenceRequirement: "required_deferred_allowed",
    emergencyNoticeAllowed: true,
    notes: ["Periode mengikuti surat medis dan administrasi dapat dilengkapi setelah pemberitahuan darurat."],
  },
  {
    key: "employee_marriage",
    name: "Cuti Pernikahan Karyawan",
    requestMode: "individual",
    lineHandling: "approval",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: 7,
    evidenceRequirement: "required",
    emergencyNoticeAllowed: false,
    notes: ["Hak dasar 3 hari kerja sesuai baseline YSQ."],
  },
  {
    key: "child_marriage",
    name: "Cuti Menikahkan Anak",
    requestMode: "individual",
    lineHandling: "approval",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: 7,
    evidenceRequirement: "required",
    emergencyNoticeAllowed: false,
    notes: ["Hak dasar 2 hari kerja sesuai baseline YSQ."],
  },
  {
    key: "child_circumcision",
    name: "Cuti Khitan Anak",
    requestMode: "individual",
    lineHandling: "approval",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: 7,
    evidenceRequirement: "required",
    emergencyNoticeAllowed: false,
    notes: ["Hak dasar 2 hari kerja sesuai baseline YSQ."],
  },
  {
    key: "spouse_childbirth",
    name: "Cuti Pendampingan Istri Melahirkan",
    requestMode: "individual",
    lineHandling: "notify",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: null,
    evidenceRequirement: "required_deferred_allowed",
    emergencyNoticeAllowed: true,
    notes: [
      "2 hari kerja merupakan hak dasar.",
      "Tambahan paling lama 3 hari tidak otomatis dan membutuhkan keputusan sesuai kebijakan/kesepakatan.",
    ],
  },
  {
    key: "spouse_miscarriage",
    name: "Cuti Pendampingan Istri Keguguran",
    requestMode: "individual",
    lineHandling: "notify",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: null,
    evidenceRequirement: "required_deferred_allowed",
    emergencyNoticeAllowed: true,
    notes: ["Hak dasar 2 hari kerja; administrasi dapat dilengkapi setelah kejadian."],
  },
  {
    key: "family_bereavement",
    name: "Cuti Keluarga Meninggal Dunia",
    requestMode: "individual",
    lineHandling: "notify",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: null,
    evidenceRequirement: "required_deferred_allowed",
    emergencyNoticeAllowed: true,
    notes: ["Hak dasar 2 hari kerja untuk cakupan keluarga yang ditetapkan YSQ."],
  },
  {
    key: "hajj",
    name: "Cuti Ibadah Haji Wajib",
    requestMode: "individual",
    lineHandling: "approval",
    hcHandling: "validate",
    entitlementGroup: "all",
    minimumNoticeDays: 7,
    evidenceRequirement: "required",
    emergencyNoticeAllowed: false,
    notes: ["Diberikan 1 kali selama bekerja di Yayasan dan mengikuti jadwal/dokumen resmi."],
  },
  {
    key: "unpaid",
    name: "Cuti Tanpa Gaji",
    requestMode: "individual",
    lineHandling: "approval",
    hcHandling: "approve",
    entitlementGroup: "all",
    minimumNoticeDays: 7,
    evidenceRequirement: "none",
    emergencyNoticeAllowed: false,
    notes: [
      "Memerlukan persetujuan Kepala Satuan Kerja/Unit Approver dan Human Capital.",
      "Durasi lebih dari 3 hari memakai minimum notice 30 hari dan harus divalidasi oleh rule khusus pada request.",
    ],
  },
  {
    key: "force_majeure",
    name: "Keadaan Kahar/Bencana",
    requestMode: "dispensation",
    lineHandling: "none",
    hcHandling: "none",
    entitlementGroup: "all",
    minimumNoticeDays: null,
    evidenceRequirement: "conditional",
    emergencyNoticeAllowed: true,
    notes: ["Bukan hak cuti otomatis; ditangani sebagai dispensasi kehadiran berdasarkan keputusan pimpinan."],
  },
] as const;

export function getLeavePolicy(key: LeavePolicyKey): LeavePolicyDefinition {
  const policy = LEAVE_POLICY_CATALOG.find((candidate) => candidate.key === key);
  if (!policy) throw new Error(`Leave policy not found: ${key}`);
  return policy;
}
