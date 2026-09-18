export type EmployeeServiceStage = "available" | "discovery" | "deferred";

export interface EmployeeServiceDefinition {
  key: string;
  label: string;
  description: string;
  featureIds: string[];
  stage: EmployeeServiceStage;
  href: string;
}

export const employeeServices: EmployeeServiceDefinition[] = [
  {
    key: "attendance",
    label: "Kehadiran",
    description: "Lihat rekaman jam masuk dan jam keluar yang sudah tercatat.",
    featureIds: ["ATT-001"],
    stage: "available",
    href: "/app/attendance",
  },
  {
    key: "leave",
    label: "Cuti & Izin",
    description: "Ajukan dan pantau cuti serta izin yang tersedia untuk Anda.",
    featureIds: ["LEAVE-001", "LEAVE-002"],
    stage: "available",
    href: "/app/leave",
  },
  {
    key: "payslips",
    label: "Slip Gaji",
    description: "Baca slip gaji yang sudah dipublikasikan untuk akun Anda.",
    featureIds: ["PAY-002"],
    stage: "available",
    href: "/app/payslips",
  },
  {
    key: "approvals",
    label: "Persetujuan",
    description: "Tindak lanjuti pengajuan yang membutuhkan keputusan Anda.",
    featureIds: ["APR-001"],
    stage: "available",
    href: "/app/approvals",
  },
  {
    key: "profile-change",
    label: "Data Saya",
    description: "Pengajuan perubahan data pegawai secara terkontrol.",
    featureIds: ["EMP-003"],
    stage: "discovery",
    href: "/app/services/profile-change",
  },
  {
    key: "attendance-clarification",
    label: "Klarifikasi Kehadiran",
    description: "Klarifikasi dan izin terkait catatan kehadiran.",
    featureIds: ["ATT-002"],
    stage: "discovery",
    href: "/app/services/attendance-clarification",
  },
  {
    key: "work-schedule",
    label: "Jadwal Kerja",
    description: "Jadwal kerja, hari libur, dan informasi shift.",
    featureIds: ["ATT-003"],
    stage: "discovery",
    href: "/app/services/work-schedule",
  },
  {
    key: "reimbursement",
    label: "Reimbursement",
    description: "Pengajuan dan persetujuan penggantian biaya.",
    featureIds: ["REIMB-001"],
    stage: "deferred",
    href: "/app/services/reimbursement",
  },
  {
    key: "loan",
    label: "Pinjaman",
    description: "Pengajuan pinjaman pegawai dan pemantauan angsuran.",
    featureIds: ["LOAN-001"],
    stage: "discovery",
    href: "/app/services/loan",
  },
  {
    key: "performance",
    label: "Kinerja",
    description: "Penilaian kinerja dan riwayat hasil pengembangan.",
    featureIds: ["PERF-001"],
    stage: "discovery",
    href: "/app/services/performance",
  },
  {
    key: "training",
    label: "Pengembangan",
    description: "Pelatihan internal dan catatan pembelajaran pegawai.",
    featureIds: ["TRAIN-001"],
    stage: "discovery",
    href: "/app/services/training",
  },
  {
    key: "documents",
    label: "Dokumen",
    description: "Layanan surat keterangan kerja dan dokumen kepegawaian.",
    featureIds: ["DOC-001", "DOC-002"],
    stage: "discovery",
    href: "/app/services/documents",
  },
  {
    key: "announcements",
    label: "Pengumuman",
    description: "Pengumuman dan pengingat penting dari organisasi.",
    featureIds: ["NOTIF-002", "NOTIF-003"],
    stage: "discovery",
    href: "/app/services/announcements",
  },
];

export function getEmployeeService(key: string) {
  return employeeServices.find((service) => service.key === key) ?? null;
}

export function employeeServiceStageLabel(stage: EmployeeServiceStage) {
  if (stage === "available") return "Tersedia";
  if (stage === "deferred") return "Setelah MVP";
  return "Dalam perencanaan";
}
