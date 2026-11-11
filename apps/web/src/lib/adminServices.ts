export type AdminServiceStage = "available" | "discovery" | "planned" | "deferred";

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
  /**
   * Peran yang memegang akses modul ini, untuk ditulis apa adanya pada kartu
   * yang terkunci. Ini keterangan, bukan aturan otorisasi: keputusan akses
   * tetap milik server, dan layar hanya mengulang nama perannya.
   */
  accessRoles?: string[];
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
    description: "Perjalanan dinas, aset, dokumen, dan komunikasi.",
  },
  {
    key: "organization",
    label: "Organisasi & Lokasi",
    description: "Site, cabang, dan lokasi kerja dalam satu organisasi YSQ.",
  },
];

/**
 * Kartu yang terkunci menyebutkan peran yang membukanya, supaya pembaca tahu
 * apa yang harus diminta dan bukan sekadar bahwa dirinya ditolak.
 */
export function lockedNote(service: AdminServiceDefinition): string {
  if (!service.accessRoles?.length) {
    return "Tersedia di HCIS · akun ini belum memiliki akses";
  }
  return `Tersedia di HCIS · akun ini belum memiliki akses. Modul ini dibuka untuk peran ${service.accessRoles.join(", ")}; minta penugasan peran kepada administrator akses.`;
}

export const adminServices: AdminServiceDefinition[] = [
  {
    key: "schedules",
    label: "Jadwal & Shift",
    description: "Atur jadwal kerja, hari libur, dan penugasan shift.",
    featureIds: ["ATT-003"],
    stage: "available",
    category: "attendance",
    href: "/admin/attendance/schedules",
  },
  {
    key: "mobile-attendance",
    label: "Mobile Attendance",
    description: "Kebijakan clock in/out HP dan evidence kehadiran.",
    featureIds: ["ATT-006"],
    stage: "available",
    category: "attendance",
    href: "/admin/attendance/reports?tab=transactions&source=mobile",
    details: ["GPS", "Geotagging / geofence", "Foto kehadiran"],
  },
  {
    key: "attendance-evaluation",
    label: "Evaluasi Kehadiran & Lembur",
    description: "Atur evaluasi terlambat, lembur, dan outcome berbasis jadwal.",
    featureIds: ["ATT-007"],
    stage: "available",
    category: "attendance",
    href: "/admin/attendance/daily",
  },
  {
    key: "shift-exchange",
    label: "Tukar Shift",
    description: "Tinjau dan putuskan pertukaran shift yang sudah disetujui rekan.",
    featureIds: ["ATT-008"],
    stage: "available",
    category: "attendance",
    href: "/admin/attendance/schedules/swaps",
  },
  {
    key: "adms",
    label: "Back Office ADMS",
    description: "Kelola fleet fingerprint, mapping pegawai, transaksi, perintah, dan pemulihan sesuai izin perangkat.",
    featureIds: ["ATT-005"],
    stage: "available",
    category: "attendance",
    href: "/admin/attendance/adms",
  },
  {
    key: "payslips",
    label: "Slip Gaji",
    description: "Import, review, dan publikasi slip gaji tetap/honorer tanpa menghitung ulang payroll.",
    featureIds: ["PAY-001", "PAY-002"],
    stage: "available",
    category: "payroll-benefits",
    href: "/admin/payslips",
  },
  {
    key: "payroll",
    label: "Payroll",
    description: "Perhitungan, review, rekonsiliasi, finalisasi, dan publikasi payroll.",
    featureIds: ["PAY-003"],
    stage: "available",
    category: "payroll-benefits",
    href: "/admin/payroll",
    accessRoles: ["Kepala Human Capital", "Direktur", "Kepala Keuangan"],
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
    description: "Register pinjaman pegawai, pencairan, dan pencatatan cicilan.",
    featureIds: ["LOAN-001"],
    stage: "available",
    category: "payroll-benefits",
    href: "/admin/loans",
    details: [
      "Pengajuan pegawai dengan persetujuan atasan langsung dan approver unit",
      "Pencairan, jadwal cicilan tanpa bunga, pembayaran, dan pelunasan oleh Keuangan",
      "Potongan otomatis lewat payroll belum (menunggu PAY-003 lulus parallel run)",
    ],
  },
  {
    key: "performance",
    label: "Kinerja / KPI",
    description: "Siklus penilaian kinerja, pengesahan hasil, dan rekap predikat.",
    featureIds: ["PERF-001"],
    stage: "available",
    category: "talent",
    href: "/admin/performance",
    details: [
      "Penilaian diri pegawai dan penilaian atasan menurut struktur",
      "Pengesahan Human Capital, predikat A–D, dan riwayat per pegawai",
      "Belum memengaruhi tunjangan kinerja (menunggu PAY-003)",
    ],
  },
  {
    key: "learning",
    label: "Pelatihan",
    description: "Program pelatihan, jadwal, peserta, kehadiran, catatan, dan rekap jam pelatihan pegawai.",
    featureIds: ["TRAIN-001"],
    stage: "available",
    category: "talent",
    href: "/admin/training",
    details: [
      "Jadwal sesi dengan blokir bentrok rapat, cuti, perjalanan dinas, dan pelatihan lain",
      "Verifikasi pelatihan eksternal beserta sertifikat",
      "Materi daring, kuis, dan evaluasi belum (TRAIN-001 R3/R4)",
    ],
  },
  {
    key: "recruitment",
    label: "Recruitment",
    description: "Rekrutmen akan dikelola di aplikasi terpisah Karir SQ. HCIS menerima pegawai baru dari hasil rekrutmen.",
    featureIds: ["REC-001"],
    stage: "discovery",
    category: "talent",
    href: "/admin/services/recruitment",
    details: [
      "Lowongan, kandidat, seleksi, dan keputusan dikelola di Karir SQ",
      "Kandidat masuk dengan akun Karir SQ, bukan akun HCIS",
      "Di HCIS: lowongan dari jabatan kosong dan pegawai baru dari kandidat yang diterima",
    ],
  },
  {
    key: "work-arrangements",
    label: "Tugas Luar, WFH & Ubah Jadwal",
    description: "Register pengajuan tugas luar, WFH/WFA, dan ubah jadwal; terapkan ubah jadwal yang sudah disetujui.",
    featureIds: ["ATT-015"],
    stage: "available",
    category: "attendance",
    href: "/admin/attendance/arrangements",
    details: [
      "Pengajuan pegawai dengan persetujuan atasan langsung dan approver unit",
      "Tugas luar dan WFH yang disetujui menjelaskan hari tanpa scan; jam absen tidak diisi otomatis",
      "Ubah jadwal diterapkan HC sebagai roster terbit",
    ],
  },
  {
    key: "business-travel",
    label: "Perjalanan Dinas",
    description: "Register perjalanan dinas pegawai dan penerbitan surat tugas bernomor.",
    featureIds: ["TRIP-001"],
    stage: "available",
    category: "employee-services",
    href: "/admin/trips",
    details: [
      "Pengajuan pegawai dengan persetujuan atasan langsung dan approver unit",
      "Surat tugas bernomor dari register dokumen",
      "Biaya, uang muka, dan reimbursement belum (REIMB-001)",
    ],
  },
  {
    key: "documents",
    label: "Dokumen Kepegawaian",
    description: "Kelola surat keterangan, surat peringatan, dan dokumen HR terkait.",
    featureIds: ["DOC-001", "DOC-002"],
    stage: "available",
    category: "employee-services",
    href: "/admin/documents",
  },
  {
    key: "letters",
    label: "Buku Nomor Surat",
    description: "Buku nomor surat keluar yayasan: jenis, penerbit, hak ambil nomor, register, dan ekspor.",
    featureIds: ["DOC-003"],
    stage: "available",
    category: "employee-services",
    href: "/admin/letters",
    accessRoles: ["HC Admin"],
    details: [
      "Nomor tanpa celah per penerbit, jenis, dan periode; nomor batal tetap tercatat",
      "Pegawai yang diberi akses mengambil nomor sendiri dari layanan Nomor Surat",
      "Register memuat juga surat yang diterbitkan HCIS, tanpa mengubah nomornya",
    ],
  },
  {
    key: "communications",
    label: "Pengumuman & Notifikasi",
    description: "Kelola pengumuman, reminder, dan delivery notifikasi.",
    featureIds: ["NOTIF-002", "NOTIF-004"],
    stage: "available",
    category: "employee-services",
    href: "/admin/announcements",
    details: [
      "Pengumuman organisasi dengan sasaran unit",
      "Notifikasi in-app sudah berjalan",
      "Pengingat terjadwal (NOTIF-003) dan email/WhatsApp (NOTIF-001) belum",
    ],
  },
  {
    key: "employee-cards",
    label: "Kartu Pegawai",
    description: "Pas foto, penerbitan, cetak, dan penggantian kartu identitas pegawai.",
    featureIds: ["EMP-012"],
    stage: "available",
    category: "employee-services",
    href: "/admin/employee-cards",
    accessRoles: ["HC Admin"],
    details: [
      "Kartu cetak CR80 dan kartu digital dari satu data",
      "QR membuka halaman cek keaslian dengan status langsung",
      "Terbit ulang kartu hilang atau rusak dengan riwayat lengkap",
    ],
  },
  {
    key: "help-center",
    label: "Pusat Bantuan",
    description: "Kelola FAQ, panduan layanan, dan kontak Human Capital untuk pegawai.",
    featureIds: ["HELP-001"],
    stage: "available",
    category: "employee-services",
    href: "/admin/help",
    accessRoles: ["HC Admin"],
    details: [
      "FAQ dan panduan per layanan dengan status draf, terbit, dan arsip",
      "Setiap perubahan tersimpan sebagai revisi dan riwayat",
      "Isi awal berupa draf yang perlu ditinjau HC sebelum terbit",
    ],
  },
  {
    key: "committees",
    label: "Kepanitiaan",
    description: "Panitia kegiatan lintas unit (PPDB, ujian, wisuda, Ramadhan): susunan, SK, dan rekap keikutsertaan.",
    featureIds: ["ORG-012"],
    stage: "available",
    category: "organization",
    href: "/admin/committees",
    accessRoles: ["HC Admin"],
    details: [
      "Susunan panitia dari pegawai aktif: ketua, sekretaris, bendahara, koordinator seksi, anggota",
      "SK panitia bernomor dari register surat, atau mencatat SK yang terbit di luar HCIS",
      "Tidak mengubah struktur organisasi dan tidak memberi kewenangan persetujuan; honor tidak termasuk",
    ],
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
  if (stage === "available") return "Tersedia";
  if (stage === "deferred") return "Setelah MVP";
  if (stage === "planned") return "Direncanakan";
  return "Dalam perencanaan";
}
