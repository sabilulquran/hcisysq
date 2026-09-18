export type AdminServiceStage = "discovery" | "planned" | "deferred";

export type AdminServiceCategory =
  | "attendance"
  | "payroll-benefits"
  | "talent"
  | "employee-services"
  | "organization";

export interface AdminServiceDefinition {
  key: string;
  label: string;
  description: string;
  featureIds: string[];
  stage: AdminServiceStage;
  category: AdminServiceCategory;
  href: string;
  details?: string[];
}

export const adminServiceCategories: Array<{
  key: AdminServiceCategory;
  label: string;
  description: string;
}> = [
  {
    key: "attendance",
    label: "Waktu & Kehadiran",
    description: "Konfigurasi jadwal, metode presensi, evaluasi kehadiran, dan shift.",
  },
  {
    key: "payroll-benefits",
    label: "Payroll & Benefit",
    description: "Payroll, reimbursement, dan layanan finansial pegawai.",
  },
  {
    key: "talent",
    label: "Talent & Pengembangan",
    description: "Kinerja, pembelajaran, dan proses rekrutmen.",
  },
  {
    key: "employee-services",
    label: "Layanan Pegawai",
    description: "Perjalanan dinas, aset, workplace, dokumen, dan komunikasi.",
  },
  {
    key: "organization",
    label: "Organisasi & Lokasi",
    description: "Site, cabang, dan lokasi kerja dalam satu organisasi YSQ.",
  },
];

export const adminServices: AdminServiceDefinition[] = [
  {
    key: "schedules",
    label: "Jadwal & Shift",
    description: "Atur jadwal kerja, hari libur, dan penugasan shift.",
    featureIds: ["ATT-003"],
    stage: "discovery",
    category: "attendance",
    href: "/admin/services/schedules",
  },
  {
    key: "mobile-attendance",
    label: "Mobile Attendance",
    description: "Kebijakan clock in/out HP dan evidence kehadiran.",
    featureIds: ["ATT-006"],
    stage: "planned",
    category: "attendance",
    href: "/admin/services/mobile-attendance",
    details: ["GPS", "Geotagging / geofence", "Foto kehadiran", "Face recognition"],
  },
  {
    key: "attendance-evaluation",
    label: "Evaluasi Kehadiran & Lembur",
    description: "Atur evaluasi terlambat, lembur, dan outcome berbasis jadwal.",
    featureIds: ["ATT-007"],
    stage: "planned",
    category: "attendance",
    href: "/admin/services/attendance-evaluation",
  },
  {
    key: "shift-exchange",
    label: "Tukar Shift",
    description: "Atur kebijakan pertukaran shift dan alur persetujuannya.",
    featureIds: ["ATT-008"],
    stage: "planned",
    category: "attendance",
    href: "/admin/services/shift-exchange",
  },
  {
    key: "payroll",
    label: "Payroll",
    description: "Perhitungan, review, rekonsiliasi, finalisasi, dan publikasi payroll.",
    featureIds: ["PAY-003"],
    stage: "planned",
    category: "payroll-benefits",
    href: "/admin/services/payroll",
  },
  {
    key: "reimbursement",
    label: "Reimbursement",
    description: "Kelola pengajuan dan persetujuan penggantian biaya.",
    featureIds: ["REIMB-001"],
    stage: "deferred",
    category: "payroll-benefits",
    href: "/admin/services/reimbursement",
  },
  {
    key: "loans",
    label: "Pinjaman Pegawai",
    description: "Kelola pengajuan, persetujuan, dan angsuran pinjaman pegawai.",
    featureIds: ["LOAN-001"],
    stage: "discovery",
    category: "payroll-benefits",
    href: "/admin/services/loans",
  },
  {
    key: "performance",
    label: "Kinerja / KPI",
    description: "Kelola sasaran, indikator, penilaian, dan hasil kinerja.",
    featureIds: ["PERF-001"],
    stage: "discovery",
    category: "talent",
    href: "/admin/services/performance",
  },
  {
    key: "learning",
    label: "Training / LMS",
    description: "Kelola pelatihan, pembelajaran, dan riwayat pengembangan.",
    featureIds: ["TRAIN-001"],
    stage: "discovery",
    category: "talent",
    href: "/admin/services/learning",
  },
  {
    key: "recruitment",
    label: "Recruitment",
    description: "Kelola kandidat, proses seleksi, interview, dan keputusan rekrutmen.",
    featureIds: ["REC-001"],
    stage: "discovery",
    category: "talent",
    href: "/admin/services/recruitment",
  },
  {
    key: "business-travel",
    label: "Perjalanan Dinas",
    description: "Kelola pengajuan, approval, surat tugas, dan administrasi perjalanan.",
    featureIds: ["TRIP-001"],
    stage: "planned",
    category: "employee-services",
    href: "/admin/services/business-travel",
  },
  {
    key: "assets",
    label: "Asset Pegawai",
    description: "Kelola penyerahan, pemegang, kondisi, dan pengembalian aset kerja.",
    featureIds: ["ASSET-001"],
    stage: "planned",
    category: "employee-services",
    href: "/admin/services/assets",
  },
  {
    key: "workplace",
    label: "Desk / Workplace Booking",
    description: "Kelola resource kerja bersama dan reservasinya.",
    featureIds: ["WORK-001"],
    stage: "planned",
    category: "employee-services",
    href: "/admin/services/workplace",
  },
  {
    key: "documents",
    label: "Dokumen Kepegawaian",
    description: "Kelola surat keterangan, surat peringatan, dan dokumen HR terkait.",
    featureIds: ["DOC-001", "DOC-002"],
    stage: "discovery",
    category: "employee-services",
    href: "/admin/services/documents",
  },
  {
    key: "communications",
    label: "Pengumuman & Notifikasi",
    description: "Kelola pengumuman, reminder, dan delivery notifikasi.",
    featureIds: ["NOTIF-001", "NOTIF-002", "NOTIF-003"],
    stage: "discovery",
    category: "employee-services",
    href: "/admin/services/communications",
  },
  {
    key: "sites",
    label: "Lokasi & Cabang",
    description: "Kelola site, cabang, dan lokasi kerja dalam satu organisasi.",
    featureIds: ["ORG-005"],
    stage: "planned",
    category: "organization",
    href: "/admin/services/sites",
  },
];

export function getAdminService(key: string) {
  return adminServices.find((service) => service.key === key) ?? null;
}

export function adminServiceStageLabel(stage: AdminServiceStage) {
  if (stage === "deferred") return "Setelah MVP";
  if (stage === "planned") return "Direncanakan";
  return "Dalam perencanaan";
}
