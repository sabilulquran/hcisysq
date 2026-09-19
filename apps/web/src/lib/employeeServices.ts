export type EmployeeServiceStage = "available" | "discovery" | "planned" | "deferred";

export type EmployeeServiceCategory =
  | "time-attendance"
  | "leave"
  | "tasks"
  | "finance"
  | "development"
  | "employee-services"
  | "information";

export interface EmployeeServiceDefinition {
  key: string;
  label: string;
  description: string;
  featureIds: string[];
  stage: EmployeeServiceStage;
  category: EmployeeServiceCategory;
  href: string;
  details?: string[];
}

export const employeeServiceCategories: Array<{
  key: EmployeeServiceCategory;
  label: string;
  description: string;
}> = [
  {
    key: "time-attendance",
    label: "Waktu & Kehadiran",
    description: "Kehadiran harian, jadwal kerja, shift, dan tindak lanjut waktu kerja.",
  },
  {
    key: "leave",
    label: "Cuti",
    description: "Pengajuan cuti, izin, dan informasi saldo hak cuti.",
  },
  {
    key: "tasks",
    label: "Tugas & Persetujuan",
    description: "Hal yang memerlukan keputusan atau tindakan Anda.",
  },
  {
    key: "finance",
    label: "Keuangan Saya",
    description: "Dokumen kompensasi dan layanan finansial pegawai.",
  },
  {
    key: "development",
    label: "Kinerja & Pengembangan",
    description: "Kinerja, KPI, pelatihan, dan catatan pembelajaran.",
  },
  {
    key: "employee-services",
    label: "Layanan Pegawai",
    description: "Administrasi pribadi, perjalanan, aset, dan fasilitas kerja.",
  },
  {
    key: "information",
    label: "Informasi",
    description: "Pengumuman, notifikasi, dan pengingat organisasi.",
  },
];

export const employeeServices: EmployeeServiceDefinition[] = [
  {
    key: "attendance",
    label: "Kehadiran",
    description: "Lihat rekaman jam masuk dan jam keluar yang sudah tercatat.",
    featureIds: ["ATT-001"],
    stage: "available",
    category: "time-attendance",
    href: "/app/attendance",
  },
  {
    key: "clock-in",
    label: "Clock In/Out",
    description: "Presensi dari HP dengan evidence yang sesuai kebijakan.",
    featureIds: ["ATT-006"],
    stage: "available",
    category: "time-attendance",
    href: "/app/attendance/clock",
    details: ["GPS", "Geotagging / geofence", "Foto kehadiran", "Face recognition"],
  },
  {
    key: "work-schedule",
    label: "Jadwal & Shift",
    description: "Jadwal kerja, hari libur, dan penugasan shift.",
    featureIds: ["ATT-003"],
    stage: "available",
    category: "time-attendance",
    href: "/app/attendance/clock",
  },
  {
    key: "shift-swap",
    label: "Tukar Shift",
    description: "Ajukan pertukaran shift dengan alur persetujuan yang terkontrol.",
    featureIds: ["ATT-008"],
    stage: "planned",
    category: "time-attendance",
    href: "/app/services/shift-swap",
  },
  {
    key: "attendance-clarification",
    label: "Klarifikasi Kehadiran",
    description: "Klarifikasi dan izin terkait catatan kehadiran.",
    featureIds: ["ATT-002"],
    stage: "available",
    category: "time-attendance",
    href: "/app/attendance/clock",
  },
  {
    key: "lateness",
    label: "Keterlambatan",
    description: "Lihat hasil evaluasi keterlambatan berbasis jadwal dan kebijakan.",
    featureIds: ["ATT-007"],
    stage: "available",
    category: "time-attendance",
    href: "/app/attendance/clock",
  },
  {
    key: "overtime",
    label: "Lembur",
    description: "Pengajuan, persetujuan, dan hasil lembur berbasis kebijakan.",
    featureIds: ["ATT-007"],
    stage: "planned",
    category: "time-attendance",
    href: "/app/services/overtime",
  },
  {
    key: "leave",
    label: "Cuti & Izin",
    description: "Ajukan dan pantau cuti serta izin yang tersedia untuk Anda.",
    featureIds: ["LEAVE-001"],
    stage: "available",
    category: "leave",
    href: "/app/leave",
  },
  {
    key: "leave-balance",
    label: "Saldo Cuti",
    description: "Lihat hak dan saldo cuti yang berlaku untuk Anda.",
    featureIds: ["LEAVE-002"],
    stage: "available",
    category: "leave",
    href: "/app/leave",
  },
  {
    key: "approvals",
    label: "Persetujuan",
    description: "Tindak lanjuti pengajuan yang membutuhkan keputusan Anda.",
    featureIds: ["APR-001"],
    stage: "available",
    category: "tasks",
    href: "/app/approvals",
  },
  {
    key: "payslips",
    label: "Slip Gaji",
    description: "Baca slip gaji yang sudah dipublikasikan untuk akun Anda.",
    featureIds: ["PAY-002"],
    stage: "available",
    category: "finance",
    href: "/app/payslips",
  },
  {
    key: "reimbursement",
    label: "Reimbursement",
    description: "Pengajuan dan persetujuan penggantian biaya.",
    featureIds: ["REIMB-001"],
    stage: "deferred",
    category: "finance",
    href: "/app/services/reimbursement",
  },
  {
    key: "loan",
    label: "Pinjaman",
    description: "Pengajuan pinjaman pegawai dan pemantauan angsuran.",
    featureIds: ["LOAN-001"],
    stage: "discovery",
    category: "finance",
    href: "/app/services/loan",
  },
  {
    key: "performance",
    label: "Kinerja / KPI",
    description: "Sasaran, penilaian kinerja, dan riwayat hasil evaluasi.",
    featureIds: ["PERF-001"],
    stage: "discovery",
    category: "development",
    href: "/app/services/performance",
  },
  {
    key: "training",
    label: "Training / LMS",
    description: "Pelatihan internal, pembelajaran, dan catatan pengembangan.",
    featureIds: ["TRAIN-001"],
    stage: "discovery",
    category: "development",
    href: "/app/services/training",
  },
  {
    key: "profile-change",
    label: "Data Saya",
    description: "Lihat dan ajukan perubahan data pegawai secara terkontrol.",
    featureIds: ["EMP-003"],
    stage: "discovery",
    category: "employee-services",
    href: "/app/services/profile-change",
  },
  {
    key: "documents",
    label: "Dokumen",
    description: "Surat keterangan dan dokumen kepegawaian.",
    featureIds: ["DOC-001", "DOC-002"],
    stage: "discovery",
    category: "employee-services",
    href: "/app/services/documents",
  },
  {
    key: "business-travel",
    label: "Perjalanan Dinas",
    description: "Ajukan dan pantau perjalanan atau penugasan dinas.",
    featureIds: ["TRIP-001"],
    stage: "planned",
    category: "employee-services",
    href: "/app/services/business-travel",
  },
  {
    key: "assets",
    label: "Asset Saya",
    description: "Lihat aset organisasi yang menjadi tanggung jawab Anda.",
    featureIds: ["ASSET-001"],
    stage: "planned",
    category: "employee-services",
    href: "/app/services/assets",
  },
  {
    key: "desk-booking",
    label: "Desk Booking",
    description: "Pesan meja atau fasilitas kerja bersama yang tersedia.",
    featureIds: ["WORK-001"],
    stage: "planned",
    category: "employee-services",
    href: "/app/services/desk-booking",
  },
  {
    key: "announcements",
    label: "Pengumuman",
    description: "Informasi dan pengumuman penting dari organisasi.",
    featureIds: ["NOTIF-002"],
    stage: "discovery",
    category: "information",
    href: "/app/services/announcements",
  },
  {
    key: "notifications",
    label: "Notifikasi & Pengingat",
    description: "Pengingat dan notifikasi transaksi atau agenda yang relevan.",
    featureIds: ["NOTIF-001", "NOTIF-003"],
    stage: "discovery",
    category: "information",
    href: "/app/services/notifications",
  },
];

export function getEmployeeService(key: string) {
  return employeeServices.find((service) => service.key === key) ?? null;
}

export function employeeServiceStageLabel(stage: EmployeeServiceStage) {
  if (stage === "available") return "Tersedia";
  if (stage === "deferred") return "Setelah MVP";
  if (stage === "planned") return "Direncanakan";
  return "Dalam perencanaan";
}
